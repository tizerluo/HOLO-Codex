import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentLoopError } from "./errors.js";
import { ARTIFACT_KINDS, type ArtifactKind, type ArtifactRecord } from "./state-types.js";
import type { AgentLoopStorage } from "./types.js";

export interface ArtifactWriter {
  id: string;
  path: string;
  append(content: string | Buffer): void;
  finalize(): ArtifactRecord;
}

/** Write a run artifact to disk, persist metadata, and return its record. */
export function writeArtifact(
  repoRoot: string,
  storage: AgentLoopStorage,
  runId: string,
  kind: ArtifactKind,
  name: string,
  content: string | Buffer
): ArtifactRecord {
  assertArtifactKind(kind);
  const id = randomUUID();
  const safeName = sanitizeName(name);
  const path = join(repoRoot, ".agent-loop", "artifacts", runId, kind, safeName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const record = {
    id,
    runId,
    kind,
    name: safeName,
    path,
    sha256: sha256(readFileSync(path)),
    createdAt: new Date().toISOString()
  };
  storage.insertArtifact(record);
  return record;
}

/** Create an artifact file that can be appended while work is still running. */
export function createArtifactWriter(
  repoRoot: string,
  storage: AgentLoopStorage,
  runId: string,
  kind: ArtifactKind,
  name: string
): ArtifactWriter {
  assertArtifactKind(kind);
  const id = randomUUID();
  const safeName = sanitizeName(name);
  const path = join(repoRoot, ".agent-loop", "artifacts", runId, kind, safeName);
  const hash = createHash("sha256");
  let finalized: ArtifactRecord | undefined;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return {
    id,
    path,
    append(content: string | Buffer): void {
      if (finalized) {
        throw new AgentLoopError("artifact_integrity_error", `Artifact writer is already finalized: ${id}`);
      }
      appendFileSync(path, content);
      hash.update(content);
    },
    finalize(): ArtifactRecord {
      if (finalized) {
        return finalized;
      }
      finalized = {
        id,
        runId,
        kind,
        name: safeName,
        path,
        sha256: hash.digest("hex"),
        createdAt: new Date().toISOString()
      };
      storage.insertArtifact(finalized);
      return finalized;
    }
  };
}

/** Read an artifact and verify the stored sha256 digest before returning content. */
export function readArtifact(
  storage: AgentLoopStorage,
  artifactId: string
): { record: ArtifactRecord; content: Buffer } {
  const record = readArtifactRecord(storage, artifactId);
  if (!existsSync(record.path)) {
    throw new AgentLoopError("artifact_integrity_error", `Artifact file is missing: ${record.id}`);
  }
  const content = readFileSync(record.path);
  const actual = sha256(content);
  if (actual !== record.sha256) {
    throw new AgentLoopError("artifact_integrity_error", `Artifact sha256 mismatch: ${record.id}`, {
      details: { expected: record.sha256, actual }
    });
  }
  return { record: toArtifactRecord(record), content };
}

/** List artifacts for a run. */
export function listArtifacts(
  storage: AgentLoopStorage,
  runId: string
): ArtifactRecord[] {
  return storage.listArtifacts(runId).map(toArtifactRecord);
}

/** Link a persisted artifact id to an event. */
export function linkArtifactToEvent(
  storage: AgentLoopStorage,
  eventId: string,
  artifactId: string
): void {
  storage.linkArtifactToEvent(eventId, artifactId);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function sanitizeName(name: string): string {
  return name.replaceAll("\\", "/").split("/").filter(Boolean).join("-");
}

function assertArtifactKind(kind: string): asserts kind is ArtifactKind {
  if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    throw new AgentLoopError("storage_error", `Unsupported artifact kind: ${kind}`);
  }
}

function readArtifactRecord(storage: AgentLoopStorage, artifactId: string): ReturnType<AgentLoopStorage["getArtifact"]> {
  try {
    return storage.getArtifact(artifactId);
  } catch (error) {
    if (error instanceof AgentLoopError) {
      throw new AgentLoopError("artifact_integrity_error", `Artifact metadata is unavailable: ${artifactId}`, {
        details: { cause: error.message, code: error.code }
      });
    }
    throw error;
  }
}

function toArtifactRecord(record: {
  id: string;
  runId: string;
  kind: string;
  name: string;
  path: string;
  sha256: string;
  createdAt: string;
}): ArtifactRecord {
  return {
    ...record,
    kind: record.kind as ArtifactKind
  };
}
