import { isRecord, loadConfig, statePath } from "./config.js";
import { SqliteAgentLoopStorage } from "./storage.js";
import type { AgentLoopGateKind } from "./types.js";

export interface GateRecoveryResult {
  ok: true;
  recovered: number;
  scope: "repo";
  kind: AgentLoopGateKind;
  warnings: string[];
}

/** Terminal worker failure kinds that an operator can explicitly recover so resume re-attempts the worker. */
export const TERMINAL_WORKER_GATE_KINDS: AgentLoopGateKind[] = [
  "worker_failed",
  "worker_output_invalid",
  "worker_timeout"
];

/** Decision kind recorded when an operator marks an active worker failure obsolete for resume. */
export const WORKER_FAILURE_RECOVERED_DECISION = "worker_failure_recovered";

export interface RepoGateRecovery {
  recovered: number;
  kind: "needs_repo_init";
}

export interface WorkerGateRecovery {
  recovered: number;
  runId?: string;
  gateKinds: AgentLoopGateKind[];
  gateIds: string[];
  workerIds: string[];
}

export interface RunRecoveryResult {
  ok: true;
  /** Total gates recovered across repo-level and run-scoped recovery (kept stable for callers that expect a single count). */
  recovered: number;
  repo: RepoGateRecovery;
  worker: WorkerGateRecovery;
  warnings: string[];
}

/** Explicitly recover repo-level gates whose blocking condition has already cleared. */
export function recoverSatisfiedRepoGates(repoRoot: string, source = "cli"): GateRecoveryResult {
  loadConfig(repoRoot);
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const before = storage.listGates().filter((gate) =>
      gate.kind === "needs_repo_init" && gate.status === "open" && gate.runId === undefined
    );
    storage.resolveOpenGatesByKind("needs_repo_init", { scope: "repo" });
    const after = storage.listGates().filter((gate) =>
      gate.kind === "needs_repo_init" && gate.status === "open" && gate.runId === undefined
    );
    const recovered = before.length - after.length;
    if (recovered > 0) {
      const gateIds = before.slice(0, recovered).map((gate) => gate.id);
      const payload = {
        source,
        scope: "repo",
        kind: "needs_repo_init",
        recovered,
        gateIds,
        reason: "config_exists_and_valid"
      };
      storage.appendEvent({
        kind: "gate_recovery",
        message: "Recovered repo-level needs_repo_init gate after config became valid.",
        payload
      });
      const run = storage.getCurrentRun();
      if (run) {
        storage.appendDecision({
          runId: run.id,
          kind: "gate_recovery",
          message: "Explicit recovery resolved repo-level needs_repo_init gate.",
          details: payload
        });
      }
    }
    return { ok: true, recovered, scope: "repo", kind: "needs_repo_init", warnings: [] };
  } finally {
    storage.close();
  }
}

/**
 * Resolve active terminal-worker gates on the current run so `resume` can re-attempt the worker.
 *
 * The gate is resolved (never deleted), the failed worker row is preserved, and a visible
 * `gate_recovery` event plus a `worker_failure_recovered` decision are appended so the
 * recovery stays auditable and `blockRunForTerminalWorker` will not silently re-open the gate.
 * Returns a zero recovery when the current run has no active terminal-worker gate.
 */
export function recoverTerminalWorkerGate(
  storage: SqliteAgentLoopStorage,
  source: "cli" | "dashboard" | "ui" | "api" | "test" = "cli"
): WorkerGateRecovery {
  const empty: WorkerGateRecovery = { recovered: 0, gateKinds: [], gateIds: [], workerIds: [] };
  const run = storage.getCurrentRun();
  if (!run || run.status === "STOPPED") {
    return empty;
  }
  const openWorkerGates = storage
    .listGates(run.id)
    .filter((gate) => gate.status === "open" && TERMINAL_WORKER_GATE_KINDS.includes(gate.kind));
  if (openWorkerGates.length === 0) {
    return { ...empty, runId: run.id };
  }
  const gateKinds = [...new Set(openWorkerGates.map((gate) => gate.kind))];
  const gateIds = openWorkerGates.map((gate) => gate.id);
  const workerIds = [...new Set(openWorkerGates.map((gate) => gateWorkerId(gate.details)).filter((id): id is string => Boolean(id)))];
  for (const kind of gateKinds) {
    storage.resolveOpenGatesByKind(kind, { scope: "run", runId: run.id });
  }
  const payload = {
    source,
    scope: "run" as const,
    reason: "operator_marked_obsolete",
    gateKinds,
    gateIds,
    workerIds,
    runId: run.id
  };
  storage.appendEvent({
    runId: run.id,
    kind: "gate_recovery",
    message: "Recovered active terminal-worker gate; resume will re-attempt the worker.",
    payload
  });
  storage.appendDecision({
    runId: run.id,
    kind: WORKER_FAILURE_RECOVERED_DECISION,
    message: "Operator marked the active worker failure obsolete and cleared the gate for resume.",
    details: payload
  });
  // Flip the run back to RUNNING so the next reconcile does not report BLOCKED and `resume` can re-run the worker.
  // blockRunForTerminalWorker honors the recovery decision and will not re-open the gate for these workers.
  if (run.status === "BLOCKED") {
    storage.updateRunStatus(run.id, run.version, "RUNNING", run.currentState ? { currentState: run.currentState } : {});
  }
  return { recovered: openWorkerGates.length, runId: run.id, gateKinds, gateIds, workerIds };
}

function gateWorkerId(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  return typeof details.workerId === "string" ? details.workerId : undefined;
}

/**
 * Single recovery entry point for CLI, MCP, and Dashboard: recover repo-level init gates
 * whose config is now valid, then recover any active terminal-worker gate on the current run.
 * Both legs preserve audit history and emit visible events/decisions.
 */
export function recoverBlockedRun(
  repoRoot: string,
  source: "cli" | "dashboard" | "ui" | "api" | "test" = "cli"
): RunRecoveryResult {
  loadConfig(repoRoot);
  const repoResult = recoverSatisfiedRepoGates(repoRoot, source);
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const worker = recoverTerminalWorkerGate(storage, source);
    return {
      ok: true,
      recovered: repoResult.recovered + worker.recovered,
      repo: { recovered: repoResult.recovered, kind: "needs_repo_init" },
      worker,
      warnings: repoResult.warnings
    };
  } finally {
    storage.close();
  }
}
