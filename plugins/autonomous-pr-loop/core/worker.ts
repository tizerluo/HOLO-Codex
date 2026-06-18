import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { evaluatePolicy } from "./command-runner.js";
import { isRecord } from "./config.js";
import { writeArtifact } from "./artifacts.js";
import { AgentLoopError } from "./errors.js";
import { PR_LOOP_SHAPE } from "./loop-shapes.js";
import { resolveProfile } from "./profiles.js";
import { buildWorkerPrompt, workerSandbox } from "./worker-prompts.js";
import { resolveWorkerPolicy } from "./worker-policy.js";
import { createWorkerJsonlStreamIngestor } from "./worker-events.js";
import { captureScopeBaseline, evaluateWorkerScope } from "./scope-guard.js";
import type { AgentLoopState, ArtifactRecord } from "./state-types.js";
import type {
  AgentLoopConfig,
  AgentLoopRun,
  AgentLoopStorage,
  ScopeGuardReport,
  WorkerCommandPlan,
  WorkerResult,
  WorkerRun,
  WorkerType
} from "./types.js";

export interface WorkerExecutionResult {
  worker: WorkerRun;
  result?: WorkerResult;
  scope?: ScopeGuardReport;
  artifacts: ArtifactRecord[];
  commandPlan: WorkerCommandPlan;
}

/** Execute or dry-run a delegated Codex worker for one state-machine state. */
export async function executeWorker(input: {
  repoRoot: string;
  storage: AgentLoopStorage;
  run: AgentLoopRun;
  config: AgentLoopConfig;
  state: AgentLoopState;
  type: WorkerType;
  dryRun: boolean;
  context?: unknown;
  signal?: AbortSignal | undefined;
}): Promise<WorkerExecutionResult> {
  if (input.config.workerBackend === "codex-app-server") {
    const probe = await probeCodexAppServer(input.repoRoot, input.config.workerTimeoutMs);
    const probeArtifact = writeArtifact(
      input.repoRoot,
      input.storage,
      input.run.id,
      "log",
      "codex-app-server-probe.json",
      `${JSON.stringify(probe, null, 2)}\n`
    );
    const code = probe.status === "success" ? "worker_failed" : "required_tool_unavailable";
    const message = probe.status === "success"
      ? "codex-app-server capability probe succeeded, but worker execution through app-server is not implemented in PR H2."
      : "codex-app-server backend is unavailable.";
    throw new AgentLoopError(code, message, {
      details: { backend: "codex-app-server", probe, artifactId: probeArtifact.id },
      exitCode: 2
    });
  }
  clearOrRejectRunningWorker(input.storage, input.config.workerTimeoutMs);
  const policy = resolveWorkerPolicy({
    config: input.config,
    state: input.state,
    workerType: input.type
  });
  const worker = input.storage.createWorker({
    runId: input.run.id,
    type: input.type,
    backend: input.config.workerBackend,
    attempt: 0,
    resumeUsed: false
  });
  const prompt = buildWorkerPrompt({ ...input, profile: resolveProfile(input.config, input.state), policy });
  const promptArtifact = writeArtifact(
    input.repoRoot,
    input.storage,
    input.run.id,
    "worker-prompt",
    `${worker.id}.md`,
    prompt
  );
  const commandPlan = buildWorkerCommandPlan(input.repoRoot, input.run.id, input.config, input.type, promptArtifact.path, worker.id, policy.sandbox);
  assertWorkerCommandAllowed(commandPlan);
  if (input.dryRun) {
    const planArtifact = writeArtifact(
      input.repoRoot,
      input.storage,
      input.run.id,
      "dry-run-plan",
      `${worker.id}-worker-command.json`,
      `${JSON.stringify(commandPlan, null, 2)}\n`
    );
    const updated = input.storage.updateWorker(worker.id, {
      status: "succeeded",
      completedAt: new Date().toISOString()
    });
    input.storage.appendEvent({
      runId: input.run.id,
      kind: "worker_dry_run",
      message: `Prepared ${input.type} worker prompt without executing codex.`,
      payload: { workerId: worker.id, commandPlan },
      artifactIds: [promptArtifact.id, planArtifact.id]
    });
    return { worker: updated, artifacts: [promptArtifact, planArtifact], commandPlan };
  }

  return await runWithRetry({
    ...input,
    initialWorker: worker,
    prompt,
    promptArtifact,
    commandPlan
  });
}

/** Return the PR D worker type for a state, if the state delegates to a worker. */
export function workerTypeForState(state: AgentLoopState, context?: { ciFailed?: boolean }): WorkerType | undefined {
  if (state === "FIX_REVIEW" && context?.ciFailed) {
    return "ci-fix";
  }
  return PR_LOOP_SHAPE.defaultRoleForState(state);
}

function buildWorkerCommandPlan(
  repoRoot: string,
  runId: string,
  config: AgentLoopConfig,
  type: WorkerType,
  promptPath: string,
  workerId: string,
  sandbox: "read-only" | "workspace-write" = workerSandbox(type),
  resumeThreadId?: string
): WorkerCommandPlan {
  const outputSchemaPath = join(pluginRoot(), "plugins", "autonomous-pr-loop", "schemas", "worker-result.schema.json");
  const outputLastMessagePath = join(
    repoRoot,
    ".agent-loop",
    "artifacts",
    runId,
    "worker-result",
    `${workerId}-worker-final.json`
  );
  mkdirSync(dirname(outputLastMessagePath), { recursive: true });
  const args = [
    "exec",
    "-C",
    repoRoot,
    "-s",
    sandbox,
    "--json",
    "--output-schema",
    outputSchemaPath,
    "--output-last-message",
    outputLastMessagePath
  ];
  if (config.workerEphemeral) {
    args.push("--ephemeral");
  }
  if (resumeThreadId) {
    args.push("resume", resumeThreadId, "Retry once. Return valid JSON matching the required schema.");
  }
  return {
    file: "codex",
    args,
    cwd: repoRoot,
    sandbox,
    promptPath,
    outputSchemaPath,
    outputLastMessagePath
  };
}

function pluginRoot(): string {
  return resolve(import.meta.dirname, "../../..");
}

function assertWorkerCommandAllowed(plan: WorkerCommandPlan): void {
  const policy = evaluatePolicy({ file: plan.file, args: plan.args });
  if (!policy.allowed) {
    throw new AgentLoopError("policy_violation", policy.reason ?? "Worker command rejected by policy.", {
      details: { plan },
      exitCode: 2
    });
  }
}

async function runWithRetry(input: {
  repoRoot: string;
  storage: AgentLoopStorage;
  run: AgentLoopRun;
  config: AgentLoopConfig;
  state: AgentLoopState;
  type: WorkerType;
  context?: unknown;
  signal?: AbortSignal | undefined;
  initialWorker: WorkerRun;
  prompt: string;
  promptArtifact: ArtifactRecord;
  commandPlan: WorkerCommandPlan;
}): Promise<WorkerExecutionResult> {
  let worker = input.initialWorker;
  let commandPlan = input.commandPlan;
  let threadId: string | undefined;
  for (let attempt = 0; attempt <= input.config.workerMaxRetries; attempt += 1) {
    const spawnContext = createWorkerSpawnContext(commandPlan.cwd, worker.id, commandPlan.file);
    const baseline = captureScopeBaseline(input.repoRoot);
    const ingestor = createWorkerJsonlStreamIngestor({
      repoRoot: input.repoRoot,
      storage: input.storage,
      runId: input.run.id,
      workerId: worker.id,
      backend: input.config.workerBackend
    });
    const runResult = await spawnCodexWorker(
      commandPlan,
      input.prompt,
      input.config.workerTimeoutMs,
      spawnContext,
      (chunk) => ingestor.ingestChunk(chunk),
      input.signal
    );
    const ingest = ingestor.finalize();
    threadId = ingest.threadId ?? threadId;
    const rawJsonlArtifactId = ingest.rawJsonlArtifactId;
    if (runResult.timedOut) {
      input.storage.updateWorker(worker.id, {
        status: "timed_out",
        ...(threadId ? { threadId } : {}),
        completedAt: new Date().toISOString(),
        exitCode: 124,
        rawJsonlArtifactId,
        error: "Worker timed out."
      });
      throw new AgentLoopError("worker_timeout", "Codex worker timed out.", {
        details: workerGateDetails(worker, {
          ...(threadId ? { threadId } : {}),
          timeoutMs: input.config.workerTimeoutMs
        }),
        exitCode: 2
      });
    }
    if (runResult.exitCode !== 0) {
      input.storage.updateWorker(worker.id, {
        status: "failed",
        ...(threadId ? { threadId } : {}),
        completedAt: new Date().toISOString(),
        exitCode: runResult.exitCode,
        rawJsonlArtifactId,
        error: runResult.stderr || `codex exited ${runResult.exitCode}`
      });
      if (attempt < input.config.workerMaxRetries) {
        worker = input.storage.createWorker({
          runId: input.run.id,
          type: input.type,
          backend: input.config.workerBackend,
          attempt: attempt + 1,
          resumeUsed: threadId !== undefined
        });
        commandPlan = buildWorkerCommandPlan(
          input.repoRoot,
          input.run.id,
          input.config,
          input.type,
          input.promptArtifact.path,
          worker.id,
          resolveWorkerPolicy({ config: input.config, state: input.state, workerType: input.type }).sandbox,
          threadId
        );
        assertWorkerCommandAllowed(commandPlan);
        continue;
      }
      throw new AgentLoopError("worker_failed", "Codex worker failed.", {
        details: workerGateDetails(worker, {
          ...(threadId ? { threadId } : {}),
          exitCode: runResult.exitCode,
          error: runResult.stderr || `codex exited ${runResult.exitCode}`
        }),
        exitCode: 1
      });
    }
    const parsed = parseWorkerResult(commandPlan.outputLastMessagePath);
    if (!parsed.ok) {
      input.storage.updateWorker(worker.id, {
        status: "invalid_output",
        ...(threadId ? { threadId } : {}),
        completedAt: new Date().toISOString(),
        exitCode: 0,
        rawJsonlArtifactId,
        error: parsed.error
      });
      if (attempt < input.config.workerMaxRetries) {
        worker = input.storage.createWorker({
          runId: input.run.id,
          type: input.type,
          backend: input.config.workerBackend,
          attempt: attempt + 1,
          resumeUsed: threadId !== undefined
        });
        commandPlan = buildWorkerCommandPlan(
          input.repoRoot,
          input.run.id,
          input.config,
          input.type,
          input.promptArtifact.path,
          worker.id,
          resolveWorkerPolicy({ config: input.config, state: input.state, workerType: input.type }).sandbox,
          threadId
        );
        assertWorkerCommandAllowed(commandPlan);
        continue;
      }
      throw new AgentLoopError("worker_output_invalid", "Worker output did not match schema.", {
        details: workerGateDetails(worker, {
          ...(threadId ? { threadId } : {}),
          error: parsed.error
        }),
        exitCode: 2
      });
    }
    const resultArtifact = persistExistingResult(
      input.repoRoot,
      input.storage,
      input.run.id,
      commandPlan.outputLastMessagePath,
      `${worker.id}-worker-final.json`
    );
    if (!parsed.result.ok) {
      input.storage.updateWorker(worker.id, {
        status: "failed",
        ...(threadId ? { threadId } : {}),
        completedAt: new Date().toISOString(),
        exitCode: 0,
        resultArtifactId: resultArtifact.id,
        rawJsonlArtifactId,
        error: parsed.result.error?.message ?? parsed.result.summary
      });
      throw new AgentLoopError("worker_failed", "Worker reported failure.", {
        details: workerGateDetails(worker, {
          ...(threadId ? { threadId } : {}),
          error: parsed.result.error?.message ?? parsed.result.summary,
          result: parsed.result
        }),
        exitCode: 1
      });
    }
    const scope = evaluateWorkerScope({
      repoRoot: input.repoRoot,
      storage: input.storage,
      runId: input.run.id,
      workerId: worker.id,
      config: input.config,
      baseline,
      result: parsed.result,
      ...optionalAllowedPaths(input.type, input.config, input.state),
      ...(input.config.loopShape === "generic-loop" ? { outOfScopeGate: "generic_scope_change_requested" as const } : {})
    });
    const updated = input.storage.updateWorker(worker.id, {
      status: "succeeded",
      ...(threadId ? { threadId } : {}),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      resultArtifactId: resultArtifact.id,
      rawJsonlArtifactId
    });
    input.storage.appendEvent({
      runId: input.run.id,
      kind: "worker_completed",
      message: `${input.type} worker completed.`,
      payload: { workerId: worker.id, result: parsed.result, scope },
      artifactIds: [input.promptArtifact.id, resultArtifact.id, rawJsonlArtifactId]
    });
    if (scope.gate) {
      throw new AgentLoopError(scope.gate, "Worker scope guard blocked progress.", {
        details: scope.gate === "generic_scope_change_requested" ? genericScopeGateDetails(input.config, input.state, scope) : scope,
        exitCode: 2
      });
    }
    return {
      worker: updated,
      result: parsed.result,
      scope,
      artifacts: [input.promptArtifact, resultArtifact],
      commandPlan
    };
  }
  throw new AgentLoopError("storage_error", "Worker retry loop ended unexpectedly.");
}

function workerGateDetails(worker: WorkerRun, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    workerId: worker.id,
    workerType: worker.type,
    attempt: worker.attempt,
    ...(worker.threadId === undefined ? {} : { threadId: worker.threadId }),
    ...extra
  };
}

interface AppServerProbeResult {
  success: boolean;
  status: "success" | "command_missing" | "help_failed" | "startup_failed" | "handshake_timeout" | "protocol_mismatch";
  helpExitCode?: number;
  stderr?: string;
  responsePreview?: string;
}

async function probeCodexAppServer(repoRoot: string, workerTimeoutMs: number): Promise<AppServerProbeResult> {
  const codexPath = resolveOptionalExecutable("codex", process.env.PATH ?? "");
  if (!codexPath) {
    return { success: false, status: "command_missing" };
  }
  try {
    execFileSync(codexPath, ["app-server", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Math.min(workerTimeoutMs, 5_000)
    });
  } catch (error) {
    const helpExitCode = typeof error === "object" && error !== null && "status" in error ? Number((error as { status?: unknown }).status) : undefined;
    const result: AppServerProbeResult = {
      success: false,
      status: "help_failed",
      stderr: error instanceof Error ? error.message : String(error)
    };
    if (typeof helpExitCode === "number" && Number.isFinite(helpExitCode)) {
      result.helpExitCode = helpExitCode;
    }
    return result;
  }
  return await new Promise((resolve) => {
    const child = spawn(codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: AppServerProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ success: false, status: "handshake_timeout", responsePreview: stdout.slice(0, 500), stderr: stderr.slice(0, 500) });
    }, 3_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
          if (parsed.id === 1 && parsed.result !== undefined) {
            finish({ success: true, status: "success", responsePreview: line.slice(0, 500) });
            return;
          }
          if (parsed.id === 1 && parsed.error !== undefined) {
            finish({ success: false, status: "protocol_mismatch", responsePreview: line.slice(0, 500) });
            return;
          }
        } catch {
          // Keep waiting until a complete JSON-RPC line or timeout.
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ success: false, status: "startup_failed", stderr: error.message });
    });
    child.on("close", () => {
      finish({ success: false, status: stdout ? "protocol_mismatch" : "startup_failed", responsePreview: stdout.slice(0, 500), stderr: stderr.slice(0, 500) });
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  });
}

async function spawnCodexWorker(
  plan: WorkerCommandPlan,
  prompt: string,
  timeoutMs: number,
  spawnContext: { executablePath: string; env: NodeJS.ProcessEnv },
  onStdoutChunk: (chunk: string) => void,
  signal?: AbortSignal
): Promise<{ exitCode: number; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn(spawnContext.executablePath, plan.args, {
      cwd: plan.cwd,
      env: spawnContext.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const appendStderr = (message: string): void => {
      stderr = `${stderr}${stderr ? "\n" : ""}${message}`;
    };
    const finish = (result: { exitCode: number; stderr: string; timedOut: boolean }): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        signalProcessTree(child.pid, child, "SIGTERM");
        killTimer = setTimeout(() => {
          signalProcessTree(child.pid, child, "SIGKILL");
          finish({ exitCode: 124, stderr, timedOut: true });
        }, 1_000);
      }
    }, timeoutMs);
    const abort = (): void => {
      if (!settled) {
        timedOut = true;
        signalProcessTree(child.pid, child, "SIGTERM");
        killTimer = setTimeout(() => {
          signalProcessTree(child.pid, child, "SIGKILL");
          finish({ exitCode: 130, stderr, timedOut: true });
        }, 1_000);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      onStdoutChunk(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      appendStderr(error.message);
      finish({ exitCode: 1, stderr, timedOut: false });
    });
    child.on("close", (code, closeSignal) => {
      signal?.removeEventListener("abort", abort);
      finish({ exitCode: code ?? 1, stderr, timedOut: timedOut || closeSignal === "SIGTERM" });
    });
    child.stdin.on("error", (error) => {
      if (!isClosedWorkerStdinError(error)) {
        appendStderr(error.message);
      }
    });
    try {
      child.stdin.end(prompt);
    } catch (error) {
      if (!isClosedWorkerStdinError(error)) {
        appendStderr(errorMessage(error));
      }
    }
  });
}

function isClosedWorkerStdinError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWorkerSpawnContext(
  repoRoot: string,
  workerId: string,
  executable: string
): { executablePath: string; env: NodeJS.ProcessEnv } {
  const originalPath = process.env.PATH ?? "";
  const executablePath = resolveExecutable(executable, originalPath);
  const binDir = join(repoRoot, ".agent-loop", "worker-policy-bin", workerId);
  mkdirSync(binDir, { recursive: true });
  writeShim(join(binDir, "git"), gitShim(resolveOptionalExecutable("git", originalPath)));
  writeShim(join(binDir, "gh"), ghShim(resolveOptionalExecutable("gh", originalPath)));
  writeShim(join(binDir, "codex"), codexShim(resolveOptionalExecutable("codex", originalPath)));
  return {
    executablePath,
    env: {
      ...process.env,
      PATH: `${binDir}:${originalPath}`,
      AGENT_LOOP_WORKER_POLICY: "1"
    }
  };
}

function writeShim(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function gitShim(realPath: string | undefined): string {
  return `#!/bin/sh
cmd="$1"
while [ "$cmd" = "-c" ] || [ "$cmd" = "-C" ]; do
  shift 2 || exit 126
  cmd="$1"
done
case "$cmd" in
  commit|push|rebase|reset|clean|merge) echo "agent-loop worker policy denied git side effect" >&2; exit 126 ;;
esac
${execLine(realPath)}
`;
}

function ghShim(realPath: string | undefined): string {
  return `#!/bin/sh
case "$1 $2" in
  "repo delete"|"pr create"|"pr ready"|"pr merge"|"pr close"|"pr comment") echo "agent-loop worker policy denied gh side effect" >&2; exit 126 ;;
esac
${execLine(realPath)}
`;
}

function codexShim(realPath: string | undefined): string {
  return `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --dangerously-bypass-approvals-and-sandbox|danger-full-access) echo "agent-loop worker policy denied danger sandbox" >&2; exit 126 ;;
  esac
done
if [ "$1" = "exec" ]; then
  echo "agent-loop worker policy denied nested codex exec" >&2
  exit 126
fi
${execLine(realPath)}
`;
}

function execLine(realPath: string | undefined): string {
  return realPath ? `exec ${shellQuote(realPath)} "$@"` : "echo \"command unavailable\" >&2; exit 127";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function resolveExecutable(file: string, pathValue: string): string {
  const resolved = resolveOptionalExecutable(file, pathValue);
  if (!resolved) {
    throw new AgentLoopError("required_tool_unavailable", `Required executable not found: ${file}`, {
      details: { file },
      exitCode: 2
    });
  }
  return resolved;
}

function resolveOptionalExecutable(file: string, pathValue: string): string | undefined {
  try {
    return execFileSync("which", [file], {
      encoding: "utf8",
      env: { ...process.env, PATH: pathValue },
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

function signalProcessTree(
  pid: number | undefined,
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): void {
  try {
    if (pid) {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall back to the direct child when process-group signaling is unavailable.
  }
  child.kill(signal);
}

function parseWorkerResult(path: string): { ok: true; result: WorkerResult } | { ok: false; error: string } {
  if (!existsSync(path)) {
    return { ok: false, error: `Missing worker final output: ${path}` };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isWorkerResult(parsed)
      ? { ok: true, result: parsed }
      : { ok: false, error: "Worker final output failed structural validation." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isWorkerResult(value: unknown): value is WorkerResult {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.ok === "boolean" &&
    typeof value.summary === "string" &&
    isStringArray(value.changedFiles) &&
    Array.isArray(value.commandsRun) &&
    value.commandsRun.every(isCommandRun) &&
    isStringArray(value.testsRun) &&
    isRecord(value.gitnexus) &&
    typeof value.gitnexus.impactRun === "boolean" &&
    typeof value.gitnexus.detectChangesRun === "boolean" &&
    Array.isArray(value.outOfScope) &&
    value.outOfScope.every(isOutOfScope) &&
    isStringArray(value.followUps);
}

function isCommandRun(value: unknown): value is { command: string; exitCode: number } {
  return isRecord(value) && typeof value.command === "string" && Number.isInteger(value.exitCode);
}

function isOutOfScope(value: unknown): value is { item: string; reason: string } {
  return isRecord(value) && typeof value.item === "string" && typeof value.reason === "string";
}

function persistExistingResult(
  repoRoot: string,
  storage: AgentLoopStorage,
  runId: string,
  path: string,
  name: string
): ArtifactRecord {
  const content = readFileSync(path);
  const record = {
    id: randomUUID(),
    runId,
    kind: "worker-result" as const,
    name,
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
    createdAt: new Date().toISOString()
  };
  storage.insertArtifact(record);
  return record;
}

function clearOrRejectRunningWorker(storage: AgentLoopStorage, workerTimeoutMs: number): void {
  const running = storage.getRunningWorker();
  if (!running) {
    return;
  }
  const ageMs = Date.now() - Date.parse(running.startedAt);
  if (Number.isFinite(ageMs) && ageMs > workerTimeoutMs) {
    storage.updateWorker(running.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: 124,
      error: "Stale running worker cleaned before spawning a new worker."
    });
    storage.appendEvent({
      runId: running.runId,
      kind: "stale_worker_cleaned",
      message: `Cleaned stale running worker ${running.id}.`,
      payload: { workerId: running.id, ageMs, workerTimeoutMs }
    });
    return;
  }
  throw new AgentLoopError("worker_already_running", "Another worker is already running.", {
    details: { workerId: running.id, runId: running.runId, startedAt: running.startedAt },
    exitCode: 2
  });
}

function optionalAllowedPaths(type: WorkerType, config: AgentLoopConfig, state: AgentLoopState): { allowedPaths?: string[] } {
  const allowedPaths = resolveWorkerPolicy({ config, state, workerType: type }).allowedPaths;
  return allowedPaths ? { allowedPaths } : {};
}

function genericScopeGateDetails(config: AgentLoopConfig, state: AgentLoopState, scope: unknown): Record<string, unknown> {
  return {
    ...(typeof scope === "object" && scope !== null && !Array.isArray(scope) ? scope as Record<string, unknown> : {}),
    loopShape: config.loopShape,
    workflowProfile: config.workflowProfile,
    state,
    allowedNextStates: ["PLAN_WORK", "STOPPED"],
    defaultNextState: "PLAN_WORK",
    requiredPayload: { nextState: "PLAN_WORK", source: "ui" }
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
