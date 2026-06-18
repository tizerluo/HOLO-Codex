import { readFileSync } from "node:fs";
import { observeCodexHook } from "../core/hook-observer.js";
import type { CodexHookEvent } from "../core/hook-events.js";

export function runObserveOnlyHook(event: CodexHookEvent): void {
  const input = readStdinJson();
  const repoRoot = process.env.AGENT_LOOP_REPO_ROOT;
  const result = observeCodexHook(event, input, repoRoot);
  if (result.error) {
    process.stderr.write(`agent-loop ${event} observe failed: ${result.error}\n`);
  }
  process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
}

function readStdinJson(): unknown {
  const text = readFileSync(0, "utf8");
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { rawLength: text.length };
  }
}
