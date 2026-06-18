import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statePath, withConfigDefaults } from "../core/config.js";
import {
  recoverBlockedRun,
  recoverSatisfiedRepoGates,
  recoverTerminalWorkerGate,
  WORKER_FAILURE_RECOVERED_DECISION
} from "../core/gate-recovery.js";
import { blockRunForTerminalWorker } from "../core/state-machine.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

function writeConfig(repoRoot: string): void {
  mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".agent-loop", "config.json"),
    `${JSON.stringify(withConfigDefaults({ repoId: "example/fixture" }), null, 2)}\n`
  );
}

describe("gate recovery", () => {
  afterEach(() => cleanupTempRepos());

  it("explicitly resolves repo-level init gates and writes event plus decision audit", () => {
    const repoRoot = tempRepo();
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".agent-loop", "config.json"),
      `${JSON.stringify(withConfigDefaults({ repoId: "example/fixture" }), null, 2)}\n`
    );
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.createRun("BLOCKED");
    storage.writeGate({
      kind: "needs_repo_init",
      message: "Missing config."
    });
    const gate = storage.listGates().find((item) => item.kind === "needs_repo_init");
    storage.close();

    const result = recoverSatisfiedRepoGates(repoRoot, "test");
    const after = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const event = after.listEvents().find((item) => item.kind === "gate_recovery");
    const decision = after.listDecisions(run.id).find((item) => item.kind === "gate_recovery");
    const recoveredGate = after.getGate(gate?.id ?? "");
    after.close();

    expect(result.recovered).toBe(1);
    expect(recoveredGate?.status).toBe("resolved");
    expect(event?.payload).toMatchObject({
      source: "test",
      scope: "repo",
      reason: "config_exists_and_valid",
      gateIds: [gate?.id]
    });
    expect(decision?.details).toMatchObject({ source: "test", gateIds: [gate?.id] });
  });

  it("recovers an active terminal-worker gate with a visible decision and preserves history", () => {
    const repoRoot = tempRepo();
    writeConfig(repoRoot);
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
    const blocked = blockRunForTerminalWorker(storage, run);
    expect(blocked?.gate?.kind).toBe("worker_failed");
    expect(storage.getCurrentRun()?.status).toBe("BLOCKED");

    const result = recoverTerminalWorkerGate(storage, "test");
    const runAfter = storage.getCurrentRun();
    const recoveredGate = storage.listGates(run.id).find((item) => item.kind === "worker_failed");
    const decision = storage.listDecisions(run.id).find((item) => item.kind === WORKER_FAILURE_RECOVERED_DECISION);
    const event = storage.listEvents().find((item) => item.kind === "gate_recovery" && item.runId === run.id);
    const reconcile = runAfter ? blockRunForTerminalWorker(storage, runAfter) : undefined;
    const failedWorker = storage.listWorkers(run.id, 20).find((item) => item.id === worker.id);
    storage.close();

    expect(result.recovered).toBe(1);
    expect(result.workerIds).toEqual([worker.id]);
    expect(result.gateKinds).toEqual(["worker_failed"]);
    expect(runAfter?.status).toBe("RUNNING");
    // History is preserved: the gate is resolved (not deleted) and the failed worker row remains.
    expect(recoveredGate?.status).toBe("resolved");
    expect(failedWorker?.status).toBe("failed");
    // A visible event and decision explain the recovery.
    expect(event?.payload).toMatchObject({
      source: "test",
      scope: "run",
      reason: "operator_marked_obsolete",
      gateKinds: ["worker_failed"],
      workerIds: [worker.id]
    });
    expect(decision?.details).toMatchObject({
      source: "test",
      reason: "operator_marked_obsolete",
      workerIds: [worker.id],
      gateIds: [recoveredGate?.id]
    });
    // Reconcile must not silently re-open the gate for the recovered worker.
    expect(reconcile).toBeUndefined();
  });

  it("is a no-op when the current run has no active terminal-worker gate", () => {
    const repoRoot = tempRepo();
    writeConfig(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "WRITE_SPEC" });

    const result = recoverTerminalWorkerGate(storage, "test");
    const decisions = storage.listDecisions(run.id);
    const events = storage.listEvents().filter((item) => item.kind === "gate_recovery");
    storage.close();

    expect(result.recovered).toBe(0);
    expect(result.runId).toBe(run.id);
    expect(decisions).toEqual([]);
    expect(events).toEqual([]);
  });

  it("recoverBlockedRun composes repo-init and terminal-worker recovery", () => {
    const repoRoot = tempRepo();
    writeConfig(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    storage.writeGate({ kind: "needs_repo_init", message: "Missing config." });
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
      error: "boom"
    });
    blockRunForTerminalWorker(storage, run);
    storage.close();

    const result = recoverBlockedRun(repoRoot, "test");
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const repoGate = after.listGates().find((item) => item.kind === "needs_repo_init");
    const workerGate = after.listGates(run.id).find((item) => item.kind === "worker_failed");
    after.close();

    expect(result.recovered).toBe(2);
    expect(result.repo.recovered).toBe(1);
    expect(result.worker.recovered).toBe(1);
    expect(result.worker.workerIds).toEqual([worker.id]);
    expect(repoGate?.status).toBe("resolved");
    expect(workerGate?.status).toBe("resolved");
  });
});
