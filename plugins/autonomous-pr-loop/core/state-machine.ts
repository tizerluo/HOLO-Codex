import { execFileSync } from "node:child_process";
import { writeArtifact } from "./artifacts.js";
import { CommandRunner } from "./command-runner.js";
import { isRecord, loadConfig, statePath } from "./config.js";
import { AgentLoopError, isGateCode } from "./errors.js";
import { WORKER_FAILURE_RECOVERED_DECISION } from "./gate-recovery.js";
import { GENERIC_LOOP_SHAPE, PR_LOOP_SHAPE, resolveLoopShape, type LoopShape } from "./loop-shapes.js";
import { executeGenericLifecycleStep, executeGenericPreWorkerStep } from "./generic-lifecycle.js";
import { executePrLifecycleStep } from "./pr-lifecycle.js";
import { resolvePrSelection } from "./pr-selector.js";
import { getDeliveryWorkItem, type DeliveryWorkItem } from "./delivery-work-item.js";
import { applyProfileConfig, resolveProfile } from "./profiles.js";
import { SqliteAgentLoopStorage } from "./storage.js";
import { executeWorker } from "./worker.js";
import type { GitHubPullRequest } from "./github.js";
import type { AgentLoopConfig, AgentLoopGateKind, AgentLoopRun, WorkerRun, WorkerStatus } from "./types.js";
import type {
  AgentLoopState,
  AgentLoopTrigger,
  ArtifactRecord,
  CommandPlan,
  RealitySnapshot,
  StateMachineResult,
  StateTransition,
  TransitionGuard
} from "./state-types.js";

export const LOOP_STATES: AgentLoopState[] = [...new Set([...PR_LOOP_SHAPE.states, ...GENERIC_LOOP_SHAPE.states])];

export const TERMINAL_STATES: AgentLoopState[] = [...new Set([...PR_LOOP_SHAPE.terminalStates, ...GENERIC_LOOP_SHAPE.terminalStates])];

/** Single declarative transition table used by PR B and extended by later PRs. */
export const TRANSITIONS: StateTransition[] = [...PR_LOOP_SHAPE.transitions, ...GENERIC_LOOP_SHAPE.transitions];

/** Validate transition reachability and terminal-state coverage. */
export function validateTransitionTable(): string[] {
  const errors: string[] = [];
  for (const shape of [PR_LOOP_SHAPE, GENERIC_LOOP_SHAPE]) {
  const states = new Set(shape.states);
  for (const transition of shape.transitions) {
    if (!states.has(transition.from)) {
      errors.push(`${shape.id}: unknown from state: ${transition.from}`);
    }
    if (!states.has(transition.to)) {
      errors.push(`${shape.id}: unknown to state: ${transition.to}`);
    }
  }
  for (const state of shape.states) {
    const terminal = shape.terminalStates.includes(state);
    const hasExit = shape.transitions.some((transition) => transition.from === state);
    if (!terminal && !hasExit) {
      errors.push(`${shape.id}: state has no exit: ${state}`);
    }
    if (state !== "STOPPED" && state !== "COMPLETE" && !shape.transitions.some((transition) => transition.from === state && transition.to === "STOPPED" && transition.trigger === "stop")) {
      errors.push(`${shape.id}: state has no stop transition: ${state}`);
    }
  }
  const reachable = new Set<AgentLoopState>([shape.initialState]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const transition of shape.transitions) {
      if (reachable.has(transition.from) && !reachable.has(transition.to)) {
        reachable.add(transition.to);
        changed = true;
      }
    }
  }
  for (const state of shape.states.filter((item) => !shape.terminalStates.includes(item))) {
    if (!reachable.has(state)) {
      errors.push(`${shape.id}: state is unreachable: ${state}`);
    }
  }
  }
  return errors;
}

/** Return command plans for a state; dry-run records these without execution. */
export function planState(state: AgentLoopState, repoRoot: string): CommandPlan[] {
  if (state === "SYNC_MAIN") {
    return [
      {
        id: "git-status",
        file: "git",
        args: ["status", "--short", "--branch"],
        cwd: repoRoot,
        purpose: "Inspect current worktree before loop progress."
      },
      {
        id: "git-branch",
        file: "git",
        args: ["branch", "--show-current"],
        cwd: repoRoot,
        purpose: "Record branch for resume reality checks."
      }
    ];
  }
  if (state === "DISCOVER_PROGRESS") {
    return [
      {
        id: "git-work-tree",
        file: "git",
        args: ["rev-parse", "--is-inside-work-tree"],
        cwd: repoRoot,
        purpose: "Confirm repo context before selecting next PR."
      }
    ];
  }
  return [];
}

/** Start or continue a dry-run state machine until one step or the next gate. */
export async function runStateMachine(options: {
  repoRoot: string;
  dryRun: boolean;
  untilGate: boolean;
  singleStep?: boolean;
  signal?: AbortSignal | undefined;
  pullRequests?: GitHubPullRequest[];
}): Promise<StateMachineResult> {
  assertTransitionTable();
  const storage = new SqliteAgentLoopStorage(statePath(options.repoRoot));
  try {
    const configResult = tryLoadConfig(options.repoRoot);
    const shape = configResult.ok ? resolveLoopShape(applyProfileConfig(configResult.config).loopShape) : PR_LOOP_SHAPE;
    const run = ensureRun(storage, options.repoRoot, shape);
    if (!configResult.ok) {
      return blockRun(storage, run, "needs_repo_init", configResult.error.message, configResult.error.details);
    }
    const effectiveConfig = applyProfileConfig(configResult.config);
    auditProfileSelection(storage, run, effectiveConfig);
    let currentRun = run;
    const openGate = storage.listGates(run.id).find((item) => item.status === "open");
    if (run.status === "BLOCKED" && openGate) {
      const workItem = getDeliveryWorkItem(storage, currentRun.id);
      if (shape.id === "pr-loop" && !options.dryRun && openGate.kind === "ambiguous_next_pr" && !resolvePrSelection(options.repoRoot, effectiveConfig, selectionOptions(options.pullRequests, options.dryRun, workItem)).ambiguous) {
        storage.resolveOpenGatesByKind("ambiguous_next_pr", { scope: "run", runId: run.id });
        currentRun = storage.updateRunStatus(run.id, run.version, "RUNNING", { currentState: normalizeState(run.currentState, shape) });
        storage.appendEvent({
          runId: currentRun.id,
          kind: "gate_recovery",
          message: "Resolved ambiguous_next_pr after PR selector found a unique target.",
          payload: { gate: "ambiguous_next_pr", source: "state_machine" }
        });
      } else {
      return {
        ok: false,
        runId: run.id,
        status: "BLOCKED",
        currentState: normalizeState(run.currentState, shape),
        transitions: [],
          gate: { kind: openGate.kind, message: openGate.message, ...(openGate.details === undefined ? {} : { details: openGate.details }) },
        artifacts: []
      };
      }
    }
    const workerGate = blockRunForTerminalWorker(storage, currentRun);
    if (workerGate) {
      return workerGate;
    }

    const transitions: Array<{ from: AgentLoopState; to: AgentLoopState }> = [];
    const artifacts: ArtifactRecord[] = [];
    let current = normalizeState(currentRun.currentState, shape);
    if (shape.id === "generic-loop" && currentRun.status === "READY" && current === "COMPLETE") {
      return {
        ok: true,
        runId: currentRun.id,
        status: "READY",
        currentState: "COMPLETE",
        transitions,
        artifacts
      };
    }
    if (shape.id === "pr-loop" && currentRun.status === "READY" && current === "SELECT_NEXT_PR" && deliveryRunCompleted(storage, currentRun.id)) {
      return {
        ok: true,
        runId: currentRun.id,
        status: "READY",
        currentState: "SELECT_NEXT_PR",
        transitions,
        artifacts
      };
    }
    const maxSteps = options.untilGate ? 10 : 1;

    for (let index = 0; index < maxSteps; index += 1) {
      if (shape.id === "pr-loop" && current === "SELECT_NEXT_PR") {
        const workItem = getDeliveryWorkItem(storage, currentRun.id);
        const selection = resolvePrSelection(options.repoRoot, effectiveConfig, selectionOptions(options.pullRequests, options.dryRun, workItem));
        if (selection.ambiguous) {
          return blockRun(
            storage,
            currentRun,
            "ambiguous_next_pr",
            "Could not uniquely identify the next PR from the configured plans directory.",
            {
              plansDir: effectiveConfig.plansDir,
              reason: selection.reason,
              candidates: selection.candidates,
              evidence: selection.evidence
            }
          );
        }
        if (selection.mode === "current_pr") {
          if (!options.dryRun) {
            storage.upsertPrLink({
              runId: currentRun.id,
              branch: selection.pr.headRefName,
              prNumber: selection.pr.number,
              url: selection.pr.url,
              headRef: selection.pr.headRefName,
              baseRef: selection.pr.baseRefName,
              state: selection.pr.state,
              draft: selection.pr.isDraft
            });
            storage.appendDecision({
              runId: currentRun.id,
              kind: "pr_reused",
              message: `Selected existing PR #${selection.pr.number} for ${selection.item.id}.`,
              details: { branch: selection.pr.headRefName, spec: selection.item.file }
            });
          }
          const nextState: AgentLoopState = "WAIT_REVIEW_OR_CI";
          transitions.push({ from: current, to: nextState });
          if (!options.dryRun) {
            currentRun = storage.updateRunStatus(currentRun.id, currentRun.version, "RUNNING", {
              currentState: nextState,
              branch: selection.pr.headRefName,
              worktreeClean: true
            });
          } else {
            currentRun = { ...currentRun, currentState: nextState, branch: selection.pr.headRefName, worktreeClean: true };
          }
          storage.appendEvent({
            runId: currentRun.id,
            kind: "state_transition",
            message: `${current} -> ${nextState}`,
            stateBefore: current,
            stateAfter: nextState,
            payload: { selectedPr: selection.item.id, prNumber: selection.pr.number, branch: selection.pr.headRefName, explicitWorkItem: workItem }
          });
          current = nextState;
          continue;
        }
      }
      const next = nextTransition(shape, current, "step", "progress", { includeTerminal: shape.id === "generic-loop" });
      if (!next) {
        break;
      }
      const preWorkerGenericLifecycle = shape.id === "generic-loop"
        ? executeGenericPreWorkerStep({ storage, run: currentRun, state: current, dryRun: options.dryRun })
        : {};
      if (preWorkerGenericLifecycle.transitionGuard) {
        const transition = nextTransition(shape, current, "step", "progress", {
          guard: preWorkerGenericLifecycle.transitionGuard,
          includeTerminal: true
        });
        if (!transition) {
          throw new AgentLoopError("storage_error", `No generic transition from ${current} for guard ${preWorkerGenericLifecycle.transitionGuard}.`);
        }
        const nextState = transition.to;
        const nextStatus = preWorkerGenericLifecycle.status ?? (nextState === "STOPPED" ? "STOPPED" : "RUNNING");
        if (!options.dryRun) {
          currentRun = storage.updateRunStatus(currentRun.id, currentRun.version, nextStatus, { currentState: nextState });
        } else {
          currentRun = { ...currentRun, currentState: nextState, status: nextStatus };
        }
        storage.appendEvent({
          runId: currentRun.id,
          kind: "state_transition",
          message: `${current} -> ${nextState}`,
          stateBefore: current,
          stateAfter: nextState,
          payload: { dryRun: options.dryRun, loopShape: shape.id, genericLifecycle: preWorkerGenericLifecycle }
        });
        transitions.push({ from: current, to: nextState });
        current = nextState;
        if (options.singleStep || shape.terminalStates.includes(current)) {
          break;
        }
        continue;
      }
      const plans = planState(current, options.repoRoot);
      const artifact = writeArtifact(
        options.repoRoot,
        storage,
        currentRun.id,
        "dry-run-plan",
        `${current.toLowerCase()}.json`,
        `${JSON.stringify({ state: current, dryRun: options.dryRun, plans }, null, 2)}\n`
      );
      artifacts.push(artifact);
      const commandResults = await applyCommandPlans(
        options.repoRoot,
        storage,
        currentRun.id,
        effectiveConfig,
        plans,
        options.dryRun,
        options.signal
      );
      let workerResult: Awaited<ReturnType<typeof executeWorker>> | undefined;
      let lifecycle: Awaited<ReturnType<typeof executePrLifecycleStep>> | undefined;
      let genericLifecycle: Awaited<ReturnType<typeof executeGenericLifecycleStep>> | undefined;
      try {
        const workerType = shape.defaultRoleForState(current);
        if (workerType) {
          workerResult = await executeWorker({
            repoRoot: options.repoRoot,
              storage,
              run: currentRun,
              config: effectiveConfig,
              state: current,
              type: workerType,
              dryRun: options.dryRun,
              signal: options.signal
            });
          artifacts.push(...workerResult.artifacts);
        }
        lifecycle = shape.id === "pr-loop" && !options.dryRun
          ? await executePrLifecycleStep({
              repoRoot: options.repoRoot,
              storage,
              run: currentRun,
              config: effectiveConfig,
              state: current,
              signal: options.signal
            })
          : undefined;
        genericLifecycle = shape.id === "generic-loop"
          ? await executeGenericLifecycleStep({
              repoRoot: options.repoRoot,
              storage,
              run: currentRun,
              config: effectiveConfig,
              state: current,
              dryRun: options.dryRun,
              ...(workerResult?.result ? { workerResult: workerResult.result } : {})
            })
          : undefined;
      } catch (error) {
        if (error instanceof AgentLoopError && isGateCode(error.code)) {
          return blockRun(storage, currentRun, error.code, error.message, error.details);
        }
        throw error;
      }
      const selectedGenericTransition = shape.id === "generic-loop"
        ? nextTransition(shape, current, "step", "progress", {
            guard: genericLifecycle?.transitionGuard ?? "always",
            includeTerminal: true
          })
        : undefined;
      if (shape.id === "generic-loop" && !selectedGenericTransition) {
        throw new AgentLoopError("storage_error", `No generic transition from ${current} for guard ${genericLifecycle?.transitionGuard ?? "always"}.`);
      }
      const nextState = lifecycle?.nextState ?? selectedGenericTransition?.to ?? next.to;
      artifacts.push(...(genericLifecycle?.artifacts ?? []));
      const nextStatus = genericLifecycle?.status ?? (shape.id === "generic-loop" && nextState === "COMPLETE" ? "READY" : nextState === "STOPPED" ? "STOPPED" : "RUNNING");
      const updateOptions: {
        currentState: AgentLoopState;
        branch?: string;
        worktreeClean?: boolean;
      } = { currentState: nextState };
      if (lifecycle?.branch !== undefined) {
        updateOptions.branch = lifecycle.branch;
      }
      if (lifecycle?.worktreeClean !== undefined) {
        updateOptions.worktreeClean = lifecycle.worktreeClean;
      }
      if (!options.dryRun) {
        currentRun = storage.updateRunStatus(currentRun.id, currentRun.version, nextStatus, updateOptions);
      } else {
        currentRun = { ...currentRun, currentState: nextState, status: nextStatus };
      }
      if (shape.id === "generic-loop" && nextState === "COMPLETE" && !options.dryRun) {
        storage.appendDecision({
          runId: currentRun.id,
          kind: "generic_loop_completed",
          message: "Generic loop completed.",
          details: { loopShape: shape.id, workflowProfile: effectiveConfig.workflowProfile }
        });
      }
      storage.appendEvent({
        runId: currentRun.id,
        kind: "state_transition",
        message: `${current} -> ${nextState}`,
        stateBefore: current,
        stateAfter: nextState,
        payload: { dryRun: options.dryRun, loopShape: shape.id, plans, commandResults, worker: workerResult, lifecycle, genericLifecycle },
        artifactIds: [artifact.id, ...(workerResult?.artifacts.map((item) => item.id) ?? []), ...(genericLifecycle?.artifacts?.map((item) => item.id) ?? [])]
      });
      transitions.push({ from: current, to: nextState });
      current = nextState;
      if (!options.dryRun && shape.id === "pr-loop" && nextState === "SELECT_NEXT_PR" && maybeCompleteMergedDeliveryRun(storage, currentRun)) {
        currentRun = storage.listRuns(20).find((item) => item.id === currentRun.id) ?? currentRun;
        break;
      }
      if (options.singleStep) {
        break;
      }
      if (shape.terminalStates.includes(current)) {
        break;
      }
    }

    const result: StateMachineResult = {
      ok: true,
      runId: currentRun.id,
      status: currentRun.status,
      currentState: normalizeState(currentRun.currentState, shape),
      transitions,
      artifacts
    };
    return result;
  } finally {
    storage.close();
  }
}

/** Resume the latest run after validating branch and clean-worktree reality. */
export async function resumeStateMachine(repoRoot: string): Promise<StateMachineResult> {
  assertTransitionTable();
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const run = storage.getCurrentRun();
    if (!run) {
      return await runStateMachine({ repoRoot, dryRun: true, untilGate: false });
    }
    const configResult = tryLoadConfig(repoRoot);
    const shape = configResult.ok ? resolveLoopShape(applyProfileConfig(configResult.config).loopShape) : shapeForStoredState(run.currentState);
    if (shape.id === "generic-loop" && run.status === "READY" && normalizeState(run.currentState, shape) === "COMPLETE") {
      return {
        ok: true,
        runId: run.id,
        status: "READY",
        currentState: "COMPLETE",
        transitions: [],
        artifacts: []
      };
    }
    if (run.status === "STOPPED") {
      return {
        ok: false,
        runId: run.id,
        status: run.status,
        currentState: normalizeState(run.currentState, shape),
        transitions: [],
        artifacts: []
      };
    }
    let currentRun = run;
    if (currentRun.status === "BLOCKED") {
      const openGate = storage.listGates(currentRun.id).find((gate) => gate.status === "open");
      if (openGate?.kind === "ambiguous_next_pr") {
        const effectiveConfig = configResult.ok ? applyProfileConfig(configResult.config) : undefined;
        const workItem = effectiveConfig ? getDeliveryWorkItem(storage, currentRun.id) : undefined;
        if (effectiveConfig && !resolvePrSelection(repoRoot, effectiveConfig, { githubRequired: true, ...(workItem ? { workItem } : {}) }).ambiguous) {
          storage.resolveOpenGatesByKind("ambiguous_next_pr", { scope: "run", runId: currentRun.id });
          currentRun = storage.updateRunStatus(currentRun.id, currentRun.version, "RUNNING", { currentState: normalizeState(currentRun.currentState, resolveLoopShape(effectiveConfig.loopShape)) });
          storage.appendEvent({
            runId: currentRun.id,
            kind: "gate_recovery",
            message: "Resolved ambiguous_next_pr before resume after PR selector found a unique target.",
            payload: { gate: "ambiguous_next_pr", source: "resume" }
          });
        }
      }
      if (storage.listGates(currentRun.id).some((gate) => gate.status === "open")) {
        return {
          ok: false,
          runId: currentRun.id,
          status: currentRun.status,
          currentState: normalizeState(currentRun.currentState),
          transitions: [],
          artifacts: []
        };
      }
      if (currentRun.status === "BLOCKED") {
        currentRun = storage.updateRunStatus(currentRun.id, currentRun.version, "RUNNING");
      }
    }
    const workerGate = blockRunForTerminalWorker(storage, currentRun);
    if (workerGate) {
      return workerGate;
    }
    const reality = readReality(repoRoot);
    if (
      (currentRun.branch && currentRun.branch !== reality.branch) ||
      (currentRun.worktreeClean !== undefined && currentRun.worktreeClean !== reality.worktreeClean)
    ) {
      return blockRun(storage, currentRun, "dirty_unowned_worktree", "Reality check failed before resume.", {
        expected: { branch: currentRun.branch, worktreeClean: currentRun.worktreeClean },
        actual: reality
      });
    }
      return await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });
  } finally {
    storage.close();
  }
}

/** Stop the current run without deleting state history. */
export function stopStateMachine(repoRoot: string): StateMachineResult {
  assertTransitionTable();
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    let run = storage.getCurrentRun();
    if (!run) {
      return {
        ok: true,
        status: "STOPPED",
        currentState: "STOPPED",
        transitions: [],
        artifacts: []
      };
    }
    const shape = shapeForStoredState(run.currentState);
    const stateBefore = normalizeState(run.currentState, shape);
    const stopTransition = nextTransition(shape, stateBefore, "stop", "terminal");
    if (!stopTransition) {
      throw new AgentLoopError("storage_error", `No stop transition for state ${normalizeState(run.currentState, shape)}.`);
    }
    storage.resolveOpenGates(run.id);
    const runningWorker = storage.getRunningWorker();
    if (runningWorker) {
      storage.updateWorker(runningWorker.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        exitCode: 130,
        error: "Stopped by supervisor."
      });
    }
    let stopped: AgentLoopRun | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        stopped = storage.updateRunStatus(run.id, run.version, "STOPPED", {
          currentState: "STOPPED",
          stoppedAt: new Date().toISOString()
        });
        break;
      } catch (error) {
        if (!(error instanceof AgentLoopError) || error.code !== "version_conflict" || attempt === 2) {
          throw error;
        }
        run = storage.getCurrentRun() ?? run;
      }
    }
    if (!stopped) {
      throw new AgentLoopError("storage_error", "Run stop did not complete.");
    }
    storage.appendEvent({
      runId: stopped.id,
      kind: "run_stopped",
      message: "Run stopped by CLI.",
      stateBefore,
      stateAfter: "STOPPED"
    });
    return {
      ok: true,
      runId: stopped.id,
      status: "STOPPED",
      currentState: "STOPPED",
      transitions: [{ from: stopTransition.from, to: "STOPPED" }],
      artifacts: []
    };
  } finally {
    storage.close();
  }
}

function maybeCompleteMergedDeliveryRun(storage: SqliteAgentLoopStorage, run: AgentLoopRun): boolean {
  if (!getDeliveryWorkItem(storage, run.id) || !hasMergeDecision(storage, run.id) || deliveryRunCompleted(storage, run.id)) {
    return false;
  }
  const completed = storage.updateRunStatus(run.id, run.version, "READY", { currentState: "SELECT_NEXT_PR", worktreeClean: true });
  storage.appendDecision({
    runId: completed.id,
    kind: "delivery_run_completed",
    message: "Delivery run completed after merge cleanup.",
    details: { currentState: "SELECT_NEXT_PR" }
  });
  storage.appendEvent({
    runId: completed.id,
    kind: "delivery_run_completed",
    message: "Delivery run completed after merge cleanup.",
    stateBefore: "SELECT_NEXT_PR",
    stateAfter: "SELECT_NEXT_PR"
  });
  return true;
}

function hasMergeDecision(storage: SqliteAgentLoopStorage, runId: string): boolean {
  return storage.listDecisions(runId).some((decision) => decision.kind === "pr_merged" || decision.kind === "merge_reused");
}

function deliveryRunCompleted(storage: SqliteAgentLoopStorage, runId: string): boolean {
  return storage.listDecisions(runId).some((decision) => decision.kind === "delivery_run_completed");
}

function ensureRun(
  storage: SqliteAgentLoopStorage,
  repoRoot: string,
  shape: LoopShape
): AgentLoopRun {
  const existing = storage.getCurrentRun();
  if (existing && existing.status !== "STOPPED") {
    return existing;
  }
  const reality = readReality(repoRoot);
  return storage.createRun("RUNNING", {
    currentState: shape.initialState,
    branch: reality.branch,
    worktreeClean: reality.worktreeClean
  });
}

function auditProfileSelection(
  storage: SqliteAgentLoopStorage,
  run: AgentLoopRun,
  config: AgentLoopConfig
): void {
  if (storage.listDecisions(run.id).some((decision) => decision.kind === "profile_selected")) {
    return;
  }
  const profile = resolveProfile(config, normalizeState(run.currentState, resolveLoopShape(config.loopShape)));
  const details = {
    loopShape: profile.loopShape,
    workflowProfile: profile.workflowProfile,
    roleProfile: profile.roleProfile,
    currentRole: profile.currentRole,
    roleMapping: profile.roleMapping,
    autonomyBoundary: profile.autonomyBoundary,
    validationPosture: profile.validationPosture,
    source: "config_or_default"
  };
  storage.appendDecision({
    runId: run.id,
    kind: "profile_selected",
    message: `Selected workflow profile ${profile.workflowProfile} for ${profile.loopShape}.`,
    details
  });
  storage.appendEvent({
    runId: run.id,
    kind: "profile_selected",
    message: `Selected workflow profile ${profile.workflowProfile}.`,
    payload: details
  });
}

function blockRun(
  storage: SqliteAgentLoopStorage,
  run: AgentLoopRun,
  kind: AgentLoopGateKind,
  message: string,
  details?: unknown
): StateMachineResult {
  const stateBefore = stateFromGateDetails(details) ?? normalizeState(run.currentState, shapeForStoredState(run.currentState));
  const blocked = storage.updateRunStatus(run.id, run.version, "BLOCKED", {
    currentState: stateBefore
  });
  storage.writeGate({ runId: blocked.id, kind, message, details });
  storage.appendEvent({
    runId: blocked.id,
    kind: "gate_opened",
    message,
    stateBefore,
    stateAfter: "BLOCKED",
    payload: { gate: kind, details }
  });
  return {
    ok: false,
    runId: blocked.id,
    status: "BLOCKED",
    currentState: stateBefore,
    transitions: [{ from: stateBefore, to: "BLOCKED" }],
    gate: { kind, message, ...(details === undefined ? {} : { details }) },
    artifacts: []
  };
}

function stateFromGateDetails(details: unknown): AgentLoopState | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const state = (details as { state?: unknown }).state;
  return typeof state === "string" ? normalizeState(state, shapeForStoredState(state)) : undefined;
}

/** Convert a terminal worker failure on a still-running run into a visible gate. */
export function blockRunForTerminalWorker(
  storage: SqliteAgentLoopStorage,
  run: AgentLoopRun
): StateMachineResult | undefined {
  if (run.status !== "RUNNING" || storage.listGates(run.id).some((gate) => gate.status === "open")) {
    return undefined;
  }
  const recoveredWorkerIds = collectRecoveredWorkerIds(storage, run.id);
  const workers = storage.listWorkers(run.id, 20);
  if (workers.length === 0 || workers.some((item) => item.status === "running")) {
    return undefined;
  }
  const latestStartedAt = workers.reduce((latest, item) => item.startedAt > latest ? item.startedAt : latest, workers[0]?.startedAt ?? "");
  const latestWorkers = workers.filter((item) => item.startedAt === latestStartedAt);
  if (latestWorkers.some((item) => item.status === "succeeded")) {
    return undefined;
  }
  const worker = latestWorkers.find((item) => gateForTerminalWorker(item) !== undefined && !recoveredWorkerIds.has(item.id));
  if (!worker) return undefined;
  const gate = gateForTerminalWorker(worker);
  if (!gate) {
    return undefined;
  }
  return blockRun(storage, run, gate, messageForTerminalWorker(worker), detailsForTerminalWorker(worker));
}

/**
 * Worker ids an operator has explicitly marked obsolete via recovery. Reconcile must not
 * re-open a gate for these workers; doing so would silently hide an active failure and
 * trap the run. A fresh worker attempt (new id) is not in this set until recovered again.
 */
function collectRecoveredWorkerIds(storage: SqliteAgentLoopStorage, runId: string): Set<string> {
  const ids = new Set<string>();
  for (const decision of storage.listDecisions(runId)) {
    if (decision.kind !== WORKER_FAILURE_RECOVERED_DECISION || !isRecord(decision.details)) {
      continue;
    }
    const workerIds = decision.details.workerIds;
    if (Array.isArray(workerIds)) {
      for (const id of workerIds) {
        if (typeof id === "string") {
          ids.add(id);
        }
      }
    }
  }
  return ids;
}

function gateForTerminalWorker(worker: WorkerRun): AgentLoopGateKind | undefined {
  const gates: Partial<Record<WorkerStatus, AgentLoopGateKind>> = {
    failed: "worker_failed",
    invalid_output: "worker_output_invalid",
    timed_out: "worker_timeout"
  };
  return gates[worker.status];
}

function messageForTerminalWorker(worker: WorkerRun): string {
  if (worker.status === "invalid_output") {
    return "Worker output did not match schema.";
  }
  if (worker.status === "timed_out") {
    return "Codex worker timed out.";
  }
  return worker.error ?? "Codex worker failed.";
}

function detailsForTerminalWorker(worker: WorkerRun): Record<string, unknown> {
  return {
    workerId: worker.id,
    workerType: worker.type,
    attempt: worker.attempt,
    ...(worker.exitCode === undefined ? {} : { exitCode: worker.exitCode }),
    ...(worker.error === undefined ? {} : { error: worker.error }),
    ...(worker.threadId === undefined ? {} : { threadId: worker.threadId })
  };
}

function selectionOptions(
  pullRequests: GitHubPullRequest[] | undefined,
  dryRun: boolean,
  workItem?: DeliveryWorkItem
): { pullRequests?: GitHubPullRequest[]; githubRequired: boolean; workItem?: DeliveryWorkItem } {
  return {
    ...(pullRequests === undefined ? {} : { pullRequests }),
    githubRequired: !dryRun,
    ...(workItem ? { workItem } : {})
  };
}

function assertTransitionTable(): void {
  const errors = validateTransitionTable();
  if (errors.length > 0) {
    throw new AgentLoopError("storage_error", "State transition table is invalid.", {
      details: { errors }
    });
  }
}

function nextTransition(
  shape: LoopShape,
  state: AgentLoopState,
  trigger: AgentLoopTrigger,
  mode: "progress" | "terminal",
  options: { guard?: TransitionGuard; includeTerminal?: boolean } = {}
): StateTransition | undefined {
  return shape.transitions.find((transition) => {
    if (transition.from !== state || transition.trigger !== trigger) {
      return false;
    }
    if (options.guard !== undefined && transition.guard !== options.guard) {
      return false;
    }
    const terminal = shape.terminalStates.includes(transition.to);
    if (options.includeTerminal && mode === "progress") {
      return true;
    }
    return mode === "terminal" ? terminal : !terminal;
  });
}

function tryLoadConfig(
  repoRoot: string
):
  | { ok: true; config: ReturnType<typeof loadConfig>["config"] }
  | { ok: false; error: AgentLoopError } {
  try {
    return { ok: true, config: loadConfig(repoRoot).config };
  } catch (error) {
    if (error instanceof AgentLoopError) {
      return { ok: false, error };
    }
    throw error;
  }
}

function normalizeState(value: string | undefined, shape: LoopShape = PR_LOOP_SHAPE): AgentLoopState {
  return shape.states.includes(value as AgentLoopState) ? (value as AgentLoopState) : shape.initialState;
}

function shapeForStoredState(value: string | undefined): LoopShape {
  return value && GENERIC_LOOP_SHAPE.states.includes(value as AgentLoopState) ? GENERIC_LOOP_SHAPE : PR_LOOP_SHAPE;
}

function readReality(repoRoot: string): RealitySnapshot {
  try {
    return {
      branch: execFileSync("git", ["branch", "--show-current"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim(),
      worktreeClean:
        execFileSync("git", ["status", "--short"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        }).trim().length === 0
    };
  } catch (error) {
    throw new AgentLoopError("not_git_repo", "Could not read git reality for this repository.", {
      details: { cause: error instanceof Error ? error.message : String(error) }
    });
  }
}

async function applyCommandPlans(
  repoRoot: string,
  storage: SqliteAgentLoopStorage,
  runId: string,
  config: ReturnType<typeof loadConfig>["config"],
  plans: CommandPlan[],
  dryRun: boolean,
  signal?: AbortSignal
): Promise<unknown[]> {
  const runner = new CommandRunner({ repoRoot, storage, runId, config, signal });
  const results = [];
  for (const plan of plans) {
    results.push(await runner.run(plan, dryRun));
  }
  return results;
}
