import type { LocaleSetting } from "./locale.js";

/** Repository-level configuration for a portable HOLO-Codex installation. */
export interface AgentLoopConfig {
  repoId: string;
  locale: LocaleSetting;
  loopShape: LoopShapeId;
  workflowProfile: WorkflowProfileId;
  roleProfile: RoleProfileId;
  baseBranch: string;
  branchPrefix: string;
  plansDir: string;
  lintCommand?: string;
  testCommand?: string;
  gitnexusRepo?: string;
  gitnexusRequired: boolean;
  requiredChecks: string[];
  requireReviewApproval: boolean;
  autonomyMode: AutonomyMode;
  mergeMode: MergeMode;
  notifyMode: NotifyMode;
  reviewHandling: ReviewHandlingMode;
  carryoverTarget?: string;
  allowAutoMerge: boolean;
  maxReviewFixRounds: number;
  maxTestFixRounds: number;
  maxCiReruns: number;
  commandTimeoutMs: number;
  commandOutputLimitBytes: number;
  githubRetryMaxAttempts: number;
  githubRetryBaseDelayMs: number;
  reviewCiPollIntervalMs: number;
  reviewCiMaxWaitMs: number;
  workerBackend: WorkerBackend;
  workerTimeoutMs: number;
  workerMaxRetries: number;
  workerEphemeral: boolean;
  protectedPaths: string[];
  dashboard?: {
    enabled: boolean;
    host: string;
    port?: number;
  };
}

/** Supported loop shape identifiers. */
export type LoopShapeId = "pr-loop" | "generic-loop";

/** Built-in workflow profile identifiers selected by repo config. */
export type WorkflowProfileId =
  | "default_pr_loop"
  | "docs_only_loop"
  | "review_fix_loop"
  | "release_ready_loop"
  | "research_report_loop"
  | "document_preparation_loop"
  | "repo_hygiene_loop"
  | "weekly_review_loop"
  | "data_extraction_loop";

/** Built-in role profile identifiers selected by repo config. */
export type RoleProfileId = "default_pr_roles";


/** How far the loop may proceed without asking the operator to intervene. */
export type AutonomyMode = "supervised" | "autonomous_until_gate" | "autonomous_until_terminal";

/** Canonical merge strategy. Legacy `allowAutoMerge` is derived from this field. */
export type MergeMode = "manual" | "conditional" | "disabled";

/** Notification posture used to avoid turning progress into interruption. */
export type NotifyMode = "all_gates" | "important_only" | "blockers_only";

/** Review handling strategy for scoped fixes and follow-up carryover. */
export type ReviewHandlingMode =
  | "fix_scoped_and_carry_forward"
  | "ask_on_any_review"
  | "require_zero_open_findings";

/** Stable gate categories that stop or block loop progress. */
export type AgentLoopGateKind =
  | "needs_repo_init"
  | "unsupported_remote"
  | "needs_secret_or_login"
  | "policy_violation"
  | "ambiguous_next_pr"
  | "dirty_unowned_worktree"
  | "required_tool_unavailable"
  | "ci_required_checks_missing"
  | "ci_pending_timeout"
  | "merge_requires_confirmation"
  | "github_transient_failure"
  | "gitnexus_check_failed"
  | "github_resource_not_found"
  | "worker_failed"
  | "worker_output_invalid"
  | "review_out_of_scope"
  | "worker_timeout"
  | "worker_already_running"
  | "generic_goal_needs_confirmation"
  | "generic_human_gate"
  | "generic_scope_change_requested";

/** Current high-level loop status reported by CLI, hooks, MCP, and UI surfaces. */
export type AgentLoopStatus =
  | "IDLE"
  | "READY"
  | "RUNNING"
  | "BLOCKED"
  | "NEEDS_REPO_INIT"
  | "ERROR"
  | "STOPPED";

/** Persisted loop run with optimistic-lock version metadata. */
export interface AgentLoopRun {
  id: string;
  status: AgentLoopStatus;
  currentState?: string;
  version: number;
  branch?: string;
  worktreeClean?: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
}

/** Append-only event written to the loop event ledger. */
export interface AgentLoopEvent {
  id: string;
  seq: number;
  runId?: string;
  kind: string;
  message: string;
  stateBefore?: string;
  stateAfter?: string;
  payload?: unknown;
  artifactIds?: string[];
  createdAt: string;
}

/** Persisted artifact metadata shared by storage, CLI, and future UI surfaces. */
export interface AgentLoopArtifactRecord {
  id: string;
  runId: string;
  kind: string;
  name: string;
  path: string;
  sha256: string;
  createdAt: string;
}

/** Stored GitHub PR identity associated with a run and branch. */
export interface AgentLoopPrLink {
  id: string;
  runId: string;
  branch: string;
  prNumber: number;
  url: string;
  headRef: string;
  baseRef: string;
  state: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Latest observed CI check for a pull request. */
export interface AgentLoopCiCheck {
  id: string;
  runId: string;
  prNumber: number;
  name: string;
  status: string;
  conclusion?: string;
  url?: string;
  startedAt?: string;
  completedAt?: string;
  observedAt: string;
}

/** Normalized review comment from GitHub review threads. */
export interface AgentLoopReviewComment {
  id: string;
  runId: string;
  prNumber: number;
  commentId: string;
  url: string;
  author: string;
  body: string;
  path: string;
  line?: number;
  diffHunk: string;
  isResolved: boolean;
  isOutdated: boolean;
  actionable: boolean;
  status: "open" | "handled" | "out_of_scope" | "stale";
  observedAt: string;
}

/** Append-only decision explaining an idempotent lifecycle choice. */
export interface AgentLoopDecision {
  id: string;
  runId: string;
  kind: string;
  message: string;
  details?: unknown;
  createdAt: string;
}

/** Persisted gate row with approval/rejection metadata for control surfaces. */
export interface AgentLoopGate {
  id: string;
  runId?: string;
  kind: AgentLoopGateKind;
  status: "open" | "resolved" | "approved" | "rejected";
  message: string;
  details?: unknown;
  createdAt: string;
  resolvedAt?: string;
  decisionNote?: string;
  decidedAt?: string;
}

/** Structured operator decision metadata accepted by CLI, API, MCP, and UI gate controls. */
export interface GateDecisionInput {
  note: string;
  source?: "cli" | "api" | "ui" | "nl";
  payload?: Record<string, unknown>;
}

/** Trusted supervisor check recorded before publish actions are allowed. */
export interface AgentLoopRunCheck {
  runId: string;
  kind: "self_check" | "gitnexus_detect_changes" | "scope_guard" | "protected_paths" | "carryover_recorded";
  status: "passed" | "skipped";
  details?: unknown;
  createdAt: string;
}

/** Worker roles that may be delegated to Codex without owning GitHub lifecycle actions. */
export type WorkerType = "planner" | "implementation" | "review-fix" | "ci-fix" | "reviewer";

/** Profile summary exposed to CLI, MCP, Dashboard, audit, and prompts. */
export interface AgentLoopProfileSummary {
  loopShape: LoopShapeId;
  workflowProfile: WorkflowProfileId;
  workflowLabel: string;
  workflowDescription: string;
  roleProfile: RoleProfileId;
  lifecycleKind?: "pr" | "generic";
  expectedDeliverable?: string;
  allowedWriteRoots?: string[];
  currentRole?: {
    state: string;
    alias: string;
    workerType: WorkerType;
    label: string;
    sandbox: "read-only" | "workspace-write";
  };
  roleMapping: Array<{
    state: string;
    alias: string;
    workerType: WorkerType;
    label: string;
    sandbox: "read-only" | "workspace-write";
  }>;
  autonomyBoundary: string;
  handoffSummary: string;
  validationPosture: string;
  likelyGates: string[];
  availableWorkflows: Array<{ id: WorkflowProfileId; label: string; description: string }>;
  availableRoleProfiles: Array<{ id: RoleProfileId; label: string; description: string }>;
}

/** Workflow stage forecast rendered by dry-run surfaces. */
export interface WorkflowStageSummary {
  state: string;
  roleAlias?: string;
  workerType?: WorkerType;
  sandbox?: "read-only" | "workspace-write";
  gateExpected: boolean;
  deliverable?: string;
}

/** Supported worker runtime backends. */
export type WorkerBackend = "codex-exec" | "codex-app-server";

/** Worker execution status persisted for resume, retries, and future UI surfaces. */
export type WorkerStatus = "running" | "succeeded" | "failed" | "timed_out" | "invalid_output";

/** Structured result a worker must produce through `--output-schema`. */
export interface WorkerResult {
  ok: boolean;
  summary: string;
  changedFiles: string[];
  commandsRun: Array<{ command: string; exitCode: number }>;
  testsRun: string[];
  gitnexus: { impactRun: boolean; detectChangesRun: boolean; notes?: string };
  outOfScope: Array<{ item: string; reason: string }>;
  followUps: string[];
  error?: { kind: string; message: string };
}

/** Stored worker process metadata. */
export interface WorkerRun {
  id: string;
  runId: string;
  type: WorkerType;
  backend: string;
  status: WorkerStatus;
  threadId?: string;
  attempt: number;
  resumeUsed: boolean;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  resultArtifactId?: string;
  rawJsonlArtifactId?: string;
  error?: string;
}

/** Summary event extracted from Codex JSONL worker output. */
export interface WorkerEvent {
  id: string;
  seq: number;
  workerId: string;
  runId: string;
  eventType: string;
  itemType?: string;
  itemId?: string;
  itemStatus?: string;
  threadId?: string;
  backend?: WorkerBackend;
  summary?: unknown;
  usage?: unknown;
  artifactIds?: string[];
  createdAt: string;
}

/** Fact sources normalized into the Agent Timeline read model. */
export type AgentTimelineSource =
  | "event"
  | "worker_event"
  | "worker"
  | "state"
  | "gate"
  | "artifact"
  | "decision";

/** Public, redacted timeline entry assembled from immutable source rows. */
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

/** Timeline query filters exposed to MCP, API, and Dashboard surfaces. */
export interface AgentTimelineQuery {
  cursor?: string;
  limit?: number;
  sources?: AgentTimelineSource[];
  runId?: string;
  workerId?: string;
}

/** Stable cursor page returned by the Agent Timeline read model. */
export interface AgentTimelinePage {
  entries: AgentTimelineEntry[];
  nextCursor?: string;
}

/** Timeline storage consistency report used by doctor and tests. */
export interface AgentTimelineIntegrityReport {
  ok: boolean;
  missingTable: boolean;
  missingTriggers: string[];
  missingSourceRows: Array<{ source: AgentTimelineSource; missing: number }>;
  sourceCounts: Record<AgentTimelineSource, number>;
  repair: string;
}

/** Structured Codex command plan used for dry-runs and policy checks. */
export interface WorkerCommandPlan {
  file: "codex";
  args: string[];
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  promptPath: string;
  outputSchemaPath: string;
  outputLastMessagePath: string;
}

/** Scope guard report comparing worker claims with real git changes. */
export interface ScopeGuardReport {
  ok: boolean;
  actualChangedFiles: string[];
  reportedChangedFiles: string[];
  missingFromReport: string[];
  extraInReport: string[];
  protectedPathHits: string[];
  invalidWorkerPaths: string[];
  outOfScope: Array<{ item: string; reason: string }>;
  gate?: AgentLoopGateKind;
}

/** Storage contract shared by CLI, future hooks, MCP, and UI. */
export interface AgentLoopStorage {
  /** Close the storage handle and release SQLite resources. */
  close(): void;
  /** Persist the normalized repository configuration snapshot. */
  writeRepoConfig(config: AgentLoopConfig): void;
  /** Read the repository configuration snapshot when present. */
  readRepoConfig(): AgentLoopConfig | undefined;
  /** Create a new run with initial status and optional resume reality metadata. */
  createRun(status: AgentLoopStatus, options?: {
    currentState?: string;
    branch?: string;
    worktreeClean?: boolean;
  }): AgentLoopRun;
  /** Return the active RUNNING run or atomically create one. */
  getOrCreateActiveRun(options?: {
    currentState?: string;
    branch?: string;
    worktreeClean?: boolean;
  }): { run: AgentLoopRun; created: boolean };
  /** Update a run using optimistic locking on `expectedVersion`. */
  updateRunStatus(
    runId: string,
    expectedVersion: number,
    status: AgentLoopStatus,
    options?: {
      currentState?: string;
      branch?: string;
      worktreeClean?: boolean;
      stoppedAt?: string;
    }
  ): AgentLoopRun;
  /** Append an immutable event to the run ledger. */
  appendEvent(event: Omit<AgentLoopEvent, "id" | "seq" | "createdAt">): AgentLoopEvent;
  /** Open a gate that blocks loop progress until resolved. */
  writeGate(gate: {
    runId?: string;
    kind: AgentLoopGateKind;
    message: string;
    details?: unknown;
  }): void;
  /** Resolve all open gates for a run without deleting gate history. */
  resolveOpenGates(runId: string): void;
  /** Resolve open gates of one kind; default scope is repo-level unless `runId` or `scope: "all"` is supplied. */
  resolveOpenGatesByKind(kind: AgentLoopGateKind, options?: { scope?: "repo" | "run" | "all"; runId?: string }): void;
  /** List persisted gates newest-first, optionally scoped to one run. */
  listGates(runId?: string): AgentLoopGate[];
  /** Fetch a gate by stable id. */
  getGate(gateId: string): AgentLoopGate | undefined;
  /** Mark an open gate as approved or rejected with an operator note. */
  decideGate(gateId: string, decision: "approved" | "rejected", note: string): AgentLoopGate;
  /** Record a trusted supervisor check for publish prerequisites. */
  recordRunCheck(check: Omit<AgentLoopRunCheck, "createdAt">): AgentLoopRunCheck;
  /** Return true when a trusted supervisor check exists for a run. */
  hasRunCheck(runId: string, kind: AgentLoopRunCheck["kind"]): boolean;
  /** List trusted supervisor checks recorded for a run. */
  listRunChecks(runId: string): AgentLoopRunCheck[];
  /** Return the latest run by update time, if any exists. */
  getCurrentRun(): AgentLoopRun | undefined;
  /** Fetch a run by stable id. */
  getRun(runId: string): AgentLoopRun | undefined;
  /** List persisted runs newest-first. */
  listRuns(limit?: number): AgentLoopRun[];
  /** Run a group of read queries against one consistent SQLite snapshot. */
  readTransaction<T>(fn: () => T): T;
  /** Insert artifact metadata after its file has been written and hashed. */
  insertArtifact(record: AgentLoopArtifactRecord): void;
  /** Fetch artifact metadata by id. */
  getArtifact(artifactId: string): AgentLoopArtifactRecord;
  /** List artifacts for a run in creation order. */
  listArtifacts(runId: string): AgentLoopArtifactRecord[];
  /** Add an artifact id to an event without duplicating existing links. */
  linkArtifactToEvent(eventId: string, artifactId: string): void;
  /** Return the current status, latest run, and newest open gate. */
  getCurrentStatus(): {
    status: AgentLoopStatus;
    run?: AgentLoopRun;
    gate?: {
      kind: AgentLoopGateKind;
      message: string;
      details?: unknown;
    };
  };
  /** List recent ledger events newest-first, or sinceSeq deltas oldest-first for polling. */
  listEvents(options?: number | { sinceSeq?: number; limit?: number }): AgentLoopEvent[];
  /** List normalized agent timeline entries using an opaque cursor. */
  listAgentTimeline(query?: AgentTimelineQuery): AgentTimelinePage;
  /** Check whether the derived timeline index and triggers are present. */
  checkTimelineIntegrity(): AgentTimelineIntegrityReport;
  /** Upsert a pull request link for the run. */
  upsertPrLink(link: Omit<AgentLoopPrLink, "id" | "createdAt" | "updatedAt">): AgentLoopPrLink;
  /** Return the newest PR link for a run. */
  getPrLink(runId: string): AgentLoopPrLink | undefined;
  /** Replace the latest observed CI checks for a run and PR. */
  replaceCiChecks(runId: string, prNumber: number, checks: Array<Omit<AgentLoopCiCheck, "id" | "runId" | "prNumber" | "observedAt">>): AgentLoopCiCheck[];
  /** List stored CI checks for a run. */
  listCiChecks(runId: string): AgentLoopCiCheck[];
  /** Replace review comments for a run and PR. */
  replaceReviewComments(runId: string, prNumber: number, comments: Array<Omit<AgentLoopReviewComment, "id" | "runId" | "prNumber" | "observedAt">>): AgentLoopReviewComment[];
  /** List stored review comments for a run. */
  listReviewComments(runId: string): AgentLoopReviewComment[];
  /** Append a lifecycle decision. */
  appendDecision(decision: Omit<AgentLoopDecision, "id" | "createdAt">): AgentLoopDecision;
  /** List lifecycle decisions newest-first. */
  listDecisions(runId: string): AgentLoopDecision[];
  /** Create a persisted worker execution row. */
  createWorker(worker: {
    runId: string;
    type: WorkerType;
    backend: string;
    attempt: number;
    resumeUsed: boolean;
  }): WorkerRun;
  /** Update worker metadata after JSONL ingest, completion, or failure. */
  updateWorker(workerId: string, patch: {
    status?: WorkerStatus;
    threadId?: string;
    completedAt?: string;
    exitCode?: number;
    resultArtifactId?: string;
    rawJsonlArtifactId?: string;
    error?: string;
  }): WorkerRun;
  /** Return any currently running worker. */
  getRunningWorker(): WorkerRun | undefined;
  /** List persisted workers newest-first, optionally scoped to a run. */
  listWorkers(runId?: string, limit?: number): WorkerRun[];
  /** Append a normalized worker JSONL event. */
  appendWorkerEvent(event: Omit<WorkerEvent, "id" | "seq" | "createdAt">): WorkerEvent;
  /** List worker events for one worker in creation order. */
  listWorkerEvents(workerId: string): WorkerEvent[];
}

/** Single diagnostic check emitted by `agent-loop doctor`. */
export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  details?: unknown;
}

/** Structured doctor output used by humans, tests, and future control surfaces. */
export interface DoctorReport {
  status: "pass" | "warn" | "fail";
  checks: DoctorCheck[];
  gate?: AgentLoopGateKind;
}

export interface LoadedConfig {
  path: string;
  config: AgentLoopConfig;
}
