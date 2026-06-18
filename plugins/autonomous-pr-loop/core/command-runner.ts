import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { writeArtifact } from "./artifacts.js";
import type { CommandPlan, CommandRunResult } from "./state-types.js";
import type { AgentLoopConfig, AgentLoopStorage } from "./types.js";

const execFileAsync = promisify(execFile);

interface RunnerOptions {
  repoRoot: string;
  storage: AgentLoopStorage;
  runId: string;
  config: AgentLoopConfig;
  signal?: AbortSignal | undefined;
}

/** Execute structured command plans through an argv allowlist and denylist policy. */
export class CommandRunner {
  constructor(private readonly options: RunnerOptions) {}

  async run(plan: CommandPlan, dryRun: boolean): Promise<CommandRunResult> {
    const started = Date.now();
    const policy = evaluatePolicy(plan);
    if (!policy.allowed) {
      const reason = policy.reason ?? "Command rejected.";
      const result = this.result(plan, dryRun, false, 126, "", reason, started, false, [], reason);
      this.recordCommandResult(result, "policy_violation");
      return result;
    }

    if (dryRun) {
      const result = this.result(plan, true, true, 0, "", "", started, false, []);
      this.recordCommandResult(result, "command_dry_run");
      return result;
    }

    try {
      const output = await execFileAsync(plan.file, plan.args, {
        cwd: plan.cwd,
        shell: false,
        timeout: plan.timeoutMs ?? this.options.config.commandTimeoutMs,
        maxBuffer: Math.max((plan.outputLimitBytes ?? this.options.config.commandOutputLimitBytes) * 4, 1_048_576),
        signal: this.options.signal
      });
      const result = this.result(
        plan,
        false,
        true,
        0,
        output.stdout,
        output.stderr,
        started,
        false,
        []
      );
      this.recordCommandResult(result, "command_executed");
      return result;
    } catch (error) {
      const typed = error as {
        code?: number | string;
        killed?: boolean;
        signal?: string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const outputLimited = typed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        typed.message?.toLowerCase().includes("maxbuffer") === true;
      const timedOut = !outputLimited && (typed.code === "ETIMEDOUT" || typed.killed === true || typed.signal === "SIGTERM");
      const result = this.result(
        plan,
        false,
        true,
        typeof typed.code === "number" ? typed.code : timedOut ? 124 : outputLimited ? 1 : 1,
        typed.stdout ?? "",
        typed.stderr ?? typed.message ?? "",
        started,
        timedOut,
        [],
        outputLimited ? "Command output exceeded maxBuffer." : undefined
      );
      this.recordCommandResult(result, timedOut ? "command_timeout" : outputLimited ? "command_output_limit" : "command_failed");
      return result;
    }
  }

  private result(
    plan: CommandPlan,
    dryRun: boolean,
    allowed: boolean,
    exitCode: number,
    stdout: string,
    stderr: string,
    started: number,
    timedOut: boolean,
    artifactIds: string[],
    rejectionReason?: string
  ): CommandRunResult {
    return {
      plan,
      dryRun,
      allowed,
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      timedOut,
      artifactIds,
      ...(rejectionReason ? { rejectionReason } : {})
    };
  }

  private recordCommandResult(result: CommandRunResult, kind: string): void {
    const limit = result.plan.outputLimitBytes ?? this.options.config.commandOutputLimitBytes;
    const output = `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`;
    const artifactIds: string[] = [...result.artifactIds];
    let stdout = truncate(result.stdout, limit);
    let stderr = truncate(result.stderr, limit);
    if (Buffer.byteLength(output) > limit) {
      const artifact = writeArtifact(
        this.options.repoRoot,
        this.options.storage,
        this.options.runId,
        "command-output",
        `${result.plan.id}.txt`,
        output
      );
      artifactIds.push(artifact.id);
      result.artifactIds.push(artifact.id);
      stdout = truncate(result.stdout, Math.floor(limit / 2));
      stderr = truncate(result.stderr, Math.floor(limit / 2));
    }
    this.options.storage.appendEvent({
      runId: this.options.runId,
      kind,
      message: `${result.plan.file} ${result.plan.args.join(" ")}`.trim(),
      payload: {
        plan: result.plan,
        exitCode: result.exitCode,
        stdout,
        stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        allowed: result.allowed,
        dryRun: result.dryRun,
        rejectionReason: result.rejectionReason
      },
      artifactIds
    });
  }
}

/** Build a command plan with a stable random id. */
export function commandPlan(
  file: string,
  args: string[],
  cwd: string,
  purpose: string,
  options: { timeoutMs?: number; outputLimitBytes?: number } = {}
): CommandPlan {
  return {
    id: randomUUID(),
    file,
    args,
    cwd,
    purpose,
    ...options
  };
}

/** Return whether a command plan may execute under PR B policy. */
export function evaluatePolicy(plan: Pick<CommandPlan, "file" | "args">): {
  allowed: boolean;
  reason?: string;
} {
  if (matchesDenylist(plan)) {
    return { allowed: false, reason: "Command denied by destructive command policy." };
  }
  if (!matchesAllowlist(plan)) {
    return { allowed: false, reason: "Command is not in the PR B allowlist." };
  }
  return { allowed: true };
}

function matchesAllowlist(plan: Pick<CommandPlan, "file" | "args">): boolean {
  if ([
    ["git", "status", "--short", "--branch"],
    ["git", "branch", "--show-current"],
    ["git", "rev-parse", "--is-inside-work-tree"],
    ["gh", "auth", "status"],
    ["codex", "--version"],
    ["npx", "gitnexus", "--version"],
    ["pnpm", "--version"]
  ].some(([file, ...args]) => plan.file === file && sameArgs(plan.args, args))) {
    return true;
  }
  if (plan.file === "git") {
    return matchesGitAllowlist(plan.args);
  }
  if (plan.file === "gh") {
    return matchesGhAllowlist(plan.args);
  }
  if (plan.file === "npx" && plan.args[0] === "gitnexus") {
    return ["status", "analyze", "detect_changes", "impact"].includes(plan.args[1] ?? "");
  }
  if (plan.file === "pnpm") {
    return plan.args.length === 1 && (plan.args[0] === "lint" || plan.args[0] === "test");
  }
  if (plan.file === "npm") {
    return plan.args.length === 2 && plan.args[0] === "run" && (plan.args[1] === "lint" || plan.args[1] === "test");
  }
  if (plan.file === "yarn") {
    return plan.args.length === 1 && (plan.args[0] === "lint" || plan.args[0] === "test");
  }
  if (plan.file === "bun") {
    return plan.args.length === 2 && plan.args[0] === "run" && (plan.args[1] === "lint" || plan.args[1] === "test");
  }
  if (plan.file === "codex") {
    return matchesCodexAllowlist(plan.args);
  }
  return false;
}

function matchesDenylist(plan: Pick<CommandPlan, "file" | "args">): boolean {
  const args = stripGitGlobalOptions(plan.args);
  if (plan.file === "git") {
    if (args[0] === "reset" && args.includes("--hard")) {
      return true;
    }
    if (args[0] === "clean" && args.some((arg) => /^-.*f/.test(arg))) {
      return true;
    }
    if (args[0] === "rebase") {
      return true;
    }
    if (args[0] === "push" && args.some((arg) => arg === "-f" || arg === "--force" || arg === "--force-with-lease")) {
      return true;
    }
  }
  if (plan.file === "rm") {
    return args.some((arg) => arg.startsWith("-") && arg.includes("r") && arg.includes("f"));
  }
  if (plan.file === "gh" && args[0] === "repo" && args[1] === "delete") {
    return true;
  }
  if (plan.file === "codex") {
    return args.includes("danger-full-access") ||
      args.includes("--dangerously-bypass-approvals-and-sandbox");
  }
  return false;
}

function matchesCodexAllowlist(args: string[]): boolean {
  const fresh = parseCodexBaseArgs(args);
  if (!fresh) {
    return false;
  }
  const trailing = args.slice(fresh.nextIndex);
  if (trailing.length === 0) {
    return true;
  }
  return trailing.length === 3 &&
    trailing[0] === "resume" &&
    isOptionValue(trailing[1]) &&
    typeof trailing[2] === "string" &&
    trailing[2].length > 0;
}

function parseCodexBaseArgs(args: string[]): { nextIndex: number } | undefined {
  if (args.length < 10 || args[0] !== "exec") {
    return undefined;
  }
  const cwd = optionValue(args, "-C");
  const sandbox = optionValue(args, "-s");
  const outputSchema = optionValue(args, "--output-schema");
  const outputLastMessage = optionValue(args, "--output-last-message");
  if (!cwd || !outputSchema || !outputLastMessage || sandbox !== "read-only" && sandbox !== "workspace-write") {
    return undefined;
  }
  const expected = [
    "exec",
    "-C",
    cwd,
    "-s",
    sandbox,
    "--json",
    "--output-schema",
    outputSchema,
    "--output-last-message",
    outputLastMessage
  ];
  if (!sameArgs(args.slice(0, expected.length), expected)) {
    return undefined;
  }
  const nextIndex = expected.length;
  if (args[nextIndex] === "--ephemeral") {
    return { nextIndex: nextIndex + 1 };
  }
  return { nextIndex };
}

function matchesGitAllowlist(args: string[]): boolean {
  if (hasGitWorkingTreeOverride(args)) {
    return false;
  }
  const stripped = stripGitGlobalOptions(args);
  if (stripped[0] === "checkout") {
    return stripped.length === 2 || (stripped.length === 3 && stripped[1] === "-b");
  }
  if (stripped[0] === "pull") {
    return stripped.length === 4 && stripped[1] === "--ff-only" && stripped[2] === "origin";
  }
  if (stripped[0] === "status") {
    return sameArgs(stripped, ["status", "--short"]) ||
      sameArgs(stripped, ["status", "--short", "--branch"]) ||
      sameArgs(stripped, ["status", "--porcelain=v1", "--untracked-files=all"]);
  }
  if (stripped[0] === "branch") {
    return sameArgs(stripped, ["branch", "--show-current"]);
  }
  if (stripped[0] === "rev-parse") {
    return stripped.length === 2 || sameArgs(stripped, ["rev-parse", "--is-inside-work-tree"]) ||
      (stripped.length === 3 && stripped[1] === "--verify");
  }
  if (stripped[0] === "diff") {
    return sameArgs(stripped, ["diff", "--name-only"]) ||
      sameArgs(stripped, ["diff", "--cached", "--quiet"]) ||
      (stripped.length === 3 && stripped[1] === "--name-only");
  }
  if (stripped[0] === "add") {
    return stripped.length >= 3 && stripped[1] === "--";
  }
  if (stripped[0] === "commit") {
    return stripped.length === 3 && stripped[1] === "-m";
  }
  if (stripped[0] === "push") {
    return stripped.length === 4 && stripped[1] === "-u" && stripped[2] === "origin";
  }
  if (stripped[0] === "ls-remote") {
    return stripped.length === 4 && stripped[1] === "--heads" && stripped[2] === "origin";
  }
  return false;
}

function matchesGhAllowlist(args: string[]): boolean {
  if (sameArgs(args, ["auth", "status"])) {
    return true;
  }
  if (args[0] === "pr" && args[1] === "list") {
    return args.length === 6 && args[2] === "--head" && args[4] === "--json";
  }
  if (args[0] === "pr" && args[1] === "view") {
    return args.length === 5 && args[3] === "--json";
  }
  if (args[0] === "pr" && args[1] === "create") {
    return args.length === 11 &&
      args[2] === "--draft" &&
      args[3] === "--title" &&
      args[5] === "--body" &&
      args[7] === "--head" &&
      args[9] === "--base";
  }
  if (args[0] === "pr" && args[1] === "comment") {
    return args.length === 5 && args[3] === "--body";
  }
  if (args[0] === "pr" && args[1] === "ready") {
    return args.length === 3;
  }
  if (args[0] === "pr" && args[1] === "merge") {
    return args.length === 4 && args[3] === "--merge";
  }
  if (args[0] === "api" && args[1] === "graphql") {
    return args.length === 10 &&
      args[2] === "-f" &&
      startsWith(args[3], "query=") &&
      args[4] === "-F" &&
      startsWith(args[5], "owner=") &&
      args[6] === "-F" &&
      startsWith(args[7], "name=") &&
      args[8] === "-F" &&
      startsWith(args[9], "number=");
  }
  return false;
}

function startsWith(value: string | undefined, prefix: string): boolean {
  return value?.startsWith(prefix) ?? false;
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  const value = index >= 0 ? args[index + 1] : undefined;
  return isOptionValue(value) ? value : undefined;
}

function isOptionValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("-");
}

function hasGitWorkingTreeOverride(args: string[]): boolean {
  return args.some((arg) => arg === "-C" || arg === "--git-dir" || arg === "--work-tree" ||
    arg.startsWith("--git-dir=") || arg.startsWith("--work-tree="));
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

function sameArgs(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every((arg, index) => actual[index] === arg);
}

function truncate(value: string, limit: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= limit) {
    return value;
  }
  if (limit <= 0) {
    return "[truncated]";
  }
  return `${utf8Prefix(buffer, limit)}\n[truncated]`;
}

function utf8Prefix(buffer: Buffer, limit: number): string {
  let end = Math.min(limit, buffer.byteLength);
  let value = buffer.subarray(0, end).toString("utf8");
  while (end > 0 && value.endsWith("\uFFFD")) {
    end -= 1;
    value = buffer.subarray(0, end).toString("utf8");
  }
  return value;
}
