import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentLoopCli } from "../core/cli.js";
import { inspectAgentLoopBinary } from "../core/hook-diagnostics.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("agent-loop CLI", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("init --dry-run does not create .agent-loop", async () => {
    const repoRoot = tempRepo();

    const result = await runAgentLoopCli(["init", "--dry-run", "--json"], repoRoot);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      dryRun: true,
      currentBranch: "main",
      config: {
        repoId: "example/fixture",
        lintCommand: "pnpm lint",
        testCommand: "pnpm test"
      }
    });
    expect(existsSync(join(repoRoot, ".agent-loop"))).toBe(false);
  });

  it("init creates config and storage for a fresh repo", async () => {
    const repoRoot = tempRepo();

    const result = await runAgentLoopCli(["init", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.dryRun).toBe(false);
    expect(existsSync(join(repoRoot, ".agent-loop", "config.json"))).toBe(true);
    expect(existsSync(join(repoRoot, ".agent-loop", "state.sqlite"))).toBe(true);
  });

  it("doctor reports needs_repo_init when config is missing", async () => {
    const repoRoot = tempRepo();

    const result = await runAgentLoopCli(["doctor", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(payload.gate).toBe("needs_repo_init");
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "github remote",
          details: { remote: "github.com/<owner>/<repo>" }
        })
      ])
    );
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "config schema",
          status: "fail"
        })
      ])
    );
  });

  it("doctor points hook installation guidance at the resolved global CLI command", async () => {
    const repoRoot = tempRepo("agent loop doctor target-");
    const canonicalRepoRoot = realpathSync(repoRoot);
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-empty-codex-home-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    let payload: { checks: Array<{ name: string; status: string; message: string; details?: Record<string, unknown> }> } | undefined;
    try {
      const result = await runAgentLoopCli(["doctor", "--json"], repoRoot);
      payload = JSON.parse(result.stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }

    if (!payload) throw new Error("missing doctor payload");
    const hookCheck = payload.checks.find((check) => check.name === "codex hooks");
    expect(hookCheck).toMatchObject({
      status: "warn",
      details: {
        targetRepoRoot: canonicalRepoRoot,
        installCommand: `agent-loop install-hooks --repo '${canonicalRepoRoot}'`
      }
    });
    expect(hookCheck?.message).toContain(`agent-loop install-hooks --repo '${canonicalRepoRoot}'`);
  });

  it("doctor reports invalid hooks json as a warning instead of crashing", async () => {
    const repoRoot = tempRepo("agent loop doctor invalid hooks-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-invalid-hooks-"));
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "hooks.json"), "{not json");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    let payload: { checks: Array<{ name: string; status: string; message: string }> } | undefined;
    try {
      const result = await runAgentLoopCli(["doctor", "--json"], repoRoot);
      payload = JSON.parse(result.stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }

    const hookCheck = payload?.checks.find((check) => check.name === "codex hooks");
    expect(hookCheck?.status).toBe("warn");
    expect(hookCheck?.message).toContain("not valid JSON");
  });

  it("doctor reports unexpected router hook dist paths in details", async () => {
    const repoRoot = tempRepo("agent loop doctor old router-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-old-router-"));
    const legacyToken = "ghp_123456789012345678901234567890123456";
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: `TOKEN=${legacyToken} node '/tmp/old/autonomous-pr-loop/hooks/dist/pre-tool-use.js'` }] }]
      }
    }, null, 2)}\n`);
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    let payload: { checks: Array<{ name: string; status?: string; message?: string; details?: { unexpectedRouterCommands?: string[]; routerCommandsPointToExpectedDist?: boolean; refreshCommand?: string } }> } | undefined;
    try {
      const result = await runAgentLoopCli(["doctor", "--json"], repoRoot);
      payload = JSON.parse(result.stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }

    const hookCheck = payload?.checks.find((check) => check.name === "codex hooks");
    expect(hookCheck?.status).toBe("warn");
    expect(hookCheck?.message).toContain("outside the expected hook dist");
    expect(hookCheck?.details?.routerCommandsPointToExpectedDist).toBe(false);
    expect(hookCheck?.details?.unexpectedRouterCommands?.[0]).toContain("[redacted]");
    expect(hookCheck?.details?.refreshCommand).toContain("agent-loop install-hooks --repo");
    expect(JSON.stringify(hookCheck)).not.toContain(legacyToken);
  });

  it("doctor warns when only the PATH agent-loop binary points at the old private repo", async () => {
    const repoRoot = tempRepo("agent loop doctor old binary-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-old-binary-home-"));
    const fakeBinDir = mkdtempSync(join(tmpdir(), "agent-loop-old-binary-bin-"));
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(fakeBinDir, "agent-loop"), "#!/bin/sh\nnode /Users/mac-mini/projects/codex-auto-PR-loop-plusin/plugins/autonomous-pr-loop/bin/agent-loop.mjs \"$@\"\n", { mode: 0o755 });
    const oldCodexHome = process.env.CODEX_HOME;
    const oldPath = process.env.PATH;
    process.env.CODEX_HOME = codexHome;

    let payload: { checks: Array<{ name: string; status?: string; message?: string; details?: { legacyPrivateRepoCommands?: string[]; agentLoopBinary?: { legacyPrivateRepoReferences?: string[] } } }> } | undefined;
    try {
      await runAgentLoopCli(["install-hooks", "--repo", repoRoot, "--json"], repoRoot);
      process.env.PATH = `${fakeBinDir}:${oldPath ?? ""}`;
      payload = JSON.parse((await runAgentLoopCli(["doctor", "--json"], repoRoot)).stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
      process.env.PATH = oldPath;
    }

    const hookCheck = payload?.checks.find((check) => check.name === "codex hooks");
    expect(hookCheck?.status).toBe("warn");
    expect(hookCheck?.message).toContain("old private repo");
    expect(hookCheck?.details?.legacyPrivateRepoCommands).toEqual([]);
    expect(hookCheck?.details?.agentLoopBinary?.legacyPrivateRepoReferences).toHaveLength(1);
    expect(hookCheck?.details?.agentLoopBinary?.legacyPrivateRepoReferences?.[0]).toContain("<legacy-private-repo-path>");
    expect(hookCheck?.details?.agentLoopBinary?.legacyPrivateRepoReferences?.[0]).not.toContain("/Users/mac-mini");
  });

  it("agent-loop binary inspection reads only a bounded prefix", () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), "agent-loop-large-binary-bin-"));
    writeFileSync(
      join(fakeBinDir, "agent-loop"),
      `#!/bin/sh\n${"x".repeat(140 * 1024)}\nnode /Users/mac-mini/projects/codex-auto-PR-loop-plusin/plugins/autonomous-pr-loop/bin/agent-loop.mjs "$@"\n`,
      { mode: 0o755 }
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${oldPath ?? ""}`;

    let result: ReturnType<typeof inspectAgentLoopBinary>;
    try {
      result = inspectAgentLoopBinary("/expected/package");
    } finally {
      process.env.PATH = oldPath;
    }

    expect(result.readTruncated).toBe(true);
    expect(result.legacyPrivateRepoReferences).toEqual([]);
  });

  it("doctor reports invalid hook binding registry as a warning instead of crashing", async () => {
    const repoRoot = tempRepo("agent loop doctor invalid registry-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-invalid-registry-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    let payload: { checks: Array<{ name: string; status: string; message: string; details?: { registryError?: string } }> } | undefined;
    try {
      await runAgentLoopCli(["install-hooks", "--json"], repoRoot);
      writeFileSync(join(codexHome, "agent-loop", "hook-bindings.json"), "{not json");
      const result = await runAgentLoopCli(["doctor", "--json"], repoRoot);
      payload = JSON.parse(result.stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }

    const hookCheck = payload?.checks.find((check) => check.name === "codex hooks");
    expect(hookCheck?.status).toBe("warn");
    expect(hookCheck?.message).toContain("binding registry is not valid");
    expect(hookCheck?.details?.registryError).toBeTruthy();
  });

  it("doctor reports stale hook registry locks", async () => {
    const repoRoot = tempRepo("agent loop doctor stale lock-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-stale-lock-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    let payload: { checks: Array<{ name: string; status: string; message: string; details?: { lock?: { stale?: boolean } } }> } | undefined;
    try {
      await runAgentLoopCli(["install-hooks", "--repo", repoRoot, "--json"], repoRoot);
      writeFileSync(join(codexHome, "agent-loop", "hook-bindings.json.lock"), `${JSON.stringify({ pid: 999_999, createdAt: "2000-01-01T00:00:00.000Z" })}\n`);
      const result = await runAgentLoopCli(["doctor", "--json"], repoRoot);
      payload = JSON.parse(result.stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }

    const hookCheck = payload?.checks.find((check) => check.name === "codex hooks");
    expect(hookCheck?.status).toBe("warn");
    expect(hookCheck?.message).toContain("registry lock appears stale");
    expect(hookCheck?.details?.lock?.stale).toBe(true);
  });

  it("status reports needs_repo_init and exits 2 when config is missing", async () => {
    const repoRoot = tempRepo();

    const result = await runAgentLoopCli(["status", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(payload.error.code).toBe("needs_repo_init");
  });

  it("reports unknown commands as structured errors", async () => {
    const repoRoot = tempRepo();

    const result = await runAgentLoopCli(["wat", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(payload.error.code).toBe("unknown_command");
  });

  it("reports unsupported remotes as a gate", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init", "--dry-run"], repoRoot);
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["remote", "set-url", "origin", "ssh://git@example.com/example/repo.git"], {
      cwd: repoRoot
    });

    const result = await runAgentLoopCli(["init", "--dry-run", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(payload.error.code).toBe("unsupported_remote");
    expect(payload.error.details.remote).toBe("ssh://example.com/<redacted>");
  });
});
