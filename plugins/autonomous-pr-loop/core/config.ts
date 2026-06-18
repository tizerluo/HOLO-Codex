import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentLoopError } from "./errors.js";
import { DEFAULT_LOCALE, LOCALE_SETTINGS } from "./locale.js";
import {
  DEFAULT_LOOP_SHAPE_ID,
  DEFAULT_ROLE_PROFILE_ID,
  DEFAULT_WORKFLOW_PROFILE_ID,
  ROLE_PROFILE_IDS,
  WORKFLOW_PROFILE_IDS,
  resolveProfile
} from "./profiles.js";
import { loopShapeIds } from "./loop-shapes.js";
import type { AgentLoopConfig, LoadedConfig } from "./types.js";

export const CONFIG_DIR = ".agent-loop";
export const CONFIG_FILE = "config.json";
/** Default protected path globs used when a repository config omits policy paths. */
export const DEFAULT_PROTECTED_PATHS = [
  ".git/**",
  ".agent-loop/**",
  ".claude/**",
  "AGENTS.md",
  "CLAUDE.md",
  ".env*",
  "**/*secret*"
];

export const AUTONOMY_MODES = ["supervised", "autonomous_until_gate", "autonomous_until_terminal"] as const;
export const MERGE_MODES = ["manual", "conditional", "disabled"] as const;
export const NOTIFY_MODES = ["all_gates", "important_only", "blockers_only"] as const;
export const WORKER_BACKENDS = ["codex-exec", "codex-app-server"] as const;
export const REVIEW_HANDLING_MODES = [
  "fix_scoped_and_carry_forward",
  "ask_on_any_review",
  "require_zero_open_findings"
] as const;

/** Return the canonical agent-loop config path for a repository root. */
export function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_DIR, CONFIG_FILE);
}

/** Return the canonical SQLite state path for a repository root. */
export function statePath(repoRoot: string): string {
  return join(repoRoot, CONFIG_DIR, "state.sqlite");
}

/** Merge a partial repository config with PR A defaults. */
export function withConfigDefaults(
  input: Partial<AgentLoopConfig> & { repoId: string }
): AgentLoopConfig {
  const mergeMode = input.mergeMode ?? (input.allowAutoMerge ? "conditional" : "manual");
  return {
    repoId: input.repoId,
    locale: input.locale ?? DEFAULT_LOCALE,
    loopShape: input.loopShape ?? DEFAULT_LOOP_SHAPE_ID,
    workflowProfile: input.workflowProfile ?? DEFAULT_WORKFLOW_PROFILE_ID,
    roleProfile: input.roleProfile ?? DEFAULT_ROLE_PROFILE_ID,
    baseBranch: input.baseBranch ?? "main",
    branchPrefix: input.branchPrefix ?? "codex/",
    plansDir: input.plansDir ?? "docs/plans",
    ...(input.lintCommand ? { lintCommand: input.lintCommand } : {}),
    ...(input.testCommand ? { testCommand: input.testCommand } : {}),
    ...(input.gitnexusRepo ? { gitnexusRepo: input.gitnexusRepo } : {}),
    gitnexusRequired: input.gitnexusRequired ?? true,
    requiredChecks: input.requiredChecks ?? [],
    requireReviewApproval: input.requireReviewApproval ?? true,
    autonomyMode: input.autonomyMode ?? "autonomous_until_gate",
    mergeMode,
    notifyMode: input.notifyMode ?? "important_only",
    reviewHandling: input.reviewHandling ?? "fix_scoped_and_carry_forward",
    ...(input.carryoverTarget ? { carryoverTarget: input.carryoverTarget } : {}),
    allowAutoMerge: mergeMode === "conditional",
    maxReviewFixRounds: input.maxReviewFixRounds ?? 3,
    maxTestFixRounds: input.maxTestFixRounds ?? 2,
    maxCiReruns: input.maxCiReruns ?? 1,
    commandTimeoutMs: input.commandTimeoutMs ?? 600_000,
    commandOutputLimitBytes: input.commandOutputLimitBytes ?? 65_536,
    githubRetryMaxAttempts: input.githubRetryMaxAttempts ?? 3,
    githubRetryBaseDelayMs: input.githubRetryBaseDelayMs ?? 1_000,
    reviewCiPollIntervalMs: input.reviewCiPollIntervalMs ?? 30_000,
    reviewCiMaxWaitMs: input.reviewCiMaxWaitMs ?? 1_800_000,
    workerBackend: input.workerBackend ?? "codex-exec",
    workerTimeoutMs: input.workerTimeoutMs ?? 1_800_000,
    workerMaxRetries: input.workerMaxRetries ?? 1,
    workerEphemeral: input.workerEphemeral ?? false,
    protectedPaths: input.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
    ...(input.dashboard ? { dashboard: input.dashboard } : {})
  };
}

/** Load and validate `.agent-loop/config.json`, or throw a structured gate error. */
export function loadConfig(repoRoot: string): LoadedConfig {
  const path = configPath(repoRoot);
  if (!existsSync(path)) {
    throw new AgentLoopError(
      "needs_repo_init",
      "Missing .agent-loop/config.json. Run `pnpm agent-loop init`.",
      { details: { path }, exitCode: 2 }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new AgentLoopError("invalid_config", "Config is not valid JSON.", {
      details: { path, cause: error instanceof Error ? error.message : String(error) }
    });
  }

  const config = validateConfig(parsed);
  return { path, config };
}

/** Validate user config and return a default-filled normalized config. */
export function validateConfig(value: unknown): AgentLoopConfig {
  if (!isRecord(value)) {
    throw new AgentLoopError("invalid_config", "Config must be a JSON object.");
  }
  assertKnownTopLevelKeys(value);
  if (typeof value.repoId !== "string" || value.repoId.length === 0) {
    throw new AgentLoopError("invalid_config", "Config repoId is required.");
  }

  const config = withConfigDefaults(value as Partial<AgentLoopConfig> & { repoId: string });
  const stringFields = ["baseBranch", "branchPrefix", "plansDir"] as const;
  for (const field of stringFields) {
    if (typeof config[field] !== "string" || config[field].length === 0) {
      throw new AgentLoopError("invalid_config", `Config ${field} must be a non-empty string.`);
    }
  }

  const optionalStrings = ["lintCommand", "testCommand", "gitnexusRepo"] as const;
  for (const field of optionalStrings) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      throw new AgentLoopError("invalid_config", `Config ${field} must be a string.`);
    }
  }

  if (!WORKER_BACKENDS.includes(config.workerBackend)) {
    throw new AgentLoopError("invalid_config", "Config workerBackend is invalid.");
  }
  if (!AUTONOMY_MODES.includes(config.autonomyMode)) {
    throw new AgentLoopError("invalid_config", "Config autonomyMode is invalid.");
  }
  if (!MERGE_MODES.includes(config.mergeMode)) {
    throw new AgentLoopError("invalid_config", "Config mergeMode is invalid.");
  }
  if (!NOTIFY_MODES.includes(config.notifyMode)) {
    throw new AgentLoopError("invalid_config", "Config notifyMode is invalid.");
  }
  if (!REVIEW_HANDLING_MODES.includes(config.reviewHandling)) {
    throw new AgentLoopError("invalid_config", "Config reviewHandling is invalid.");
  }
  if (!LOCALE_SETTINGS.includes(config.locale)) {
    throw new AgentLoopError("invalid_config", "Config locale is invalid.");
  }
  if (!loopShapeIds().includes(config.loopShape)) {
    throw new AgentLoopError("invalid_config", "Config loopShape is invalid.");
  }
  if (!WORKFLOW_PROFILE_IDS.includes(config.workflowProfile)) {
    throw new AgentLoopError("invalid_config", "Config workflowProfile is invalid.");
  }
  if (!ROLE_PROFILE_IDS.includes(config.roleProfile)) {
    throw new AgentLoopError("invalid_config", "Config roleProfile is invalid.");
  }
  resolveProfile(config);
  if (config.carryoverTarget !== undefined && typeof config.carryoverTarget !== "string") {
    throw new AgentLoopError("invalid_config", "Config carryoverTarget must be a string.");
  }

  const booleans = ["gitnexusRequired", "requireReviewApproval", "allowAutoMerge", "workerEphemeral"] as const;
  for (const field of booleans) {
    if (typeof config[field] !== "boolean") {
      throw new AgentLoopError("invalid_config", `Config ${field} must be a boolean.`);
    }
  }

  const numbers = ["maxReviewFixRounds", "maxTestFixRounds", "maxCiReruns", "workerMaxRetries"] as const;
  for (const field of numbers) {
    if (!Number.isInteger(config[field]) || config[field] < 0) {
      throw new AgentLoopError("invalid_config", `Config ${field} must be a non-negative integer.`);
    }
  }

  const positiveNumbers = [
    "commandTimeoutMs",
    "commandOutputLimitBytes",
    "githubRetryMaxAttempts",
    "githubRetryBaseDelayMs",
    "reviewCiPollIntervalMs",
    "reviewCiMaxWaitMs",
    "workerTimeoutMs"
  ] as const;
  for (const field of positiveNumbers) {
    if (!Number.isInteger(config[field]) || config[field] < 1) {
      throw new AgentLoopError("invalid_config", `Config ${field} must be a positive integer.`);
    }
  }

  if (!Array.isArray(config.requiredChecks) || !config.requiredChecks.every(isString)) {
    throw new AgentLoopError("invalid_config", "Config requiredChecks must be a string array.");
  }
  if (!Array.isArray(config.protectedPaths) || !config.protectedPaths.every(isString)) {
    throw new AgentLoopError("invalid_config", "Config protectedPaths must be a string array.");
  }
  if (config.dashboard) {
    assertKnownDashboardKeys(config.dashboard);
    if (
      typeof config.dashboard.enabled !== "boolean" ||
      typeof config.dashboard.host !== "string" ||
      config.dashboard.host.length === 0
    ) {
      throw new AgentLoopError("invalid_config", "Config dashboard is invalid.");
    }
    if (
      config.dashboard.port !== undefined &&
      (!Number.isInteger(config.dashboard.port) ||
        config.dashboard.port < 1 ||
        config.dashboard.port > 65_535)
    ) {
      throw new AgentLoopError("invalid_config", "Config dashboard.port is invalid.");
    }
  }

  return config;
}

function assertKnownTopLevelKeys(value: Record<string, unknown>): void {
  const allowed = new Set([
    "repoId",
    "locale",
    "loopShape",
    "workflowProfile",
    "roleProfile",
    "baseBranch",
    "branchPrefix",
    "plansDir",
    "lintCommand",
    "testCommand",
    "gitnexusRepo",
    "gitnexusRequired",
    "requiredChecks",
    "requireReviewApproval",
    "autonomyMode",
    "mergeMode",
    "notifyMode",
    "reviewHandling",
    "carryoverTarget",
    "allowAutoMerge",
    "maxReviewFixRounds",
    "maxTestFixRounds",
    "maxCiReruns",
    "commandTimeoutMs",
    "commandOutputLimitBytes",
    "githubRetryMaxAttempts",
    "githubRetryBaseDelayMs",
    "reviewCiPollIntervalMs",
    "reviewCiMaxWaitMs",
    "workerBackend",
    "workerTimeoutMs",
    "workerMaxRetries",
    "workerEphemeral",
    "protectedPaths",
    "dashboard"
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new AgentLoopError("invalid_config", "Config contains unknown fields.", {
      details: { fields: unknown }
    });
  }
}

function assertKnownDashboardKeys(value: Record<string, unknown>): void {
  const allowed = new Set(["enabled", "host", "port"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new AgentLoopError("invalid_config", "Config dashboard contains unknown fields.", {
      details: { fields: unknown }
    });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
