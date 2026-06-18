import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { matchesProtectedPath } from "./policy.js";
import type {
  AgentLoopConfig,
  AgentLoopStorage,
  ScopeGuardReport,
  WorkerResult
} from "./types.js";

export interface ScopeBaselineEntry {
  path: string;
  digest: string | null;
}

/** Capture the current git porcelain paths, including untracked files. */
export function captureScopeBaseline(repoRoot: string): ScopeBaselineEntry[] {
  return readPorcelainPaths(repoRoot).map((path) => ({ path, digest: digestPath(repoRoot, path) }));
}

/** Validate worker changes against real git state, protected paths, and worker claims. */
export function evaluateWorkerScope(input: {
  repoRoot: string;
  storage: AgentLoopStorage;
  runId: string;
  workerId: string;
  config: AgentLoopConfig;
  baseline: ScopeBaselineEntry[];
  result: WorkerResult;
  allowedPaths?: string[];
  outOfScopeGate?: "review_out_of_scope" | "generic_scope_change_requested";
}): ScopeGuardReport {
  const after = readPorcelainPaths(input.repoRoot).map((path) => ({ path, digest: digestPath(input.repoRoot, path) }));
  const baseline = new Map(input.baseline.map((entry) => [entry.path, entry.digest]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry.digest]));
  const actualChangedFiles = unique([...baseline.keys(), ...afterMap.keys()])
    .filter((path) => baseline.get(path) !== afterMap.get(path))
    .filter((path) => !isSupervisorRuntimePath(path, input.runId, input.workerId));
  const workerPaths = [...input.result.changedFiles, ...input.result.outOfScope.map((item) => item.item)];
  const invalidWorkerPaths = unique(workerPaths.filter((path) => !isSafeRepoRelativePath(path)));
  const reportedChangedFiles = unique(input.result.changedFiles.filter(isSafeRepoRelativePath));
  const missingFromReport = actualChangedFiles.filter((path) => !reportedChangedFiles.includes(path));
  const extraInReport = reportedChangedFiles.filter((path) => !actualChangedFiles.includes(path));
  const protectedPathHits = actualChangedFiles.filter((path) =>
    input.config.protectedPaths.some((pattern) => matchesProtectedPath(pattern, path))
  );
  const outOfScope = [
    ...input.result.outOfScope,
    ...actualChangedFiles
      .filter((path) => !isAllowed(path, input.allowedPaths))
      .map((path) => ({ item: path, reason: "Changed path is outside worker allowed paths." }))
  ];
  const gate = invalidWorkerPaths.length > 0
    ? "policy_violation"
    : protectedPathHits.length > 0
    ? "policy_violation"
    : outOfScope.length > 0
      ? input.outOfScopeGate ?? "review_out_of_scope"
      : input.config.gitnexusRequired &&
          (!input.result.gitnexus.impactRun || !input.result.gitnexus.detectChangesRun)
        ? "policy_violation"
        : undefined;

  if (missingFromReport.length > 0 || extraInReport.length > 0) {
    input.storage.appendEvent({
      runId: input.runId,
      kind: "worker_changed_files_mismatch",
      message: "Worker changedFiles did not match git status.",
      payload: {
        workerId: input.workerId,
        actualChangedFiles,
        reportedChangedFiles,
        missingFromReport,
        extraInReport
      }
    });
  }

  return {
    ok: gate === undefined,
    actualChangedFiles,
    reportedChangedFiles,
    missingFromReport,
    extraInReport,
    protectedPathHits,
    invalidWorkerPaths,
    outOfScope,
    ...(gate ? { gate } : {})
  };
}

function readPorcelainPaths(repoRoot: string): string[] {
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  }) as Buffer;
  return parsePorcelainPaths(output);
}

function digestPath(repoRoot: string, path: string): string | null {
  const absolutePath = join(repoRoot, path);
  if (!existsSync(absolutePath)) {
    return null;
  }
  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    return "directory";
  }
  return hashFile(absolutePath);
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function parsePorcelainPaths(output: Buffer): string[] {
  const records = output.toString("utf8").split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path) {
      paths.push(normalizePath(path));
    }
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }
  return unique(paths);
}

function isAllowed(path: string, allowedPaths: string[] | undefined): boolean {
  if (!allowedPaths) {
    return true;
  }
  return allowedPaths.some((allowedPath) => {
    const normalized = normalizePath(allowedPath);
    const file = normalizePath(path);
    return file === normalized || file.startsWith(`${normalized.replace(/\/$/, "")}/`);
  });
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isSafeRepoRelativePath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.split("/").includes("..");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isSupervisorRuntimePath(path: string, runId: string, workerId: string): boolean {
  return path === `.agent-loop/artifacts/${runId}/worker-jsonl/${workerId}.jsonl` ||
    path === `.agent-loop/artifacts/${runId}/worker-result/${workerId}-worker-final.json` ||
    path === ".agent-loop/state.sqlite" ||
    path === ".agent-loop/state.sqlite-shm" ||
    path === ".agent-loop/state.sqlite-wal";
}
