import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { CODEX_HOOK_EVENTS } from "./hook-events.js";
import { redactSecrets } from "./redaction.js";

export const LEGACY_PRIVATE_REPO_MARKER = "codex-auto-PR-loop-plusin";
const BINARY_READ_LIMIT_BYTES = 128 * 1024;

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
  readTruncated?: boolean;
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
  let readTruncated = false;
  if (path && existsSync(path)) {
    try {
      const result = readTextPrefix(path, BINARY_READ_LIMIT_BYTES);
      text = result.text;
      readTruncated = result.truncated;
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
    ...(readError ? { readError } : {}),
    ...(readTruncated ? { readTruncated } : {})
  };
}

export function commandsReferencingLegacyPrivateRepo(commands: string[]): string[] {
  return commands
    .filter((command) => command.includes(LEGACY_PRIVATE_REPO_MARKER))
    .map(redactDiagnosticText);
}

export function redactDiagnosticText(value: string): string {
  return redactLegacyPrivateRepoPaths(redactSecrets(value));
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

function redactLegacyPrivateRepoPaths(value: string): string {
  const marker = escapeRegExp(LEGACY_PRIVATE_REPO_MARKER);
  const unixPath = new RegExp(`(?:/[^\\s'"=]+)*/${marker}(?:/[^\\s'"]*)?`, "g");
  const windowsPath = new RegExp(`(?:[A-Za-z]:\\\\[^\\s'"=]+\\\\)*${marker}(?:\\\\[^\\s'"]*)?`, "g");
  return value
    .replace(unixPath, "<legacy-private-repo-path>")
    .replace(windowsPath, "<legacy-private-repo-path>");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readTextPrefix(path: string, limitBytes: number): { text: string; truncated: boolean } {
  const size = statSync(path).size;
  const length = Math.min(size, limitBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: size > bytesRead
    };
  } finally {
    closeSync(fd);
  }
}
