import type { AgentLoopCiCheck, AgentLoopConfig, AgentLoopGateKind } from "./types.js";
import { isRecord } from "./config.js";

export type CiState = "green" | "failed" | "pending" | "missing";

export interface CiEvaluation {
  state: CiState;
  gate?: AgentLoopGateKind;
  checks: Array<Omit<AgentLoopCiCheck, "id" | "runId" | "prNumber" | "observedAt">>;
  missingRequiredChecks: string[];
}

/** Normalize GitHub statusCheckRollup entries and evaluate required checks. */
export function evaluateCiChecks(config: AgentLoopConfig, rollup: unknown[]): CiEvaluation {
  const checks = latestByName(rollup.map(normalizeCheck).filter((check) => check.name.length > 0));
  if (config.requiredChecks.length === 0) {
    return evaluateObservedChecks(checks);
  }
  const byName = new Map(checks.map((check) => [check.name, check]));
  const missingRequiredChecks = config.requiredChecks.filter((name) => !byName.has(name));
  if (missingRequiredChecks.length > 0) {
    return {
      state: "missing",
      gate: "ci_required_checks_missing",
      checks,
      missingRequiredChecks
    };
  }
  const required = config.requiredChecks.map((name) => byName.get(name)).filter(isDefined);
  if (required.some((check) => isFailure(check.conclusion))) {
    return { state: "failed", checks, missingRequiredChecks: [] };
  }
  if (required.some((check) => !isSuccess(check.conclusion) || check.status.toLowerCase() !== "completed")) {
    return { state: "pending", checks, missingRequiredChecks: [] };
  }
  return { state: "green", checks, missingRequiredChecks: [] };
}

function evaluateObservedChecks(
  checks: Array<Omit<AgentLoopCiCheck, "id" | "runId" | "prNumber" | "observedAt">>
): CiEvaluation {
  if (checks.length === 0) {
    return {
      state: "missing",
      gate: "ci_required_checks_missing",
      checks,
      missingRequiredChecks: []
    };
  }
  if (checks.some((check) => isFailure(check.conclusion))) {
    return { state: "failed", checks, missingRequiredChecks: [] };
  }
  if (checks.some((check) => !isSuccess(check.conclusion) || check.status.toLowerCase() !== "completed")) {
    return { state: "pending", checks, missingRequiredChecks: [] };
  }
  return { state: "green", checks, missingRequiredChecks: [] };
}

function normalizeCheck(value: unknown): Omit<AgentLoopCiCheck, "id" | "runId" | "prNumber" | "observedAt"> {
  if (!isRecord(value)) {
    return { name: "", status: "unknown" };
  }
  const name = stringValue(value.name) || stringValue(value.context) || stringValue(value.workflowName);
  const state = stringValue(value.state);
  return {
    name,
    status: stringValue(value.status) || statusFromState(state),
    ...(stringValue(value.conclusion) || conclusionFromState(state)
      ? { conclusion: stringValue(value.conclusion) || conclusionFromState(state) }
      : {}),
    ...(stringValue(value.url) || stringValue(value.detailsUrl)
      ? { url: stringValue(value.url) || stringValue(value.detailsUrl) }
      : {}),
    ...(stringValue(value.startedAt) ? { startedAt: stringValue(value.startedAt) } : {}),
    ...(stringValue(value.completedAt) ? { completedAt: stringValue(value.completedAt) } : {})
  };
}

function statusFromState(state: string): string {
  const normalized = state.toLowerCase();
  if (["success", "failure", "failed", "error", "cancelled", "skipped"].includes(normalized)) {
    return "COMPLETED";
  }
  if (["pending", "queued", "in_progress", "requested", "waiting"].includes(normalized)) {
    return "IN_PROGRESS";
  }
  return "unknown";
}

function conclusionFromState(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === "success") return "SUCCESS";
  if (normalized === "failure" || normalized === "failed" || normalized === "error") return "FAILURE";
  if (normalized === "cancelled") return "CANCELLED";
  if (normalized === "skipped") return "SKIPPED";
  return "";
}

function latestByName(
  checks: Array<Omit<AgentLoopCiCheck, "id" | "runId" | "prNumber" | "observedAt">>
): Array<Omit<AgentLoopCiCheck, "id" | "runId" | "prNumber" | "observedAt">> {
  const byName = new Map<string, Omit<AgentLoopCiCheck, "id" | "runId" | "prNumber" | "observedAt">>();
  for (const check of checks) {
    const previous = byName.get(check.name);
    if (!previous || timestamp(check) >= timestamp(previous)) {
      byName.set(check.name, check);
    }
  }
  return [...byName.values()];
}

function timestamp(check: { completedAt?: string; startedAt?: string }): number {
  return Date.parse(check.completedAt ?? check.startedAt ?? "") || 0;
}

function isSuccess(value: string | undefined): boolean {
  return value?.toLowerCase() === "success";
}

function isFailure(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized === "failure" || normalized === "failed" || normalized === "timed_out";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
