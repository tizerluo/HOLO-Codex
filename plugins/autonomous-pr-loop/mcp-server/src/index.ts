#!/usr/bin/env tsx
import readline from "node:readline";
import { resolveRepoRoot } from "../../core/repo-root.js";
import { callMcpTool, MCP_TOOLS } from "./tools.js";

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;

rl.on("line", (line) => {
  void handleLine(line);
});

async function handleLine(line: string): Promise<void> {
  if (line.trim().length === 0) {
    return;
  }
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    respond(null, undefined, errorPayload(-32700, "Parse error"));
    return;
  }

  try {
    if (request.method === "initialize") {
      initialized = true;
      respond(request.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "autonomous-pr-loop", version: "0.1.3" }
      });
      return;
    }
    if (request.method === "ping") {
      respond(request.id, {});
      return;
    }
    if (!initialized) {
      respond(request.id, undefined, errorPayload(-32002, "MCP server is not initialized."));
      return;
    }
    if (request.method === "tools/list") {
      respond(request.id, { tools: MCP_TOOLS });
      return;
    }
    if (request.method === "tools/call") {
      const params = isRecord(request.params) ? request.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = isRecord(params.arguments) ? params.arguments : {};
      const result = await callMcpTool(name, args, resolveMcpRepoRoot());
      respond(request.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      });
      return;
    }
    if (request.id !== undefined) {
      respond(request.id, undefined, errorPayload(-32601, `Method not found: ${request.method ?? ""}`));
    }
  } catch (error) {
    respond(request.id, undefined, errorPayload(-32000, error instanceof Error ? error.message : String(error)));
  }
}

function respond(id: JsonRpcRequest["id"], result?: unknown, error?: unknown): void {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    ...(error ? { error } : { result })
  })}\n`);
}

function errorPayload(code: number, message: string): { code: number; message: string } {
  return { code, message };
}

function resolveMcpRepoRoot(): string {
  return resolveRepoRoot(process.env.AGENT_LOOP_REPO_ROOT ?? process.cwd());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
