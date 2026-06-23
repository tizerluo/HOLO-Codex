import { AgentLoopError } from "./errors.js";
import { PR_LOOP_STATES } from "./loop-shapes.js";
import { resolveProfile, workflowStages } from "./profiles.js";
import type { MergeReadiness } from "./autonomy-policy.js";
import { redactSecrets } from "./redaction.js";
import { getDeliveryWorkItem, selectDefaultDeliveryRun, type DeliveryWorkItem } from "./delivery-work-item.js";
import type { HookCaptureReport } from "./hook-capture.js";
import type { AgentLoopState } from "./state-types.js";
import type {
  AgentLoopArtifactRecord,
  AgentLoopCiCheck,
  AgentLoopConfig,
  AgentLoopDecision,
  AgentLoopEvent,
  AgentLoopGate,
  AgentLoopPrLink,
  AgentLoopReviewComment,
  AgentLoopRun,
  AgentLoopRunCheck,
  AgentLoopStorage,
  WorkerRun
} from "./types.js";

export const WORKFLOW_STAGE_IDS = [
  "work_item",
  "plan",
  "build",
  "verify",
  "pr",
  "review",
  "merge_readiness",
  "cleanup"
] as const;

export type WorkflowStageId = (typeof WORKFLOW_STAGE_IDS)[number];
export type WorkflowStageStatus = "pending" | "active" | "blocked" | "done" | "skipped" | "manual" | "failed";
export type WorkflowStageSource = "run_state" | "workflow_evidence" | "gate" | "historical";
export type WorkflowReviewReviewer = "claude_acp" | "agy_gemini" | "internal_tester" | "internal_reviewer" | "github" | "human" | "custom";
export type WorkflowReviewRequirement = "required" | "optional" | "not_required" | "unknown";
export type WorkflowReviewProgress = "requested" | "started" | "in_progress" | "incomplete" | "complete" | "skipped" | "unknown";
export type WorkflowReviewResult = "pass" | "block" | "warn" | "unknown";
export type WorkflowReviewSeveritySummary = "none" | "p3_only" | "p2_or_higher" | "unknown";
export type WorkflowReviewSeverityId = "p0" | "p1" | "p2" | "p3" | "follow_up";
export type WorkflowReviewSeverityStatus = "none" | "present" | "unknown";
export type WorkflowReviewResolutionStatus = "fixed" | "routed" | "pending" | "not_applicable" | "unknown";
export type WorkflowActor =
  | "codex"
  | "worker"
  | "tester"
  | "reviewer"
  | "claude_acp"
  | "agy_gemini"
  | "github"
  | "github_ci"
  | "gitnexus"
  | "browser"
  | "human";

export interface WorkflowActorChip {
  actor: WorkflowActor;
  label: string;
  status: WorkflowStageStatus;
  model?: string;
  sessionId?: string;
}

export interface WorkflowEvidenceCounts {
  events: number;
  artifacts: number;
  gates: number;
  prComments: number;
  gitnexus: number;
  browser: number;
  ci: number;
  reports: number;
}

export interface WorkflowDrillDownTarget {
  page:
    | "Event Ledger"
    | "Gate Center"
    | "Worker Runs"
    | "Artifact Diff Viewer"
    | "PR Inbox"
    | "Scope Guard"
    | "Recovery Center";
}

export interface WorkflowEvidenceRef {
  id: string;
  kind: "event" | "artifact" | "gate" | "pr_comment" | "github_check" | "gitnexus" | "browser" | "report";
  label: string;
  summary: string;
  interaction: "popover" | "drill_down_link";
  drillDownTarget?: WorkflowDrillDownTarget;
  createdAt?: string;
  source?: string;
}

export interface WorkflowRequirement {
  id: string;
  label: string;
  status: "pending" | "satisfied" | "blocked" | "skipped";
  evidenceRefIds: string[];
  skippedReason?: string;
  blockedBy?: string;
}

export interface WorkflowBlocker {
  id: string;
  severity: "P0" | "P1" | "P2" | "P3" | "policy" | "ci" | "review" | "manual";
  title: string;
  reason: string;
  owner: string;
  nextAction: string;
  blockedBy?: string;
  evidenceRefIds: string[];
}

export interface WorkflowStageAction {
  label: string;
  command?: string;
  safeToRunFromDashboard: boolean;
  requiresConfirmation: boolean;
}

export interface WorkflowBoardSubstage {
  id: string;
  label: string;
  status: WorkflowStageStatus;
  evidenceCounts: WorkflowEvidenceCounts;
  latestEvidence: WorkflowEvidenceRef[];
  requiredEvidence: WorkflowRequirement[];
}

export interface WorkflowBoardStage {
  id: WorkflowStageId;
  label: string;
  status: WorkflowStageStatus;
  actorChips: WorkflowActorChip[];
  evidenceCounts: WorkflowEvidenceCounts;
  substages: WorkflowBoardSubstage[];
  latestAction?: WorkflowStageAction;
  blockers: WorkflowBlocker[];
  nextAction?: string;
}

export interface WorkflowBoardWorkItem {
  issueNumber?: number | undefined;
  issueTitle?: string | undefined;
  issueUrl?: string | undefined;
  runId?: string | undefined;
  branch?: string | undefined;
  currentState?: string | undefined;
  status?: string | undefined;
  loopShape: string;
  workflowProfile?: string | undefined;
  prUrl?: string | undefined;
  prNumber?: number | undefined;
  lastUpdate?: string | undefined;
  activeGate?: string | undefined;
  readOnly: boolean;
}

export interface WorkflowReviewReportRow {
  id: string;
  agent: string;
  reviewer?: WorkflowReviewReviewer | undefined;
  role: string;
  model?: string | undefined;
  backend?: string | undefined;
  status: "pass" | "block" | "warn" | "pending" | "skipped" | "unknown";
  prComment: "posted" | "missing" | "not_required" | "unknown";
  severitySummary: string;
  severityGroups: WorkflowReviewSeverityGroup[];
  resolutionStatus: WorkflowReviewResolutionStatus;
  resolutionEvidence: string;
  followUp?: string | undefined;
  requirement?: WorkflowReviewRequirement | undefined;
  progress?: WorkflowReviewProgress | undefined;
  result?: WorkflowReviewResult | undefined;
  commentUrl?: string | undefined;
  commentId?: string | undefined;
  sessionId?: string | undefined;
  conversationId?: string | undefined;
  reason?: string | undefined;
  nextAction?: string | undefined;
  evidenceRefIds: string[];
}

export interface WorkflowReviewSeverityGroup {
  id: WorkflowReviewSeverityId;
  label: string;
  status: WorkflowReviewSeverityStatus;
  evidence?: string | undefined;
}

export interface WorkflowCheckRow {
  id: string;
  label: string;
  status: "passed" | "failed" | "pending" | "blocked" | "skipped" | "unknown";
  evidence: string;
  owner: string;
  blockedBy?: string | undefined;
}

export interface WorkflowBoard {
  runId?: string | undefined;
  mode: "empty" | "active" | "historical" | "unsupported" | "unknown_state";
  activeStageId?: WorkflowStageId | undefined;
  selectedStageId: WorkflowStageId;
  stageSource: WorkflowStageSource;
  stageSourceEvent?: { id: string; status: WorkflowStageStatus; createdAt: string } | undefined;
  hookCapture?: HookCaptureReport | undefined;
  workItem: WorkflowBoardWorkItem;
  stages: WorkflowBoardStage[];
  evidenceRefs: WorkflowEvidenceRef[];
  reviewReports: WorkflowReviewReportRow[];
  verificationChecks: WorkflowCheckRow[];
  mergeReadinessChecks: WorkflowCheckRow[];
  cleanupChecks: WorkflowCheckRow[];
  appendEvidenceEnabled: boolean;
  message?: string | undefined;
}

export interface AppendWorkflowEvidenceInput {
  runId?: string | undefined;
  stageId?: string | undefined;
  substageId?: string | undefined;
  summary?: string | undefined;
  evidenceRefIds?: unknown;
  artifactIds?: unknown;
  actor?: string | undefined;
  status?: string | undefined;
  source?: string | undefined;
  review?: unknown;
}

interface WorkflowStageSignal {
  stageId: WorkflowStageId;
  status: WorkflowStageStatus;
  event: AgentLoopEvent;
}

export interface AppendWorkflowEvidenceResult {
  event: AgentLoopEvent;
  evidence: WorkflowEvidenceRef;
}

export interface WorkflowReviewEvidence {
  reviewer: WorkflowReviewReviewer;
  requirement: WorkflowReviewRequirement;
  progress: WorkflowReviewProgress;
  result: WorkflowReviewResult;
  severitySummary: WorkflowReviewSeveritySummary;
  role?: string | undefined;
  model?: string | undefined;
  backend?: string | undefined;
  sessionId?: string | undefined;
  conversationId?: string | undefined;
  commentUrl?: string | undefined;
  commentId?: string | undefined;
  p0?: string | undefined;
  p1?: string | undefined;
  p2?: string | undefined;
  p3?: string | undefined;
  followUp?: string | undefined;
  resolutionStatus?: WorkflowReviewResolutionStatus | undefined;
  resolutionEvidence?: string | undefined;
  reason?: string | undefined;
}

export const WORKFLOW_STAGE_DEFINITIONS: Array<{
  id: WorkflowStageId;
  label: string;
  substages: Array<{ id: string; label: string }>;
  nextAction: string;
}> = [
  {
    id: "work_item",
    label: "Work Item",
    nextAction: "Write or confirm the plan.",
    substages: [
      { id: "issue_selected", label: "Issue selected" },
      { id: "scope_confirmed", label: "Scope confirmed" },
      { id: "handoff_checked", label: "Handoff checked" },
      { id: "non_goals_recorded", label: "Non-goals recorded" }
    ]
  },
  {
    id: "plan",
    label: "Plan",
    nextAction: "Create branch and implement.",
    substages: [
      { id: "impact_checked", label: "Impact checked" },
      { id: "plan_written", label: "Plan written" },
      { id: "test_plan_defined", label: "Test plan defined" },
      { id: "review_rules_confirmed", label: "Review rules confirmed" }
    ]
  },
  {
    id: "build",
    label: "Build",
    nextAction: "Run verification.",
    substages: [
      { id: "branch_created", label: "Branch created" },
      { id: "implementation_active", label: "Implementation active" },
      { id: "files_changed", label: "Files changed" },
      { id: "local_smoke", label: "Local smoke" }
    ]
  },
  {
    id: "verify",
    label: "Verify",
    nextAction: "Publish the PR.",
    substages: [
      { id: "lint", label: "Lint" },
      { id: "focused_tests", label: "Focused tests" },
      { id: "full_tests", label: "Full tests" },
      { id: "gitnexus_detect", label: "GitNexus detect" },
      { id: "browser_validation", label: "Browser validation" },
      { id: "internal_tester", label: "Internal tester" },
      { id: "internal_reviewer", label: "Internal reviewer" }
    ]
  },
  {
    id: "pr",
    label: "PR",
    nextAction: "Run post-PR reviews.",
    substages: [
      { id: "commit_created", label: "Commit created" },
      { id: "branch_pushed", label: "Branch pushed" },
      { id: "pr_opened", label: "PR opened" },
      { id: "pr_body_completed", label: "PR body completed" },
      { id: "delivery_comment_posted", label: "Delivery comment posted" }
    ]
  },
  {
    id: "review",
    label: "Review",
    nextAction: "Wait for CI and merge readiness.",
    substages: [
      { id: "claude_acp_review", label: "Claude ACP review" },
      { id: "agy_gemini_review", label: "AGY/Gemini review" },
      { id: "github_comments_inspected", label: "GitHub comments inspected" },
      { id: "findings_classified", label: "Findings classified" },
      { id: "reports_posted", label: "Reports posted to PR" }
    ]
  },
  {
    id: "merge_readiness",
    label: "Merge Readiness",
    nextAction: "Merge PR, or fix the blocking condition in this PR.",
    substages: [
      { id: "ci_checks", label: "CI checks" },
      { id: "review_approval", label: "Review approval" },
      { id: "findings_gate", label: "Findings gate" },
      { id: "scope_guard", label: "Scope guard" },
      { id: "merge_policy", label: "Merge policy" }
    ]
  },
  {
    id: "cleanup",
    label: "Cleanup",
    nextAction: "Move to the next issue.",
    substages: [
      { id: "pr_merged", label: "PR merged" },
      { id: "switched_main", label: "Switched to main" },
      { id: "pulled_latest", label: "Pulled latest" },
      { id: "gitnexus_reindexed", label: "GitNexus index rebuilt" },
      { id: "worktree_clean", label: "Worktree clean" },
      { id: "next_issue_selected", label: "Next issue selected" }
    ]
  }
];

const STAGE_BY_ID = new Map(WORKFLOW_STAGE_DEFINITIONS.map((stage) => [stage.id, stage]));
const PR_STATES = new Set<string>(PR_LOOP_STATES);
const WORKFLOW_EVIDENCE_KIND = "workflow_stage_evidence";
const MAX_SUMMARY_LENGTH = 280;
const REVIEW_REVIEWERS: WorkflowReviewReviewer[] = ["claude_acp", "agy_gemini", "internal_tester", "internal_reviewer", "github", "human", "custom"];
const REVIEW_REQUIREMENTS: WorkflowReviewRequirement[] = ["required", "optional", "not_required", "unknown"];
const REVIEW_PROGRESS: WorkflowReviewProgress[] = ["requested", "started", "in_progress", "incomplete", "complete", "skipped", "unknown"];
const REVIEW_RESULTS: WorkflowReviewResult[] = ["pass", "block", "warn", "unknown"];
const REVIEW_SEVERITIES: WorkflowReviewSeveritySummary[] = ["none", "p3_only", "p2_or_higher", "unknown"];
const REVIEW_RESOLUTIONS: WorkflowReviewResolutionStatus[] = ["fixed", "routed", "pending", "not_applicable", "unknown"];
const REVIEW_SEVERITY_GROUPS: Array<{ id: WorkflowReviewSeverityId; label: string }> = [
  { id: "p0", label: "P0" },
  { id: "p1", label: "P1" },
  { id: "p2", label: "P2" },
  { id: "p3", label: "P3" },
  { id: "follow_up", label: "Follow-up" }
];

export interface WorkflowBoardInput {
  config: AgentLoopConfig;
  run?: AgentLoopRun | undefined;
  currentRun?: AgentLoopRun | undefined;
  gates: AgentLoopGate[];
  events: AgentLoopEvent[];
  workers: WorkerRun[];
  artifacts: AgentLoopArtifactRecord[];
  pr?: AgentLoopPrLink | undefined;
  ci: AgentLoopCiCheck[];
  reviewComments: AgentLoopReviewComment[];
  decisions: AgentLoopDecision[];
  runChecks: AgentLoopRunCheck[];
  mergeReadiness?: MergeReadiness | undefined;
  deliveryWorkItem?: DeliveryWorkItem | undefined;
  hookCapture?: HookCaptureReport | undefined;
}

export function selectWorkflowBoardRun(storage: AgentLoopStorage, runId?: string): AgentLoopRun | undefined {
  const runs = storage.listRuns(200);
  if (runId) {
    return runs.find((run) => run.id === runId);
  }
  return selectDefaultDeliveryRun(storage);
}

export function deriveWorkflowBoard(input: WorkflowBoardInput): WorkflowBoard {
  const run = input.run;
  const loopShape = input.config.loopShape;
  if (!run) {
    return emptyBoard(loopShape);
  }
  const readOnly = !(run.status === "RUNNING" || run.status === "BLOCKED");
  const deliveryWorkItem = input.deliveryWorkItem;
  const workItem: WorkflowBoardWorkItem = {
    ...(deliveryWorkItem ? {
      issueNumber: deliveryWorkItem.issue,
      issueTitle: deliveryWorkItem.title,
      issueUrl: deliveryWorkItem.url
    } : {}),
    runId: run.id,
    branch: run.branch,
    currentState: run.currentState,
    status: run.status,
    loopShape,
    workflowProfile: input.config.workflowProfile,
    prUrl: input.pr?.url,
    prNumber: input.pr?.prNumber,
    lastUpdate: run.updatedAt,
    activeGate: input.gates.find((gate) => gate.status === "open")?.kind,
    readOnly
  };
  if (loopShape !== "pr-loop") {
    return unsupportedBoard(workItem, "PR O observes only $pr-delivery-loop / pr-loop runs.");
  }
  if (run.currentState && !PR_STATES.has(run.currentState)) {
    return unknownStateBoard(workItem, `Unknown PR loop state: ${run.currentState}`);
  }

  const appendedRefs = appendedEvidenceRefs(input.events);
  const evidenceRefs = [
    ...appendedRefs,
    ...gateEvidenceRefs(input.gates),
    ...eventEvidenceRefs(input.events),
    ...artifactEvidenceRefs(input.artifacts),
    ...ciEvidenceRefs(input.ci),
    ...reviewEvidenceRefs(input.reviewComments),
    ...workerEvidenceRefs(input.workers)
  ];
  const activeGate = input.gates.find((gate) => gate.status === "open");
  const effectiveState = effectivePrState(run.currentState, input.events);
  const stateStage = boardStageForState(effectiveState, input);
  const stageSignal = workflowStageSignal(input.events);
  const signalOverridesState = stageSignal ? isCurrentStageSignalStatus(stageSignal.status) : false;
  const stageFromState = signalOverridesState && stageSignal
    ? stageSignal.stageId
    : advanceStageWithEvidence(
      stateStage,
      stageSignal?.stageId,
      effectiveState
    );
  const activeStageId = activeGate ? stageForGate(activeGate, stageFromState) : stageFromState;
  const stageSignalApplies = Boolean(stageSignal && !activeGate && (
    signalOverridesState || (stageSignal.stageId === activeStageId && activeStageId !== stateStage)
  ));
  const stageSource: WorkflowStageSource = activeGate
    ? "gate"
    : readOnly
      ? "historical"
      : stageSignalApplies
        ? "workflow_evidence"
        : activeStageId === stateStage ? "run_state" : "workflow_evidence";
  const statusOverride: Partial<Record<WorkflowStageId, WorkflowStageStatus>> = {};
  if (activeGate) {
    statusOverride[activeStageId] = "blocked";
  } else if (stageSignalApplies && stageSignal) {
    statusOverride[stageSignal.stageId] = stageSignal.status;
  } else if (readOnly) {
    statusOverride[activeStageId] = "pending";
  }
  const profile = resolveProfile(input.config, isAgentLoopState(effectiveState) ? effectiveState : undefined);
  const stageMetadata = workflowStages(input.config);
  const stages = WORKFLOW_STAGE_DEFINITIONS.map((definition) =>
    buildStage({
      definition,
      activeStageId,
      statusOverride,
      evidenceRefs,
      input,
      profileRoleMapping: profile.roleMapping,
      stageMetadata
    })
  );
  const blockers = activeGate ? [gateBlocker(activeGate, activeStageId)] : [];
  const blockedStage = stages.find((stage) => stage.id === activeStageId);
  if (blockedStage && blockers.length > 0) {
    blockedStage.blockers = blockers;
  }

  return {
    runId: run.id,
    mode: readOnly ? "historical" : "active",
    activeStageId,
    selectedStageId: activeStageId,
    stageSource,
    ...(stageSignalApplies && stageSignal ? { stageSourceEvent: { id: stageSignal.event.id, status: stageSignal.status, createdAt: stageSignal.event.createdAt } } : {}),
    ...(input.hookCapture ? { hookCapture: workflowBoardHookCapture(input.hookCapture) } : {}),
    workItem,
    stages,
    evidenceRefs,
    reviewReports: reviewRows(input, appendedRefs),
    verificationChecks: verificationRows(input),
    mergeReadinessChecks: mergeReadinessRows(input),
    cleanupChecks: cleanupRows(input),
    appendEvidenceEnabled: !readOnly,
    ...(readOnly ? { message: "Historical run; workflow board is read-only." } : {})
  };
}

export function appendWorkflowEvidence(storage: AgentLoopStorage, input: AppendWorkflowEvidenceInput): AppendWorkflowEvidenceResult {
  const currentRun = input.runId
    ? storage.listRuns(200).find((run) => run.id === input.runId)
    : storage.getCurrentRun();
  if (!currentRun) {
    throw new AgentLoopError("storage_error", "No run is available for workflow evidence.");
  }
  if (currentRun.status !== "RUNNING" && currentRun.status !== "BLOCKED") {
    const workItem = getDeliveryWorkItem(storage, currentRun.id);
    const recoveryCommand = currentRun.status === "STOPPED" && workItem
      ? `agent-loop delivery resume --run ${currentRun.id} --reason "resume interrupted delivery run"`
      : undefined;
    throw new AgentLoopError("policy_violation", recoveryCommand
      ? "Workflow evidence target run is stopped; resume the delivery run before appending evidence."
      : "Workflow evidence can only be appended to a running or blocked run.", {
      details: { runId: currentRun.id, status: currentRun.status, ...(recoveryCommand ? { recoveryCommand } : {}) }
    });
  }
  const normalized = normalizeWorkflowEvidenceInput(input);
  const event = storage.appendEvent({
    runId: currentRun.id,
    kind: WORKFLOW_EVIDENCE_KIND,
    message: normalized.summary,
    payload: {
      stageId: normalized.stageId,
      ...(normalized.substageId ? { substageId: normalized.substageId } : {}),
      evidenceRefIds: normalized.evidenceRefIds,
      actor: normalized.actor,
      status: normalized.status,
      source: normalized.source,
      ...(normalized.review ? { review: normalized.review } : {})
    },
    artifactIds: normalized.artifactIds
  });
  return {
    event,
    evidence: {
      id: event.id,
      kind: evidenceKindFromSource(normalized.source),
      label: WORKFLOW_STAGE_DEFINITIONS.find((stage) => stage.id === normalized.stageId)?.label ?? normalized.stageId,
      summary: normalized.summary,
      interaction: "drill_down_link",
      drillDownTarget: { page: "Event Ledger" },
      createdAt: event.createdAt,
      source: normalized.source
    }
  };
}

export function normalizeWorkflowEvidenceInput(input: AppendWorkflowEvidenceInput): {
  stageId: WorkflowStageId;
  substageId?: string;
  summary: string;
  evidenceRefIds: string[];
  artifactIds: string[];
  actor: WorkflowActor;
  status: WorkflowStageStatus;
  source: string;
  review?: WorkflowReviewEvidence;
} {
  const stageId = input.stageId;
  if (!isWorkflowStageId(stageId)) {
    throw new AgentLoopError("invalid_config", "workflow evidence stageId is invalid.");
  }
  const stage = STAGE_BY_ID.get(stageId);
  const substageId = typeof input.substageId === "string" && input.substageId.trim().length > 0
    ? input.substageId.trim()
    : undefined;
  if (substageId && !stage?.substages.some((substage) => substage.id === substageId)) {
    throw new AgentLoopError("invalid_config", "workflow evidence substageId is invalid.");
  }
  const rawSummary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (rawSummary.length === 0) {
    throw new AgentLoopError("invalid_config", "workflow evidence summary is required.");
  }
  if (rawSummary.length > MAX_SUMMARY_LENGTH) {
    throw new AgentLoopError("invalid_config", `workflow evidence summary must be ${MAX_SUMMARY_LENGTH} characters or shorter.`);
  }
  const summary = redactSecrets(rawSummary);
  const actor = isWorkflowActor(input.actor) ? input.actor : "codex";
  const status = input.status === undefined ? "done" : workflowStageStatus(input.status);
  const source = typeof input.source === "string" && input.source.trim().length > 0 ? input.source.trim() : "cli";
  const review = normalizeReviewEvidence(input.review, stageId);
  return {
    stageId,
    ...(substageId ? { substageId } : {}),
    summary,
    evidenceRefIds: stringArray(input.evidenceRefIds),
    artifactIds: stringArray(input.artifactIds),
    actor,
    status,
    source,
    ...(review ? { review } : {})
  };
}

function workflowStageStatus(value: unknown): WorkflowStageStatus {
  if (isWorkflowStageStatus(value)) return value;
  throw new AgentLoopError("invalid_config", "workflow evidence status is invalid.");
}

function workflowBoardHookCapture(report: HookCaptureReport): HookCaptureReport {
  return {
    status: report.status,
    reason: report.reason
  };
}

function normalizeReviewEvidence(value: unknown, stageId: WorkflowStageId): WorkflowReviewEvidence | undefined {
  if (value === undefined) return undefined;
  if (stageId !== "review") {
    throw new AgentLoopError("invalid_config", "structured review evidence is only valid for the review stage.");
  }
  if (!isRecord(value)) {
    throw new AgentLoopError("invalid_config", "structured review evidence must be an object.");
  }
  const reviewer = enumValue(value.reviewer, REVIEW_REVIEWERS, "reviewer");
  const requirement = enumValue(value.requirement, REVIEW_REQUIREMENTS, "requirement");
  const progress = enumValue(value.progress, REVIEW_PROGRESS, "progress");
  const result = enumValue(value.result, REVIEW_RESULTS, "result");
  const severitySummary = enumValue(value.severitySummary, REVIEW_SEVERITIES, "severitySummary");
  const commentUrl = optionalRedactedString(value.commentUrl, "commentUrl");
  const commentId = optionalRedactedString(value.commentId, "commentId");
  const resolutionStatus = value.resolutionStatus === undefined ? undefined : enumValue(value.resolutionStatus, REVIEW_RESOLUTIONS, "resolutionStatus");
  if (commentUrl && !isGitHubIssueCommentUrl(commentUrl)) {
    throw new AgentLoopError("invalid_config", "review evidence commentUrl must be a GitHub PR comment, review, or discussion URL.");
  }
  if (progress === "complete" && requirement !== "not_required" && !commentUrl) {
    throw new AgentLoopError("invalid_config", "complete review evidence requires a valid --comment-url.");
  }
  if (progress === "skipped" && requirement !== "not_required") {
    throw new AgentLoopError("invalid_config", "skipped review evidence must use requirement not_required.");
  }
  return {
    reviewer,
    requirement,
    progress,
    result,
    severitySummary,
    ...optionalReviewField("role", value.role),
    ...optionalReviewField("model", value.model),
    ...optionalReviewField("backend", value.backend),
    ...optionalReviewField("sessionId", value.sessionId),
    ...optionalReviewField("conversationId", value.conversationId),
    ...(commentUrl ? { commentUrl } : {}),
    ...(commentId ? { commentId } : {}),
    ...optionalReviewField("p0", value.p0),
    ...optionalReviewField("p1", value.p1),
    ...optionalReviewField("p2", value.p2),
    ...optionalReviewField("p3", value.p3),
    ...optionalReviewField("followUp", value.followUp),
    ...(resolutionStatus ? { resolutionStatus } : {}),
    ...optionalReviewField("resolutionEvidence", value.resolutionEvidence),
    ...optionalReviewField("reason", value.reason)
  };
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  throw new AgentLoopError("invalid_config", `review evidence ${field} is invalid.`);
}

function optionalReviewField<K extends keyof WorkflowReviewEvidence>(key: K, value: unknown): Pick<WorkflowReviewEvidence, K> | Record<string, never> {
  const normalized = optionalRedactedString(value, String(key));
  return normalized ? { [key]: normalized } as Pick<WorkflowReviewEvidence, K> : {};
}

function optionalRedactedString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new AgentLoopError("invalid_config", `review evidence ${field} must be a string.`);
  }
  const normalized = redactSecrets(value.trim());
  if (normalized.length > MAX_SUMMARY_LENGTH) {
    throw new AgentLoopError("invalid_config", `review evidence ${field} must be ${MAX_SUMMARY_LENGTH} characters or shorter.`);
  }
  return normalized.length > 0 ? normalized : undefined;
}

function isGitHubIssueCommentUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:\/files)?(?:\?[^#\s]+)?#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+)(?:\?[^#\s]+)?$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWorkflowStageId(value: unknown): value is WorkflowStageId {
  return typeof value === "string" && WORKFLOW_STAGE_IDS.includes(value as WorkflowStageId);
}

function emptyCounts(): WorkflowEvidenceCounts {
  return { events: 0, artifacts: 0, gates: 0, prComments: 0, gitnexus: 0, browser: 0, ci: 0, reports: 0 };
}

function emptyBoard(loopShape: string): WorkflowBoard {
  const stages = WORKFLOW_STAGE_DEFINITIONS.map((definition) => buildEmptyStage(definition));
  return {
    mode: "empty",
    selectedStageId: "work_item",
    stageSource: "historical",
    workItem: { loopShape, readOnly: true },
    stages,
    evidenceRefs: [],
    reviewReports: [],
    verificationChecks: [],
    mergeReadinessChecks: [],
    cleanupChecks: [],
    appendEvidenceEnabled: false,
    message: "No active PR delivery run is selected."
  };
}

function unsupportedBoard(workItem: WorkflowBoardWorkItem, message: string): WorkflowBoard {
  return {
    runId: workItem.runId,
    mode: "unsupported",
    selectedStageId: "work_item",
    stageSource: "historical",
    workItem: { ...workItem, readOnly: true },
    stages: WORKFLOW_STAGE_DEFINITIONS.map((definition) => ({ ...buildEmptyStage(definition), status: "skipped" as const })),
    evidenceRefs: [],
    reviewReports: [],
    verificationChecks: [],
    mergeReadinessChecks: [],
    cleanupChecks: [],
    appendEvidenceEnabled: false,
    message
  };
}

function unknownStateBoard(workItem: WorkflowBoardWorkItem, message: string): WorkflowBoard {
  return {
    runId: workItem.runId,
    mode: "unknown_state",
    selectedStageId: "work_item",
    stageSource: "historical",
    workItem: { ...workItem, readOnly: true },
    stages: WORKFLOW_STAGE_DEFINITIONS.map((definition) => buildEmptyStage(definition)),
    evidenceRefs: [],
    reviewReports: [],
    verificationChecks: [],
    mergeReadinessChecks: [],
    cleanupChecks: [],
    appendEvidenceEnabled: false,
    message
  };
}

function buildEmptyStage(definition: (typeof WORKFLOW_STAGE_DEFINITIONS)[number]): WorkflowBoardStage {
  return {
    id: definition.id,
    label: definition.label,
    status: "pending",
    actorChips: actorChipsForStage(definition.id, "pending"),
    evidenceCounts: emptyCounts(),
    substages: definition.substages.map((substage) => ({
      ...substage,
      status: "pending",
      evidenceCounts: emptyCounts(),
      latestEvidence: [],
      requiredEvidence: []
    })),
    blockers: [],
    nextAction: definition.nextAction
  };
}

function buildStage(input: {
  definition: (typeof WORKFLOW_STAGE_DEFINITIONS)[number];
  activeStageId: WorkflowStageId;
  statusOverride: Partial<Record<WorkflowStageId, WorkflowStageStatus>>;
  evidenceRefs: WorkflowEvidenceRef[];
  input: WorkflowBoardInput;
  profileRoleMapping: ReturnType<typeof resolveProfile>["roleMapping"];
  stageMetadata: ReturnType<typeof workflowStages>;
}): WorkflowBoardStage {
  const index = WORKFLOW_STAGE_IDS.indexOf(input.definition.id);
  const activeIndex = WORKFLOW_STAGE_IDS.indexOf(input.activeStageId);
  const baseStatus: WorkflowStageStatus = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
  const status = input.statusOverride[input.definition.id] ?? inferredStageStatus(input.definition.id, baseStatus, input.input);
  const stageEvidence = evidenceForStage(input.definition.id, input.evidenceRefs);
  const counts = evidenceCounts(stageEvidence);
  return {
    id: input.definition.id,
    label: input.definition.label,
    status,
    actorChips: actorChipsForStage(input.definition.id, status, input.profileRoleMapping, input.stageMetadata),
    evidenceCounts: counts,
    substages: input.definition.id === "cleanup"
      ? cleanupSubstages(input.definition, input.input, input.evidenceRefs, status)
      : input.definition.substages.map((substage, substageIndex) => ({
        ...substage,
        status: substageIndex === 0 && status === "active" ? "active" : status === "done" ? "done" : "pending",
        evidenceCounts: counts,
        latestEvidence: stageEvidence.slice(0, 3),
        requiredEvidence: []
      })),
    latestAction: { label: status === "blocked" ? "Resolve blocker" : input.definition.nextAction, safeToRunFromDashboard: false, requiresConfirmation: false },
    blockers: [],
    nextAction: input.definition.nextAction
  };
}

function inferredStageStatus(stageId: WorkflowStageId, baseStatus: WorkflowStageStatus, input: WorkflowBoardInput): WorkflowStageStatus {
  if (stageId === "verify" && input.ci.some((check) => check.conclusion === "failure" || check.conclusion === "timed_out")) {
    return "failed";
  }
  if (stageId === "pr" && baseStatus === "active" && !input.pr) {
    return "manual";
  }
  if (stageId === "merge_readiness" && input.mergeReadiness && !input.mergeReadiness.ready && baseStatus === "active") {
    return "blocked";
  }
  return baseStatus;
}

function effectivePrState(state: string | undefined, events: AgentLoopEvent[]): string | undefined {
  if (state !== "BLOCKED" && state !== "STOPPED") return state;
  const historical = [...events].sort((a, b) => b.seq - a.seq);
  for (const event of historical) {
    const candidates = [event.stateBefore, event.stateAfter];
    for (const candidate of candidates) {
      if (candidate && PR_STATES.has(candidate) && candidate !== "BLOCKED" && candidate !== "STOPPED") {
        return candidate;
      }
    }
  }
  return undefined;
}

function advanceStageWithEvidence(
  stateStage: WorkflowStageId,
  evidenceStage: WorkflowStageId | undefined,
  state: string | undefined
): WorkflowStageId {
  if (!evidenceStage || state === "SYNC_MAIN") return stateStage;
  return stageIndex(evidenceStage) > stageIndex(stateStage) ? evidenceStage : stateStage;
}

function workflowStageSignal(events: AgentLoopEvent[]): WorkflowStageSignal | undefined {
  let latestDone: WorkflowStageSignal | undefined;
  for (const event of [...events]
    .filter((event) => event.kind === WORKFLOW_EVIDENCE_KIND)
    .sort((left, right) => right.seq - left.seq)) {
    const status = payloadString(event, "status") ?? "done";
    const stageId = payloadStage(event);
    if (status === "done") {
      const doneSignal: WorkflowStageSignal = { event, stageId, status };
      if (!latestDone || stageIndex(stageId) > stageIndex(latestDone.stageId)) {
        latestDone = doneSignal;
      }
      continue;
    }
    if (!isCurrentStageSignalStatus(status)) continue;
    if (latestDone && stageIndex(latestDone.stageId) >= stageIndex(stageId)) {
      return latestDone;
    }
    return { event, stageId, status };
  }
  return latestDone;
}

function isCurrentStageSignalStatus(value: string | undefined): value is WorkflowStageStatus {
  return value === "active" || value === "manual" || value === "blocked" || value === "failed";
}

function stageIndex(stageId: WorkflowStageId): number {
  return WORKFLOW_STAGE_IDS.indexOf(stageId);
}

function boardStageForState(state: string | undefined, input: WorkflowBoardInput): WorkflowStageId {
  if (state === "WRITE_SPEC") return "plan";
  if (state === "CREATE_BRANCH" || state === "IMPLEMENT") return "build";
  if (state === "SELF_CHECK") return "verify";
  if (state === "COMMIT_PUSH_PR" || state === "PUSH_FIX") return "pr";
  if (state === "FIX_REVIEW") return "review";
  if (state === "READY_TO_MERGE") return "merge_readiness";
  if (state === "MERGE") return "cleanup";
  if (state === "WAIT_REVIEW_OR_CI") return reviewOrMergeReadiness(input);
  if (state === "SYNC_MAIN") return hasCleanupEvidence(input) ? "cleanup" : "work_item";
  if (state === "DISCOVER_PROGRESS" || state === "SELECT_NEXT_PR" || state === undefined) {
    return "work_item";
  }
  return "work_item";
}

function reviewOrMergeReadiness(input: WorkflowBoardInput): WorkflowStageId {
  if (input.reviewComments.some((comment) => comment.actionable && !comment.isResolved && !comment.isOutdated)) {
    return "review";
  }
  if (input.events.some((event) => event.kind === WORKFLOW_EVIDENCE_KIND && payloadStage(event) === "review")) {
    return "review";
  }
  return "merge_readiness";
}

function hasCleanupEvidence(input: WorkflowBoardInput): boolean {
  return input.events.some((event) => {
    const text = `${event.kind} ${event.message}`.toLowerCase();
    return payloadStage(event) === "cleanup" || text.includes("merged") || text.includes("gitnexus analyze") || text.includes("pulled latest");
  });
}

function stageForGate(gate: AgentLoopGate, fallback: WorkflowStageId): WorkflowStageId {
  const map: Partial<Record<string, WorkflowStageId>> = {
    needs_repo_init: "work_item",
    unsupported_remote: "work_item",
    needs_secret_or_login: "work_item",
    ambiguous_next_pr: "work_item",
    generic_goal_needs_confirmation: "work_item",
    policy_violation: "plan",
    required_tool_unavailable: "plan",
    gitnexus_check_failed: "verify",
    dirty_unowned_worktree: "build",
    worker_failed: "build",
    worker_output_invalid: "build",
    worker_timeout: "build",
    worker_already_running: "build",
    review_out_of_scope: "review",
    generic_human_gate: "review",
    generic_scope_change_requested: "review",
    ci_required_checks_missing: "merge_readiness",
    ci_pending_timeout: "merge_readiness",
    merge_requires_confirmation: "merge_readiness",
    github_transient_failure: fallback === "pr" ? "pr" : "merge_readiness",
    github_resource_not_found: fallback === "pr" ? "pr" : "merge_readiness"
  };
  return map[gate.kind] ?? fallback;
}

function gateBlocker(gate: AgentLoopGate, stageId: WorkflowStageId): WorkflowBlocker {
  return {
    id: gate.id,
    severity: gate.kind.startsWith("ci_") ? "ci" : gate.kind.startsWith("review_") ? "review" : "policy",
    title: gate.kind,
    reason: gate.message,
    owner: stageId === "merge_readiness" ? "GitHub / Codex" : "Codex",
    nextAction: "Inspect the gate and resolve the required condition.",
    evidenceRefIds: [gate.id]
  };
}

function actorChipsForStage(
  stageId: WorkflowStageId,
  status: WorkflowStageStatus,
  profileRoleMapping: ReturnType<typeof resolveProfile>["roleMapping"] = [],
  stageMetadata: ReturnType<typeof workflowStages> = []
): WorkflowActorChip[] {
  const active = status === "active" || status === "blocked" || status === "manual";
  const metadataActors = stageMetadata
    .filter((item) => stageForProfileState(item.state) === stageId && item.workerType)
    .map((item): WorkflowActorChip => {
      const role = profileRoleMapping.find((mapping) => mapping.state === item.state);
      return {
        actor: workflowActorForWorkerType(item.workerType),
        label: role?.label ?? item.roleAlias ?? item.workerType ?? "Worker",
        status: active ? status : status === "done" ? "done" : "pending",
        ...(item.workerType ? { model: `${item.workerType}${item.sandbox ? ` / ${item.sandbox}` : ""}` } : {})
      };
    });
  if (metadataActors.length > 0) return uniqueActorChips(metadataActors);
  const stageActors: Record<WorkflowStageId, Array<{ actor: WorkflowActor; label: string }>> = {
    work_item: [{ actor: "codex", label: "Codex" }, { actor: "human", label: "Human" }],
    plan: [{ actor: "codex", label: "Codex" }, { actor: "gitnexus", label: "GitNexus" }],
    build: [{ actor: "codex", label: "Codex" }, { actor: "worker", label: "Worker" }],
    verify: [{ actor: "codex", label: "Codex" }, { actor: "tester", label: "Tester" }, { actor: "reviewer", label: "Reviewer" }],
    pr: [{ actor: "codex", label: "Codex" }, { actor: "github", label: "GitHub" }],
    review: [{ actor: "claude_acp", label: "Claude ACP" }, { actor: "agy_gemini", label: "AGY/Gemini" }, { actor: "github", label: "GitHub" }],
    merge_readiness: [{ actor: "github_ci", label: "GitHub CI" }, { actor: "reviewer", label: "Reviewer" }, { actor: "human", label: "Human" }],
    cleanup: [{ actor: "codex", label: "Codex" }, { actor: "gitnexus", label: "GitNexus" }]
  };
  return stageActors[stageId].map((item) => ({
    ...item,
    status: active ? status : status === "done" ? "done" : "pending"
  }));
}

function stageForProfileState(state: string): WorkflowStageId {
  return boardStageForState(state, {
    config: {} as AgentLoopConfig,
    gates: [],
    events: [],
    workers: [],
    artifacts: [],
    ci: [],
    reviewComments: [],
    decisions: [],
    runChecks: []
  });
}

function workflowActorForWorkerType(workerType: string | undefined): WorkflowActor {
  if (workerType === "reviewer") return "reviewer";
  if (workerType === "review-fix") return "reviewer";
  return "worker";
}

function uniqueActorChips(chips: WorkflowActorChip[]): WorkflowActorChip[] {
  const seen = new Set<string>();
  return chips.filter((chip) => {
    const key = `${chip.actor}:${chip.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceCounts(refs: WorkflowEvidenceRef[]): WorkflowEvidenceCounts {
  return refs.reduce((counts, ref) => {
    if (ref.kind === "event") counts.events += 1;
    if (ref.kind === "artifact") counts.artifacts += 1;
    if (ref.kind === "gate") counts.gates += 1;
    if (ref.kind === "pr_comment") counts.prComments += 1;
    if (ref.kind === "gitnexus") counts.gitnexus += 1;
    if (ref.kind === "browser") counts.browser += 1;
    if (ref.kind === "github_check") counts.ci += 1;
    if (ref.kind === "report") counts.reports += 1;
    return counts;
  }, emptyCounts());
}

function evidenceForStage(stageId: WorkflowStageId, refs: WorkflowEvidenceRef[]): WorkflowEvidenceRef[] {
  return refs.filter((ref) => ref.source === stageId || ref.id.startsWith(`${stageId}:`));
}

function appendedEvidenceRefs(events: AgentLoopEvent[]): WorkflowEvidenceRef[] {
  return events
    .filter((event) => event.kind === WORKFLOW_EVIDENCE_KIND)
    .map((event) => ({
      id: event.id,
      kind: evidenceKindFromSource(payloadString(event, "source") ?? "manual"),
      label: stageLabel(payloadStage(event)),
      summary: redactSecrets(event.message),
      interaction: "drill_down_link" as const,
      drillDownTarget: { page: "Event Ledger" as const },
      createdAt: event.createdAt,
      source: payloadStage(event)
    }));
}

function gateEvidenceRefs(gates: AgentLoopGate[]): WorkflowEvidenceRef[] {
  return gates.map((gate) => ({
    id: gate.id,
    kind: "gate" as const,
    label: gate.kind,
    summary: gate.message,
    interaction: "drill_down_link" as const,
    drillDownTarget: { page: "Gate Center" as const },
    createdAt: gate.createdAt,
    source: stageForGate(gate, "work_item")
  }));
}

function eventEvidenceRefs(events: AgentLoopEvent[]): WorkflowEvidenceRef[] {
  return events
    .filter((event) => event.kind !== WORKFLOW_EVIDENCE_KIND)
    .slice(0, 20)
    .map((event) => ({
      id: event.id,
      kind: event.kind.includes("gitnexus") ? "gitnexus" as const : event.kind.includes("browser") ? "browser" as const : "event" as const,
      label: event.kind,
      summary: redactSecrets(event.message),
      interaction: "drill_down_link" as const,
      drillDownTarget: { page: event.kind.includes("gitnexus") ? "Scope Guard" as const : "Event Ledger" as const },
      createdAt: event.createdAt,
      source: eventStageGuess(event)
    }));
}

function artifactEvidenceRefs(artifacts: AgentLoopArtifactRecord[]): WorkflowEvidenceRef[] {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    kind: "artifact" as const,
    label: artifact.name,
    summary: artifact.kind,
    interaction: "drill_down_link" as const,
    drillDownTarget: { page: "Artifact Diff Viewer" as const },
    createdAt: artifact.createdAt,
    source: artifact.kind.includes("spec") ? "plan" : "build"
  }));
}

function ciEvidenceRefs(ci: AgentLoopCiCheck[]): WorkflowEvidenceRef[] {
  return ci.map((check) => ({
    id: check.id,
    kind: "github_check" as const,
    label: check.name,
    summary: check.conclusion ?? check.status,
    interaction: "drill_down_link" as const,
    drillDownTarget: { page: "PR Inbox" as const },
    createdAt: check.observedAt,
    source: "merge_readiness"
  }));
}

function reviewEvidenceRefs(comments: AgentLoopReviewComment[]): WorkflowEvidenceRef[] {
  return comments.map((comment) => ({
    id: comment.id,
    kind: "pr_comment" as const,
    label: comment.author,
    summary: redactSecrets(comment.body.slice(0, 180)),
    interaction: "drill_down_link" as const,
    drillDownTarget: { page: "PR Inbox" as const },
    createdAt: comment.observedAt,
    source: "review"
  }));
}

function workerEvidenceRefs(workers: WorkerRun[]): WorkflowEvidenceRef[] {
  return workers.map((worker) => ({
    id: worker.id,
    kind: "event" as const,
    label: worker.type,
    summary: worker.error ? redactSecrets(worker.error) : worker.status,
    interaction: "drill_down_link" as const,
    drillDownTarget: { page: "Worker Runs" as const },
    createdAt: worker.completedAt ?? worker.startedAt,
    source: worker.type === "reviewer" ? "verify" : "build"
  }));
}

function reviewRows(input: WorkflowBoardInput, appended: WorkflowEvidenceRef[]): WorkflowReviewReportRow[] {
  const rows: WorkflowReviewReportRow[] = [];
  const structured = latestStructuredReviewEvidence(input.events);
  for (const { event, review } of structured.values()) {
    const ref = appended.find((item) => item.id === event.id);
    rows.push(reviewRowFromEvidence(event, review, ref));
  }
  rows.push(...input.reviewComments.map((comment) => ({
    id: comment.id,
    agent: comment.author,
    role: "GitHub PR comment",
    status: comment.actionable && !comment.isResolved ? "block" as const : "unknown" as const,
    prComment: "posted" as const,
    severitySummary: "no severity evidence",
    severityGroups: severityGroupsFromSummary("unknown"),
    resolutionStatus: comment.actionable && !comment.isResolved ? "pending" as const : "unknown" as const,
    resolutionEvidence: comment.actionable && !comment.isResolved ? "Actionable PR comment is unresolved." : "No structured fix/routing status.",
    nextAction: comment.actionable && !comment.isResolved ? "Classify and fix or reply." : "No action from available evidence.",
    evidenceRefIds: [comment.id]
  })));
  // Legacy review events preserve coarse completion status, but never infer P0/P1/P2 severity from free text.
  for (const event of input.events.filter((item) => item.kind === WORKFLOW_EVIDENCE_KIND && payloadStage(item) === "review")) {
    if (parseStoredReviewEvidence(event)) continue;
    const ref = appended.find((item) => item.id === event.id);
    const refs = payloadStringArray(event, "evidenceRefIds");
    const actor = payloadString(event, "actor");
    const status = payloadString(event, "status");
    rows.push({
      id: event.id,
      agent: reportAgentLabel(actor, event.message),
      role: "Legacy review evidence",
      status: status === "skipped" ? "skipped" : status === "blocked" || status === "failed" ? "block" : status === "done" ? "pass" : "unknown",
      prComment: refs.some(isGitHubIssueCommentUrl) ? "posted" : "unknown",
      severitySummary: "no severity evidence",
      severityGroups: severityGroupsFromSummary("unknown"),
      resolutionStatus: status === "blocked" || status === "failed" ? "pending" : "unknown",
      resolutionEvidence: "Legacy evidence has no structured fix/routing status.",
      reason: status === "skipped" ? event.message : undefined,
      nextAction: "Inspect legacy review evidence; structured completion data is unavailable.",
      evidenceRefIds: ref ? [ref.id, ...refs] : [event.id, ...refs]
    });
  }
  if (!rows.some((row) => row.agent === "Claude ACP")) {
    rows.push({
      id: "review:claude-unknown",
      agent: "Claude ACP",
      reviewer: "claude_acp",
      role: reviewRoleLabel("claude_acp"),
      status: "unknown",
      prComment: "unknown",
      severitySummary: "no requirement source",
      severityGroups: severityGroupsFromSummary("unknown"),
      resolutionStatus: "unknown",
      resolutionEvidence: "No structured review evidence yet.",
      requirement: "unknown",
      progress: "unknown",
      result: "unknown",
      reason: "No required Claude review evidence source exists yet.",
      nextAction: "Attach Claude review evidence when this work requires it.",
      evidenceRefIds: []
    });
  }
  if (!rows.some((row) => row.agent === "AGY/Gemini")) {
    rows.push({
      id: "review:agy-unknown",
      agent: "AGY/Gemini",
      reviewer: "agy_gemini",
      role: reviewRoleLabel("agy_gemini"),
      status: "unknown",
      prComment: "unknown",
      severitySummary: "no requirement source",
      severityGroups: severityGroupsFromSummary("unknown"),
      resolutionStatus: "unknown",
      resolutionEvidence: "No structured review evidence yet.",
      requirement: "unknown",
      progress: "unknown",
      result: "unknown",
      reason: "No required AGY/Gemini review evidence source exists yet.",
      nextAction: "Attach AGY/Gemini review evidence when this work requires it.",
      evidenceRefIds: []
    });
  }
  return rows;
}

function latestStructuredReviewEvidence(events: AgentLoopEvent[]): Map<WorkflowReviewReviewer, { event: AgentLoopEvent; review: WorkflowReviewEvidence }> {
  const latest = new Map<WorkflowReviewReviewer, { event: AgentLoopEvent; review: WorkflowReviewEvidence }>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.kind !== WORKFLOW_EVIDENCE_KIND || payloadStage(event) !== "review") continue;
    const review = parseStoredReviewEvidence(event);
    if (review) latest.set(review.reviewer, { event, review });
  }
  return latest;
}

function reviewRowFromEvidence(event: AgentLoopEvent, review: WorkflowReviewEvidence, ref: WorkflowEvidenceRef | undefined): WorkflowReviewReportRow {
  const refs = payloadStringArray(event, "evidenceRefIds");
  const progress = effectiveReviewProgress(review);
  const prComment = review.requirement === "not_required" || progress === "skipped"
    ? "not_required"
    : review.commentUrl
      ? "posted"
      : review.requirement === "required"
        ? "missing"
        : "unknown";
  return {
    id: event.id,
    agent: reviewAgentLabel(review.reviewer),
    reviewer: review.reviewer,
    role: review.role ?? reviewRoleLabel(review.reviewer),
    model: review.model,
    backend: review.backend ?? review.model,
    status: reviewStatus(review, progress),
    prComment,
    severitySummary: reviewSeverityLabel(review.severitySummary),
    severityGroups: reviewSeverityGroups(review),
    resolutionStatus: reviewResolutionStatus(review, progress),
    resolutionEvidence: reviewResolutionEvidence(review, progress),
    followUp: review.followUp,
    requirement: review.requirement,
    progress,
    result: review.result,
    commentUrl: review.commentUrl,
    commentId: review.commentId,
    sessionId: review.sessionId,
    conversationId: review.conversationId,
    reason: review.reason,
    nextAction: reviewNextAction(review, progress, prComment),
    evidenceRefIds: [
      ...(ref ? [ref.id] : [event.id]),
      ...refs,
      ...(review.commentUrl ? [review.commentUrl] : [])
    ]
  };
}

function effectiveReviewProgress(review: WorkflowReviewEvidence): WorkflowReviewProgress {
  if (review.requirement === "not_required" && review.progress === "skipped") return "skipped";
  if (review.requirement === "not_required" && review.progress === "complete") return "complete";
  if (review.progress === "complete" && !review.commentUrl) return "incomplete";
  if (review.requirement === "required" && review.progress === "unknown") return "incomplete";
  return review.progress;
}

function reviewStatus(review: WorkflowReviewEvidence, progress: WorkflowReviewProgress): WorkflowReviewReportRow["status"] {
  if (progress === "skipped") return "skipped";
  if (progress === "incomplete" && review.result !== "block") return "pending";
  if (review.result === "block") return "block";
  if (review.result === "warn") return "warn";
  if (review.result === "pass") return "pass";
  if (progress === "requested" || progress === "started" || progress === "in_progress" || progress === "incomplete") return "pending";
  return "unknown";
}

function reviewNextAction(review: WorkflowReviewEvidence, progress: WorkflowReviewProgress, prComment: WorkflowReviewReportRow["prComment"]): string {
  if (review.result === "block" || review.severitySummary === "p2_or_higher") return "Fix or route blocking findings before merge.";
  if (progress === "incomplete") return "Attach the missing required report evidence.";
  if (progress === "requested" || progress === "started" || progress === "in_progress") return "Wait for the reviewer report and PR comment.";
  if (prComment === "missing") return "Post or link the PR review report comment.";
  if (progress === "skipped") return review.reason ?? "Reviewer explicitly skipped.";
  if (progress === "complete") return "Keep report linked in PR evidence.";
  return "Attach structured review evidence when available.";
}

function reviewResolutionStatus(review: WorkflowReviewEvidence, progress: WorkflowReviewProgress): WorkflowReviewResolutionStatus {
  if (review.resolutionStatus) return review.resolutionStatus;
  if (review.result === "block" || review.severitySummary === "p2_or_higher") return "pending";
  if (progress === "incomplete") return "pending";
  if (review.result === "pass" && (review.severitySummary === "none" || review.severitySummary === "p3_only")) return "not_applicable";
  return "unknown";
}

function reviewResolutionEvidence(review: WorkflowReviewEvidence, progress: WorkflowReviewProgress): string {
  if (review.resolutionEvidence) return review.resolutionEvidence;
  if (review.reason) return review.reason;
  if (review.result === "block" || review.severitySummary === "p2_or_higher") return "P0/P1/P2 findings must be fixed or routed before merge.";
  if (progress === "incomplete") return "Required report or re-review evidence is incomplete.";
  if (review.result === "pass" && (review.severitySummary === "none" || review.severitySummary === "p3_only")) return "No P0/P1/P2 fix or routing required.";
  return "No structured fix/routing status.";
}

function reviewSeverityGroups(review: WorkflowReviewEvidence): WorkflowReviewSeverityGroup[] {
  const fromSummary = severityGroupsFromSummary(review.severitySummary);
  const explicit = severityGroupsFromExplicitFields(review);
  return fromSummary.map((group, index) => explicit[index]?.status === "present" ? explicit[index] : group);
}

function severityGroupsFromExplicitFields(review: WorkflowReviewEvidence): WorkflowReviewSeverityGroup[] {
  return [
    severityGroup("p0", "P0", review.p0),
    severityGroup("p1", "P1", review.p1),
    severityGroup("p2", "P2", review.p2),
    severityGroup("p3", "P3", review.p3),
    severityGroup("follow_up", "Follow-up", review.followUp)
  ];
}

function severityGroupsFromSummary(summary: WorkflowReviewSeveritySummary): WorkflowReviewSeverityGroup[] {
  if (summary === "none") {
    return REVIEW_SEVERITY_GROUPS.map((group) => ({ ...group, status: "none" as const }));
  }
  if (summary === "p3_only") {
    return REVIEW_SEVERITY_GROUPS.map((group) => ({
      ...group,
      status: group.id === "p3" ? "present" as const : "none" as const,
      ...(group.id === "p3" ? { evidence: "P3-only findings recorded." } : {})
    }));
  }
  if (summary === "p2_or_higher") {
    return REVIEW_SEVERITY_GROUPS.map((group) => ({
      ...group,
      status: "unknown" as const,
      ...(["p0", "p1", "p2"].includes(group.id) ? { evidence: "P2 or higher finding recorded; exact severity group not split." } : {})
    }));
  }
  return REVIEW_SEVERITY_GROUPS.map((group) => ({ ...group, status: "unknown" as const }));
}

function severityGroup(id: WorkflowReviewSeverityId, label: string, evidence: string | undefined): WorkflowReviewSeverityGroup {
  return evidence ? { id, label, status: "present", evidence } : { id, label, status: "none" };
}

function reviewAgentLabel(reviewer: WorkflowReviewReviewer): string {
  const labels: Record<WorkflowReviewReviewer, string> = {
    claude_acp: "Claude ACP",
    agy_gemini: "AGY/Gemini",
    internal_tester: "Internal tester",
    internal_reviewer: "Internal reviewer",
    github: "GitHub",
    human: "Human",
    custom: "Custom reviewer"
  };
  return labels[reviewer];
}

function reviewRoleLabel(reviewer: WorkflowReviewReviewer): string {
  const labels: Record<WorkflowReviewReviewer, string> = {
    claude_acp: "Code/security review",
    agy_gemini: "UI/multimodal review",
    internal_tester: "Internal tester",
    internal_reviewer: "Internal code review",
    github: "GitHub review",
    human: "Human owner review",
    custom: "Custom review"
  };
  return labels[reviewer];
}

function reviewSeverityLabel(severity: WorkflowReviewSeveritySummary): string {
  const labels: Record<WorkflowReviewSeveritySummary, string> = {
    none: "none",
    p3_only: "P3 only",
    p2_or_higher: "P2 or higher",
    unknown: "no severity evidence"
  };
  return labels[severity];
}

function verificationRows(input: WorkflowBoardInput): WorkflowCheckRow[] {
  const checks: WorkflowCheckRow[] = [
    { id: "lint", label: "Lint", status: "unknown", evidence: "no appended evidence", owner: "Codex" },
    { id: "focused_tests", label: "Focused tests", status: "unknown", evidence: "no appended evidence", owner: "Codex" },
    { id: "full_tests", label: "Full tests", status: "unknown", evidence: "no appended evidence", owner: "Codex" },
    { id: "gitnexus_detect", label: "GitNexus detect", status: "unknown", evidence: "no appended evidence", owner: "GitNexus" }
  ];
  for (const check of input.ci) {
    checks.push({
      id: `ci:${check.id}`,
      label: check.name,
      status: check.conclusion === "success" ? "passed" : check.conclusion ? "failed" : "pending",
      evidence: check.conclusion ?? check.status,
      owner: "GitHub CI"
    });
  }
  return checks;
}

function mergeReadinessRows(input: WorkflowBoardInput): WorkflowCheckRow[] {
  const readiness = input.mergeReadiness;
  if (hasCleanupEvidence(input)) {
    return [
      { id: "merge_policy", label: "Merge policy", status: "passed", evidence: "cleanup evidence supersedes pre-merge blockers", owner: "Codex" },
      { id: "findings_gate", label: "No unresolved P0/P1/P2", status: "passed", evidence: "cleanup evidence recorded after merge", owner: "Reviewer" }
    ];
  }
  if (!readiness) {
    return [{ id: "merge_policy", label: "Merge policy", status: "unknown", evidence: "merge readiness not available", owner: "Codex" }];
  }
  const evidenceRows = readiness.evidence.map((item, index) => ({
    id: `merge:evidence:${index}`,
    label: item,
    status: "passed" as const,
    evidence: item,
    owner: "Codex"
  }));
  const missingRows = readiness.missingConditions.map((item, index) => ({
    id: `merge:missing:${index}`,
    label: item,
    status: "blocked" as const,
    evidence: item,
    owner: "Codex"
  }));
  const blockingReview = blockingReviewEvidence(input.events);
  const satisfiedReview = satisfiedReviewEvidence(input.events);
  const findingsGate = blockingReview
    ? { id: "findings_gate", label: "No unresolved P0/P1/P2", status: "blocked" as const, evidence: blockingReview.message, owner: reviewAgentLabel(blockingReview.review.reviewer) }
    : satisfiedReview
      ? { id: "findings_gate", label: "No unresolved P0/P1/P2", status: "passed" as const, evidence: satisfiedReview, owner: "Reviewer" }
      : { id: "findings_gate", label: "No unresolved P0/P1/P2", status: "unknown" as const, evidence: "no severity evidence", owner: "Reviewer" };
  return [
    ...evidenceRows,
    ...missingRows,
    findingsGate
  ];
}

function blockingReviewEvidence(events: AgentLoopEvent[]): { message: string; review: WorkflowReviewEvidence } | undefined {
  for (const { event, review } of latestStructuredReviewEvidence(events).values()) {
    if (review && (review.result === "block" || review.severitySummary === "p2_or_higher") && !reviewFindingsResolved(review)) {
      return { message: event.message, review };
    }
  }
  return undefined;
}

function satisfiedReviewEvidence(events: AgentLoopEvent[]): string | undefined {
  const required = [...latestStructuredReviewEvidence(events).values()]
    .filter(({ review }) => review.requirement === "required");
  if (required.length === 0) return undefined;
  const allClear = required.every(({ review }) =>
    effectiveReviewProgress(review) === "complete" &&
    (
      reviewFindingsResolved(review) ||
      (review.result === "pass" && (review.severitySummary === "none" || review.severitySummary === "p3_only"))
    )
  );
  return allClear ? "all required structured reviews passed or resolved P0/P1/P2 findings" : undefined;
}

function reviewFindingsResolved(review: WorkflowReviewEvidence): boolean {
  return review.resolutionStatus === "fixed" || review.resolutionStatus === "routed";
}

function cleanupRows(input: WorkflowBoardInput): WorkflowCheckRow[] {
  return cleanupSubstageRows(input);
}

function cleanupSubstages(
  definition: (typeof WORKFLOW_STAGE_DEFINITIONS)[number],
  input: WorkflowBoardInput,
  refs: WorkflowEvidenceRef[],
  stageStatus: WorkflowStageStatus
): WorkflowBoardSubstage[] {
  const rows = cleanupSubstageRows(input);
  const firstIncompleteIndex = rows.findIndex((row) => row.status !== "passed" && row.status !== "skipped");
  return definition.substages.map((substage, index) => {
    const row = rows.find((item) => item.id === substage.id);
    const latestEvidence = cleanupEvidenceRefs(input.events, refs, substage.id);
    return {
      ...substage,
      status: row ? cleanupSubstageStatus(row, stageStatus, index === firstIncompleteIndex) : "pending",
      evidenceCounts: evidenceCounts(latestEvidence),
      latestEvidence,
      requiredEvidence: []
    };
  });
}

function cleanupSubstageRows(input: WorkflowBoardInput): WorkflowCheckRow[] {
  const evidence = cleanupEvidenceBySubstage(input.events);
  return cleanupDefinition().substages.map((substage) => {
    const fallback = cleanupFallback(input, substage.id);
    return cleanupCheck(substage.id, substage.label, cleanupOwner(substage.id), evidence, fallback.passed, fallback.evidence);
  });
}

function cleanupCheck(
  id: string,
  label: string,
  owner: string,
  evidence: Map<string, AgentLoopEvent>,
  fallbackPassed = false,
  fallbackEvidence = "no appended evidence"
): WorkflowCheckRow {
  const event = evidence.get(id);
  if (event) {
    return { id, label, status: "passed", evidence: event.message, owner };
  }
  return { id, label, status: fallbackPassed ? "passed" : "pending", evidence: fallbackEvidence, owner };
}

function cleanupSubstageStatus(row: WorkflowCheckRow, stageStatus: WorkflowStageStatus, isFirstIncomplete: boolean): WorkflowStageStatus {
  if (row.status === "passed") return "done";
  if (row.status === "failed") return "failed";
  if (row.status === "blocked") return "blocked";
  if (row.status === "skipped") return "skipped";
  if (stageStatus === "active" && isFirstIncomplete) return "active";
  return "pending";
}

function cleanupFallback(input: WorkflowBoardInput, substageId: string): { passed: boolean; evidence: string } {
  if (substageId === "pr_merged") {
    return { passed: input.pr?.state === "MERGED", evidence: input.pr?.state ?? "no PR link" };
  }
  if (substageId === "worktree_clean") {
    return { passed: input.run?.worktreeClean === true, evidence: String(input.run?.worktreeClean ?? "unknown") };
  }
  return { passed: false, evidence: "no appended evidence" };
}

function cleanupOwner(substageId: string): string {
  if (substageId === "pr_merged") return "GitHub";
  if (substageId === "gitnexus_reindexed") return "GitNexus";
  return "Codex";
}

function cleanupEvidenceRefs(events: AgentLoopEvent[], refs: WorkflowEvidenceRef[], substageId: string): WorkflowEvidenceRef[] {
  const eventIds = new Set(events
    .filter((event) => event.kind === WORKFLOW_EVIDENCE_KIND && payloadStage(event) === "cleanup" && payloadString(event, "substageId") === substageId)
    .map((event) => event.id));
  return refs.filter((ref) => eventIds.has(ref.id)).slice(0, 3);
}

function cleanupDefinition(): (typeof WORKFLOW_STAGE_DEFINITIONS)[number] {
  const definition = STAGE_BY_ID.get("cleanup");
  if (!definition) {
    throw new AgentLoopError("invalid_config", "cleanup workflow stage definition is missing.");
  }
  return definition;
}

function cleanupEvidenceBySubstage(events: AgentLoopEvent[]): Map<string, AgentLoopEvent> {
  const bySubstage = new Map<string, AgentLoopEvent>();
  for (const event of [...events].sort((left, right) => right.seq - left.seq)) {
    if (event.kind !== WORKFLOW_EVIDENCE_KIND || payloadStage(event) !== "cleanup") continue;
    const substageId = payloadString(event, "substageId");
    if (substageId && !bySubstage.has(substageId)) {
      bySubstage.set(substageId, event);
    }
  }
  return bySubstage;
}

function payloadStage(event: AgentLoopEvent): WorkflowStageId {
  const stageId = payloadString(event, "stageId");
  return isWorkflowStageId(stageId) ? stageId : eventStageGuess(event);
}

function payloadString(event: AgentLoopEvent, key: string): string | undefined {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function payloadStringArray(event: AgentLoopEvent, key: string): string[] {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [];
  }
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseStoredReviewEvidence(event: AgentLoopEvent): WorkflowReviewEvidence | undefined {
  if (!isRecord(event.payload)) return undefined;
  const review = event.payload.review;
  if (!isRecord(review)) return undefined;
  if (!isWorkflowReviewReviewer(review.reviewer)) return undefined;
  if (!isWorkflowReviewRequirement(review.requirement)) return undefined;
  if (!isWorkflowReviewProgress(review.progress)) return undefined;
  if (!isWorkflowReviewResult(review.result)) return undefined;
  if (!isWorkflowReviewSeverity(review.severitySummary)) return undefined;
  const commentUrl = typeof review.commentUrl === "string" ? review.commentUrl : undefined;
  return {
    reviewer: review.reviewer,
    requirement: review.requirement,
    progress: review.progress,
    result: review.result,
    severitySummary: review.severitySummary,
    ...optionalStoredReviewString("role", review.role),
    ...optionalStoredReviewString("model", review.model),
    ...optionalStoredReviewString("backend", review.backend),
    ...optionalStoredReviewString("sessionId", review.sessionId),
    ...optionalStoredReviewString("conversationId", review.conversationId),
    ...(commentUrl && isGitHubIssueCommentUrl(commentUrl) ? { commentUrl } : {}),
    ...optionalStoredReviewString("commentId", review.commentId),
    ...optionalStoredReviewString("p0", review.p0),
    ...optionalStoredReviewString("p1", review.p1),
    ...optionalStoredReviewString("p2", review.p2),
    ...optionalStoredReviewString("p3", review.p3),
    ...optionalStoredReviewString("followUp", review.followUp),
    ...(isWorkflowReviewResolution(review.resolutionStatus) ? { resolutionStatus: review.resolutionStatus } : {}),
    ...optionalStoredReviewString("resolutionEvidence", review.resolutionEvidence),
    ...optionalStoredReviewString("reason", review.reason)
  };
}

function optionalStoredReviewString<K extends keyof WorkflowReviewEvidence>(key: K, value: unknown): Pick<WorkflowReviewEvidence, K> | Record<string, never> {
  return typeof value === "string" && value.trim().length > 0 ? { [key]: value } as Pick<WorkflowReviewEvidence, K> : {};
}

function isWorkflowReviewReviewer(value: unknown): value is WorkflowReviewReviewer {
  return typeof value === "string" && REVIEW_REVIEWERS.includes(value as WorkflowReviewReviewer);
}

function isWorkflowReviewRequirement(value: unknown): value is WorkflowReviewRequirement {
  return typeof value === "string" && REVIEW_REQUIREMENTS.includes(value as WorkflowReviewRequirement);
}

function isWorkflowReviewProgress(value: unknown): value is WorkflowReviewProgress {
  return typeof value === "string" && REVIEW_PROGRESS.includes(value as WorkflowReviewProgress);
}

function isWorkflowReviewResult(value: unknown): value is WorkflowReviewResult {
  return typeof value === "string" && REVIEW_RESULTS.includes(value as WorkflowReviewResult);
}

function isWorkflowReviewSeverity(value: unknown): value is WorkflowReviewSeveritySummary {
  return typeof value === "string" && REVIEW_SEVERITIES.includes(value as WorkflowReviewSeveritySummary);
}

function isWorkflowReviewResolution(value: unknown): value is WorkflowReviewResolutionStatus {
  return typeof value === "string" && REVIEW_RESOLUTIONS.includes(value as WorkflowReviewResolutionStatus);
}

function eventStageGuess(event: AgentLoopEvent): WorkflowStageId {
  const text = `${event.kind} ${event.message}`.toLowerCase();
  if (text.includes("review")) return "review";
  if (text.includes("ci") || text.includes("merge readiness")) return "merge_readiness";
  if (text.includes("pr ") || text.includes("pull request")) return "pr";
  if (text.includes("test") || text.includes("lint") || text.includes("gitnexus")) return "verify";
  if (text.includes("branch") || text.includes("implement") || text.includes("worker")) return "build";
  if (text.includes("plan") || text.includes("spec")) return "plan";
  if (text.includes("merge") || text.includes("cleanup")) return "cleanup";
  return "work_item";
}

function stageLabel(stageId: WorkflowStageId): string {
  return STAGE_BY_ID.get(stageId)?.label ?? stageId;
}

function evidenceKindFromSource(source: string): WorkflowEvidenceRef["kind"] {
  const normalized = source.toLowerCase();
  if (normalized.includes("gitnexus")) return "gitnexus";
  if (normalized.includes("browser")) return "browser";
  if (normalized.includes("review") || normalized.includes("claude") || normalized.includes("agy") || normalized.includes("gemini")) return "report";
  if (normalized.includes("ci")) return "github_check";
  return "event";
}

function reportAgentLabel(actor: string | undefined, summary: string): string {
  const lower = summary.toLowerCase();
  if (actor === "agy_gemini" || lower.includes("agy") || lower.includes("gemini")) return "AGY/Gemini";
  if (actor === "claude_acp" || lower.includes("claude")) return "Claude ACP";
  if (actor === "tester") return "Internal tester";
  if (actor === "reviewer") return "Internal reviewer";
  return "Review evidence";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function isWorkflowActor(value: unknown): value is WorkflowActor {
  return typeof value === "string" && [
    "codex",
    "worker",
    "tester",
    "reviewer",
    "claude_acp",
    "agy_gemini",
    "github",
    "github_ci",
    "gitnexus",
    "browser",
    "human"
  ].includes(value);
}

function isWorkflowStageStatus(value: unknown): value is WorkflowStageStatus {
  return typeof value === "string" && ["pending", "active", "blocked", "done", "skipped", "manual", "failed"].includes(value);
}

function isAgentLoopState(value: string | undefined): value is AgentLoopState {
  return typeof value === "string" && PR_STATES.has(value);
}
