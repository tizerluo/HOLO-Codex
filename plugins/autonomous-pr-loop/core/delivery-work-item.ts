import { AgentLoopError } from "./errors.js";
import { redactSecrets } from "./redaction.js";
import type { AgentLoopDecision, AgentLoopEvent, AgentLoopRun, AgentLoopStorage } from "./types.js";

export const DELIVERY_WORK_ITEM_BOUND_KIND = "delivery_work_item_bound";
export const WORKFLOW_STAGE_EVIDENCE_KIND = "workflow_stage_evidence";

export interface DeliveryWorkItem {
  issue: number;
  title: string;
  url: string;
  branch?: string;
  source: "cli" | "dashboard" | "state_machine";
}

export interface BindDeliveryWorkItemInput {
  issue?: string;
  title?: string;
  url?: string;
  branch?: string;
  runId?: string;
  source?: "cli" | "dashboard" | "state_machine";
}

export interface BindDeliveryWorkItemResult {
  run: AgentLoopRun;
  workItem: DeliveryWorkItem;
  reused: boolean;
  bound: boolean;
  event?: AgentLoopEvent;
}

export interface ResumeDeliveryRunInput {
  runId?: string;
  reason?: string;
  currentBranch?: string;
  worktreeClean?: boolean;
}

export interface ResumeDeliveryRunResult {
  run: AgentLoopRun;
  workItem: DeliveryWorkItem;
  event: AgentLoopEvent;
  decision: AgentLoopDecision;
  recommendedState: string;
}

export function bindDeliveryWorkItem(
  storage: AgentLoopStorage,
  input: BindDeliveryWorkItemInput
): BindDeliveryWorkItemResult {
  const workItem = normalizeWorkItemInput(input);
  const run = selectBindableRun(storage, workItem, input.runId);
  const existing = getDeliveryWorkItem(storage, run.id);
  if (existing && sameIssue(existing, workItem)) {
    return { run, workItem: existing, reused: true, bound: false };
  }

  const event = storage.appendEvent({
    runId: run.id,
    kind: DELIVERY_WORK_ITEM_BOUND_KIND,
    message: `Bound delivery work item #${workItem.issue}: ${redactSecrets(workItem.title)}`,
    payload: workItem
  });
  storage.appendDecision({
    runId: run.id,
    kind: DELIVERY_WORK_ITEM_BOUND_KIND,
    message: `Bound delivery work item #${workItem.issue}.`,
    details: workItem
  });
  appendWorkItemStageEvidence(storage, run.id, workItem);
  return { run, workItem, reused: false, bound: true, event };
}

export function getDeliveryWorkItem(storage: AgentLoopStorage, runId: string | undefined): DeliveryWorkItem | undefined {
  if (!runId) return undefined;
  const event = latestEventLookup(storage)?.findLatestEvent(runId, DELIVERY_WORK_ITEM_BOUND_KIND)
    ?? storage
      .listEvents(100_000)
      .find((item) => item.runId === runId && item.kind === DELIVERY_WORK_ITEM_BOUND_KIND);
  return parseDeliveryWorkItem(event?.payload);
}

export function selectDefaultDeliveryRun(storage: AgentLoopStorage): AgentLoopRun | undefined {
  return storage
    .listRuns(200)
    .find((run) => isLiveRun(run) && getDeliveryWorkItem(storage, run.id) !== undefined);
}

export function resumeDeliveryRun(
  storage: AgentLoopStorage,
  input: ResumeDeliveryRunInput
): ResumeDeliveryRunResult {
  const runId = typeof input.runId === "string" && input.runId.trim().length > 0 ? input.runId.trim() : "";
  if (!runId) {
    throw new AgentLoopError("invalid_config", "delivery resume requires --run.");
  }
  const reason = typeof input.reason === "string" && input.reason.trim().length > 0 ? redactSecrets(input.reason.trim()) : "";
  if (!reason) {
    throw new AgentLoopError("invalid_config", "delivery resume requires --reason.");
  }
  const run = storage.listRuns(200).find((item) => item.id === runId);
  if (!run) {
    throw new AgentLoopError("storage_error", `Run not found: ${runId}`);
  }
  if (run.status !== "STOPPED") {
    throw new AgentLoopError("policy_violation", "Only stopped delivery runs can be resumed.", {
      details: { runId: run.id, status: run.status },
      exitCode: 2
    });
  }
  const workItem = getDeliveryWorkItem(storage, run.id);
  if (!workItem) {
    throw new AgentLoopError("policy_violation", "Only runs bound to a delivery work item can be resumed.", {
      details: { runId: run.id },
      exitCode: 2
    });
  }
  const currentBranch = input.currentBranch?.trim();
  if (workItem.branch && currentBranch && workItem.branch !== currentBranch) {
    throw new AgentLoopError("policy_violation", "Refusing to resume a delivery run from a different branch.", {
      details: { runId: run.id, expectedBranch: workItem.branch, currentBranch },
      exitCode: 2
    });
  }
  const conflicting = storage
    .listRuns(200)
    .find((item) => item.id !== run.id && isLiveRun(item));
  if (conflicting) {
    const existing = getDeliveryWorkItem(storage, conflicting.id);
    throw new AgentLoopError("policy_violation", "Another active delivery run conflicts with the requested resume.", {
      details: { runId: run.id, conflictingRunId: conflicting.id, existingIssue: existing?.issue, requestedIssue: workItem.issue },
      exitCode: 2
    });
  }

  const recommendedState = resumeStateForRun(storage, run);
  let resumed: AgentLoopRun;
  try {
    resumed = storage.updateRunStatus(run.id, run.version, "RUNNING", {
      currentState: recommendedState,
      ...(currentBranch ? { branch: currentBranch } : {}),
      ...(input.worktreeClean !== undefined ? { worktreeClean: input.worktreeClean } : {})
    });
  } catch (error) {
    if (isUniqueRunningRunError(error)) {
      throw new AgentLoopError("policy_violation", "Another active delivery run conflicts with the requested resume.", {
        details: { runId: run.id },
        exitCode: 2
      });
    }
    throw error;
  }
  const event = storage.appendEvent({
    runId: resumed.id,
    kind: "delivery_run_resumed",
    message: `Resumed delivery run for issue #${workItem.issue}.`,
    stateBefore: run.currentState ?? "STOPPED",
    stateAfter: recommendedState,
    payload: {
      issue: workItem.issue,
      branch: workItem.branch,
      reason
    }
  });
  const decision = storage.appendDecision({
    runId: resumed.id,
    kind: "delivery_run_resumed",
    message: `Resumed delivery run for issue #${workItem.issue}.`,
    details: {
      issue: workItem.issue,
      branch: workItem.branch,
      reason
    }
  });
  return { run: resumed, workItem, event, decision, recommendedState };
}

function resumeStateForRun(storage: AgentLoopStorage, run: AgentLoopRun): string {
  const stopped = storage
    .listEvents(1000)
    .filter((event) => event.runId === run.id && event.kind === "run_stopped")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const candidate = stopped?.stateBefore ?? run.currentState;
  return isSafeResumeState(candidate) ? candidate : "COMMIT_PUSH_PR";
}

function isSafeResumeState(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value !== "STOPPED" &&
    value !== "BLOCKED";
}

function isUniqueRunningRunError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed: runs\.status/i.test(error.message);
}

export function defaultIssueBranch(issue: number, title: string, prefix: string): string {
  const slug = `${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${prefix}issue-${issue}${slug ? `-${slug}` : ""}`;
}

function selectBindableRun(
  storage: AgentLoopStorage,
  workItem: DeliveryWorkItem,
  runId: string | undefined
): AgentLoopRun {
  if (runId) {
    const run = storage.listRuns(200).find((item) => item.id === runId);
    if (!run) {
      throw new AgentLoopError("storage_error", `Run not found: ${runId}`);
    }
    assertCanBindRun(storage, run, workItem);
    return run;
  }

  const liveRuns = storage.listRuns(200).filter(isLiveRun);
  const sameIssueRun = liveRuns.find((run) => {
    const existing = getDeliveryWorkItem(storage, run.id);
    return existing && sameIssue(existing, workItem);
  });
  if (sameIssueRun) return sameIssueRun;

  const unboundLiveRun = liveRuns.find((run) => run.status === "RUNNING" && getDeliveryWorkItem(storage, run.id) === undefined);
  if (unboundLiveRun) return unboundLiveRun;

  const different = liveRuns.find((run) => {
    const existing = getDeliveryWorkItem(storage, run.id);
    return existing !== undefined && !sameIssue(existing, workItem);
  });
  if (different) {
    const existing = getDeliveryWorkItem(storage, different.id);
    throw new AgentLoopError("policy_violation", "Another delivery work item is already bound to an active run.", {
      details: { runId: different.id, existingIssue: existing?.issue, requestedIssue: workItem.issue },
      exitCode: 2
    });
  }

  return storage.createRun("RUNNING", {
    currentState: "SELECT_NEXT_PR"
  });
}

function assertCanBindRun(storage: AgentLoopStorage, run: AgentLoopRun, workItem: DeliveryWorkItem): void {
  if (!isLiveRun(run)) {
    throw new AgentLoopError("policy_violation", "Delivery work item can only be bound to a running or blocked run.", {
      details: { runId: run.id, status: run.status },
      exitCode: 2
    });
  }
  const existing = getDeliveryWorkItem(storage, run.id);
  if (existing && !sameIssue(existing, workItem)) {
    throw new AgentLoopError("policy_violation", "The requested run is already bound to a different delivery work item.", {
      details: { runId: run.id, existingIssue: existing.issue, requestedIssue: workItem.issue },
      exitCode: 2
    });
  }
}

function normalizeWorkItemInput(input: BindDeliveryWorkItemInput): DeliveryWorkItem {
  const issue = Number(input.issue);
  if (!Number.isInteger(issue) || issue < 1) {
    throw new AgentLoopError("invalid_config", "delivery bind requires --issue with a positive integer.");
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) {
    throw new AgentLoopError("invalid_config", "delivery bind requires --title.");
  }
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/i.test(url)) {
    throw new AgentLoopError("invalid_config", "delivery bind requires --url pointing to a GitHub issue.");
  }
  const branch = typeof input.branch === "string" && input.branch.trim().length > 0 ? input.branch.trim() : undefined;
  return {
    issue,
    title: redactSecrets(title),
    url,
    ...(branch ? { branch } : {}),
    source: input.source ?? "cli"
  };
}

function appendWorkItemStageEvidence(storage: AgentLoopStorage, runId: string, workItem: DeliveryWorkItem): void {
  storage.appendEvent({
    runId,
    kind: WORKFLOW_STAGE_EVIDENCE_KIND,
    message: `Selected issue #${workItem.issue}: ${workItem.title}`,
    payload: {
      stageId: "work_item",
      substageId: "issue_selected",
      evidenceRefIds: [workItem.url],
      artifactIds: [],
      actor: "codex",
      status: "done",
      source: "delivery"
    }
  });
}

function sameIssue(left: DeliveryWorkItem, right: DeliveryWorkItem): boolean {
  return left.issue === right.issue;
}

function isLiveRun(run: AgentLoopRun): boolean {
  return run.status === "RUNNING" || run.status === "BLOCKED";
}

function latestEventLookup(storage: AgentLoopStorage): { findLatestEvent(runId: string, kind: string): AgentLoopEvent | undefined } | undefined {
  const candidate = storage as AgentLoopStorage & { findLatestEvent?: unknown };
  return typeof candidate.findLatestEvent === "function"
    ? { findLatestEvent: candidate.findLatestEvent.bind(storage) as (runId: string, kind: string) => AgentLoopEvent | undefined }
    : undefined;
}

function parseDeliveryWorkItem(payload: unknown): DeliveryWorkItem | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.issue !== "number" ||
    !Number.isInteger(record.issue) ||
    typeof record.title !== "string" ||
    typeof record.url !== "string"
  ) {
    return undefined;
  }
  const source = record.source === "dashboard" || record.source === "state_machine" ? record.source : "cli";
  return {
    issue: record.issue,
    title: record.title,
    url: record.url,
    ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
    source
  };
}
