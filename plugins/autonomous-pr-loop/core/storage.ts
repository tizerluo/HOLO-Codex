import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { withConfigDefaults } from "./config.js";
import { AgentLoopError } from "./errors.js";
import { isSecretKey, redactSecrets } from "./redaction.js";
import type {
  AgentLoopConfig,
  AgentLoopArtifactRecord,
  AgentLoopCiCheck,
  AgentLoopDecision,
  AgentLoopEvent,
  AgentLoopGate,
  AgentLoopGateKind,
  AgentTimelineEntry,
  AgentTimelineIntegrityReport,
  AgentTimelinePage,
  AgentTimelineQuery,
  AgentTimelineSource,
  AgentLoopRunCheck,
  AgentLoopPrLink,
  AgentLoopReviewComment,
  AgentLoopRun,
  AgentLoopStatus,
  AgentLoopStorage,
  WorkerBackend,
  WorkerEvent,
  WorkerRun,
  WorkerStatus,
  WorkerType
} from "./types.js";

export const STORAGE_SCHEMA_VERSION = 8;
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3, 4, 5, 6, 7, STORAGE_SCHEMA_VERSION] as const;
export type StorageOpenMode = "rw" | "ro";
const TIMELINE_SOURCES = ["event", "worker_event", "worker", "state", "gate", "artifact", "decision"] as const;
const TIMELINE_TRIGGER_NAMES = [
  "timeline_events_insert",
  "timeline_worker_events_insert",
  "timeline_workers_insert",
  "timeline_workers_status_update",
  "timeline_states_insert",
  "timeline_gates_insert",
  "timeline_artifacts_insert",
  "timeline_decisions_insert"
] as const;
const PR_C_TABLES_SQL = `
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
const PR_D_TABLES_SQL = `
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
const PR_E_INDEXES_SQL = `
  create unique index if not exists runs_single_running
    on runs(status)
    where status = 'RUNNING';
`;
const PR_E_TABLES_SQL = `
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
const TIMELINE_INDEX_SQL = `
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
const TIMELINE_TRIGGERS_SQL = `
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
const SCHEMA_SQL = `
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

/** SQLite-backed implementation of the shared Agent Loop storage contract. */
export class SqliteAgentLoopStorage implements AgentLoopStorage {
  private readonly db: DatabaseSync;
  private readonly mode: StorageOpenMode;
  private readonly listWorkersByRunStatement: StatementSync;
  private readonly listWorkersStatement: StatementSync;

  constructor(private readonly path: string, options: { mode?: StorageOpenMode } = {}) {
    this.mode = options.mode ?? "rw";
    if (this.mode === "rw") {
      mkdirSync(dirname(path), { recursive: true });
    } else if (!existsSync(path)) {
      throw new AgentLoopError("storage_error", "Read-only storage file does not exist.", {
        details: { path }
      });
    }
    this.db = new DatabaseSync(path, {
      readOnly: this.mode === "ro",
      enableForeignKeyConstraints: true,
      timeout: 5000
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

  close(): void {
    this.db.close();
  }

  writeRepoConfig(config: AgentLoopConfig): void {
    const snapshot = JSON.stringify({ schemaVersion: STORAGE_SCHEMA_VERSION, ...config });
    this.transaction(() => {
      this.db
        .prepare(
          `insert into repo_config (id, schema_version, config_json, updated_at)
           values (1, ?, ?, ?)
           on conflict(id) do update set
             schema_version = excluded.schema_version,
             config_json = excluded.config_json,
             updated_at = excluded.updated_at`
        )
        .run(STORAGE_SCHEMA_VERSION, snapshot, now());
    });
  }

  readRepoConfig(): AgentLoopConfig | undefined {
    const row = this.db
      .prepare("select schema_version, config_json from repo_config where id = 1")
      .get() as { schema_version: number; config_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    if (!isSupportedSchemaVersion(row.schema_version)) {
      throw new AgentLoopError(
        "storage_schema_mismatch",
        `Stored repo config schema version ${row.schema_version} is not supported.`,
        { details: { expected: STORAGE_SCHEMA_VERSION, actual: row.schema_version } }
      );
    }
    const parsed = parseJson(row.config_json, "Stored repo config JSON is invalid.") as AgentLoopConfig & {
      schemaVersion?: number;
    };
    const { schemaVersion: _schemaVersion, ...config } = parsed;
    return config;
  }

  createRun(
    status: AgentLoopStatus,
    options: {
      currentState?: string;
      branch?: string;
      worktreeClean?: boolean;
    } = {}
  ): AgentLoopRun {
    const createdAt = now();
    const run: AgentLoopRun = {
      id: randomUUID(),
      status,
      ...(options.currentState ? { currentState: options.currentState } : {}),
      version: 0,
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.worktreeClean !== undefined ? { worktreeClean: options.worktreeClean } : {}),
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt
    };
    try {
      this.transaction(() => {
        this.db
          .prepare(
            `insert into runs (
               id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
             )
             values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)`
          )
          .run(
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
        this.db
          .prepare(
            `insert into states (run_id, status, state, version, payload_json, created_at)
             values (?, ?, ?, ?, null, ?)`
          )
          .run(run.id, run.status, run.currentState ?? run.status, run.version, run.updatedAt);
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

  getOrCreateActiveRun(options: {
    currentState?: string;
    branch?: string;
    worktreeClean?: boolean;
  } = {}): { run: AgentLoopRun; created: boolean } {
    return this.transaction(() => {
      const active = this.getActiveRun();
      if (active) {
        return { run: active, created: false };
      }
      const createdAt = now();
      const run: AgentLoopRun = {
        id: randomUUID(),
        status: "RUNNING",
        ...(options.currentState ? { currentState: options.currentState } : {}),
        version: 0,
        ...(options.branch ? { branch: options.branch } : {}),
        ...(options.worktreeClean !== undefined ? { worktreeClean: options.worktreeClean } : {}),
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt
      };
      this.db
        .prepare(
          `insert into runs (
             id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
           )
           values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)`
        )
        .run(
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
      this.db
        .prepare(
          `insert into states (run_id, status, state, version, payload_json, created_at)
           values (?, ?, ?, ?, null, ?)`
        )
        .run(run.id, run.status, run.currentState ?? run.status, run.version, run.updatedAt);
      return { run, created: true };
    });
  }

  recordRunCheck(check: Omit<AgentLoopRunCheck, "createdAt">): AgentLoopRunCheck {
    const stored: AgentLoopRunCheck = { ...check, createdAt: now() };
    this.transaction(() => {
      this.db
        .prepare(
          `insert into run_checks (run_id, kind, status, details_json, created_at)
           values (?, ?, ?, ?, ?)
           on conflict(run_id, kind) do update set
             status = excluded.status,
             details_json = excluded.details_json,
             created_at = excluded.created_at`
        )
        .run(
          stored.runId,
          stored.kind,
          stored.status,
          stored.details === undefined ? null : JSON.stringify(stored.details),
          stored.createdAt
        );
    });
    return stored;
  }

  hasRunCheck(runId: string, kind: AgentLoopRunCheck["kind"]): boolean {
    const row = this.db
      .prepare("select 1 from run_checks where run_id = ? and kind = ? and status in ('passed', 'skipped') limit 1")
      .get(runId, kind);
    return row !== undefined;
  }

  listRunChecks(runId: string): AgentLoopRunCheck[] {
    const rows = this.db
      .prepare("select run_id, kind, status, details_json, created_at from run_checks where run_id = ? order by created_at desc")
      .all(runId);
    return (rows as unknown as RunCheckRow[]).map(fromRunCheckRow);
  }

  updateRunStatus(
    runId: string,
    expectedVersion: number,
    status: AgentLoopStatus,
    options: {
      currentState?: string;
      branch?: string;
      worktreeClean?: boolean;
      stoppedAt?: string;
    } = {}
  ): AgentLoopRun {
    const updatedAt = now();
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `update runs
           set status = ?,
               current_state = coalesce(?, current_state),
               branch = coalesce(?, branch),
               worktree_clean = coalesce(?, worktree_clean),
               stopped_at = coalesce(?, stopped_at),
               version = version + 1,
               updated_at = ?
           where id = ? and version = ?`
        )
        .run(
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
      this.db
        .prepare(
          `insert into states (run_id, status, state, version, payload_json, created_at)
           values (?, ?, ?, ?, null, ?)`
        )
        .run(run.id, run.status, run.currentState ?? run.status, run.version, run.updatedAt);
      return run;
    });
  }

  appendEvent(event: Omit<AgentLoopEvent, "id" | "seq" | "createdAt">): AgentLoopEvent {
    const stored = {
      id: randomUUID(),
      ...event,
      createdAt: now()
    };
    let seq = 0;
    this.transaction(() => {
      this.db
        .prepare(
          `insert into events (
             id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
           )
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          stored.id,
          stored.runId ?? null,
          stored.kind,
          stored.message,
          stored.stateBefore ?? null,
          stored.stateAfter ?? null,
          stored.payload === undefined ? null : JSON.stringify(stored.payload),
          stored.artifactIds === undefined ? null : JSON.stringify(stored.artifactIds),
          stored.createdAt
        );
      seq = Number((this.db.prepare("select last_insert_rowid() as seq").get() as { seq: number }).seq);
    });
    return { seq, ...stored };
  }

  writeGate(gate: {
    runId?: string;
    kind: AgentLoopGateKind;
    message: string;
    details?: unknown;
  }): void {
    this.transaction(() => {
      this.db
        .prepare(
          `insert into gates (id, run_id, kind, status, message, details_json, created_at, resolved_at)
           values (?, ?, ?, 'open', ?, ?, ?, null)`
        )
        .run(
          randomUUID(),
          gate.runId ?? null,
          gate.kind,
          gate.message,
          gate.details === undefined ? null : JSON.stringify(gate.details),
          now()
        );
    });
  }

  resolveOpenGates(runId: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          `update gates
           set status = 'resolved', resolved_at = ?
           where run_id = ? and status = 'open'`
        )
        .run(now(), runId);
    });
  }

  resolveOpenGatesByKind(
    kind: AgentLoopGateKind,
    options: { scope?: "repo" | "run" | "all"; runId?: string } = {}
  ): void {
    const scope = options.scope ?? (options.runId ? "run" : "repo");
    this.transaction(() => {
      if (scope === "run") {
        if (!options.runId) {
          throw new AgentLoopError("storage_error", "runId is required for run-scoped gate recovery.");
        }
        this.db
          .prepare(
            `update gates
             set status = 'resolved', resolved_at = ?
             where kind = ? and run_id = ? and status = 'open'`
          )
          .run(now(), kind, options.runId);
        return;
      }
      if (scope === "repo") {
        this.db
          .prepare(
            `update gates
             set status = 'resolved', resolved_at = ?
             where kind = ? and run_id is null and status = 'open'`
          )
          .run(now(), kind);
        return;
      }
      this.db
        .prepare(
          `update gates
           set status = 'resolved', resolved_at = ?
           where kind = ? and status = 'open'`
        )
        .run(now(), kind);
    });
  }

  listGates(runId?: string): AgentLoopGate[] {
    const sql = `select id, run_id, kind, status, message, details_json, created_at,
                        resolved_at, decision_note, decided_at
                 from gates
                 ${runId ? "where run_id = ?" : ""}
                 order by created_at desc
                 limit 100`;
    const rows = runId
      ? this.db.prepare(sql).all(runId)
      : this.db.prepare(sql).all();
    return (rows as unknown as GateRow[]).map(fromGateRow);
  }

  getGate(gateId: string): AgentLoopGate | undefined {
    const row = this.db
      .prepare(
        `select id, run_id, kind, status, message, details_json, created_at,
                resolved_at, decision_note, decided_at
         from gates
         where id = ?`
      )
      .get(gateId) as GateRow | undefined;
    return row ? fromGateRow(row) : undefined;
  }

  decideGate(gateId: string, decision: "approved" | "rejected", note: string): AgentLoopGate {
    if (note.trim().length === 0) {
      throw new AgentLoopError("invalid_config", "Gate decision note is required.");
    }
    const decidedAt = now();
    this.transaction(() => {
      const result = this.db
        .prepare(
          `update gates
           set status = ?, decision_note = ?, decided_at = ?, resolved_at = coalesce(resolved_at, ?)
           where id = ? and status = 'open'`
        )
        .run(decision, note, decidedAt, decidedAt, gateId);
      if (result.changes !== 1) {
        const gate = this.getGate(gateId);
        if (!gate) {
          throw new AgentLoopError("storage_error", `Gate not found: ${gateId}`);
        }
        throw new AgentLoopError("storage_error", `Gate ${gateId} is not open.`, {
          details: { gateId, status: gate.status }
        });
      }
    });
    const gate = this.getGate(gateId);
    if (!gate) {
      throw new AgentLoopError("storage_error", `Gate not found after decision: ${gateId}`);
    }
    return gate;
  }

  getCurrentStatus(): {
    status: AgentLoopStatus;
    run?: AgentLoopRun;
    gate?: {
      kind: AgentLoopGateKind;
      message: string;
      details?: unknown;
    };
  } {
    const repoGate = this.db
      .prepare(
        `select kind, message, details_json
         from gates
         where status = 'open' and run_id is null
         order by created_at desc
         limit 1`
      )
      .get() as
      | { kind: AgentLoopGateKind; message: string; details_json: string | null }
      | undefined;

    if (repoGate) {
      return {
        status: "BLOCKED",
        gate: statusGateFromRow(repoGate)
      };
    }

    const row = this.db
      .prepare(
        `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         order by updated_at desc, rowid desc
         limit 1`
      )
      .get() as RunRow | undefined;

    if (!row) {
      return { status: "IDLE" };
    }
    const run = fromRunRow(row);
    const runGate = this.db
      .prepare(
        `select kind, message, details_json
         from gates
         where status = 'open' and run_id = ?
         order by created_at desc
         limit 1`
      )
      .get(run.id) as
      | { kind: AgentLoopGateKind; message: string; details_json: string | null }
      | undefined;

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

  listEvents(options: number | { sinceSeq?: number; limit?: number } = 50): AgentLoopEvent[] {
    const limit = typeof options === "number" ? options : options.limit ?? 50;
    const sinceSeq = typeof options === "number" ? undefined : options.sinceSeq;
    const rows = sinceSeq === undefined
      ? this.db
        .prepare(
          `select seq, id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
           from events
           order by seq desc
           limit ?`
        )
        .all(limit) as unknown as EventRow[]
      : this.db
        .prepare(
          `select seq, id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
           from events
           where seq > ?
           order by seq asc
           limit ?`
        )
        .all(sinceSeq, limit) as unknown as EventRow[];
    return rows.map(fromEventRow);
  }

  findLatestEvent(runId: string, kind: string): AgentLoopEvent | undefined {
    const row = this.db
      .prepare(
        `select seq, id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
         from events
         where run_id = ? and kind = ?
         order by seq desc
         limit 1`
      )
      .get(runId, kind) as EventRow | undefined;
    return row ? fromEventRow(row) : undefined;
  }

  listAgentTimeline(query: AgentTimelineQuery = {}): AgentTimelinePage {
    const limit = clampLimit(query.limit ?? 50);
    const cursor = query.cursor ? decodeTimelineCursor(query.cursor) : undefined;
    const params: SQLInputValue[] = [];
    const where: string[] = [];
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
    const rows = this.db
      .prepare(
        `select timeline_seq, source, source_id, source_seq, run_id, worker_id, created_at
         from timeline_index
         ${where.length ? `where ${where.join(" and ")}` : ""}
         order by created_at desc, timeline_seq desc
         limit ?`
      )
      .all(...params) as unknown as TimelineIndexRow[];
    const pageRows = rows.slice(0, limit);
    const entries = pageRows
      .map((row) => this.timelineEntry(row))
      .filter((entry): entry is AgentTimelineEntry => entry !== undefined);
    const last = pageRows[pageRows.length - 1];
    return {
      entries,
      ...(rows.length > limit && last ? { nextCursor: encodeTimelineCursor(last.timeline_seq, last.created_at) } : {})
    };
  }

  checkTimelineIntegrity(): AgentTimelineIntegrityReport {
    const missingTable = !hasTable(this.db, "timeline_index");
    const triggers = new Set((this.db
      .prepare("select name from sqlite_master where type = 'trigger' and name like 'timeline_%'")
      .all() as Array<{ name: string }>).map((row) => row.name));
    const missingTriggers = TIMELINE_TRIGGER_NAMES.filter((name) => !triggers.has(name));
    const sourceCounts = Object.fromEntries(TIMELINE_SOURCES.map((source) => [source, 0])) as Record<AgentTimelineSource, number>;
    const missingSourceRows: Array<{ source: AgentTimelineSource; missing: number }> = [];
    if (!missingTable) {
      const rows = this.db
        .prepare("select source, count(*) as count from timeline_index group by source")
        .all() as Array<{ source: AgentTimelineSource; count: number }>;
      for (const row of rows) {
        if ((TIMELINE_SOURCES as readonly string[]).includes(row.source)) {
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

  upsertPrLink(link: Omit<AgentLoopPrLink, "id" | "createdAt" | "updatedAt">): AgentLoopPrLink {
    const createdAt = now();
    const id = randomUUID();
    this.transaction(() => {
      this.db
        .prepare(
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
        )
        .run(
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

  getPrLink(runId: string): AgentLoopPrLink | undefined {
    const row = this.db
      .prepare(
        `select id, run_id, branch, pr_number, url, head_ref, base_ref, state, draft, created_at, updated_at
         from pr_links
         where run_id = ?
         order by updated_at desc
         limit 1`
      )
      .get(runId) as PrLinkRow | undefined;
    return row ? fromPrLinkRow(row) : undefined;
  }

  replaceCiChecks(
    runId: string,
    prNumber: number,
    checks: Array<Omit<AgentLoopCiCheck, "id" | "runId" | "prNumber" | "observedAt">>
  ): AgentLoopCiCheck[] {
    const observedAt = now();
    this.transaction(() => {
      this.db.prepare("delete from ci_checks where run_id = ? and pr_number = ?").run(runId, prNumber);
      for (const check of checks) {
        this.db
          .prepare(
            `insert into ci_checks (
               id, run_id, pr_number, name, status, conclusion, url, started_at, completed_at, observed_at
             )
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            randomUUID(),
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

  listCiChecks(runId: string): AgentLoopCiCheck[] {
    const rows = this.db
      .prepare(
        `select id, run_id, pr_number, name, status, conclusion, url, started_at, completed_at, observed_at
         from ci_checks
         where run_id = ?
         order by observed_at desc, name asc`
      )
      .all(runId) as unknown as CiCheckRow[];
    return rows.map(fromCiCheckRow);
  }

  replaceReviewComments(
    runId: string,
    prNumber: number,
    comments: Array<Omit<AgentLoopReviewComment, "id" | "runId" | "prNumber" | "observedAt">>
  ): AgentLoopReviewComment[] {
    const observedAt = now();
    this.transaction(() => {
      this.db.prepare("delete from review_comments where run_id = ? and pr_number = ?").run(runId, prNumber);
      for (const comment of comments) {
        this.db
          .prepare(
            `insert into review_comments (
               id, run_id, pr_number, comment_id, url, author, body, path, line, diff_hunk,
               is_resolved, is_outdated, actionable, status, observed_at
             )
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            randomUUID(),
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

  listReviewComments(runId: string): AgentLoopReviewComment[] {
    const rows = this.db
      .prepare(
        `select id, run_id, pr_number, comment_id, url, author, body, path, line, diff_hunk,
                is_resolved, is_outdated, actionable, status, observed_at
         from review_comments
         where run_id = ?
         order by observed_at desc, path asc`
      )
      .all(runId) as unknown as ReviewCommentRow[];
    return rows.map(fromReviewCommentRow);
  }

  appendDecision(decision: Omit<AgentLoopDecision, "id" | "createdAt">): AgentLoopDecision {
    const stored: AgentLoopDecision = { id: randomUUID(), ...decision, createdAt: now() };
    this.transaction(() => {
      this.db
        .prepare(
          `insert into decisions (id, run_id, kind, message, details_json, created_at)
           values (?, ?, ?, ?, ?, ?)`
        )
        .run(
          stored.id,
          stored.runId,
          stored.kind,
          stored.message,
          stored.details === undefined ? null : JSON.stringify(stored.details),
          stored.createdAt
        );
    });
    return stored;
  }

  listDecisions(runId: string): AgentLoopDecision[] {
    const rows = this.db
      .prepare(
        `select id, run_id, kind, message, details_json, created_at
         from decisions
         where run_id = ?
         order by created_at desc`
      )
      .all(runId) as unknown as DecisionRow[];
    return rows.map(fromDecisionRow);
  }

  createWorker(worker: {
    runId: string;
    type: WorkerType;
    backend: string;
    attempt: number;
    resumeUsed: boolean;
  }): WorkerRun {
    const id = randomUUID();
    const startedAt = now();
    try {
      this.transaction(() => {
        this.db
          .prepare(
            `insert into workers (
               id, run_id, type, backend, status, thread_id, attempt, resume_used,
               started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
             )
             values (?, ?, ?, ?, 'running', null, ?, ?, ?, null, null, null, null, null)`
          )
          .run(id, worker.runId, worker.type, worker.backend, worker.attempt, boolToDb(worker.resumeUsed), startedAt);
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

  updateWorker(workerId: string, patch: {
    status?: WorkerStatus;
    threadId?: string;
    completedAt?: string;
    exitCode?: number;
    resultArtifactId?: string;
    rawJsonlArtifactId?: string;
    error?: string;
  }): WorkerRun {
    this.transaction(() => {
      this.db
        .prepare(
          `update workers
           set status = coalesce(?, status),
               thread_id = coalesce(?, thread_id),
               completed_at = coalesce(?, completed_at),
               exit_code = coalesce(?, exit_code),
               result_artifact_id = coalesce(?, result_artifact_id),
               raw_jsonl_artifact_id = coalesce(?, raw_jsonl_artifact_id),
               error = coalesce(?, error)
           where id = ?`
        )
        .run(
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

  getRunningWorker(): WorkerRun | undefined {
    const row = this.db
      .prepare(
        `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
         from workers
         where status = 'running'
         order by started_at desc
         limit 1`
      )
      .get() as WorkerRow | undefined;
    return row ? fromWorkerRow(row) : undefined;
  }

  listWorkers(runId?: string, limit = 50): WorkerRun[] {
    const rows = runId
      ? this.listWorkersByRunStatement.all(runId, limit) as unknown as WorkerRow[]
      : this.listWorkersStatement.all(limit) as unknown as WorkerRow[];
    return rows.map(fromWorkerRow);
  }

  appendWorkerEvent(event: Omit<WorkerEvent, "id" | "seq" | "createdAt">): WorkerEvent {
    const existing = this.findDuplicateWorkerEvent(event);
    if (existing) {
      return existing;
    }
    const stored = { id: randomUUID(), ...event, createdAt: now() };
    let seq = 0;
    this.transaction(() => {
      this.db
        .prepare(
          `insert into worker_events (
             id, worker_id, run_id, event_type, item_type, item_id, item_status,
             thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           )
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          stored.id,
          stored.workerId,
          stored.runId,
          stored.eventType,
          stored.itemType ?? null,
          stored.itemId ?? null,
          stored.itemStatus ?? null,
          stored.threadId ?? null,
          stored.backend ?? null,
          stored.summary === undefined ? null : JSON.stringify(stored.summary),
          stored.usage === undefined ? null : JSON.stringify(stored.usage),
          stored.artifactIds === undefined ? null : JSON.stringify(stored.artifactIds),
          stored.createdAt
          );
      seq = Number((this.db.prepare("select last_insert_rowid() as seq").get() as { seq: number }).seq);
    });
    return { seq, ...stored };
  }

  listWorkerEvents(workerId: string): WorkerEvent[] {
    const rows = this.db
      .prepare(
        `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
         from worker_events
         where worker_id = ?
         order by seq asc`
      )
      .all(workerId) as unknown as WorkerEventRow[];
    return rows.map(fromWorkerEventRow);
  }

  private findDuplicateWorkerEvent(event: Omit<WorkerEvent, "id" | "seq" | "createdAt">): WorkerEvent | undefined {
    if (!event.threadId) {
      return undefined;
    }
    const row = event.itemId
      ? this.db
        .prepare(
          `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                  thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           from worker_events
           where thread_id = ? and item_id = ? and coalesce(item_status, '') = ?
           limit 1`
        )
        .get(event.threadId, event.itemId, event.itemStatus ?? "") as WorkerEventRow | undefined
      : this.db
        .prepare(
          `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                  thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           from worker_events
           where thread_id = ? and event_type = ? and item_id is null
           limit 1`
        )
        .get(event.threadId, event.eventType) as WorkerEventRow | undefined;
    return row ? fromWorkerEventRow(row) : undefined;
  }

  insertArtifact(record: AgentLoopArtifactRecord): void {
    this.transaction(() => {
      this.db
        .prepare(
          `insert into artifacts (id, run_id, kind, name, path, sha256, metadata_json, created_at)
           values (?, ?, ?, ?, ?, ?, null, ?)`
        )
        .run(
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

  getArtifact(artifactId: string): AgentLoopArtifactRecord {
    const row = this.db
      .prepare(
        `select id, run_id, kind, name, path, sha256, created_at
         from artifacts
         where id = ?`
      )
      .get(artifactId) as ArtifactRow | undefined;
    if (!row) {
      throw new AgentLoopError("storage_error", `Artifact not found: ${artifactId}`);
    }
    return fromArtifactRow(row);
  }

  listArtifacts(runId: string): AgentLoopArtifactRecord[] {
    const rows = this.db
      .prepare(
        `select id, run_id, kind, name, path, sha256, created_at
         from artifacts
         where run_id = ?
         order by created_at asc`
      )
      .all(runId) as unknown as ArtifactRow[];
    return rows.map(fromArtifactRow);
  }

  linkArtifactToEvent(eventId: string, artifactId: string): void {
    this.transaction(() => {
      const row = this.db
        .prepare("select artifact_ids_json from events where id = ?")
        .get(eventId) as { artifact_ids_json: string | null } | undefined;
      if (!row) {
        throw new AgentLoopError("storage_error", `Event not found: ${eventId}`);
      }
      const ids = row.artifact_ids_json
        ? (parseJson(row.artifact_ids_json, "Stored artifact id list is invalid.") as string[])
        : [];
      if (!ids.includes(artifactId)) {
        ids.push(artifactId);
      }
      this.db
        .prepare("update events set artifact_ids_json = ? where id = ?")
        .run(JSON.stringify(ids), eventId);
    });
  }

  getCurrentRun(): AgentLoopRun | undefined {
    const row = this.db
      .prepare(
        `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         order by updated_at desc
         limit 1`
      )
      .get() as RunRow | undefined;
    return row ? fromRunRow(row) : undefined;
  }

  listRuns(limit = 50): AgentLoopRun[] {
    const rows = this.db
      .prepare(
        `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         order by updated_at desc
         limit ?`
      )
      .all(limit) as unknown as RunRow[];
    return rows.map(fromRunRow);
  }

  /** Run a group of read queries against one SQLite snapshot. */
  readTransaction<T>(fn: () => T): T {
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

  private ensureSchema(): void {
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

  private migratePrC(): void {
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

  private migratePrD(): void {
    this.db.exec(PR_D_TABLES_SQL);
  }

  private migratePrE(): void {
    addColumnIfMissing(this.db, "gates", "decision_note", "text");
    addColumnIfMissing(this.db, "gates", "decided_at", "text");
    this.db.exec(PR_E_TABLES_SQL);
    this.db.exec(PR_E_INDEXES_SQL);
  }

  private migrateF0(): void {
    rebuildEventsWithSeq(this.db);
    rebuildWorkerEventsWithSeq(this.db);
  }

  private migrateTimelineV7(): void {
    this.db.exec(TIMELINE_INDEX_SQL);
    this.db.exec(TIMELINE_TRIGGERS_SQL);
    backfillTimelineIndex(this.db);
  }

  private migrateHighFidelityWorkerEventsV8(): void {
    addColumnIfMissing(this.db, "worker_events", "item_id", "text");
    addColumnIfMissing(this.db, "worker_events", "item_status", "text");
    addColumnIfMissing(this.db, "worker_events", "thread_id", "text");
    addColumnIfMissing(this.db, "worker_events", "backend", "text");
    addColumnIfMissing(this.db, "worker_events", "artifact_ids_json", "text");
    this.reconcileHighFidelityWorkerEventsV8();
  }

  private reconcileHighFidelityWorkerEventsV8(): void {
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

  private markSchemaVersion(): void {
    this.db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
  }

  private ensureRepoConfigVersion(): void {
    this.validateRepoConfigVersion(true);
  }

  private validateRepoConfigVersion(rewrite = false): void {
    let row: { schema_version: number; config_json: string } | undefined;
    try {
      row = this.db
        .prepare("select schema_version, config_json from repo_config where id = 1")
        .get() as { schema_version: number; config_json: string } | undefined;
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
    const parsed = parseJson(row.config_json, "Stored repo config snapshot JSON is invalid.") as {
      schemaVersion?: number;
      repoId?: string;
    };
    if (parsed.schemaVersion === STORAGE_SCHEMA_VERSION) {
      return;
    }
    if (rewrite && isSupportedSchemaVersion(parsed.schemaVersion ?? 0) && typeof parsed.repoId === "string") {
      this.writeRepoConfig(withConfigDefaults(parsed as Partial<AgentLoopConfig> & { repoId: string }));
      return;
    }
    throw new AgentLoopError("storage_error", "Stored repo config snapshot schemaVersion is invalid.", {
      details: { expected: STORAGE_SCHEMA_VERSION, actual: parsed.schemaVersion }
    });
  }

  private getUserVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  getRun(runId: string): AgentLoopRun | undefined {
    const row = this.db
      .prepare(
        `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         where id = ?`
      )
      .get(runId) as RunRow | undefined;
    return row ? fromRunRow(row) : undefined;
  }

  private getActiveRun(): AgentLoopRun | undefined {
    const row = this.db
      .prepare(
        `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         where status = 'RUNNING'
         order by updated_at desc
         limit 1`
      )
      .get() as RunRow | undefined;
    return row ? fromRunRow(row) : undefined;
  }

  private getWorker(workerId: string): WorkerRun {
    const row = this.db
      .prepare(
        `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
         from workers
         where id = ?`
      )
      .get(workerId) as WorkerRow | undefined;
    if (!row) {
      throw new AgentLoopError("storage_error", `Worker not found: ${workerId}`);
    }
    return fromWorkerRow(row);
  }

  private timelineEntry(row: TimelineIndexRow): AgentTimelineEntry | undefined {
    if (!isTimelineSource(row.source)) {
      return undefined;
    }
    if (row.source === "event") {
      const sourceRow = this.db
        .prepare(
          `select seq, id, run_id, kind, message, artifact_ids_json, created_at
           from events where id = ?`
        )
        .get(row.source_id) as Pick<EventRow, "seq" | "id" | "run_id" | "kind" | "message" | "artifact_ids_json" | "created_at"> | undefined;
      if (!sourceRow) return undefined;
      const artifactIds = sourceRow.artifact_ids_json
        ? parseJson(sourceRow.artifact_ids_json, "Stored event artifact list JSON is invalid.") as string[]
        : undefined;
      return timelineEntry(row, {
        kind: sourceRow.kind,
        title: sourceRow.kind,
        summary: sourceRow.message,
        ...(sourceRow.run_id ? { runId: sourceRow.run_id } : {}),
        ...(artifactIds ? { artifactIds } : {}),
        rawRef: { table: "events", id: sourceRow.id, seq: sourceRow.seq }
      });
    }
    if (row.source === "worker_event") {
      const sourceRow = this.db
        .prepare(
          `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                  thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           from worker_events where id = ?`
        )
        .get(row.source_id) as WorkerEventRow | undefined;
      if (!sourceRow) return undefined;
      const worker = this.db
        .prepare("select thread_id from workers where id = ?")
        .get(sourceRow.worker_id) as { thread_id: string | null } | undefined;
      const summary = sourceRow.summary_json
        ? summarizeTimelinePayload(parseJson(sourceRow.summary_json, "Stored worker event summary JSON is invalid."))
        : sourceRow.event_type;
      const artifactIds = sourceRow.artifact_ids_json
        ? parseJson(sourceRow.artifact_ids_json, "Stored worker event artifact list JSON is invalid.") as string[]
        : undefined;
      return timelineEntry(row, {
        kind: sourceRow.item_type ?? sourceRow.event_type,
        title: workerEventTimelineTitle(sourceRow),
        summary,
        runId: sourceRow.run_id,
        workerId: sourceRow.worker_id,
        ...(sourceRow.thread_id ? { threadId: sourceRow.thread_id } : worker?.thread_id ? { threadId: worker.thread_id } : {}),
        ...(sourceRow.item_status ? { status: sourceRow.item_status } : {}),
        ...(artifactIds?.length ? { artifactIds } : {}),
        rawRef: { table: "worker_events", id: sourceRow.id, seq: sourceRow.seq }
      });
    }
    if (row.source === "worker") {
      const sourceRow = this.db
        .prepare(
          `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                  started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
           from workers where id = ?`
        )
        .get(row.worker_id ?? workerIdFromSourceId(row.source_id)) as WorkerRow | undefined;
      if (!sourceRow) return undefined;
      const status = statusFromWorkerSourceId(row.source_id) ?? sourceRow.status;
      return timelineEntry(row, {
        kind: sourceRow.type,
        title: `${sourceRow.type} worker ${status}`,
        summary: summarizeTimelinePayload({
          status,
          attempt: sourceRow.attempt,
          backend: sourceRow.backend,
          exitCode: sourceRow.exit_code,
          error: sourceRow.error
        }),
        runId: sourceRow.run_id,
        workerId: sourceRow.id,
        ...(sourceRow.thread_id ? { threadId: sourceRow.thread_id } : {}),
        status,
        artifactIds: [sourceRow.result_artifact_id, sourceRow.raw_jsonl_artifact_id].filter((id): id is string => Boolean(id)),
        rawRef: { table: "workers", id: row.source_id }
      });
    }
    if (row.source === "state") {
      const sourceRow = this.db
        .prepare("select id, run_id, status, state, version, created_at from states where id = ?")
        .get(Number(row.source_id)) as Pick<StateRow, "id" | "run_id" | "status" | "state" | "version" | "created_at"> | undefined;
      if (!sourceRow) return undefined;
      return timelineEntry(row, {
        kind: sourceRow.state ?? sourceRow.status,
        title: "State changed",
        summary: summarizeTimelinePayload({ status: sourceRow.status, state: sourceRow.state, version: sourceRow.version }),
        ...(sourceRow.run_id ? { runId: sourceRow.run_id } : {}),
        status: sourceRow.status,
        rawRef: { table: "states", id: String(sourceRow.id), seq: sourceRow.id }
      });
    }
    if (row.source === "gate") {
      const sourceRow = this.db
        .prepare(
          `select id, run_id, kind, status, message, details_json, created_at,
                  resolved_at, decision_note, decided_at
           from gates where id = ?`
        )
        .get(row.source_id) as GateRow | undefined;
      if (!sourceRow) return undefined;
      return timelineEntry(row, {
        kind: sourceRow.kind,
        title: `Gate opened: ${sourceRow.kind}`,
        summary: sourceRow.message,
        ...(sourceRow.run_id ? { runId: sourceRow.run_id } : {}),
        status: sourceRow.status,
        rawRef: { table: "gates", id: sourceRow.id }
      });
    }
    if (row.source === "artifact") {
      const sourceRow = this.db
        .prepare("select id, run_id, kind, name, path, sha256, created_at from artifacts where id = ?")
        .get(row.source_id) as ArtifactRow | undefined;
      if (!sourceRow) return undefined;
      return timelineEntry(row, {
        kind: sourceRow.kind,
        title: `Artifact: ${sourceRow.name ?? sourceRow.id}`,
        summary: summarizeTimelinePayload({ name: sourceRow.name ?? sourceRow.id, kind: sourceRow.kind, sha256: sourceRow.sha256 }),
        runId: sourceRow.run_id,
        artifactIds: [sourceRow.id],
        rawRef: { table: "artifacts", id: sourceRow.id }
      });
    }
    const sourceRow = this.db
      .prepare("select id, run_id, kind, message, created_at from decisions where id = ?")
      .get(row.source_id) as Pick<DecisionRow, "id" | "run_id" | "kind" | "message" | "created_at"> | undefined;
    if (!sourceRow) return undefined;
    return timelineEntry(row, {
      kind: sourceRow.kind,
      title: sourceRow.kind,
      summary: sourceRow.message,
      runId: sourceRow.run_id,
      rawRef: { table: "decisions", id: sourceRow.id }
    });
  }

  private transaction<T>(fn: () => T): T {
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
}

interface TimelineIndexRow {
  timeline_seq: number;
  source: string;
  source_id: string;
  source_seq: number | null;
  run_id: string | null;
  worker_id: string | null;
  created_at: string;
}

interface StateRow {
  id: number;
  run_id: string | null;
  status: string;
  state: string | null;
  version: number;
  payload_json: string | null;
  created_at: string;
}

function timelineEntry(
  row: TimelineIndexRow,
  entry: {
    kind: string;
    title: string;
    summary: string;
    runId?: string;
    workerId?: string;
    threadId?: string;
    status?: string;
    artifactIds?: string[];
    rawRef: AgentTimelineEntry["rawRef"];
  }
): AgentTimelineEntry {
  return {
    timelineSeq: row.timeline_seq,
    occurredAt: row.created_at,
    cursor: encodeTimelineCursor(row.timeline_seq, row.created_at),
    source: row.source as AgentTimelineSource,
    kind: entry.kind,
    ...(entry.runId ? { runId: entry.runId } : {}),
    ...(entry.workerId ? { workerId: entry.workerId } : {}),
    ...(entry.threadId ? { threadId: entry.threadId } : {}),
    title: truncateTimelineText(redactTimelineText(entry.title), 160),
    summary: truncateTimelineText(redactTimelineText(entry.summary), 1000),
    ...(entry.status ? { status: entry.status } : {}),
    ...(entry.artifactIds?.length ? { artifactIds: entry.artifactIds } : {}),
    createdAt: row.created_at,
    rawRef: entry.rawRef
  };
}

function backfillTimelineIndex(db: DatabaseSync): void {
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

function normalizeTimelineSources(sources: AgentTimelineSource[]): AgentTimelineSource[] {
  const unique = [...new Set(sources)];
  if (unique.some((source) => !isTimelineSource(source))) {
    throw new AgentLoopError("invalid_config", "Unsupported timeline source.", { details: { sources } });
  }
  return unique;
}

function isTimelineSource(value: string): value is AgentTimelineSource {
  return (TIMELINE_SOURCES as readonly string[]).includes(value);
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 200);
}

interface TimelineCursor {
  timelineSeq: number;
  occurredAt: string;
}

function encodeTimelineCursor(timelineSeq: number, occurredAt?: string): string {
  return Buffer.from(JSON.stringify({ timelineSeq, ...(occurredAt ? { occurredAt } : {}) }), "utf8").toString("base64url");
}

function decodeTimelineCursor(cursor: string): TimelineCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const timelineSeq = (parsed as { timelineSeq?: unknown; occurredAt?: unknown }).timelineSeq;
      const occurredAt = (parsed as { timelineSeq?: unknown; occurredAt?: unknown }).occurredAt;
      if (
        typeof timelineSeq === "number" &&
        Number.isInteger(timelineSeq) &&
        timelineSeq > 0 &&
        typeof occurredAt === "string" &&
        occurredAt.length > 0
      ) {
        return { timelineSeq, occurredAt };
      }
    }
  } catch {
    // Fall through to the structured storage error below.
  }
  throw new AgentLoopError("invalid_config", "Timeline cursor is invalid.");
}

function timelineMissingSourceRows(db: DatabaseSync): Array<{ source: AgentTimelineSource; missing: number }> {
  const checks: Array<{ source: AgentTimelineSource; sql: string }> = [
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
    const row = db.prepare(check.sql).get() as { count: number } | undefined;
    const missing = row?.count ?? 0;
    return missing > 0 ? [{ source: check.source, missing }] : [];
  });
}

function summarizeTimelinePayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(redactTimelineValue(value));
}

function redactTimelineValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactTimelineValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    redacted[key] = isSecretKey(key) ? "[redacted]" : redactTimelineValue(nested);
  }
  return redacted;
}

function redactTimelineText(value: string): string {
  return redactSecrets(value);
}

function truncateTimelineText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function statusFromWorkerSourceId(sourceId: string): WorkerStatus | undefined {
  const status = sourceId.split(":").at(-1);
  return status && ["running", "succeeded", "failed", "timed_out", "invalid_output"].includes(status)
    ? status as WorkerStatus
    : undefined;
}

function workerIdFromSourceId(sourceId: string): string {
  return sourceId.split(":")[0] ?? sourceId;
}

interface RunRow {
  id: string;
  status: AgentLoopStatus;
  current_state: string | null;
  version: number;
  branch: string | null;
  worktree_clean: number | null;
  started_at: string | null;
  stopped_at: string | null;
  created_at: string;
  updated_at: string;
}

function fromRunRow(row: RunRow): AgentLoopRun {
  return {
    id: row.id,
    status: row.status,
    ...(row.current_state ? { currentState: row.current_state } : {}),
    version: row.version,
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.worktree_clean !== null ? { worktreeClean: row.worktree_clean === 1 } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.stopped_at ? { stoppedAt: row.stopped_at } : {})
  };
}

interface EventRow {
  seq: number;
  id: string;
  run_id: string | null;
  kind: string;
  message: string;
  state_before: string | null;
  state_after: string | null;
  payload_json: string | null;
  artifact_ids_json: string | null;
  created_at: string;
}

function fromEventRow(row: EventRow): AgentLoopEvent {
  return {
    id: row.id,
    seq: row.seq,
    ...(row.run_id ? { runId: row.run_id } : {}),
    kind: row.kind,
    message: row.message,
    ...(row.state_before ? { stateBefore: row.state_before } : {}),
    ...(row.state_after ? { stateAfter: row.state_after } : {}),
    ...(row.payload_json
      ? { payload: parseJson(row.payload_json, "Stored event payload JSON is invalid.") }
      : {}),
    ...(row.artifact_ids_json
      ? { artifactIds: parseJson(row.artifact_ids_json, "Stored event artifact list JSON is invalid.") as string[] }
      : {}),
    createdAt: row.created_at
  };
}

interface GateRow {
  id: string;
  run_id: string | null;
  kind: AgentLoopGateKind;
  status: "open" | "resolved" | "approved" | "rejected";
  message: string;
  details_json: string | null;
  created_at: string;
  resolved_at: string | null;
  decision_note: string | null;
  decided_at: string | null;
}

function statusGateFromRow(row: Pick<GateRow, "kind" | "message" | "details_json">): {
  kind: AgentLoopGateKind;
  message: string;
  details?: unknown;
} {
  return {
    kind: row.kind,
    message: row.message,
    ...(row.details_json
      ? { details: parseJson(row.details_json, "Stored gate details JSON is invalid.") }
      : {})
  };
}

function latestGateSatisfied(db: DatabaseSync, runId: string): boolean {
  const row = db
    .prepare(
      `select status
       from gates
       where run_id = ?
       order by created_at desc
       limit 1`
    )
    .get(runId) as { status: GateRow["status"] } | undefined;
  return row?.status === "approved" || row?.status === "resolved";
}

function fromGateRow(row: GateRow): AgentLoopGate {
  return {
    id: row.id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    kind: row.kind,
    status: row.status,
    message: row.message,
    ...(row.details_json
      ? { details: parseJson(row.details_json, "Stored gate details JSON is invalid.") }
      : {}),
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.decision_note ? { decisionNote: row.decision_note } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {})
  };
}

interface ArtifactRow {
  id: string;
  run_id: string;
  kind: string;
  name: string | null;
  path: string;
  sha256: string | null;
  created_at: string;
}

function fromArtifactRow(row: ArtifactRow): AgentLoopArtifactRecord {
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

interface PrLinkRow {
  id: string;
  run_id: string;
  branch: string;
  pr_number: number;
  url: string;
  head_ref: string;
  base_ref: string;
  state: string;
  draft: number;
  created_at: string;
  updated_at: string;
}

function fromPrLinkRow(row: PrLinkRow): AgentLoopPrLink {
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

interface CiCheckRow {
  id: string;
  run_id: string;
  pr_number: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  started_at: string | null;
  completed_at: string | null;
  observed_at: string;
}

function fromCiCheckRow(row: CiCheckRow): AgentLoopCiCheck {
  return {
    id: row.id,
    runId: row.run_id,
    prNumber: row.pr_number,
    name: row.name,
    status: row.status,
    ...(row.conclusion ? { conclusion: row.conclusion } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    observedAt: row.observed_at
  };
}

interface ReviewCommentRow {
  id: string;
  run_id: string;
  pr_number: number;
  comment_id: string;
  url: string;
  author: string;
  body: string;
  path: string;
  line: number | null;
  diff_hunk: string;
  is_resolved: number;
  is_outdated: number;
  actionable: number;
  status: "open" | "handled" | "out_of_scope" | "stale";
  observed_at: string;
}

function fromReviewCommentRow(row: ReviewCommentRow): AgentLoopReviewComment {
  return {
    id: row.id,
    runId: row.run_id,
    prNumber: row.pr_number,
    commentId: row.comment_id,
    url: row.url,
    author: row.author,
    body: row.body,
    path: row.path,
    ...(row.line === null ? {} : { line: row.line }),
    diffHunk: row.diff_hunk,
    isResolved: row.is_resolved === 1,
    isOutdated: row.is_outdated === 1,
    actionable: row.actionable === 1,
    status: row.status,
    observedAt: row.observed_at
  };
}

interface DecisionRow {
  id: string;
  run_id: string;
  kind: string;
  message: string;
  details_json: string | null;
  created_at: string;
}

function fromDecisionRow(row: DecisionRow): AgentLoopDecision {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    message: row.message,
    ...(row.details_json
      ? { details: parseJson(row.details_json, "Stored decision details JSON is invalid.") }
      : {}),
    createdAt: row.created_at
  };
}

interface RunCheckRow {
  run_id: string;
  kind: AgentLoopRunCheck["kind"];
  status: AgentLoopRunCheck["status"];
  details_json: string | null;
  created_at: string;
}

function fromRunCheckRow(row: RunCheckRow): AgentLoopRunCheck {
  return {
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    ...(row.details_json ? { details: JSON.parse(row.details_json) } : {}),
    createdAt: row.created_at
  };
}

interface WorkerRow {
  id: string;
  run_id: string;
  type: WorkerType;
  backend: string;
  status: WorkerStatus;
  thread_id: string | null;
  attempt: number;
  resume_used: number;
  started_at: string;
  completed_at: string | null;
  exit_code: number | null;
  result_artifact_id: string | null;
  raw_jsonl_artifact_id: string | null;
  error: string | null;
}

function fromWorkerRow(row: WorkerRow): WorkerRun {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    backend: row.backend,
    status: row.status,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    attempt: row.attempt,
    resumeUsed: row.resume_used === 1,
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(row.result_artifact_id ? { resultArtifactId: row.result_artifact_id } : {}),
    ...(row.raw_jsonl_artifact_id ? { rawJsonlArtifactId: row.raw_jsonl_artifact_id } : {}),
    ...(row.error ? { error: row.error } : {})
  };
}

interface WorkerEventRow {
  seq: number;
  id: string;
  worker_id: string;
  run_id: string;
  event_type: string;
  item_type: string | null;
  item_id: string | null;
  item_status: string | null;
  thread_id: string | null;
  backend: WorkerBackend | null;
  summary_json: string | null;
  usage_json: string | null;
  artifact_ids_json: string | null;
  created_at: string;
}

function fromWorkerEventRow(row: WorkerEventRow): WorkerEvent {
  return {
    id: row.id,
    seq: row.seq,
    workerId: row.worker_id,
    runId: row.run_id,
    eventType: row.event_type,
    ...(row.item_type ? { itemType: row.item_type } : {}),
    ...(row.item_id ? { itemId: row.item_id } : {}),
    ...(row.item_status ? { itemStatus: row.item_status } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.backend ? { backend: row.backend } : {}),
    ...(row.summary_json ? { summary: parseJson(row.summary_json, "Stored worker event summary JSON is invalid.") } : {}),
    ...(row.usage_json ? { usage: parseJson(row.usage_json, "Stored worker event usage JSON is invalid.") } : {}),
    ...(row.artifact_ids_json ? { artifactIds: parseJson(row.artifact_ids_json, "Stored worker event artifact list JSON is invalid.") as string[] } : {}),
    createdAt: row.created_at
  };
}

function workerEventTimelineTitle(row: WorkerEventRow): string {
  const item = row.item_type ?? row.event_type;
  return row.item_status ? `${row.item_status} ${item}` : item;
}

function isSupportedSchemaVersion(value: number): boolean {
  return (SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(value);
}

function rebuildEventsWithSeq(db: DatabaseSync): void {
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

function rebuildWorkerEventsWithSeq(db: DatabaseSync): void {
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

function dedupeHighFidelityWorkerEventsV8(db: DatabaseSync): void {
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

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  validateSqlIdentifier(tableName);
  validateSqlIdentifier(columnName);
  const columns = db.prepare(`pragma table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  validateSqlIdentifier(tableName);
  const row = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = ? limit 1")
    .get(tableName);
  return row !== undefined;
}

function boolToDb(value: boolean | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

function addColumnIfMissing(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  definition: string
): void {
  validateSqlIdentifier(tableName);
  validateSqlIdentifier(columnName);
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`alter table ${tableName} add column ${columnName} ${definition}`);
  }
}

function validateSqlIdentifier(value: string): void {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new AgentLoopError("storage_error", `Unsafe SQLite identifier: ${value}`);
  }
}

function now(): string {
  return new Date().toISOString();
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

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint/i.test(error.message);
}

function toStorageError(error: unknown, message: string): AgentLoopError {
  if (error instanceof AgentLoopError) {
    return error;
  }
  return new AgentLoopError("storage_error", message, {
    details: { cause: error instanceof Error ? error.message : String(error) }
  });
}
