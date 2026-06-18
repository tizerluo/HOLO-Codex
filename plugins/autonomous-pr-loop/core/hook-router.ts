import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord } from "./config.js";

export interface HookBinding {
  id: string;
  repoRoot: string;
  worktreeRoot: string;
  gitCommonDir?: string;
  branch?: string;
  runId?: string;
  sessionIdHash?: string;
  transcriptPathSha256?: string;
  status: "active" | "stale" | "disabled";
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export interface HookRouteContext {
  cwd: string;
  worktreeRoot: string;
  gitCommonDir?: string;
  branch?: string;
  sessionId?: string;
  turnId?: string;
  transcriptPathSha256?: string;
}

export type HookRouteResult =
  | { status: "matched"; binding: HookBinding; context: HookRouteContext; legacy: boolean }
  | { status: "no_match"; context: HookRouteContext; reason: string; worktreeBinding?: boolean }
  | { status: "ambiguous"; context: HookRouteContext; bindings: HookBinding[]; reason: string }
  | { status: "route_error"; context: HookRouteContext; reason: string };

interface HookBindingRegistry {
  version: 1;
  bindings: HookBinding[];
}

export interface HookRegistryLockReport {
  path: string;
  exists: boolean;
  stale: boolean;
  ageMs?: number;
  pid?: number;
  processAlive?: boolean;
}

export interface UpsertHookBindingInput {
  repoRoot: string;
  runId?: string;
  sessionId?: string;
  transcriptPath?: string;
  status?: HookBinding["status"];
}

export function hookRegistryPath(codexHome = codexHomePath()): string {
  return join(codexHome, "agent-loop", "hook-bindings.json");
}

export function hookRegistryLockPath(codexHome = codexHomePath()): string {
  return `${hookRegistryPath(codexHome)}.lock`;
}

export function codexHomePath(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function listHookBindings(codexHome = codexHomePath()): HookBinding[] {
  return readRegistry(codexHome).bindings;
}

export function inspectHookRegistryLock(codexHome = codexHomePath()): HookRegistryLockReport {
  const path = hookRegistryLockPath(codexHome);
  if (!existsSync(path)) {
    return { path, exists: false, stale: false };
  }
  const metadata = readLockMetadata(path);
  const stat = statSync(path);
  const ageMs = Date.now() - (metadata.createdAtMs ?? stat.mtimeMs);
  const alive = metadata.pid ? processAlive(metadata.pid) : undefined;
  return {
    path,
    exists: true,
    stale: ageMs > LOCK_STALE_MS && alive !== true,
    ageMs,
    ...(metadata.pid ? { pid: metadata.pid } : {}),
    ...(alive === undefined ? {} : { processAlive: alive })
  };
}

/** Create or update an active hook binding for one repo/worktree/session. */
export function upsertHookBinding(input: UpsertHookBindingInput, codexHome = codexHomePath()): HookBinding {
  return withRegistryLock(codexHome, () => {
    const repoRoot = canonicalPath(input.repoRoot);
    const context = resolveHookContext({ cwd: repoRoot, sessionId: input.sessionId, transcriptPath: input.transcriptPath });
    const sessionIdHash = input.sessionId ? sha256(input.sessionId) : undefined;
    const now = new Date().toISOString();
    const registry = readRegistry(codexHome);
    const worktreeBindings = registry.bindings.filter((binding) => binding.worktreeRoot === context.worktreeRoot);
    const exact = registry.bindings.find((binding) =>
      binding.worktreeRoot === context.worktreeRoot &&
      (binding.sessionIdHash ?? "") === (sessionIdHash ?? "")
    );
    const singleScoped = sessionIdHash === undefined
      ? worktreeBindings.filter((binding) => binding.sessionIdHash !== undefined)
      : [];
    const existing = exact ?? (singleScoped.length === 1 ? singleScoped[0] : undefined);
    const binding: HookBinding = {
      id: existing?.id ?? randomUUID(),
      repoRoot,
      worktreeRoot: context.worktreeRoot,
      ...(context.gitCommonDir ? { gitCommonDir: context.gitCommonDir } : {}),
      ...(context.branch ? { branch: context.branch } : {}),
      ...(input.runId ? { runId: input.runId } : existing?.runId ? { runId: existing.runId } : {}),
      ...(sessionIdHash ? { sessionIdHash } : existing?.sessionIdHash ? { sessionIdHash: existing.sessionIdHash } : {}),
      ...(input.transcriptPath ? { transcriptPathSha256: sha256(input.transcriptPath) } : existing?.transcriptPathSha256 ? { transcriptPathSha256: existing.transcriptPathSha256 } : {}),
      status: input.status ?? "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.lastSeenAt ? { lastSeenAt: existing.lastSeenAt } : {})
    };
    registry.bindings = [
      ...registry.bindings.filter((item) => item.id !== binding.id && !(sessionIdHash && item.worktreeRoot === context.worktreeRoot && item.sessionIdHash === undefined)),
      binding
    ];
    writeRegistry(registry, codexHome);
    return binding;
  });
}

export function removeHookBinding(input: { repoRoot: string; sessionId?: string }, codexHome = codexHomePath()): HookBinding[] {
  return withRegistryLock(codexHome, () => {
    const repoRoot = canonicalPath(input.repoRoot);
    const context = resolveHookContext({ cwd: repoRoot, sessionId: input.sessionId });
    const sessionIdHash = input.sessionId ? sha256(input.sessionId) : undefined;
    const registry = readRegistry(codexHome);
    const removed = registry.bindings.filter((binding) =>
      binding.worktreeRoot === context.worktreeRoot &&
      (sessionIdHash === undefined || binding.sessionIdHash === sessionIdHash)
    );
    registry.bindings = registry.bindings.filter((binding) => !removed.some((item) => item.id === binding.id));
    writeRegistry(registry, codexHome);
    return removed;
  });
}

/** Resolve a hook payload to exactly one binding, or report why routing cannot safely proceed. */
export function resolveHookRoute(payload: unknown, options: { legacyRepoRoot?: string | undefined; codexHome?: string | undefined } = {}): HookRouteResult {
  const context = hookContextFromPayload(payload, options.legacyRepoRoot);
  let registry: HookBindingRegistry;
  try {
    registry = readRegistry(options.codexHome ?? codexHomePath());
  } catch (error) {
    return { status: "route_error", context, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const active = registry.bindings.filter((binding) => binding.status === "active");
    const worktreeMatches = active.filter((binding) => bindingMatchesContext(binding, context));
    const contextSessionHash = context.sessionId ? sha256(context.sessionId) : undefined;
    const sessionMatches = context.sessionId
      ? worktreeMatches.filter((binding) => binding.sessionIdHash === contextSessionHash)
      : [];
    const candidates = sessionMatches.length > 0
      ? sessionMatches
      : worktreeMatches.filter((binding) => binding.sessionIdHash === undefined);

    if (candidates.length === 1) {
      const binding = touchBinding(candidates[0]!, context, options.codexHome);
      if (contextSessionHash && binding.sessionIdHash !== undefined && binding.sessionIdHash !== contextSessionHash) {
        return { status: "no_match", context, reason: "Hook binding was claimed by another Codex session.", worktreeBinding: true };
      }
      return { status: "matched", binding, context, legacy: false };
    }
    if (candidates.length > 1) {
      return { status: "ambiguous", context, bindings: candidates, reason: "Multiple hook bindings match this Codex session context." };
    }
    if (worktreeMatches.length > 0) {
      return { status: "no_match", context, reason: "Active hook bindings exist for this worktree, but none match this Codex session.", worktreeBinding: true };
    }

    const legacy = legacyRoute(options.legacyRepoRoot, context);
    if (legacy) {
      return { status: "matched", binding: legacy, context, legacy: true };
    }
    return { status: "no_match", context, reason: "No active agent-loop hook binding matches this Codex session context." };
  } catch (error) {
    return { status: "route_error", context, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function hookContextFromPayload(payload: unknown, fallbackCwd = process.cwd()): HookRouteContext {
  const record = isRecord(payload) ? payload : {};
  return resolveHookContext({
    cwd: stringValue(record.cwd) ?? fallbackCwd,
    sessionId: stringValue(record.session_id) ?? stringValue(record.sessionId),
    turnId: stringValue(record.turn_id) ?? stringValue(record.turnId),
    transcriptPath: stringValue(record.transcript_path) ?? stringValue(record.transcriptPath)
  });
}

export function resolveHookContext(input: { cwd: string; sessionId?: string | undefined; turnId?: string | undefined; transcriptPath?: string | undefined }): HookRouteContext {
  const cwd = canonicalPath(input.cwd);
  const worktreeRoot = gitOutput(["rev-parse", "--show-toplevel"], cwd);
  const commonDir = gitOutput(["rev-parse", "--git-common-dir"], cwd);
  const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const commonPath = commonDir
    ? canonicalPath(isAbsolute(commonDir) ? commonDir : join(cwd, commonDir))
    : undefined;
  return {
    cwd,
    worktreeRoot: worktreeRoot ? canonicalPath(worktreeRoot) : cwd,
    ...(commonPath ? { gitCommonDir: commonPath } : {}),
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.transcriptPath ? { transcriptPathSha256: sha256(input.transcriptPath) } : {})
  };
}

function readRegistry(codexHome: string): HookBindingRegistry {
  const path = hookRegistryPath(codexHome);
  if (!existsSync(path)) {
    return { version: 1, bindings: [] };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
    throw new Error(`Invalid hook binding registry: expected { version: 1, bindings: [...] } in ${path}`);
  }
  const bindings = parsed.bindings.map(parseBinding);
  const invalid = bindings.findIndex((binding) => binding === undefined);
  if (invalid >= 0) {
    throw new Error(`Invalid hook binding registry: invalid binding at index ${invalid} in ${path}`);
  }
  return {
    version: 1,
    bindings: bindings.filter((binding): binding is HookBinding => binding !== undefined)
  };
}

function writeRegistry(registry: HookBindingRegistry, codexHome: string): void {
  const path = hookRegistryPath(codexHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function parseBinding(value: unknown): HookBinding | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.repoRoot !== "string" || typeof value.worktreeRoot !== "string") {
    return undefined;
  }
  const status = value.status === "stale" || value.status === "disabled" ? value.status : "active";
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    repoRoot: value.repoRoot,
    worktreeRoot: value.worktreeRoot,
    ...(typeof value.gitCommonDir === "string" ? { gitCommonDir: value.gitCommonDir } : {}),
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.sessionIdHash === "string" ? { sessionIdHash: value.sessionIdHash } : typeof value.sessionId === "string" ? { sessionIdHash: sha256(value.sessionId) } : {}),
    ...(typeof value.transcriptPathSha256 === "string" ? { transcriptPathSha256: value.transcriptPathSha256 } : {}),
    status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.lastSeenAt === "string" ? { lastSeenAt: value.lastSeenAt } : {})
  };
}

function touchBinding(binding: HookBinding, context: HookRouteContext, codexHome = codexHomePath()): HookBinding {
  return withRegistryLock(codexHome, () => {
    const registry = readRegistry(codexHome);
    const current = registry.bindings.find((item) => item.id === binding.id) ?? binding;
    const contextSessionHash = context.sessionId ? sha256(context.sessionId) : undefined;
    if (current.sessionIdHash !== undefined && contextSessionHash !== undefined && current.sessionIdHash !== contextSessionHash) {
      return current;
    }
    const nowMs = Date.now();
    const shouldClaimSession = current.sessionIdHash === undefined && contextSessionHash !== undefined;
    const shouldClaimTranscript = current.transcriptPathSha256 === undefined && context.transcriptPathSha256 !== undefined;
    const lastSeenAtMs = current.lastSeenAt ? Date.parse(current.lastSeenAt) : 0;
    const shouldRefreshLastSeen = !Number.isFinite(lastSeenAtMs) || nowMs - lastSeenAtMs > TOUCH_REFRESH_MS;
    if (!shouldClaimSession && !shouldClaimTranscript && !shouldRefreshLastSeen) {
      return current;
    }
    const now = new Date(nowMs).toISOString();
    const updated: HookBinding = {
      ...current,
      ...(shouldClaimSession ? { sessionIdHash: contextSessionHash } : {}),
      ...(shouldClaimTranscript ? { transcriptPathSha256: context.transcriptPathSha256 } : {}),
      lastSeenAt: now,
      updatedAt: now
    };
    registry.bindings = registry.bindings.map((item) => item.id === current.id ? updated : item);
    writeRegistry(registry, codexHome);
    return updated;
  });
}

function legacyRoute(legacyRepoRoot: string | undefined, context: HookRouteContext): HookBinding | undefined {
  if (!legacyRepoRoot) return undefined;
  const legacyContext = resolveHookContext({ cwd: legacyRepoRoot });
  if (legacyContext.worktreeRoot !== context.worktreeRoot) {
    return undefined;
  }
  const now = new Date().toISOString();
  return {
    id: `legacy:${sha256(legacyContext.worktreeRoot).slice(0, 16)}`,
    repoRoot: canonicalPath(legacyRepoRoot),
    worktreeRoot: legacyContext.worktreeRoot,
    ...(legacyContext.gitCommonDir ? { gitCommonDir: legacyContext.gitCommonDir } : {}),
    ...(legacyContext.branch ? { branch: legacyContext.branch } : {}),
    status: "active",
    createdAt: now,
    updatedAt: now
  };
}

function bindingMatchesContext(binding: HookBinding, context: HookRouteContext): boolean {
  if (binding.worktreeRoot === context.worktreeRoot) {
    return true;
  }
  return binding.gitCommonDir !== undefined &&
    context.gitCommonDir !== undefined &&
    binding.gitCommonDir === context.gitCommonDir &&
    context.cwd.startsWith(`${binding.worktreeRoot}/`);
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function gitOutput(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withRegistryLock<T>(codexHome: string, fn: () => T): T {
  const path = hookRegistryPath(codexHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = hookRegistryLockPath(codexHome);
  let fd: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      break;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
        if (recoverStaleLock(lockPath)) {
          continue;
        }
        sleepSync(20);
        continue;
      }
      throw error;
    }
  }
  if (fd === undefined) {
    throw new Error(`Timed out waiting for hook registry lock: ${lockPath}`);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

const LOCK_STALE_MS = 30_000;
const TOUCH_REFRESH_MS = 10_000;

function recoverStaleLock(lockPath: string): boolean {
  const report = inspectLockPath(lockPath);
  if (!report.stale) {
    return false;
  }
  rmSync(lockPath, { force: true });
  return true;
}

function inspectLockPath(path: string): HookRegistryLockReport {
  if (!existsSync(path)) {
    return { path, exists: false, stale: false };
  }
  const metadata = readLockMetadata(path);
  const stat = statSync(path);
  const ageMs = Date.now() - (metadata.createdAtMs ?? stat.mtimeMs);
  const alive = metadata.pid ? processAlive(metadata.pid) : undefined;
  return {
    path,
    exists: true,
    stale: ageMs > LOCK_STALE_MS && alive !== true,
    ageMs,
    ...(metadata.pid ? { pid: metadata.pid } : {}),
    ...(alive === undefined ? {} : { processAlive: alive })
  };
}

function readLockMetadata(path: string): { pid?: number; createdAtMs?: number } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return {};
    const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
    const createdAtMs = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : undefined;
    return {
      ...(pid && Number.isInteger(pid) && pid > 0 ? { pid } : {}),
      ...(createdAtMs && Number.isFinite(createdAtMs) ? { createdAtMs } : {})
    };
  } catch {
    return {};
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Fallback for hardened runtimes without SharedArrayBuffer.
    }
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
