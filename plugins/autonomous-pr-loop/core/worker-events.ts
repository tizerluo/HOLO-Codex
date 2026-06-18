import { createHash } from "node:crypto";
import { createArtifactWriter, writeArtifact, type ArtifactWriter } from "./artifacts.js";
import { isSecretKey, redactSecrets } from "./redaction.js";
import type { AgentLoopStorage, WorkerBackend, WorkerEvent } from "./types.js";

const KNOWN_ITEM_TYPES = [
  "agent_message",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "error"
] as const;
const SUMMARY_LIMIT_BYTES = 8 * 1024;

export interface WorkerEventIngestResult {
  threadId?: string;
  unknownEventCount: number;
  usage?: unknown;
  rawJsonlArtifactId: string;
}

export interface WorkerJsonlStreamIngestor {
  ingestChunk(chunk: string): void;
  finalize(): WorkerEventIngestResult;
  readonly threadId: string | undefined;
  readonly unknownEventCount: number;
  readonly rawJsonl: string;
}

/** Create a line-oriented Codex JSONL ingestor that appends worker events as lines arrive. */
export function createWorkerJsonlStreamIngestor(input: {
  repoRoot: string;
  storage: AgentLoopStorage;
  runId: string;
  workerId: string;
  backend: WorkerBackend;
}): WorkerJsonlStreamIngestor {
  return new StreamingWorkerEventIngestor(input);
}

/** Ingest Codex JSONL events into storage summaries and a raw JSONL artifact. */
export function ingestWorkerJsonl(input: {
  repoRoot: string;
  storage: AgentLoopStorage;
  runId: string;
  workerId: string;
  jsonl: string;
  backend?: WorkerBackend;
}): WorkerEventIngestResult {
  const ingestor = createWorkerJsonlStreamIngestor({
    repoRoot: input.repoRoot,
    storage: input.storage,
    runId: input.runId,
    workerId: input.workerId,
    backend: input.backend ?? "codex-exec"
  });
  ingestor.ingestChunk(input.jsonl);
  return ingestor.finalize();
}

class StreamingWorkerEventIngestor implements WorkerJsonlStreamIngestor {
  private buffer = "";
  private readonly rawWriter: ArtifactWriter;
  private currentThreadId: string | undefined;
  private currentUsage: unknown;
  private unknownCount = 0;
  private finalized = false;

  constructor(private readonly input: {
    repoRoot: string;
    storage: AgentLoopStorage;
    runId: string;
    workerId: string;
    backend: WorkerBackend;
  }) {
    this.rawWriter = createArtifactWriter(
      input.repoRoot,
      input.storage,
      input.runId,
      "worker-jsonl",
      `${input.workerId}.jsonl`
    );
  }

  get threadId(): string | undefined {
    return this.currentThreadId;
  }

  get unknownEventCount(): number {
    return this.unknownCount;
  }

  get rawJsonl(): string {
    return "";
  }

  ingestChunk(chunk: string): void {
    if (this.finalized || chunk.length === 0) {
      return;
    }
    this.rawWriter.append(chunk);
    this.buffer += chunk;
    let newline = this.buffer.search(/\r?\n/);
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      const delimiterLength = this.buffer[newline] === "\r" && this.buffer[newline + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(newline + delimiterLength);
      this.ingestLine(line);
      newline = this.buffer.search(/\r?\n/);
    }
  }

  finalize(): WorkerEventIngestResult {
    if (!this.finalized) {
      if (this.buffer.trim().length > 0) {
        if (parseLine(this.buffer)) {
          this.ingestLine(this.buffer);
        } else {
          this.appendEvent("worker_jsonl_partial_line", undefined, {
            truncated: true,
            length: this.buffer.length,
            sha256: sha256(this.buffer)
          });
        }
        this.buffer = "";
      }
      this.finalized = true;
    }
    const raw = this.rawWriter.finalize();
    return {
      ...(this.currentThreadId ? { threadId: this.currentThreadId } : {}),
      unknownEventCount: this.unknownCount,
      ...(this.currentUsage ? { usage: this.currentUsage } : {}),
      rawJsonlArtifactId: raw.id
    };
  }

  private ingestLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }
    const parsed = parseLine(line);
    if (!parsed) {
      this.unknownCount += 1;
      return;
    }
    const type = eventType(parsed);
    const threadId = extractThreadId(parsed) ?? this.currentThreadId;
    this.currentThreadId = threadId;
    const usage = extractUsage(parsed);
    this.currentUsage = usage ?? this.currentUsage;
    if (type === "thread.started") {
      this.appendEvent(type, undefined, { threadId }, { ...(threadId ? { threadId } : {}) });
      return;
    }
    if (type === "turn.started" || type === "turn.completed" || type === "turn.failed") {
      this.appendEvent(type, undefined, summarizeTurn(parsed), {
        ...(threadId ? { threadId } : {}),
        ...(usage ? { usage } : {})
      });
      return;
    }
    if (type === "item.started" || type === "item.updated" || type === "item.completed" || type === "item.failed") {
      const itemType = extractItemType(parsed);
      if (!isKnownItemType(itemType)) {
        this.unknownCount += 1;
        return;
      }
      this.appendEvent(type, itemType, summarizeItem(parsed, itemType), {
        ...(threadId ? { threadId } : {}),
        ...optionalString("itemId", extractItemId(parsed)),
        ...optionalString("itemStatus", extractItemStatus(parsed, type)),
        ...(usage ? { usage } : {})
      });
      return;
    }
    this.unknownCount += 1;
  }

  private appendEvent(
    eventTypeValue: string,
    itemType: string | undefined,
    summary: unknown,
    options: {
      threadId?: string;
      itemId?: string;
      itemStatus?: string;
      usage?: unknown;
    } = {}
  ): WorkerEvent {
    const normalized = normalizeSummary(summary, {
      repoRoot: this.input.repoRoot,
      storage: this.input.storage,
      runId: this.input.runId,
      workerId: this.input.workerId,
      eventType: eventTypeValue,
      ...(options.itemId ? { itemId: options.itemId } : {})
    });
    return this.input.storage.appendWorkerEvent({
      workerId: this.input.workerId,
      runId: this.input.runId,
      eventType: eventTypeValue,
      ...(itemType ? { itemType } : {}),
      ...(options.itemId ? { itemId: options.itemId } : {}),
      ...(options.itemStatus ? { itemStatus: options.itemStatus } : {}),
      ...(options.threadId ? { threadId: options.threadId } : this.currentThreadId ? { threadId: this.currentThreadId } : {}),
      backend: this.input.backend,
      summary: normalized.summary,
      ...(options.usage ? { usage: options.usage } : {}),
      ...(normalized.artifactIds.length ? { artifactIds: normalized.artifactIds } : {})
    });
  }
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function eventType(value: Record<string, unknown>): string {
  return stringValue(value.type) ?? stringValue(value.event) ?? stringValue(value.eventType) ?? "unknown";
}

function extractThreadId(value: Record<string, unknown>): string | undefined {
  return stringValue(value.thread_id) ??
    stringValue(value.threadId) ??
    stringValue(value.id) ??
    stringValue(recordValue(value.thread)?.id) ??
    stringValue(recordValue(value.session)?.id);
}

function extractItemType(value: Record<string, unknown>): string | undefined {
  const item = recordValue(value.item);
  return stringValue(value.item_type) ?? stringValue(value.itemType) ?? stringValue(item?.type);
}

function extractItemId(value: Record<string, unknown>): string | undefined {
  const item = recordValue(value.item);
  return stringValue(value.item_id) ?? stringValue(value.itemId) ?? stringValue(item?.id);
}

function extractItemStatus(value: Record<string, unknown>, eventTypeValue: string): string | undefined {
  const item = recordValue(value.item);
  return stringValue(value.item_status) ??
    stringValue(value.itemStatus) ??
    stringValue(item?.status) ??
    eventTypeValue.split(".").at(-1);
}

function extractUsage(value: Record<string, unknown>): unknown {
  return value.usage ?? recordValue(value.turn)?.usage;
}

function summarizeTurn(value: Record<string, unknown>): unknown {
  return redactSummary({
    type: eventType(value),
    threadId: extractThreadId(value),
    usage: extractUsage(value),
    error: stringValue(value.error) ?? stringValue(recordValue(value.turn)?.error)
  });
}

function summarizeItem(value: Record<string, unknown>, itemType: string): unknown {
  const item = recordValue(value.item) ?? value;
  const base = {
    id: extractItemId(value),
    type: itemType,
    status: extractItemStatus(value, eventType(value))
  };
  if (itemType === "agent_message") {
    const text = stringValue(item.text) ?? stringValue(item.message) ?? stringValue(item.content);
    return redactSummary({ ...base, message: text ? summarizeText(text) : undefined });
  }
  if (itemType === "command_execution") {
    return redactSummary({
      ...base,
      command: item.command,
      exitCode: item.exit_code ?? item.exitCode,
      stdout: summarizeMaybeText(item.stdout),
      stderr: summarizeMaybeText(item.stderr),
      startedAt: stringValue(item.started_at) ?? stringValue(item.startedAt),
      completedAt: stringValue(item.completed_at) ?? stringValue(item.completedAt)
    });
  }
  if (itemType === "file_change") {
    return redactSummary({ ...base, path: item.path, operation: item.operation, changes: summarizeOpaquePayload(item.changes) });
  }
  if (itemType === "mcp_tool_call") {
    return redactSummary({ ...base, server: item.server, tool: item.tool ?? item.name, result: summarizeMaybeText(item.result) });
  }
  if (itemType === "web_search") {
    return redactSummary({ ...base, query: item.query, url: item.url, resultCount: item.result_count ?? item.resultCount });
  }
  if (itemType === "todo_list") {
    const todos = Array.isArray(item.todos) ? item.todos : Array.isArray(item.items) ? item.items : undefined;
    return redactSummary({ ...base, count: todos?.length, todos: todos?.slice(0, 20) });
  }
  return redactSummary({ ...base, message: item.message, error: item.error });
}

function summarizeMaybeText(value: unknown): unknown {
  return typeof value === "string" ? summarizeText(value) : value;
}

function summarizeOpaquePayload(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  const redacted = redactSummary(value);
  const json = JSON.stringify(redacted);
  return {
    length: json.length,
    sha256: sha256(json),
    type: Array.isArray(value) ? "array" : typeof value
  };
}

function summarizeText(text: string): Record<string, unknown> {
  return {
    length: text.length,
    sha256: sha256(text),
    preview: redactSecrets(text.slice(0, 240)),
    truncated: text.length > 240
  };
}

function normalizeSummary(
  summary: unknown,
  artifactContext: {
    repoRoot: string;
    storage: AgentLoopStorage;
    runId: string;
    workerId: string;
    eventType: string;
    itemId?: string;
  }
): { summary: unknown; artifactIds: string[] } {
  const redacted = redactSummary(summary);
  const json = JSON.stringify(redacted);
  if (Buffer.byteLength(json, "utf8") <= SUMMARY_LIMIT_BYTES) {
    return { summary: redacted, artifactIds: [] };
  }
  const hash = sha256(json);
  const artifact = writeArtifact(
    artifactContext.repoRoot,
    artifactContext.storage,
    artifactContext.runId,
    "log",
    `${artifactContext.workerId}-${safeName(artifactContext.eventType)}-${safeName(artifactContext.itemId ?? hash.slice(0, 12))}.summary.json`,
    json
  );
  return {
    summary: {
      truncated: true,
      length: json.length,
      sha256: hash,
      artifactId: artifact.id
    },
    artifactIds: [artifact.id]
  };
}

function redactSummary(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactSummary);
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    redacted[key] = isSecretKey(key) ? "[redacted]" : redactSummary(nested);
  }
  return redacted;
}

function isKnownItemType(value: string | undefined): value is typeof KNOWN_ITEM_TYPES[number] {
  return value !== undefined && (KNOWN_ITEM_TYPES as readonly string[]).includes(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value ? { [key]: value } as { [P in K]?: string } : {};
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "event";
}
