import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactRemote, runCommand, type CommandResult } from "./command.js";

export type ReleaseDoctorStatus = "pass" | "warn" | "fail";

export interface ReleaseDoctorCheck {
  id: string;
  label: string;
  status: ReleaseDoctorStatus;
  message: string;
  details?: unknown;
}

export interface ReleaseDoctorReport {
  ok: boolean;
  status: ReleaseDoctorStatus;
  targetRepoRoot: string;
  version: string;
  tag: string;
  checks: ReleaseDoctorCheck[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
    releaseBlockers: number;
    openPullRequests: number;
  };
}

export interface ReleaseDoctorOptions {
  version?: string;
  tag?: string;
  packageRoot?: string;
  commandRunner?: (file: string, args: string[], cwd: string) => CommandResult;
}

interface GitHubIssue {
  number?: number;
  title?: string;
  body?: string;
  url?: string;
  labels?: Array<{ name?: string }>;
}

interface GitHubPullRequest {
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
}

const PACKAGE_NAME = "holo-codex";
const RELEASE_BLOCKER_LABELS = new Set(["release-blocker", "blocker", "p0", "p1"]);
const HOOK_SOURCE_FILES = [
  "pre-tool-use",
  "post-tool-use",
  "user-prompt-submit",
  "stop",
  "session-start",
  "pre-compact",
  "post-compact",
  "permission-request"
];
const RELEASE_WORKFLOW_MARKERS = [
  "workflow_dispatch",
  "version:",
  "tag:",
  "dry_run:",
  "pnpm lint",
  "vitest run",
  "pnpm build:hooks",
  "npm pack --ignore-scripts --json",
  "Tarball install smoke",
  "npm publish"
];

/** Build a read-only release readiness report for the current release checkout. */
export function runReleaseDoctor(repoRoot: string, options: ReleaseDoctorOptions = {}): ReleaseDoctorReport {
  const packageRoot = options.packageRoot ?? repoRoot;
  const commandRunner = options.commandRunner ?? runCommand;
  const version = options.version ?? readJsonVersion(join(packageRoot, "package.json")) ?? "unknown";
  const tag = options.tag ?? `v${version}`;
  const checks: ReleaseDoctorCheck[] = [];

  const origin = commandRunner("git", ["remote", "get-url", "origin"], repoRoot);
  const repoId = origin.ok ? parseGitHubRepoId(origin.stdout) : undefined;
  const gitBaseline = checkGitBaseline(repoRoot, commandRunner);
  checks.push(gitBaseline);
  checks.push(checkGitHubRemote(origin, repoId));

  const defaultBranch = repoId ? readGitHubDefaultBranch(repoRoot, repoId, commandRunner) : undefined;
  checks.push(checkDefaultBranchHead(repoRoot, defaultBranch, commandRunner));

  const openIssues = repoId ? readOpenIssues(repoRoot, repoId, commandRunner) : { status: "warn" as const, issues: [], message: "GitHub repo id was unavailable." };
  checks.push(checkReleaseBlockingIssues(openIssues));
  const openPrs = repoId ? readOpenPullRequests(repoRoot, repoId, commandRunner) : { status: "warn" as const, prs: [], message: "GitHub repo id was unavailable." };
  checks.push(checkOpenPullRequests(openPrs));
  checks.push(repoId ? checkGitHubRelease(repoRoot, repoId, tag, commandRunner) : warn("github_release", "GitHub release", "GitHub repo id was unavailable; release existence was not checked."));
  checks.push(checkGitTag(repoRoot, tag, commandRunner));
  checks.push(checkNpmVersion(repoRoot, version, commandRunner));
  checks.push(checkVersionMetadata(packageRoot, version));
  checks.push(checkGeneratedDist(packageRoot));
  checks.push(checkReleaseWorkflow(packageRoot));
  checks.push(checkRequiredEntrypoints(packageRoot));

  return buildReport(repoRoot, version, tag, checks, {
    releaseBlockers: openIssues.issues.filter(isReleaseBlockingIssue).length,
    openPullRequests: openPrs.prs.length
  });
}

function checkGitBaseline(repoRoot: string, commandRunner: NonNullable<ReleaseDoctorOptions["commandRunner"]>): ReleaseDoctorCheck {
  const branch = commandRunner("git", ["branch", "--show-current"], repoRoot);
  const status = commandRunner("git", ["status", "--short"], repoRoot);
  const head = commandRunner("git", ["rev-parse", "HEAD"], repoRoot);
  const originMain = commandRunner("git", ["rev-parse", "origin/main"], repoRoot);
  const failures: string[] = [];
  if (!branch.ok) failures.push("current branch unavailable");
  if (branch.ok && branch.stdout !== "main") failures.push(`current branch is ${branch.stdout || "detached"}, expected main`);
  if (!status.ok) failures.push("worktree status unavailable");
  if (status.ok && status.stdout.trim().length > 0) failures.push("worktree is not clean");
  if (!head.ok || !originMain.ok) failures.push("HEAD or origin/main unavailable");
  if (head.ok && originMain.ok && head.stdout !== originMain.stdout) failures.push("HEAD does not match origin/main");
  if (failures.length > 0) {
    return fail("git_baseline", "Git baseline", `Release checkout is not ready: ${failures.join("; ")}.`, {
      branch: branch.ok ? branch.stdout : undefined,
      head: head.ok ? head.stdout : undefined,
      originMain: originMain.ok ? originMain.stdout : undefined
    });
  }
  return pass("git_baseline", "Git baseline", "Current branch is main, worktree is clean, and HEAD matches origin/main.", {
    branch: branch.stdout,
    head: head.stdout
  });
}

function checkGitHubRemote(origin: CommandResult, repoId: string | undefined): ReleaseDoctorCheck {
  if (!origin.ok) {
    return fail("github_remote", "GitHub remote", "Could not read origin remote.", { stderr: redactReleaseDiagnostic(origin.stderr) });
  }
  if (!repoId) {
    return fail("github_remote", "GitHub remote", "Origin remote is not a recognized GitHub repository.", {
      remote: redactRemote(origin.stdout)
    });
  }
  return pass("github_remote", "GitHub remote", "Origin remote points at GitHub.", { repoId });
}

function readGitHubDefaultBranch(repoRoot: string, repoId: string, commandRunner: NonNullable<ReleaseDoctorOptions["commandRunner"]>): { status: ReleaseDoctorStatus; branch?: string; message?: string } {
  const result = commandRunner("gh", ["repo", "view", repoId, "--json", "defaultBranchRef,nameWithOwner"], repoRoot);
  if (!result.ok) {
    return { status: "warn", message: "GitHub default branch could not be read." };
  }
  const parsed = parseJsonObject(result.stdout);
  const branch = readNestedString(parsed, ["defaultBranchRef", "name"]);
  return branch ? { status: "pass", branch } : { status: "warn", message: "GitHub default branch payload was not recognized." };
}

function checkDefaultBranchHead(repoRoot: string, defaultBranch: { status: ReleaseDoctorStatus; branch?: string; message?: string } | undefined, commandRunner: NonNullable<ReleaseDoctorOptions["commandRunner"]>): ReleaseDoctorCheck {
  if (!defaultBranch) {
    return warn("github_default_branch", "GitHub default branch", "GitHub repo id was unavailable; default branch was not checked.");
  }
  if (defaultBranch.status !== "pass" || !defaultBranch.branch) {
    return warn("github_default_branch", "GitHub default branch", defaultBranch.message ?? "GitHub default branch was not checked.");
  }
  const head = commandRunner("git", ["rev-parse", "HEAD"], repoRoot);
  const remote = commandRunner("git", ["ls-remote", "origin", `refs/heads/${defaultBranch.branch}`], repoRoot);
  const remoteHead = remote.stdout.split(/\s+/)[0] ?? "";
  if (!head.ok || !remote.ok || remoteHead.length === 0) {
    return warn("github_default_branch", "GitHub default branch", `Could not verify origin/${defaultBranch.branch}.`, {
      branch: defaultBranch.branch,
      stderr: redactReleaseDiagnostic(remote.stderr)
    });
  }
  if (head.stdout !== remoteHead) {
    return fail("github_default_branch", "GitHub default branch", `HEAD does not match origin/${defaultBranch.branch}.`, {
      branch: defaultBranch.branch,
      head: head.stdout,
      remoteHead
    });
  }
  return pass("github_default_branch", "GitHub default branch", `HEAD matches origin/${defaultBranch.branch}.`, {
    branch: defaultBranch.branch,
    head: head.stdout
  });
}

function readOpenIssues(repoRoot: string, repoId: string, commandRunner: NonNullable<ReleaseDoctorOptions["commandRunner"]>): { status: ReleaseDoctorStatus; issues: GitHubIssue[]; message?: string } {
  const result = commandRunner("gh", ["issue", "list", "--repo", repoId, "--state", "open", "--json", "number,title,body,url,labels"], repoRoot);
  if (!result.ok) {
    return { status: "warn", issues: [], message: "Open issues could not be read." };
  }
  const parsed = parseJsonArray(result.stdout) as GitHubIssue[] | undefined;
  return parsed ? { status: "pass", issues: parsed } : { status: "warn", issues: [], message: "Open issue payload was not recognized." };
}

function checkReleaseBlockingIssues(input: { status: ReleaseDoctorStatus; issues: GitHubIssue[]; message?: string }): ReleaseDoctorCheck {
  if (input.status !== "pass") {
    return warn("release_blocking_issues", "Release-blocking issues", input.message ?? "Open issue state was not checked.");
  }
  const blockers = input.issues.filter(isReleaseBlockingIssue);
  if (blockers.length > 0) {
    return fail("release_blocking_issues", "Release-blocking issues", `${blockers.length} release-blocking issue(s) are open.`, {
      blockers: blockers.map((issue) => ({ number: issue.number, title: issue.title, url: issue.url }))
    });
  }
  if (input.issues.length > 0) {
    return warn("release_blocking_issues", "Release-blocking issues", `${input.issues.length} open issue(s), none marked as release blockers.`, {
      openIssues: input.issues.map((issue) => ({ number: issue.number, title: issue.title, url: issue.url }))
    });
  }
  return pass("release_blocking_issues", "Release-blocking issues", "No open release-blocking issues.");
}

function readOpenPullRequests(repoRoot: string, repoId: string, commandRunner: NonNullable<ReleaseDoctorOptions["commandRunner"]>): { status: ReleaseDoctorStatus; prs: GitHubPullRequest[]; message?: string } {
  const result = commandRunner("gh", ["pr", "list", "--repo", repoId, "--state", "open", "--json", "number,title,url,isDraft"], repoRoot);
  if (!result.ok) {
    return { status: "warn", prs: [], message: "Open pull requests could not be read." };
  }
  const parsed = parseJsonArray(result.stdout) as GitHubPullRequest[] | undefined;
  return parsed ? { status: "pass", prs: parsed } : { status: "warn", prs: [], message: "Open PR payload was not recognized." };
}

function checkOpenPullRequests(input: { status: ReleaseDoctorStatus; prs: GitHubPullRequest[]; message?: string }): ReleaseDoctorCheck {
  if (input.status !== "pass") {
    return warn("open_pull_requests", "Open pull requests", input.message ?? "Open PR state was not checked.");
  }
  if (input.prs.length > 0) {
    return warn("open_pull_requests", "Open pull requests", `${input.prs.length} open pull request(s) should be reviewed before release.`, {
      openPullRequests: input.prs
    });
  }
  return pass("open_pull_requests", "Open pull requests", "No open pull requests.");
}

function checkGitHubRelease(repoRoot: string, repoId: string, tag: string, commandRunner: NonNullable<ReleaseDoctorOptions["commandRunner"]>): ReleaseDoctorCheck {
  const result = commandRunner("gh", ["release", "view", tag, "--repo", repoId, "--json", "tagName,publishedAt,url"], repoRoot);
  if (result.ok) {
    return fail("github_release", "GitHub release", `GitHub Release already exists for ${tag}.`, {
      release: parseJsonObject(result.stdout)
    });
  }
  if (isNotFound(result)) {
    return pass("github_release", "GitHub release", `No GitHub Release exists for ${tag}.`);
  }
  return warn("github_release", "GitHub release", `Could not verify GitHub Release ${tag}.`, { stderr: redactReleaseDiagnostic(result.stderr) });
}

function checkGitTag(repoRoot: string, tag: string, commandRunner: NonNullable<ReleaseDoctorOptions["commandRunner"]>): ReleaseDoctorCheck {
  const result = commandRunner("git", ["ls-remote", "origin", `refs/tags/${tag}`], repoRoot);
  if (!result.ok) {
    return warn("git_tag", "Git tag", `Could not verify remote tag ${tag}.`, { stderr: redactReleaseDiagnostic(result.stderr) });
  }
  if (result.stdout.trim().length > 0) {
    return fail("git_tag", "Git tag", `Remote tag already exists: ${tag}.`, { tag });
  }
  return pass("git_tag", "Git tag", `Remote tag does not exist yet: ${tag}.`);
}

function checkNpmVersion(repoRoot: string, version: string, commandRunner: NonNullable<ReleaseDoctorOptions["commandRunner"]>): ReleaseDoctorCheck {
  const result = commandRunner("npm", ["view", `${PACKAGE_NAME}@${version}`, "version", "--json"], repoRoot);
  if (result.ok) {
    return fail("npm_version", "npm version", `${PACKAGE_NAME}@${version} already exists on npm.`, {
      version: result.stdout.replace(/^"|"$/g, "")
    });
  }
  if (isNotFound(result)) {
    return pass("npm_version", "npm version", `${PACKAGE_NAME}@${version} does not exist on npm yet.`);
  }
  return warn("npm_version", "npm version", `Could not verify ${PACKAGE_NAME}@${version} on npm.`, { stderr: redactReleaseDiagnostic(result.stderr) });
}

function checkVersionMetadata(packageRoot: string, version: string): ReleaseDoctorCheck {
  const checks = [
    ["package.json", readJsonVersion(join(packageRoot, "package.json"))],
    ["plugins/autonomous-pr-loop/package.json", readJsonVersion(join(packageRoot, "plugins/autonomous-pr-loop/package.json"))],
    ["plugins/autonomous-pr-loop/.codex-plugin/plugin.json", readJsonVersion(join(packageRoot, "plugins/autonomous-pr-loop/.codex-plugin/plugin.json"))],
    ["plugins/autonomous-pr-loop/mcp-server/src/index.ts serverInfo", sourceContainsVersion(join(packageRoot, "plugins/autonomous-pr-loop/mcp-server/src/index.ts"), version) ? version : "missing"],
    ["plugins/autonomous-pr-loop/mcp-server/dist/index.js serverInfo", sourceContainsVersion(join(packageRoot, "plugins/autonomous-pr-loop/mcp-server/dist/index.js"), version) ? version : "missing"]
  ];
  const mismatches = checks.filter(([, actual]) => actual !== version);
  if (mismatches.length > 0) {
    return fail("version_metadata", "Version metadata", "Release version metadata is not synchronized.", {
      version,
      mismatches: mismatches.map(([file, actual]) => ({ file, actual }))
    });
  }
  return pass("version_metadata", "Version metadata", `All release metadata matches ${version}.`);
}

function checkGeneratedDist(packageRoot: string): ReleaseDoctorCheck {
  const stale: Array<{ source: string; dist: string }> = [];
  const missing: string[] = [];
  for (const name of HOOK_SOURCE_FILES) {
    const source = join(packageRoot, "plugins/autonomous-pr-loop/hooks", `${name}.ts`);
    const dist = join(packageRoot, "plugins/autonomous-pr-loop/hooks/dist", `${name}.js`);
    compareGeneratedPair(source, dist, stale, missing);
  }
  compareGeneratedPair(
    join(packageRoot, "plugins/autonomous-pr-loop/mcp-server/src/index.ts"),
    join(packageRoot, "plugins/autonomous-pr-loop/mcp-server/dist/index.js"),
    stale,
    missing
  );
  if (missing.length > 0) {
    return fail("generated_dist", "Generated dist", "Generated release artifacts are missing.", {
      missing,
      stale
    });
  }
  if (stale.length > 0) {
    return warn("generated_dist", "Generated dist", "Generated release artifacts are older than source files; rerun the relevant build before release.", {
      missing,
      stale
    });
  }
  return pass("generated_dist", "Generated dist", "Hook and MCP generated dist files are present and fresh.");
}

function checkReleaseWorkflow(packageRoot: string): ReleaseDoctorCheck {
  const path = join(packageRoot, ".github/workflows/release.yml");
  if (!existsSync(path)) {
    return fail("release_workflow", "Release workflow", "Release workflow file is missing.", { path });
  }
  const text = readFileSync(path, "utf8");
  const missing = RELEASE_WORKFLOW_MARKERS.filter((marker) => !text.includes(marker));
  if (missing.length > 0) {
    return fail("release_workflow", "Release workflow", "Release workflow is missing required release-readiness markers.", {
      missing
    });
  }
  return pass("release_workflow", "Release workflow", "Release workflow includes dispatch inputs and validation/publish steps.");
}

function checkRequiredEntrypoints(packageRoot: string): ReleaseDoctorCheck {
  const pkg = readJsonObject(join(packageRoot, "package.json"));
  const scripts = isRecord(pkg?.scripts) ? pkg.scripts : {};
  const missing: string[] = [];
  for (const script of ["lint", "test", "build:hooks"]) {
    if (typeof scripts[script] !== "string") {
      missing.push(`package script: ${script}`);
    }
  }
  if (!sourceContains(join(packageRoot, "plugins/autonomous-pr-loop/core/cli.ts"), "dashboard smoke")) {
    missing.push("agent-loop dashboard smoke");
  }
  if (!sourceContains(join(packageRoot, "docs/release-checklist.md"), "npm pack --ignore-scripts --dry-run --json")) {
    missing.push("npm pack --ignore-scripts --dry-run --json documentation");
  }
  if (missing.length > 0) {
    return fail("required_entrypoints", "Required release checks", "Required release check entrypoints are missing.", {
      missing
    });
  }
  return pass("required_entrypoints", "Required release checks", "Required local release check entrypoints are present.");
}

function buildReport(repoRoot: string, version: string, tag: string, checks: ReleaseDoctorCheck[], counts: { releaseBlockers: number; openPullRequests: number }): ReleaseDoctorReport {
  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const status: ReleaseDoctorStatus = failed > 0 ? "fail" : warnings > 0 ? "warn" : "pass";
  return {
    ok: status !== "fail",
    status,
    targetRepoRoot: repoRoot,
    version,
    tag,
    checks,
    summary: {
      passed: checks.filter((check) => check.status === "pass").length,
      warnings,
      failed,
      releaseBlockers: counts.releaseBlockers,
      openPullRequests: counts.openPullRequests
    }
  };
}

function compareGeneratedPair(source: string, dist: string, stale: Array<{ source: string; dist: string }>, missing: string[]): void {
  if (!existsSync(source) || !existsSync(dist)) {
    missing.push(!existsSync(source) ? source : dist);
    return;
  }
  if (statSync(dist).mtimeMs < statSync(source).mtimeMs) {
    stale.push({ source, dist });
  }
}

function isReleaseBlockingIssue(issue: GitHubIssue): boolean {
  const labelNames = (issue.labels ?? []).map((label) => (label.name ?? "").toLowerCase());
  const labelsBlock = labelNames.some((label) => RELEASE_BLOCKER_LABELS.has(label));
  const labelText = labelNames.join("\n");
  const text = `${labelText}\n${issue.title ?? ""}\n${issue.body ?? ""}`.toLowerCase();
  return labelsBlock ||
    /\brelease[-\s]?blocker\b/.test(text) ||
    /\bblocker\b/.test(text) ||
    /\bp[01]\b/.test(text);
}

function readJsonVersion(path: string): string | undefined {
  const parsed = readJsonObject(path);
  return typeof parsed?.version === "string" ? parsed.version : undefined;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return parseJsonObject(readFileSync(path, "utf8"));
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonArray(text: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readNestedString(value: Record<string, unknown> | undefined, path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return typeof current === "string" ? current : undefined;
}

function sourceContainsVersion(path: string, version: string): boolean {
  return sourceContains(path, `serverInfo: { name: "autonomous-pr-loop", version: "${version}" }`);
}

function sourceContains(path: string, needle: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes(needle);
}

function parseGitHubRepoId(remote: string): string | undefined {
  const https = remote.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!https) return undefined;
  return `${https[1]}/${https[2]}`;
}

function isNotFound(result: CommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}\n${result.combined}`.toLowerCase();
  return text.includes("not found") || text.includes("e404") || text.includes("404");
}

function redactReleaseDiagnostic(value: string): string {
  return value
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-github-token>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted-github-token>")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "<redacted-api-key>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}\b/gi, "Bearer <redacted-token>")
    .replace(/\b(token|auth|password|secret)=([^\s&]+)/gi, "$1=<redacted>");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pass(id: string, label: string, message: string, details?: unknown): ReleaseDoctorCheck {
  return { id, label, status: "pass", message, ...(details === undefined ? {} : { details }) };
}

function warn(id: string, label: string, message: string, details?: unknown): ReleaseDoctorCheck {
  return { id, label, status: "warn", message, ...(details === undefined ? {} : { details }) };
}

function fail(id: string, label: string, message: string, details?: unknown): ReleaseDoctorCheck {
  return { id, label, status: "fail", message, ...(details === undefined ? {} : { details }) };
}
