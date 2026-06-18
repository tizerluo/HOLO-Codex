import { execFileSync } from "node:child_process";
import { writeArtifact } from "./artifacts.js";
import { AgentLoopError } from "./errors.js";
import type { AgentLoopConfig, AgentLoopStorage } from "./types.js";

export interface GitNexusResult {
  ok: boolean;
  skipped: boolean;
  stdout: string;
  stderr: string;
}

/** Run `gitnexus status` as a best-effort repository health check. */
export function gitnexusStatus(repoRoot: string, config: AgentLoopConfig): GitNexusResult {
  return runGitNexus(repoRoot, ["status"], config.gitnexusRequired);
}

/** Run `gitnexus analyze` as a best-effort repository index refresh. */
export function gitnexusAnalyze(repoRoot: string, config: AgentLoopConfig): GitNexusResult {
  return runGitNexus(repoRoot, ["analyze"], config.gitnexusRequired);
}

/** Guard commit/push with `gitnexus detect_changes` when required by config. */
export function gitnexusDetectChanges(
  repoRoot: string,
  config: AgentLoopConfig,
  storage: AgentLoopStorage,
  runId: string
): GitNexusResult {
  const result = runGitNexus(repoRoot, ["detect_changes"], config.gitnexusRequired);
  if (!result.ok && config.gitnexusRequired) {
    throw new AgentLoopError("gitnexus_check_failed", "GitNexus detect_changes did not pass.", {
      details: { stdout: result.stdout, stderr: result.stderr },
      exitCode: 2
    });
  }
  if (!config.gitnexusRequired) {
    const artifact = writeArtifact(
      repoRoot,
      storage,
      runId,
      "log",
      "gitnexus-alternative-scope-check.txt",
      `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}\n`
    );
    storage.appendDecision({
      runId,
      kind: "gitnexus_not_required",
      message: "GitNexus detect_changes was not required; stored alternative scope evidence.",
      details: { artifactId: artifact.id, ok: result.ok }
    });
  }
  return result;
}

/** Placeholder impact query for PR C callers and later PRs. */
export function gitnexusImpact(repoRoot: string, config: AgentLoopConfig): GitNexusResult {
  return runGitNexus(repoRoot, ["impact"], config.gitnexusRequired);
}

function runGitNexus(repoRoot: string, args: string[], required: boolean): GitNexusResult {
  try {
    const stdout = execFileSync("npx", ["gitnexus", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, skipped: false, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const typed = error as { stderr?: string; stdout?: string; message?: string; status?: number };
    const result = {
      ok: false,
      skipped: false,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message ?? ""
    };
    if (required && isToolUnavailable(typed)) {
      throw new AgentLoopError("required_tool_unavailable", "GitNexus is required but unavailable.", {
        details: { args, stderr: result.stderr, status: typed.status },
        exitCode: 2
      });
    }
    return result;
  }
}

function isToolUnavailable(error: { stderr?: string; message?: string; status?: number }): boolean {
  const text = `${error.stderr ?? ""}\n${error.message ?? ""}`.toLowerCase();
  return error.status === 127 || text.includes("not found") || text.includes("could not determine executable");
}
