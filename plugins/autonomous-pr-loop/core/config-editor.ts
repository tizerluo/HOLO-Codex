import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { configPath, loadConfig, statePath, validateConfig } from "./config.js";
import { AgentLoopError } from "./errors.js";
import { SqliteAgentLoopStorage } from "./storage.js";
import type { AgentLoopConfig } from "./types.js";

export interface ConfigEditorSnapshot {
  path: string;
  hash: string;
  mtimeMs: number;
  config: AgentLoopConfig;
}

export interface ConfigDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
  risk: "low" | "high";
}

export interface SaveConfigInput {
  nextConfig: AgentLoopConfig;
  expectedHash: string;
  note?: string;
  confirmationToken?: string;
}

/** Read config with a content hash so dashboard saves cannot silently overwrite edits. */
export function readConfigForEdit(repoRoot: string): ConfigEditorSnapshot {
  const loaded = loadConfig(repoRoot);
  const raw = readFileSync(loaded.path, "utf8");
  return {
    path: loaded.path,
    hash: sha256(raw),
    mtimeMs: statSync(loaded.path).mtimeMs,
    config: loaded.config
  };
}

/** Compute a stable field-level diff for policy review before save. */
export function diffConfig(before: AgentLoopConfig, after: AgentLoopConfig): ConfigDiffEntry[] {
  return Object.keys({ ...before, ...after })
    .filter((field) => JSON.stringify(before[field as keyof AgentLoopConfig]) !== JSON.stringify(after[field as keyof AgentLoopConfig]))
    .map((field) => ({
      field,
      before: before[field as keyof AgentLoopConfig],
      after: after[field as keyof AgentLoopConfig],
      risk: highRiskFields.has(field) ? "high" : "low"
    }));
}

export interface SaveConfigResult {
  config: AgentLoopConfig;
  diff: ConfigDiffEntry[];
  snapshot: ConfigEditorSnapshot;
}

/** Validate and save dashboard config changes with policy notes and audit events. */
export function saveConfigEdit(repoRoot: string, input: SaveConfigInput): SaveConfigResult {
  const snapshot = readConfigForEdit(repoRoot);
  if (snapshot.hash !== input.expectedHash) {
    throw new AgentLoopError("invalid_config", "Config changed on disk; reload before saving.");
  }
  const config = validateConfig(input.nextConfig);
  const diff = diffConfig(snapshot.config, config);
  assertPolicySaveAllowed(diff, config, input.note, input.confirmationToken);
  writeFileSync(configPath(repoRoot), `${JSON.stringify(config, null, 2)}\n`);
  auditConfigSave(repoRoot, diff, input.note);
  return { config, diff, snapshot: readConfigForEdit(repoRoot) };
}

function assertPolicySaveAllowed(
  diff: ConfigDiffEntry[],
  config: AgentLoopConfig,
  note: string | undefined,
  confirmationToken: string | undefined
): void {
  const hasHighRisk = diff.some((entry) => entry.risk === "high");
  if (hasHighRisk && !note?.trim()) {
    throw new AgentLoopError("invalid_config", "High-risk policy changes require an operator note.");
  }
  if (requiresExplicitConfirmation(diff) && confirmationToken?.trim() !== "CONFIRM") {
    throw new AgentLoopError("invalid_config", "Dangerous policy changes require confirmation token CONFIRM.");
  }
  if (!config.gitnexusRequired && !note?.trim()) {
    throw new AgentLoopError("invalid_config", "Disabling GitNexus required needs a note.");
  }
  if (config.reviewHandling === "fix_scoped_and_carry_forward" && !config.carryoverTarget?.trim()) {
    throw new AgentLoopError("invalid_config", "Carryover review handling requires a carryover target.");
  }
}

function requiresExplicitConfirmation(diff: ConfigDiffEntry[]): boolean {
  return diff.some((entry) =>
    (entry.field === "mergeMode" && entry.after === "conditional") ||
    (entry.field === "requireReviewApproval" && entry.after === false)
  );
}

function auditConfigSave(repoRoot: string, diff: ConfigDiffEntry[], note: string | undefined): void {
  if (!existsSync(statePath(repoRoot))) {
    return;
  }
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    storage.writeRepoConfig(loadConfig(repoRoot).config);
    const run = storage.getCurrentRun();
    const message = `Dashboard config changed ${diff.length} field(s).`;
    storage.appendEvent({
      ...(run ? { runId: run.id } : {}),
      kind: "config_changed",
      message,
      payload: { diff, note: note ?? "" }
    });
    if (run) {
      storage.appendDecision({
        runId: run.id,
        kind: "config_changed",
        message,
        details: { diff, note: note ?? "" }
      });
    }
  } finally {
    storage.close();
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const highRiskFields = new Set([
  "mergeMode",
  "requireReviewApproval",
  "gitnexusRequired",
  "protectedPaths",
  "reviewHandling",
  "carryoverTarget"
]);
