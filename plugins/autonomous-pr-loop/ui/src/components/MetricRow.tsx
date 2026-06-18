import type { JSX } from "react";
import type { StatusTone } from "./StatusBadge.js";

export function MetricRow({ label, value, tone }: { label: string; value: string; tone: StatusTone }): JSX.Element {
  return <div className={`metric-row metric-row--${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}
