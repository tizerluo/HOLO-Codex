import type { JSX } from "react";
import type { DashboardApi, WorkerSummary } from "../../api.js";
import { ActivityBadge, activityReasonLabel } from "../../components/ActivityBadge.js";
import { ResponsiveTable } from "../../components/ResponsiveTable.js";
import { StatusBadge, toneForStatus } from "../../components/StatusBadge.js";
import { displayValueLabel, t } from "../../i18n.js";
import { RawMessageDetails, WorkerEventDetails, formatTime, summarizeRawMessage, workerScopeSummary, type EffectiveLocale } from "../CommandCenterParts.js";

export function WorkerRuns({ workers, api, locale, scopeNote, hideScopeNote = false }: { workers: WorkerSummary[]; api: DashboardApi; locale: EffectiveLocale; scopeNote?: string; hideScopeNote?: boolean }): JSX.Element {
  return (
    <div className="two-stack">
      {hideScopeNote ? null : <p className="scope-note">{scopeNote ?? workerScopeSummary(workers, locale)}</p>}
      <ResponsiveTable
        columns={[t(locale, "tableWorker"), t(locale, "tableActivity"), t(locale, "tableRole"), t(locale, "tableStatus"), t(locale, "tableStarted"), t(locale, "tableRawResultError")]}
        rows={workers.map((worker) => {
          const { error, ...workerForEvents } = worker;
          return {
            key: worker.id,
            cells: [
              worker.id.slice(0, 8),
              <ActivityBadge key={`${worker.id}-activity`} activity={worker.activity} reason={worker.activityReason} locale={locale} />,
              worker.type,
              <StatusBadge key={worker.id} value={displayValueLabel(locale, worker.status)} tone={toneForStatus(worker.status)} />,
              formatTime(worker.startedAt),
              <>
                {error ? <RawMessageDetails message={error} locale={locale} /> : null}
                <WorkerEventDetails worker={workerForEvents} api={api} locale={locale} />
              </>
            ],
            cardTitle: `${worker.type} / ${worker.status}`,
            cardMeta: `${worker.id} / ${activityReasonLabel(locale, worker.activityReason)} / ${formatTime(worker.startedAt)}`,
            cardSummary: summarizeRawMessage(error, locale) ?? worker.resultArtifactId ?? t(locale, "workerEvents")
          };
        })}
        empty={t(locale, "noWorkerRuns")}
      />
    </div>
  );
}
