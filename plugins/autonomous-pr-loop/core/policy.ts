import { AgentLoopError } from "./errors.js";
import type { AgentLoopConfig } from "./types.js";

/** Assert that a path is not blocked by the repository policy protectedPaths globs. */
export function assertAllowedPath(config: AgentLoopConfig, path: string): void {
  const blocked = config.protectedPaths.some((pattern) => matchesProtectedPath(pattern, path));

  if (blocked) {
    throw new AgentLoopError(
      "policy_violation",
      `Path is protected by agent-loop policy: ${path}`,
      { details: { path } }
    );
  }
}

/** Match the small glob subset used by protectedPaths: `*`, `**`, and `/**` directory roots. */
export function matchesProtectedPath(pattern: string, path: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const normalizedPath = normalizePath(path);
  if (!normalizedPattern.includes("/")) {
    const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
    return globToRegExp(normalizedPattern).test(basename);
  }
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (normalizedPath === prefix) {
      return true;
    }
  }
  return globToRegExp(normalizedPattern).test(normalizedPath);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
