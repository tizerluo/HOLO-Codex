import { join } from "node:path";
import { CODEX_HOOK_EVENTS, hookScriptName, type CodexHookEvent } from "./hook-events.js";
import { defaultPackageRoot, hookDistRoot } from "./plugin-paths.js";

/** Return the installed command used by Codex to invoke one agent-loop hook. */
export function agentLoopHookCommand(repoRoot: string, event: CodexHookEvent, packageRoot = defaultPackageRoot()): string {
  return `AGENT_LOOP_REPO_ROOT=${shellQuote(repoRoot)} node ${shellQuote(join(hookDistRoot(packageRoot), hookScriptName(event)))}`;
}

/** Return the installed router command used by Codex to invoke one agent-loop hook. */
export function agentLoopRouterHookCommand(event: CodexHookEvent, packageRoot = defaultPackageRoot()): string {
  return `node ${shellQuote(join(hookDistRoot(packageRoot), hookScriptName(event)))}`;
}

/** Return the legacy per-repo Codex hook entries installed before router isolation. */
export function agentLoopHookEntries(repoRoot: string, packageRoot = defaultPackageRoot()): Record<string, unknown[]> {
  return Object.fromEntries(CODEX_HOOK_EVENTS.map((event) => [
    event,
    [{
      matcher: "*",
      hooks: [{
        type: "command",
        command: agentLoopHookCommand(repoRoot, event, packageRoot),
        timeout: event === "PreToolUse" ? 1000 : 500,
        statusMessage: hookStatusMessage(event)
      }]
    }]
  ]));
}

/** Return canonical router entries for `hooks.json` under the root `hooks` key. */
export function agentLoopRouterHookEntries(packageRoot = defaultPackageRoot()): Record<string, unknown[]> {
  return Object.fromEntries(CODEX_HOOK_EVENTS.map((event) => [
    event,
    [{
      matcher: "*",
      hooks: [{
        type: "command",
        command: agentLoopRouterHookCommand(event, packageRoot),
        timeout: event === "PreToolUse" ? 1000 : 500,
        statusMessage: hookStatusMessage(event)
      }]
    }]
  ]));
}

/** True for agent-loop hook commands managed by this plugin. */
export function isAgentLoopHookCommand(command: string): boolean {
  return command.includes("autonomous-pr-loop/hooks/dist/") && CODEX_HOOK_EVENTS.some((event) => command.includes(hookScriptName(event)));
}

/** True for old per-repo agent-loop hook commands that used `AGENT_LOOP_REPO_ROOT`. */
export function isLegacyAgentLoopHookCommand(command: string): boolean {
  return isAgentLoopHookCommand(command) && command.includes("AGENT_LOOP_REPO_ROOT=");
}

/** Recursively collect command hook strings from supported Codex hooks config shapes. */
export function collectHookCommands(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectHookCommands);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const direct = Array.isArray(record.hooks)
    ? record.hooks.flatMap((hook) => typeof hook === "object" && hook !== null && typeof (hook as { command?: unknown }).command === "string"
      ? [(hook as { command: string }).command]
      : [])
    : [];
  return [
    ...direct,
    ...Object.values(record).flatMap(collectHookCommands)
  ];
}

function hookStatusMessage(event: CodexHookEvent): string {
  return event === "PreToolUse"
    ? "Checking agent-loop command policy"
    : `Recording agent-loop ${event} event`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
