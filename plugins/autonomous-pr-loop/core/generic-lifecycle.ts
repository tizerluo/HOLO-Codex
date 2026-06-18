import { writeArtifact } from "./artifacts.js";
import { AgentLoopError } from "./errors.js";
import { workflowProfileDefinition } from "./profiles.js";
import type { AgentLoopConfig, AgentLoopDecision, AgentLoopRun, AgentLoopStorage, WorkerResult } from "./types.js";
import type { AgentLoopState, ArtifactRecord, TransitionGuard } from "./state-types.js";

export interface GenericLifecycleResult {
  nextState?: AgentLoopState;
  transitionGuard?: TransitionGuard;
  artifacts?: ArtifactRecord[];
  status?: "RUNNING" | "READY" | "STOPPED";
}

export function executeGenericPreWorkerStep(input: {
  storage: AgentLoopStorage;
  run: AgentLoopRun;
  state: AgentLoopState;
  dryRun: boolean;
}): GenericLifecycleResult {
  if (input.state !== "EXECUTE_STEP") {
    return {};
  }
  const scopeDecision = latestGateDecision(input.storage, input.run.id, "generic_scope_change_requested", "EXECUTE_STEP");
  if (!scopeDecision) {
    return {};
  }
  if (decisionStatus(scopeDecision) === "rejected") {
    if (!input.dryRun) markConsumed(input.storage, input.run.id, scopeDecision, "STOPPED");
    return { transitionGuard: "rejected", status: "STOPPED" };
  }
  const nextState = decisionNextState(scopeDecision, ["PLAN_WORK", "STOPPED"], "generic_scope_change_requested", "EXECUTE_STEP", "PLAN_WORK");
  if (!input.dryRun) markConsumed(input.storage, input.run.id, scopeDecision, nextState);
  return {
    transitionGuard: nextState === "PLAN_WORK" ? "scope_change_approved" : "rejected",
    ...(nextState === "STOPPED" ? { status: "STOPPED" as const } : {})
  };
}

export async function executeGenericLifecycleStep(input: {
  repoRoot: string;
  storage: AgentLoopStorage;
  run: AgentLoopRun;
  config: AgentLoopConfig;
  state: AgentLoopState;
  dryRun: boolean;
  workerResult?: WorkerResult;
}): Promise<GenericLifecycleResult> {
  const profile = workflowProfileDefinition(input.config.workflowProfile);
  if (input.state === "DEFINE_GOAL") {
    const gateDecision = latestGateDecision(input.storage, input.run.id, "generic_goal_needs_confirmation", "DEFINE_GOAL");
    if (!gateDecision) {
      throw new AgentLoopError("generic_goal_needs_confirmation", "Generic loop goal needs confirmation before work starts.", {
        details: {
          loopShape: "generic-loop",
          workflowProfile: input.config.workflowProfile,
          state: "DEFINE_GOAL",
          expectedDeliverable: profile.expectedDeliverable,
          allowedNextStates: ["COLLECT_CONTEXT", "PLAN_WORK", "STOPPED"],
          defaultNextState: "COLLECT_CONTEXT",
          requiredPayload: { nextState: "COLLECT_CONTEXT", source: "ui" }
        },
        exitCode: 2
      });
    }
    if (decisionStatus(gateDecision) === "rejected") {
      if (!input.dryRun) markConsumed(input.storage, input.run.id, gateDecision, "STOPPED");
      return { transitionGuard: "rejected", status: "STOPPED" };
    }
    const nextState = decisionNextState(gateDecision, ["COLLECT_CONTEXT", "PLAN_WORK", "STOPPED"], "generic_goal_needs_confirmation", "DEFINE_GOAL", "COLLECT_CONTEXT");
    if (!input.dryRun) markConsumed(input.storage, input.run.id, gateDecision, nextState);
    return { transitionGuard: guardForGoalDecision(nextState), ...(nextState === "STOPPED" ? { status: "STOPPED" as const } : {}) };
  }
  if (input.state === "COLLECT_CONTEXT") {
    return {
      transitionGuard: "always",
      artifacts: [writeGenericArtifact(input, "generic-context", "context.md", genericArtifactContent(input, "Context collected"))]
    };
  }
  if (input.state === "PLAN_WORK") {
    if (!input.dryRun) {
      input.storage.appendDecision({
        runId: input.run.id,
        kind: "generic_plan_ready",
        message: "Generic loop plan is ready.",
        details: { workflowProfile: input.config.workflowProfile, expectedDeliverable: profile.expectedDeliverable }
      });
    }
    return {
      transitionGuard: "always",
      artifacts: [writeGenericArtifact(input, "generic-plan", "plan.md", genericArtifactContent(input, "Plan ready"))]
    };
  }
  if (input.state === "EXECUTE_STEP") {
    return { transitionGuard: "always" };
  }
  if (input.state === "SELF_REVIEW") {
    const anchor = latestReviewCycleAnchor(input.storage, input.run.id);
    const cycles = executionReviewCycles(input.storage, input.run.id, anchor);
    const maxCycles = profile.maxExecutionReviewCycles ?? 3;
    const review = classifySelfReview(input.workerResult);
    if (!review.needsFix) {
      if (!input.dryRun) {
        input.storage.appendDecision({
          runId: input.run.id,
          kind: "generic_review_passed",
          message: "Generic self-review passed.",
          details: { anchorId: anchor?.id, workflowProfile: input.config.workflowProfile, summary: input.workerResult?.summary }
        });
      }
      return { transitionGuard: "review_passed" };
    }
    if (cycles < maxCycles) {
      if (!input.dryRun) {
        input.storage.appendDecision({
          runId: input.run.id,
          kind: "generic_execute_review_cycle",
          message: "Generic self-review requested another execution pass.",
          details: {
            cycle: cycles + 1,
            maxCycles,
            anchorId: anchor?.id,
            workflowProfile: input.config.workflowProfile,
            reasons: review.reasons,
            followUps: input.workerResult?.followUps ?? [],
            outOfScope: input.workerResult?.outOfScope ?? []
          }
        });
      }
      return { transitionGuard: "fix_needed_cycles_remain" };
    }
    if (!input.dryRun) {
      input.storage.appendDecision({
        runId: input.run.id,
        kind: "generic_review_cycles_exhausted",
        message: "Generic self-review cycles exhausted; escalating to human gate.",
        details: {
          cycles,
          maxCycles,
          anchorId: anchor?.id,
          workflowProfile: input.config.workflowProfile,
          reasons: review.reasons,
          followUps: input.workerResult?.followUps ?? [],
          outOfScope: input.workerResult?.outOfScope ?? []
        }
      });
    }
    return { transitionGuard: "review_cycles_exhausted" };
  }
  if (input.state === "HUMAN_GATE") {
    const reason = humanGateReason(input.storage, input.run.id);
    const approval = latestGateDecision(input.storage, input.run.id, "generic_human_gate", "HUMAN_GATE");
    if (!approval) {
      throw new AgentLoopError("generic_human_gate", "Generic deliverable needs human approval before delivery.", {
        details: {
          loopShape: "generic-loop",
          workflowProfile: input.config.workflowProfile,
          state: "HUMAN_GATE",
          expectedDeliverable: profile.expectedDeliverable,
          reason,
          allowedNextStates: ["DELIVER", "EXECUTE_STEP", "STOPPED"],
          defaultNextState: "DELIVER",
          requiredPayload: { nextState: "DELIVER", source: "ui" }
        },
        exitCode: 2
      });
    }
    if (decisionStatus(approval) === "rejected") {
      if (!input.dryRun) markConsumed(input.storage, input.run.id, approval, "STOPPED");
      return { transitionGuard: "rejected", status: "STOPPED" };
    }
    const nextState = decisionNextState(approval, ["DELIVER", "EXECUTE_STEP", "STOPPED"], "generic_human_gate", "HUMAN_GATE", "DELIVER");
    if (!input.dryRun) markConsumed(input.storage, input.run.id, approval, nextState);
    return { transitionGuard: guardForHumanGateDecision(nextState), ...(nextState === "STOPPED" ? { status: "STOPPED" as const } : {}) };
  }
  if (input.state === "DELIVER") {
    return {
      transitionGuard: "always",
      artifacts: [writeGenericArtifact(input, "generic-deliverable", "deliverable.md", genericArtifactContent(input, "Deliverable approved"))]
    };
  }
  if (input.state === "COMPLETE") {
    if (!input.storage.listDecisions(input.run.id).some((decision) => decision.kind === "generic_loop_completed")) {
      input.storage.appendDecision({
        runId: input.run.id,
        kind: "generic_loop_completed",
        message: "Generic loop completed.",
        details: { workflowProfile: input.config.workflowProfile, expectedDeliverable: profile.expectedDeliverable }
      });
      input.storage.appendEvent({
        runId: input.run.id,
        kind: "generic_loop_completed",
        message: "Generic loop completed.",
        stateBefore: "DELIVER",
        stateAfter: "COMPLETE",
        payload: { workflowProfile: input.config.workflowProfile, expectedDeliverable: profile.expectedDeliverable }
      });
    }
    return { nextState: "COMPLETE", status: "READY" };
  }
  return {};
}

function writeGenericArtifact(
  input: {
    repoRoot: string;
    storage: AgentLoopStorage;
    run: AgentLoopRun;
    config: AgentLoopConfig;
    state: AgentLoopState;
    dryRun: boolean;
  },
  kind: "generic-context" | "generic-plan" | "generic-deliverable",
  name: string,
  content: string
): ArtifactRecord {
  return writeArtifact(input.repoRoot, input.storage, input.run.id, kind, name, content);
}

function genericArtifactContent(input: { config: AgentLoopConfig; state: AgentLoopState }, title: string): string {
  const profile = workflowProfileDefinition(input.config.workflowProfile);
  return [
    `# ${title}`,
    "",
    `- loopShape: ${input.config.loopShape}`,
    `- workflowProfile: ${input.config.workflowProfile}`,
    `- state: ${input.state}`,
    `- expectedDeliverable: ${profile.expectedDeliverable ?? "deliverable"}`,
    `- allowedWriteRoots: ${(profile.allowedWriteRoots ?? []).join(", ") || "none"}`,
    `- requiredEvidence: ${(profile.requiredEvidence ?? []).join(", ") || "none"}`,
    `- reviewChecklist: ${(profile.reviewChecklist ?? []).join(", ") || "none"}`,
    `- handoff: ${profile.handoffTemplate}`,
    "",
    "This artifact records the generic-loop lifecycle handoff. Worker output and detailed evidence remain in worker artifacts and timeline entries."
  ].join("\n");
}

function latestGateDecision(storage: AgentLoopStorage, runId: string, gateKind: string, state?: AgentLoopState): AgentLoopDecision | undefined {
  const gate = storage.listGates(runId).find((item) => {
    if (item.kind !== gateKind || item.status === "open") {
      return false;
    }
    return state === undefined || gateState(item.details) === state;
  });
  if (!gate) {
    return undefined;
  }
  return storage.listDecisions(runId).find((decision) => {
    if (decision.kind !== "gate_approved" && decision.kind !== "gate_rejected") {
      return false;
    }
    const details = decision.details;
    if (typeof details !== "object" || details === null || (details as { gateKind?: unknown }).gateKind !== gateKind) {
      return false;
    }
    const matches = (details as { gateId?: unknown }).gateId === gate.id && (state === undefined || (details as { state?: unknown }).state === state);
    return matches && !isConsumed(storage, runId, decision);
  });
}

function gateState(details: unknown): AgentLoopState | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const state = (details as { state?: unknown }).state;
  return typeof state === "string" ? state as AgentLoopState : undefined;
}

function decisionGateId(decision: AgentLoopDecision): string | undefined {
  if (typeof decision.details !== "object" || decision.details === null || Array.isArray(decision.details)) return undefined;
  const gateId = (decision.details as { gateId?: unknown }).gateId;
  return typeof gateId === "string" ? gateId : undefined;
}

function decisionGateKind(decision: AgentLoopDecision): string | undefined {
  if (typeof decision.details !== "object" || decision.details === null || Array.isArray(decision.details)) return undefined;
  const gateKind = (decision.details as { gateKind?: unknown }).gateKind;
  return typeof gateKind === "string" ? gateKind : undefined;
}

function isConsumed(storage: AgentLoopStorage, runId: string, decision: AgentLoopDecision): boolean {
  const gateId = decisionGateId(decision);
  return storage.listDecisions(runId).some((item) => {
    if (item.kind !== "generic_gate_decision_consumed" || typeof item.details !== "object" || item.details === null || Array.isArray(item.details)) {
      return false;
    }
    const details = item.details as { gateId?: unknown; decisionId?: unknown };
    return details.decisionId === decision.id || (gateId !== undefined && details.gateId === gateId);
  });
}

function markConsumed(storage: AgentLoopStorage, runId: string, decision: AgentLoopDecision, nextState: AgentLoopState): void {
  storage.appendDecision({
    runId,
    kind: "generic_gate_decision_consumed",
    message: `Consumed generic gate decision for ${nextState}.`,
    details: { gateId: decisionGateId(decision), decisionId: decision.id, nextState }
  });
  if (nextState === "EXECUTE_STEP" && decisionGateKind(decision) === "generic_human_gate") {
    storage.appendDecision({
      runId,
      kind: "generic_review_cycles_reset",
      message: "Generic review cycles reset after human requested changes.",
      details: { gateId: decisionGateId(decision), decisionId: decision.id, nextState }
    });
  }
}

function classifySelfReview(result: WorkerResult | undefined): { needsFix: boolean; reasons: string[] } {
  if (!result) {
    return { needsFix: false, reasons: ["no reviewer output; treating dry-run review as passed"] };
  }
  const blockingFollowUps = result.followUps.filter(isBlockingFollowUp);
  const reasons = [
    ...(blockingFollowUps.length > 0 ? [`blockingFollowUps:${blockingFollowUps.length}`] : []),
    ...(result.outOfScope.length > 0 ? [`outOfScope:${result.outOfScope.length}`] : []),
    ...(result.error ? [`error:${result.error.kind}`] : [])
  ];
  return { needsFix: reasons.length > 0, reasons };
}

function guardForGoalDecision(nextState: AgentLoopState): TransitionGuard {
  if (nextState === "COLLECT_CONTEXT") return "goal_clear";
  if (nextState === "PLAN_WORK") return "skip_context";
  if (nextState === "STOPPED") return "rejected";
  return "rejected";
}

function guardForHumanGateDecision(nextState: AgentLoopState): TransitionGuard {
  if (nextState === "DELIVER") return "deliverable_approved";
  if (nextState === "EXECUTE_STEP") return "request_changes";
  if (nextState === "STOPPED") return "rejected";
  return "rejected";
}

function isBlockingFollowUp(value: string): boolean {
  return /^(fix|fix-needed|needs-fix|must-fix|blocker|blocking|required|request-changes|changes-required)(?=[:\s-]|$)|^(必须|阻塞|需要修复)(?=[:：\s-]|$)/i.test(value.trim());
}

function humanGateReason(storage: AgentLoopStorage, runId: string): "review_passed" | "review_overridden" {
  const anchor = latestReviewCycleAnchor(storage, runId);
  const latest = decisionsSinceLatestPlan(storage, runId, anchor)
    .find((decision) => (decision.kind === "generic_review_cycles_exhausted" || decision.kind === "generic_review_passed") && decisionMatchesAnchor(decision, anchor));
  return latest?.kind === "generic_review_cycles_exhausted" ? "review_overridden" : "review_passed";
}

function decisionStatus(decision: AgentLoopDecision): "approved" | "rejected" {
  return decision.kind === "gate_rejected" ? "rejected" : "approved";
}

function decisionNextState(
  decision: AgentLoopDecision,
  allowed: AgentLoopState[],
  gateKind: "generic_goal_needs_confirmation" | "generic_human_gate" | "generic_scope_change_requested",
  state: AgentLoopState,
  defaultNextState: AgentLoopState
): AgentLoopState {
  const details = typeof decision.details === "object" && decision.details !== null
    ? decision.details as { payload?: { nextState?: unknown }; nextState?: unknown }
    : {};
  const value = details.payload?.nextState ?? details.nextState;
  if (typeof value === "string" && allowed.includes(value as AgentLoopState)) {
    return value as AgentLoopState;
  }
  throw new AgentLoopError(gateKind, "Generic gate decision payload must include a valid next state.", {
    details: {
      gateKind,
      state,
      allowedNextStates: allowed,
      defaultNextState,
      requiredPayload: { nextState: defaultNextState, source: "ui" },
      receivedNextState: value
    },
    exitCode: 2
  });
}

function executionReviewCycles(storage: AgentLoopStorage, runId: string, anchor: AgentLoopDecision | undefined): number {
  return decisionsSinceLatestPlan(storage, runId, anchor)
    .filter((decision) => decision.kind === "generic_execute_review_cycle" && decisionMatchesAnchor(decision, anchor))
    .length;
}

function decisionsSinceLatestPlan(storage: AgentLoopStorage, runId: string, anchor = latestReviewCycleAnchor(storage, runId)): AgentLoopDecision[] {
  const decisions = storage.listDecisions(runId);
  return anchor ? decisions.filter((decision) => decision.createdAt >= anchor.createdAt) : decisions;
}

function latestReviewCycleAnchor(storage: AgentLoopStorage, runId: string): AgentLoopDecision | undefined {
  return storage
    .listDecisions(runId)
    .find((decision) => decision.kind === "generic_plan_ready" || decision.kind === "generic_review_cycles_reset");
}

function decisionMatchesAnchor(decision: AgentLoopDecision, anchor: AgentLoopDecision | undefined): boolean {
  if (!anchor) return true;
  if (typeof decision.details !== "object" || decision.details === null || Array.isArray(decision.details)) {
    return anchor.kind === "generic_review_cycles_reset" ? false : decision.createdAt >= anchor.createdAt;
  }
  const anchorId = (decision.details as { anchorId?: unknown }).anchorId;
  return anchorId === anchor.id || (anchorId === undefined && anchor.kind !== "generic_review_cycles_reset" && decision.createdAt >= anchor.createdAt);
}
