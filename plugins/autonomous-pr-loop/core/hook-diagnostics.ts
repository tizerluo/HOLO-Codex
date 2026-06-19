import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CODEX_HOOK_EVENTS } from "./hook-events.js";
import { redactSecrets } from "./redaction.js";

export const LEGACY_PRIVATE_REPO_MARKER = "codex-auto-PR-loop-plusin";

export interface BundledHooksConfigInspection {
  path: string;
  valid: boolean;
  legacyTopLevelEvents: string[];
  error?: string;
}

export interface AgentLoopBinaryInspection {
  path?: string;
  realPath?: string;
  expectedPackageRoot: string;
  pointsToExpectedPackage: boolean;
  referencesExpectedPackage: boolean;
  legacyPrivateRepoReferences: string[];
  readError?: string;
}

/** Inspect the plugin-bundled Codex hooks config without mutating plugin cache or user config. */
export function inspectBundledHooksConfig(packageRoot: string): BundledHooksConfigInspection {
  const path = join(packageRoot, "plugins", "autonomous-pr-loop", "hooks", "hooks.json");
  if (!existsSync(path)) {
    return {
      path,
      valid: false,
      legacyTopLevelEvents: [],
      error: "missing bundled hooks config"
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return { path, valid: false, legacyTopLevelEvents: [], error: "expected JSON object" };
    }
    const legacyTopLevelEvents = CODEX_HOOK_EVENTS.filter((event) => event in parsed);
    if (!isRecord(parsed.hooks)) {
      return {
        path,
        valid: false,
        legacyTopLevelEvents,
        error: "expected top-level hooks object"
      };
    }
    return {
      path,
      valid: legacyTopLevelEvents.length === 0,
      legacyTopLevelEvents,
      ...(legacyTopLevelEvents.length > 0 ? { error: "legacy top-level hook events are not valid bundled hook config" } : {})
    };
  } catch (error) {
    return {
      path,
      valid: false,
      legacyTopLevelEvents: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** Inspect the first PATH agent-loop binary for source-install drift. */
export function inspectAgentLoopBinary(expectedPackageRoot: string): AgentLoopBinaryInspection {
  const path = firstPathBinary("agent-loop");
  const realPath = path && existsSync(path) ? realpathSync(path) : undefined;
  let text = "";
  let readError: string | undefined;
  if (path && existsSync(path)) {
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
  }
  const referencesExpectedPackage = text.includes(expectedPackageRoot);
  const legacyPrivateRepoReferences = [
    ...(path?.includes(LEGACY_PRIVATE_REPO_MARKER) ? [path] : []),
    ...(realPath?.includes(LEGACY_PRIVATE_REPO_MARKER) ? [realPath] : []),
    ...text.split(/\r?\n/).filter((line) => line.includes(LEGACY_PRIVATE_REPO_MARKER))
  ].map(redactDiagnosticText);
  return {
    ...(path ? { path } : {}),
    ...(realPath ? { realPath } : {}),
    expectedPackageRoot,
    pointsToExpectedPackage: (realPath ? realPath.startsWith(expectedPackageRoot) : false) || referencesExpectedPackage,
    referencesExpectedPackage,
    legacyPrivateRepoReferences,
    ...(readError ? { readError } : {})
  };
}

export function commandsReferencingLegacyPrivateRepo(commands: string[]): string[] {
  return commands
    .filter((command) => command.includes(LEGACY_PRIVATE_REPO_MARKER))
    .map(redactDiagnosticText);
}

export function redactDiagnosticText(value: string): string {
  return redactSecrets(value);
}

function firstPathBinary(name: string): string | undefined {
  try {
    const output = execFileSync("sh", ["-lc", `command -v ${name} || true`], { encoding: "utf8" }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
