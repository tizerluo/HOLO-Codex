import { execFileSync } from "node:child_process";
import { symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { writeArtifact } from "../core/artifacts.js";
import { runAgentLoopCli } from "../core/cli.js";
import { statePath } from "../core/config.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { callMcpTool, MCP_TOOLS } from "../mcp-server/src/tools.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("mcp tools", () => {
  afterEach(() => cleanupTempRepos());

  it("serves initialize and tools/list before resolving a target repo", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-loop-mcp-non-git-"));
    try {
      const output = execFileSync(join(import.meta.dirname, "../../../node_modules/.bin/tsx"), [
        join(import.meta.dirname, "../mcp-server/src/index.ts")
      ], {
        cwd,
        input: [
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
          ""
        ].join("\n"),
        encoding: "utf8"
      });
      const lines = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(lines[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "autonomous-pr-loop" } } });
      expect(lines[1]).toMatchObject({ id: 2, result: { tools: expect.any(Array) } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("exposes the PR E tool set and returns current status", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const names = MCP_TOOLS.map((tool) => tool.name);

    const status = await callMcpTool("loop_status", {}, repoRoot);

    expect(names).toEqual(expect.arrayContaining([
      "loop_status",
      "loop_run_until_gate",
      "loop_approve_gate",
      "loop_agent_timeline",
      "loop_read_artifact",
      "loop_spawn_worker"
    ]));
    expect(status).toMatchObject({ ok: true });
  });

  it("requires tokens in all mutating tool schemas", () => {
    const mutating = [
      "loop_run_until_gate",
      "loop_resume",
      "loop_stop",
      "loop_step",
      "loop_approve_gate",
      "loop_reject_gate",
      "loop_spawn_worker"
    ];

    for (const name of mutating) {
      const tool = MCP_TOOLS.find((item) => item.name === name);
      expect(tool?.inputSchema.required).toContain("token");
    }
  });

  it("rejects missing and invalid mutating tokens", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const oldToken = process.env.AGENT_LOOP_MCP_TOKEN;

    delete process.env.AGENT_LOOP_MCP_TOKEN;
    const missing = await callMcpTool("loop_step", {}, repoRoot);
    process.env.AGENT_LOOP_MCP_TOKEN = "expected";
    const invalid = await callMcpTool("loop_step", { token: "wrong" }, repoRoot);
    process.env.AGENT_LOOP_MCP_TOKEN = oldToken;

    expect(missing).toMatchObject({ ok: false, error: { code: "needs_secret_or_login" } });
    expect(invalid).toMatchObject({ ok: false, error: { code: "needs_secret_or_login" } });
  });

  it("returns stored PR, CI, and review data", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");
    storage.upsertPrLink({
      runId: run.id,
      branch: "codex/next",
      prNumber: 3,
      url: "https://github.test/pr/3",
      headRef: "codex/next",
      baseRef: "main",
      state: "OPEN",
      draft: true
    });
    storage.replaceCiChecks(run.id, 3, [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]);
    storage.replaceReviewComments(run.id, 3, [{
      commentId: "c1",
      url: "https://github.test/c1",
      author: "reviewer",
      body: "fix",
      path: "src/index.ts",
      diffHunk: "@@",
      isResolved: false,
      isOutdated: false,
      actionable: true,
      status: "open"
    }]);
    storage.close();

    await expect(callMcpTool("loop_get_pr_status", {}, repoRoot)).resolves.toMatchObject({ data: { pr: { prNumber: 3 } } });
    await expect(callMcpTool("loop_get_ci_status", {}, repoRoot)).resolves.toMatchObject({ data: { checks: [{ name: "ci" }] } });
    await expect(callMcpTool("loop_get_review_comments", {}, repoRoot)).resolves.toMatchObject({ data: { comments: [{ commentId: "c1" }] } });
  });

  it("returns normalized agent timeline entries", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");
    storage.appendEvent({ runId: run.id, kind: "timeline.seed", message: "Timeline seeded." });
    storage.close();

    const result = await callMcpTool("loop_agent_timeline", { runId: run.id, limit: 5 }, repoRoot);

    expect(result).toMatchObject({
      ok: true,
      data: {
        entries: expect.arrayContaining([
          expect.objectContaining({ source: "event", kind: "timeline.seed" })
        ])
      }
    });
  });

  it("prevents artifact path traversal", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");
    const artifact = writeArtifact(repoRoot, storage, run.id, "log", "ok.txt", "ok");
    storage.close();
    const db = new DatabaseSync(statePath(repoRoot));
    db.prepare("update artifacts set path = ? where id = ?").run(join(repoRoot, "package.json"), artifact.id);
    db.close();

    const result = await callMcpTool("loop_read_artifact", { artifactId: artifact.id }, repoRoot);

    expect(result).toMatchObject({ ok: false, error: { code: "artifact_integrity_error" } });
  });

  it("prevents artifact symlinks that escape the artifact root", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");
    const artifact = writeArtifact(repoRoot, storage, run.id, "log", "ok.txt", "ok");
    storage.close();
    const outside = join(repoRoot, "outside-secret.txt");
    writeFileSync(outside, "secret");
    unlinkSync(artifact.path);
    symlinkSync(outside, artifact.path);

    const result = await callMcpTool("loop_read_artifact", { artifactId: artifact.id }, repoRoot);

    expect(result).toMatchObject({ ok: false, error: { code: "artifact_integrity_error" } });
  });
});
