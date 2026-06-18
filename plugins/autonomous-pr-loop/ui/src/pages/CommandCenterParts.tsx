import type { JSX } from "react";
import { useState } from "react";
import type {
  AgentTimelineEntry,
  DashboardApi,
  DryRunPreviewData,
  LoopNotification,
  MissionControlData,
  PlanItem,
  PlanNavigatorData,
  PrSelectionData,
  WorkerSummary
} from "../api.js";
import { EmptyState } from "../components/EmptyState.js";
import { StatusBadge, toneForStatus, type StatusTone } from "../components/StatusBadge.js";
import { List } from "../components/List.js";
import { MetricRow } from "../components/MetricRow.js";
import { ResponsiveTable } from "../components/ResponsiveTable.js";
import { displayValueLabel, t } from "../i18n.js";
import type { EffectiveLocale } from "../../../core/locale.js";

export type { EffectiveLocale };

export interface ArtifactPreviewState {
  id: string;
  text: string;
  error?: string;
  truncated?: boolean;
}

export type TimelinePreset = "all" | "live" | "hooks" | "gates" | "artifacts";

export const timelinePresets: Array<{ id: TimelinePreset; labelKey: string; sources?: AgentTimelineEntry["source"][] }> = [
  { id: "all", labelKey: "timelinePresetAll" },
  { id: "live", labelKey: "timelinePresetLive", sources: ["worker", "worker_event"] },
  { id: "hooks", labelKey: "timelinePresetHooks", sources: ["event", "worker_event"] },
  { id: "gates", labelKey: "timelinePresetGates", sources: ["gate", "decision"] },
  { id: "artifacts", labelKey: "timelinePresetArtifacts", sources: ["artifact"] }
];

export function PlanSelectionSummary({ data, selection, locale }: { data: PlanNavigatorData | undefined; selection: PrSelectionData | undefined; locale: EffectiveLocale }): JSX.Element {
  return (
    <section className="focus-panel">
      <div>
        <p className="eyebrow">{selectionEyebrow(selection, locale)}</p>
        <h2>{selectionTitle(selection, data?.selectedNext, locale)}</h2>
        <p>{selectionDetail(selection, data?.selectedNext, data?.ambiguous ?? false, locale)}</p>
      </div>
      <StatusBadge value={selectionStatus(selection, data?.ambiguous ?? false, locale)} tone={selectionTone(selection, data?.ambiguous ?? false)} />
    </section>
  );
}

export function PlanList({ items, locale }: { items: PlanNavigatorData["candidates"]; locale: EffectiveLocale }): JSX.Element {
  return items.length === 0 ? (
    <EmptyState title={t(locale, "noPrs")} message={t(locale, "noPrsMessage")} />
  ) : (
    <div className="plan-list-table">
      <ResponsiveTable columns={[t(locale, "tablePr"), t(locale, "tableStatus"), t(locale, "title"), t(locale, "issues")]} rows={items.map((item) => ({ key: item.id, cells: [item.id, item.status, item.title, item.issueRefs.join(", ") || "-"], cardTitle: item.id, cardMeta: item.status, cardSummary: item.title }))} empty={t(locale, "noPrsEmpty")} />
    </div>
  );
}

export function NotificationList({ items, locale }: { items: LoopNotification[]; locale: EffectiveLocale }): JSX.Element {
  return items.length === 0 ? <EmptyState title={t(locale, "noNotifications")} message={t(locale, "noNotificationsMessage")} /> : <div className="notification-list">{items.map((item) => <details key={item.id} className="notification-item"><summary><span>{item.title}</span><StatusBadge value={severityLabel(locale, item.severity)} tone={toneForStatus(item.severity)} /></summary><p>{item.reason}</p><pre>{JSON.stringify(item.payload ?? {}, null, 2)}</pre></details>)}</div>;
}

export function ProfileDetails({ data, locale }: { data: MissionControlData; locale: EffectiveLocale }): JSX.Element {
  const profile = data.profile;
  if (!profile) return <EmptyState title={t(locale, "workflowUnavailable")} message={t(locale, "workflowUnavailableMessage")} />;
  return (
    <div className="two-stack compact-stack">
      <section className="summary-panel">
        <MetricRow label={t(locale, "fieldLoopShape")} value={profile.loopShape} tone="blue" />
        <MetricRow label={t(locale, "fieldWorkflowProfile")} value={profile.workflowLabel} tone="blue" />
        <MetricRow label={t(locale, "fieldRoleProfile")} value={displayValueLabel(locale, profile.roleProfile)} tone="blue" />
        <MetricRow label={t(locale, "currentRole")} value={profile.currentRole ? `${profile.currentRole.label} / ${profile.currentRole.sandbox}` : t(locale, "none")} tone={profile.currentRole ? "yellow" : "muted"} />
      </section>
      <List items={[profile.workflowDescription, profile.autonomyBoundary, profile.handoffSummary, profile.validationPosture]} locale={locale} />
      <ResponsiveTable
        columns={[t(locale, "tableState"), t(locale, "tableRole"), t(locale, "tableWorker"), t(locale, "tableSandbox")]}
        rows={profile.roleMapping.map((role) => ({ key: `${role.state}:${role.alias}`, cells: [role.state, role.label, role.workerType, role.sandbox], cardTitle: role.state, cardMeta: role.label, cardSummary: `${role.workerType} / ${role.sandbox}` }))}
        empty={t(locale, "noRoles")}
      />
    </div>
  );
}

export function WorkflowStages({ stages, locale }: { stages: NonNullable<DryRunPreviewData["workflowStages"]>; locale: EffectiveLocale }): JSX.Element {
  return <ResponsiveTable columns={[t(locale, "tableState"), t(locale, "tableRole"), t(locale, "tableWorker"), t(locale, "tableGate")]} rows={stages.map((stage) => ({ key: stage.state, cells: [stage.state, stage.roleAlias ?? "-", stage.workerType ?? "-", stage.gateExpected ? t(locale, "yes") : t(locale, "no")], cardTitle: stage.state, cardMeta: stage.roleAlias ?? stage.workerType ?? "-", cardSummary: stage.gateExpected ? t(locale, "possibleGates") : t(locale, "no") }))} empty={t(locale, "noWorkflowStages")} />;
}

export function WorkerEventDetails({ worker, api, locale }: { worker: WorkerSummary; api: DashboardApi; locale: EffectiveLocale }): JSX.Element {
  const [entries, setEntries] = useState<AgentTimelineEntry[]>();
  const [error, setError] = useState<string>();
  const load = async (): Promise<void> => {
    if (entries !== undefined || error) return;
    const result = await api.agentTimeline({ workerId: worker.id, sources: ["worker_event"], limit: 25 });
    if (!result.ok || !result.data) {
      setError(result.error?.message ?? t(locale, "timelineLoadError"));
      return;
    }
    setEntries(result.data.entries);
  };
  return (
    <details className="inline-details" onToggle={(event) => event.currentTarget.open && void load()}>
      <summary>{worker.resultArtifactId ?? worker.error ?? t(locale, "workerEvents")}</summary>
      {error ? <p>{error}</p> : <TimelineEntries entries={entries ?? []} locale={locale} compact />}
    </details>
  );
}

export function TimelineEntries({ entries, locale, compact = false }: { entries: AgentTimelineEntry[]; locale: EffectiveLocale; compact?: boolean }): JSX.Element {
  if (entries.length === 0) {
    return <EmptyState title={t(locale, "timelineEmpty")} message={t(locale, "timelineEmptyMessage")} />;
  }
  return (
    <div className={compact ? "timeline-list timeline-list--compact" : "timeline-list"}>
      {entries.map((entry) => (
        <details key={entry.cursor} className="timeline-item">
          <summary>
            <span>{formatTime(entry.occurredAt)}</span>
            <strong>{entry.title}</strong>
            <StatusBadge value={entry.source} tone={toneForStatus(entry.status ?? entry.source)} />
          </summary>
          <dl className="detail-list">
            <div><dt>{t(locale, "tableSeq")}</dt><dd>{String(entry.timelineSeq)}</dd></div>
            <div><dt>{t(locale, "timelineSource")}</dt><dd>{entry.source}</dd></div>
            <div><dt>{t(locale, "tableKind")}</dt><dd>{entry.kind}</dd></div>
            {entry.workerId ? <div><dt>{t(locale, "tableWorker")}</dt><dd>{entry.workerId}</dd></div> : null}
            {entry.threadId ? <div><dt>{t(locale, "timelineThread")}</dt><dd>{entry.threadId}</dd></div> : null}
            <div><dt>{t(locale, "tableDetails")}</dt><dd>{entry.summary || "-"}</dd></div>
          </dl>
        </details>
      ))}
    </div>
  );
}

export function TimelineSummary({ data, locale }: { data: MissionControlData; locale: EffectiveLocale }): JSX.Element {
  const summary = data.timelineSummary;
  const latest = summary?.latest;
  const lastFailure = summary?.lastFailure;
  return (
    <section className="summary-panel">
      <MetricRow label={t(locale, "timelineLatest")} value={latest ? `${latest.source}: ${latest.title}` : t(locale, "none")} tone={latest ? "blue" : "muted"} />
      <MetricRow label={t(locale, "timelineLastFailure")} value={lastFailure ? `${lastFailure.source}: ${lastFailure.title}` : t(locale, "none")} tone={lastFailure ? "red" : "green"} />
      <MetricRow label={t(locale, "timelineActiveWorker")} value={summary?.activeWorker ? `${summary.activeWorker.type} / ${summary.activeWorker.status}` : t(locale, "none")} tone={summary?.activeWorker ? "yellow" : "muted"} />
      <MetricRow label={t(locale, "timelineObservationGap")} value={summary?.hasObservationGap ? t(locale, "timelineGap") : t(locale, "timelineNoGap")} tone={summary?.hasObservationGap ? "yellow" : "green"} />
    </section>
  );
}

export function filterTimelinePreset(entries: AgentTimelineEntry[], preset: TimelinePreset): AgentTimelineEntry[] {
  if (preset !== "hooks") {
    return entries;
  }
  return entries.filter((entry) =>
    entry.kind.toLowerCase().includes("hook") ||
    entry.kind.toLowerCase().includes("permission") ||
    entry.title.toLowerCase().includes("hook") ||
    entry.title.toLowerCase().includes("permission")
  );
}

export function workflowRoleShapeSummary(data: MissionControlData, locale: EffectiveLocale): string {
  const workflow = data.profile?.workflowLabel ?? displayValueLabel(locale, "default_pr_loop");
  const role = data.profile?.currentRole?.label ?? displayValueLabel(locale, data.current.run?.currentState ?? data.current.status);
  const shape = data.profile?.loopShape ?? "pr-loop";
  return `${workflow} / ${role} / ${shape}`;
}

export function selectionCompact(selection: PrSelectionData | undefined, fallback: PlanItem | undefined, locale: EffectiveLocale): string {
  if (selection?.mode === "generic_loop") return displayValueLabel(locale, selection.workflowProfile ?? "generic-loop");
  if (selection?.mode === "ambiguous") return t(locale, "ambiguous");
  const item = selection?.item ?? fallback;
  if (!item) return t(locale, "unknown");
  return selection?.prNumber ? `${item.id} / #${selection.prNumber}` : item.id;
}

export function selectionEyebrow(selection: PrSelectionData | undefined, locale: EffectiveLocale): string {
  if (selection?.mode === "generic_loop") return t(locale, "genericLoop");
  if (selection?.mode === "current_pr") return t(locale, "currentPr");
  if (selection?.mode === "next_spec") return t(locale, "nextPr");
  return t(locale, "selectedNextPr");
}

export function selectionTitle(selection: PrSelectionData | undefined, fallback: PlanItem | undefined, locale: EffectiveLocale): string {
  if (selection?.mode === "generic_loop") return displayValueLabel(locale, selection.workflowProfile ?? "generic-loop");
  if (selection?.mode === "ambiguous") return t(locale, "noUniqueNextPr");
  const item = selection?.item ?? fallback;
  if (!item) return t(locale, "noUniqueNextPr");
  return selection?.prNumber ? `${item.title} / #${selection.prNumber}` : item.title;
}

export function selectionDetail(selection: PrSelectionData | undefined, fallback: PlanItem | undefined, ambiguous: boolean, locale: EffectiveLocale): string {
  if (selection?.mode === "generic_loop") return selection.evidence[0] ?? t(locale, "genericLoopNoPrSelection");
  if (selection?.mode === "ambiguous") return selection.reason ?? "ambiguous_next_pr";
  const item = selection?.item ?? fallback;
  const evidence = selection?.evidence[0] ?? item?.whySelected;
  const branch = selection?.branchName ? `${t(locale, "tableBranch")}: ${selection.branchName}` : undefined;
  return [branch, evidence ?? (ambiguous ? "ambiguous_next_pr" : t(locale, "noNextPrMessage"))].filter(Boolean).join(" - ");
}

export function selectionStatus(selection: PrSelectionData | undefined, ambiguous: boolean, locale: EffectiveLocale): string {
  if (selection?.mode === "generic_loop") return t(locale, "selected");
  if (selection?.mode === "current_pr") return t(locale, "current");
  if (selection?.mode === "next_spec") return t(locale, "selected");
  return ambiguous || selection?.mode === "ambiguous" ? t(locale, "ambiguous") : t(locale, "selected");
}

export function selectionTone(selection: PrSelectionData | undefined, ambiguous: boolean): StatusTone {
  if (selection?.mode === "generic_loop") return "green";
  if (selection?.mode === "current_pr") return "green";
  if (selection?.mode === "next_spec") return "blue";
  return ambiguous || selection?.mode === "ambiguous" ? "yellow" : "green";
}

export function severityLabel(locale: EffectiveLocale, severity: LoopNotification["severity"]): string {
  const keys: Record<LoopNotification["severity"], string> = {
    blocked: "severityBlocked",
    confirmation_required: "severityConfirmationRequired",
    attention: "severityAttention",
    informational: "severityInformational"
  };
  return t(locale, keys[severity]);
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function decodeBase64Preview(id: string, value: string, locale: EffectiveLocale = "en-US"): { id: string; text: string; truncated?: boolean } {
  const maxChars = 500_000;
  if (value.length > maxChars) {
    return { id, text: t(locale, "artifactLarge"), truncated: true };
  }
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return { id, text: new TextDecoder().decode(bytes) };
  } catch {
    return { id, text: t(locale, "artifactDecodeError") };
  }
}

export function RawMessageDetails({ message, locale }: { message: string; locale: EffectiveLocale }): JSX.Element {
  return (
    <details className="raw-message-details">
      <summary>{t(locale, "rawOriginalMessage")}</summary>
      <pre>{message}</pre>
    </details>
  );
}

export function summarizeRawMessage(message: string | undefined, locale: EffectiveLocale, maxLength = 160): string | undefined {
  if (!message) return undefined;
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1).trimEnd()}${t(locale, "ellipsis")}`;
}

export function workerScopeSummary(workers: WorkerSummary[], locale: EffectiveLocale): string {
  // Current-run data may arrive as either normalized activity or the legacy activityReason.
  const current = workers.filter((worker) => worker.activity === "active" || worker.activityReason === "current_run").length;
  const historical = workers.filter((worker) => worker.activity === "historical").length;
  const stale = workers.filter((worker) => worker.activityReason === "stale_worker_failure").length;
  return t(locale, "workerScopeSummary", {
    current,
    total: workers.length,
    historical,
    stale
  });
}
