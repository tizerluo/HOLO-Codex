import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { AgentTimelineEntry, DashboardApi } from "../../api.js";
import { ErrorState } from "../../components/ErrorState.js";
import { t } from "../../i18n.js";
import {
  TimelineEntries,
  filterTimelinePreset,
  timelinePresets,
  type EffectiveLocale,
  type TimelinePreset
} from "../CommandCenterParts.js";

export function AgentTimelineView({ api, runId, locale }: { api: DashboardApi; runId?: string; locale: EffectiveLocale }): JSX.Element {
  const [entries, setEntries] = useState<AgentTimelineEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [preset, setPreset] = useState<TimelinePreset>("all");
  const load = async (nextCursor?: string): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const activePreset = timelinePresets.find((item) => item.id === preset);
      const result = await api.agentTimeline({
        limit: 50,
        ...(runId ? { runId } : {}),
        ...(activePreset?.sources ? { sources: activePreset.sources } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {})
      });
      if (!result.ok || !result.data) {
        setError(result.error?.message ?? t(locale, "timelineLoadError"));
        return;
      }
      const filtered = filterTimelinePreset(result.data.entries, preset);
      setEntries((current) => nextCursor ? [...current, ...filtered] : filtered);
      setCursor(result.data.nextCursor);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setEntries([]);
    setCursor(undefined);
    void load();
  }, [api, locale, preset, runId]);
  if (error) return <ErrorState title={t(locale, "timelineUnavailable")} message={error} />;
  return (
    <div className="two-stack">
      <section className="focus-panel observability-console">
        <div>
          <p className="eyebrow">{t(locale, "observabilityConsole")}</p>
          <h2>{t(locale, "observabilityTitle")}</h2>
          <p>{t(locale, "observabilityMessage")}</p>
        </div>
        <div className="preset-tabs" role="tablist" aria-label={t(locale, "timelinePresets")}>
          {timelinePresets.map((item) => (
            <button
              key={item.id}
              className={item.id === preset ? "ghost-button is-active" : "ghost-button"}
              type="button"
              onClick={() => setPreset(item.id)}
            >
              {t(locale, item.labelKey)}
            </button>
          ))}
        </div>
      </section>
      <TimelineEntries entries={entries} locale={locale} />
      {cursor ? <button className="ghost-button" type="button" disabled={loading} onClick={() => void load(cursor)}>{loading ? t(locale, "actionReading") : t(locale, "actionLoadMore")}</button> : null}
    </div>
  );
}
