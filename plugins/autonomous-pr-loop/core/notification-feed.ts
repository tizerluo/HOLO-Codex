import type { MergeReadiness } from "./autonomy-policy.js";
import type { AgentLoopConfig, AgentLoopEvent, AgentLoopGate, AgentTimelineEntry, WorkerRun } from "./types.js";
import { isRecord } from "./config.js";
import { redactSecrets } from "./redaction.js";

export type NotificationSeverity = "informational" | "attention" | "confirmation_required" | "blocked";

export interface LoopNotification {
  id: string;
  severity: NotificationSeverity;
  title: string;
  reason: string;
  source: "event" | "gate" | "timeline" | "worker" | "merge";
  sourceId: string;
  createdAt: string;
  payload?: unknown;
}

/** Derive dashboard notifications from events and gates without making progress noisy. */
export function deriveNotifications(input: {
  config: AgentLoopConfig;
  events: AgentLoopEvent[];
  gates: AgentLoopGate[];
  timelineEntries?: AgentTimelineEntry[];
  workers?: WorkerRun[];
  mergeReadiness?: MergeReadiness;
  runId?: string;
  now?: Date;
  dismissedIds?: Set<string>;
}): LoopNotification[] {
  const readIds = new Set([
    ...notificationReadIds(input.events),
    ...notificationDismissedIds(input.events),
    ...(input.dismissedIds ?? [])
  ]);
  const gateNotifications = input.gates
    .filter((gate) => gate.status === "open")
    .map((gate): LoopNotification => ({
      id: `gate:${gate.id}`,
      severity: severityForGate(gate.kind),
      title: gate.kind,
      reason: reasonForGate(gate.kind),
      source: "gate",
      sourceId: gate.id,
      createdAt: gate.createdAt,
      payload: redactPayload(gate.details)
    }));
  const eventNotifications = input.events
    .map((event) => notificationForEvent(event))
    .filter((item): item is LoopNotification => item !== undefined);
  const timelineNotifications = timelineDerivedNotifications(input.timelineEntries ?? [], input.workers ?? [], input.now ?? new Date());
  const mergeRunId = input.runId ?? currentRunId(input.workers);
  const mergeNotifications = input.mergeReadiness?.ready && mergeRunId
    ? [mergeReadyNotification(mergeRunId, input.mergeReadiness, input.now ?? new Date())]
    : [];
  return [...gateNotifications, ...eventNotifications, ...timelineNotifications, ...mergeNotifications]
    .filter((notification) => !readIds.has(notification.id))
    .filter((notification) => isVisibleForMode(input.config.notifyMode, notification.severity))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function notificationReadIds(events: AgentLoopEvent[]): Set<string> {
  return notificationIdsForKind(events, "notification_marked_read");
}

function notificationDismissedIds(events: AgentLoopEvent[]): Set<string> {
  return notificationIdsForKind(events, "notification_dismissed");
}

function notificationIdsForKind(events: AgentLoopEvent[], kind: string): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind !== kind || !isRecord(event.payload)) {
      continue;
    }
    const notificationIds = event.payload.notificationIds;
    if (Array.isArray(notificationIds)) {
      for (const id of notificationIds) {
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  return ids;
}

function notificationForEvent(event: AgentLoopEvent): LoopNotification | undefined {
  const severity = severityForEvent(event.kind);
  if (!severity) {
    return undefined;
  }
  return {
    id: `event:${event.id}`,
    severity,
    title: event.kind,
    reason: reasonForEvent(event.kind, severity),
    source: "event",
    sourceId: event.id,
    createdAt: event.createdAt,
    payload: redactPayload(event.payload)
  };
}

function timelineDerivedNotifications(entries: AgentTimelineEntry[], workers: WorkerRun[], now: Date): LoopNotification[] {
  const notifications: LoopNotification[] = [];
  const workerStatuses = new Map(workers.map((worker) => [worker.id, worker.status]));
  for (const worker of workers) {
    if (worker.status === "failed" || worker.status === "timed_out" || worker.status === "invalid_output") {
      notifications.push({
        id: `worker:${worker.id}:${worker.status}`,
        severity: "attention",
        title: worker.status === "failed" ? "worker_failed" : `worker_${worker.status}`,
        reason: "A worker reached a terminal failure state.",
        source: "worker",
        sourceId: worker.id,
        createdAt: worker.completedAt ?? worker.startedAt,
        payload: redactPayload({ type: worker.type, error: worker.error })
      });
    }
  }
  for (const entry of entries) {
    if (isPermissionRequestEntry(entry)) {
      const workerId = entry.workerId ?? "unknown";
      const itemId = timelineItemId(entry);
      notifications.push({
        id: `permission:${workerId}:${itemId}`,
        severity: "confirmation_required",
        title: "permission_requested",
        reason: "A permission request is visible in the agent timeline.",
        source: "timeline",
        sourceId: entry.rawRef.id,
        createdAt: entry.occurredAt,
        payload: redactPayload({ title: entry.title, summary: entry.summary })
      });
    }
    if (entry.source === "worker_event" && entry.kind === "command_execution" && !isTerminalWorkerStatus(workerStatuses.get(entry.workerId ?? "")) && isLongRunningCommand(entry, now)) {
      const workerId = entry.workerId ?? "unknown";
      const itemId = timelineItemId(entry);
      notifications.push({
        id: `longrunning:${workerId}:${itemId}`,
        severity: "attention",
        title: "long_running_command",
        reason: "A command has been running for more than 60 seconds without a terminal event.",
        source: "timeline",
        sourceId: entry.rawRef.id,
        createdAt: entry.occurredAt,
        payload: redactPayload({ title: entry.title, summary: entry.summary })
      });
    }
  }
  return notifications;
}

function isPermissionRequestEntry(entry: AgentTimelineEntry): boolean {
  return entry.kind === "PermissionRequest" ||
    entry.kind === "permission_request" ||
    entry.kind === "permission.requested" ||
    entry.kind === "permission_requested";
}

function isTerminalWorkerStatus(status: WorkerRun["status"] | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "timed_out" || status === "invalid_output";
}

function mergeReadyNotification(runId: string, mergeReadiness: MergeReadiness, now: Date): LoopNotification {
  return {
    id: `mergeready:${runId}`,
    severity: "confirmation_required",
    title: "merge_ready",
    reason: "Merge readiness evidence is complete under the configured policy.",
    source: "merge",
    sourceId: runId,
    createdAt: now.toISOString(),
    payload: redactPayload({ state: mergeReadiness.state, evidence: mergeReadiness.evidence })
  };
}

function currentRunId(workers: WorkerRun[] | undefined): string | undefined {
  return workers?.[0]?.runId;
}

function isLongRunningCommand(entry: AgentTimelineEntry, now: Date): boolean {
  if (entry.status && entry.status !== "started" && entry.status !== "running") {
    return false;
  }
  const summary = parseSummary(entry.summary);
  const startedAt = typeof summary?.startedAt === "string" ? summary.startedAt : entry.createdAt;
  const startedMs = Date.parse(startedAt);
  return !Number.isNaN(startedMs) && now.getTime() - startedMs > 60_000;
}

function parseSummary(summary: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(summary) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function timelineItemId(entry: AgentTimelineEntry): string {
  const summary = parseSummary(entry.summary);
  return typeof summary?.id === "string" && summary.id.length > 0 ? summary.id : entry.rawRef.id;
}

function redactPayload(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactPayload);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, nested]) => [
    key,
    /token|api_key|authorization|password|secret/i.test(key) ? "[redacted]" : redactPayload(nested)
  ]));
}

function severityForGate(kind: string): NotificationSeverity {
  if (kind === "merge_requires_confirmation") return "confirmation_required";
  if (kind.includes("timeout") || kind.includes("policy") || kind.includes("unavailable")) return "blocked";
  if (kind.includes("ci") || kind.includes("review") || kind.includes("github")) return "attention";
  return "blocked";
}

function severityForEvent(kind: string): NotificationSeverity | undefined {
  if (kind.includes("merge_completed") || kind.includes("pr_merged")) return "informational";
  if (kind.includes("ci_failed") || kind.includes("review_arrived")) return "attention";
  if (kind.includes("worker") && (kind.includes("failed") || kind.includes("invalid"))) return "attention";
  if (kind.includes("loop_stopped")) return "informational";
  return undefined;
}

function isVisibleForMode(mode: AgentLoopConfig["notifyMode"], severity: NotificationSeverity): boolean {
  if (mode === "blockers_only") {
    return severity === "blocked" || severity === "confirmation_required";
  }
  if (mode === "important_only") {
    return severity !== "informational";
  }
  return true;
}

function reasonForGate(kind: string): string {
  if (kind === "merge_requires_confirmation") {
    return "Policy requires an explicit confirmation before the loop can continue.";
  }
  if (kind.includes("ci")) return "CI evidence is missing, pending, or failed.";
  if (kind.includes("review")) return "Review evidence needs attention before autonomous progress.";
  if (kind.includes("policy")) return "A policy guard blocked unsafe progress.";
  return "The loop cannot safely continue until this gate is resolved.";
}

function reasonForEvent(kind: string, severity: NotificationSeverity): string {
  if (severity === "informational") {
    return "Progress was recorded without requiring operator attention.";
  }
  if (kind.includes("worker")) return "A worker output or execution issue needs attention.";
  if (kind.includes("ci")) return "CI changed in a way that may affect loop progress.";
  return "This event may require operator attention under the current policy.";
}
