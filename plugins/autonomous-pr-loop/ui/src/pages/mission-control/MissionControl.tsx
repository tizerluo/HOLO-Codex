import type { JSX } from "react";
import type { DashboardApi, MissionControlData, WorkflowDrillDownTarget } from "../../api.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { Collapsible } from "../../components/Collapsible.js";
import { List } from "../../components/List.js";
import { MetricRow } from "../../components/MetricRow.js";
import { displayValueLabel, t } from "../../i18n.js";
import {
  PlanSelectionSummary,
  ProfileDetails,
  TimelineSummary,
  selectionCompact,
  workerScopeSummary,
  workflowRoleShapeSummary,
  type EffectiveLocale
} from "../CommandCenterParts.js";
import { EventLedger } from "../event-ledger/EventLedger.js";
import { WorkerRuns } from "../worker-runs/WorkerRuns.js";
import { WorkflowBoardView } from "./WorkflowBoard.js";

export function MissionControl({
  data,
  api,
  stale,
  locale,
  onNavigate
}: {
  data: MissionControlData;
  api: DashboardApi;
  stale: boolean;
  locale: EffectiveLocale;
  onNavigate?: (page: WorkflowDrillDownTarget["page"]) => void;
}): JSX.Element {
  const historicalGates = data.gates.filter((gate) => gate.activity === "historical");
  const workflowRefreshKey = [
    data.current.run?.id ?? "no-run",
    data.current.run?.status ?? data.current.status,
    data.current.run?.currentState ?? "no-state",
    data.current.run?.updatedAt ?? "no-update",
    data.events[0]?.id ?? "no-event",
    data.decisions?.[0]?.id ?? "no-decision"
  ].join(":");
  return (
    <div className="mission-grid">
      <section className="summary-panel summary-panel--mission">
        <MetricRow label={t(locale, "metricNextAction")} value={data.current.nextAction} tone="yellow" />
        <MetricRow label={t(locale, "metricAutonomyBoundary")} value={displayValueLabel(locale, data.autonomy?.autonomyMode ?? "autonomous_until_gate")} tone="blue" />
        <MetricRow label={t(locale, "metricAttention")} value={t(locale, "metricItems", { count: data.notifications?.filter((item) => item.severity !== "informational").length ?? 0 })} tone="yellow" />
        <MetricRow
          label={data.profile?.loopShape === "generic-loop" ? t(locale, "deliverableReadiness") : t(locale, "metricMergeReadiness")}
          value={data.profile?.loopShape === "generic-loop" ? displayValueLabel(locale, data.profile.expectedDeliverable ?? data.profile.loopShape) : displayValueLabel(locale, data.mergeReadiness?.state ?? "manual")}
          tone={data.profile?.loopShape === "generic-loop" || data.mergeReadiness?.ready ? "green" : "yellow"}
        />
        <MetricRow label={t(locale, "metricWorkflow")} value={workflowRoleShapeSummary(data, locale)} tone="blue" />
      </section>
      <WorkflowBoardView
        api={api}
        runId={data.current.run?.id}
        refreshKey={workflowRefreshKey}
        locale={locale}
        onEvidenceAppended={() => undefined}
        {...(onNavigate ? { onNavigate } : {})}
      />
      <section className="focus-panel">
        <div>
          <p className="eyebrow">{t(locale, "autonomyPosture")}</p>
          <h2>{data.autonomy?.summary ?? t(locale, "autonomyFallback")}</h2>
        </div>
        <StatusBadge value={stale ? t(locale, "stale") : t(locale, "live")} tone={stale ? "yellow" : "green"} />
      </section>
      <Collapsible title={t(locale, "policyDetails")} chip={t(locale, "notifyRules", { count: data.autonomy?.notifyWhen.length ?? 0 })}>
        <List items={[...(data.autonomy?.notifyWhen ?? []), ...(data.autonomy?.requiresConfirmation ?? [])]} locale={locale} />
      </Collapsible>
      <Collapsible title={t(locale, "workflowProfile")} chip={data.profile?.loopShape ?? "pr-loop"}>
        <ProfileDetails data={data} locale={locale} />
      </Collapsible>
      <Collapsible title={t(locale, "selectedNextPr")} chip={selectionCompact(data.selection, data.plan?.selectedNext, locale)}>
        <PlanSelectionSummary data={data.plan} selection={data.selection} locale={locale} />
      </Collapsible>
      {data.profile?.loopShape === "generic-loop" ? null : (
        <Collapsible title={t(locale, "mergeEvidence")} chip={data.mergeReadiness?.ready ? t(locale, "allEvidenceReady") : t(locale, "missingCount", { count: data.mergeReadiness?.missingConditions.length ?? 0 })}>
          <List items={[...(data.mergeReadiness?.evidence ?? []), ...(data.mergeReadiness?.missingConditions ?? [])]} locale={locale} />
        </Collapsible>
      )}
      {historicalGates.length ? (
        <Collapsible title={t(locale, "historicalGates")} chip={t(locale, "gatesChip", { count: historicalGates.length })}>
          <List items={historicalGates.map((gate) => `${gate.kind}: ${gate.message}`)} locale={locale} />
        </Collapsible>
      ) : null}
      <Collapsible title={t(locale, "timelineLatest")} chip={data.timelineSummary?.hasObservationGap ? t(locale, "timelineGap") : t(locale, "timelineNoGap")}>
        <TimelineSummary data={data} locale={locale} />
      </Collapsible>
      <Collapsible title={t(locale, "workerRunsRepoScope")} chip={workerScopeSummary(data.workers, locale)}>
        <>
          <p className="scope-note">{t(locale, "workerScopePreview", { shown: Math.min(data.workers.length, 5), total: data.workers.length })}</p>
          <WorkerRuns workers={data.workers.slice(0, 5)} api={api} locale={locale} hideScopeNote />
        </>
      </Collapsible>
      <Collapsible title={t(locale, "pageEvents")} chip={t(locale, "metricItems", { count: data.events.length })}>
        <EventLedger events={data.events.slice(0, 8)} locale={locale} />
      </Collapsible>
    </div>
  );
}
