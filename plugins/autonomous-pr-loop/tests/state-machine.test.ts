import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentLoopCli } from "../core/cli.js";
import { configPath, statePath } from "../core/config.js";
import type { AgentLoopError } from "../core/errors.js";
import { recoverBlockedRun } from "../core/gate-recovery.js";
import {
  blockRunForTerminalWorker,
  resumeStateMachine,
  runStateMachine,
  validateTransitionTable
} from "../core/state-machine.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo, withFakeExecutable } from "./helpers.js";

describe("state machine", () => {
  afterEach(() => cleanupTempRepos());

  it("advances from SYNC_MAIN to DISCOVER_PROGRESS", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);

    const result = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });

    expect(result.transitions).toEqual([{ from: "SYNC_MAIN", to: "DISCOVER_PROGRESS" }]);
    expect(result.currentState).toBe("DISCOVER_PROGRESS");
  });

  it("records the resolved profile when a run starts", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);

    await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    const decisions = run ? storage.listDecisions(run.id) : [];
    const events = storage.listEvents(20);
    storage.close();

    expect(decisions.some((decision) => decision.kind === "profile_selected")).toBe(true);
    expect(events.some((event) => event.kind === "profile_selected")).toBe(true);
  });

  it("opens a generic goal confirmation gate and resumes with structured next state", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);

    const blocked = await runStateMachine({ repoRoot, dryRun: true, untilGate: true });
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    const gate = storage.listGates(run?.id).find((item) => item.status === "open");
    storage.decideGate(gate?.id ?? "", "approved", "goal is clear");
    storage.appendDecision({
      runId: run?.id ?? "",
      kind: "gate_approved",
      message: "Approved generic goal gate.",
      details: {
        gateId: gate?.id,
        gateKind: "generic_goal_needs_confirmation",
        state: "DEFINE_GOAL",
        source: "cli",
        payload: { nextState: "COLLECT_CONTEXT" }
      }
    });
    storage.close();

    const resumed = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });

    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.currentState).toBe("DEFINE_GOAL");
    expect(blocked.gate?.kind).toBe("generic_goal_needs_confirmation");
    expect(resumed.transitions).toContainEqual({ from: "DEFINE_GOAL", to: "COLLECT_CONTEXT" });
    expect(resumed.currentState).toBe("COLLECT_CONTEXT");
  });

  it("recovers generic fail-closed gates after approving the reopened gate", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);

    await runStateMachine({ repoRoot, dryRun: true, untilGate: true });
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    const gate = storage.listGates(run?.id).find((item) => item.status === "open");
    storage.decideGate(gate?.id ?? "", "approved", "goal is clear");
    storage.appendDecision({
      runId: run?.id ?? "",
      kind: "gate_approved",
      message: "Approved generic goal gate without payload.",
      details: {
        gateId: gate?.id,
        gateKind: "generic_goal_needs_confirmation",
        state: "DEFINE_GOAL",
        source: "cli",
        payload: {}
      }
    });
    storage.close();

    const failed = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });
    const reopenedStorage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const reopenedRun = reopenedStorage.getCurrentRun();
    const reopenedGate = reopenedStorage.listGates(reopenedRun?.id).find((item) => item.status === "open");
    const reopenedDetails = reopenedGate?.details as { state?: string; defaultNextState?: string } | undefined;
    reopenedStorage.decideGate(reopenedGate?.id ?? "", "approved", "payload fixed");
    reopenedStorage.appendDecision({
      runId: reopenedRun?.id ?? "",
      kind: "gate_approved",
      message: "Approved reopened generic goal gate.",
      details: {
        gateId: reopenedGate?.id,
        gateKind: "generic_goal_needs_confirmation",
        state: reopenedDetails?.state,
        source: "ui",
        payload: { nextState: reopenedDetails?.defaultNextState }
      }
    });
    reopenedStorage.close();

    const resumed = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });

    expect(failed.status).toBe("BLOCKED");
    expect(failed.currentState).toBe("DEFINE_GOAL");
    expect(failed.gate?.kind).toBe("generic_goal_needs_confirmation");
    expect(reopenedDetails).toMatchObject({
      state: "DEFINE_GOAL",
      defaultNextState: "COLLECT_CONTEXT"
    });
    expect(resumed.transitions).toEqual([{ from: "DEFINE_GOAL", to: "COLLECT_CONTEXT" }]);
  });

  it("stops generic workflow when the goal gate is rejected", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);

    await runStateMachine({ repoRoot, dryRun: true, untilGate: true });
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    const gate = storage.listGates(run?.id).find((item) => item.status === "open");
    storage.decideGate(gate?.id ?? "", "rejected", "not the right goal");
    storage.appendDecision({
      runId: run?.id ?? "",
      kind: "gate_rejected",
      message: "Rejected generic goal gate.",
      details: {
        gateId: gate?.id,
        gateKind: "generic_goal_needs_confirmation",
        state: "DEFINE_GOAL",
        source: "ui",
        payload: { nextState: "COLLECT_CONTEXT" }
      }
    });
    storage.close();

    const resumed = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const rejectedTransition = after.listEvents(10).find((event) => event.stateBefore === "DEFINE_GOAL" && event.stateAfter === "STOPPED");
    after.close();

    expect(resumed.status).toBe("STOPPED");
    expect(resumed.currentState).toBe("STOPPED");
    expect(resumed.transitions).toContainEqual({ from: "DEFINE_GOAL", to: "STOPPED" });
    expect(rejectedTransition?.payload).toMatchObject({ genericLifecycle: { transitionGuard: "rejected" } });
  });

  it("consumes generic scope approvals once before rerunning a worker", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "EXECUTE_STEP" });
    storage.writeGate({
      runId: run.id,
      kind: "generic_scope_change_requested",
      message: "scope change",
      details: {
        state: "EXECUTE_STEP",
        allowedNextStates: ["PLAN_WORK", "STOPPED"],
        defaultNextState: "PLAN_WORK"
      }
    });
    const gate = storage.listGates(run.id)[0];
    if (!gate) throw new Error("missing scope gate");
    storage.decideGate(gate.id, "approved", "revise plan");
    storage.appendDecision({
      runId: run.id,
      kind: "gate_approved",
      message: "Approved generic scope gate.",
      details: {
        gateId: gate.id,
        gateKind: "generic_scope_change_requested",
        state: "EXECUTE_STEP",
        source: "ui",
        payload: { nextState: "PLAN_WORK" }
      }
    });
    storage.close();

    const first = await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });
    const afterFirst = new SqliteAgentLoopStorage(statePath(repoRoot));
    const current = afterFirst.getCurrentRun();
    if (!current) throw new Error("missing run");
    const scopeTransition = afterFirst.listEvents(10).find((event) => event.stateBefore === "EXECUTE_STEP" && event.stateAfter === "PLAN_WORK");
    expect(scopeTransition?.payload).toMatchObject({ genericLifecycle: { transitionGuard: "scope_change_approved" } });
    afterFirst.updateRunStatus(current.id, current.version, "RUNNING", { currentState: "EXECUTE_STEP" });
    afterFirst.close();
    const second = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });

    expect(first.transitions).toEqual([{ from: "EXECUTE_STEP", to: "PLAN_WORK" }]);
    expect(second.transitions).toEqual([{ from: "EXECUTE_STEP", to: "SELF_REVIEW" }]);
  });

  it("stops generic workflow when a scope gate is rejected", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "EXECUTE_STEP" });
    storage.writeGate({
      runId: run.id,
      kind: "generic_scope_change_requested",
      message: "scope change",
      details: { state: "EXECUTE_STEP", allowedNextStates: ["PLAN_WORK", "STOPPED"], defaultNextState: "PLAN_WORK" }
    });
    const gate = storage.listGates(run.id)[0];
    if (!gate) throw new Error("missing scope gate");
    storage.decideGate(gate.id, "rejected", "stop");
    storage.appendDecision({
      runId: run.id,
      kind: "gate_rejected",
      message: "Rejected generic scope gate.",
      details: {
        gateId: gate.id,
        gateKind: "generic_scope_change_requested",
        state: "EXECUTE_STEP",
        source: "ui",
        payload: { nextState: "PLAN_WORK" }
      }
    });
    storage.close();

    const result = await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });

    expect(result.status).toBe("STOPPED");
    expect(result.transitions).toEqual([{ from: "EXECUTE_STEP", to: "STOPPED" }]);
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const rejectedTransition = after.listEvents(10).find((event) => event.stateBefore === "EXECUTE_STEP" && event.stateAfter === "STOPPED");
    after.close();
    expect(rejectedTransition?.payload).toMatchObject({ genericLifecycle: { transitionGuard: "rejected" } });
  });

  it("consumes generic human gate rework decisions once", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "HUMAN_GATE" });
    storage.writeGate({
      runId: run.id,
      kind: "generic_human_gate",
      message: "review deliverable",
      details: {
        state: "HUMAN_GATE",
        reason: "review_passed",
        allowedNextStates: ["DELIVER", "EXECUTE_STEP", "STOPPED"],
        defaultNextState: "DELIVER"
      }
    });
    const gate = storage.listGates(run.id)[0];
    if (!gate) throw new Error("missing human gate");
    storage.decideGate(gate.id, "approved", "needs one more pass");
    storage.appendDecision({
      runId: run.id,
      kind: "gate_approved",
      message: "Approved generic human gate.",
      details: {
        gateId: gate.id,
        gateKind: "generic_human_gate",
        state: "HUMAN_GATE",
        source: "ui",
        payload: { nextState: "EXECUTE_STEP" }
      }
    });
    storage.close();

    const first = await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });
    const afterFirst = new SqliteAgentLoopStorage(statePath(repoRoot));
    const current = afterFirst.getCurrentRun();
    if (!current) throw new Error("missing run");
    afterFirst.updateRunStatus(current.id, current.version, "RUNNING", { currentState: "HUMAN_GATE" });
    afterFirst.close();
    const second = await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });

    expect(first.transitions).toEqual([{ from: "HUMAN_GATE", to: "EXECUTE_STEP" }]);
    expect(second.status).toBe("BLOCKED");
    expect(second.currentState).toBe("HUMAN_GATE");
    expect(second.gate?.kind).toBe("generic_human_gate");
  });

  it("loops generic self-review back to execute while review cycles remain", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const restore = withFakeExecutable(repoRoot, "codex", reviewCodexScript(["fix: evidence"]));
    try {
      const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
      const run = storage.createRun("RUNNING", { currentState: "SELF_REVIEW" });
      storage.appendDecision({
        runId: run.id,
        kind: "generic_plan_ready",
        message: "plan ready",
        details: {}
      });
      storage.close();

      const result = await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });
      const after = new SqliteAgentLoopStorage(statePath(repoRoot));
      const decisions = after.listDecisions(run.id);
      after.close();

      expect(result.transitions).toEqual([{ from: "SELF_REVIEW", to: "EXECUTE_STEP" }]);
      expect(decisions.some((decision) => decision.kind === "generic_execute_review_cycle")).toBe(true);
    } finally {
      restore();
    }
  });

  it("passes generic self-review when follow-ups are non-blocking notes", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const restore = withFakeExecutable(repoRoot, "codex", reviewCodexScript(["note: carry forward"]));
    try {
      const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
      const run = storage.createRun("RUNNING", { currentState: "SELF_REVIEW" });
      storage.appendDecision({
        runId: run.id,
        kind: "generic_plan_ready",
        message: "plan ready",
        details: {}
      });
      storage.close();

      const result = await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });
      const after = new SqliteAgentLoopStorage(statePath(repoRoot));
      const decisions = after.listDecisions(run.id);
      after.close();

      expect(result.transitions).toEqual([{ from: "SELF_REVIEW", to: "HUMAN_GATE" }]);
      expect(decisions.some((decision) => decision.kind === "generic_review_passed")).toBe(true);
      expect(decisions.some((decision) => decision.kind === "generic_execute_review_cycle")).toBe(false);
    } finally {
      restore();
    }
  });

  it("escalates generic self-review to human gate when review cycles are exhausted", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const restore = withFakeExecutable(repoRoot, "codex", reviewCodexScript(["fix: still broken"]));
    try {
      const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
      const run = storage.createRun("RUNNING", { currentState: "SELF_REVIEW" });
      storage.appendDecision({ runId: run.id, kind: "generic_plan_ready", message: "plan ready", details: {} });
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        storage.appendDecision({ runId: run.id, kind: "generic_execute_review_cycle", message: `cycle ${cycle}`, details: { cycle, maxCycles: 3 } });
      }
      storage.close();

      const reviewed = await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });
      const blocked = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });

      expect(reviewed.transitions).toEqual([{ from: "SELF_REVIEW", to: "HUMAN_GATE" }]);
      expect(blocked.status).toBe("BLOCKED");
      expect(blocked.currentState).toBe("HUMAN_GATE");
      expect(blocked.gate?.kind).toBe("generic_human_gate");
      expect(blocked.gate?.details).toMatchObject({ reason: "review_overridden" });
    } finally {
      restore();
    }
  });

  it("handles generic human gate approve, request-changes, and reject decisions", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const approveRun = storage.createRun("RUNNING", { currentState: "HUMAN_GATE" });
    storage.writeGate({
      runId: approveRun.id,
      kind: "generic_human_gate",
      message: "review deliverable",
      details: { state: "HUMAN_GATE", reason: "review_passed", allowedNextStates: ["DELIVER", "EXECUTE_STEP", "STOPPED"], defaultNextState: "DELIVER" }
    });
    const approveGate = storage.listGates(approveRun.id)[0];
    if (!approveGate) throw new Error("missing approve gate");
    storage.decideGate(approveGate.id, "approved", "ship it");
    storage.appendDecision({
      runId: approveRun.id,
      kind: "gate_approved",
      message: "Approved generic human gate.",
      details: { gateId: approveGate.id, gateKind: "generic_human_gate", state: "HUMAN_GATE", source: "ui", payload: { nextState: "DELIVER" } }
    });
    storage.close();

    const approved = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });
    const requestChangesRepo = tempRepo();
    await runAgentLoopCli(["init"], requestChangesRepo);
    writeGenericConfig(requestChangesRepo);
    const requestChangesStorage = new SqliteAgentLoopStorage(statePath(requestChangesRepo));
    const requestChangesRun = requestChangesStorage.createRun("RUNNING", { currentState: "HUMAN_GATE" });
    requestChangesStorage.writeGate({
      runId: requestChangesRun.id,
      kind: "generic_human_gate",
      message: "review deliverable",
      details: { state: "HUMAN_GATE", reason: "review_passed", allowedNextStates: ["DELIVER", "EXECUTE_STEP", "STOPPED"], defaultNextState: "DELIVER" }
    });
    const requestChangesGate = requestChangesStorage.listGates(requestChangesRun.id)[0];
    if (!requestChangesGate) throw new Error("missing request changes gate");
    requestChangesStorage.decideGate(requestChangesGate.id, "approved", "needs changes");
    requestChangesStorage.appendDecision({
      runId: requestChangesRun.id,
      kind: "gate_approved",
      message: "Requested changes from generic human gate.",
      details: { gateId: requestChangesGate.id, gateKind: "generic_human_gate", state: "HUMAN_GATE", source: "ui", payload: { nextState: "EXECUTE_STEP" } }
    });
    requestChangesStorage.close();

    const requestedChanges = await runStateMachine({ repoRoot: requestChangesRepo, dryRun: true, untilGate: false, singleStep: true });
    const rejectRepo = tempRepo();
    await runAgentLoopCli(["init"], rejectRepo);
    writeGenericConfig(rejectRepo);
    const rejectStorage = new SqliteAgentLoopStorage(statePath(rejectRepo));
    const rejectRun = rejectStorage.createRun("RUNNING", { currentState: "HUMAN_GATE" });
    rejectStorage.writeGate({
      runId: rejectRun.id,
      kind: "generic_human_gate",
      message: "review deliverable",
      details: { state: "HUMAN_GATE", reason: "review_passed", allowedNextStates: ["DELIVER", "EXECUTE_STEP", "STOPPED"], defaultNextState: "DELIVER" }
    });
    const rejectGate = rejectStorage.listGates(rejectRun.id)[0];
    if (!rejectGate) throw new Error("missing reject gate");
    rejectStorage.decideGate(rejectGate.id, "rejected", "cancel");
    rejectStorage.appendDecision({
      runId: rejectRun.id,
      kind: "gate_rejected",
      message: "Rejected generic human gate.",
      details: { gateId: rejectGate.id, gateKind: "generic_human_gate", state: "HUMAN_GATE", source: "ui", payload: { nextState: "STOPPED" } }
    });
    rejectStorage.close();

    const rejected = await runStateMachine({ repoRoot: rejectRepo, dryRun: true, untilGate: false, singleStep: true });
    const afterReject = new SqliteAgentLoopStorage(statePath(rejectRepo));
    const rejectedTransition = afterReject.listEvents(10).find((event) => event.stateBefore === "HUMAN_GATE" && event.stateAfter === "STOPPED");
    afterReject.close();

    expect(approved.transitions).toEqual([{ from: "HUMAN_GATE", to: "DELIVER" }]);
    expect(requestedChanges.transitions).toEqual([{ from: "HUMAN_GATE", to: "EXECUTE_STEP" }]);
    expect(rejected.status).toBe("STOPPED");
    expect(rejected.transitions).toEqual([{ from: "HUMAN_GATE", to: "STOPPED" }]);
    expect(rejectedTransition?.payload).toMatchObject({ genericLifecycle: { transitionGuard: "rejected" } });
  });

  it("advances generic delivery through the declared always transition", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    storage.createRun("RUNNING", { currentState: "DELIVER" });
    storage.close();

    const delivered = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });

    expect(delivered.status).toBe("READY");
    expect(delivered.currentState).toBe("COMPLETE");
    expect(delivered.transitions).toEqual([{ from: "DELIVER", to: "COMPLETE" }]);
  });

  it("resets generic review cycles after human gate requests changes", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "HUMAN_GATE" });
    storage.appendDecision({ runId: run.id, kind: "generic_plan_ready", message: "plan ready", details: {} });
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      storage.appendDecision({ runId: run.id, kind: "generic_execute_review_cycle", message: `cycle ${cycle}`, details: { cycle, maxCycles: 3 } });
    }
    storage.appendDecision({ runId: run.id, kind: "generic_review_cycles_exhausted", message: "exhausted", details: { cycles: 3, maxCycles: 3 } });
    storage.writeGate({
      runId: run.id,
      kind: "generic_human_gate",
      message: "review deliverable",
      details: { state: "HUMAN_GATE", reason: "review_overridden", allowedNextStates: ["DELIVER", "EXECUTE_STEP", "STOPPED"], defaultNextState: "DELIVER" }
    });
    const gate = storage.listGates(run.id)[0];
    if (!gate) throw new Error("missing request changes gate");
    storage.decideGate(gate.id, "approved", "needs changes");
    storage.appendDecision({
      runId: run.id,
      kind: "gate_approved",
      message: "Requested changes from generic human gate.",
      details: { gateId: gate.id, gateKind: "generic_human_gate", state: "HUMAN_GATE", source: "ui", payload: { nextState: "EXECUTE_STEP" } }
    });
    storage.close();

    const requestedChanges = await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });
    const resetStorage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const current = resetStorage.getCurrentRun();
    if (!current) throw new Error("missing run");
    const resetWritten = resetStorage.listDecisions(run.id).some((decision) => decision.kind === "generic_review_cycles_reset");
    resetStorage.updateRunStatus(current.id, current.version, "RUNNING", { currentState: "SELF_REVIEW" });
    resetStorage.close();
    const restore = withFakeExecutable(repoRoot, "codex", reviewCodexScript([]));
    try {
      const reviewed = await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });
      const blocked = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });

      expect(requestedChanges.transitions).toEqual([{ from: "HUMAN_GATE", to: "EXECUTE_STEP" }]);
      expect(resetWritten).toBe(true);
      expect(reviewed.transitions).toEqual([{ from: "SELF_REVIEW", to: "HUMAN_GATE" }]);
      expect(blocked.gate?.kind).toBe("generic_human_gate");
      expect(blocked.gate?.details).toMatchObject({ reason: "review_passed" });
    } finally {
      restore();
    }
  });

  it("run and resume return a generic COMPLETE run as READY without re-executing", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeGenericConfig(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("READY", { currentState: "COMPLETE" });
    storage.close();

    const runResult = await runStateMachine({ repoRoot, dryRun: false, untilGate: true });
    const resumeResult = await resumeStateMachine(repoRoot);

    expect(runResult.runId).toBe(run.id);
    expect(runResult.status).toBe("READY");
    expect(runResult.currentState).toBe("COMPLETE");
    expect(runResult.transitions).toEqual([]);
    expect(resumeResult.runId).toBe(run.id);
    expect(resumeResult.status).toBe("READY");
    expect(resumeResult.currentState).toBe("COMPLETE");
    expect(resumeResult.transitions).toEqual([]);
  });

  it("enters needs_repo_init when config is missing", async () => {
    const repoRoot = tempRepo();

    const result = await runStateMachine({ repoRoot, dryRun: true, untilGate: true });

    expect(result.status).toBe("BLOCKED");
    expect(result.gate?.kind).toBe("needs_repo_init");
  });

  it("enters ambiguous_next_pr when no unique next PR exists", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);

    const result = await runStateMachine({ repoRoot, dryRun: true, untilGate: true });

    expect(result.status).toBe("BLOCKED");
    expect(result.gate?.kind).toBe("ambiguous_next_pr");
  });

  it("uses a bound delivery work item instead of entering ambiguous_next_pr", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli([
      "delivery",
      "bind",
      "--issue",
      "46",
      "--title",
      "Connect pr-delivery-loop to workflow evidence",
      "--url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/46"
    ], repoRoot);

    const result = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });

    expect(result.status).toBe("RUNNING");
    expect(result.gate).toBeUndefined();
    expect(result.transitions).toEqual([{ from: "SELECT_NEXT_PR", to: "WRITE_SPEC" }]);
    expect(result.currentState).toBe("WRITE_SPEC");
  });

  it("maps a bound delivery work item to an existing open PR by branch", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli([
      "delivery",
      "bind",
      "--issue",
      "46",
      "--title",
      "Connect pr-delivery-loop to workflow evidence",
      "--url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/46",
      "--branch",
      "codex/issue-46-pr-delivery-loop-stage-evidence"
    ], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    storage.close();

    const result = await runStateMachine({
      repoRoot,
      dryRun: false,
      untilGate: false,
      pullRequests: [openPr(50, "codex/issue-46-pr-delivery-loop-stage-evidence")]
    });
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const link = run ? after.getPrLink(run.id) : undefined;
    after.close();

    expect(result.transitions).toEqual([{ from: "SELECT_NEXT_PR", to: "WAIT_REVIEW_OR_CI" }]);
    expect(link?.prNumber).toBe(50);
    expect(link?.branch).toBe("codex/issue-46-pr-delivery-loop-stage-evidence");
  });

  it("maps a bound delivery work item to an existing open PR by issue reference when branch differs", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli([
      "delivery",
      "bind",
      "--issue",
      "46",
      "--title",
      "Connect pr-delivery-loop to workflow evidence",
      "--url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/46"
    ], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    storage.close();

    const result = await runStateMachine({
      repoRoot,
      dryRun: false,
      untilGate: false,
      pullRequests: [openPr(52, "codex/custom-delivery-branch", { body: "Closes #46" })]
    });
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const link = run ? after.getPrLink(run.id) : undefined;
    after.close();

    expect(result.transitions).toEqual([{ from: "SELECT_NEXT_PR", to: "WAIT_REVIEW_OR_CI" }]);
    expect(link?.prNumber).toBe(52);
    expect(link?.branch).toBe("codex/custom-delivery-branch");
  });

  it("blocks when multiple open PRs reference the bound issue", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli([
      "delivery",
      "bind",
      "--issue",
      "46",
      "--title",
      "Connect pr-delivery-loop to workflow evidence",
      "--url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/46"
    ], repoRoot);

    const result = await runStateMachine({
      repoRoot,
      dryRun: false,
      untilGate: false,
      pullRequests: [
        openPr(52, "codex/custom-delivery-branch", { body: "Closes #46" }),
        openPr(53, "codex/another-delivery-branch", { title: "Issue #46 alternate" })
      ]
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.gate?.kind).toBe("ambiguous_next_pr");
  });

  it("does not match a bound delivery work item from bare numbers in PR text", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli([
      "delivery",
      "bind",
      "--issue",
      "46",
      "--title",
      "Connect pr-delivery-loop to workflow evidence",
      "--url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/46"
    ], repoRoot);

    const result = await runStateMachine({
      repoRoot,
      dryRun: false,
      untilGate: false,
      pullRequests: [openPr(52, "codex/custom-delivery-branch", { body: "Fixed 46 tests." })]
    });

    expect(result.transitions).toEqual([{ from: "SELECT_NEXT_PR", to: "WRITE_SPEC" }]);
  });

  it("keeps blocked state resumable after gate approval", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);

    const blocked = await runStateMachine({ repoRoot, dryRun: true, untilGate: true });
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    const gate = storage.listGates(run?.id)[0];
    storage.decideGate(gate?.id ?? "", "approved", "test");
    storage.close();
    writeFileSync(join(repoRoot, "docs", "plans", "next-pr-b.md"), "# next\n");

    const resumed = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });

    expect(blocked.currentState).toBe("SELECT_NEXT_PR");
    expect(resumed.runId).toBe(blocked.runId);
    expect(resumed.transitions).toEqual([{ from: "SELECT_NEXT_PR", to: "WRITE_SPEC" }]);
  });

  it("does not persist dry-run state transitions", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);

    const result = await runStateMachine({ repoRoot, dryRun: true, untilGate: false, singleStep: true });
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    storage.close();

    expect(result.currentState).toBe("DISCOVER_PROGRESS");
    expect(run?.currentState).toBe("SYNC_MAIN");
  });

  it("advances past SELECT_NEXT_PR when next PR is unique", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeFileSync(join(repoRoot, "docs", "plans", "next-pr-b.md"), "# next\n");

    const result = await runStateMachine({ repoRoot, dryRun: true, untilGate: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("RUNNING");
    expect(result.transitions).toContainEqual({ from: "SELECT_NEXT_PR", to: "WRITE_SPEC" });
    expect(result.currentState).not.toBe("SELECT_NEXT_PR");
    expect(result.gate).toBeUndefined();
  });

  it("selects an existing open PR and advances to review or CI wait", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeSpecIndex(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SELECT_NEXT_PR" });
    storage.close();

    const result = await runStateMachine({
      repoRoot,
      dryRun: false,
      untilGate: false,
      pullRequests: [openPr(9, "codex/pr-h-bilingual-i18n")]
    });
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const link = after.getPrLink(run.id);
    after.close();

    expect(result.transitions).toEqual([{ from: "SELECT_NEXT_PR", to: "WAIT_REVIEW_OR_CI" }]);
    expect(link?.prNumber).toBe(9);
    expect(link?.branch).toBe("codex/pr-h-bilingual-i18n");
  });

  it("auto-recovers ambiguous_next_pr when the selector now resolves", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeSpecIndex(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("BLOCKED", { currentState: "SELECT_NEXT_PR" });
    storage.writeGate({ runId: run.id, kind: "ambiguous_next_pr", message: "old ambiguity" });
    storage.close();

    const result = await runStateMachine({
      repoRoot,
      dryRun: false,
      untilGate: false,
      pullRequests: [openPr(9, "codex/pr-h-bilingual-i18n")]
    });
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const gates = after.listGates(run.id);
    after.close();

    expect(result.status).toBe("RUNNING");
    expect(result.currentState).toBe("WAIT_REVIEW_OR_CI");
    expect(gates.every((gate) => gate.status !== "open")).toBe(true);
  });

  it("does not recover ambiguous_next_pr during dry-run", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeSpecIndex(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("BLOCKED", { currentState: "SELECT_NEXT_PR" });
    storage.writeGate({ runId: run.id, kind: "ambiguous_next_pr", message: "old ambiguity" });
    storage.close();

    const result = await runStateMachine({
      repoRoot,
      dryRun: true,
      untilGate: false,
      pullRequests: [openPr(9, "codex/pr-h-bilingual-i18n")]
    });
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const gates = after.listGates(run.id);
    after.close();

    expect(result.status).toBe("BLOCKED");
    expect(gates.some((gate) => gate.status === "open")).toBe(true);
  });

  it("recovers ambiguous_next_pr through resume when GitHub maps an open PR", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    writeSpecIndex(repoRoot);
    const restoreGh = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '[{"number":9,"headRefName":"codex/pr-h-bilingual-i18n","baseRefName":"main","state":"OPEN","isDraft":false,"url":"https://example.test/pull/9"}]'
  exit 0
fi
exit 1
`);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("BLOCKED", { currentState: "SELECT_NEXT_PR" });
    storage.writeGate({ runId: run.id, kind: "ambiguous_next_pr", message: "old ambiguity" });
    storage.close();

    try {
      const result = await resumeStateMachine(repoRoot);
      const after = new SqliteAgentLoopStorage(statePath(repoRoot));
      const link = after.getPrLink(run.id);
      const gates = after.listGates(run.id);
      after.close();

      expect(result.currentState).toBe("WAIT_REVIEW_OR_CI");
      expect(link?.prNumber).toBe(9);
      expect(gates.every((gate) => gate.status !== "open")).toBe(true);
    } finally {
      restoreGh();
    }
  });

  it("reconciles terminal worker failures through resume", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
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

    const result = await resumeStateMachine(repoRoot);
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const gate = after.listGates(run.id)[0];
    after.close();

    expect(result.status).toBe("BLOCKED");
    expect(result.currentState).toBe("WRITE_SPEC");
    expect(result.gate?.kind).toBe("worker_failed");
    expect(gate?.details).toMatchObject({
      workerId: worker.id,
      workerType: "planner",
      attempt: 1,
      exitCode: 1,
      error: "failed to load skill"
    });
  });

  it("recovers a worker_failed gate and resume re-runs the worker without re-blocking", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
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
    blockRunForTerminalWorker(storage, run);
    expect(storage.getCurrentRun()?.status).toBe("BLOCKED");
    storage.close();

    recoverBlockedRun(repoRoot, "test");

    const restore = withFakeExecutable(repoRoot, "codex", successCodexScript());
    try {
      const result = await resumeStateMachine(repoRoot);
      const after = new SqliteAgentLoopStorage(statePath(repoRoot));
      const currentRun = after.getCurrentRun();
      const workers = after.listWorkers(run.id, 50);
      const openWorkerGate = after.listGates(run.id).find((item) => item.status === "open" && item.kind === "worker_failed");
      after.close();

      expect(result.gate?.kind).not.toBe("worker_failed");
      expect(openWorkerGate).toBeUndefined();
      expect(workers.length).toBeGreaterThan(1);
      expect(workers[0]?.status).toBe("succeeded");
      expect(currentRun?.currentState).toBe("CREATE_BRANCH");
    } finally {
      restore();
    }
  });

  it("blocks with worker_failed when a delegated worker exits nonzero", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const restore = withFakeExecutable(repoRoot, "codex", "#!/bin/sh\nprintf 'worker failed' >&2\nexit 1\n");
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    storage.createRun("RUNNING", { currentState: "WRITE_SPEC" });
    storage.close();

    try {
      const result = await runStateMachine({ repoRoot, dryRun: false, untilGate: false });
      const after = new SqliteAgentLoopStorage(statePath(repoRoot));
      const gate = after.listGates(result.runId)[0];
      after.close();

      expect(result.status).toBe("BLOCKED");
      expect(result.gate?.kind).toBe("worker_failed");
      expect(gate?.kind).toBe("worker_failed");
      expect(gate?.details).toMatchObject({ workerType: "planner", attempt: 1, exitCode: 1 });
    } finally {
      restore();
    }
  });

  it("blocks with worker_failed when a delegated worker reports ok false", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const restore = withFakeExecutable(repoRoot, "codex", okFalseCodexScript());
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    storage.createRun("RUNNING", { currentState: "WRITE_SPEC" });
    storage.close();

    try {
      const result = await runStateMachine({ repoRoot, dryRun: false, untilGate: false });

      expect(result.status).toBe("BLOCKED");
      expect(result.gate?.kind).toBe("worker_failed");
      expect(result.gate?.details).toMatchObject({ workerType: "planner", attempt: 0, error: "failed" });
    } finally {
      restore();
    }
  });

  it("keeps invalid worker output on the worker_output_invalid gate", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const restore = withFakeExecutable(repoRoot, "codex", invalidOutputCodexScript());
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    storage.createRun("RUNNING", { currentState: "WRITE_SPEC" });
    storage.close();

    try {
      const result = await runStateMachine({ repoRoot, dryRun: false, untilGate: false });

      expect(result.status).toBe("BLOCKED");
      expect(result.gate?.kind).toBe("worker_output_invalid");
    } finally {
      restore();
    }
  });

  it("returns structured not_git_repo errors when git reality cannot be read", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "agent-loop-non-git-"));
    try {
      await expect(runStateMachine({ repoRoot, dryRun: true, untilGate: true })).rejects.toMatchObject({
        code: "not_git_repo"
      } satisfies Partial<AgentLoopError>);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("validates the declarative transition table", () => {
    expect(validateTransitionTable()).toEqual([]);
  });

  it("can open a PR A style state.sqlite after migration", () => {
    const repoRoot = tempRepo();
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    writeFileSync(configPath(repoRoot), `${JSON.stringify({ repoId: "example/fixture" })}\n`);
    const dbPath = statePath(repoRoot);
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table runs (
        id text primary key,
        status text not null,
        version integer not null default 0,
        created_at text not null,
        updated_at text not null
      );
      create table states (
        id integer primary key autoincrement,
        run_id text,
        status text not null,
        version integer not null,
        created_at text not null
      );
      create table events (
        id text primary key,
        run_id text,
        kind text not null,
        message text not null,
        payload_json text,
        created_at text not null
      );
      create table gates (
        id text primary key,
        run_id text,
        kind text not null,
        status text not null,
        message text not null,
        details_json text,
        created_at text not null,
        resolved_at text
      );
      create table artifacts (
        id text primary key,
        run_id text,
        kind text not null,
        path text not null,
        metadata_json text,
        created_at text not null
      );
      create table repo_config (
        id integer primary key check (id = 1),
        schema_version integer not null,
        config_json text not null,
        updated_at text not null
      );
      insert into runs (id, status, version, created_at, updated_at)
        values ('old-run', 'READY', 0, '2026-06-12T00:00:00.000Z', '2026-06-12T00:00:00.000Z');
      pragma user_version = 1;
    `);
    db.close();

    const reopened = new SqliteAgentLoopStorage(dbPath);
    const run = reopened.getCurrentRun();
    reopened.close();

    expect(run?.status).toBe("READY");
  });
});

function openPr(number: number, headRefName: string, extras: { title?: string; body?: string } = {}) {
  return {
    number,
    headRefName,
    ...extras,
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    url: `https://example.test/pull/${number}`
  };
}

function writeSpecIndex(repoRoot: string): void {
  mkdirSync(join(repoRoot, "docs", "specs"), { recursive: true });
  writeFileSync(join(repoRoot, "docs", "specs", "README.md"), "# Specs\n\n已完成主线顺序：\n\n1. [PR A：First](./pr-a-first.md)\n\n后续 PR 顺序必须固定：\n\n9. [PR H：Bilingual i18n](./pr-h-bilingual-i18n.md)\n10. [PR I：Cross-Repo Support](./pr-i-cross-repo-support.md)\n");
  writeFileSync(join(repoRoot, "docs", "specs", "pr-a-first.md"), "# PR A First\n");
  writeFileSync(join(repoRoot, "docs", "specs", "pr-h-bilingual-i18n.md"), "# PR H Bilingual i18n\n");
  writeFileSync(join(repoRoot, "docs", "specs", "pr-i-cross-repo-support.md"), "# PR I Cross-Repo Support\n");
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

function okFalseCodexScript(): string {
  return `#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
{"ok":false,"summary":"failed","changedFiles":[],"commandsRun":[],"testsRun":[],"gitnexus":{"impactRun":true,"detectChangesRun":true},"outOfScope":[],"followUps":[],"error":{"kind":"test","message":"failed"}}
JSON
printf '{"type":"thread.started","thread":{"id":"thread-failed"}}\\n'
`;
}

function reviewCodexScript(followUps: string[]): string {
  const followUpsJson = JSON.stringify(followUps);
  return `#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
{"ok":true,"summary":"review complete","changedFiles":[],"commandsRun":[],"testsRun":[],"gitnexus":{"impactRun":true,"detectChangesRun":true},"outOfScope":[],"followUps":${followUpsJson}}
JSON
printf '{"type":"thread.started","thread":{"id":"thread-review"}}\\n'
`;
}

function invalidOutputCodexScript(): string {
  return `#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
mkdir -p "$(dirname "$out")"
printf 'not-json' > "$out"
`;
}

function successCodexScript(): string {
  return `#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
{"ok":true,"summary":"spec written","changedFiles":[],"commandsRun":[],"testsRun":[],"gitnexus":{"impactRun":true,"detectChangesRun":true},"outOfScope":[],"followUps":[]}
JSON
printf '{"type":"thread.started","thread":{"id":"thread-ok"}}\\n'
`;
}
