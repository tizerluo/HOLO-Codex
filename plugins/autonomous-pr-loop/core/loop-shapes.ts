import { AgentLoopError } from "./errors.js";
import type { AgentLoopState, StateTransition } from "./state-types.js";
import type { LoopShapeId, WorkerType } from "./types.js";

export interface LoopShape {
  id: LoopShapeId;
  label: string;
  lifecycleKind: "pr" | "generic";
  initialState: AgentLoopState;
  states: AgentLoopState[];
  transitions: StateTransition[];
  terminalStates: AgentLoopState[];
  defaultRoleForState(state: AgentLoopState): WorkerType | undefined;
}

export const PR_LOOP_STATES: AgentLoopState[] = [
  "SYNC_MAIN",
  "DISCOVER_PROGRESS",
  "SELECT_NEXT_PR",
  "WRITE_SPEC",
  "CREATE_BRANCH",
  "IMPLEMENT",
  "SELF_CHECK",
  "COMMIT_PUSH_PR",
  "WAIT_REVIEW_OR_CI",
  "FIX_REVIEW",
  "PUSH_FIX",
  "READY_TO_MERGE",
  "MERGE",
  "BLOCKED",
  "STOPPED"
];

export const PR_LOOP_TERMINAL_STATES: AgentLoopState[] = ["BLOCKED", "STOPPED"];

export const PR_LOOP_TRANSITIONS: StateTransition[] = [
  { from: "SYNC_MAIN", to: "DISCOVER_PROGRESS", trigger: "step", guard: "config_present" },
  { from: "DISCOVER_PROGRESS", to: "SELECT_NEXT_PR", trigger: "step", guard: "config_present" },
  { from: "SELECT_NEXT_PR", to: "WRITE_SPEC", trigger: "step", guard: "next_pr_unique" },
  { from: "WRITE_SPEC", to: "CREATE_BRANCH", trigger: "step", guard: "always" },
  { from: "CREATE_BRANCH", to: "IMPLEMENT", trigger: "step", guard: "always" },
  { from: "IMPLEMENT", to: "SELF_CHECK", trigger: "step", guard: "always" },
  { from: "SELF_CHECK", to: "COMMIT_PUSH_PR", trigger: "step", guard: "always" },
  { from: "COMMIT_PUSH_PR", to: "WAIT_REVIEW_OR_CI", trigger: "step", guard: "always" },
  { from: "WAIT_REVIEW_OR_CI", to: "FIX_REVIEW", trigger: "step", guard: "always" },
  { from: "FIX_REVIEW", to: "PUSH_FIX", trigger: "step", guard: "always" },
  { from: "PUSH_FIX", to: "WAIT_REVIEW_OR_CI", trigger: "step", guard: "always" },
  { from: "WAIT_REVIEW_OR_CI", to: "READY_TO_MERGE", trigger: "step", guard: "always" },
  { from: "READY_TO_MERGE", to: "MERGE", trigger: "step", guard: "always" },
  { from: "MERGE", to: "SYNC_MAIN", trigger: "step", guard: "always" },
  { from: "SYNC_MAIN", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "DISCOVER_PROGRESS", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "SELECT_NEXT_PR", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "WRITE_SPEC", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "CREATE_BRANCH", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "IMPLEMENT", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "SELF_CHECK", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "COMMIT_PUSH_PR", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "WAIT_REVIEW_OR_CI", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "FIX_REVIEW", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "PUSH_FIX", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "READY_TO_MERGE", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "MERGE", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "BLOCKED", to: "STOPPED", trigger: "stop", guard: "always" }
];

/** Return the default worker type delegated by the PR loop state machine. */
export function prLoopDefaultRoleForState(state: AgentLoopState): WorkerType | undefined {
  if (state === "WRITE_SPEC") {
    return "planner";
  }
  if (state === "IMPLEMENT") {
    return "implementation";
  }
  if (state === "FIX_REVIEW") {
    return "review-fix";
  }
  if (state === "SELF_CHECK") {
    return "reviewer";
  }
  return undefined;
}

export const PR_LOOP_SHAPE: LoopShape = {
  id: "pr-loop",
  label: "PR Loop",
  lifecycleKind: "pr",
  initialState: "SYNC_MAIN",
  states: PR_LOOP_STATES,
  transitions: PR_LOOP_TRANSITIONS,
  terminalStates: PR_LOOP_TERMINAL_STATES,
  defaultRoleForState: prLoopDefaultRoleForState
};

export const GENERIC_LOOP_STATES: AgentLoopState[] = [
  "DEFINE_GOAL",
  "COLLECT_CONTEXT",
  "PLAN_WORK",
  "EXECUTE_STEP",
  "SELF_REVIEW",
  "HUMAN_GATE",
  "DELIVER",
  "COMPLETE",
  "BLOCKED",
  "STOPPED"
];

export const GENERIC_LOOP_TERMINAL_STATES: AgentLoopState[] = ["COMPLETE", "BLOCKED", "STOPPED"];

export const GENERIC_LOOP_TRANSITIONS: StateTransition[] = [
  // Raised by a missing goal-confirmation decision before lifecycle returns a guard.
  { from: "DEFINE_GOAL", to: "BLOCKED", trigger: "step", guard: "goal_unclear" },
  { from: "DEFINE_GOAL", to: "COLLECT_CONTEXT", trigger: "step", guard: "goal_clear" },
  { from: "DEFINE_GOAL", to: "PLAN_WORK", trigger: "step", guard: "skip_context" },
  { from: "DEFINE_GOAL", to: "STOPPED", trigger: "step", guard: "rejected" },
  { from: "COLLECT_CONTEXT", to: "PLAN_WORK", trigger: "step", guard: "always" },
  { from: "PLAN_WORK", to: "EXECUTE_STEP", trigger: "step", guard: "always" },
  { from: "EXECUTE_STEP", to: "BLOCKED", trigger: "step", guard: "scope_change_requested" },
  { from: "EXECUTE_STEP", to: "PLAN_WORK", trigger: "step", guard: "scope_change_approved" },
  { from: "EXECUTE_STEP", to: "SELF_REVIEW", trigger: "step", guard: "always" },
  { from: "EXECUTE_STEP", to: "STOPPED", trigger: "step", guard: "rejected" },
  { from: "SELF_REVIEW", to: "EXECUTE_STEP", trigger: "step", guard: "fix_needed_cycles_remain" },
  { from: "SELF_REVIEW", to: "HUMAN_GATE", trigger: "step", guard: "review_passed" },
  { from: "SELF_REVIEW", to: "HUMAN_GATE", trigger: "step", guard: "review_cycles_exhausted" },
  { from: "HUMAN_GATE", to: "DELIVER", trigger: "step", guard: "deliverable_approved" },
  { from: "HUMAN_GATE", to: "EXECUTE_STEP", trigger: "step", guard: "request_changes" },
  { from: "HUMAN_GATE", to: "STOPPED", trigger: "step", guard: "rejected" },
  { from: "DELIVER", to: "COMPLETE", trigger: "step", guard: "always" },
  { from: "DEFINE_GOAL", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "COLLECT_CONTEXT", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "PLAN_WORK", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "EXECUTE_STEP", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "SELF_REVIEW", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "HUMAN_GATE", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "DELIVER", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "BLOCKED", to: "STOPPED", trigger: "stop", guard: "always" }
];

/** Return the default worker type delegated by the generic loop state machine. */
export function genericLoopDefaultRoleForState(state: AgentLoopState): WorkerType | undefined {
  if (state === "DEFINE_GOAL" || state === "COLLECT_CONTEXT" || state === "PLAN_WORK") {
    return "planner";
  }
  if (state === "EXECUTE_STEP" || state === "DELIVER") {
    return "implementation";
  }
  if (state === "SELF_REVIEW") {
    return "reviewer";
  }
  return undefined;
}

export const GENERIC_LOOP_SHAPE: LoopShape = {
  id: "generic-loop",
  label: "Generic Loop",
  lifecycleKind: "generic",
  initialState: "DEFINE_GOAL",
  states: GENERIC_LOOP_STATES,
  transitions: GENERIC_LOOP_TRANSITIONS,
  terminalStates: GENERIC_LOOP_TERMINAL_STATES,
  defaultRoleForState: genericLoopDefaultRoleForState
};

const LOOP_SHAPES: Record<LoopShapeId, LoopShape> = {
  "pr-loop": PR_LOOP_SHAPE,
  "generic-loop": GENERIC_LOOP_SHAPE
};

/** Resolve a configured loop shape, rejecting future unsupported shapes. */
export function resolveLoopShape(id: string): LoopShape {
  if (id in LOOP_SHAPES) {
    return LOOP_SHAPES[id as LoopShapeId];
  }
  throw new AgentLoopError("invalid_config", "Config loopShape is invalid.");
}

export function loopShapeIds(): LoopShapeId[] {
  return Object.keys(LOOP_SHAPES) as LoopShapeId[];
}

export function sandboxForShapeState(
  shapeId: LoopShapeId,
  state: AgentLoopState,
  workerType: WorkerType
): "read-only" | "workspace-write" {
  if (shapeId === "generic-loop" && ["DEFINE_GOAL", "COLLECT_CONTEXT", "PLAN_WORK", "SELF_REVIEW"].includes(state)) {
    return "read-only";
  }
  return workerType === "reviewer" ? "read-only" : "workspace-write";
}
