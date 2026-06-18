import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { DashboardApi, DryRunPreviewData } from "../../api.js";
import { CommandPreview } from "../../components/CommandPreview.js";
import { Collapsible } from "../../components/Collapsible.js";
import { EmptyState } from "../../components/EmptyState.js";
import { ErrorState } from "../../components/ErrorState.js";
import { List } from "../../components/List.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { displayValueLabel, t } from "../../i18n.js";
import {
  WorkflowStages,
  selectionDetail,
  selectionEyebrow,
  selectionStatus,
  selectionTitle,
  selectionTone,
  type EffectiveLocale
} from "../CommandCenterParts.js";

export function DryRunPreview({ api, onAction, locale }: { api: DashboardApi; onAction: (path: string) => void; locale: EffectiveLocale }): JSX.Element {
  const [preview, setPreview] = useState<DryRunPreviewData>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void api.dryRunPreview().then((result) => {
      if (result.ok && result.data) setPreview(result.data);
      else setError(result.error?.message ?? t(locale, "dryRunLoadError"));
    });
  }, [api, locale]);
  if (error) return <ErrorState title={t(locale, "dryRunUnavailable")} message={error} />;
  if (!preview) return <EmptyState title={t(locale, "loadingPreview")} message={t(locale, "loadingPreviewMessage")} />;
  const mergeForecast = preview.mergeForecast;
  const forecastMessage = mergeForecast
    ? (mergeForecast.ready ? t(locale, "mergeReady") : t(locale, "mergeMissing"))
    : t(locale, "genericForecastReady");
  const forecastStatus = mergeForecast ? displayValueLabel(locale, mergeForecast.state) : displayValueLabel(locale, preview.profile?.loopShape ?? "generic-loop");
  return (
    <div className="two-stack">
      <section className="focus-panel">
        <div>
          <p className="eyebrow">{selectionEyebrow(preview.selection, locale)}</p>
          <h2>{selectionTitle(preview.selection, preview.nextPr, locale)}</h2>
          <p>{selectionDetail(preview.selection, preview.nextPr, false, locale)}</p>
        </div>
        <StatusBadge value={selectionStatus(preview.selection, false, locale)} tone={selectionTone(preview.selection, false)} />
      </section>
      <section className="focus-panel">
        <div>
          <p className="eyebrow">{t(locale, "forecastSummary")}</p>
          <h2>{preview.autonomyForecast.summary}</h2>
          <p>{forecastMessage}</p>
        </div>
        <StatusBadge value={forecastStatus} tone={mergeForecast?.ready === false ? "yellow" : "green"} />
      </section>
      <div className="button-row wide">
        <button className="success-button" type="button" onClick={() => onAction("/api/run-until-gate")}>{t(locale, "actionStartRealRun")}</button>
        <button className="ghost-button" type="button" onClick={() => onAction("/api/stop")}>{t(locale, "actionStopRun")}</button>
      </div>
      <Collapsible title={t(locale, "commandsPlanned")} chip={t(locale, "commandsChip", { count: preview.commandsPlanned.length })}><CommandPreview commands={preview.commandsPlanned} emptyMessage={t(locale, "noCommandsPlanned")} /></Collapsible>
      <Collapsible title={t(locale, "workflowStages")} chip={t(locale, "stagesChip", { count: preview.workflowStages?.length ?? 0 })}><WorkflowStages stages={preview.workflowStages ?? []} locale={locale} /></Collapsible>
      <Collapsible title={t(locale, "possibleGates")} chip={t(locale, "gatesChip", { count: preview.possibleGates.length })}><List items={preview.possibleGates} locale={locale} /></Collapsible>
      <Collapsible title={t(locale, "missingConditions")} chip={t(locale, "missingCount", { count: preview.missingConditions.length })}><List items={preview.missingConditions} locale={locale} /></Collapsible>
      <Collapsible title={t(locale, "filesLikelyTouched")} chip={t(locale, "pathsChip", { count: preview.filesLikelyTouched.length })}><List items={preview.filesLikelyTouched} locale={locale} /></Collapsible>
    </div>
  );
}
