import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AgentLoopError } from "../core/errors.js";
import { STORAGE_SCHEMA_VERSION, SqliteAgentLoopStorage } from "../core/storage.js";
import { withConfigDefaults } from "../core/config.js";

describe("storage", () => {
  it("initializes the required schema", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);

    expect(existsSync(dbPath)).toBe(true);
    const db = (storage as unknown as { db: DatabaseSync }).db;
    const journalMode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const busyTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    const tables = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    storage.close();

    expect(tables).toEqual(
      expect.arrayContaining([
        "runs",
        "states",
        "events",
        "gates",
        "artifacts",
        "repo_config",
        "pr_links",
        "ci_checks",
        "review_comments",
        "decisions",
        "workers",
        "worker_events",
        "run_checks",
        "timeline_index"
      ])
    );
    expect(STORAGE_SCHEMA_VERSION).toBe(8);
    expect(journalMode.journal_mode.toLowerCase()).toBe("wal");
    expect(busyTimeout.timeout).toBe(5000);
  });

  it("supports read-only opens without migrating or writing", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    storage.close();
    const before = statSync(dbPath).mtimeMs;

    const readonly = new SqliteAgentLoopStorage(dbPath, { mode: "ro" });
    const status = readonly.getCurrentStatus();
    readonly.close();
    const after = statSync(dbPath).mtimeMs;

    expect(status.status).toBe("IDLE");
    expect(after).toBe(before);
  });

  it("writes PR links, CI checks, review comments, and decisions", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    const run = storage.createRun("RUNNING");

    const link = storage.upsertPrLink({
      runId: run.id,
      branch: "codex/next",
      prNumber: 12,
      url: "https://github.test/pr/12",
      headRef: "codex/next",
      baseRef: "main",
      state: "OPEN",
      draft: true
    });
    const checks = storage.replaceCiChecks(run.id, 12, [{
      name: "ci",
      status: "COMPLETED",
      conclusion: "SUCCESS"
    }]);
    const comments = storage.replaceReviewComments(run.id, 12, [{
      commentId: "c1",
      url: "https://github.test/comment",
      author: "reviewer",
      body: "fix",
      path: "src/index.ts",
      line: 4,
      diffHunk: "@@",
      isResolved: false,
      isOutdated: false,
      actionable: true,
      status: "open"
    }]);
    const decision = storage.appendDecision({
      runId: run.id,
      kind: "branch_renamed",
      message: "Created suffix.",
      details: { branch: "codex/next-2" }
    });
    const check = storage.recordRunCheck({
      runId: run.id,
      kind: "self_check",
      status: "passed"
    });
    storage.close();

    expect(link.prNumber).toBe(12);
    expect(checks[0]?.name).toBe("ci");
    expect(comments[0]?.status).toBe("open");
    expect(decision.kind).toBe("branch_renamed");
    expect(check.kind).toBe("self_check");
  });

  it("uses monotonic event seq values and since queries", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    const run = storage.createRun("RUNNING");

    const first = storage.appendEvent({ runId: run.id, kind: "one", message: "first" });
    const second = storage.appendEvent({ runId: run.id, kind: "two", message: "second" });
    const third = storage.appendEvent({ runId: run.id, kind: "three", message: "third" });
    const recent = storage.listEvents(2);
    const since = storage.listEvents({ sinceSeq: first.seq, limit: 10 });
    storage.close();

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect(recent.map((event) => event.kind)).toEqual(["three", "two"]);
    expect(since.map((event) => event.kind)).toEqual(["two", "three"]);
  });

  it("enforces foreign keys and maps active run conflicts", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);

    storage.createRun("RUNNING");
    expect(() => storage.createRun("RUNNING")).toThrow(AgentLoopError);
    expect(() => storage.appendDecision({
      runId: "missing",
      kind: "bad",
      message: "bad"
    })).toThrow();
    storage.close();
  });

  it("writes worker runs and worker events", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    const run = storage.createRun("RUNNING");

    const worker = storage.createWorker({
      runId: run.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });
    expect(() => storage.createWorker({
      runId: run.id,
      type: "reviewer",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    })).toThrow(AgentLoopError);
    storage.appendWorkerEvent({
      workerId: worker.id,
      runId: run.id,
      eventType: "item.completed",
      itemType: "file_change",
      itemId: "item-1",
      itemStatus: "completed",
      threadId: "thread-1",
      backend: "codex-exec",
      summary: { path: "src/index.ts" }
    });
    storage.appendWorkerEvent({
      workerId: worker.id,
      runId: run.id,
      eventType: "item.started",
      itemType: "file_change",
      itemId: "item-1",
      itemStatus: "started",
      threadId: "thread-1",
      backend: "codex-exec",
      summary: { path: "src/index.ts" }
    });
    storage.appendWorkerEvent({
      workerId: worker.id,
      runId: run.id,
      eventType: "turn.completed",
      threadId: "thread-1",
      backend: "codex-exec",
      summary: { usage: 1 }
    });
    storage.appendWorkerEvent({
      workerId: worker.id,
      runId: run.id,
      eventType: "turn.completed",
      threadId: "thread-1",
      backend: "codex-exec",
      summary: { usage: 2 }
    });
    storage.appendWorkerEvent({
      workerId: worker.id,
      runId: run.id,
      eventType: "item.completed",
      itemType: "file_change",
      itemId: "item-1",
      itemStatus: "completed",
      threadId: "thread-1",
      backend: "codex-exec",
      summary: { path: "src/index.ts" }
    });
    const updated = storage.updateWorker(worker.id, {
      status: "succeeded",
      threadId: "thread-1",
      completedAt: "2026-06-12T00:00:00.000Z",
      exitCode: 0
    });
    const events = storage.listWorkerEvents(worker.id);
    storage.close();

    expect(updated.threadId).toBe("thread-1");
    expect(updated.status).toBe("succeeded");
    expect(events).toHaveLength(3);
    expect(events.filter((event) => event.itemId === "item-1").map((event) => event.itemStatus)).toEqual(["completed", "started"]);
    expect(events.filter((event) => event.eventType === "turn.completed")).toHaveLength(1);
    expect(events[0]?.itemType).toBe("file_change");
    expect(events[0]?.threadId).toBe("thread-1");
  });

  it("maintains timeline_index through storage triggers", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    const run = storage.createRun("RUNNING", { currentState: "SELF_CHECK" });
    const event = storage.appendEvent({
      runId: run.id,
      kind: "secret_event",
      message: "token=abc123 should be hidden",
      artifactIds: ["artifact-1"]
    });
    storage.writeGate({ runId: run.id, kind: "policy_violation", message: "blocked" });
    storage.appendDecision({ runId: run.id, kind: "decision", message: "operator decided" });
    storage.insertArtifact({
      id: "artifact-1",
      runId: run.id,
      kind: "log",
      name: "worker.log",
      path: join(dirname(dbPath), "worker.log"),
      sha256: "sha",
      createdAt: "2026-06-12T00:00:00.000Z"
    });
    const worker = storage.createWorker({
      runId: run.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });
    storage.appendWorkerEvent({
      runId: run.id,
      workerId: worker.id,
      eventType: "item.completed",
      itemId: "cmd-redacted",
      itemStatus: "completed",
      threadId: "thread-redacted",
      itemType: "command_execution",
      summary: { command: "echo ok", authorization: "Bearer secret" }
    });
    const bearerEvent = storage.appendEvent({
      runId: run.id,
      kind: "authorization_event",
      message: "authorization: Bearer eyJabc.def ghi"
    });
    const bearerSentenceEvent = storage.appendEvent({
      runId: run.id,
      kind: "bearer_sentence_event",
      message: "Used Bearer abc123 then call the api"
    });
    const jwtEvent = storage.appendEvent({
      runId: run.id,
      kind: "jwt_event",
      message: "token=eyJabc.def.ghi"
    });
    const githubTokenEvent = storage.appendEvent({
      runId: run.id,
      kind: "github_token_event",
      message: "token ghp_abcdefghijklmnopqrstuvwxyz123456"
    });
    const githubFineGrainedTokenEvent = storage.appendEvent({
      runId: run.id,
      kind: "github_fine_grained_token_event",
      message: "github_pat_abcdefghijklmnopqrstuvwxyz123456"
    });
    const openAiTokenEvent = storage.appendEvent({
      runId: run.id,
      kind: "openai_token_event",
      message: "sk-abcdefghijklmnopqrstuvwxyz123456"
    });
    const urlCredentialEvent = storage.appendEvent({
      runId: run.id,
      kind: "url_credential_event",
      message: "https://user:password@example.com/repo.git"
    });
    storage.updateWorker(worker.id, { status: "succeeded", completedAt: "2026-06-12T00:00:00.000Z" });
    storage.insertArtifact({
      id: "artifact-tie-1",
      runId: run.id,
      kind: "log",
      name: "tie-1.log",
      path: join(dirname(dbPath), "tie-1.log"),
      sha256: "sha-1",
      createdAt: "2030-01-01T00:00:00.000Z"
    });
    storage.insertArtifact({
      id: "artifact-tie-2",
      runId: run.id,
      kind: "log",
      name: "tie-2.log",
      path: join(dirname(dbPath), "tie-2.log"),
      sha256: "sha-2",
      createdAt: "2030-01-01T00:00:00.000Z"
    });

    const page = storage.listAgentTimeline({ runId: run.id, limit: 20 });
    const firstPage = storage.listAgentTimeline({ runId: run.id, limit: 2 });
    const secondPage = storage.listAgentTimeline({ runId: run.id, limit: 20, cursor: firstPage.nextCursor! });
    const artifactFirstPage = storage.listAgentTimeline({ runId: run.id, sources: ["artifact"], limit: 1 });
    const artifactSecondPage = storage.listAgentTimeline({
      runId: run.id,
      sources: ["artifact"],
      limit: 1,
      cursor: artifactFirstPage.nextCursor!
    });
    const integrity = storage.checkTimelineIntegrity();
    const runningEntry = page.entries.find((entry) => entry.rawRef.id === `${worker.id}:running`);
    const legacyCursor = Buffer.from(JSON.stringify({ timelineSeq: page.entries[0]?.timelineSeq }), "utf8").toString("base64url");
    const latestOccurredAt = page.entries.reduce((latest, entry) =>
      Date.parse(entry.occurredAt) > Date.parse(latest) ? entry.occurredAt : latest,
    page.entries[0]?.occurredAt ?? "");
    const pagedSeqs = [...firstPage.entries, ...secondPage.entries].map((entry) => entry.timelineSeq);
    const db = (storage as unknown as { db: DatabaseSync }).db;
    db.prepare("delete from timeline_index where source = 'event' and source_id = ?").run(event.id);
    const damagedIntegrity = storage.checkTimelineIntegrity();
    expect(() => storage.listAgentTimeline({ cursor: legacyCursor })).toThrow(AgentLoopError);
    storage.close();

    expect(integrity.ok).toBe(true);
    expect(integrity.missingSourceRows).toEqual([]);
    expect(damagedIntegrity.ok).toBe(false);
    expect(damagedIntegrity.missingSourceRows).toEqual([{ source: "event", missing: 1 }]);
    expect(page.entries.map((entry) => entry.source)).toEqual(expect.arrayContaining([
      "state",
      "event",
      "gate",
      "decision",
      "artifact",
      "worker",
      "worker_event"
    ]));
    expect(page.entries[0]?.occurredAt).toBe(latestOccurredAt);
    expect(artifactFirstPage.entries[0]?.rawRef.id).toBe("artifact-tie-2");
    expect(artifactSecondPage.entries[0]?.rawRef.id).toBe("artifact-tie-1");
    expect(runningEntry?.status).toBe("running");
    expect(runningEntry?.title).toContain("running");
    expect(page.entries.some((entry) => entry.rawRef.table === "workers" && entry.rawRef.id === `${worker.id}:succeeded`)).toBe(true);
    expect(page.entries.find((entry) => entry.rawRef.id === event.id)?.summary).toContain("[redacted]");
    expect(page.entries.find((entry) => entry.rawRef.id === bearerEvent.id)?.summary).toBe("authorization: [redacted]");
    expect(page.entries.find((entry) => entry.rawRef.id === bearerSentenceEvent.id)?.summary).toBe("Used Bearer [redacted] then call the api");
    expect(page.entries.find((entry) => entry.rawRef.id === jwtEvent.id)?.summary).toBe("token=[redacted]");
    expect(page.entries.find((entry) => entry.rawRef.id === githubTokenEvent.id)?.summary).toBe("token [redacted]");
    expect(page.entries.find((entry) => entry.rawRef.id === githubFineGrainedTokenEvent.id)?.summary).toBe("[redacted]");
    expect(page.entries.find((entry) => entry.rawRef.id === openAiTokenEvent.id)?.summary).toBe("[redacted]");
    expect(page.entries.find((entry) => entry.rawRef.id === urlCredentialEvent.id)?.summary).toBe("[redacted]@example.com/repo.git");
    expect(page.entries.find((entry) => entry.source === "worker_event")?.summary).toContain("[redacted]");
    expect(new Set(pagedSeqs).size).toBe(pagedSeqs.length);
    expect(pagedSeqs).toHaveLength(page.entries.length);
  });

  it("reports missing timeline triggers in storage integrity checks", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    const db = (storage as unknown as { db: DatabaseSync }).db;
    db.exec("drop trigger timeline_events_insert");

    const integrity = storage.checkTimelineIntegrity();
    storage.close();

    expect(integrity.ok).toBe(false);
    expect(integrity.missingTriggers).toContain("timeline_events_insert");
  });

  it("writes repo config, event, gate, and current status", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    const config = withConfigDefaults({ repoId: "owner/repo" });
    storage.writeRepoConfig(config);
    const run = storage.createRun("READY");
    const event = storage.appendEvent({
      runId: run.id,
      kind: "test",
      message: "event written",
      payload: { ok: true }
    });
    storage.writeGate({
      runId: run.id,
      kind: "policy_violation",
      message: "blocked for test",
      details: { path: ".env" }
    });
    const gate = storage.listGates()[0];
    const approved = storage.decideGate(gate?.id ?? "", "approved", "reviewed");
    const current = storage.getCurrentStatus();
    storage.close();

    expect(event.kind).toBe("test");
    expect(storageRead(dbPath)).toMatchObject({ repoId: "owner/repo" });
    expect(approved.status).toBe("approved");
    expect(current.status).toBe("READY");
  });

  it("ignores stale open gates from older runs when reporting current status", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    const oldRun = storage.createRun("BLOCKED");
    storage.writeGate({
      runId: oldRun.id,
      kind: "dirty_unowned_worktree",
      message: "Old run gate should not block the current run."
    });
    const latestRun = storage.createRun("READY");
    storage.writeGate({
      runId: latestRun.id,
      kind: "policy_violation",
      message: "Latest run gate has already been approved."
    });
    const latestGate = storage.listGates(latestRun.id)[0];
    storage.decideGate(latestGate?.id ?? "", "approved", "reviewed");
    storage.updateRunStatus(latestRun.id, latestRun.version, "READY");

    const current = storage.getCurrentStatus();
    storage.close();

    expect(current.status).toBe("READY");
    expect(current.run?.id).toBe(latestRun.id);
    expect(current.gate).toBeUndefined();
  });

  it("keeps a blocked run blocked when the latest gate was rejected", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    const run = storage.createRun("BLOCKED");
    storage.writeGate({
      runId: run.id,
      kind: "policy_violation",
      message: "Rejected gate should keep the run blocked."
    });
    const gate = storage.listGates(run.id)[0];
    storage.decideGate(gate?.id ?? "", "rejected", "not safe");

    const current = storage.getCurrentStatus();
    storage.close();

    expect(current.status).toBe("BLOCKED");
    expect(current.gate).toBeUndefined();
  });

  it("returns version conflicts for stale run writes", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    const run = storage.createRun("READY");

    const first = storage.updateRunStatus(run.id, run.version, "IDLE");

    expect(first.version).toBe(1);
    expect(() => storage.updateRunStatus(run.id, run.version, "READY")).toThrow(
      AgentLoopError
    );
    try {
      storage.updateRunStatus(run.id, run.version, "READY");
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("version_conflict");
    }
    storage.close();
  });

  it("returns version conflicts when two storage handles update the same run", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const writerA = new SqliteAgentLoopStorage(dbPath);
    const run = writerA.createRun("READY");
    writerA.close();
    const writerB = new SqliteAgentLoopStorage(dbPath);
    const writerC = new SqliteAgentLoopStorage(dbPath);
    const snapshotB = writerB.getCurrentRun();
    const snapshotC = writerC.getCurrentRun();

    expect(snapshotB?.version).toBe(0);
    expect(snapshotC?.version).toBe(0);
    writerB.updateRunStatus(run.id, snapshotB?.version ?? -1, "RUNNING");
    expect(() => writerC.updateRunStatus(run.id, snapshotC?.version ?? -1, "READY")).toThrow(
      AgentLoopError
    );
    try {
      writerC.updateRunStatus(run.id, snapshotC?.version ?? -1, "READY");
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("version_conflict");
    }
    writerB.close();
    writerC.close();
  });

  it("rejects unsupported schemaVersion", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    storage.close();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 999");
    db.close();

    expect(() => new SqliteAgentLoopStorage(dbPath)).toThrow(AgentLoopError);
    try {
      new SqliteAgentLoopStorage(dbPath);
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("storage_schema_mismatch");
    }
  });

  it("rejects unsupported repo_config schemaVersion when opening storage", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    storage.writeRepoConfig(withConfigDefaults({ repoId: "owner/repo" }));
    storage.close();
    const db = new DatabaseSync(dbPath);
    db.prepare("update repo_config set schema_version = 999 where id = 1").run();
    db.close();

    expect(() => new SqliteAgentLoopStorage(dbPath)).toThrow(AgentLoopError);
    try {
      new SqliteAgentLoopStorage(dbPath);
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("storage_schema_mismatch");
    }
  });

  it("migrates a v1 database missing repo_config without failing", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 1");
    db.close();

    const storage = new SqliteAgentLoopStorage(dbPath);
    const tables = (storage as unknown as { db: DatabaseSync }).db
      .prepare("select name from sqlite_master where type = 'table' and name = 'decisions'")
      .all();
    storage.close();

    expect(tables).toHaveLength(1);
  });

  it("migrates a v2 database to worker tables", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 2");
    db.close();

    const storage = new SqliteAgentLoopStorage(dbPath);
    const sqlite = (storage as unknown as { db: DatabaseSync }).db;
    const tables = sqlite
      .prepare("select name from sqlite_master where type = 'table' and name in ('workers', 'worker_events')")
      .all();
    const version = sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
    storage.close();

    expect(tables).toHaveLength(2);
    expect(version.user_version).toBe(STORAGE_SCHEMA_VERSION);
  });

  it("can open a migrated database from a second handle without duplicate-column migration errors", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 2");
    db.close();

    const first = new SqliteAgentLoopStorage(dbPath);
    const second = new SqliteAgentLoopStorage(dbPath);
    const version = (second as unknown as { db: DatabaseSync }).db
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    first.close();
    second.close();

    expect(version.user_version).toBe(STORAGE_SCHEMA_VERSION);
  });

  it("migrates a v4 database to trusted run checks", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 4");
    db.close();

    const storage = new SqliteAgentLoopStorage(dbPath);
    const tables = (storage as unknown as { db: DatabaseSync }).db
      .prepare("select name from sqlite_master where type = 'table' and name = 'run_checks'")
      .all();
    const version = (storage as unknown as { db: DatabaseSync }).db
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    storage.close();

    expect(tables).toHaveLength(1);
    expect(version.user_version).toBe(STORAGE_SCHEMA_VERSION);
  });

  it("migrates a v7 database to high-fidelity worker event columns", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table runs (
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
      create table workers (
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
        error text
      );
      create table worker_events (
        seq integer primary key autoincrement,
        id text not null unique,
        worker_id text not null,
        run_id text not null,
        event_type text not null,
        item_type text,
        summary_json text,
        usage_json text,
        created_at text not null
      );
      pragma user_version = 7;
    `);
    db.close();

    const storage = new SqliteAgentLoopStorage(dbPath);
    const sqlite = (storage as unknown as { db: DatabaseSync }).db;
    const columns = sqlite.prepare("pragma table_info(worker_events)").all().map((row) => (row as { name: string }).name);
    const indexes = sqlite
      .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'worker_events'")
      .all()
      .map((row) => (row as { name: string }).name);
    const version = sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
    storage.close();

    expect(columns).toEqual(expect.arrayContaining(["thread_id", "item_id", "backend", "artifact_ids_json"]));
    expect(indexes).toEqual(expect.arrayContaining([
      "worker_events_thread_item_status_unique",
      "worker_events_thread_event_unique"
    ]));
    expect(version.user_version).toBe(STORAGE_SCHEMA_VERSION);
  });

  it("reconciles old v8 worker event indexes and duplicate non-item rows", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const setup = new SqliteAgentLoopStorage(dbPath);
    const run = setup.createRun("RUNNING");
    const worker = setup.createWorker({
      runId: run.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });
    setup.close();

    const db = new DatabaseSync(dbPath);
    db.exec(`
      drop index if exists worker_events_thread_item_status_unique;
      drop index if exists worker_events_thread_event_unique;
      create unique index if not exists worker_events_thread_item_unique
        on worker_events(thread_id, item_id)
        where item_id is not null;
    `);
    const insert = db.prepare(`
      insert into worker_events (
        id, worker_id, run_id, event_type, thread_id, backend, summary_json, created_at
      ) values (?, ?, ?, 'turn.completed', 'thread-old-v8', 'codex-exec', ?, ?)
    `);
    insert.run("turn-old-1", worker.id, run.id, JSON.stringify({ usage: 1 }), "2026-06-12T00:00:00.000Z");
    insert.run("turn-old-2", worker.id, run.id, JSON.stringify({ usage: 2 }), "2026-06-12T00:00:01.000Z");
    db.close();

    const storage = new SqliteAgentLoopStorage(dbPath);
    storage.appendWorkerEvent({
      workerId: worker.id,
      runId: run.id,
      eventType: "item.started",
      itemType: "command_execution",
      itemId: "cmd-old-v8",
      itemStatus: "started",
      threadId: "thread-old-v8"
    });
    storage.appendWorkerEvent({
      workerId: worker.id,
      runId: run.id,
      eventType: "item.completed",
      itemType: "command_execution",
      itemId: "cmd-old-v8",
      itemStatus: "completed",
      threadId: "thread-old-v8"
    });
    const events = storage.listWorkerEvents(worker.id);
    const sqlite = (storage as unknown as { db: DatabaseSync }).db;
    const integrity = storage.checkTimelineIntegrity();
    const orphanTimelineRows = sqlite
      .prepare(`
        select count(*) as count
        from timeline_index
        left join worker_events on worker_events.id = timeline_index.source_id
        where timeline_index.source = 'worker_event'
          and worker_events.id is null
      `)
      .get() as { count: number };
    const indexes = sqlite
      .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'worker_events'")
      .all()
      .map((row) => (row as { name: string }).name);
    storage.close();

    expect(indexes).not.toContain("worker_events_thread_item_unique");
    expect(indexes).toEqual(expect.arrayContaining([
      "worker_events_thread_item_status_unique",
      "worker_events_thread_event_unique"
    ]));
    expect(events.filter((event) => event.eventType === "turn.completed")).toHaveLength(1);
    expect(events.filter((event) => event.itemId === "cmd-old-v8").map((event) => event.itemStatus)).toEqual(["started", "completed"]);
    expect(integrity.ok).toBe(true);
    expect(orphanTimelineRows.count).toBe(0);
  });

  it("wraps invalid stored repo config JSON as structured storage errors", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agent-loop-storage-")), "state.sqlite");
    const storage = new SqliteAgentLoopStorage(dbPath);
    storage.close();
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `insert into repo_config (id, schema_version, config_json, updated_at)
       values (1, 1, '{not-json', '2026-06-12T00:00:00.000Z')`
    ).run();
    db.close();

    let caught: AgentLoopError | undefined;
    try {
      new SqliteAgentLoopStorage(dbPath);
    } catch (error) {
      caught = error as AgentLoopError;
    }
    expect(caught).toBeInstanceOf(AgentLoopError);
    expect(caught?.code).toBe("storage_error");
  });
});

function storageRead(dbPath: string): unknown {
  const storage = new SqliteAgentLoopStorage(dbPath);
  const config = storage.readRepoConfig();
  storage.close();
  return config;
}
