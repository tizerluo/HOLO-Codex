import type { JSX } from "react";

export type StatusTone = "green" | "yellow" | "red" | "blue" | "muted";

interface StatusBadgeProps {
  value: string;
  tone?: StatusTone;
}

export function StatusBadge({ value, tone = "muted" }: StatusBadgeProps): JSX.Element {
  return <span className={`status-badge status-badge--${tone}`}>{value}</span>;
}

export function toneForStatus(value: string | undefined): StatusTone {
  const normalized = value?.toLowerCase() ?? "";
  if (["running", "ready", "green", "passed", "succeeded", "clean", "approved", "open"].includes(normalized)) {
    return "green";
  }
  if (["blocked", "pending", "stopped", "waiting", "draft"].includes(normalized)) {
    return "yellow";
  }
  if (["failed", "error", "rejected", "timed_out", "invalid_output"].includes(normalized)) {
    return "red";
  }
  if (["idle", "needs_repo_init"].includes(normalized)) {
    return "blue";
  }
  return "muted";
}
