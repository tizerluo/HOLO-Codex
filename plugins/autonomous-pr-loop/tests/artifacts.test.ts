import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactWriter, linkArtifactToEvent, listArtifacts, readArtifact, writeArtifact } from "../core/artifacts.js";
import { AgentLoopError } from "../core/errors.js";
import { statePath } from "../core/config.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("artifacts", () => {
  afterEach(() => cleanupTempRepos());

  it("writes, reads, lists, links, and verifies artifacts", () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });
    const event = storage.appendEvent({ runId: run.id, kind: "test", message: "event" });

    const artifact = writeArtifact(repoRoot, storage, run.id, "log", "hello.txt", "hello");
    linkArtifactToEvent(storage, event.id, artifact.id);
    const listed = listArtifacts(storage, run.id);
    const read = readArtifact(storage, artifact.id);
    const events = storage.listEvents();
    storage.close();

    expect(listed).toHaveLength(1);
    expect(read.content.toString("utf8")).toBe("hello");
    expect(events[0]?.artifactIds).toEqual([artifact.id]);
  });

  it("raises artifact_integrity_error for sha256 mismatch", () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });
    const artifact = writeArtifact(repoRoot, storage, run.id, "log", "hello.txt", "hello");
    mkdirSync(join(repoRoot, ".agent-loop", "artifacts", run.id, "log"), { recursive: true });
    writeFileSync(artifact.path, "changed");

    expect(() => readArtifact(storage, artifact.id)).toThrow(AgentLoopError);
    try {
      readArtifact(storage, artifact.id);
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("artifact_integrity_error");
    }
    storage.close();
  });

  it("appends artifact content before finalizing metadata", () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });
    const writer = createArtifactWriter(repoRoot, storage, run.id, "worker-jsonl", "worker.jsonl");

    writer.append("line-1\n");
    writer.append(Buffer.from("line-2\n"));
    expect(readFileSync(writer.path, "utf8")).toBe("line-1\nline-2\n");
    expect(storage.listArtifacts(run.id)).toEqual([]);

    const artifact = writer.finalize();
    const read = readArtifact(storage, artifact.id);
    storage.close();

    expect(read.content.toString("utf8")).toBe("line-1\nline-2\n");
  });

  it("raises artifact_integrity_error when metadata is missing", () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));

    expect(() => readArtifact(storage, "missing-artifact")).toThrow(AgentLoopError);
    try {
      readArtifact(storage, "missing-artifact");
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("artifact_integrity_error");
    }
    storage.close();
  });

  it("rejects unsupported artifact kinds at runtime", () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SYNC_MAIN" });

    expect(() =>
      writeArtifact(repoRoot, storage, run.id, "bad/../../kind" as never, "x.txt", "x")
    ).toThrow(AgentLoopError);
    try {
      writeArtifact(repoRoot, storage, run.id, "bad/../../kind" as never, "x.txt", "x");
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("storage_error");
    }
    storage.close();
  });
});
