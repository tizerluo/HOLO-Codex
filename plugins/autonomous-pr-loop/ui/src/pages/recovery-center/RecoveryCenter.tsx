import type { JSX } from "react";
import { useState } from "react";
import type { DashboardResult, GateReevaluationData, GateReevaluationResult, MissionControlData } from "../../api.js";
import { ActivityBadge, activityReasonLabel } from "../../components/ActivityBadge.js";
import { Collapsible } from "../../components/Collapsible.js";
import { List } from "../../components/List.js";
import { MetricRow } from "../../components/MetricRow.js";
import { t } from "../../i18n.js";
import { RawMessageDetails, summarizeRawMessage, workerScopeSummary, type EffectiveLocale } from "../CommandCenterParts.js";

export function RecoveryCenter({
  data,
  stale,
  onRecover,
  onReevaluateGate,
  onMarkGateHandled,
  locale
}: {
  data: MissionControlData;
  stale: boolean;
  onRecover: () => void;
  onReevaluateGate: (gateId: string) => Promise<DashboardResult<GateReevaluationData>>;
  onMarkGateHandled: (gateId: string) => void;
  locale: EffectiveLocale;
}): JSX.Element {
  const run = data.current.run;
  const historicalGates = data.gates.filter((gate) => gate.activity === "historical");
  const staleWorkers = data.workers.filter((worker) => worker.activityReason === "stale_worker_failure");
  const [results, setResults] = useState<Record<string, { result?: GateReevaluationResult; error?: string }>>({});

  const reEvaluateGate = async (gateId: string): Promise<void> => {
    const response = await onReevaluateGate(gateId);
    const result = response.data?.result;
    setResults((current) => ({
      ...current,
      [gateId]: response.ok && isGateReevaluationResult(result)
        ? { result }
        : { error: response.error?.message ?? t(locale, "reevaluateUnknownError") }
    }));
  };

  return (
    <div className="two-stack">
      <section className="recovery-panel">
        <MetricRow label={t(locale, "storageRun")} value={run?.id ?? t(locale, "none")} tone={run ? "blue" : "muted"} />
        <MetricRow label={t(locale, "gitBranch")} value={run?.branch ?? t(locale, "unknown")} tone="blue" />
        <MetricRow label={t(locale, "worktree")} value={run?.worktreeClean === false ? t(locale, "dirty") : t(locale, "clean")} tone={run?.worktreeClean === false ? "red" : "green"} />
        <MetricRow label={t(locale, "freshness")} value={stale ? t(locale, "staleData") : t(locale, "fresh")} tone={stale ? "yellow" : "green"} />
      </section>
      <Collapsible title={t(locale, "recoveryWhyStopped")} chip={data.current.gate ? t(locale, "activityActive") : t(locale, "activityHistorical") } defaultOpen>
        <List items={[recoveryExplanation(data, locale)]} locale={locale} />
      </Collapsible>
      {historicalGates.length ? (
        <Collapsible title={t(locale, "historicalGates")} chip={t(locale, "gatesChip", { count: historicalGates.length })} defaultOpen>
          <div className="compact-card-list">
            {historicalGates.map((gate) => (
              <article className="compact-data-card" key={gate.id}>
                <div className="compact-data-card__head">
                  <strong>{gate.kind}</strong>
                  <ActivityBadge activity={gate.activity} reason={gate.activityReason} locale={locale} />
                </div>
                <p>{summarizeRawMessage(gate.message, locale)}</p>
                <dl>
                  <div><dt>{t(locale, "gateId")}</dt><dd>{gate.id}</dd></div>
                  <div><dt>{t(locale, "reason")}</dt><dd>{activityReasonLabel(locale, gate.activityReason)}</dd></div>
                  <div><dt>{t(locale, "tableRawMessage")}</dt><dd><RawMessageDetails message={gate.message} locale={locale} /></dd></div>
                </dl>
                {results[gate.id] ? (
                  <div className={results[gate.id]?.error ? "action-result action-result--error" : "action-result"}>
                    <strong>{t(locale, "reevaluateResultTitle")}</strong>
                    <span>{results[gate.id]?.error ?? t(locale, `reevaluateResult.${results[gate.id]?.result}`)}</span>
                  </div>
                ) : null}
                <div className="button-row">
                  <button className="ghost-button" type="button" onClick={() => void reEvaluateGate(gate.id)}>{t(locale, "actionReevaluate")}</button>
                  {gate.status === "open" ? (
                    <button className="ghost-button" type="button" onClick={() => onMarkGateHandled(gate.id)}>{t(locale, "actionMarkHandled")}</button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </Collapsible>
      ) : null}
      {staleWorkers.length ? (
        <Collapsible title={t(locale, "staleWorkerFailures")} chip={workerScopeSummary(data.workers, locale)}>
          <div className="compact-card-list compact-card-list--always">
            {staleWorkers.map((worker) => (
              <article className="compact-data-card" key={worker.id}>
                <div className="compact-data-card__head">
                  <strong>{worker.id}</strong>
                  <ActivityBadge activity={worker.activity} reason={worker.activityReason} locale={locale} />
                </div>
                <p>{summarizeRawMessage(worker.error, locale) ?? activityReasonLabel(locale, worker.activityReason)}</p>
                {worker.error ? <RawMessageDetails message={worker.error} locale={locale} /> : null}
              </article>
            ))}
          </div>
        </Collapsible>
      ) : null}
      {data.recoveryWarnings?.length ? <Collapsible title={t(locale, "recoveryWarnings")} chip={t(locale, "warningsChip", { count: data.recoveryWarnings.length })} defaultOpen><List items={data.recoveryWarnings} locale={locale} /></Collapsible> : null}
      <button className="ghost-button" type="button" onClick={onRecover}>{t(locale, "actionRunRecovery")}</button>
    </div>
  );
}

function recoveryExplanation(data: MissionControlData, locale: EffectiveLocale): string {
  if (data.current.gate) {
    return t(locale, "recoveryExplanationActive", { gate: data.current.gate.kind });
  }
  if (data.gates.some((gate) => gate.activity === "historical")) {
    return t(locale, "recoveryExplanationHistorical");
  }
  if (data.current.status === "STOPPED") {
    return t(locale, "recoveryExplanationStopped");
  }
  return t(locale, "recoveryExplanationClear");
}

function isGateReevaluationResult(value: unknown): value is GateReevaluationResult {
  return value === "still_historical" ||
    value === "overridden_by_current_reality" ||
    value === "active_again" ||
    value === "manually_handled";
}
