import type { JSX } from "react";
import type { EffectiveLocale } from "../../../core/locale.js";
import { t } from "../i18n.js";

/** Render a localized risk badge for human-readable dashboard status. */
export function RiskBadge({ risk, locale = "en-US" }: { risk: "low" | "medium" | "high"; locale?: EffectiveLocale }): JSX.Element {
  const tone = risk === "high" ? "red" : risk === "medium" ? "yellow" : "green";
  const labelKey = risk === "high" ? "riskHigh" : risk === "medium" ? "riskMedium" : "riskLow";
  return <span className={`status-badge status-badge--${tone}`}>{t(locale, labelKey)}</span>;
}
