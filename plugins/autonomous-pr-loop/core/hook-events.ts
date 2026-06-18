export const CODEX_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "PreCompact",
  "PostCompact",
  "PermissionRequest"
] as const;

export type CodexHookEvent = typeof CODEX_HOOK_EVENTS[number];

export const OBSERVE_ONLY_HOOK_EVENTS = CODEX_HOOK_EVENTS.filter((event) => event !== "PreToolUse") as Exclude<CodexHookEvent, "PreToolUse">[];

export function hookScriptName(event: CodexHookEvent): string {
  return `${event.replaceAll(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}.js`;
}

export function hookEventKind(event: CodexHookEvent): string {
  return `hook_${event.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}`;
}
