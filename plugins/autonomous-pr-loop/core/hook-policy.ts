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
  repoId?: string;
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

interface HookAllowlistContext {
  repoRoot: string;
  repoId?: string;
}

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
  const environmentScope = environmentScopePolicy(normalized);
  if (environmentScope) {
    return deny(renderCommand(normalized), environmentScope, "policy_violation", "Do not override repository scope through environment variables.");
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
  if (override && matchesHookAllowlist(command, input)) {
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
  if (!matchesHookAllowlist(command, input)) {
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
      repoId: config.repoId,
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

function environmentScopePolicy(command: HookCommand): string | undefined {
  const forbiddenPrefixes = [
    "GH_REPO=", "GH_HOST=", "GITHUB_TOKEN=",
    "GIT_DIR=", "GIT_WORK_TREE=", "GIT_CONFIG_GLOBAL=", "GIT_CONFIG_SYSTEM=",
    "GIT_SSH_COMMAND=", "GIT_EXTERNAL_DIFF="
  ];
  if (command.file === "env" && command.args.some((arg) => forbiddenPrefixes.some((prefix) => arg.startsWith(prefix)))) {
    return "environment_repo_scope_forbidden";
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

function matchesHookAllowlist(command: HookCommand, context: HookAllowlistContext): boolean {
  const args = stripGitGlobalOptions(command.args);
  if (
    isApplyPatchCommand(command) ||
    matchesLocalInspectionAllowlist(command, context) ||
    matchesStructuredInspectionAllowlist(command, context) ||
    matchesToolDiscoveryAllowlist(command) ||
    matchesClaudeHelpAllowlist(command) ||
    matchesSafeTempMkdirAllowlist(command)
  ) {
    return true;
  }
  if (command.file === "git") {
    if (!matchesGitGlobalScope(command.args, context.repoRoot)) {
      return false;
    }
    return args[0] === "status" ||
      args[0] === "branch" && args[1] === "--show-current" ||
      args[0] === "branch" && args[1] === "-vv" ||
      args[0] === "rev-parse" ||
      args[0] === "diff" && matchesGitReadArgsAllowlist(args.slice(1)) ||
      ["log", "show"].includes(args[0] ?? "") && matchesGitReadArgsAllowlist(args.slice(1)) ||
      args[0] === "grep" && matchesGitGrepAllowlist(args.slice(1)) ||
      args[0] === "remote" && args[1] === "-v" ||
      args[0] === "ls-remote" && matchesGitLsRemoteAllowlist(args.slice(1)) ||
      args[0] === "merge-base" ||
      args[0] === "cat-file" && matchesGitCatFileAllowlist(args.slice(1)) ||
      args[0] === "fetch" && matchesGitFetchAllowlist(args.slice(1)) ||
      args[0] === "pull" && matchesGitPullAllowlist(args.slice(1)) ||
      args[0] === "switch" && args.length === 2 && typeof args[1] === "string" && !args[1].startsWith("-") ||
      args[0] === "switch" && args[1] === "-c" && args.length === 3 && isCodexBranch(args[2] ?? "") ||
      args[0] === "branch" && matchesGitBranchMutationAllowlist(args.slice(1)) ||
      args[0] === "add" && args[1] === "--" ||
      args[0] === "commit" && args[1] === "-m" ||
      args[0] === "push" && matchesGitPushAllowlist(args.slice(1));
  }
  if (command.file === "gh") {
    if (!matchesGhRepoScope(command.args, context.repoId)) {
      return false;
    }
    return command.args[0] === "auth" && command.args[1] === "status" ||
      command.args[0] === "issue" && ["create", "comment"].includes(command.args[1] ?? "") && matchesGhWriteAllowlist(command.args, context.repoId) ||
      command.args[0] === "issue" && ["list", "view"].includes(command.args[1] ?? "") ||
      command.args[0] === "pr" && ["list", "view", "checks"].includes(command.args[1] ?? "") ||
      command.args[0] === "pr" && command.args[1] === "diff" && matchesGhPrDiffAllowlist(command.args.slice(2), context.repoId) ||
      command.args[0] === "pr" && ["create", "ready", "comment"].includes(command.args[1] ?? "") && matchesGhWriteAllowlist(command.args, context.repoId) ||
      command.args[0] === "repo" && command.args[1] === "view" && matchesGhRepoViewAllowlist(command.args.slice(2), context.repoId) ||
      command.args[0] === "release" && matchesGhReleaseReadAllowlist(command.args.slice(1), context.repoId) ||
      command.args[0] === "run" && command.args[1] === "view" && command.args.includes("--log") ||
      command.args[0] === "pr" && command.args[1] === "merge" && matchesGhPrMergeAllowlist(command.args.slice(2)) ||
      command.args[0] === "api" && command.args[1] === "graphql" && matchesGhGraphqlAllowlist(command.args.slice(2), context.repoId);
  }
  if (command.file === "pnpm") {
    return command.args[0] === "install" && command.args.length === 2 && command.args[1] === "--frozen-lockfile" ||
      command.args[0] === "test" ||
      command.args[0] === "lint" ||
      command.args[0] === "build:hooks" ||
      command.args[0] === "build:mcp" ||
      command.args[0] === "exec" && matchesPnpmExecAllowlist(command.args.slice(1)) ||
      ["view", "info"].includes(command.args[0] ?? "") && matchesPackageViewAllowlist(command.args.slice(1)) ||
      command.args[0] === "pack" && matchesPnpmPackAllowlist(command.args.slice(1)) ||
      command.args[0] === "agent-loop" && matchesAgentLoopAllowlist(command.args.slice(1), context);
  }
  if (command.file === "agent-loop") {
    return matchesAgentLoopAllowlist(command.args, context);
  }
  if (command.file === "npm") {
    return matchesNpmAllowlist(command.args);
  }
  if (command.file === "npx") {
    return command.args[0] === "gitnexus" &&
      ["--version", "status", "analyze", "detect_changes", "impact"].includes(command.args[1] ?? "");
  }
  if (command.file === "codex") {
    return command.args[0] === "--version";
  }
  if (matchesReviewerDispatchAllowlist(command, context)) {
    return true;
  }
  if (matchesDashboardSmokeAllowlist(command)) {
    return true;
  }
  return false;
}

function matchesLocalInspectionAllowlist(command: HookCommand, context: HookAllowlistContext): boolean {
  if (hasUnsafePathArg(command.args, context)) {
    return false;
  }
  if (command.file === "rg") {
    return matchesRipgrepAllowlist(command.args);
  }
  if (["pwd", "stat", "file", "wc", "nl", "cat"].includes(command.file)) {
    return !command.args.some(isDangerousReadArg);
  }
  if (command.file === "ls") {
    return !command.args.some((arg) => arg === "--hyperlink" || arg.startsWith("--format=") && arg.includes("shell"));
  }
  if (command.file === "head" || command.file === "tail") {
    return !command.args.some((arg) => ["-f", "--follow", "--pid"].includes(arg) || arg.startsWith("--pid="));
  }
  if (command.file === "sed") {
    return matchesSedReadAllowlist(command.args);
  }
  if (command.file === "find") {
    return matchesFindReadAllowlist(command.args);
  }
  return false;
}

function matchesStructuredInspectionAllowlist(command: HookCommand, context: HookAllowlistContext): boolean {
  if (hasUnsafePathArg(command.args, context)) {
    return false;
  }
  return command.file === "jq" && matchesJqAllowlist(command.args) ||
    command.file === "python" && command.args[0] === "-m" && command.args[1] === "json.tool";
}

function isDangerousReadArg(arg: string): boolean {
  return arg === "--help" || arg === "--version" ? false : arg.startsWith("--") && arg.includes("output");
}

function matchesToolDiscoveryAllowlist(command: HookCommand): boolean {
  const allowedTools = new Set([
    "agent-loop",
    "agy",
    "agy-dispatch.mjs",
    "claude",
    "claude-acp-dispatch.mjs",
    "claude-acp-review",
    "node",
    "pnpm"
  ]);
  if (command.file === "which") {
    return command.args.length === 1 && allowedTools.has(command.args[0] ?? "");
  }
  return command.file === "command" &&
    command.args.length === 2 &&
    command.args[0] === "-v" &&
    allowedTools.has(command.args[1] ?? "");
}

function matchesClaudeHelpAllowlist(command: HookCommand): boolean {
  if (command.file !== "claude") {
    return false;
  }
  if (command.args.length === 1) {
    return command.args[0] === "--help" || command.args[0] === "-h";
  }
  return command.args.length === 2 &&
    command.args[0] === "acp" &&
    (command.args[1] === "--help" || command.args[1] === "-h");
}

function hasUnsafePathArg(args: string[], context: HookAllowlistContext): boolean {
  return args.some((arg) => {
    if (!arg || arg === "-" || arg.startsWith("-")) {
      if (arg.startsWith("--") && arg.includes("=")) {
        return isUnsafePathValue(arg.slice(arg.indexOf("=") + 1), context);
      }
      return false;
    }
    return isUnsafePathValue(arg, context);
  });
}

function isUnsafePathValue(value: string, context: HookAllowlistContext): boolean {
  if (value.split(/[\\/]/).includes("..")) {
    return true;
  }
  return (value.startsWith("/") || value.startsWith("~")) &&
    !isTrustedSkillPath(value) &&
    !isSafeReleaseSmokeReadPath(value, context);
}

function isTrustedSkillPath(value: string): boolean {
  const home = process.env.HOME?.replaceAll("\\", "/");
  if (!home) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(`${home}/.codex/skills/`) ||
    normalized.startsWith(`${home}/.agents/skills/`);
}

function isSafeReleaseSmokeReadPath(value: string, context: HookAllowlistContext): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split(/[\\/]/).includes("..")) {
    return false;
  }
  if (normalized === context.repoRoot || normalized.startsWith(`${context.repoRoot}/`)) {
    return false;
  }
  return normalized.startsWith("/tmp/holo-") ||
    /^\/var\/folders\/[^/]+\/[^/]+\/T\/holo-[^/]+(?:\/|$)/.test(normalized);
}

function matchesSafeTempMkdirAllowlist(command: HookCommand): boolean {
  return command.file === "mkdir" &&
    command.args.length === 2 &&
    command.args[0] === "-p" &&
    isSafeTempPath(command.args[1] ?? "");
}

function matchesSedReadAllowlist(args: string[]): boolean {
  if (args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) {
    return false;
  }
  const normalized = args.filter((arg) => arg !== "--");
  if (normalized[0] !== "-n" || normalized.length < 3) {
    return false;
  }
  const script = normalized[1] ?? "";
  return /^(\d+|\$)?(,(\d+|\$))?p$/.test(script);
}

function matchesFindReadAllowlist(args: string[]): boolean {
  if (args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprintf"].includes(arg))) {
    return false;
  }
  const allowedPrimaries = new Set(["-maxdepth", "-mindepth", "-name", "-iname", "-path", "-type", "-print"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) {
      continue;
    }
    if (!allowedPrimaries.has(arg)) {
      return false;
    }
    if (["-maxdepth", "-mindepth", "-name", "-iname", "-path", "-type"].includes(arg)) {
      index += 1;
    }
  }
  return true;
}

function matchesRipgrepAllowlist(args: string[]): boolean {
  return !args.some((arg) =>
    arg === "--pre" ||
    arg.startsWith("--pre=") ||
    arg === "-L" ||
    arg === "--follow" ||
    arg === "-f" ||
    arg.startsWith("-f") ||
    arg === "--file" ||
    arg.startsWith("--file=") ||
    arg === "--files-from" ||
    arg.startsWith("--files-from=") ||
    arg === "--glob-from" ||
    arg.startsWith("--glob-from=") ||
    arg === "--ignore-file" ||
    arg.startsWith("--ignore-file=")
  );
}

function matchesJqAllowlist(args: string[]): boolean {
  return !args.some((arg) =>
    arg === "-f" ||
    arg.startsWith("-f") ||
    arg === "--from-file" ||
    arg.startsWith("--from-file=") ||
    arg === "-L" ||
    arg.startsWith("-L") ||
    arg === "--run-tests"
  );
}

function matchesGitGrepAllowlist(args: string[]): boolean {
  return !args.some((arg) =>
    arg === "-O" ||
    arg.startsWith("-O") ||
    arg === "--open-files-in-pager" ||
    arg.startsWith("--open-files-in-pager=")
  );
}

function matchesGitGlobalScope(args: string[], repoRoot: string): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-C") {
      if (args[index + 1] !== repoRoot) {
        return false;
      }
      index += 1;
      continue;
    }
    if (arg === "--git-dir" || arg === "--work-tree" || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      return false;
    }
    if (arg === "-c" || arg.startsWith("-c")) {
      return false;
    }
    if (arg === "--no-pager" || arg === "--paginate") {
      continue;
    }
    break;
  }
  return true;
}

function matchesGitReadArgsAllowlist(args: string[]): boolean {
  return !args.some((arg) =>
    arg === "--ext-diff" ||
    arg === "--no-index" ||
    arg === "--textconv" ||
    arg === "--output" ||
    arg.startsWith("--output=") ||
    arg.startsWith("--ext-diff=")
  );
}

function matchesGitPushAllowlist(args: string[]): boolean {
  return args.length === 3 &&
    args[0] === "-u" &&
    args[1] === "origin" &&
    isCodexBranch(args[2] ?? "") &&
    args.every((arg) => !["-f", "-d", "--force", "--force-with-lease", "--mirror", "--delete"].includes(arg) && !arg.startsWith("+") && !/^:[^:]+/.test(arg));
}

function matchesGitLsRemoteAllowlist(args: string[]): boolean {
  if (args.length === 0) {
    return true;
  }
  if (args[0] !== "origin") {
    return false;
  }
  return args.slice(1).every((arg) =>
    arg === "main" ||
    arg === "refs/heads/main" ||
    /^refs\/tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(arg) ||
    isCodexBranch(arg)
  );
}

function matchesGitFetchAllowlist(args: string[]): boolean {
  return args.length === 2 &&
    args[0] === "origin" &&
    ((args[1] ?? "") === "main" || isCodexBranch(args[1] ?? ""));
}

function matchesGitPullAllowlist(args: string[]): boolean {
  return args.length === 3 &&
    args[0] === "--ff-only" &&
    args[1] === "origin" &&
    args[2] === "main";
}

function matchesGitBranchMutationAllowlist(args: string[]): boolean {
  return args.length === 2 &&
    args[0] === "-d" &&
    isCodexBranch(args[1] ?? "");
}

function matchesGitCatFileAllowlist(args: string[]): boolean {
  return ["-p", "-t", "-s", "-e"].includes(args[0] ?? "") && args.length >= 2;
}

function isCodexBranch(value: string): boolean {
  return /^codex\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..") && !value.endsWith("/");
}

function matchesGhRepoScope(args: string[], repoId?: string): boolean {
  if (args.some((arg) => arg === "--hostname" || arg.startsWith("--hostname="))) {
    return false;
  }
  const repoValues: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--repo" || arg === "-R") {
      repoValues.push(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      repoValues.push(arg.slice("--repo=".length));
      continue;
    }
    if (arg.startsWith("-R=")) {
      repoValues.push(arg.slice("-R=".length));
      continue;
    }
    if (arg.startsWith("-R") && arg.length > 2) {
      repoValues.push(arg.slice(2));
    }
  }
  return repoValues.length === 0 || Boolean(repoId) && repoValues.every((value) => value === repoId);
}

function matchesGhWriteAllowlist(args: string[], repoId?: string): boolean {
  if (!repoId || !matchesGhExplicitRepo(args, repoId)) {
    return false;
  }
  const forbiddenFlags = new Set(["--body-file", "-F", "--field", "--raw-field", "--input"]);
  return !args.some((arg) => forbiddenFlags.has(arg) || arg.startsWith("--body-file=") || arg.startsWith("--input="));
}

function matchesGhExplicitRepo(args: string[], repoId: string): boolean {
  const repoValues = ghRepoFlagValues(args);
  return repoValues.length === 1 && repoValues[0] === repoId;
}

function matchesGhRepoViewAllowlist(args: string[], repoId?: string): boolean {
  if (!repoId || args[0] !== repoId) {
    return false;
  }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") {
      const value = args[index + 1] ?? "";
      if (value !== "defaultBranchRef,nameWithOwner") {
        return false;
      }
      index += 1;
      continue;
    }
    return false;
  }
  return args.includes("--json");
}

function matchesGhReleaseReadAllowlist(args: string[], repoId?: string): boolean {
  const subcommand = args[0];
  if (!repoId || !["view", "list"].includes(subcommand ?? "") || !matchesGhExplicitRepo(args, repoId)) {
    return false;
  }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--repo" || arg === "-R") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=") || arg.startsWith("-R=") || arg.startsWith("-R") && arg.length > 2) {
      continue;
    }
    if (arg === "--json") {
      const value = args[index + 1] ?? "";
      const expected = subcommand === "view" ? "tagName,publishedAt,url" : "tagName,publishedAt";
      if (value !== expected) {
        return false;
      }
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      if (!/^\d+$/.test(args[index + 1] ?? "")) {
        return false;
      }
      index += 1;
      continue;
    }
    if (subcommand === "view" && index === 1 && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(arg)) {
      continue;
    }
    return false;
  }
  return args.includes("--json");
}

function matchesGhPrDiffAllowlist(args: string[], repoId?: string): boolean {
  if (!repoId || !matchesGhExplicitRepo(args, repoId)) {
    return false;
  }
  let sawNumber = false;
  let sawDiffMode = false;
  let sawPathSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (/^\d+$/.test(arg) && !sawNumber && !sawPathSeparator) {
      sawNumber = true;
      continue;
    }
    if (arg === "--repo" || arg === "-R") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=") || arg.startsWith("-R=") || arg.startsWith("-R") && arg.length > 2) {
      continue;
    }
    if ((arg === "--name-only" || arg === "--patch") && !sawPathSeparator) {
      sawDiffMode = true;
      continue;
    }
    if (arg === "--" && !sawPathSeparator) {
      sawPathSeparator = true;
      continue;
    }
    if (sawPathSeparator && isSafeRepoRelativePath(arg)) {
      continue;
    }
    return false;
  }
  return sawNumber && sawDiffMode;
}

function isSafeRepoRelativePath(value: string): boolean {
  return value.length > 0 &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.includes("..") &&
    !value.includes("\\");
}

function ghRepoFlagValues(args: string[]): string[] {
  const repoValues: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--repo" || arg === "-R") {
      repoValues.push(args[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--repo=")) {
      repoValues.push(arg.slice("--repo=".length));
    } else if (arg.startsWith("-R=")) {
      repoValues.push(arg.slice("-R=".length));
    } else if (arg.startsWith("-R") && arg.length > 2) {
      repoValues.push(arg.slice(2));
    }
  }
  return repoValues;
}

function matchesGhGraphqlAllowlist(args: string[], repoId?: string): boolean {
  if (!repoId || !matchesGhExplicitRepo(args, repoId)) {
    return false;
  }
  const forbiddenFlags = new Set(["-F", "--field", "--raw-field", "--input"]);
  if (args.some((arg) => forbiddenFlags.has(arg) || arg.startsWith("-F") || arg.startsWith("--field=") || arg.startsWith("--raw-field=") || arg.startsWith("--input="))) {
    return false;
  }
  const query = args.find((arg, index) => args[index - 1] === "-f" && arg.startsWith("query=") || arg.startsWith("query="));
  return Boolean(query) && !/\bmutation\b/i.test(query ?? "");
}

function matchesGhPrMergeAllowlist(args: string[]): boolean {
  const allowedFlags = new Set(["--merge", "--squash", "--rebase", "--delete-branch", "--body", "--subject", "--repo", "-R"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (["--admin", "--auto", "-d"].includes(arg)) {
      return false;
    }
    if (arg.startsWith("--repo=") || arg.startsWith("-R=") || arg.startsWith("-R") && arg.length > 2) {
      continue;
    }
    if (arg.startsWith("--") && !allowedFlags.has(arg)) {
      return false;
    }
    if ((arg === "--body" || arg === "--subject" || arg === "--repo" || arg === "-R") && args[index + 1]) {
      index += 1;
    }
  }
  return args.some((arg) => ["--merge", "--squash", "--rebase"].includes(arg));
}

function isApplyPatchCommand(command: HookCommand): boolean {
  return command.file === "apply_patch" || command.raw?.startsWith("*** Begin Patch") === true;
}

function matchesPnpmExecAllowlist(args: string[]): boolean {
  if (args[0] === "vitest") {
    return !args.some(hasUnsafeToolingArg);
  }
  return args[0] === "tsx" && typeof args[1] === "string" && isRepoOwnedTsxEntrypoint(args[1]);
}

function isRepoOwnedTsxEntrypoint(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return !normalized.split("/").includes("..") &&
    (
      normalized.startsWith("plugins/autonomous-pr-loop/scripts/") ||
      normalized.startsWith("plugins/autonomous-pr-loop/mcp-server/src/")
    );
}

function matchesPnpmPackAllowlist(args: string[]): boolean {
  return args.includes("--dry-run") &&
    args.includes("--ignore-scripts") &&
    matchesPackageViewAllowlist(args) &&
    !args.some((arg) => arg === "--pack-destination" || arg.startsWith("--pack-destination="));
}

function matchesNpmAllowlist(args: string[]): boolean {
  if (args[0] === "whoami" && args.length === 1) {
    return true;
  }
  if (args[0] === "ping") {
    return args.length === 2 && args[1] === "--json";
  }
  if (["view", "info"].includes(args[0] ?? "")) {
    return matchesPackageViewAllowlist(args.slice(1));
  }
  if (args[0] === "pack") {
    return matchesNpmPackAllowlist(args.slice(1));
  }
  if (args[0] === "install") {
    return matchesNpmInstallAllowlist(args.slice(1));
  }
  return false;
}

function hasUnsafeToolingArg(arg: string): boolean {
  return arg.startsWith("/") ||
    arg.startsWith("~") ||
    arg.split(/[\\/]/).includes("..") ||
    arg === "--config" ||
    arg === "-c" ||
    arg.startsWith("-c") ||
    arg.startsWith("--config=");
}

function matchesPackageViewAllowlist(args: string[]): boolean {
  return !args.some((arg) =>
    arg === "--registry" ||
    arg.startsWith("--registry=") ||
    arg === "--userconfig" ||
    arg.startsWith("--userconfig=") ||
    arg === "--config" ||
    arg.startsWith("--config=")
  );
}

function matchesNpmPackAllowlist(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (["--ignore-scripts", "--json", "--dry-run"].includes(arg)) {
      continue;
    }
    if (arg === "--pack-destination") {
      if (!args[index + 1] || args[index + 1]?.startsWith("-")) {
        return false;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--pack-destination=") && arg.slice("--pack-destination=".length)) {
      continue;
    }
    return false;
  }
  if (!hasExactIgnoreScripts(args) || !args.includes("--json") || flagValues(args, "--pack-destination").length > 1) {
    return false;
  }
  if (args.includes("--dry-run")) {
    return true;
  }
  const destination = singleFlagValue(args, "--pack-destination");
  return Boolean(destination) && isSafeTempPath(destination ?? "");
}

function matchesNpmInstallAllowlist(args: string[]): boolean {
  const specs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--ignore-scripts") {
      continue;
    }
    if (arg === "--prefix") {
      if (!args[index + 1] || args[index + 1]?.startsWith("-")) {
        return false;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--prefix=") && arg.slice("--prefix=".length)) {
      continue;
    }
    if (arg.startsWith("-")) {
      return false;
    }
    specs.push(arg);
  }
  const prefix = singleFlagValue(args, "--prefix");
  return Boolean(prefix) &&
    flagValues(args, "--prefix").length === 1 &&
    isSafeTempPath(prefix ?? "") &&
    specs.length >= 1 &&
    specs.every(isSafeNpmInstallSpec) &&
    hasExactIgnoreScripts(args);
}

function isSafeTempPath(value: string): boolean {
  if (value.split(/[\\/]/).includes("..")) {
    return false;
  }
  return /^\/tmp\/holo-[^/]+(?:\/|$)/.test(value) ||
    /^\/var\/folders\/[^/]+\/[^/]+\/T\/holo-[^/]+(?:\/|$)/.test(value);
}

function hasExactIgnoreScripts(args: string[]): boolean {
  return args.includes("--ignore-scripts") &&
    !args.some((arg) => arg === "--no-ignore-scripts" || arg.startsWith("--no-ignore-scripts=") || arg.startsWith("--ignore-scripts="));
}

function isSafeNpmInstallSpec(value: string): boolean {
  if (value.startsWith("http:") || value.startsWith("https:") || value.startsWith("git+") || value.startsWith("github:") || value.startsWith("ssh:")) {
    return false;
  }
  return value === "holo-codex" ||
    value.endsWith(".tgz") &&
      (value.startsWith("./") || value.startsWith("tmp/") || value.startsWith("/tmp/") || value.startsWith("/var/folders/"));
}

function matchesAgentLoopAllowlist(args: string[], context: HookAllowlistContext): boolean {
  if (matchesAgentLoopHelpAllowlist(args)) {
    return true;
  }
  if (["status", "doctor", "logs", "observe", "timeline", "workers", "stop"].includes(args[0] ?? "")) {
    return true;
  }
  if (["approve-gate", "resume", "recover"].includes(args[0] ?? "")) {
    return true;
  }
  if (args[0] === "local") {
    return args[1] === "doctor";
  }
  if (args[0] === "install-hooks") {
    return singleFlagValue(args, "--repo") === context.repoRoot;
  }
  if (args[0] === "hooks") {
    return ["doctor", "list", "bind"].includes(args[1] ?? "");
  }
  if (args[0] === "delivery") {
    return ["bind", "stage"].includes(args[1] ?? "");
  }
  if (args[0] === "dashboard") {
    return matchesAgentLoopDashboardAllowlist(args.slice(1));
  }
  if (args[0] === "release") {
    return matchesAgentLoopReleaseAllowlist(args.slice(1));
  }
  if (args[0] === "evidence") {
    return args[1] === "append";
  }
  if (args[0] === "maintainer-override") {
    return args[1] === "approve";
  }
  return false;
}

function matchesAgentLoopHelpAllowlist(args: string[]): boolean {
  if (args.length === 0) {
    return false;
  }
  const last = args[args.length - 1];
  if (last !== "--help" && last !== "-h") {
    return false;
  }
  return args.length <= 3 && !args.some((arg) => arg.includes("/") || arg.includes("\\") || arg.includes(".."));
}

function matchesAgentLoopReleaseAllowlist(args: string[]): boolean {
  if (args[0] !== "doctor") {
    return false;
  }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    if (arg === "--version") {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args[index + 1] ?? "")) {
        return false;
      }
      index += 1;
      continue;
    }
    if (arg === "--tag") {
      if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args[index + 1] ?? "")) {
        return false;
      }
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function matchesAgentLoopDashboardAllowlist(args: string[]): boolean {
  if (args[0] !== "smoke") {
    return false;
  }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") {
      continue;
    }
    if (arg === "--host") {
      const value = args[index + 1];
      if (!value || !["127.0.0.1", "localhost"].includes(value)) {
        return false;
      }
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value) || Number(value) > 65_535) {
        return false;
      }
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function matchesReviewerDispatchAllowlist(command: HookCommand, context: HookAllowlistContext): boolean {
  return matchesClaudeAcpDispatchAllowlist(command, context) || matchesAgyDispatchAllowlist(command, context);
}

function matchesClaudeAcpDispatchAllowlist(command: HookCommand, context: HookAllowlistContext): boolean {
  const { scriptEvidence, args } = dispatchScriptArgs(command);
  if (!isTrustedDispatchScript(scriptEvidence, "dispatch-claude-acp", "claude-acp-dispatch.mjs")) {
    return false;
  }
  if (matchesHelpOnly(args)) {
    return true;
  }
  if (!matchesKnownValueFlags(args, new Set([
    "--cwd",
    "--effort",
    "--heartbeatMs",
    "--mode",
    "--model",
    "--permission",
    "--prompt",
    "--resume-session",
    "--softTimeoutMs",
    "--timeoutMs"
  ]))) {
    return false;
  }
  const modes = flagValues(args, "--mode");
  if (modes.length > 1) {
    return false;
  }
  const resumeSessions = flagValues(args, "--resume-session");
  if (resumeSessions.length > 1 || resumeSessions.some((session) => !isUuid(session))) {
    return false;
  }
  return singleFlagValue(args, "--cwd") === context.repoRoot &&
    (modes[0] ?? "plan") === "plan" &&
    singleFlagValue(args, "--permission") === "reject";
}

function matchesAgyDispatchAllowlist(command: HookCommand, context: HookAllowlistContext): boolean {
  const { scriptEvidence, args } = dispatchScriptArgs(command);
  if (!isTrustedDispatchScript(scriptEvidence, "dispatch-agy-headless", "agy-dispatch.mjs")) {
    return false;
  }
  if (matchesHelpOnly(args)) {
    return true;
  }
  if (!matchesKnownValueFlags(args, new Set([
    "--conversation",
    "--cwd",
    "--mode",
    "--model",
    "--printTimeout",
    "--prompt",
    "--role",
    "--transport"
  ]))) {
    return false;
  }
  if (args.some((arg) => arg === "--allow-dangerous" || arg.startsWith("--allow-dangerous="))) {
    return false;
  }
  const modes = flagValues(args, "--mode");
  if (modes.length > 1) {
    return false;
  }
  if (flagValues(args, "--transport").length > 1) {
    return false;
  }
  const role = singleFlagValue(args, "--role") ?? "";
  const mode = modes[0] ?? "packet-only";
  const transport = singleFlagValue(args, "--transport");
  return singleFlagValue(args, "--cwd") === context.repoRoot &&
    ["reviewer", "ui-reviewer", "tester", "planner", "researcher", "second-opinion"].includes(role) &&
    ["packet-only", "sandbox-inspect"].includes(mode) &&
    (transport === undefined || transport === "direct");
}

function matchesHelpOnly(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function matchesKnownValueFlags(args: string[], allowedFlags: Set<string>): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) {
      return false;
    }
    const equals = arg.indexOf("=");
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    if (!allowedFlags.has(flag)) {
      return false;
    }
    if (equals >= 0) {
      if (arg.slice(equals + 1).length === 0) {
        return false;
      }
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      return false;
    }
    index += 1;
  }
  return true;
}

function dispatchScriptArgs(command: HookCommand): { scriptEvidence: string; args: string[] } {
  const rawScriptPath = command.raw?.match(/^\S+/)?.[0];
  const scriptPath = command.file === "node" ? command.args[0] ?? "" : rawScriptPath ?? command.file;
  const args = command.file === "node" ? command.args.slice(1) : command.args;
  return {
    scriptEvidence: `${scriptPath}\n${command.raw ?? ""}`.replaceAll("\\", "/"),
    args
  };
}

function isTrustedDispatchScript(scriptEvidence: string, skillName: string, scriptName: string): boolean {
  const scriptPath = scriptEvidence.split("\n")[0]?.replaceAll("\\", "/") ?? "";
  const home = process.env.HOME?.replaceAll("\\", "/");
  return Boolean(home) && (
    scriptPath === `${home}/.codex/skills/${skillName}/scripts/${scriptName}` ||
    scriptPath === `${home}/.agents/skills/${skillName}/scripts/${scriptName}`
  );
}

function matchesDashboardSmokeAllowlist(command: HookCommand): boolean {
  if (command.file === "ps") {
    return command.args.length === 1 && command.args[0] === "aux";
  }
  if (command.file === "lsof") {
    return command.args.length >= 2 && command.args[0] === "-i" && /^:\d+$/.test(command.args[1] ?? "");
  }
  if (command.file === "curl") {
    return matchesCurlLocalhostReadAllowlist(command.args);
  }
  return false;
}

function matchesCurlLocalhostReadAllowlist(args: string[]): boolean {
  const urls = args.filter((arg) => /^https?:\/\//.test(arg));
  if (urls.length !== 1) {
    return false;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === urls[0]) {
      continue;
    }
    if (["--head", "-I", "--fail", "--silent", "-s", "--show-error", "-S"].includes(arg)) {
      continue;
    }
    if (["--max-time", "--connect-timeout"].includes(arg) && /^\d+(\.\d+)?$/.test(args[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    if ((arg.startsWith("--max-time=") || arg.startsWith("--connect-timeout=")) && /^\d+(\.\d+)?$/.test(arg.split("=")[1] ?? "")) {
      continue;
    }
    if ((arg === "-X" || arg === "--request") && ["GET", "HEAD"].includes(args[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    if (arg === "--request=GET" || arg === "--request=HEAD") {
      continue;
    }
    return false;
  }
  const url = urls[0];
  return Boolean(url) && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/.test(url ?? "");
}

function valueAfterFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function singleFlagValue(args: string[], flag: string): string | undefined {
  const values = flagValues(args, flag);
  return values.length === 1 ? values[0] : undefined;
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === flag) {
      values.push(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
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
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    const next = value[index + 1] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if ((char === "$" && next === "(") || char === "`" || (char === "<" || char === ">") && next === "(") {
      return true;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "&" && next === "&" || char === "|" || char === ";" || char === "<" || char === ">" || char === "\n" || char === "\r") {
      return true;
    }
  }
  return quote !== undefined;
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
