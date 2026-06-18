import { createHash } from "node:crypto";
import { isRecord, statePath } from "./config.js";
import { hookEventKind, type CodexHookEvent } from "./hook-events.js";
import { resolveHookRoute } from "./hook-router.js";
import { redactSecrets } from "./redaction.js";
import { SqliteAgentLoopStorage } from "./storage.js";

export interface ObserveHookResult {
  continue: true;
  observed: boolean;
  error?: string;
}

/** Persist a lightweight observe-only Codex hook event without affecting tool execution. */
export function observeCodexHook(event: CodexHookEvent, payload: unknown, repoRoot?: string): ObserveHookResult {
  try {
    const route = resolveHookRoute(payload, { legacyRepoRoot: repoRoot });
    if (route.status === "no_match") {
      return { continue: true, observed: false };
    }
    if (route.status === "ambiguous") {
      return { continue: true, observed: false, error: route.reason };
    }
    if (route.status === "route_error") {
      return { continue: true, observed: false, error: route.reason };
    }
    const storage = new SqliteAgentLoopStorage(statePath(route.binding.repoRoot));
    try {
      const run = route.binding.runId ? storage.listRuns(200).find((item) => item.id === route.binding.runId) : storage.getCurrentRun();
      storage.appendEvent({
        ...(run ? { runId: run.id } : {}),
        kind: hookEventKind(event),
        message: `Codex ${event} hook observed.`,
        payload: {
          ...normalizeHookPayload(event, payload),
          hookRouting: route.legacy ? "legacy" : "binding",
          worktreeRoot: route.context.worktreeRoot
        }
      });
    } finally {
      storage.close();
    }
    return { continue: true, observed: true };
  } catch (error) {
    return { continue: true, observed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeHookPayload(event: CodexHookEvent, payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload ?? {});
  const base = {
    event,
    payloadLength: text.length,
    payloadSha256: createHash("sha256").update(text).digest("hex")
  };
  if (event === "UserPromptSubmit" || event === "PermissionRequest") {
    return { ...base, redacted: true };
  }
  if (!isRecord(payload)) {
    return base;
  }
  return {
    ...base,
    redacted: true,
    toolName: stringValue(payload.tool_name) ?? stringValue(payload.toolName) ?? stringValue(payload.tool),
    matcher: stringValue(payload.matcher),
    sessionIdHash: hashOptional(stringValue(payload.session_id) ?? stringValue(payload.sessionId)),
    command: summarizeCommand(payload)
  };
}

function summarizeCommand(payload: Record<string, unknown>): string | undefined {
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : payload;
  const command = stringValue(toolInput.command) ?? stringValue(toolInput.cmd) ?? stringValue(toolInput.input);
  return command ? redactSecrets(command.slice(0, 500)) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hashOptional(value: string | undefined): string | undefined {
  return value ? createHash("sha256").update(value).digest("hex") : undefined;
}
