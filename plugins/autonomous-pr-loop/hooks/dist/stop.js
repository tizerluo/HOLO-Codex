#!/usr/bin/env tsx

// plugins/autonomous-pr-loop/hooks/observe-runner.ts
import { readFileSync as readFileSync2 } from "node:fs";

// plugins/autonomous-pr-loop/core/hook-observer.ts
import { createHash as createHash2 } from "node:crypto";

// plugins/autonomous-pr-loop/core/config.ts
import { join } from "node:path";

// plugins/autonomous-pr-loop/core/errors.ts
var AgentLoopError = class extends Error {
  code;
  details;
  exitCode;
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AgentLoopError";
    this.code = code;
    this.details = options.details;
    this.exitCode = options.exitCode ?? (isGateCode(code) ? 2 : 1);
  }
};
function isGateCode(code) {
  return code === "needs_repo_init" || code === "unsupported_remote" || code === "needs_secret_or_login" || code === "policy_violation" || code === "ambiguous_next_pr" || code === "dirty_unowned_worktree" || code === "required_tool_unavailable" || code === "ci_required_checks_missing" || code === "ci_pending_timeout" || code === "merge_requires_confirmation" || code === "github_transient_failure" || code === "gitnexus_check_failed" || code === "github_resource_not_found" || code === "worker_failed" || code === "worker_output_invalid" || code === "review_out_of_scope" || code === "worker_timeout" || code === "worker_already_running" || code === "generic_goal_needs_confirmation" || code === "generic_human_gate" || code === "generic_scope_change_requested";
}

// plugins/autonomous-pr-loop/core/locale.ts
var DEFAULT_LOCALE = "zh-CN";

// plugins/autonomous-pr-loop/core/profiles.ts
var DEFAULT_LOOP_SHAPE_ID = "pr-loop";
var DEFAULT_WORKFLOW_PROFILE_ID = "default_pr_loop";
var DEFAULT_ROLE_PROFILE_ID = "default_pr_roles";

// plugins/autonomous-pr-loop/core/config.ts
var CONFIG_DIR = ".agent-loop";
var DEFAULT_PROTECTED_PATHS = [
  ".git/**",
  ".agent-loop/**",
  ".claude/**",
  "AGENTS.md",
  "CLAUDE.md",
  ".env*",
  "**/*secret*"
];
function statePath(repoRoot) {
  return join(repoRoot, CONFIG_DIR, "state.sqlite");
}
function withConfigDefaults(input) {
  const mergeMode = input.mergeMode ?? (input.allowAutoMerge ? "conditional" : "manual");
  return {
    repoId: input.repoId,
    locale: input.locale ?? DEFAULT_LOCALE,
    loopShape: input.loopShape ?? DEFAULT_LOOP_SHAPE_ID,
    workflowProfile: input.workflowProfile ?? DEFAULT_WORKFLOW_PROFILE_ID,
    roleProfile: input.roleProfile ?? DEFAULT_ROLE_PROFILE_ID,
    baseBranch: input.baseBranch ?? "main",
    branchPrefix: input.branchPrefix ?? "codex/",
    plansDir: input.plansDir ?? "docs/plans",
    ...input.lintCommand ? { lintCommand: input.lintCommand } : {},
    ...input.testCommand ? { testCommand: input.testCommand } : {},
    ...input.gitnexusRepo ? { gitnexusRepo: input.gitnexusRepo } : {},
    gitnexusRequired: input.gitnexusRequired ?? true,
    requiredChecks: input.requiredChecks ?? [],
    requireReviewApproval: input.requireReviewApproval ?? true,
    autonomyMode: input.autonomyMode ?? "autonomous_until_gate",
    mergeMode,
    notifyMode: input.notifyMode ?? "important_only",
    reviewHandling: input.reviewHandling ?? "fix_scoped_and_carry_forward",
    ...input.carryoverTarget ? { carryoverTarget: input.carryoverTarget } : {},
    allowAutoMerge: mergeMode === "conditional",
    maxReviewFixRounds: input.maxReviewFixRounds ?? 3,
    maxTestFixRounds: input.maxTestFixRounds ?? 2,
    maxCiReruns: input.maxCiReruns ?? 1,
    commandTimeoutMs: input.commandTimeoutMs ?? 6e5,
    commandOutputLimitBytes: input.commandOutputLimitBytes ?? 65536,
    githubRetryMaxAttempts: input.githubRetryMaxAttempts ?? 3,
    githubRetryBaseDelayMs: input.githubRetryBaseDelayMs ?? 1e3,
    reviewCiPollIntervalMs: input.reviewCiPollIntervalMs ?? 3e4,
    reviewCiMaxWaitMs: input.reviewCiMaxWaitMs ?? 18e5,
    workerBackend: input.workerBackend ?? "codex-exec",
    workerTimeoutMs: input.workerTimeoutMs ?? 18e5,
    workerMaxRetries: input.workerMaxRetries ?? 1,
    workerEphemeral: input.workerEphemeral ?? false,
    protectedPaths: input.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
    ...input.dashboard ? { dashboard: input.dashboard } : {}
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// plugins/autonomous-pr-loop/core/hook-events.ts
var CODEX_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "PreCompact",
  "PostCompact",
  "PermissionRequest"
];
var OBSERVE_ONLY_HOOK_EVENTS = CODEX_HOOK_EVENTS.filter((event) => event !== "PreToolUse");
function hookEventKind(event) {
  return `hook_${event.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}`;
}

// plugins/autonomous-pr-loop/core/hook-router.ts
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join as join2, resolve } from "node:path";
function hookRegistryPath(codexHome = codexHomePath()) {
  return join2(codexHome, "agent-loop", "hook-bindings.json");
}
function hookRegistryLockPath(codexHome = codexHomePath()) {
  return `${hookRegistryPath(codexHome)}.lock`;
}
function codexHomePath() {
  return process.env.CODEX_HOME ?? join2(homedir(), ".codex");
}
function resolveHookRoute(payload, options = {}) {
  const context = hookContextFromPayload(payload, options.legacyRepoRoot);
  let registry;
  try {
    registry = readRegistry(options.codexHome ?? codexHomePath());
  } catch (error) {
    return { status: "route_error", context, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const active = registry.bindings.filter((binding) => binding.status === "active");
    const worktreeMatches = active.filter((binding) => bindingMatchesContext(binding, context));
    const contextSessionHash = context.sessionId ? sha256(context.sessionId) : void 0;
    const sessionMatches = context.sessionId ? worktreeMatches.filter((binding) => binding.sessionIdHash === contextSessionHash) : [];
    const candidates = sessionMatches.length > 0 ? sessionMatches : worktreeMatches.filter((binding) => binding.sessionIdHash === void 0);
    if (candidates.length === 1) {
      const binding = touchBinding(candidates[0], context, options.codexHome);
      if (contextSessionHash && binding.sessionIdHash !== void 0 && binding.sessionIdHash !== contextSessionHash) {
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
function hookContextFromPayload(payload, fallbackCwd = process.cwd()) {
  const record = isRecord(payload) ? payload : {};
  return resolveHookContext({
    cwd: stringValue(record.cwd) ?? fallbackCwd,
    sessionId: stringValue(record.session_id) ?? stringValue(record.sessionId),
    turnId: stringValue(record.turn_id) ?? stringValue(record.turnId),
    transcriptPath: stringValue(record.transcript_path) ?? stringValue(record.transcriptPath)
  });
}
function resolveHookContext(input) {
  const cwd = canonicalPath(input.cwd);
  const worktreeRoot = gitOutput(["rev-parse", "--show-toplevel"], cwd);
  const commonDir = gitOutput(["rev-parse", "--git-common-dir"], cwd);
  const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const commonPath = commonDir ? canonicalPath(isAbsolute(commonDir) ? commonDir : join2(cwd, commonDir)) : void 0;
  return {
    cwd,
    worktreeRoot: worktreeRoot ? canonicalPath(worktreeRoot) : cwd,
    ...commonPath ? { gitCommonDir: commonPath } : {},
    ...branch && branch !== "HEAD" ? { branch } : {},
    ...input.sessionId ? { sessionId: input.sessionId } : {},
    ...input.turnId ? { turnId: input.turnId } : {},
    ...input.transcriptPath ? { transcriptPathSha256: sha256(input.transcriptPath) } : {}
  };
}
function readRegistry(codexHome) {
  const path = hookRegistryPath(codexHome);
  if (!existsSync(path)) {
    return { version: 1, bindings: [] };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
    throw new Error(`Invalid hook binding registry: expected { version: 1, bindings: [...] } in ${path}`);
  }
  const bindings = parsed.bindings.map(parseBinding);
  const invalid = bindings.findIndex((binding) => binding === void 0);
  if (invalid >= 0) {
    throw new Error(`Invalid hook binding registry: invalid binding at index ${invalid} in ${path}`);
  }
  return {
    version: 1,
    bindings: bindings.filter((binding) => binding !== void 0)
  };
}
function writeRegistry(registry, codexHome) {
  const path = hookRegistryPath(codexHome);
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}
`, { mode: 384 });
  renameSync(tmp, path);
}
function parseBinding(value) {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.repoRoot !== "string" || typeof value.worktreeRoot !== "string") {
    return void 0;
  }
  const status = value.status === "stale" || value.status === "disabled" ? value.status : "active";
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return void 0;
  }
  return {
    id: value.id,
    repoRoot: value.repoRoot,
    worktreeRoot: value.worktreeRoot,
    ...typeof value.gitCommonDir === "string" ? { gitCommonDir: value.gitCommonDir } : {},
    ...typeof value.branch === "string" ? { branch: value.branch } : {},
    ...typeof value.runId === "string" ? { runId: value.runId } : {},
    ...typeof value.sessionIdHash === "string" ? { sessionIdHash: value.sessionIdHash } : typeof value.sessionId === "string" ? { sessionIdHash: sha256(value.sessionId) } : {},
    ...typeof value.transcriptPathSha256 === "string" ? { transcriptPathSha256: value.transcriptPathSha256 } : {},
    status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...typeof value.lastSeenAt === "string" ? { lastSeenAt: value.lastSeenAt } : {}
  };
}
function touchBinding(binding, context, codexHome = codexHomePath()) {
  return withRegistryLock(codexHome, () => {
    const registry = readRegistry(codexHome);
    const current = registry.bindings.find((item) => item.id === binding.id) ?? binding;
    const contextSessionHash = context.sessionId ? sha256(context.sessionId) : void 0;
    if (current.sessionIdHash !== void 0 && contextSessionHash !== void 0 && current.sessionIdHash !== contextSessionHash) {
      return current;
    }
    const nowMs = Date.now();
    const shouldClaimSession = current.sessionIdHash === void 0 && contextSessionHash !== void 0;
    const shouldClaimTranscript = current.transcriptPathSha256 === void 0 && context.transcriptPathSha256 !== void 0;
    const lastSeenAtMs = current.lastSeenAt ? Date.parse(current.lastSeenAt) : 0;
    const shouldRefreshLastSeen = !Number.isFinite(lastSeenAtMs) || nowMs - lastSeenAtMs > TOUCH_REFRESH_MS;
    if (!shouldClaimSession && !shouldClaimTranscript && !shouldRefreshLastSeen) {
      return current;
    }
    const now2 = new Date(nowMs).toISOString();
    const updated = {
      ...current,
      ...shouldClaimSession ? { sessionIdHash: contextSessionHash } : {},
      ...shouldClaimTranscript ? { transcriptPathSha256: context.transcriptPathSha256 } : {},
      lastSeenAt: now2,
      updatedAt: now2
    };
    registry.bindings = registry.bindings.map((item) => item.id === current.id ? updated : item);
    writeRegistry(registry, codexHome);
    return updated;
  });
}
function legacyRoute(legacyRepoRoot, context) {
  if (!legacyRepoRoot) return void 0;
  const legacyContext = resolveHookContext({ cwd: legacyRepoRoot });
  if (legacyContext.worktreeRoot !== context.worktreeRoot) {
    return void 0;
  }
  const now2 = (/* @__PURE__ */ new Date()).toISOString();
  return {
    id: `legacy:${sha256(legacyContext.worktreeRoot).slice(0, 16)}`,
    repoRoot: canonicalPath(legacyRepoRoot),
    worktreeRoot: legacyContext.worktreeRoot,
    ...legacyContext.gitCommonDir ? { gitCommonDir: legacyContext.gitCommonDir } : {},
    ...legacyContext.branch ? { branch: legacyContext.branch } : {},
    status: "active",
    createdAt: now2,
    updatedAt: now2
  };
}
function bindingMatchesContext(binding, context) {
  if (binding.worktreeRoot === context.worktreeRoot) {
    return true;
  }
  return binding.gitCommonDir !== void 0 && context.gitCommonDir !== void 0 && binding.gitCommonDir === context.gitCommonDir && context.cwd.startsWith(`${binding.worktreeRoot}/`);
}
function canonicalPath(path) {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}
function gitOutput(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || void 0;
  } catch {
    return void 0;
  }
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function withRegistryLock(codexHome, fn) {
  const path = hookRegistryPath(codexHome);
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const lockPath = hookRegistryLockPath(codexHome);
  let fd;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx", 384);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() })}
`);
      break;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        if (recoverStaleLock(lockPath)) {
          continue;
        }
        sleepSync(20);
        continue;
      }
      throw error;
    }
  }
  if (fd === void 0) {
    throw new Error(`Timed out waiting for hook registry lock: ${lockPath}`);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}
var LOCK_STALE_MS = 3e4;
var TOUCH_REFRESH_MS = 1e4;
function recoverStaleLock(lockPath) {
  const report = inspectLockPath(lockPath);
  if (!report.stale) {
    return false;
  }
  rmSync(lockPath, { force: true });
  return true;
}
function inspectLockPath(path) {
  if (!existsSync(path)) {
    return { path, exists: false, stale: false };
  }
  const metadata = readLockMetadata(path);
  const stat = statSync(path);
  const ageMs = Date.now() - (metadata.createdAtMs ?? stat.mtimeMs);
  const alive = metadata.pid ? processAlive(metadata.pid) : void 0;
  return {
    path,
    exists: true,
    stale: ageMs > LOCK_STALE_MS && alive !== true,
    ageMs,
    ...metadata.pid ? { pid: metadata.pid } : {},
    ...alive === void 0 ? {} : { processAlive: alive }
  };
}
function readLockMetadata(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return {};
    const pid = typeof parsed.pid === "number" ? parsed.pid : void 0;
    const createdAtMs = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : void 0;
    return {
      ...pid && Number.isInteger(pid) && pid > 0 ? { pid } : {},
      ...createdAtMs && Number.isFinite(createdAtMs) ? { createdAtMs } : {}
    };
  } catch {
    return {};
  }
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
    }
  }
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}

// plugins/autonomous-pr-loop/core/redaction.ts
function redactSecrets(value) {
  return value.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/\b[A-Za-z0-9._%+-]+:[^@\s]+@/g, "[redacted]@").replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]").replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]").replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]").replace(/((?:token|api_key|authorization|password|secret)\s*[:=]\s*)(["'])(?:(?!\2).)*\2/gi, "$1$2[redacted]$2").replace(/((?:token|api_key|authorization|password|secret)\s*[:=]\s*)[^\n\r,;}]+/gi, "$1[redacted]");
}
function isSecretKey(key) {
  return /token|api_key|authorization|password|secret/i.test(key);
}

// plugins/autonomous-pr-loop/core/storage.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
var STORAGE_SCHEMA_VERSION = 8;
var SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3, 4, 5, 6, 7, STORAGE_SCHEMA_VERSION];
var TIMELINE_SOURCES = ["event", "worker_event", "worker", "state", "gate", "artifact", "decision"];
var TIMELINE_TRIGGER_NAMES = [
  "timeline_events_insert",
  "timeline_worker_events_insert",
  "timeline_workers_insert",
  "timeline_workers_status_update",
  "timeline_states_insert",
  "timeline_gates_insert",
  "timeline_artifacts_insert",
  "timeline_decisions_insert"
];
var PR_C_TABLES_SQL = `
  create table if not exists pr_links (
    id text primary key,
    run_id text not null,
    branch text not null,
    pr_number integer not null,
    url text not null,
    head_ref text not null,
    base_ref text not null,
    state text not null,
    draft integer not null,
    created_at text not null,
    updated_at text not null,
    unique(run_id, pr_number),
    foreign key(run_id) references runs(id)
  );

  create table if not exists ci_checks (
    id text primary key,
    run_id text not null,
    pr_number integer not null,
    name text not null,
    status text not null,
    conclusion text,
    url text,
    started_at text,
    completed_at text,
    observed_at text not null,
    foreign key(run_id) references runs(id)
  );

  create table if not exists review_comments (
    id text primary key,
    run_id text not null,
    pr_number integer not null,
    comment_id text not null,
    url text not null,
    author text not null,
    body text not null,
    path text not null,
    line integer,
    diff_hunk text not null,
    is_resolved integer not null,
    is_outdated integer not null,
    actionable integer not null,
    status text not null,
    observed_at text not null,
    unique(run_id, comment_id),
    foreign key(run_id) references runs(id)
  );

  create table if not exists decisions (
    id text primary key,
    run_id text not null,
    kind text not null,
    message text not null,
    details_json text,
    created_at text not null,
    foreign key(run_id) references runs(id)
  );
`;
var PR_D_TABLES_SQL = `
  create table if not exists workers (
    id text primary key,
    run_id text not null,
    type text not null,
    backend text not null,
    status text not null,
    thread_id text,
    attempt integer not null,
    resume_used integer not null,
    started_at text not null,
    completed_at text,
    exit_code integer,
    result_artifact_id text,
    raw_jsonl_artifact_id text,
    error text,
    foreign key(run_id) references runs(id)
  );

  create table if not exists worker_events (
    seq integer primary key autoincrement,
    id text not null unique,
    worker_id text not null,
    run_id text not null,
    event_type text not null,
    item_type text,
    item_id text,
    item_status text,
    thread_id text,
    backend text,
    summary_json text,
    usage_json text,
    artifact_ids_json text,
    created_at text not null,
    foreign key(worker_id) references workers(id),
    foreign key(run_id) references runs(id)
  );

  create unique index if not exists workers_single_running
    on workers(status)
    where status = 'running';
`;
var PR_E_INDEXES_SQL = `
  create unique index if not exists runs_single_running
    on runs(status)
    where status = 'RUNNING';
`;
var PR_E_TABLES_SQL = `
  create table if not exists run_checks (
    run_id text not null,
    kind text not null,
    status text not null,
    details_json text,
    created_at text not null,
    primary key(run_id, kind),
    foreign key(run_id) references runs(id)
  );
`;
var TIMELINE_INDEX_SQL = `
  create table if not exists timeline_index (
    timeline_seq integer primary key autoincrement,
    source text not null,
    source_id text not null,
    source_seq integer,
    run_id text,
    worker_id text,
    created_at text not null,
    unique(source, source_id)
  );

  create index if not exists timeline_index_created
    on timeline_index(created_at desc, timeline_seq desc);
  create index if not exists timeline_index_run
    on timeline_index(run_id, timeline_seq desc);
  create index if not exists timeline_index_worker
    on timeline_index(worker_id, timeline_seq desc);
`;
var TIMELINE_TRIGGERS_SQL = `
  create trigger if not exists timeline_events_insert
  after insert on events
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('event', new.id, new.seq, new.run_id, null, new.created_at);
  end;

  create trigger if not exists timeline_worker_events_insert
  after insert on worker_events
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('worker_event', new.id, new.seq, new.run_id, new.worker_id, new.created_at);
  end;

  create trigger if not exists timeline_workers_insert
  after insert on workers
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('worker', new.id || ':' || new.status, null, new.run_id, new.id, new.started_at);
  end;

  create trigger if not exists timeline_workers_status_update
  after update of status on workers
  when old.status is not new.status
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values (
      'worker',
      new.id || ':' || new.status,
      null,
      new.run_id,
      new.id,
      coalesce(new.completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  end;

  create trigger if not exists timeline_states_insert
  after insert on states
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('state', cast(new.id as text), new.id, new.run_id, null, new.created_at);
  end;

  create trigger if not exists timeline_gates_insert
  after insert on gates
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('gate', new.id, null, new.run_id, null, new.created_at);
  end;

  create trigger if not exists timeline_artifacts_insert
  after insert on artifacts
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('artifact', new.id, null, new.run_id, null, new.created_at);
  end;

  create trigger if not exists timeline_decisions_insert
  after insert on decisions
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('decision', new.id, null, new.run_id, null, new.created_at);
  end;
`;
var SCHEMA_SQL = `
  create table if not exists runs (
    id text primary key,
    status text not null,
    current_state text,
    version integer not null default 0,
    branch text,
    worktree_clean integer,
    started_at text,
    stopped_at text,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists states (
    id integer primary key autoincrement,
    run_id text,
    status text not null,
    state text,
    version integer not null,
    payload_json text,
    created_at text not null,
    foreign key(run_id) references runs(id)
  );

  create table if not exists events (
    seq integer primary key autoincrement,
    id text not null unique,
    run_id text,
    kind text not null,
    message text not null,
    state_before text,
    state_after text,
    payload_json text,
    artifact_ids_json text,
    created_at text not null,
    foreign key(run_id) references runs(id)
  );

  create table if not exists gates (
    id text primary key,
    run_id text,
    kind text not null,
    status text not null,
    message text not null,
    details_json text,
    created_at text not null,
    resolved_at text,
    decision_note text,
    decided_at text,
    foreign key(run_id) references runs(id)
  );

  create table if not exists artifacts (
    id text primary key,
    run_id text,
    kind text not null,
    name text,
    path text not null,
    sha256 text,
    metadata_json text,
    created_at text not null,
    foreign key(run_id) references runs(id)
  );

  create table if not exists repo_config (
    id integer primary key check (id = 1),
    schema_version integer not null,
    config_json text not null,
    updated_at text not null
  );

  ${PR_C_TABLES_SQL}
  ${PR_D_TABLES_SQL}
  ${PR_E_TABLES_SQL}
  ${PR_E_INDEXES_SQL}
`;
var SqliteAgentLoopStorage = class {
  constructor(path, options = {}) {
    this.path = path;
    this.mode = options.mode ?? "rw";
    if (this.mode === "rw") {
      mkdirSync2(dirname2(path), { recursive: true });
    } else if (!existsSync2(path)) {
      throw new AgentLoopError("storage_error", "Read-only storage file does not exist.", {
        details: { path }
      });
    }
    this.db = new DatabaseSync(path, {
      readOnly: this.mode === "ro",
      enableForeignKeyConstraints: true,
      timeout: 5e3
    });
    try {
      this.db.exec("PRAGMA foreign_keys=ON");
      this.db.exec("PRAGMA busy_timeout=5000");
      if (this.mode === "rw") {
        this.db.exec("PRAGMA journal_mode=WAL");
      }
      this.ensureSchema();
      if (this.mode === "rw") {
        this.ensureRepoConfigVersion();
      } else {
        this.validateRepoConfigVersion();
      }
      const workersSql = `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                                 started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
                          from workers`;
      this.listWorkersByRunStatement = this.db.prepare(`${workersSql} where run_id = ? order by started_at desc limit ?`);
      this.listWorkersStatement = this.db.prepare(`${workersSql} order by started_at desc limit ?`);
    } catch (error) {
      this.db.close();
      throw toStorageError(error, "Failed to open agent-loop storage.");
    }
  }
  path;
  db;
  mode;
  listWorkersByRunStatement;
  listWorkersStatement;
  close() {
    this.db.close();
  }
  writeRepoConfig(config) {
    const snapshot = JSON.stringify({ schemaVersion: STORAGE_SCHEMA_VERSION, ...config });
    this.transaction(() => {
      this.db.prepare(
        `insert into repo_config (id, schema_version, config_json, updated_at)
           values (1, ?, ?, ?)
           on conflict(id) do update set
             schema_version = excluded.schema_version,
             config_json = excluded.config_json,
             updated_at = excluded.updated_at`
      ).run(STORAGE_SCHEMA_VERSION, snapshot, now());
    });
  }
  readRepoConfig() {
    const row = this.db.prepare("select schema_version, config_json from repo_config where id = 1").get();
    if (!row) {
      return void 0;
    }
    if (!isSupportedSchemaVersion(row.schema_version)) {
      throw new AgentLoopError(
        "storage_schema_mismatch",
        `Stored repo config schema version ${row.schema_version} is not supported.`,
        { details: { expected: STORAGE_SCHEMA_VERSION, actual: row.schema_version } }
      );
    }
    const parsed = parseJson(row.config_json, "Stored repo config JSON is invalid.");
    const { schemaVersion: _schemaVersion, ...config } = parsed;
    return config;
  }
  createRun(status, options = {}) {
    const createdAt = now();
    const run = {
      id: randomUUID2(),
      status,
      ...options.currentState ? { currentState: options.currentState } : {},
      version: 0,
      ...options.branch ? { branch: options.branch } : {},
      ...options.worktreeClean !== void 0 ? { worktreeClean: options.worktreeClean } : {},
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt
    };
    try {
      this.transaction(() => {
        this.db.prepare(
          `insert into runs (
               id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
             )
             values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)`
        ).run(
          run.id,
          run.status,
          run.currentState ?? null,
          run.version,
          run.branch ?? null,
          boolToDb(run.worktreeClean),
          run.startedAt ?? null,
          run.createdAt,
          run.updatedAt
        );
        this.db.prepare(
          `insert into states (run_id, status, state, version, payload_json, created_at)
             values (?, ?, ?, ?, null, ?)`
        ).run(run.id, run.status, run.currentState ?? run.status, run.version, run.updatedAt);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AgentLoopError("version_conflict", "Another active run already exists.", {
          details: { status },
          exitCode: 2
        });
      }
      throw error;
    }
    return run;
  }
  getOrCreateActiveRun(options = {}) {
    return this.transaction(() => {
      const active = this.getActiveRun();
      if (active) {
        return { run: active, created: false };
      }
      const createdAt = now();
      const run = {
        id: randomUUID2(),
        status: "RUNNING",
        ...options.currentState ? { currentState: options.currentState } : {},
        version: 0,
        ...options.branch ? { branch: options.branch } : {},
        ...options.worktreeClean !== void 0 ? { worktreeClean: options.worktreeClean } : {},
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt
      };
      this.db.prepare(
        `insert into runs (
             id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
           )
           values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)`
      ).run(
        run.id,
        run.status,
        run.currentState ?? null,
        run.version,
        run.branch ?? null,
        boolToDb(run.worktreeClean),
        run.startedAt ?? null,
        run.createdAt,
        run.updatedAt
      );
      this.db.prepare(
        `insert into states (run_id, status, state, version, payload_json, created_at)
           values (?, ?, ?, ?, null, ?)`
      ).run(run.id, run.status, run.currentState ?? run.status, run.version, run.updatedAt);
      return { run, created: true };
    });
  }
  recordRunCheck(check) {
    const stored = { ...check, createdAt: now() };
    this.transaction(() => {
      this.db.prepare(
        `insert into run_checks (run_id, kind, status, details_json, created_at)
           values (?, ?, ?, ?, ?)
           on conflict(run_id, kind) do update set
             status = excluded.status,
             details_json = excluded.details_json,
             created_at = excluded.created_at`
      ).run(
        stored.runId,
        stored.kind,
        stored.status,
        stored.details === void 0 ? null : JSON.stringify(stored.details),
        stored.createdAt
      );
    });
    return stored;
  }
  hasRunCheck(runId, kind) {
    const row = this.db.prepare("select 1 from run_checks where run_id = ? and kind = ? and status in ('passed', 'skipped') limit 1").get(runId, kind);
    return row !== void 0;
  }
  listRunChecks(runId) {
    const rows = this.db.prepare("select run_id, kind, status, details_json, created_at from run_checks where run_id = ? order by created_at desc").all(runId);
    return rows.map(fromRunCheckRow);
  }
  updateRunStatus(runId, expectedVersion, status, options = {}) {
    const updatedAt = now();
    return this.transaction(() => {
      const result = this.db.prepare(
        `update runs
           set status = ?,
               current_state = coalesce(?, current_state),
               branch = coalesce(?, branch),
               worktree_clean = coalesce(?, worktree_clean),
               stopped_at = coalesce(?, stopped_at),
               version = version + 1,
               updated_at = ?
           where id = ? and version = ?`
      ).run(
        status,
        options.currentState ?? null,
        options.branch ?? null,
        boolToDb(options.worktreeClean),
        options.stoppedAt ?? null,
        updatedAt,
        runId,
        expectedVersion
      );
      if (result.changes !== 1) {
        throw new AgentLoopError(
          "version_conflict",
          `Run ${runId} was updated by another writer.`,
          { details: { runId, expectedVersion } }
        );
      }
      const run = this.getRun(runId);
      if (!run) {
        throw new AgentLoopError("storage_error", `Run not found: ${runId}`);
      }
      this.db.prepare(
        `insert into states (run_id, status, state, version, payload_json, created_at)
           values (?, ?, ?, ?, null, ?)`
      ).run(run.id, run.status, run.currentState ?? run.status, run.version, run.updatedAt);
      return run;
    });
  }
  appendEvent(event) {
    const stored = {
      id: randomUUID2(),
      ...event,
      createdAt: now()
    };
    let seq = 0;
    this.transaction(() => {
      this.db.prepare(
        `insert into events (
             id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
           )
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        stored.id,
        stored.runId ?? null,
        stored.kind,
        stored.message,
        stored.stateBefore ?? null,
        stored.stateAfter ?? null,
        stored.payload === void 0 ? null : JSON.stringify(stored.payload),
        stored.artifactIds === void 0 ? null : JSON.stringify(stored.artifactIds),
        stored.createdAt
      );
      seq = Number(this.db.prepare("select last_insert_rowid() as seq").get().seq);
    });
    return { seq, ...stored };
  }
  writeGate(gate) {
    this.transaction(() => {
      this.db.prepare(
        `insert into gates (id, run_id, kind, status, message, details_json, created_at, resolved_at)
           values (?, ?, ?, 'open', ?, ?, ?, null)`
      ).run(
        randomUUID2(),
        gate.runId ?? null,
        gate.kind,
        gate.message,
        gate.details === void 0 ? null : JSON.stringify(gate.details),
        now()
      );
    });
  }
  resolveOpenGates(runId) {
    this.transaction(() => {
      this.db.prepare(
        `update gates
           set status = 'resolved', resolved_at = ?
           where run_id = ? and status = 'open'`
      ).run(now(), runId);
    });
  }
  resolveOpenGatesByKind(kind, options = {}) {
    const scope = options.scope ?? (options.runId ? "run" : "repo");
    this.transaction(() => {
      if (scope === "run") {
        if (!options.runId) {
          throw new AgentLoopError("storage_error", "runId is required for run-scoped gate recovery.");
        }
        this.db.prepare(
          `update gates
             set status = 'resolved', resolved_at = ?
             where kind = ? and run_id = ? and status = 'open'`
        ).run(now(), kind, options.runId);
        return;
      }
      if (scope === "repo") {
        this.db.prepare(
          `update gates
             set status = 'resolved', resolved_at = ?
             where kind = ? and run_id is null and status = 'open'`
        ).run(now(), kind);
        return;
      }
      this.db.prepare(
        `update gates
           set status = 'resolved', resolved_at = ?
           where kind = ? and status = 'open'`
      ).run(now(), kind);
    });
  }
  listGates(runId) {
    const sql = `select id, run_id, kind, status, message, details_json, created_at,
                        resolved_at, decision_note, decided_at
                 from gates
                 ${runId ? "where run_id = ?" : ""}
                 order by created_at desc
                 limit 100`;
    const rows = runId ? this.db.prepare(sql).all(runId) : this.db.prepare(sql).all();
    return rows.map(fromGateRow);
  }
  getGate(gateId) {
    const row = this.db.prepare(
      `select id, run_id, kind, status, message, details_json, created_at,
                resolved_at, decision_note, decided_at
         from gates
         where id = ?`
    ).get(gateId);
    return row ? fromGateRow(row) : void 0;
  }
  decideGate(gateId, decision, note) {
    if (note.trim().length === 0) {
      throw new AgentLoopError("invalid_config", "Gate decision note is required.");
    }
    const decidedAt = now();
    this.transaction(() => {
      const result = this.db.prepare(
        `update gates
           set status = ?, decision_note = ?, decided_at = ?, resolved_at = coalesce(resolved_at, ?)
           where id = ? and status = 'open'`
      ).run(decision, note, decidedAt, decidedAt, gateId);
      if (result.changes !== 1) {
        const gate2 = this.getGate(gateId);
        if (!gate2) {
          throw new AgentLoopError("storage_error", `Gate not found: ${gateId}`);
        }
        throw new AgentLoopError("storage_error", `Gate ${gateId} is not open.`, {
          details: { gateId, status: gate2.status }
        });
      }
    });
    const gate = this.getGate(gateId);
    if (!gate) {
      throw new AgentLoopError("storage_error", `Gate not found after decision: ${gateId}`);
    }
    return gate;
  }
  getCurrentStatus() {
    const repoGate = this.db.prepare(
      `select kind, message, details_json
         from gates
         where status = 'open' and run_id is null
         order by created_at desc
         limit 1`
    ).get();
    if (repoGate) {
      return {
        status: "BLOCKED",
        gate: statusGateFromRow(repoGate)
      };
    }
    const row = this.db.prepare(
      `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         order by updated_at desc, rowid desc
         limit 1`
    ).get();
    if (!row) {
      return { status: "IDLE" };
    }
    const run = fromRunRow(row);
    const runGate = this.db.prepare(
      `select kind, message, details_json
         from gates
         where status = 'open' and run_id = ?
         order by created_at desc
         limit 1`
    ).get(run.id);
    if (runGate) {
      return {
        status: "BLOCKED",
        run,
        gate: statusGateFromRow(runGate)
      };
    }
    if (run.status === "BLOCKED" && latestGateSatisfied(this.db, run.id)) {
      return { status: "READY", run: { ...run, status: "READY" } };
    }
    return { status: run.status, run };
  }
  listEvents(options = 50) {
    const limit = typeof options === "number" ? options : options.limit ?? 50;
    const sinceSeq = typeof options === "number" ? void 0 : options.sinceSeq;
    const rows = sinceSeq === void 0 ? this.db.prepare(
      `select seq, id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
           from events
           order by seq desc
           limit ?`
    ).all(limit) : this.db.prepare(
      `select seq, id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
           from events
           where seq > ?
           order by seq asc
           limit ?`
    ).all(sinceSeq, limit);
    return rows.map(fromEventRow);
  }
  findLatestEvent(runId, kind) {
    const row = this.db.prepare(
      `select seq, id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
         from events
         where run_id = ? and kind = ?
         order by seq desc
         limit 1`
    ).get(runId, kind);
    return row ? fromEventRow(row) : void 0;
  }
  listAgentTimeline(query = {}) {
    const limit = clampLimit(query.limit ?? 50);
    const cursor = query.cursor ? decodeTimelineCursor(query.cursor) : void 0;
    const params = [];
    const where = [];
    if (cursor) {
      where.push("(created_at < ? or (created_at = ? and timeline_seq < ?))");
      params.push(cursor.occurredAt, cursor.occurredAt, cursor.timelineSeq);
    }
    if (query.sources?.length) {
      const sources = normalizeTimelineSources(query.sources);
      where.push(`source in (${sources.map(() => "?").join(", ")})`);
      params.push(...sources);
    }
    if (query.runId) {
      where.push("run_id = ?");
      params.push(query.runId);
    }
    if (query.workerId) {
      where.push("worker_id = ?");
      params.push(query.workerId);
    }
    params.push(limit + 1);
    const rows = this.db.prepare(
      `select timeline_seq, source, source_id, source_seq, run_id, worker_id, created_at
         from timeline_index
         ${where.length ? `where ${where.join(" and ")}` : ""}
         order by created_at desc, timeline_seq desc
         limit ?`
    ).all(...params);
    const pageRows = rows.slice(0, limit);
    const entries = pageRows.map((row) => this.timelineEntry(row)).filter((entry) => entry !== void 0);
    const last = pageRows[pageRows.length - 1];
    return {
      entries,
      ...rows.length > limit && last ? { nextCursor: encodeTimelineCursor(last.timeline_seq, last.created_at) } : {}
    };
  }
  checkTimelineIntegrity() {
    const missingTable = !hasTable(this.db, "timeline_index");
    const triggers = new Set(this.db.prepare("select name from sqlite_master where type = 'trigger' and name like 'timeline_%'").all().map((row) => row.name));
    const missingTriggers = TIMELINE_TRIGGER_NAMES.filter((name) => !triggers.has(name));
    const sourceCounts = Object.fromEntries(TIMELINE_SOURCES.map((source) => [source, 0]));
    const missingSourceRows = [];
    if (!missingTable) {
      const rows = this.db.prepare("select source, count(*) as count from timeline_index group by source").all();
      for (const row of rows) {
        if (TIMELINE_SOURCES.includes(row.source)) {
          sourceCounts[row.source] = row.count;
        }
      }
      missingSourceRows.push(...timelineMissingSourceRows(this.db));
    }
    const ok = !missingTable && missingTriggers.length === 0 && missingSourceRows.length === 0;
    return {
      ok,
      missingTable,
      missingTriggers,
      missingSourceRows,
      sourceCounts,
      repair: "Run storage migration or rebuild timeline_index by dropping timeline_index/triggers and reopening storage in read-write mode."
    };
  }
  upsertPrLink(link) {
    const createdAt = now();
    const id = randomUUID2();
    this.transaction(() => {
      this.db.prepare(
        `insert into pr_links (
             id, run_id, branch, pr_number, url, head_ref, base_ref, state, draft, created_at, updated_at
           )
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(run_id, pr_number) do update set
             branch = excluded.branch,
             url = excluded.url,
             head_ref = excluded.head_ref,
             base_ref = excluded.base_ref,
             state = excluded.state,
             draft = excluded.draft,
             updated_at = excluded.updated_at`
      ).run(
        id,
        link.runId,
        link.branch,
        link.prNumber,
        link.url,
        link.headRef,
        link.baseRef,
        link.state,
        boolToDb(link.draft),
        createdAt,
        createdAt
      );
    });
    const stored = this.getPrLink(link.runId);
    if (!stored) {
      throw new AgentLoopError("storage_error", "PR link was not stored.");
    }
    return stored;
  }
  getPrLink(runId) {
    const row = this.db.prepare(
      `select id, run_id, branch, pr_number, url, head_ref, base_ref, state, draft, created_at, updated_at
         from pr_links
         where run_id = ?
         order by updated_at desc
         limit 1`
    ).get(runId);
    return row ? fromPrLinkRow(row) : void 0;
  }
  replaceCiChecks(runId, prNumber, checks) {
    const observedAt = now();
    this.transaction(() => {
      this.db.prepare("delete from ci_checks where run_id = ? and pr_number = ?").run(runId, prNumber);
      for (const check of checks) {
        this.db.prepare(
          `insert into ci_checks (
               id, run_id, pr_number, name, status, conclusion, url, started_at, completed_at, observed_at
             )
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID2(),
          runId,
          prNumber,
          check.name,
          check.status,
          check.conclusion ?? null,
          check.url ?? null,
          check.startedAt ?? null,
          check.completedAt ?? null,
          observedAt
        );
      }
    });
    return this.listCiChecks(runId);
  }
  listCiChecks(runId) {
    const rows = this.db.prepare(
      `select id, run_id, pr_number, name, status, conclusion, url, started_at, completed_at, observed_at
         from ci_checks
         where run_id = ?
         order by observed_at desc, name asc`
    ).all(runId);
    return rows.map(fromCiCheckRow);
  }
  replaceReviewComments(runId, prNumber, comments) {
    const observedAt = now();
    this.transaction(() => {
      this.db.prepare("delete from review_comments where run_id = ? and pr_number = ?").run(runId, prNumber);
      for (const comment of comments) {
        this.db.prepare(
          `insert into review_comments (
               id, run_id, pr_number, comment_id, url, author, body, path, line, diff_hunk,
               is_resolved, is_outdated, actionable, status, observed_at
             )
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID2(),
          runId,
          prNumber,
          comment.commentId,
          comment.url,
          comment.author,
          comment.body,
          comment.path,
          comment.line ?? null,
          comment.diffHunk,
          boolToDb(comment.isResolved),
          boolToDb(comment.isOutdated),
          boolToDb(comment.actionable),
          comment.status,
          observedAt
        );
      }
    });
    return this.listReviewComments(runId);
  }
  listReviewComments(runId) {
    const rows = this.db.prepare(
      `select id, run_id, pr_number, comment_id, url, author, body, path, line, diff_hunk,
                is_resolved, is_outdated, actionable, status, observed_at
         from review_comments
         where run_id = ?
         order by observed_at desc, path asc`
    ).all(runId);
    return rows.map(fromReviewCommentRow);
  }
  appendDecision(decision) {
    const stored = { id: randomUUID2(), ...decision, createdAt: now() };
    this.transaction(() => {
      this.db.prepare(
        `insert into decisions (id, run_id, kind, message, details_json, created_at)
           values (?, ?, ?, ?, ?, ?)`
      ).run(
        stored.id,
        stored.runId,
        stored.kind,
        stored.message,
        stored.details === void 0 ? null : JSON.stringify(stored.details),
        stored.createdAt
      );
    });
    return stored;
  }
  listDecisions(runId) {
    const rows = this.db.prepare(
      `select id, run_id, kind, message, details_json, created_at
         from decisions
         where run_id = ?
         order by created_at desc`
    ).all(runId);
    return rows.map(fromDecisionRow);
  }
  createWorker(worker) {
    const id = randomUUID2();
    const startedAt = now();
    try {
      this.transaction(() => {
        this.db.prepare(
          `insert into workers (
               id, run_id, type, backend, status, thread_id, attempt, resume_used,
               started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
             )
             values (?, ?, ?, ?, 'running', null, ?, ?, ?, null, null, null, null, null)`
        ).run(id, worker.runId, worker.type, worker.backend, worker.attempt, boolToDb(worker.resumeUsed), startedAt);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AgentLoopError("worker_already_running", "Another worker is already running.", {
          details: { runId: worker.runId },
          exitCode: 2
        });
      }
      throw error;
    }
    return this.getWorker(id);
  }
  updateWorker(workerId, patch) {
    this.transaction(() => {
      this.db.prepare(
        `update workers
           set status = coalesce(?, status),
               thread_id = coalesce(?, thread_id),
               completed_at = coalesce(?, completed_at),
               exit_code = coalesce(?, exit_code),
               result_artifact_id = coalesce(?, result_artifact_id),
               raw_jsonl_artifact_id = coalesce(?, raw_jsonl_artifact_id),
               error = coalesce(?, error)
           where id = ?`
      ).run(
        patch.status ?? null,
        patch.threadId ?? null,
        patch.completedAt ?? null,
        patch.exitCode ?? null,
        patch.resultArtifactId ?? null,
        patch.rawJsonlArtifactId ?? null,
        patch.error ?? null,
        workerId
      );
    });
    return this.getWorker(workerId);
  }
  getRunningWorker() {
    const row = this.db.prepare(
      `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
         from workers
         where status = 'running'
         order by started_at desc
         limit 1`
    ).get();
    return row ? fromWorkerRow(row) : void 0;
  }
  listWorkers(runId, limit = 50) {
    const rows = runId ? this.listWorkersByRunStatement.all(runId, limit) : this.listWorkersStatement.all(limit);
    return rows.map(fromWorkerRow);
  }
  appendWorkerEvent(event) {
    const existing = this.findDuplicateWorkerEvent(event);
    if (existing) {
      return existing;
    }
    const stored = { id: randomUUID2(), ...event, createdAt: now() };
    let seq = 0;
    this.transaction(() => {
      this.db.prepare(
        `insert into worker_events (
             id, worker_id, run_id, event_type, item_type, item_id, item_status,
             thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           )
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        stored.id,
        stored.workerId,
        stored.runId,
        stored.eventType,
        stored.itemType ?? null,
        stored.itemId ?? null,
        stored.itemStatus ?? null,
        stored.threadId ?? null,
        stored.backend ?? null,
        stored.summary === void 0 ? null : JSON.stringify(stored.summary),
        stored.usage === void 0 ? null : JSON.stringify(stored.usage),
        stored.artifactIds === void 0 ? null : JSON.stringify(stored.artifactIds),
        stored.createdAt
      );
      seq = Number(this.db.prepare("select last_insert_rowid() as seq").get().seq);
    });
    return { seq, ...stored };
  }
  listWorkerEvents(workerId) {
    const rows = this.db.prepare(
      `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
         from worker_events
         where worker_id = ?
         order by seq asc`
    ).all(workerId);
    return rows.map(fromWorkerEventRow);
  }
  findDuplicateWorkerEvent(event) {
    if (!event.threadId) {
      return void 0;
    }
    const row = event.itemId ? this.db.prepare(
      `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                  thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           from worker_events
           where thread_id = ? and item_id = ? and coalesce(item_status, '') = ?
           limit 1`
    ).get(event.threadId, event.itemId, event.itemStatus ?? "") : this.db.prepare(
      `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                  thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           from worker_events
           where thread_id = ? and event_type = ? and item_id is null
           limit 1`
    ).get(event.threadId, event.eventType);
    return row ? fromWorkerEventRow(row) : void 0;
  }
  insertArtifact(record) {
    this.transaction(() => {
      this.db.prepare(
        `insert into artifacts (id, run_id, kind, name, path, sha256, metadata_json, created_at)
           values (?, ?, ?, ?, ?, ?, null, ?)`
      ).run(
        record.id,
        record.runId,
        record.kind,
        record.name,
        record.path,
        record.sha256,
        record.createdAt
      );
    });
  }
  getArtifact(artifactId) {
    const row = this.db.prepare(
      `select id, run_id, kind, name, path, sha256, created_at
         from artifacts
         where id = ?`
    ).get(artifactId);
    if (!row) {
      throw new AgentLoopError("storage_error", `Artifact not found: ${artifactId}`);
    }
    return fromArtifactRow(row);
  }
  listArtifacts(runId) {
    const rows = this.db.prepare(
      `select id, run_id, kind, name, path, sha256, created_at
         from artifacts
         where run_id = ?
         order by created_at asc`
    ).all(runId);
    return rows.map(fromArtifactRow);
  }
  linkArtifactToEvent(eventId, artifactId) {
    this.transaction(() => {
      const row = this.db.prepare("select artifact_ids_json from events where id = ?").get(eventId);
      if (!row) {
        throw new AgentLoopError("storage_error", `Event not found: ${eventId}`);
      }
      const ids = row.artifact_ids_json ? parseJson(row.artifact_ids_json, "Stored artifact id list is invalid.") : [];
      if (!ids.includes(artifactId)) {
        ids.push(artifactId);
      }
      this.db.prepare("update events set artifact_ids_json = ? where id = ?").run(JSON.stringify(ids), eventId);
    });
  }
  getCurrentRun() {
    const row = this.db.prepare(
      `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         order by updated_at desc
         limit 1`
    ).get();
    return row ? fromRunRow(row) : void 0;
  }
  listRuns(limit = 50) {
    const rows = this.db.prepare(
      `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         order by updated_at desc
         limit ?`
    ).all(limit);
    return rows.map(fromRunRow);
  }
  /** Run a group of read queries against one SQLite snapshot. */
  readTransaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AgentLoopError("storage_error", "Read transaction rollback failed.", {
          details: {
            cause: error instanceof Error ? error.message : String(error),
            rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }
        });
      }
      throw error;
    }
  }
  ensureSchema() {
    const currentVersion = this.getUserVersion();
    if (currentVersion !== 0 && !isSupportedSchemaVersion(currentVersion)) {
      throw new AgentLoopError(
        "storage_schema_mismatch",
        `SQLite schema version ${currentVersion} is not supported.`,
        { details: { expected: STORAGE_SCHEMA_VERSION, actual: currentVersion } }
      );
    }
    if (currentVersion === STORAGE_SCHEMA_VERSION) {
      if (this.mode !== "ro") {
        this.transaction(() => this.reconcileHighFidelityWorkerEventsV8());
      }
      return;
    }
    if (this.mode === "ro") {
      throw new AgentLoopError(
        "storage_schema_mismatch",
        `SQLite schema version ${currentVersion} requires migration before read-only use.`,
        { details: { expected: STORAGE_SCHEMA_VERSION, actual: currentVersion } }
      );
    }
    this.transaction(() => {
      const lockedVersion = this.getUserVersion();
      if (lockedVersion === STORAGE_SCHEMA_VERSION) {
        return;
      }
      if (lockedVersion !== 0 && !isSupportedSchemaVersion(lockedVersion)) {
        throw new AgentLoopError(
          "storage_schema_mismatch",
          `SQLite schema version ${lockedVersion} is not supported.`,
          { details: { expected: STORAGE_SCHEMA_VERSION, actual: lockedVersion } }
        );
      }
      this.db.exec(SCHEMA_SQL);
      this.migratePrC();
      this.migratePrD();
      this.migratePrE();
      this.migrateF0();
      this.migrateTimelineV7();
      this.migrateHighFidelityWorkerEventsV8();
      this.markSchemaVersion();
    });
  }
  migratePrC() {
    addColumnIfMissing(this.db, "runs", "current_state", "text");
    addColumnIfMissing(this.db, "runs", "branch", "text");
    addColumnIfMissing(this.db, "runs", "worktree_clean", "integer");
    addColumnIfMissing(this.db, "runs", "started_at", "text");
    addColumnIfMissing(this.db, "runs", "stopped_at", "text");
    addColumnIfMissing(this.db, "states", "state", "text");
    addColumnIfMissing(this.db, "states", "payload_json", "text");
    addColumnIfMissing(this.db, "events", "state_before", "text");
    addColumnIfMissing(this.db, "events", "state_after", "text");
    addColumnIfMissing(this.db, "events", "artifact_ids_json", "text");
    addColumnIfMissing(this.db, "artifacts", "name", "text");
    addColumnIfMissing(this.db, "artifacts", "sha256", "text");
    this.db.exec(PR_C_TABLES_SQL);
  }
  migratePrD() {
    this.db.exec(PR_D_TABLES_SQL);
  }
  migratePrE() {
    addColumnIfMissing(this.db, "gates", "decision_note", "text");
    addColumnIfMissing(this.db, "gates", "decided_at", "text");
    this.db.exec(PR_E_TABLES_SQL);
    this.db.exec(PR_E_INDEXES_SQL);
  }
  migrateF0() {
    rebuildEventsWithSeq(this.db);
    rebuildWorkerEventsWithSeq(this.db);
  }
  migrateTimelineV7() {
    this.db.exec(TIMELINE_INDEX_SQL);
    this.db.exec(TIMELINE_TRIGGERS_SQL);
    backfillTimelineIndex(this.db);
  }
  migrateHighFidelityWorkerEventsV8() {
    addColumnIfMissing(this.db, "worker_events", "item_id", "text");
    addColumnIfMissing(this.db, "worker_events", "item_status", "text");
    addColumnIfMissing(this.db, "worker_events", "thread_id", "text");
    addColumnIfMissing(this.db, "worker_events", "backend", "text");
    addColumnIfMissing(this.db, "worker_events", "artifact_ids_json", "text");
    this.reconcileHighFidelityWorkerEventsV8();
  }
  reconcileHighFidelityWorkerEventsV8() {
    dedupeHighFidelityWorkerEventsV8(this.db);
    this.db.exec(`
      drop index if exists worker_events_thread_item_unique;
      create unique index if not exists worker_events_thread_item_status_unique
        on worker_events(thread_id, item_id, coalesce(item_status, ''))
        where item_id is not null;
      create unique index if not exists worker_events_thread_event_unique
        on worker_events(thread_id, event_type)
        where item_id is null;
    `);
  }
  markSchemaVersion() {
    this.db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
  }
  ensureRepoConfigVersion() {
    this.validateRepoConfigVersion(true);
  }
  validateRepoConfigVersion(rewrite = false) {
    let row;
    try {
      row = this.db.prepare("select schema_version, config_json from repo_config where id = 1").get();
    } catch (error) {
      throw toStorageError(error, "Could not read stored repo config metadata.");
    }
    if (!row) {
      return;
    }
    if (!isSupportedSchemaVersion(row.schema_version)) {
      throw new AgentLoopError(
        "storage_schema_mismatch",
        `Stored repo config schema version ${row.schema_version} is not supported.`,
        { details: { expected: STORAGE_SCHEMA_VERSION, actual: row.schema_version } }
      );
    }
    const parsed = parseJson(row.config_json, "Stored repo config snapshot JSON is invalid.");
    if (parsed.schemaVersion === STORAGE_SCHEMA_VERSION) {
      return;
    }
    if (rewrite && isSupportedSchemaVersion(parsed.schemaVersion ?? 0) && typeof parsed.repoId === "string") {
      this.writeRepoConfig(withConfigDefaults(parsed));
      return;
    }
    throw new AgentLoopError("storage_error", "Stored repo config snapshot schemaVersion is invalid.", {
      details: { expected: STORAGE_SCHEMA_VERSION, actual: parsed.schemaVersion }
    });
  }
  getUserVersion() {
    const row = this.db.prepare("PRAGMA user_version").get();
    return row.user_version;
  }
  getRun(runId) {
    const row = this.db.prepare(
      `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         where id = ?`
    ).get(runId);
    return row ? fromRunRow(row) : void 0;
  }
  getActiveRun() {
    const row = this.db.prepare(
      `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         where status = 'RUNNING'
         order by updated_at desc
         limit 1`
    ).get();
    return row ? fromRunRow(row) : void 0;
  }
  getWorker(workerId) {
    const row = this.db.prepare(
      `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
         from workers
         where id = ?`
    ).get(workerId);
    if (!row) {
      throw new AgentLoopError("storage_error", `Worker not found: ${workerId}`);
    }
    return fromWorkerRow(row);
  }
  timelineEntry(row) {
    if (!isTimelineSource(row.source)) {
      return void 0;
    }
    if (row.source === "event") {
      const sourceRow2 = this.db.prepare(
        `select seq, id, run_id, kind, message, artifact_ids_json, created_at
           from events where id = ?`
      ).get(row.source_id);
      if (!sourceRow2) return void 0;
      const artifactIds = sourceRow2.artifact_ids_json ? parseJson(sourceRow2.artifact_ids_json, "Stored event artifact list JSON is invalid.") : void 0;
      return timelineEntry(row, {
        kind: sourceRow2.kind,
        title: sourceRow2.kind,
        summary: sourceRow2.message,
        ...sourceRow2.run_id ? { runId: sourceRow2.run_id } : {},
        ...artifactIds ? { artifactIds } : {},
        rawRef: { table: "events", id: sourceRow2.id, seq: sourceRow2.seq }
      });
    }
    if (row.source === "worker_event") {
      const sourceRow2 = this.db.prepare(
        `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                  thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           from worker_events where id = ?`
      ).get(row.source_id);
      if (!sourceRow2) return void 0;
      const worker = this.db.prepare("select thread_id from workers where id = ?").get(sourceRow2.worker_id);
      const summary = sourceRow2.summary_json ? summarizeTimelinePayload(parseJson(sourceRow2.summary_json, "Stored worker event summary JSON is invalid.")) : sourceRow2.event_type;
      const artifactIds = sourceRow2.artifact_ids_json ? parseJson(sourceRow2.artifact_ids_json, "Stored worker event artifact list JSON is invalid.") : void 0;
      return timelineEntry(row, {
        kind: sourceRow2.item_type ?? sourceRow2.event_type,
        title: workerEventTimelineTitle(sourceRow2),
        summary,
        runId: sourceRow2.run_id,
        workerId: sourceRow2.worker_id,
        ...sourceRow2.thread_id ? { threadId: sourceRow2.thread_id } : worker?.thread_id ? { threadId: worker.thread_id } : {},
        ...sourceRow2.item_status ? { status: sourceRow2.item_status } : {},
        ...artifactIds?.length ? { artifactIds } : {},
        rawRef: { table: "worker_events", id: sourceRow2.id, seq: sourceRow2.seq }
      });
    }
    if (row.source === "worker") {
      const sourceRow2 = this.db.prepare(
        `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                  started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
           from workers where id = ?`
      ).get(row.worker_id ?? workerIdFromSourceId(row.source_id));
      if (!sourceRow2) return void 0;
      const status = statusFromWorkerSourceId(row.source_id) ?? sourceRow2.status;
      return timelineEntry(row, {
        kind: sourceRow2.type,
        title: `${sourceRow2.type} worker ${status}`,
        summary: summarizeTimelinePayload({
          status,
          attempt: sourceRow2.attempt,
          backend: sourceRow2.backend,
          exitCode: sourceRow2.exit_code,
          error: sourceRow2.error
        }),
        runId: sourceRow2.run_id,
        workerId: sourceRow2.id,
        ...sourceRow2.thread_id ? { threadId: sourceRow2.thread_id } : {},
        status,
        artifactIds: [sourceRow2.result_artifact_id, sourceRow2.raw_jsonl_artifact_id].filter((id) => Boolean(id)),
        rawRef: { table: "workers", id: row.source_id }
      });
    }
    if (row.source === "state") {
      const sourceRow2 = this.db.prepare("select id, run_id, status, state, version, created_at from states where id = ?").get(Number(row.source_id));
      if (!sourceRow2) return void 0;
      return timelineEntry(row, {
        kind: sourceRow2.state ?? sourceRow2.status,
        title: "State changed",
        summary: summarizeTimelinePayload({ status: sourceRow2.status, state: sourceRow2.state, version: sourceRow2.version }),
        ...sourceRow2.run_id ? { runId: sourceRow2.run_id } : {},
        status: sourceRow2.status,
        rawRef: { table: "states", id: String(sourceRow2.id), seq: sourceRow2.id }
      });
    }
    if (row.source === "gate") {
      const sourceRow2 = this.db.prepare(
        `select id, run_id, kind, status, message, details_json, created_at,
                  resolved_at, decision_note, decided_at
           from gates where id = ?`
      ).get(row.source_id);
      if (!sourceRow2) return void 0;
      return timelineEntry(row, {
        kind: sourceRow2.kind,
        title: `Gate opened: ${sourceRow2.kind}`,
        summary: sourceRow2.message,
        ...sourceRow2.run_id ? { runId: sourceRow2.run_id } : {},
        status: sourceRow2.status,
        rawRef: { table: "gates", id: sourceRow2.id }
      });
    }
    if (row.source === "artifact") {
      const sourceRow2 = this.db.prepare("select id, run_id, kind, name, path, sha256, created_at from artifacts where id = ?").get(row.source_id);
      if (!sourceRow2) return void 0;
      return timelineEntry(row, {
        kind: sourceRow2.kind,
        title: `Artifact: ${sourceRow2.name ?? sourceRow2.id}`,
        summary: summarizeTimelinePayload({ name: sourceRow2.name ?? sourceRow2.id, kind: sourceRow2.kind, sha256: sourceRow2.sha256 }),
        runId: sourceRow2.run_id,
        artifactIds: [sourceRow2.id],
        rawRef: { table: "artifacts", id: sourceRow2.id }
      });
    }
    const sourceRow = this.db.prepare("select id, run_id, kind, message, created_at from decisions where id = ?").get(row.source_id);
    if (!sourceRow) return void 0;
    return timelineEntry(row, {
      kind: sourceRow.kind,
      title: sourceRow.kind,
      summary: sourceRow.message,
      runId: sourceRow.run_id,
      rawRef: { table: "decisions", id: sourceRow.id }
    });
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AgentLoopError("storage_error", "Transaction rollback failed.", {
          details: {
            cause: error instanceof Error ? error.message : String(error),
            rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }
        });
      }
      throw error;
    }
  }
};
function timelineEntry(row, entry) {
  return {
    timelineSeq: row.timeline_seq,
    occurredAt: row.created_at,
    cursor: encodeTimelineCursor(row.timeline_seq, row.created_at),
    source: row.source,
    kind: entry.kind,
    ...entry.runId ? { runId: entry.runId } : {},
    ...entry.workerId ? { workerId: entry.workerId } : {},
    ...entry.threadId ? { threadId: entry.threadId } : {},
    title: truncateTimelineText(redactTimelineText(entry.title), 160),
    summary: truncateTimelineText(redactTimelineText(entry.summary), 1e3),
    ...entry.status ? { status: entry.status } : {},
    ...entry.artifactIds?.length ? { artifactIds: entry.artifactIds } : {},
    createdAt: row.created_at,
    rawRef: entry.rawRef
  };
}
function backfillTimelineIndex(db) {
  db.exec(`
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    select source, source_id, source_seq, run_id, worker_id, created_at
    from (
      select 'event' as source, id as source_id, seq as source_seq, run_id, null as worker_id, created_at
        from events
      union all
      select 'worker_event' as source, id as source_id, seq as source_seq, run_id, worker_id, created_at
        from worker_events
      union all
      select 'worker' as source, id || ':' || status as source_id, null as source_seq, run_id, id as worker_id, started_at as created_at
        from workers
      union all
      select 'state' as source, cast(id as text) as source_id, id as source_seq, run_id, null as worker_id, created_at
        from states
      union all
      select 'gate' as source, id as source_id, null as source_seq, run_id, null as worker_id, created_at
        from gates
      union all
      select 'artifact' as source, id as source_id, null as source_seq, run_id, null as worker_id, created_at
        from artifacts
      union all
      select 'decision' as source, id as source_id, null as source_seq, run_id, null as worker_id, created_at
        from decisions
    )
    order by created_at asc, source asc, source_id asc;
  `);
}
function normalizeTimelineSources(sources) {
  const unique = [...new Set(sources)];
  if (unique.some((source) => !isTimelineSource(source))) {
    throw new AgentLoopError("invalid_config", "Unsupported timeline source.", { details: { sources } });
  }
  return unique;
}
function isTimelineSource(value) {
  return TIMELINE_SOURCES.includes(value);
}
function clampLimit(value) {
  if (!Number.isFinite(value)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 200);
}
function encodeTimelineCursor(timelineSeq, occurredAt) {
  return Buffer.from(JSON.stringify({ timelineSeq, ...occurredAt ? { occurredAt } : {} }), "utf8").toString("base64url");
}
function decodeTimelineCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const timelineSeq = parsed.timelineSeq;
      const occurredAt = parsed.occurredAt;
      if (typeof timelineSeq === "number" && Number.isInteger(timelineSeq) && timelineSeq > 0 && typeof occurredAt === "string" && occurredAt.length > 0) {
        return { timelineSeq, occurredAt };
      }
    }
  } catch {
  }
  throw new AgentLoopError("invalid_config", "Timeline cursor is invalid.");
}
function timelineMissingSourceRows(db) {
  const checks = [
    {
      source: "event",
      sql: `select count(*) as count
            from events source
            left join timeline_index ti on ti.source = 'event' and ti.source_id = source.id
            where ti.timeline_seq is null`
    },
    {
      source: "worker_event",
      sql: `select count(*) as count
            from worker_events source
            left join timeline_index ti on ti.source = 'worker_event' and ti.source_id = source.id
            where ti.timeline_seq is null`
    },
    {
      source: "worker",
      sql: `select count(*) as count
            from workers source
            left join timeline_index ti on ti.source = 'worker' and ti.source_id = source.id || ':' || source.status
            where ti.timeline_seq is null`
    },
    {
      source: "state",
      sql: `select count(*) as count
            from states source
            left join timeline_index ti on ti.source = 'state' and ti.source_id = cast(source.id as text)
            where ti.timeline_seq is null`
    },
    {
      source: "gate",
      sql: `select count(*) as count
            from gates source
            left join timeline_index ti on ti.source = 'gate' and ti.source_id = source.id
            where ti.timeline_seq is null`
    },
    {
      source: "artifact",
      sql: `select count(*) as count
            from artifacts source
            left join timeline_index ti on ti.source = 'artifact' and ti.source_id = source.id
            where ti.timeline_seq is null`
    },
    {
      source: "decision",
      sql: `select count(*) as count
            from decisions source
            left join timeline_index ti on ti.source = 'decision' and ti.source_id = source.id
            where ti.timeline_seq is null`
    }
  ];
  return checks.flatMap((check) => {
    const row = db.prepare(check.sql).get();
    const missing = row?.count ?? 0;
    return missing > 0 ? [{ source: check.source, missing }] : [];
  });
}
function summarizeTimelinePayload(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === void 0 || value === null) {
    return "";
  }
  return JSON.stringify(redactTimelineValue(value));
}
function redactTimelineValue(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactTimelineValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const redacted = {};
  for (const [key, nested] of Object.entries(value).slice(0, 40)) {
    redacted[key] = isSecretKey(key) ? "[redacted]" : redactTimelineValue(nested);
  }
  return redacted;
}
function redactTimelineText(value) {
  return redactSecrets(value);
}
function truncateTimelineText(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
function statusFromWorkerSourceId(sourceId) {
  const status = sourceId.split(":").at(-1);
  return status && ["running", "succeeded", "failed", "timed_out", "invalid_output"].includes(status) ? status : void 0;
}
function workerIdFromSourceId(sourceId) {
  return sourceId.split(":")[0] ?? sourceId;
}
function fromRunRow(row) {
  return {
    id: row.id,
    status: row.status,
    ...row.current_state ? { currentState: row.current_state } : {},
    version: row.version,
    ...row.branch ? { branch: row.branch } : {},
    ...row.worktree_clean !== null ? { worktreeClean: row.worktree_clean === 1 } : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...row.started_at ? { startedAt: row.started_at } : {},
    ...row.stopped_at ? { stoppedAt: row.stopped_at } : {}
  };
}
function fromEventRow(row) {
  return {
    id: row.id,
    seq: row.seq,
    ...row.run_id ? { runId: row.run_id } : {},
    kind: row.kind,
    message: row.message,
    ...row.state_before ? { stateBefore: row.state_before } : {},
    ...row.state_after ? { stateAfter: row.state_after } : {},
    ...row.payload_json ? { payload: parseJson(row.payload_json, "Stored event payload JSON is invalid.") } : {},
    ...row.artifact_ids_json ? { artifactIds: parseJson(row.artifact_ids_json, "Stored event artifact list JSON is invalid.") } : {},
    createdAt: row.created_at
  };
}
function statusGateFromRow(row) {
  return {
    kind: row.kind,
    message: row.message,
    ...row.details_json ? { details: parseJson(row.details_json, "Stored gate details JSON is invalid.") } : {}
  };
}
function latestGateSatisfied(db, runId) {
  const row = db.prepare(
    `select status
       from gates
       where run_id = ?
       order by created_at desc
       limit 1`
  ).get(runId);
  return row?.status === "approved" || row?.status === "resolved";
}
function fromGateRow(row) {
  return {
    id: row.id,
    ...row.run_id ? { runId: row.run_id } : {},
    kind: row.kind,
    status: row.status,
    message: row.message,
    ...row.details_json ? { details: parseJson(row.details_json, "Stored gate details JSON is invalid.") } : {},
    createdAt: row.created_at,
    ...row.resolved_at ? { resolvedAt: row.resolved_at } : {},
    ...row.decision_note ? { decisionNote: row.decision_note } : {},
    ...row.decided_at ? { decidedAt: row.decided_at } : {}
  };
}
function fromArtifactRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    name: row.name ?? row.id,
    path: row.path,
    sha256: row.sha256 ?? "",
    createdAt: row.created_at
  };
}
function fromPrLinkRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    branch: row.branch,
    prNumber: row.pr_number,
    url: row.url,
    headRef: row.head_ref,
    baseRef: row.base_ref,
    state: row.state,
    draft: row.draft === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function fromCiCheckRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    prNumber: row.pr_number,
    name: row.name,
    status: row.status,
    ...row.conclusion ? { conclusion: row.conclusion } : {},
    ...row.url ? { url: row.url } : {},
    ...row.started_at ? { startedAt: row.started_at } : {},
    ...row.completed_at ? { completedAt: row.completed_at } : {},
    observedAt: row.observed_at
  };
}
function fromReviewCommentRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    prNumber: row.pr_number,
    commentId: row.comment_id,
    url: row.url,
    author: row.author,
    body: row.body,
    path: row.path,
    ...row.line === null ? {} : { line: row.line },
    diffHunk: row.diff_hunk,
    isResolved: row.is_resolved === 1,
    isOutdated: row.is_outdated === 1,
    actionable: row.actionable === 1,
    status: row.status,
    observedAt: row.observed_at
  };
}
function fromDecisionRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    message: row.message,
    ...row.details_json ? { details: parseJson(row.details_json, "Stored decision details JSON is invalid.") } : {},
    createdAt: row.created_at
  };
}
function fromRunCheckRow(row) {
  return {
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    ...row.details_json ? { details: JSON.parse(row.details_json) } : {},
    createdAt: row.created_at
  };
}
function fromWorkerRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    backend: row.backend,
    status: row.status,
    ...row.thread_id ? { threadId: row.thread_id } : {},
    attempt: row.attempt,
    resumeUsed: row.resume_used === 1,
    startedAt: row.started_at,
    ...row.completed_at ? { completedAt: row.completed_at } : {},
    ...row.exit_code === null ? {} : { exitCode: row.exit_code },
    ...row.result_artifact_id ? { resultArtifactId: row.result_artifact_id } : {},
    ...row.raw_jsonl_artifact_id ? { rawJsonlArtifactId: row.raw_jsonl_artifact_id } : {},
    ...row.error ? { error: row.error } : {}
  };
}
function fromWorkerEventRow(row) {
  return {
    id: row.id,
    seq: row.seq,
    workerId: row.worker_id,
    runId: row.run_id,
    eventType: row.event_type,
    ...row.item_type ? { itemType: row.item_type } : {},
    ...row.item_id ? { itemId: row.item_id } : {},
    ...row.item_status ? { itemStatus: row.item_status } : {},
    ...row.thread_id ? { threadId: row.thread_id } : {},
    ...row.backend ? { backend: row.backend } : {},
    ...row.summary_json ? { summary: parseJson(row.summary_json, "Stored worker event summary JSON is invalid.") } : {},
    ...row.usage_json ? { usage: parseJson(row.usage_json, "Stored worker event usage JSON is invalid.") } : {},
    ...row.artifact_ids_json ? { artifactIds: parseJson(row.artifact_ids_json, "Stored worker event artifact list JSON is invalid.") } : {},
    createdAt: row.created_at
  };
}
function workerEventTimelineTitle(row) {
  const item = row.item_type ?? row.event_type;
  return row.item_status ? `${row.item_status} ${item}` : item;
}
function isSupportedSchemaVersion(value) {
  return SUPPORTED_SCHEMA_VERSIONS.includes(value);
}
function rebuildEventsWithSeq(db) {
  if (hasColumn(db, "events", "seq")) {
    return;
  }
  db.exec(`
    alter table events rename to events_legacy_v6;
    create table events (
      seq integer primary key autoincrement,
      id text not null unique,
      run_id text,
      kind text not null,
      message text not null,
      state_before text,
      state_after text,
      payload_json text,
      artifact_ids_json text,
      created_at text not null,
      foreign key(run_id) references runs(id)
    );
    insert into events (
      id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
    )
    select id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
      from events_legacy_v6
      order by created_at asc, id asc;
    drop table events_legacy_v6;
  `);
}
function rebuildWorkerEventsWithSeq(db) {
  if (hasColumn(db, "worker_events", "seq")) {
    return;
  }
  db.exec(`
    alter table worker_events rename to worker_events_legacy_v6;
    create table worker_events (
      seq integer primary key autoincrement,
      id text not null unique,
      worker_id text not null,
      run_id text not null,
      event_type text not null,
      item_type text,
      summary_json text,
      usage_json text,
      created_at text not null,
      foreign key(worker_id) references workers(id),
      foreign key(run_id) references runs(id)
    );
    insert into worker_events (
      id, worker_id, run_id, event_type, item_type, summary_json, usage_json, created_at
    )
    select id, worker_id, run_id, event_type, item_type, summary_json, usage_json, created_at
      from worker_events_legacy_v6
      order by created_at asc, id asc;
    drop table worker_events_legacy_v6;
  `);
}
function dedupeHighFidelityWorkerEventsV8(db) {
  db.exec(`
    create temp table if not exists worker_event_dedupe_ids (
      id text primary key
    );
    delete from worker_event_dedupe_ids;
    insert or ignore into worker_event_dedupe_ids (id)
    select id from (
      select id from (
        select id,
               seq,
               row_number() over (
                 partition by thread_id, item_id, coalesce(item_status, '')
                 order by seq asc
               ) as duplicate_rank
        from worker_events
        where thread_id is not null and item_id is not null
      )
      where duplicate_rank > 1
    );
    insert or ignore into worker_event_dedupe_ids (id)
    select id from (
      select id from (
        select id,
               seq,
               row_number() over (
                 partition by thread_id, event_type
                 order by seq asc
               ) as duplicate_rank
        from worker_events
        where thread_id is not null and item_id is null
      )
      where duplicate_rank > 1
    );
    delete from timeline_index
    where source = 'worker_event'
      and source_id in (select id from worker_event_dedupe_ids);
    delete from worker_events
    where id in (select id from worker_event_dedupe_ids);
    delete from worker_event_dedupe_ids;
  `);
}
function hasColumn(db, tableName, columnName) {
  validateSqlIdentifier(tableName);
  validateSqlIdentifier(columnName);
  const columns = db.prepare(`pragma table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}
function hasTable(db, tableName) {
  validateSqlIdentifier(tableName);
  const row = db.prepare("select 1 from sqlite_master where type = 'table' and name = ? limit 1").get(tableName);
  return row !== void 0;
}
function boolToDb(value) {
  if (value === void 0) {
    return null;
  }
  return value ? 1 : 0;
}
function addColumnIfMissing(db, tableName, columnName, definition) {
  validateSqlIdentifier(tableName);
  validateSqlIdentifier(columnName);
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`alter table ${tableName} add column ${columnName} ${definition}`);
  }
}
function validateSqlIdentifier(value) {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new AgentLoopError("storage_error", `Unsafe SQLite identifier: ${value}`);
  }
}
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function parseJson(value, message) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new AgentLoopError("storage_error", message, {
      details: { cause: error instanceof Error ? error.message : String(error) }
    });
  }
}
function isUniqueConstraintError(error) {
  return error instanceof Error && /unique constraint/i.test(error.message);
}
function toStorageError(error, message) {
  if (error instanceof AgentLoopError) {
    return error;
  }
  return new AgentLoopError("storage_error", message, {
    details: { cause: error instanceof Error ? error.message : String(error) }
  });
}

// plugins/autonomous-pr-loop/core/hook-observer.ts
function observeCodexHook(event, payload, repoRoot) {
  try {
    const route = resolveHookRoute(payload, { legacyRepoRoot: repoRoot });
    if (route.status === "no_match") {
      return { continue: true, observed: false };
    }
    if (route.status === "ambiguous") {
      return { continue: true, observed: false, error: route.reason };
    }
    if (route.status === "route_error") {
      return { continue: true, observed: false, error: route.reason };
    }
    const storage = new SqliteAgentLoopStorage(statePath(route.binding.repoRoot));
    try {
      const run = route.binding.runId ? storage.listRuns(200).find((item) => item.id === route.binding.runId) : storage.getCurrentRun();
      storage.appendEvent({
        ...run ? { runId: run.id } : {},
        kind: hookEventKind(event),
        message: `Codex ${event} hook observed.`,
        payload: {
          ...normalizeHookPayload(event, payload),
          hookRouting: route.legacy ? "legacy" : "binding",
          worktreeRoot: route.context.worktreeRoot
        }
      });
    } finally {
      storage.close();
    }
    return { continue: true, observed: true };
  } catch (error) {
    return { continue: true, observed: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function normalizeHookPayload(event, payload) {
  const text = JSON.stringify(payload ?? {});
  const base = {
    event,
    payloadLength: text.length,
    payloadSha256: createHash2("sha256").update(text).digest("hex")
  };
  if (event === "UserPromptSubmit" || event === "PermissionRequest") {
    return { ...base, redacted: true };
  }
  if (!isRecord(payload)) {
    return base;
  }
  return {
    ...base,
    redacted: true,
    toolName: stringValue2(payload.tool_name) ?? stringValue2(payload.toolName) ?? stringValue2(payload.tool),
    matcher: stringValue2(payload.matcher),
    sessionIdHash: hashOptional(stringValue2(payload.session_id) ?? stringValue2(payload.sessionId)),
    command: summarizeCommand(payload)
  };
}
function summarizeCommand(payload) {
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : payload;
  const command = stringValue2(toolInput.command) ?? stringValue2(toolInput.cmd) ?? stringValue2(toolInput.input);
  return command ? redactSecrets(command.slice(0, 500)) : void 0;
}
function stringValue2(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function hashOptional(value) {
  return value ? createHash2("sha256").update(value).digest("hex") : void 0;
}

// plugins/autonomous-pr-loop/hooks/observe-runner.ts
function runObserveOnlyHook(event) {
  const input = readStdinJson();
  const repoRoot = process.env.AGENT_LOOP_REPO_ROOT;
  const result = observeCodexHook(event, input, repoRoot);
  if (result.error) {
    process.stderr.write(`agent-loop ${event} observe failed: ${result.error}
`);
  }
  process.stdout.write(`${JSON.stringify({ continue: true })}
`);
}
function readStdinJson() {
  const text = readFileSync2(0, "utf8");
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { rawLength: text.length };
  }
}

// plugins/autonomous-pr-loop/hooks/stop.ts
runObserveOnlyHook("Stop");
