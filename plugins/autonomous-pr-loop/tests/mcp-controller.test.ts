import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeArtifact } from "../core/artifacts.js";
import { McpController } from "../core/mcp-controller.js";
import { createControllerHost } from "../core/controller-host.js";
import { runAgentLoopCli } from "../core/cli.js";
import { configPath, statePath } from "../core/config.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("mcp controller", () => {
  afterEach(() => cleanupTempRepos());

  it("returns needs_repo_init for mutating tools when config is missing", async () => {
    const repoRoot = tempRepo();
    const controller = new McpController({ repoRoot });
    const oldToken = process.env.AGENT_LOOP_MCP_TOKEN;
    process.env.AGENT_LOOP_MCP_TOKEN = "test-token";
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("BLOCKED");
    storage.writeGate({ runId: run.id, kind: "policy_violation", message: "blocked" });
    const gate = storage.listGates()[0];
    storage.close();

    const result = await controller.loopStep("test-token");
    const approval = controller.loopApproveGate(gate?.id ?? "", "note", "test-token");
    process.env.AGENT_LOOP_MCP_TOKEN = oldToken;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("needs_repo_init");
    expect(approval.ok).toBe(false);
    expect(approval.error?.code).toBe("needs_repo_init");
  });

  it("starts run_until_gate in background and does not create parallel runs", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const oldToken = process.env.AGENT_LOOP_MCP_TOKEN;
    process.env.AGENT_LOOP_MCP_TOKEN = "test-token";
    let started = 0;
    const controller = new McpController({
      repoRoot,
      startRun: () => {
        started += 1;
      }
    });

    const first = controller.loopRunUntilGate("test-token");
    const second = controller.loopRunUntilGate("test-token");
    process.env.AGENT_LOOP_MCP_TOKEN = oldToken;

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.data).toMatchObject({ alreadyRunning: false });
    expect(second.data).toMatchObject({ alreadyRunning: true });
    expect(started).toBe(1);
  });

  it("reports background start failures without leaving a running run", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const oldToken = process.env.AGENT_LOOP_MCP_TOKEN;
    process.env.AGENT_LOOP_MCP_TOKEN = "test-token";
    const controller = new McpController({
      repoRoot,
      startRun: () => false
    });

    const result = controller.loopRunUntilGate("test-token");
    process.env.AGENT_LOOP_MCP_TOKEN = oldToken;
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const status = storage.getCurrentStatus();
    storage.close();

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("required_tool_unavailable");
    expect(status.status).toBe("BLOCKED");
  });

  it("reconciles terminal worker failures before reporting run_until_gate as already running", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const oldToken = process.env.AGENT_LOOP_MCP_TOKEN;
    process.env.AGENT_LOOP_MCP_TOKEN = "test-token";
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "WRITE_SPEC" });
    const worker = storage.createWorker({
      runId: run.id,
      type: "planner",
      backend: "codex-exec",
      attempt: 1,
      resumeUsed: true
    });
    storage.updateWorker(worker.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: 1,
      error: "failed to load skill"
    });
    storage.close();
    const controller = new McpController({
      repoRoot,
      startRun: () => {
        throw new Error("should not start");
      }
    });

    const result = controller.loopRunUntilGate("test-token");
    const status = controller.loopStatus();
    const mission = controller.loopMissionControl();
    process.env.AGENT_LOOP_MCP_TOKEN = oldToken;

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: "BLOCKED",
      alreadyRunning: true,
      reconciled: true,
      gate: { kind: "worker_failed" }
    });
    expect(status.data).toMatchObject({ status: "BLOCKED", gate: { kind: "worker_failed" } });
    expect(JSON.stringify(mission.data)).toContain("worker_failed");
  });

  it("reconciles terminal worker failures on status and mission-control reads", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    seedTerminalWorker(repoRoot, "failed");
    const controller = new McpController({ repoRoot });

    const status = controller.loopStatus();
    const mission = controller.loopMissionControl();
    const gates = controller.loopListGates();

    expect(status.data).toMatchObject({ status: "BLOCKED", gate: { kind: "worker_failed" } });
    expect(JSON.stringify(mission.data)).toContain("worker_failed");
    expect(JSON.stringify(gates.data)).toContain("worker_failed");
  });

  it("does not reconcile a failed worker while the same run still has a running worker", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "WRITE_SPEC" });
    const failed = storage.createWorker({
      runId: run.id,
      type: "planner",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });
    storage.updateWorker(failed.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: 1,
      error: "old failure"
    });
    const running = storage.createWorker({
      runId: run.id,
      type: "planner",
      backend: "codex-exec",
      attempt: 1,
      resumeUsed: true
    });
    const db = (storage as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare("update workers set started_at = ? where id in (?, ?)").run(failed.startedAt, failed.id, running.id);
    storage.close();
    const controller = new McpController({ repoRoot });

    const status = controller.loopStatus();
    const gates = controller.loopListGates();

    expect(status.data).toMatchObject({ status: "RUNNING" });
    expect(JSON.stringify(gates.data)).not.toContain("worker_failed");
  });

  it("creates a reusable controller host", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const host = createControllerHost({ repoRoot });

    const first = host.getController().loopStatus();
    const second = host.controller.loopStatus();
    host.dispose();

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
  });

  it("reports dashboard start guidance without stale PR E wording", () => {
    const repoRoot = tempRepo();
    const configDir = join(repoRoot, ".agent-loop");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), `${JSON.stringify({ repoId: "example/fixture" })}\n`);
    const controller = new McpController({ repoRoot });
    const result = controller.loopOpenDashboard();
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).toContain("pnpm agent-loop dashboard");
    expect(JSON.stringify(result.data)).not.toContain("PR E");
  });

  it("atomically prevents two storage handles from creating active runs", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const first = new SqliteAgentLoopStorage(statePath(repoRoot));
    const second = new SqliteAgentLoopStorage(statePath(repoRoot));

    const created = first.getOrCreateActiveRun({ currentState: "SYNC_MAIN" });
    const reused = second.getOrCreateActiveRun({ currentState: "SYNC_MAIN" });
    first.close();
    second.close();

    expect(created.created).toBe(true);
    expect(reused.created).toBe(false);
    expect(reused.run.id).toBe(created.run.id);
  });

  it("requires notes for gate approval and writes a decision when approved", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("BLOCKED");
    storage.writeGate({
      runId: run.id,
      kind: "policy_violation",
      message: "blocked"
    });
    const gate = storage.listGates()[0];
    storage.close();
    const controller = new McpController({ repoRoot });
    const oldToken = process.env.AGENT_LOOP_MCP_TOKEN;
    process.env.AGENT_LOOP_MCP_TOKEN = "test-token";

    const withoutNote = controller.loopApproveGate(gate?.id ?? "", "", "test-token");
    const withNote = controller.loopApproveGate(gate?.id ?? "", "reviewed", "test-token");
    process.env.AGENT_LOOP_MCP_TOKEN = oldToken;
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const decisions = after.listDecisions(run.id);
    const approved = after.getGate(gate?.id ?? "");
    after.close();

    expect(withoutNote.ok).toBe(false);
    expect(withNote.ok).toBe(true);
    expect(approved?.status).toBe("approved");
    expect(decisions[0]?.kind).toBe("gate_approved");
  });

  it("does not show approved historical gates as dry-run possible gates", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("BLOCKED");
    storage.writeGate({
      runId: run.id,
      kind: "dirty_unowned_worktree",
      message: "Worktree must be clean before syncing base branch."
    });
    const gate = storage.listGates(run.id)[0];
    if (!gate) throw new Error("missing gate");
    storage.decideGate(gate.id, "approved", "reviewed");
    storage.close();
    const controller = new McpController({ repoRoot });

    const result = controller.loopDryRunPreview();

    expect(result.ok).toBe(true);
    expect((result.data as { possibleGates: string[] }).possibleGates).toEqual([]);
  });

  it("omits PR merge readiness from generic mission control", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const controller = new McpController({ repoRoot });

    const result = controller.loopMissionControl();

    expect(result.ok).toBe(true);
    expect((result.data as { mergeReadiness?: unknown }).mergeReadiness).toBeUndefined();
    expect(JSON.stringify(result.data)).toContain("generic_loop");
  });

  it("omits PR-only dashboard pages for generic loop shape", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const controller = new McpController({ repoRoot });

    const result = controller.loopDashboardMeta();

    expect(result.ok).toBe(true);
    expect((result.data as { pages: string[] }).pages).not.toContain("PR Inbox");
    expect((result.data as { pages: string[] }).pages).toContain("Gate Center");
  });

  it("surfaces historical open gates without treating them as the current gate", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const oldRun = storage.createRun("BLOCKED", { currentState: "WAIT_REVIEW_OR_CI" });
    storage.writeGate({
      runId: oldRun.id,
      kind: "worker_failed",
      message: "Old worker failed."
    });
    storage.updateRunStatus(oldRun.id, oldRun.version, "STOPPED", { currentState: "WAIT_REVIEW_OR_CI", stoppedAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const currentRun = storage.createRun("RUNNING", { currentState: "IMPLEMENT" });
    storage.close();
    const controller = new McpController({ repoRoot });

    const result = controller.loopMissionControl();
    const listed = controller.loopListGates();
    const data = result.data as {
      current: { status: string; gate?: { kind: string }; run?: { id: string } };
      gates: Array<{ id: string; runId?: string; kind: string; activity?: string; activityReason?: string }>;
      mergeReadiness?: { missingConditions: string[] };
      notifications?: Array<{ id: string; title: string; sourceId: string }>;
    };

    expect(result.ok).toBe(true);
    expect(data.current.run?.id).toBe(currentRun.id);
    expect(data.current.status).toBe("RUNNING");
    expect(data.current.gate).toBeUndefined();
    expect(data.mergeReadiness?.missingConditions).not.toContain("no open gates");
    const historicalGateId = data.gates.find((gate) => gate.runId === oldRun.id)?.id;
    expect(data.notifications?.map((item) => item.id)).not.toContain(`gate:${historicalGateId}`);
    expect(data.gates.find((gate) => gate.runId === oldRun.id)).toMatchObject({
      kind: "worker_failed",
      activity: "historical",
      activityReason: "overridden_by_reality"
    });
    const listedGate = (listed.data as { gates: Array<{ id: string; activity?: string; activityReason?: string }> }).gates.find((gate) => gate.id === historicalGateId);
    expect(listedGate).toMatchObject({
      activity: "historical",
      activityReason: "overridden_by_reality"
    });
    const explained = controller.loopExplainGate(historicalGateId ?? "");
    expect((explained.data as { gate: { activity?: string; activityReason?: string } }).gate).toMatchObject({
      activity: "historical",
      activityReason: "overridden_by_reality"
    });
  });

  it("explains historical gates older than the listGates window", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const oldRun = storage.createRun("BLOCKED", { currentState: "WAIT_REVIEW_OR_CI" });
    storage.writeGate({
      runId: oldRun.id,
      kind: "merge_requires_confirmation",
      message: "Old merge confirmation."
    });
    const oldGate = storage.listGates(oldRun.id)[0];
    if (!oldGate) throw new Error("missing old gate");
    storage.updateRunStatus(oldRun.id, oldRun.version, "STOPPED", { currentState: "STOPPED", stoppedAt: new Date().toISOString() });
    storage.createRun("RUNNING", { currentState: "SELECT_NEXT_PR" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let index = 0; index < 105; index += 1) {
      storage.writeGate({ kind: "dirty_unowned_worktree", message: `Newer gate ${index}` });
    }
    storage.close();
    const controller = new McpController({ repoRoot });

    const listed = controller.loopListGates();
    const explained = controller.loopExplainGate(oldGate.id);

    expect((listed.data as { gates: Array<{ id: string }> }).gates.some((gate) => gate.id === oldGate.id)).toBe(false);
    expect(explained.ok).toBe(true);
    expect((explained.data as { gate: { id: string; activity?: string } }).gate).toMatchObject({
      id: oldGate.id,
      activity: "historical"
    });
  });

  it("marks stale worker failures from older runs as historical", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const oldRun = storage.createRun("BLOCKED", { currentState: "IMPLEMENT" });
    const worker = storage.createWorker({
      runId: oldRun.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });
    storage.updateWorker(worker.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: 1,
      error: "old failure"
    });
    storage.writeGate({
      runId: oldRun.id,
      kind: "worker_failed",
      message: "Old worker failed.",
      details: { workerId: worker.id }
    });
    storage.updateRunStatus(oldRun.id, oldRun.version, "STOPPED", { currentState: "IMPLEMENT", stoppedAt: new Date().toISOString() });
    storage.createRun("RUNNING", { currentState: "IMPLEMENT" });
    storage.close();
    const controller = new McpController({ repoRoot });

    const result = controller.loopMissionControl();
    const data = result.data as {
      workers: Array<{ id: string; activity?: string; activityReason?: string }>;
      recoveryWarnings?: string[];
      notifications?: Array<{ id: string; title: string; sourceId: string }>;
    };

    expect(result.ok).toBe(true);
    expect(data.workers.find((item) => item.id === worker.id)).toMatchObject({
      activity: "historical",
      activityReason: "stale_worker_failure"
    });
    expect(data.notifications?.map((item) => item.id)).not.toContain(`worker:${worker.id}:failed`);
    expect(data.recoveryWarnings?.join("\n")).toContain("stale worker");
  });

  it("blocks sensitive worker artifact content reads", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "IMPLEMENT" });
    const prompt = writeArtifact(repoRoot, storage, run.id, "worker-prompt", "prompt.md", "raw prompt");
    storage.close();
    const controller = new McpController({ repoRoot });

    const result = controller.loopReadArtifact(prompt.id);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("policy_violation");
  });
});

function seedTerminalWorker(repoRoot: string, status: "failed" | "invalid_output" | "timed_out"): void {
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  const run = storage.createRun("RUNNING", { currentState: "WRITE_SPEC" });
  const worker = storage.createWorker({
    runId: run.id,
    type: "planner",
    backend: "codex-exec",
    attempt: 0,
    resumeUsed: false
  });
  storage.updateWorker(worker.id, {
    status,
    completedAt: new Date().toISOString(),
    exitCode: status === "timed_out" ? 124 : 1,
    error: "failed to load skill"
  });
  storage.close();
}

function writeGenericConfig(repoRoot: string): void {
  writeFileSync(configPath(repoRoot), `${JSON.stringify({
    repoId: "local/test",
    loopShape: "generic-loop",
    workflowProfile: "research_report_loop",
    roleProfile: "default_pr_roles",
    requiredChecks: [],
    protectedPaths: ["AGENTS.md"]
  }, null, 2)}\n`);
}
