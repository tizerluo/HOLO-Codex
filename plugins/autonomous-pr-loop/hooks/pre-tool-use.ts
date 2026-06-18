#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { evaluatePreToolUseHook, toCodexHookResponse, type HookPolicyDecision } from "../core/hook-policy.js";

const repoRoot = process.env.AGENT_LOOP_REPO_ROOT;
const input = readStdinJson();
const decision = safeEvaluate(input, repoRoot);
process.stdout.write(`${JSON.stringify(toCodexHookResponse(decision))}\n`);

function safeEvaluate(input: unknown, repoRoot: string | undefined): HookPolicyDecision {
  try {
    return evaluatePreToolUseHook(input, repoRoot);
  } catch (error) {
    return {
      allow: false,
      matchedPolicy: "hook_runner_error",
      gate: "policy_violation",
      blockedCommand: "<hook runner error>",
      nextAction: "Run `agent-loop hooks doctor` and fix hook routing before retrying.",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function readStdinJson(): unknown {
  const text = readFileSync(0, "utf8");
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const decision: HookPolicyDecision = {
      allow: false,
      matchedPolicy: "malformed_hook_payload",
      gate: "policy_violation",
      blockedCommand: "<unparseable hook payload>",
      nextAction: "Retry the tool call with a valid PreToolUse payload.",
      reason: "PreToolUse payload was not valid JSON."
    };
    process.stdout.write(`${JSON.stringify(toCodexHookResponse(decision))}\n`);
    process.exit(0);
  }
}
