import { existsSync } from "node:fs";
import { statePath } from "./config.js";
import { codexHomePath, listHookBindings, type HookBinding } from "./hook-router.js";
import { SqliteAgentLoopStorage } from "./storage.js";

export type HookCaptureStatus = "captured" | "not_seen" | "stale" | "ambiguous" | "unavailable";

export interface HookCaptureReport {
  status: HookCaptureStatus;
  reason: string;
  currentRepoBindings?: number;
  sessionScopedBindings?: number;
  activeBindings?: number;
  lastSeenAt?: string;
  latestHookEventAt?: string;
  latestHookEventKind?: string;
  runId?: string;
}

const RECENT_CAPTURE_MS = 5 * 60 * 1000;

export function inspectHookCapture(repoRoot: string, codexHome = codexHomePath()): HookCaptureReport {
  let bindings: HookBinding[];
  try {
    bindings = listHookBindings(codexHome);
  } catch (error) {
    return unavailable(`Hook binding registry could not be read: ${errorMessage(error)}`);
  }
  const active = bindings.filter((binding) => binding.status === "active");
  const current = active.filter((binding) => binding.repoRoot === repoRoot);
  if (current.length === 0) {
    return {
      status: "unavailable",
      reason: "No active hook binding exists for this repo.",
      currentRepoBindings: 0,
      sessionScopedBindings: 0,
      activeBindings: active.length
    };
  }
  if (current.length > 1) {
    return {
      status: "ambiguous",
      reason: "Multiple active hook bindings exist for this repo.",
      currentRepoBindings: current.length,
      sessionScopedBindings: current.filter((binding) => binding.sessionIdHash).length,
      activeBindings: active.length
    };
  }
  const binding = current[0]!;
  const hookEvent = latestHookEvent(repoRoot, binding.runId);
  const hookEventRecent = hookEvent ? Date.now() - Date.parse(hookEvent.createdAt) <= RECENT_CAPTURE_MS : false;
  const base = {
    currentRepoBindings: current.length,
    sessionScopedBindings: current.filter((item) => item.sessionIdHash).length,
    activeBindings: active.length,
    ...(binding.lastSeenAt ? { lastSeenAt: binding.lastSeenAt } : {}),
    ...(hookEvent ? { latestHookEventAt: hookEvent.createdAt, latestHookEventKind: hookEvent.kind } : {}),
    ...(binding.runId ? { runId: binding.runId } : {})
  };
  if (hookEventRecent) {
    return {
      status: "captured",
      reason: "Recent hook event was captured for this repo.",
      ...base
    };
  }
  if (hookEvent) {
    return {
      status: "stale",
      reason: "Hook events were captured before, but not recently.",
      ...base
    };
  }
  if (binding.lastSeenAt) {
    return {
      status: "not_seen",
      reason: "Hook routing matched this repo, but no hook event has been captured.",
      ...base
    };
  }
  return {
    status: "not_seen",
    reason: "Hook router is installed, but this repo binding has not observed the current Codex session.",
    ...base
  };
}

function latestHookEvent(repoRoot: string, runId: string | undefined): { kind: string; createdAt: string } | undefined {
  const path = statePath(repoRoot);
  if (!existsSync(path)) return undefined;
  const storage = new SqliteAgentLoopStorage(path, { mode: "ro" });
  try {
    return storage
      .listEvents(1000)
      .filter((event) => event.kind.startsWith("hook_") && (!runId || event.runId === runId))
      .map((event) => ({ kind: event.kind, createdAt: event.createdAt }))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  } finally {
    storage.close();
  }
}

function unavailable(reason: string): HookCaptureReport {
  return {
    status: "unavailable",
    reason,
    currentRepoBindings: 0,
    sessionScopedBindings: 0,
    activeBindings: 0
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
