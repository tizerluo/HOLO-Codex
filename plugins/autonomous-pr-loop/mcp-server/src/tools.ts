import { createControllerHost } from "../../core/controller-host.js";
import type { AgentTimelineSource, WorkerType } from "../../core/types.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const emptySchema = { type: "object" as const, properties: {} };

export const MCP_TOOLS: McpToolDefinition[] = [
  tool("loop_status", "Return current loop status.", emptySchema),
  tool("loop_next_action", "Return the next recommended loop action.", emptySchema),
  tool("loop_run_until_gate", "Start a background run until the next gate.", tokenSchema()),
  tool("loop_resume", "Resume one loop step.", tokenSchema()),
  tool("loop_stop", "Stop the current run.", tokenSchema()),
  tool("loop_step", "Advance one loop step.", tokenSchema()),
  tool("loop_list_gates", "List gates newest-first.", emptySchema),
  tool("loop_explain_gate", "Explain one gate.", stringIdSchema("gateId")),
  tool("loop_approve_gate", "Approve one gate with an operator note.", noteSchema("gateId")),
  tool("loop_reject_gate", "Reject one gate with an operator note.", noteSchema("gateId")),
  tool("loop_list_runs", "List persisted runs.", {
    type: "object",
    properties: { limit: { type: "number" } }
  }),
  tool("loop_agent_timeline", "List normalized agent timeline entries.", {
    type: "object",
    properties: {
      cursor: { type: "string" },
      limit: { type: "number" },
      sources: {
        type: "array",
        items: { type: "string", enum: ["event", "worker_event", "worker", "state", "gate", "artifact", "decision"] }
      },
      runId: { type: "string" },
      workerId: { type: "string" }
    }
  }),
  tool("loop_read_artifact", "Read a persisted artifact by id.", stringIdSchema("artifactId")),
  tool("loop_get_pr_status", "Return stored PR status for current run.", emptySchema),
  tool("loop_get_ci_status", "Return stored CI checks for current run.", emptySchema),
  tool("loop_get_review_comments", "Return stored review comments for current run.", emptySchema),
  tool("loop_spawn_worker", "Spawn or dry-run a delegated worker.", {
    type: "object",
    required: ["type", "token"],
    properties: {
      type: { type: "string", enum: ["planner", "implementation", "review-fix", "ci-fix", "reviewer"] },
      dryRun: { type: "boolean" },
      token: { type: "string" }
    }
  }),
  tool("loop_open_dashboard", "Return dashboard URL or unavailable status.", emptySchema)
];

/** Dispatch an MCP tool call to the shared controller. */
export async function callMcpTool(name: string, args: Record<string, unknown>, repoRoot: string): Promise<unknown> {
  const host = getControllerHost(repoRoot);
  const controller = host.getController();
  if (name === "loop_status") return controller.loopStatus();
  if (name === "loop_next_action") return controller.loopNextAction();
  if (name === "loop_run_until_gate") return controller.loopRunUntilGate(optionalString(args, "token"));
  if (name === "loop_resume") return await controller.loopResume(optionalString(args, "token"));
  if (name === "loop_stop") return controller.loopStop(optionalString(args, "token"));
  if (name === "loop_step") return await controller.loopStep(optionalString(args, "token"));
  if (name === "loop_list_gates") return controller.loopListGates();
  if (name === "loop_explain_gate") return controller.loopExplainGate(requiredString(args, "gateId"));
  if (name === "loop_approve_gate") return controller.loopApproveGate(requiredString(args, "gateId"), gateDecisionArgs(args), optionalString(args, "token"));
  if (name === "loop_reject_gate") return controller.loopRejectGate(requiredString(args, "gateId"), gateDecisionArgs(args), optionalString(args, "token"));
  if (name === "loop_list_runs") return controller.loopListRuns(optionalNumber(args, "limit"));
  if (name === "loop_agent_timeline") return controller.loopAgentTimeline({
    ...optionalStringObject(args, "cursor"),
    ...optionalNumberObject(args, "limit"),
    ...optionalStringObject(args, "runId"),
    ...optionalStringObject(args, "workerId"),
    ...optionalSourcesObject(args)
  });
  if (name === "loop_read_artifact") return controller.loopReadArtifact(requiredString(args, "artifactId"));
  if (name === "loop_get_pr_status") return controller.loopGetPrStatus();
  if (name === "loop_get_ci_status") return controller.loopGetCiStatus();
  if (name === "loop_get_review_comments") return controller.loopGetReviewComments();
  if (name === "loop_spawn_worker") return await controller.loopSpawnWorker(requiredWorkerType(args), optionalBoolean(args, "dryRun") ?? true, optionalString(args, "token"));
  if (name === "loop_open_dashboard") return controller.loopOpenDashboard();
  throw new Error(`Unknown tool: ${name}`);
}

const hosts = new Map<string, ReturnType<typeof createControllerHost>>();
const MAX_HOSTS = 16;

function getControllerHost(repoRoot: string): ReturnType<typeof createControllerHost> {
  const existing = hosts.get(repoRoot);
  if (existing) {
    hosts.delete(repoRoot);
    hosts.set(repoRoot, existing);
    return existing;
  }
  if (hosts.size >= MAX_HOSTS) {
    const oldestKey = hosts.keys().next().value as string | undefined;
    if (oldestKey) {
      hosts.get(oldestKey)?.dispose();
      hosts.delete(oldestKey);
    }
  }
  const host = createControllerHost({ repoRoot });
  hosts.set(repoRoot, host);
  return host;
}

function tool(name: string, description: string, inputSchema: McpToolDefinition["inputSchema"]): McpToolDefinition {
  return { name, description, inputSchema };
}

function stringIdSchema(name: string): McpToolDefinition["inputSchema"] {
  return {
    type: "object",
    required: [name],
    properties: { [name]: { type: "string" } }
  };
}

function noteSchema(idName: string): McpToolDefinition["inputSchema"] {
  return {
    type: "object",
    required: [idName, "note", "token"],
    properties: {
      [idName]: { type: "string" },
      note: { type: "string" },
      source: { type: "string", enum: ["cli", "api", "ui", "nl"] },
      payload: { type: "object" },
      token: { type: "string" }
    }
  };
}

function tokenSchema(): McpToolDefinition["inputSchema"] {
  return {
    type: "object",
    required: ["token"],
    properties: { token: { type: "string" } }
  };
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" ? value : undefined;
}

function optionalNumberObject(args: Record<string, unknown>, name: string): Record<string, number> {
  const value = optionalNumber(args, name);
  return value === undefined ? {} : { [name]: value };
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  return typeof value === "boolean" ? value : undefined;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function optionalStringObject(args: Record<string, unknown>, name: string): Record<string, string> {
  const value = optionalString(args, name);
  return value === undefined ? {} : { [name]: value };
}

function gateDecisionArgs(args: Record<string, unknown>): { note: string; source?: "cli" | "api" | "ui" | "nl"; payload?: Record<string, unknown> } {
  const source = optionalString(args, "source");
  const payload = args.payload;
  return {
    note: requiredString(args, "note"),
    source: source === "cli" || source === "api" || source === "ui" || source === "nl" ? source : "nl",
    payload: typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  };
}

function optionalSourcesObject(args: Record<string, unknown>): { sources?: AgentTimelineSource[] } {
  const value = args.sources;
  if (!Array.isArray(value)) {
    return {};
  }
  const sources = value.filter((item): item is AgentTimelineSource => typeof item === "string");
  return sources.length ? { sources } : {};
}

function requiredWorkerType(args: Record<string, unknown>): WorkerType {
  const value = requiredString(args, "type");
  if (["planner", "implementation", "review-fix", "ci-fix", "reviewer"].includes(value)) {
    return value as WorkerType;
  }
  throw new Error(`Unsupported worker type: ${value}`);
}
