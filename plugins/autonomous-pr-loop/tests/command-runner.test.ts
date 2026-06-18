import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRunner, evaluatePolicy } from "../core/command-runner.js";
import { readArtifact } from "../core/artifacts.js";
import { statePath, withConfigDefaults } from "../core/config.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("command runner", () => {
  afterEach(() => cleanupTempRepos());

  it("executes allowlisted commands and records output", async () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });
    const runner = new CommandRunner({
      repoRoot,
      storage,
      runId: run.id,
      config: withConfigDefaults({ repoId: "example/fixture" })
    });

    const result = await runner.run({
      id: "pnpm-version",
      file: "pnpm",
      args: ["--version"],
      cwd: repoRoot,
      purpose: "test"
    }, false);
    const events = storage.listEvents();
    storage.close();

    expect(result.allowed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(events[0]?.kind).toBe("command_executed");
  });

  it("records dry-runs without executing", async () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });
    const runner = new CommandRunner({
      repoRoot,
      storage,
      runId: run.id,
      config: withConfigDefaults({ repoId: "example/fixture" })
    });

    const result = await runner.run({
      id: "git-status",
      file: "git",
      args: ["status", "--short", "--branch"],
      cwd: repoRoot,
      purpose: "test"
    }, true);
    const events = storage.listEvents();
    storage.close();

    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(events[0]?.kind).toBe("command_dry_run");
  });

  it("rejects commands not in allowlist", async () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });
    const runner = new CommandRunner({
      repoRoot,
      storage,
      runId: run.id,
      config: withConfigDefaults({ repoId: "example/fixture" })
    });

    const result = await runner.run({
      id: "echo",
      file: "echo",
      args: ["hi"],
      cwd: repoRoot,
      purpose: "test"
    }, false);
    const events = storage.listEvents();
    storage.close();

    expect(result.allowed).toBe(false);
    expect(events[0]?.kind).toBe("policy_violation");
  });

  it("denies destructive argv variants", () => {
    expect(evaluatePolicy({ file: "git", args: ["-C", ".", "reset", "--hard"] }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "git", args: ["-C", "/tmp/other", "checkout", "main"] }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "git", args: ["push", "-f"] }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "git", args: ["rebase", "main"] }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "rm", args: ["-fr", "tmp"] }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "gh", args: ["repo", "delete", "owner/repo"] }).allowed).toBe(false);
  });

  it("allows PR C lifecycle command shapes", () => {
    expect(evaluatePolicy({ file: "git", args: ["checkout", "main"] }).allowed).toBe(true);
    expect(evaluatePolicy({ file: "git", args: ["pull", "--ff-only", "origin", "main"] }).allowed).toBe(true);
    expect(evaluatePolicy({ file: "git", args: ["push", "-u", "origin", "codex/x"] }).allowed).toBe(true);
    expect(evaluatePolicy({
      file: "gh",
      args: ["pr", "create", "--draft", "--title", "t", "--body", "b", "--head", "codex/x", "--base", "main"]
    }).allowed).toBe(true);
    expect(evaluatePolicy({
      file: "gh",
      args: [
        "api",
        "graphql",
        "-f",
        "query=query { viewer { login } }",
        "-F",
        "owner=o",
        "-F",
        "name=r",
        "-F",
        "number=1"
      ]
    }).allowed).toBe(true);
    expect(evaluatePolicy({
      file: "gh",
      args: ["pr", "create", "--draft", "--title", "t", "--body", "b", "--repo", "other/repo"]
    }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "npx", args: ["gitnexus", "detect_changes"] }).allowed).toBe(true);
    expect(evaluatePolicy({ file: "pnpm", args: ["test"] }).allowed).toBe(true);
  });

  it("allows only controlled codex exec worker command shapes", () => {
    const args = [
      "exec",
      "-C",
      "/repo",
      "-s",
      "workspace-write",
      "--json",
      "--output-schema",
      "/repo/schema.json",
      "--output-last-message",
      "/repo/final.json"
    ];
    expect(evaluatePolicy({ file: "codex", args }).allowed).toBe(true);
    expect(evaluatePolicy({ file: "codex", args: [...args, "resume", "thread-1"] }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "codex", args: [...args, "resume", "thread-1", "retry"] }).allowed).toBe(true);
    expect(evaluatePolicy({ file: "codex", args: [...args, "extra", "--unknown"] }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "codex", args: ["exec", "-C", "-s", "workspace-write", "--json", "--output-schema", "s", "--output-last-message", "o"] }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "codex", args: ["exec", "-C", "/repo", "-s", "workspace-write", "--json", "--output-schema", "s", "-o", "o"] }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "codex", args: [...args.slice(0, 4), "danger-full-access", ...args.slice(5)] }).allowed).toBe(false);
    expect(evaluatePolicy({ file: "codex", args: [...args, "--dangerously-bypass-approvals-and-sandbox"] }).allowed).toBe(false);
  });

  it("treats timeouts as failed command results", async () => {
    const repoRoot = tempRepo();
    const restorePath = withFakePnpm(repoRoot, "#!/bin/sh\nsleep 2\n");
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });
    const runner = new CommandRunner({
      repoRoot,
      storage,
      runId: run.id,
      config: withConfigDefaults({ repoId: "example/fixture", commandTimeoutMs: 1 })
    });

    const result = await runner.run({
      id: "pnpm-version-timeout",
      file: "pnpm",
      args: ["--version"],
      cwd: repoRoot,
      purpose: "test",
      timeoutMs: 10
    }, false);
    const events = storage.listEvents();
    storage.close();
    restorePath();

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(events[0]?.kind).toBe("command_timeout");
  });

  it("does not classify maxBuffer output failures as timeouts", async () => {
    const repoRoot = tempRepo();
    const restorePath = withFakePnpm(repoRoot, "#!/bin/sh\nyes x | head -c 1200000\n");
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });
    const runner = new CommandRunner({
      repoRoot,
      storage,
      runId: run.id,
      config: withConfigDefaults({ repoId: "example/fixture", commandOutputLimitBytes: 10 })
    });

    const result = await runner.run({
      id: "pnpm-output-limit",
      file: "pnpm",
      args: ["--version"],
      cwd: repoRoot,
      purpose: "test",
      outputLimitBytes: 10
    }, false);
    const events = storage.listEvents();
    storage.close();
    restorePath();

    expect(result.timedOut).toBe(false);
    expect(events[0]?.kind).toBe("command_output_limit");
  });

  it("stores large command output as an artifact and links it to the event", async () => {
    const repoRoot = tempRepo();
    const restorePath = withFakePnpm(repoRoot, "#!/bin/sh\nprintf 'abcdefghijabcdefghijabcdefghij'\n");
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });
    const runner = new CommandRunner({
      repoRoot,
      storage,
      runId: run.id,
      config: withConfigDefaults({
        repoId: "example/fixture",
        commandOutputLimitBytes: 10
      })
    });

    const result = await runner.run({
      id: "large-output",
      file: "pnpm",
      args: ["--version"],
      cwd: repoRoot,
      purpose: "test",
      outputLimitBytes: 10
    }, false);
    const events = storage.listEvents();
    const artifacts = storage.listArtifacts(run.id);
    const artifactContent = readArtifact(storage, artifacts[0]?.id ?? "").content.toString("utf8");
    storage.close();
    restorePath();

    expect(result.exitCode).toBe(0);
    expect(result.artifactIds).toEqual([artifacts[0]?.id]);
    expect(events[0]?.artifactIds?.length).toBe(1);
    expect((events[0]?.payload as { stdout?: string }).stdout).toContain("[truncated]");
    expect(artifacts[0]?.kind).toBe("command-output");
    expect(artifactContent).toContain("abcdefghijabcdefghijabcdefghij");
  });

  it("truncates multi-byte UTF-8 output without replacement characters", async () => {
    const repoRoot = tempRepo();
    const restorePath = withFakePnpm(repoRoot, "#!/bin/sh\nprintf '你好世界'\n");
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });
    const runner = new CommandRunner({
      repoRoot,
      storage,
      runId: run.id,
      config: withConfigDefaults({
        repoId: "example/fixture",
        commandOutputLimitBytes: 5
      })
    });

    await runner.run({
      id: "utf8-output",
      file: "pnpm",
      args: ["--version"],
      cwd: repoRoot,
      purpose: "test",
      outputLimitBytes: 5
    }, false);
    const events = storage.listEvents();
    const stdout = (events[0]?.payload as { stdout?: string }).stdout ?? "";
    storage.close();
    restorePath();

    expect(stdout).toContain("[truncated]");
    expect(stdout).not.toContain("\uFFFD");
  });
});

function withFakePnpm(repoRoot: string, script: string): () => void {
  const oldPath = process.env.PATH ?? "";
  const binDir = join(repoRoot, "fake-bin");
  const pnpmPath = join(binDir, "pnpm");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(pnpmPath, script);
  chmodSync(pnpmPath, 0o755);
  process.env.PATH = `${binDir}:${oldPath}`;
  return () => {
    process.env.PATH = oldPath;
  };
}
