import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { AgentLoopError } from "./errors.js";

/** Resolve a path inside a git repository to its canonical repository root. */
export function resolveRepoRoot(path: string): string {
  const targetPath = resolve(path);
  try {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: targetPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return realpathSync(repoRoot);
  } catch {
    throw new AgentLoopError("not_git_repo", "Target path is not inside a git repository.", {
      details: { targetPath },
      exitCode: 2
    });
  }
}
