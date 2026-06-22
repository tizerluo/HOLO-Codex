export interface DashboardResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  gate?: string;
}

export type ActivityState = "active" | "historical";

export interface RunSummary {
  id: string;
  status: string;
  currentState?: string;
  branch?: string;
  worktreeClean?: boolean;
  updatedAt: string;
  startedAt?: string;
}

export interface GateSummary {
  id: string;
  kind: string;
  status: string;
  message: string;
  details?: unknown;
  createdAt: string;
  decisionNote?: string;
  activity?: ActivityState;
  activityReason?: string;
}

export type GateReevaluationResult =
  | "still_historical"
  | "overridden_by_current_reality"
  | "active_again"
  | "manually_handled";

export interface GateReevaluationData {
  gate: GateSummary;
  result: GateReevaluationResult;
  reevaluated: true;
}

export interface EventSummary {
  id: string;
  seq: number;
  kind: string;
  message: string;
  stateBefore?: string;
  stateAfter?: string;
  createdAt: string;
  artifactIds?: string[];
}

export type AgentTimelineSource = "event" | "worker_event" | "worker" | "state" | "gate" | "artifact" | "decision";

export interface AgentTimelineEntry {
  timelineSeq: number;
  occurredAt: string;
  cursor: string;
  source: AgentTimelineSource;
  kind: string;
  runId?: string;
  workerId?: string;
  threadId?: string;
  title: string;
  summary: string;
  status?: string;
  artifactIds?: string[];
  createdAt: string;
  rawRef: { table: string; id: string; seq?: number };
}

export interface AgentTimelinePage {
  entries: AgentTimelineEntry[];
  nextCursor?: string;
}

export interface WorkerSummary {
  id: string;
  type: string;
  status: string;
  startedAt: string;
  threadId?: string;
  completedAt?: string;
  resultArtifactId?: string;
  error?: string;
  activity?: ActivityState;
  activityReason?: string;
}

export interface ArtifactSummary {
  id: string;
  kind: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface CiCheckSummary {
  id: string;
  name: string;
  status: string;
  conclusion?: string;
  observedAt: string;
}

export interface ReviewCommentSummary {
  id: string;
  author: string;
  path: string;
  body: string;
  actionable: boolean;
  isResolved: boolean;
  isOutdated: boolean;
  status: string;
}

export interface AutonomyPosture {
  autonomyMode: string;
  mergeMode: string;
  notifyMode: string;
  reviewHandling: string;
  summary: string;
  notifyWhen: string[];
  requiresConfirmation: string[];
  allowConditionalMerge: boolean;
}

export interface MergeReadiness {
  state: string;
  ready: boolean;
  missingConditions: string[];
  evidence: string[];
  carryoverRecords: string[];
}

export interface ProfileSummary {
  loopShape: string;
  workflowProfile: string;
  workflowLabel: string;
  workflowDescription: string;
  roleProfile: string;
  currentRole?: {
    state: string;
    alias: string;
    workerType: string;
    label: string;
    sandbox: string;
  };
  roleMapping: Array<{
    state: string;
    alias: string;
    workerType: string;
    label: string;
    sandbox: string;
  }>;
  autonomyBoundary: string;
  handoffSummary: string;
  validationPosture: string;
  likelyGates: string[];
  lifecycleKind?: string;
  expectedDeliverable?: string;
  allowedWriteRoots?: string[];
  availableWorkflows: Array<{ id: string; label: string; description: string }>;
  availableRoleProfiles: Array<{ id: string; label: string; description: string }>;
}

export interface WorkflowStageSummary {
  state: string;
  roleAlias?: string;
  workerType?: string;
  gateExpected: boolean;
  sandbox?: string;
  deliverable?: string;
}

export type WorkflowStageStatus = "pending" | "active" | "blocked" | "done" | "skipped" | "manual" | "failed";
export type WorkflowStageId = "work_item" | "plan" | "build" | "verify" | "pr" | "review" | "merge_readiness" | "cleanup";

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
  page: "Event Ledger" | "Gate Center" | "Worker Runs" | "Artifact Diff Viewer" | "PR Inbox" | "Scope Guard" | "Recovery Center";
}

export interface WorkflowEvidenceRef {
  id: string;
  kind: string;
  label: string;
  summary: string;
  interaction: "popover" | "drill_down_link";
  drillDownTarget?: WorkflowDrillDownTarget;
  createdAt?: string;
  source?: string;
}

export interface WorkflowActorChip {
  actor: string;
  label: string;
  status: WorkflowStageStatus;
  model?: string;
  sessionId?: string;
}

export interface WorkflowBoardSubstage {
  id: string;
  label: string;
  status: WorkflowStageStatus;
  evidenceCounts: WorkflowEvidenceCounts;
  latestEvidence: WorkflowEvidenceRef[];
  requiredEvidence: Array<{
    id: string;
    label: string;
    status: "pending" | "satisfied" | "blocked" | "skipped";
    evidenceRefIds: string[];
    skippedReason?: string;
    blockedBy?: string;
  }>;
}

export interface WorkflowBoardStage {
  id: WorkflowStageId;
  label: string;
  status: WorkflowStageStatus;
  actorChips: WorkflowActorChip[];
  evidenceCounts: WorkflowEvidenceCounts;
  substages: WorkflowBoardSubstage[];
  latestAction?: { label: string; command?: string; safeToRunFromDashboard: boolean; requiresConfirmation: boolean };
  blockers: Array<{
    id: string;
    severity: string;
    title: string;
    reason: string;
    owner: string;
    nextAction: string;
    blockedBy?: string;
    evidenceRefIds: string[];
  }>;
  nextAction?: string;
}

export interface WorkflowReviewReportRow {
  id: string;
  agent: string;
  reviewer?: "claude_acp" | "agy_gemini" | "internal_tester" | "internal_reviewer" | "github" | "human" | "custom";
  role: string;
  model?: string;
  backend?: string;
  status: "pass" | "block" | "warn" | "pending" | "skipped" | "unknown";
  prComment: "posted" | "missing" | "not_required" | "unknown";
  severitySummary: string;
  severityGroups: Array<{
    id: "p0" | "p1" | "p2" | "p3" | "follow_up";
    label: string;
    status: "none" | "present" | "unknown";
    evidence?: string;
  }>;
  resolutionStatus: "fixed" | "routed" | "pending" | "not_applicable" | "unknown";
  resolutionEvidence: string;
  followUp?: string;
  requirement?: "required" | "optional" | "not_required" | "unknown";
  progress?: "requested" | "started" | "in_progress" | "incomplete" | "complete" | "skipped" | "unknown";
  result?: "pass" | "block" | "warn" | "unknown";
  commentUrl?: string;
  commentId?: string;
  sessionId?: string;
  conversationId?: string;
  reason?: string;
  nextAction?: string;
  evidenceRefIds: string[];
}

export interface WorkflowCheckRow {
  id: string;
  label: string;
  status: "passed" | "failed" | "pending" | "blocked" | "skipped" | "unknown";
  evidence: string;
  owner: string;
  blockedBy?: string;
}

export interface WorkflowBoard {
  runId?: string | undefined;
  mode: "empty" | "active" | "historical" | "unsupported" | "unknown_state";
  activeStageId?: WorkflowStageId | undefined;
  selectedStageId: WorkflowStageId;
  stageSource?: "run_state" | "workflow_evidence" | "gate" | "historical";
  stageSourceEvent?: { id: string; status: WorkflowStageStatus; createdAt: string };
  hookCapture?: {
    status: "captured" | "not_seen" | "stale" | "ambiguous" | "unavailable";
    reason: string;
    currentRepoBindings?: number;
    sessionScopedBindings?: number;
    activeBindings?: number;
    lastSeenAt?: string;
    latestHookEventAt?: string;
    latestHookEventKind?: string;
    runId?: string;
  };
  workItem: {
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
  };
  stages: WorkflowBoardStage[];
  evidenceRefs: WorkflowEvidenceRef[];
  reviewReports: WorkflowReviewReportRow[];
  verificationChecks: WorkflowCheckRow[];
  mergeReadinessChecks: WorkflowCheckRow[];
  cleanupChecks: WorkflowCheckRow[];
  appendEvidenceEnabled: boolean;
  message?: string | undefined;
}

export interface WorkflowEvidenceAppendInput {
  runId?: string | undefined;
  stageId: WorkflowStageId;
  substageId?: string | undefined;
  summary: string;
  evidenceRefIds?: string[] | undefined;
  artifactIds?: string[] | undefined;
  actor?: string | undefined;
  status?: WorkflowStageStatus | undefined;
  source?: string | undefined;
  review?: {
    reviewer: "claude_acp" | "agy_gemini" | "internal_tester" | "internal_reviewer" | "github" | "human" | "custom";
    requirement: "required" | "optional" | "not_required" | "unknown";
    progress: "requested" | "started" | "in_progress" | "incomplete" | "complete" | "skipped" | "unknown";
    result: "pass" | "block" | "warn" | "unknown";
    severitySummary: "none" | "p3_only" | "p2_or_higher" | "unknown";
    role?: string;
    model?: string;
    backend?: string;
    sessionId?: string;
    conversationId?: string;
    commentUrl?: string;
    commentId?: string;
    p0?: string;
    p1?: string;
    p2?: string;
    p3?: string;
    followUp?: string;
    resolutionStatus?: "fixed" | "routed" | "pending" | "not_applicable" | "unknown";
    resolutionEvidence?: string;
    reason?: string;
  } | undefined;
}

export interface LoopNotification {
  id: string;
  severity: "informational" | "attention" | "confirmation_required" | "blocked";
  title: string;
  reason: string;
  source: string;
  sourceId: string;
  createdAt: string;
  payload?: unknown;
}

export interface PlanItem {
  id: string;
  title: string;
  status: string;
  file: string;
  dependsOn: string[];
  issueRefs: string[];
  whySelected?: string;
}

export interface PlanNavigatorData {
  convention: string;
  currentMilestone: string;
  selectedNext?: PlanItem;
  completed: PlanItem[];
  candidates: PlanItem[];
  ambiguous: boolean;
  evidence: string[];
}

export interface PrSelectionData {
  mode: "current_pr" | "next_spec" | "ambiguous" | "generic_loop";
  ambiguous: boolean;
  item?: PlanItem;
  branchName?: string;
  prNumber?: number;
  prUrl?: string;
  loopShape?: string;
  workflowProfile?: string;
  reason?: string;
  candidates?: Array<Record<string, unknown>>;
  evidence: string[];
}

export interface ConfigSnapshot {
  path: string;
  hash: string;
  mtimeMs: number;
  config: Record<string, unknown>;
}

export interface DryRunPreviewData {
  nextPr?: PlanItem;
  branchName?: string;
  selection?: PrSelectionData;
  profile?: ProfileSummary;
  workflowStages?: WorkflowStageSummary[];
  commandsPlanned: string[];
  workerType: string;
  possibleGates: string[];
  missingConditions: string[];
  filesLikelyTouched: string[];
  autonomyForecast: AutonomyPosture;
  mergeForecast?: MergeReadiness;
}

export interface MissionControlData {
  current: {
    status: string;
    nextAction: string;
    run?: RunSummary;
    gate?: {
      kind: string;
      message: string;
      details?: unknown;
    };
  };
  gates: GateSummary[];
  pr?: {
    prNumber: number;
    url: string;
    branch: string;
    state: string;
    draft: boolean;
    updatedAt: string;
  };
  ci: CiCheckSummary[];
  reviewComments: ReviewCommentSummary[];
  workers: WorkerSummary[];
  artifacts: ArtifactSummary[];
  events: EventSummary[];
  decisions?: Array<{ id: string; kind: string; message: string; createdAt: string; details?: unknown }>;
  timelineSummary?: {
    latest?: AgentTimelineEntry;
    lastFailure?: AgentTimelineEntry;
    activeWorker?: { id: string; type: string; status: string; threadId?: string; startedAt: string };
    hasObservationGap: boolean;
    runId?: string;
  };
  autonomy?: AutonomyPosture;
  mergeReadiness?: MergeReadiness;
  profile?: ProfileSummary;
  notifications?: LoopNotification[];
  plan?: PlanNavigatorData;
  selection?: PrSelectionData;
  recoveryWarnings?: string[];
}

export interface DashboardApi {
  dashboardMeta(): Promise<DashboardResult<DashboardMetaData>>;
  missionControl(): Promise<DashboardResult<MissionControlData>>;
  observe(options?: { limit?: number }): Promise<DashboardResult<ObserveData>>;
  events(since?: number): Promise<DashboardResult<{ events: EventSummary[] }>>;
  agentTimeline(options?: {
    cursor?: string;
    limit?: number;
    sources?: AgentTimelineSource[];
    runId?: string;
    workerId?: string;
  }): Promise<DashboardResult<AgentTimelinePage>>;
  mutate(path: string, body?: unknown): Promise<DashboardResult<unknown>>;
  artifact(id: string): Promise<DashboardResult<{ record: ArtifactSummary; contentBase64: string }>>;
  plan(): Promise<DashboardResult<{ plan: PlanNavigatorData; selection?: PrSelectionData }>>;
  policyConfig(): Promise<DashboardResult<ConfigSnapshot>>;
  dryRunPreview(): Promise<DashboardResult<DryRunPreviewData>>;
  notifications(): Promise<DashboardResult<{ notifications: LoopNotification[] }>>;
  workflowBoard?(options?: { runId?: string }): Promise<DashboardResult<WorkflowBoard>>;
  appendWorkflowEvidence?(input: WorkflowEvidenceAppendInput): Promise<DashboardResult<unknown>>;
  auditExport(options: { runId: string; format: "markdown" | "json" }): Promise<DashboardResult<AuditExportData>>;
}

export interface ObserveData {
  dashboard: { url: string; host: string; port: number; loopbackOnly: true };
  happy: { installed: boolean; versionText?: string; supportsNotify: boolean };
  current: MissionControlData["current"];
  timeline: AgentTimelinePage;
}

export interface AuditExportData {
  runId: string;
  format: "markdown" | "json";
  content: string | Record<string, unknown>;
}

export interface DashboardMetaData {
  appName: string;
  surface: string;
  targetRepo?: {
    root: string;
    repoId: string;
  };
}

export const DASHBOARD_TOKEN_STORAGE_KEY = "agent-loop-dashboard-token";
const DASHBOARD_RUNTIME_TOKEN_KEY = "__AGENT_LOOP_DASHBOARD_TOKEN__";

declare global {
  interface Window {
    __AGENT_LOOP_DASHBOARD_TOKEN__?: unknown;
  }
}

export function createDashboardApi(token = storedDashboardToken()): DashboardApi {
  return {
    dashboardMeta: () => apiGet<DashboardMetaData>("/api/dashboard-meta"),
    missionControl: () => apiGet<MissionControlData>("/api/mission-control"),
    observe: (options) => apiGet<ObserveData>(`/api/observe${options?.limit === undefined ? "" : `?limit=${options.limit}`}`),
    events: (since) => apiGet<{ events: EventSummary[] }>(`/api/events${since === undefined ? "" : `?since=${since}`}`),
    agentTimeline: (options) => apiGet<AgentTimelinePage>(timelinePath(options)),
    mutate: (path, body) => apiPost(path, token, body),
    artifact: (id) => apiGet<{ record: ArtifactSummary; contentBase64: string }>(
      `/api/artifacts/${encodeURIComponent(id)}`,
      token
    ),
    plan: () => apiGet<{ plan: PlanNavigatorData }>("/api/plan"),
    policyConfig: () => apiGet<ConfigSnapshot>("/api/policy-config"),
    dryRunPreview: () => apiGet<DryRunPreviewData>("/api/dry-run-preview"),
    notifications: () => apiGet<{ notifications: LoopNotification[] }>("/api/notifications"),
    workflowBoard: (options) => apiGet<WorkflowBoard>(workflowBoardPath(options)),
    appendWorkflowEvidence: (input) => apiPost("/api/workflow-board/evidence", token, input),
    auditExport: (options) => apiGet<AuditExportData>(auditExportPath(options))
  };
}

function workflowBoardPath(options?: { runId?: string }): string {
  const params = new URLSearchParams();
  if (options?.runId) params.set("runId", options.runId);
  const query = params.toString();
  return `/api/workflow-board${query ? `?${query}` : ""}`;
}

function timelinePath(options?: {
  cursor?: string;
  limit?: number;
  sources?: AgentTimelineSource[];
  runId?: string;
  workerId?: string;
}): string {
  const params = new URLSearchParams();
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.runId) params.set("runId", options.runId);
  if (options?.workerId) params.set("workerId", options.workerId);
  for (const source of options?.sources ?? []) {
    params.append("source", source);
  }
  const query = params.toString();
  return `/api/agent-timeline${query ? `?${query}` : ""}`;
}

function tokenFromLocation(): string {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token") ?? "";
  if (token) {
    window.localStorage.setItem(DASHBOARD_TOKEN_STORAGE_KEY, token);
    removeTokenFromLocation(url);
    return token;
  }
  return "";
}

function removeTokenFromLocation(url = new URL(window.location.href)): void {
  if (!url.searchParams.has("token")) {
    return;
  }
  url.searchParams.delete("token");
  window.history.replaceState(window.history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function tokenFromRuntimeBootstrap(): string {
  const token = window[DASHBOARD_RUNTIME_TOKEN_KEY];
  delete window[DASHBOARD_RUNTIME_TOKEN_KEY];
  if (typeof token !== "string" || token.length === 0) {
    return "";
  }
  removeTokenFromLocation();
  window.localStorage.setItem(DASHBOARD_TOKEN_STORAGE_KEY, token);
  return token;
}

export function storedDashboardToken(): string {
  return tokenFromRuntimeBootstrap() || tokenFromLocation() || (window.localStorage.getItem(DASHBOARD_TOKEN_STORAGE_KEY) ?? "");
}

export function storeDashboardToken(token: string): void {
  window.localStorage.setItem(DASHBOARD_TOKEN_STORAGE_KEY, token);
}

function auditExportPath(options: { runId: string; format: "markdown" | "json" }): string {
  const params = new URLSearchParams();
  params.set("runId", options.runId);
  params.set("format", options.format);
  return `/api/audit-export?${params.toString()}`;
}

async function apiGet<T>(path: string, token?: string): Promise<DashboardResult<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers["x-agent-loop-token"] = token;
  }
  return await fetchJson<T>(path, { headers });
}

async function apiPost(path: string, token: string, body?: unknown): Promise<DashboardResult<unknown>> {
  return await fetchJson(path, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-agent-loop-token": token
    },
    body: JSON.stringify(body ?? {})
  });
}

async function fetchJson<T>(path: string, init: RequestInit): Promise<DashboardResult<T>> {
  try {
    const response = await fetch(path, init);
    return await response.json() as DashboardResult<T>;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "network_error",
        message: error instanceof Error ? error.message : "Dashboard API request failed."
      }
    };
  }
}
