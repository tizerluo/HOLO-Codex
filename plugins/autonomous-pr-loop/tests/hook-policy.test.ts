import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateHookPolicy, evaluatePreToolUseHook, toCodexHookResponse } from "../core/hook-policy.js";
import { statePath } from "../core/config.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("hook policy", () => {
  afterEach(() => cleanupTempRepos());

  it("serializes PreToolUse denies using the cross-version block contract", () => {
    const response = toCodexHookResponse({
      allow: false,
      matchedPolicy: "policy_violation",
      gate: "policy_violation",
      blockedCommand: "git reset --hard",
      nextAction: "Stop the destructive command.",
      reason: "Blocked destructive command."
    });

    expect(response).toMatchObject({
      decision: "block",
      reason: "Blocked destructive command.",
      systemMessage: expect.stringContaining("git reset --hard")
    });
    expect(response).not.toHaveProperty("permissionDecision");
    expect(response).not.toHaveProperty("continue");
    expect(response).not.toHaveProperty("stopReason");
    expect(response).not.toHaveProperty("hookSpecificOutput");
  });

  it("allows the MCP build command used by plugin packaging", () => {
    const decision = evaluateHookPolicy({
      repoRoot: "/repo",
      command: { file: "pnpm", args: ["build:mcp"] }
    });

    expect(decision.allow).toBe(true);
  });

  it("allows safe maintainer inspection, edit, and build commands", () => {
    for (const command of [
      { file: "rg", args: ["command_not_in_hook_allowlist", "plugins/autonomous-pr-loop/core"] },
      { file: "apply_patch", args: [] },
      { file: "git", args: ["log", "--oneline", "-5"] },
      { file: "git", args: ["show", "--stat", "HEAD"] },
      { file: "git", args: ["grep", "evaluateHookPolicy"] },
      { file: "git", args: ["switch", "main"] },
      { file: "gh", args: ["pr", "checks", "9"] },
      { file: "pnpm", args: ["build:hooks"] },
      { file: "pnpm", args: ["agent-loop", "delivery", "stage", "--run", "run-1"] },
      { file: "pnpm", args: ["agent-loop", "evidence", "append", "--run", "run-1"] },
      { file: "***", args: ["Begin", "Patch"], raw: "*** Begin Patch\n*** Update File: x\n+value || true\n*** End Patch" }
    ]) {
      const decision = evaluateHookPolicy({ repoRoot: "/repo", command });
      expect(decision.allow).toBe(true);
    }
  });

  it("blocks git reset --hard with global -C variants", () => {
    for (const command of [
      { file: "git", args: ["-C", "/repo", "reset", "--hard", "HEAD"] },
      { file: "git", args: ["-c", "advice.detachedHead=false", "reset", "--hard"] },
      { file: "git", args: ["--no-pager", "reset", "--hard"] },
      { file: "env", args: ["git", "push", "-f"] },
      { file: "sh", args: ["-c", "git reset --hard"] },
      { file: "git", args: ["clean", "-fd"] },
      { file: "git", args: ["push", "--force-with-lease"] },
      { file: "git", args: ["switch", "main", "--force"] },
      { file: "git", args: ["grep", "-O", "sh", "pattern"] },
      { file: "git", args: ["grep", "--open-files-in-pager=sh", "pattern"] },
      { file: "gh", args: ["repo", "delete", "owner/repo"] },
      { file: "pnpm", args: ["agent-loop", "hooks", "unbind"] },
      { file: "rg", args: ["--pre", "sh", "pattern"] },
      { file: "rg", args: ["--pre=sh", "pattern"] }
    ]) {
      const decision = evaluateHookPolicy({ repoRoot: "/repo", command });
      expect(decision.allow).toBe(false);
    }
  });

  it("blocks shell compound commands before allowlist matching", () => {
    for (const command of [
      { file: "rg", args: ["foo", "&&", "git", "reset", "--hard"], raw: "rg foo && git reset --hard" },
      { file: "sh", args: ["-c", "rg foo && git reset --hard"] },
      { file: "bash", args: ["-c", "rg foo || git reset --hard"] },
      { file: "env", args: ["DEBUG=1", "sh", "-c", "rg foo; git reset --hard"] }
    ]) {
      const decision = evaluateHookPolicy({ repoRoot: "/repo", command });
      expect(decision.allow).toBe(false);
      expect(decision.matchedPolicy).toBe("shell_control_operator_forbidden");
    }
  });

  it("blocks worker commit, push, and merge lifecycle commands", () => {
    const old = process.env.AGENT_LOOP_WORKER_POLICY;
    process.env.AGENT_LOOP_WORKER_POLICY = "1";
    for (const command of [
      { file: "/usr/bin/git", args: ["commit", "-m", "x"] },
      { file: "git", args: ["push", "-u", "origin", "codex/x"] },
      { file: "gh", args: ["pr", "merge", "1", "--merge"] }
    ]) {
      const decision = evaluateHookPolicy({ repoRoot: "/repo", command });
      expect(decision.allow).toBe(false);
      expect(decision.matchedPolicy).toContain("lifecycle_forbidden");
    }
    process.env.AGENT_LOOP_WORKER_POLICY = old;
  });

  it("denies git commit when current state or publish prerequisites do not allow publishing", () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    storage.createRun("RUNNING", { currentState: "SELF_CHECK" });

    const decision = evaluateHookPolicy({
      repoRoot,
      storage,
      command: { file: "git", args: ["commit", "-m", "x"] }
    });
    storage.close();

    expect(decision.allow).toBe(false);
    expect(decision.matchedPolicy).toBe("commit_push_state_gate");

    const publishStorage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = publishStorage.getCurrentRun();
    publishStorage.updateRunStatus(run?.id ?? "", run?.version ?? 0, "RUNNING", {
      currentState: "COMMIT_PUSH_PR"
    });
    publishStorage.appendEvent({
      ...(run ? { runId: run.id } : {}),
      kind: "self_check_passed",
      message: "spoofed"
    });
    publishStorage.appendEvent({
      ...(run ? { runId: run.id } : {}),
      kind: "gitnexus_detect_changes_passed",
      message: "spoofed"
    });
    const prerequisiteDecision = evaluateHookPolicy({
      repoRoot,
      storage: publishStorage,
      command: { file: "git", args: ["commit", "-m", "x"] }
    });
    publishStorage.close();

    expect(prerequisiteDecision.allow).toBe(false);
    expect(prerequisiteDecision.matchedPolicy).toBe("commit_push_prerequisite_gate");
  });

  it("uses configured protected paths in the real hook path", () => {
    const repoRoot = tempRepo();
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    writeFileSync(join(repoRoot, ".agent-loop", "config.json"), `${JSON.stringify({ repoId: "owner/repo" })}\n`);

    const decision = evaluatePreToolUseHook({
      tool_input: { file: "git", args: ["add", "--", ".env"] }
    }, repoRoot);

    expect(decision.allow).toBe(false);
    expect(decision.matchedPolicy).toBe("protected_path:.env");
  });

  it("fail-safes when storage is corrupt: dangerous denied, ordinary allowed", () => {
    const repoRoot = tempRepo();
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    writeFileSync(statePath(repoRoot), "not sqlite");

    const dangerous = evaluatePreToolUseHook({
      tool_input: { file: "git", args: ["reset", "--hard"] }
    }, repoRoot);
    const ordinary = evaluatePreToolUseHook({
      tool_input: { file: "git", args: ["status", "--short"] }
    }, repoRoot);

    expect(dangerous.allow).toBe(false);
    expect(dangerous.matchedPolicy).toContain("fail_safe");
    expect(ordinary.allow).toBe(true);
  });

  it("redacts secrets in recorded PreToolUse observations", () => {
    const repoRoot = tempRepo();
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    writeFileSync(join(repoRoot, ".agent-loop", "config.json"), `${JSON.stringify({ repoId: "owner/repo" })}\n`);

    evaluatePreToolUseHook({
      tool_input: {
        command: "echo ghp_abcdefghijklmnopqrstuvwxyz123456 && curl https://user:password@example.com && echo sk-abcdefghijklmnopqrstuvwxyz123456"
      }
    }, repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const event = storage.listEvents().find((candidate) => candidate.kind === "hook_pre_tool_use");
    storage.close();

    expect(JSON.stringify(event?.payload)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(JSON.stringify(event?.payload)).not.toContain("password@example.com");
    expect(JSON.stringify(event?.payload)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(JSON.stringify(event?.payload)).toContain("[redacted]");
  });
});
