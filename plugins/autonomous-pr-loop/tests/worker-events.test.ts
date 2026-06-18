import { afterEach, describe, expect, it } from "vitest";
import { statePath } from "../core/config.js";
import { createWorkerJsonlStreamIngestor, ingestWorkerJsonl } from "../core/worker-events.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("worker event ingest", () => {
  afterEach(() => cleanupTempRepos());

  it("extracts thread id, command/file events, usage, and preserves raw JSONL", () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");
    const worker = storage.createWorker({
      runId: run.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });

    const result = ingestWorkerJsonl({
      repoRoot,
      storage,
      runId: run.id,
      workerId: worker.id,
      jsonl: [
        JSON.stringify({ type: "thread.started", thread: { id: "thread-1" } }),
        JSON.stringify({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "pnpm test" } }),
        JSON.stringify({ type: "item.completed", item: { id: "file-1", type: "file_change", path: "src/index.ts" } }),
        JSON.stringify({ type: "turn.completed", usage: { total_tokens: 12 } }),
        JSON.stringify({ type: "turn.completed", usage: { total_tokens: 13 } }),
        JSON.stringify({ type: "future.event", ok: true })
      ].join("\n")
    });
    const events = storage.listWorkerEvents(worker.id);
    const artifacts = storage.listArtifacts(run.id);
    storage.close();

    expect(result.threadId).toBe("thread-1");
    expect(result.unknownEventCount).toBe(1);
    expect(events.map((event) => event.itemType).filter(Boolean)).toEqual(["command_execution", "file_change"]);
    expect(events.find((event) => event.itemId === "cmd-1")?.backend).toBe("codex-exec");
    expect(events.filter((event) => event.eventType === "turn.completed")).toHaveLength(1);
    expect(events.some((event) => event.usage !== undefined)).toBe(true);
    expect(artifacts.some((artifact) => artifact.kind === "worker-jsonl")).toBe(true);
  });

  it("streams known item types, handles partial lines, and dedupes resumed items", () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");
    const worker = storage.createWorker({
      runId: run.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });
    const ingestor = createWorkerJsonlStreamIngestor({
      repoRoot,
      storage,
      runId: run.id,
      workerId: worker.id,
      backend: "codex-exec"
    });

    const lines = [
      JSON.stringify({ type: "thread.started", thread: { id: "thread-stream" } }),
      JSON.stringify({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "pnpm test", status: "started" } }),
      JSON.stringify({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "pnpm test", status: "completed", stdout: "token=secret" } }),
      JSON.stringify({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "pnpm test", status: "completed", stdout: "token=secret" } }),
      JSON.stringify({ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "hello" } }),
      JSON.stringify({ type: "item.completed", item: { id: "mcp-1", type: "mcp_tool_call", tool: "read" } }),
      JSON.stringify({ type: "item.completed", item: { id: "web-1", type: "web_search", query: "docs" } }),
      JSON.stringify({ type: "item.completed", item: { id: "todo-1", type: "todo_list", todos: [{ text: "one" }] } }),
      JSON.stringify({ type: "item.failed", item: { id: "err-1", type: "error", message: "failed" } }),
      "{bad-json}"
    ];
    ingestor.ingestChunk(`${lines.slice(0, 3).join("\n")}\n${lines[3]?.slice(0, 20)}`);
    expect(storage.listWorkerEvents(worker.id).some((event) => event.itemType === "command_execution")).toBe(true);
    ingestor.ingestChunk(`${lines[3]?.slice(20)}\n${lines.slice(4).join("\n")}\npartial`);
    const result = ingestor.finalize();
    const events = storage.listWorkerEvents(worker.id);
    storage.close();

    expect(result.threadId).toBe("thread-stream");
    expect(result.unknownEventCount).toBe(1);
    expect(events.filter((event) => event.itemId === "cmd-1")).toHaveLength(2);
    expect(events.filter((event) => event.itemId === "cmd-1").map((event) => event.itemStatus)).toEqual(["started", "completed"]);
    expect(events.map((event) => event.itemType).filter(Boolean)).toEqual([
      "command_execution",
      "command_execution",
      "agent_message",
      "mcp_tool_call",
      "web_search",
      "todo_list",
      "error"
    ]);
    expect(events.some((event) => event.eventType === "worker_jsonl_partial_line")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("stores oversized redacted summaries as artifacts", () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");
    const worker = storage.createWorker({
      runId: run.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });

    ingestWorkerJsonl({
      repoRoot,
      storage,
      runId: run.id,
      workerId: worker.id,
      jsonl: [
        JSON.stringify({ type: "thread.started", thread: { id: "thread-large" } }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "todo-large",
            type: "todo_list",
            todos: [{ text: "x".repeat(10_000) }]
          }
        })
      ].join("\n")
    });
    const event = storage.listWorkerEvents(worker.id).find((candidate) => candidate.itemId === "todo-large");
    const artifacts = storage.listArtifacts(run.id);
    storage.close();

    expect(event?.artifactIds).toHaveLength(1);
    expect(event?.summary).toMatchObject({ truncated: true, artifactId: event?.artifactIds?.[0] });
    expect(artifacts.some((artifact) => artifact.id === event?.artifactIds?.[0] && artifact.kind === "log")).toBe(true);
  });

  it("stores file change payloads as opaque summaries", () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");
    const worker = storage.createWorker({
      runId: run.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });

    ingestWorkerJsonl({
      repoRoot,
      storage,
      runId: run.id,
      workerId: worker.id,
      jsonl: JSON.stringify({
        type: "item.completed",
        thread_id: "thread-file",
        item: {
          id: "file-secret",
          type: "file_change",
          path: "src/index.ts",
          operation: "update",
          changes: "added token=super-secret"
        }
      })
    });
    const event = storage.listWorkerEvents(worker.id).find((candidate) => candidate.itemId === "file-secret");
    storage.close();

    expect(JSON.stringify(event?.summary)).not.toContain("super-secret");
    expect(event?.summary).toMatchObject({
      changes: {
        type: "string"
      }
    });
  });
});
