import { execFileSync } from "node:child_process";
import type { AgentLoopStorage } from "./types.js";
import { AgentLoopError } from "./errors.js";
import { redactRemote } from "./command.js";

/** Result of a git side-effect that may safely no-op on resume. */
export interface GitLifecycleResult {
  skipped: boolean;
  message: string;
  branch?: string;
}

/** Return the current checked-out branch name. */
export function getCurrentBranch(repoRoot: string): string {
  return git(repoRoot, ["branch", "--show-current"]);
}

/** Return true when the worktree has no staged or unstaged changes. */
export function isWorktreeClean(repoRoot: string): boolean {
  return git(repoRoot, ["status", "--short"]).length === 0;
}

/** Return the configured origin remote URL. */
export function getOriginRemote(repoRoot: string): string {
  return git(repoRoot, ["remote", "get-url", "origin"]);
}

/** Ensure origin points at GitHub, or raise the unsupported remote gate. */
export function assertGitHubRemote(repoRoot: string): void {
  const remote = getOriginRemote(repoRoot);
  if (!remote.includes("github.com")) {
    throw new AgentLoopError("unsupported_remote", "origin remote is not a GitHub remote.", {
      details: { remote: redactRemote(remote) },
      exitCode: 2
    });
  }
}

/** Synchronize the base branch using only checkout plus ff-only pull. */
export function syncBaseBranch(repoRoot: string, baseBranch: string): GitLifecycleResult {
  assertGitHubRemote(repoRoot);
  if (!isWorktreeClean(repoRoot)) {
    throw new AgentLoopError("dirty_unowned_worktree", "Worktree must be clean before syncing base branch.", {
      details: { baseBranch },
      exitCode: 2
    });
  }
  git(repoRoot, ["checkout", baseBranch]);
  git(repoRoot, ["pull", "--ff-only", "origin", baseBranch]);
  return { skipped: false, message: `Synced ${baseBranch}.`, branch: baseBranch };
}

/** Create or restore a lifecycle branch without silently overwriting unrelated branches. */
export function createBranch(
  repoRoot: string,
  branchName: string,
  options: { storage?: AgentLoopStorage; runId?: string } = {}
): GitLifecycleResult {
  const linked = options.runId && options.storage ? options.storage.getPrLink(options.runId) : undefined;
  if (branchExists(repoRoot, branchName)) {
    if (linked?.branch === branchName) {
      git(repoRoot, ["checkout", branchName]);
      recordDecision(options, "branch_reused", `Reused branch ${branchName}.`, { branchName });
      return { skipped: true, message: `Reused current run branch ${branchName}.`, branch: branchName };
    }
    const suffixed = nextAvailableBranch(repoRoot, branchName);
    git(repoRoot, ["checkout", "-b", suffixed]);
    recordDecision(options, "branch_renamed", `Created suffixed branch ${suffixed}.`, {
      requested: branchName,
      actual: suffixed
    });
    return { skipped: false, message: `Created ${suffixed}.`, branch: suffixed };
  }
  git(repoRoot, ["checkout", "-b", branchName]);
  return { skipped: false, message: `Created ${branchName}.`, branch: branchName };
}

/** Stage a constrained list of paths. */
export function stagePaths(repoRoot: string, paths: string[]): GitLifecycleResult {
  if (paths.length === 0) {
    return { skipped: true, message: "No paths to stage." };
  }
  git(repoRoot, ["add", "--", ...paths]);
  return { skipped: false, message: `Staged ${paths.length} paths.` };
}

/** Commit staged changes when there is an actual staged diff. */
export function commit(repoRoot: string, message: string): GitLifecycleResult {
  if (!hasStagedDiff(repoRoot)) {
    return { skipped: true, message: "No staged diff to commit." };
  }
  git(repoRoot, ["commit", "-m", message]);
  return { skipped: false, message };
}

/** Push a branch unless the local and remote refs already match. */
export function pushBranch(repoRoot: string, branchName: string): GitLifecycleResult {
  const local = git(repoRoot, ["rev-parse", branchName]);
  const remote = tryGit(repoRoot, ["rev-parse", `origin/${branchName}`]);
  if (remote && remote === local) {
    return { skipped: true, message: `origin/${branchName} already matches local.`, branch: branchName };
  }
  git(repoRoot, ["push", "-u", "origin", branchName]);
  return { skipped: false, message: `Pushed ${branchName}.`, branch: branchName };
}

/** Return changed files relative to an optional base ref. */
export function getChangedFiles(repoRoot: string, baseRef?: string): string[] {
  if (baseRef) {
    return git(repoRoot, ["diff", "--name-only", baseRef]).split("\n").filter(Boolean);
  }
  return git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((line) => parsePorcelainPath(line))
    .filter((path, index, paths) => path.length > 0 && paths.indexOf(path) === index);
}

/** Execute a safe git command without shell interpretation. */
export function git(repoRoot: string, args: string[]): string {
  rejectUnsafeGit(args);
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function tryGit(repoRoot: string, args: string[]): string | undefined {
  try {
    return git(repoRoot, args);
  } catch {
    return undefined;
  }
}

function branchExists(repoRoot: string, branchName: string): boolean {
  return (
    Boolean(tryGit(repoRoot, ["rev-parse", "--verify", branchName])) ||
    Boolean(tryGit(repoRoot, ["ls-remote", "--heads", "origin", branchName]))
  );
}

function nextAvailableBranch(repoRoot: string, branchName: string): string {
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${branchName}-${index}`;
    if (!branchExists(repoRoot, candidate)) {
      return candidate;
    }
  }
  throw new AgentLoopError("policy_violation", "Could not find an available branch suffix.", {
    details: { branchName },
    exitCode: 2
  });
}

function hasStagedDiff(repoRoot: string): boolean {
  try {
    git(repoRoot, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

function parsePorcelainPath(line: string): string {
  const renamed = line.slice(3).split(" -> ");
  return (renamed.at(-1) ?? "").trim().replace(/^"|"$/g, "");
}

function recordDecision(
  options: { storage?: AgentLoopStorage; runId?: string },
  kind: string,
  message: string,
  details: unknown
): void {
  if (options.storage && options.runId) {
    options.storage.appendDecision({ runId: options.runId, kind, message, details });
  }
}

function rejectUnsafeGit(args: string[]): void {
  const command = stripGitGlobalOptions(args);
  if (command[0] === "reset" && command.includes("--hard")) {
    throw new AgentLoopError("policy_violation", "git reset --hard is not allowed.", { exitCode: 2 });
  }
  if (command[0] === "clean") {
    throw new AgentLoopError("policy_violation", "git clean is not allowed.", { exitCode: 2 });
  }
  if (command[0] === "rebase") {
    throw new AgentLoopError("policy_violation", "git rebase is not allowed.", { exitCode: 2 });
  }
  if (command[0] === "push" && command.some((arg) => arg === "-f" || arg.startsWith("--force"))) {
    throw new AgentLoopError("policy_violation", "force push is not allowed.", { exitCode: 2 });
  }
}

function stripGitGlobalOptions(args: string[]): string[] {
  const result = [...args];
  while (result.length > 0) {
    const first = result[0];
    if (first === "-C" || first === "--git-dir" || first === "--work-tree") {
      result.splice(0, 2);
      continue;
    }
    if (first?.startsWith("--git-dir=") || first?.startsWith("--work-tree=")) {
      result.shift();
      continue;
    }
    break;
  }
  return result;
}
