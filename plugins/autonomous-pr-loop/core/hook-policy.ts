import { createHash } from "node:crypto";
import { isRecord, loadConfig, statePath } from "./config.js";
import { hookEventKind } from "./hook-events.js";
import { resolveHookRoute } from "./hook-router.js";
import { matchesProtectedPath } from "./policy.js";
import { redactSecrets } from "./redaction.js";
import { SqliteAgentLoopStorage } from "./storage.js";
import type { AgentLoopGateKind, AgentLoopStorage } from "./types.js";

export interface HookCommand {
  file: string;
  args: string[];
  raw?: string;
  rawKind?: "argv" | "shell";
}

export interface HookPolicyInput {
  repoRoot: string;
  command: HookCommand;
  isWorker?: boolean;
  protectedPaths?: string[];
  storage?: AgentLoopStorage;
  runId?: string;
}

export interface HookPolicyDecision {
  allow: boolean;
  matchedPolicy: string;
  gate?: AgentLoopGateKind;
  blockedCommand: string;
  nextAction: string;
  reason: string;
  auditDetails?: Record<string, unknown>;
}

type MaintainerOverrideScope = "publish" | "merge";

interface ActiveMaintainerOverride {
  decisionId: string;
  scope: MaintainerOverrideScope;
  expiresAt: string;
}

const REQUIRED_PUBLISH_EVIDENCE_SUBSTAGES = ["lint", "full_tests", "gitnexus_detect"] as const;

/** Normalize a Codex PreToolUse hook payload into an argv-like command. */
export function commandFromHookPayload(payload: unknown): HookCommand | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : payload;
  const file = stringValue(toolInput.file ?? toolInput.cmd ?? toolInput.executable);
  const args = Array.isArray(toolInput.args) ? toolInput.args.filter((arg): arg is string => typeof arg === "string") : undefined;
  if (file && args) {
    return { file: basename(file), args, raw: [file, ...args].join(" "), rawKind: "argv" };
  }
  const command = stringValue(toolInput.command ?? toolInput.cmd ?? toolInput.input);
  if (!command) {
    return undefined;
  }
  return tokenizeCommand(command);
}

/** Evaluate a hook command without spawning subprocesses. */
export function evaluateHookPolicy(input: HookPolicyInput): HookPolicyDecision {
  const normalized = normalizeCommand(input.command);
  const shellControl = shellControlPolicy(normalized);
  if (shellControl) {
    return deny(renderCommand(normalized), shellControl, "policy_violation", "Run one allowlisted command at a time without shell control operators.");
  }
  const command = unwrapCommand(normalized);
  const blockedCommand = renderCommand(command);
  const destructive = destructivePolicy(command);
  if (destructive) {
    return deny(blockedCommand, destructive, "policy_violation", "Stop using the destructive command and continue through agent-loop.");
  }
  const worker = input.isWorker === true ||
    process.env.AGENT_LOOP_WORKER_POLICY === "1" ||
    command.raw?.includes("AGENT_LOOP_WORKER_POLICY=1") === true;
  const workerPolicy = workerLifecyclePolicy(command);
  if (worker && workerPolicy) {
    return deny(blockedCommand, workerPolicy, "policy_violation", "Let the supervisor own commit, push, PR, and merge actions.");
  }
  const protectedPath = protectedPathPolicy(command, input.protectedPaths ?? []);
  if (protectedPath) {
    return deny(blockedCommand, protectedPath, "policy_violation", "Remove protected path changes from the command.");
  }
  const gate = gatedLifecyclePolicy(command, input.storage, input.runId);
  if (gate) {
    return deny(blockedCommand, gate.policy, gate.gate, gate.nextAction);
  }
  const override = activeMaintainerOverride(input.storage, lifecycleOverrideScope(command), input.runId);
  if (override && matchesHookAllowlist(command)) {
    return {
      allow: true,
      matchedPolicy: `maintainer_override:${override.scope}`,
      blockedCommand,
      nextAction: "Continue.",
      reason: `Maintainer override ${override.decisionId} allows ${blockedCommand} until ${override.expiresAt}.`,
      auditDetails: {
        overrideDecisionId: override.decisionId,
        overrideScope: override.scope,
        overrideExpiresAt: override.expiresAt
      }
    };
  }
  if (!matchesHookAllowlist(command)) {
    return deny(blockedCommand, "command_not_in_hook_allowlist", "policy_violation", "Use agent-loop MCP/CLI control surfaces or an allowlisted read/check command.");
  }
  return {
    allow: true,
    matchedPolicy: "allow",
    blockedCommand,
    nextAction: "Continue.",
    reason: "No hook policy matched."
  };
}

/** Run fail-safe PreToolUse policy and persist a ledger event when a command is blocked. */
export function evaluatePreToolUseHook(payload: unknown, repoRoot?: string): HookPolicyDecision {
  const command = commandFromHookPayload(payload);
  if (!command) {
    return {
      allow: true,
      matchedPolicy: "allow_unparsed",
      blockedCommand: "",
      nextAction: "Continue.",
      reason: "Hook payload did not contain a command."
    };
  }
  const route = resolveHookRoute(payload, { legacyRepoRoot: repoRoot });
  if (route.status === "no_match") {
    return route.worktreeBinding ? routeSessionMismatchDecision(command, route.reason) : {
      allow: true,
      matchedPolicy: "hook_routing_no_match",
      blockedCommand: renderCommand(command),
      nextAction: "Continue.",
      reason: route.reason
    };
  }
  if (route.status === "ambiguous") {
    return {
      allow: false,
      matchedPolicy: "hook_routing_ambiguous",
      gate: "policy_violation",
      blockedCommand: renderCommand(command),
      nextAction: "Run `agent-loop hooks doctor` and bind this Codex session to exactly one agent-loop target.",
      reason: route.reason
    };
  }
  if (route.status === "route_error") {
    return routeErrorDecision(command, route.reason);
  }

  let storage: SqliteAgentLoopStorage | undefined;
  try {
    const config = loadConfig(route.binding.repoRoot).config;
    storage = new SqliteAgentLoopStorage(statePath(route.binding.repoRoot));
    const decision = evaluateHookPolicy({
      repoRoot: route.binding.repoRoot,
      command,
      storage,
      ...(route.binding.runId ? { runId: route.binding.runId } : {}),
      protectedPaths: config.protectedPaths
    });
    recordHookDecision(storage, decision, route.binding.runId);
    return decision;
  } catch (error) {
    const failSafe = evaluateHookPolicy({ repoRoot: route.binding.repoRoot, command });
    if (!failSafe.allow) {
      return {
        ...failSafe,
        matchedPolicy: `fail_safe:${failSafe.matchedPolicy}`,
        reason: `Storage unavailable; denied dangerous command. ${error instanceof Error ? error.message : String(error)}`
      };
    }
    return failSafe;
  } finally {
    storage?.close();
  }
}

/** Convert a hook decision to Codex hook stdout JSON. */
export function toCodexHookResponse(decision: HookPolicyDecision): Record<string, unknown> {
  if (decision.allow) {
    return { continue: true };
  }
  return {
    decision: "block",
    reason: decision.reason,
    systemMessage: formatHookMessage(decision)
  };
}

function recordHookDecision(storage: AgentLoopStorage, decision: HookPolicyDecision, runId?: string): void {
  const run = runId ? storage.listRuns(200).find((item) => item.id === runId) : storage.getCurrentRun();
  const command = decision.blockedCommand;
  storage.appendEvent({
    ...(run ? { runId: run.id } : {}),
    kind: hookEventKind("PreToolUse"),
    message: decision.reason,
    payload: {
      allow: decision.allow,
      matchedPolicy: decision.matchedPolicy,
      ...(decision.gate ? { gate: decision.gate } : {}),
      ...(decision.auditDetails ? { auditDetails: decision.auditDetails } : {}),
      nextAction: decision.nextAction,
      commandLength: command.length,
      commandSha256: createHash("sha256").update(command).digest("hex"),
      commandPreview: redactSecrets(command.slice(0, 500))
    }
  });
}

function routeErrorDecision(command: HookCommand, reason: string): HookPolicyDecision {
  const baseCommand = normalizeCommand(command);
  const shellControl = shellControlPolicy(baseCommand);
  const normalized = shellControl ? baseCommand : unwrapCommand(baseCommand);
  const blockedCommand = renderCommand(normalized);
  const destructive = shellControl ?? destructivePolicy(normalized);
  if (destructive || lifecycleCommand(normalized)) {
    return deny(
      blockedCommand,
      `hook_routing_error${destructive ? `:${destructive}` : ""}`,
      "policy_violation",
      "Fix agent-loop hook routing with `agent-loop hooks doctor` before running lifecycle or destructive commands."
    );
  }
  return {
    allow: true,
    matchedPolicy: "hook_routing_error_noop",
    blockedCommand,
    nextAction: "Continue.",
    reason: `Hook routing unavailable; no-op for non-lifecycle command. ${reason}`
  };
}

function routeSessionMismatchDecision(command: HookCommand, reason: string): HookPolicyDecision {
  const baseCommand = normalizeCommand(command);
  const shellControl = shellControlPolicy(baseCommand);
  const normalized = shellControl ? baseCommand : unwrapCommand(baseCommand);
  const blockedCommand = renderCommand(normalized);
  const destructive = shellControl ?? destructivePolicy(normalized);
  if (destructive || lifecycleCommand(normalized)) {
    return deny(
      blockedCommand,
      `hook_routing_session_mismatch${destructive ? `:${destructive}` : ""}`,
      "policy_violation",
      "Bind this Codex session explicitly with `agent-loop hooks bind --session ...` before running lifecycle or destructive commands."
    );
  }
  return {
    allow: true,
    matchedPolicy: "hook_routing_no_match",
    blockedCommand,
    nextAction: "Continue.",
    reason
  };
}

function lifecycleCommand(command: HookCommand): boolean {
  const args = stripGitGlobalOptions(command.args);
  return command.file === "git" && ["commit", "push", "merge"].includes(args[0] ?? "") ||
    command.file === "gh" && command.args[0] === "pr" && ["create", "ready", "merge"].includes(command.args[1] ?? "");
}

function gatedLifecyclePolicy(command: HookCommand, storage?: AgentLoopStorage, runId?: string): { policy: string; gate: AgentLoopGateKind; nextAction: string } | undefined {
  const args = stripGitGlobalOptions(command.args);
  const lifecycleCommand = command.file === "git" && args[0] === "commit" ||
    command.file === "git" && args[0] === "push" ||
    command.file === "gh" && command.args[0] === "pr" && command.args[1] === "merge";
  if (!lifecycleCommand) {
    return undefined;
  }
  if (!storage) {
    return {
      policy: "storage_required_for_lifecycle",
      gate: "policy_violation",
      nextAction: "Run `pnpm agent-loop status` after restoring .agent-loop/state.sqlite."
    };
  }
  const current = storage.getCurrentStatus();
  const run = runId ? storage.getRun(runId) : current.run;
  const state = run?.currentState;
  const override = activeMaintainerOverride(storage, lifecycleOverrideScope(command), runId);
  if (command.file === "git" && (args[0] === "commit" || args[0] === "push") && state !== "COMMIT_PUSH_PR" && !override) {
    return {
      policy: "commit_push_state_gate",
      gate: current.gate?.kind ?? "policy_violation",
      nextAction: "Resume agent-loop until COMMIT_PUSH_PR owns publishing."
    };
  }
  if (command.file === "git" && (args[0] === "commit" || args[0] === "push") && !publishPrerequisitesSatisfied(storage, runId)) {
    return {
      policy: "commit_push_prerequisite_gate",
      gate: "policy_violation",
      nextAction: "Run SELF_CHECK and GitNexus detect_changes through agent-loop before publishing."
    };
  }
  if (command.file === "gh" && command.args[0] === "pr" && command.args[1] === "merge" && state !== "MERGE" && !override) {
    return {
      policy: "merge_state_gate",
      gate: current.gate?.kind ?? "merge_requires_confirmation",
      nextAction: "Wait for READY_TO_MERGE/MERGE and explicit approval."
    };
  }
  return undefined;
}

function lifecycleOverrideScope(command: HookCommand): MaintainerOverrideScope | undefined {
  const args = stripGitGlobalOptions(command.args);
  if (command.file === "git" && (args[0] === "commit" || args[0] === "push")) {
    return "publish";
  }
  if (command.file === "gh" && command.args[0] === "pr" && command.args[1] === "merge") {
    return "merge";
  }
  return undefined;
}

function activeMaintainerOverride(storage: AgentLoopStorage | undefined, scope: MaintainerOverrideScope | undefined, runId?: string): ActiveMaintainerOverride | undefined {
  if (!storage || !scope) {
    return undefined;
  }
  const run = runId ? storage.getRun(runId) : storage.getCurrentRun();
  if (!run) {
    return undefined;
  }
  return storage.listDecisions(run.id)
    .map((decision) => {
      const details = objectDetails(decision.details);
      const overrideScope = stringValue(details?.scope);
      const expiresAt = stringValue(details?.expiresAt);
      if (decision.kind !== "maintainer_override_approved" || !overrideScope || !expiresAt) {
        return undefined;
      }
      if (overrideScope !== scope) {
        return undefined;
      }
      const expiresAtMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        return undefined;
      }
      return { decisionId: decision.id, scope, expiresAt };
    })
    .find((override): override is ActiveMaintainerOverride => override !== undefined);
}

function destructivePolicy(command: HookCommand): string | undefined {
  const args = stripGitGlobalOptions(command.args);
  if (command.file === "git" && args[0] === "reset" && args.includes("--hard")) {
    return "destructive_git_reset_hard";
  }
  if (command.file === "git" && args[0] === "clean" && args.some((arg) => /^-.*f/.test(arg))) {
    return "destructive_git_clean";
  }
  if (command.file === "git" && args[0] === "push" && args.some((arg) =>
    ["-f", "-d", "--force", "--force-with-lease", "--mirror", "--delete"].includes(arg) ||
    arg.startsWith("+") ||
    /^:[^:]+/.test(arg)
  )) {
    return "destructive_git_force_push";
  }
  if (command.file === "gh" && command.args[0] === "repo" && command.args[1] === "delete") {
    return "destructive_gh_repo_delete";
  }
  return undefined;
}

function workerLifecyclePolicy(command: HookCommand): string | undefined {
  const args = stripGitGlobalOptions(command.args);
  if (command.file === "git" && ["commit", "push", "merge"].includes(args[0] ?? "")) {
    return "worker_git_lifecycle_forbidden";
  }
  if (command.file === "gh" && command.args[0] === "pr" && ["create", "ready", "merge"].includes(command.args[1] ?? "")) {
    return "worker_gh_lifecycle_forbidden";
  }
  return undefined;
}

function protectedPathPolicy(command: HookCommand, protectedPaths: string[]): string | undefined {
  const args = stripGitGlobalOptions(command.args);
  if (command.file !== "git" || args[0] !== "add") {
    return undefined;
  }
  const separator = args.indexOf("--");
  const paths = separator >= 0 ? args.slice(separator + 1) : args.slice(1);
  const hit = paths.find((path) => protectedPaths.some((pattern) => matchesProtectedPath(pattern, path)));
  return hit ? `protected_path:${hit}` : undefined;
}

function matchesHookAllowlist(command: HookCommand): boolean {
  const args = stripGitGlobalOptions(command.args);
  if (command.file === "rg" && matchesRipgrepAllowlist(command.args) || isApplyPatchCommand(command)) {
    return true;
  }
  if (command.file === "git") {
    return args[0] === "status" ||
      args[0] === "branch" && args[1] === "--show-current" ||
      args[0] === "rev-parse" ||
      args[0] === "diff" ||
      ["log", "show"].includes(args[0] ?? "") ||
      args[0] === "grep" && matchesGitGrepAllowlist(args.slice(1)) ||
      args[0] === "switch" && args.length === 2 && typeof args[1] === "string" && !args[1].startsWith("-") ||
      args[0] === "add" && args[1] === "--" ||
      args[0] === "commit" && args[1] === "-m" ||
      args[0] === "push" && matchesGitPushAllowlist(args.slice(1));
  }
  if (command.file === "gh") {
    return command.args[0] === "auth" && command.args[1] === "status" ||
      command.args[0] === "pr" && ["list", "view", "checks"].includes(command.args[1] ?? "") ||
      command.args[0] === "pr" && command.args[1] === "merge" && matchesGhPrMergeAllowlist(command.args.slice(2)) ||
      command.args[0] === "api" && command.args[1] === "graphql";
  }
  if (command.file === "pnpm") {
    return command.args[0] === "test" ||
      command.args[0] === "lint" ||
      command.args[0] === "build:hooks" ||
      command.args[0] === "build:mcp" ||
      command.args[0] === "agent-loop" && matchesAgentLoopAllowlist(command.args.slice(1));
  }
  if (command.file === "npx") {
    return command.args[0] === "gitnexus" &&
      ["--version", "status", "analyze", "detect_changes", "impact"].includes(command.args[1] ?? "");
  }
  if (command.file === "codex") {
    return command.args[0] === "--version";
  }
  return false;
}

function matchesRipgrepAllowlist(args: string[]): boolean {
  return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
}

function matchesGitGrepAllowlist(args: string[]): boolean {
  return !args.some((arg) =>
    arg === "-O" ||
    arg.startsWith("-O") ||
    arg === "--open-files-in-pager" ||
    arg.startsWith("--open-files-in-pager=")
  );
}

function matchesGitPushAllowlist(args: string[]): boolean {
  return args.length >= 3 &&
    args[0] === "-u" &&
    args.every((arg) => !["-f", "-d", "--force", "--force-with-lease", "--mirror", "--delete"].includes(arg) && !arg.startsWith("+") && !/^:[^:]+/.test(arg));
}

function matchesGhPrMergeAllowlist(args: string[]): boolean {
  const allowedFlags = new Set(["--merge", "--squash", "--rebase", "--body", "--subject"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (["--admin", "--auto", "--delete-branch", "-d"].includes(arg)) {
      return false;
    }
    if (arg.startsWith("--") && !allowedFlags.has(arg)) {
      return false;
    }
    if ((arg === "--body" || arg === "--subject") && args[index + 1]) {
      index += 1;
    }
  }
  return args.some((arg) => ["--merge", "--squash", "--rebase"].includes(arg));
}

function isApplyPatchCommand(command: HookCommand): boolean {
  return command.file === "apply_patch" || command.raw?.startsWith("*** Begin Patch") === true;
}

function matchesAgentLoopAllowlist(args: string[]): boolean {
  if (["status", "doctor", "logs", "observe", "timeline", "workers", "stop"].includes(args[0] ?? "")) {
    return true;
  }
  if (args[0] === "local") {
    return args[1] === "doctor";
  }
  if (args[0] === "hooks") {
    return ["doctor", "list"].includes(args[1] ?? "");
  }
  if (args[0] === "delivery") {
    return ["bind", "stage"].includes(args[1] ?? "");
  }
  if (args[0] === "evidence") {
    return args[1] === "append";
  }
  if (args[0] === "maintainer-override") {
    return args[1] === "approve";
  }
  return false;
}

function shellControlPolicy(command: HookCommand): string | undefined {
  if (isApplyPatchCommand(command)) {
    return undefined;
  }
  if (command.raw && command.rawKind !== "argv" && hasShellControlOperator(command.raw)) {
    return "shell_control_operator_forbidden";
  }
  if (command.file === "env") {
    const index = command.args.findIndex((arg) => !arg.includes("="));
    if (index >= 0) {
      return shellControlPolicy({
        file: basename(command.args[index] ?? ""),
        args: command.args.slice(index + 1),
        ...(command.rawKind ? { rawKind: command.rawKind } : {})
      });
    }
  }
  if ((command.file === "sh" || command.file === "bash") && command.args[0] === "-c" && command.args[1] && hasShellControlOperator(command.args[1])) {
    return "shell_control_operator_forbidden";
  }
  return undefined;
}

function deny(
  blockedCommand: string,
  matchedPolicy: string,
  gate: AgentLoopGateKind,
  nextAction: string
): HookPolicyDecision {
  return {
    allow: false,
    matchedPolicy,
    gate,
    blockedCommand,
    nextAction,
    reason: `${matchedPolicy} blocked ${blockedCommand}`
  };
}

function formatHookMessage(decision: HookPolicyDecision): string {
  return [
    `blocked command: ${decision.blockedCommand}`,
    `matched policy: ${decision.matchedPolicy}`,
    decision.gate ? `gate: ${decision.gate}` : undefined,
    `next action: ${decision.nextAction}`
  ].filter(Boolean).join("\n");
}

function normalizeCommand(command: HookCommand): HookCommand {
  return { ...command, file: basename(command.file) };
}

function unwrapCommand(command: HookCommand): HookCommand {
  if (command.file === "env") {
    const index = command.args.findIndex((arg) => !arg.includes("="));
    if (index >= 0) {
      return unwrapCommand({
        file: command.args[index] ?? "",
        args: command.args.slice(index + 1),
        raw: renderCommand(command),
        ...(command.rawKind ? { rawKind: command.rawKind } : {})
      });
    }
  }
  if ((command.file === "sh" || command.file === "bash") && command.args[0] === "-c" && command.args[1]) {
    return unwrapCommand(tokenizeCommand(command.args[1]));
  }
  return command;
}

function renderCommand(command: HookCommand): string {
  return command.raw ?? [command.file, ...command.args].join(" ");
}

function tokenizeCommand(command: string): HookCommand {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
  const [file = "", ...args] = parts;
  return { file: basename(file), args, raw: command, rawKind: "shell" };
}

function hasShellControlOperator(value: string): boolean {
  return /&&|\|\||[;|<>\n\r]/.test(value);
}

function stripGitGlobalOptions(args: string[]): string[] {
  const result = [...args];
  while (result.length > 0) {
    const first = result[0];
    if (first === "-C" || first === "--git-dir" || first === "--work-tree" || first === "-c") {
      result.splice(0, 2);
      continue;
    }
    if (first === "--no-pager" || first === "--paginate") {
      result.shift();
      continue;
    }
    if (first?.startsWith("--git-dir=") || first?.startsWith("--work-tree=") || first?.startsWith("-c")) {
      result.shift();
      continue;
    }
    break;
  }
  return result;
}

function publishPrerequisitesSatisfied(storage: AgentLoopStorage, runId?: string): boolean {
  const run = runId ? storage.getRun(runId) : storage.getCurrentRun();
  if (!run) {
    return false;
  }
  if (storage.hasRunCheck(run.id, "self_check") && storage.hasRunCheck(run.id, "gitnexus_detect_changes")) {
    return true;
  }
  return publishWorkflowEvidenceSatisfied(storage, run.id);
}

function publishWorkflowEvidenceSatisfied(storage: AgentLoopStorage, runId: string): boolean {
  const completed = new Set<string>();
  for (const event of storage.listEvents(200)) {
    const payload = objectDetails(event.payload);
    if (
      event.runId !== runId ||
      event.kind !== "workflow_stage_evidence" ||
      stringValue(payload?.stageId) !== "verify" ||
      stringValue(payload?.status) !== "done"
    ) {
      continue;
    }
    const substageId = stringValue(payload?.substageId);
    if (substageId) {
      completed.add(substageId);
    }
  }
  return REQUIRED_PUBLISH_EVIDENCE_SUBSTAGES.every((substageId) => completed.has(substageId));
}

function basename(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1) ?? value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectDetails(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
