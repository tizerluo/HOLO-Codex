import { execFileSync } from "node:child_process";
import type { AgentLoopConfig } from "./types.js";
import { AgentLoopError } from "./errors.js";

export interface GitHubPullRequest {
  number: number;
  url: string;
  title?: string;
  body?: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  mergedAt?: string | null;
  reviewDecision?: string;
  statusCheckRollup?: unknown[];
}

export interface GitHubCommandOptions {
  repoRoot: string;
  config: AgentLoopConfig;
  signal?: AbortSignal;
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              id
              url
              body
              path
              line
              diffHunk
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}`;

/** Verify the current gh CLI session can access GitHub. */
export function checkGhAuth(repoRoot: string): void {
  runGh(repoRoot, ["auth", "status"]);
}

/** List pull requests for a head branch. */
export async function listPullRequestsByHead(options: GitHubCommandOptions, branch: string): Promise<GitHubPullRequest[]> {
  const stdout = await runGhJson(options, [
    "pr",
    "list",
    "--head",
    branch,
    "--json",
    "number,url,title,body,headRefName,baseRefName,state,isDraft,mergedAt"
  ]);
  return parseJson(stdout, "Could not parse gh pr list output.") as GitHubPullRequest[];
}

/** List recent pull requests for the configured repository. */
export function listPullRequests(options: GitHubCommandOptions): GitHubPullRequest[] {
  const stdout = runGh(options.repoRoot, [
    "pr",
    "list",
    "--state",
    "all",
    "--limit",
    "100",
    "--json",
    "number,url,title,body,headRefName,baseRefName,state,isDraft,mergedAt"
  ]);
  return parseJson(stdout, "Could not parse gh pr list output.") as GitHubPullRequest[];
}

/** List open pull requests for the configured repository. */
export function listOpenPullRequests(options: GitHubCommandOptions): GitHubPullRequest[] {
  const stdout = runGh(options.repoRoot, [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number,url,title,body,headRefName,baseRefName,state,isDraft,mergedAt"
  ]);
  return parseJson(stdout, "Could not parse gh pr list output.") as GitHubPullRequest[];
}

/** Read a pull request by number with fields needed by PR C. */
export async function viewPullRequest(options: GitHubCommandOptions, prNumber: number): Promise<GitHubPullRequest> {
  const stdout = await runGhJson(options, [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,url,headRefName,baseRefName,state,isDraft,mergedAt,reviewDecision,statusCheckRollup"
  ]);
  return parseJson(stdout, "Could not parse gh pr view output.") as GitHubPullRequest;
}

/** Fetch PR reviewThreads through GitHub GraphQL for comment-level state. */
export async function fetchReviewThreads(options: GitHubCommandOptions, prNumber: number): Promise<unknown> {
  const [owner, name] = options.config.repoId.split("/");
  if (!owner || !name) {
    throw new AgentLoopError("invalid_config", "Config repoId must be owner/repo.");
  }
  const stdout = await runGhJson(options, [
    "api",
    "graphql",
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${prNumber}`
  ]);
  return parseJson(stdout, "Could not parse gh GraphQL output.");
}

/** Create a draft pull request and return the new URL. */
export function createDraftPullRequest(options: GitHubCommandOptions, input: {
  title: string;
  body: string;
  head: string;
  base: string;
}): string {
  return runGh(options.repoRoot, [
    "pr",
    "create",
    "--draft",
    "--title",
    input.title,
    "--body",
    input.body,
    "--head",
    input.head,
    "--base",
    input.base
  ]);
}

/** Add a PR comment. */
export function commentOnPullRequest(repoRoot: string, prNumber: number, body: string): void {
  runGh(repoRoot, ["pr", "comment", String(prNumber), "--body", body]);
}

/** Mark a draft PR ready for review. */
export function markPullRequestReady(repoRoot: string, prNumber: number): void {
  runGh(repoRoot, ["pr", "ready", String(prNumber)]);
}

/** Merge a PR only when the caller has already passed all PR C guards. */
export function mergePullRequest(repoRoot: string, prNumber: number): void {
  runGh(repoRoot, ["pr", "merge", String(prNumber), "--merge"]);
}

/** Run a gh read command with transient retry handling. */
export async function runGhJson(
  options: GitHubCommandOptions,
  args: string[],
  signal = options.signal
): Promise<string> {
  let lastError: unknown;
  const attempts = options.config.githubRetryMaxAttempts;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return runGh(options.repoRoot, args);
    } catch (error) {
      lastError = error;
      if (!(error instanceof AgentLoopError) || error.code !== "github_transient_failure") {
        throw error;
      }
      if (attempt < attempts) {
        await sleep(options.config.githubRetryBaseDelayMs * 2 ** (attempt - 1), signal);
      }
    }
  }
  if (lastError instanceof AgentLoopError) {
    throw lastError;
  }
  throw new AgentLoopError("github_transient_failure", "GitHub command failed after retries.", {
    details: { args },
    exitCode: 2
  });
}

/** Run gh without shell interpretation and normalize common failure classes. */
export function runGh(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("gh", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    throw classifyGhError(error, args);
  }
}

function classifyGhError(error: unknown, args: string[]): AgentLoopError {
  const detail = error as { stderr?: string; stdout?: string; message?: string; status?: number };
  const text = `${detail.stderr ?? ""}\n${detail.stdout ?? ""}\n${detail.message ?? ""}`.toLowerCase();
  const details = { args, status: detail.status, stderr: detail.stderr };
  if (text.includes("not logged") || text.includes("authentication") || text.includes("http 401")) {
    return new AgentLoopError("needs_secret_or_login", "GitHub CLI authentication is required.", {
      details,
      exitCode: 2
    });
  }
  if (isResourceLookup(args) && (text.includes("not found") || text.includes("could not resolve"))) {
    return new AgentLoopError("github_resource_not_found", "GitHub resource was not found.", {
      details: { ...details, classification: "not_found" }
    });
  }
  if (
    text.includes("rate limit") ||
    text.includes("secondary rate") ||
    text.includes("network") ||
    text.includes("timed out") ||
    text.includes("http 5")
  ) {
    return new AgentLoopError("github_transient_failure", "GitHub transient failure.", {
      details,
      exitCode: 2
    });
  }
  return new AgentLoopError("storage_error", "GitHub CLI command failed.", { details });
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new AgentLoopError("storage_error", message, {
      details: { cause: error instanceof Error ? error.message : String(error) }
    });
  }
}

function isResourceLookup(args: string[]): boolean {
  return args[0] === "pr" || (args[0] === "api" && args[1] === "graphql");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new AgentLoopError("github_transient_failure", "GitHub retry was aborted.", { exitCode: 2 }));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
