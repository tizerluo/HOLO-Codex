import { Activity } from "lucide-react";
import type { JSX } from "react";
import { displayValueLabel } from "../i18n.js";
import type { EffectiveLocale } from "../../../core/locale.js";
import type { StatusTone } from "./StatusBadge.js";

export function TopMetric({ icon: Icon, label, value, tone, locale }: { icon: typeof Activity; label: string; value: string; tone: StatusTone; locale?: EffectiveLocale }): JSX.Element {
  const displayValue = locale ? displayValueLabel(locale, value) : value;
  return <div className={`top-metric top-metric--${tone}`}><Icon size={19} /><div><span>{label}</span><strong title={value}>{displayValue}</strong></div></div>;
}
