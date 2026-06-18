import type { AgentLoopGateKind, AgentLoopStatus } from "./types.js";

/** Loop state names handled by the declarative state machine. */
export type AgentLoopState =
  | "SYNC_MAIN"
  | "DISCOVER_PROGRESS"
  | "SELECT_NEXT_PR"
  | "WRITE_SPEC"
  | "CREATE_BRANCH"
  | "IMPLEMENT"
  | "SELF_CHECK"
  | "COMMIT_PUSH_PR"
  | "WAIT_REVIEW_OR_CI"
  | "FIX_REVIEW"
  | "PUSH_FIX"
  | "READY_TO_MERGE"
  | "MERGE"
  | "DEFINE_GOAL"
  | "COLLECT_CONTEXT"
  | "PLAN_WORK"
  | "EXECUTE_STEP"
  | "SELF_REVIEW"
  | "HUMAN_GATE"
  | "DELIVER"
  | "COMPLETE"
  | "BLOCKED"
  | "STOPPED";

/** State machine trigger names represented in the transition table. */
export type AgentLoopTrigger = "step" | "stop";

/** Runtime artifact kind allowlist used to keep artifact paths constrained. */
export const ARTIFACT_KINDS = [
  "spec",
  "command-output",
  "dry-run-plan",
  "state-snapshot",
  "log",
  "worker-prompt",
  "worker-result",
  "worker-jsonl",
  "generic-context",
  "generic-plan",
  "generic-deliverable"
] as const;

/** Artifact kinds persisted under `.agent-loop/artifacts`. */
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Declarative state transition row. Guards are named so tests can inspect the table. */
export interface StateTransition {
  from: AgentLoopState;
  to: AgentLoopState;
  trigger: AgentLoopTrigger;
  guard?:
    | "always"
    | "config_present"
    | "next_pr_unique"
    | "goal_clear"
    | "goal_unclear"
    | "skip_context"
    | "scope_change_requested"
    | "scope_change_approved"
    | "review_passed"
    | "fix_needed_cycles_remain"
    | "review_cycles_exhausted"
    | "deliverable_approved"
    | "request_changes"
    | "rejected";
}

/** Named transition guard selected by shape-aware lifecycle code. */
export type TransitionGuard = NonNullable<StateTransition["guard"]>;

/** Structured command plan. Commands are never represented as shell strings. */
export interface CommandPlan {
  id: string;
  file: string;
  args: string[];
  cwd: string;
  purpose: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
}

/** Result of executing or dry-running a command plan. */
export interface CommandRunResult {
  plan: CommandPlan;
  dryRun: boolean;
  allowed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  artifactIds: string[];
  rejectionReason?: string;
}

/** Artifact metadata persisted in SQLite and verified by sha256 on read. */
export interface ArtifactRecord {
  id: string;
  runId: string;
  kind: ArtifactKind;
  name: string;
  path: string;
  sha256: string;
  createdAt: string;
}

/** Snapshot of real git state used to prevent unsafe resume behavior. */
export interface RealitySnapshot {
  branch: string;
  worktreeClean: boolean;
}

/** Result returned by state-machine operations and CLI JSON output. */
export interface StateMachineResult {
  ok: boolean;
  runId?: string;
  status: AgentLoopStatus;
  currentState?: AgentLoopState;
  transitions: Array<{ from: AgentLoopState; to: AgentLoopState }>;
  gate?: {
    kind: AgentLoopGateKind;
    message: string;
    details?: unknown;
  };
  artifacts: ArtifactRecord[];
}
