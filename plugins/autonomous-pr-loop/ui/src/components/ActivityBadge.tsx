import type { JSX } from "react";
import type { ActivityState } from "../api.js";
import { displayValueLabel, t } from "../i18n.js";
import type { EffectiveLocale } from "../pages/CommandCenterParts.js";
import { StatusBadge } from "./StatusBadge.js";

export function ActivityBadge({ activity, reason, locale }: { activity: ActivityState | undefined; reason: string | undefined; locale: EffectiveLocale }): JSX.Element {
  if (reason === "stale_worker_failure") {
    return <StatusBadge value={t(locale, "activityStaleWorker")} tone="red" />;
  }
  if (reason === "overridden_by_reality") {
    return <StatusBadge value={t(locale, "activityOverridden")} tone="blue" />;
  }
  if (reason === "marked_handled") {
    return <StatusBadge value={t(locale, "activityMarkedHandled")} tone="muted" />;
  }
  if (activity === "active") {
    return <StatusBadge value={t(locale, "activityActive")} tone="green" />;
  }
  if (activity === "historical") {
    return <StatusBadge value={t(locale, "activityHistorical")} tone="yellow" />;
  }
  return <StatusBadge value={displayValueLabel(locale, "unknown")} tone="muted" />;
}

export function activityReasonLabel(locale: EffectiveLocale, reason: string | undefined): string {
  if (!reason) return t(locale, "unknown");
  const key = `activityReason.${reason}`;
  const label = t(locale, key);
  return label === key ? displayValueLabel(locale, reason) : label;
}
