import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statePath } from "../core/config.js";
import { observeCodexHook } from "../core/hook-observer.js";
import { evaluatePreToolUseHook } from "../core/hook-policy.js";
import { hookRegistryLockPath, hookRegistryPath, resolveHookContext, upsertHookBinding } from "../core/hook-router.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("hook router", () => {
  const oldCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    process.env.CODEX_HOME = oldCodexHome;
    cleanupTempRepos();
  });

  it("routes observe-only hook events to the matching repo/run only", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-router-"));
    process.env.CODEX_HOME = codexHome;
    const repoA = tempRepo("agent-loop-hook-a-");
    const repoB = tempRepo("agent-loop-hook-b-");
    const storageA = new SqliteAgentLoopStorage(statePath(repoA));
    const runA = storageA.createRun("RUNNING", { currentState: "SELECT_NEXT_PR" });
    storageA.close();
    const storageB = new SqliteAgentLoopStorage(statePath(repoB));
    storageB.createRun("RUNNING", { currentState: "SELECT_NEXT_PR" });
    storageB.close();

    upsertHookBinding({ repoRoot: repoA, runId: runA.id });
    upsertHookBinding({ repoRoot: repoB });

    const result = observeCodexHook("PostToolUse", {
      cwd: repoA,
      session_id: "session-a",
      tool_name: "Bash",
      tool_input: { command: "git status --short" }
    });

    const checkA = new SqliteAgentLoopStorage(statePath(repoA));
    const checkB = new SqliteAgentLoopStorage(statePath(repoB));
    const eventsA = checkA.listEvents(20).filter((event) => event.kind === "hook_post_tool_use");
    const eventsB = checkB.listEvents(20).filter((event) => event.kind === "hook_post_tool_use");
    checkA.close();
    checkB.close();

    expect(result.observed).toBe(true);
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]?.runId).toBe(runA.id);
    expect(JSON.stringify(eventsA[0]?.payload ?? {})).toContain("sessionIdHash");
    expect(JSON.stringify(eventsA[0]?.payload ?? {})).not.toContain("session-a");
    expect(eventsB).toHaveLength(0);
  });

  it("does not let an unrelated repo PreToolUse policy deny the current repo command", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-router-"));
    process.env.CODEX_HOME = codexHome;
    const repoA = tempRepo("agent-loop-hook-a-");
    const repoB = tempRepo("agent-loop-hook-b-");
    mkdirSync(join(repoA, ".agent-loop"), { recursive: true });
    writeFileSync(join(repoA, ".agent-loop", "config.json"), `${JSON.stringify({ repoId: "owner/repo-a" })}\n`);
    const storageA = new SqliteAgentLoopStorage(statePath(repoA));
    storageA.createRun("RUNNING", { currentState: "SELF_CHECK" });
    storageA.close();
    upsertHookBinding({ repoRoot: repoA });

    const decision = evaluatePreToolUseHook({
      cwd: repoB,
      tool_input: { file: "git", args: ["commit", "-m", "x"] }
    });

    expect(decision.allow).toBe(true);
    expect(decision.matchedPolicy).toBe("hook_routing_no_match");
  });

  it("fails closed for ambiguous PreToolUse routing", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-router-"));
    process.env.CODEX_HOME = codexHome;
    const repo = tempRepo("agent-loop-hook-ambiguous-");
    const binding = upsertHookBinding({ repoRoot: repo });
    writeFileSync(hookRegistryPath(codexHome), `${JSON.stringify({
      version: 1,
      bindings: [
        binding,
        { ...binding, id: "duplicate-binding", runId: "other-run" }
      ]
    }, null, 2)}\n`);

    const decision = evaluatePreToolUseHook({
      cwd: repo,
      tool_input: { file: "git", args: ["status", "--short"] }
    });

    expect(decision.allow).toBe(false);
    expect(decision.matchedPolicy).toBe("hook_routing_ambiguous");
  });

  it("keeps same-worktree session bindings isolated", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-router-"));
    process.env.CODEX_HOME = codexHome;
    const repo = tempRepo("agent-loop-hook-session-");
    const one = upsertHookBinding({ repoRoot: repo, runId: "run-one", sessionId: "session-one" });
    const two = upsertHookBinding({ repoRoot: repo, runId: "run-two", sessionId: "session-two" });

    const oneResult = observeCodexHook("PostToolUse", { cwd: repo, session_id: "session-one" });
    const noSessionResult = observeCodexHook("PostToolUse", { cwd: repo });

    expect(one.runId).toBe("run-one");
    expect(two.runId).toBe("run-two");
    expect(oneResult.observed).toBe(true);
    expect(noSessionResult.observed).toBe(false);
    expect(noSessionResult.error).toBeUndefined();
  });

  it("does not let legacy repo env bypass a session-scoped binding mismatch", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-legacy-session-"));
    process.env.CODEX_HOME = codexHome;
    const repo = tempRepo("agent-loop-hook-legacy-session-");
    upsertHookBinding({ repoRoot: repo, runId: "run-one", sessionId: "session-one" });

    const observe = observeCodexHook("PostToolUse", { cwd: repo, session_id: "session-two" }, repo);
    const decision = evaluatePreToolUseHook({
      cwd: repo,
      session_id: "session-two",
      tool_input: { file: "git", args: ["status", "--short"] }
    }, repo);
    const destructive = evaluatePreToolUseHook({
      cwd: repo,
      session_id: "session-two",
      tool_input: { file: "git", args: ["reset", "--hard"] }
    }, repo);
    const lifecycle = evaluatePreToolUseHook({
      cwd: repo,
      session_id: "session-two",
      tool_input: { file: "git", args: ["commit", "-m", "x"] }
    }, repo);

    expect(observe.observed).toBe(false);
    expect(observe.error).toBeUndefined();
    expect(decision.allow).toBe(true);
    expect(decision.matchedPolicy).toBe("hook_routing_no_match");
    expect(destructive.allow).toBe(false);
    expect(destructive.matchedPolicy).toBe("hook_routing_session_mismatch:destructive_git_reset_hard");
    expect(lifecycle.allow).toBe(false);
    expect(lifecycle.matchedPolicy).toBe("hook_routing_session_mismatch");
  });

  it("claims an unscoped binding for the first matching Codex session", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-router-"));
    process.env.CODEX_HOME = codexHome;
    const repo = tempRepo("agent-loop-hook-claim-");
    upsertHookBinding({ repoRoot: repo, runId: "run-one" });

    const first = observeCodexHook("PostToolUse", { cwd: repo, session_id: "session-one" });
    const second = observeCodexHook("PostToolUse", { cwd: repo, session_id: "session-two" });
    const registry = JSON.parse(readFileSync(hookRegistryPath(codexHome), "utf8"));

    expect(first.observed).toBe(true);
    expect(second.observed).toBe(false);
    expect(JSON.stringify(registry)).toContain("sessionIdHash");
    expect(JSON.stringify(registry)).not.toContain("session-one");
    expect(JSON.stringify(registry)).not.toContain("session-two");
  });

  it("updates a single session-scoped binding instead of creating an unscoped orphan", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-delivery-claim-"));
    process.env.CODEX_HOME = codexHome;
    const repo = tempRepo("agent-loop-hook-delivery-claim-");
    const claimed = upsertHookBinding({ repoRoot: repo, sessionId: "session-one" });

    const rebound = upsertHookBinding({ repoRoot: repo, runId: "run-one" });
    const registry = JSON.parse(readFileSync(hookRegistryPath(codexHome), "utf8"));

    expect(rebound.id).toBe(claimed.id);
    expect(rebound.runId).toBe("run-one");
    expect(rebound.sessionIdHash).toBe(claimed.sessionIdHash);
    expect(registry.bindings).toHaveLength(1);
  });

  it("resolves relative git common dir from the hook cwd", () => {
    const repo = tempRepo("agent-loop-hook-common-dir-");
    mkdirSync(join(repo, "sub", "dir"), { recursive: true });

    const context = resolveHookContext({ cwd: join(repo, "sub", "dir") });

    expect(context.gitCommonDir).toBe(realpathSync(join(repo, ".git")));
  });

  it("does not store raw session ids and writes the registry with private permissions", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-private-"));
    process.env.CODEX_HOME = codexHome;
    const repo = tempRepo("agent-loop-hook-private-");

    upsertHookBinding({ repoRoot: repo, runId: "run-one", sessionId: "session-secret" });
    const raw = readFileSync(hookRegistryPath(codexHome), "utf8");
    const fileMode = statSync(hookRegistryPath(codexHome)).mode & 0o777;
    const dirMode = statSync(join(codexHome, "agent-loop")).mode & 0o777;

    expect(raw).toContain("sessionIdHash");
    expect(raw).not.toContain("session-secret");
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("fails closed for lifecycle or destructive commands when the registry is malformed", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-corrupt-"));
    process.env.CODEX_HOME = codexHome;
    const repo = tempRepo("agent-loop-hook-corrupt-");
    mkdirSync(join(codexHome, "agent-loop"), { recursive: true });
    writeFileSync(hookRegistryPath(codexHome), "{bad json\n");

    const commit = evaluatePreToolUseHook({
      cwd: repo,
      tool_input: { file: "git", args: ["commit", "-m", "x"] }
    });
    const readOnly = evaluatePreToolUseHook({
      cwd: repo,
      tool_input: { file: "git", args: ["status", "--short"] }
    });

    expect(commit.allow).toBe(false);
    expect(commit.matchedPolicy).toBe("hook_routing_error");
    expect(readOnly.allow).toBe(true);
    expect(readOnly.matchedPolicy).toBe("hook_routing_error_noop");
  });

  it("fails closed for lifecycle commands when the registry shape is invalid", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-invalid-shape-"));
    process.env.CODEX_HOME = codexHome;
    const repo = tempRepo("agent-loop-hook-invalid-shape-");
    mkdirSync(join(codexHome, "agent-loop"), { recursive: true });
    writeFileSync(hookRegistryPath(codexHome), `${JSON.stringify({ version: 2, bindings: [] })}\n`);

    const decision = evaluatePreToolUseHook({
      cwd: repo,
      tool_input: { file: "git", args: ["commit", "-m", "x"] }
    });

    expect(decision.allow).toBe(false);
    expect(decision.matchedPolicy).toBe("hook_routing_error");
  });

  it("treats fresh lock contention as route_error instead of hook runner deny-all", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-fresh-lock-"));
    process.env.CODEX_HOME = codexHome;
    const repo = tempRepo("agent-loop-hook-fresh-lock-");
    upsertHookBinding({ repoRoot: repo, runId: "run-one" });
    writeFileSync(hookRegistryLockPath(codexHome), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);

    const readOnly = evaluatePreToolUseHook({
      cwd: repo,
      tool_input: { file: "git", args: ["status", "--short"] }
    });
    const commit = evaluatePreToolUseHook({
      cwd: repo,
      tool_input: { file: "git", args: ["commit", "-m", "x"] }
    });

    expect(readOnly.allow).toBe(true);
    expect(readOnly.matchedPolicy).toBe("hook_routing_error_noop");
    expect(commit.allow).toBe(false);
    expect(commit.matchedPolicy).toBe("hook_routing_error");
  });

  it("recovers stale hook registry locks", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hook-stale-lock-"));
    process.env.CODEX_HOME = codexHome;
    const repo = tempRepo("agent-loop-hook-stale-lock-");
    mkdirSync(join(codexHome, "agent-loop"), { recursive: true });
    writeFileSync(hookRegistryLockPath(codexHome), `${JSON.stringify({ pid: 999_999, createdAt: "2000-01-01T00:00:00.000Z" })}\n`);

    const binding = upsertHookBinding({ repoRoot: repo, runId: "run-one" });

    expect(binding.runId).toBe("run-one");
  });
});
