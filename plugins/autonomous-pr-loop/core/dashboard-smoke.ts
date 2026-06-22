import { startDashboardServer } from "./dashboard-server.js";

export type DashboardSmokeStatus = "passed" | "failed" | "warning" | "incomplete";

export interface DashboardSmokeCheck {
  id: string;
  label: string;
  status: DashboardSmokeStatus;
  evidence: string;
}

export interface DashboardSmokeReport {
  ok: boolean;
  status: "pass" | "fail" | "warn";
  exitCodeContract: string;
  targetRepoRoot: string;
  dashboard: {
    url: string;
    host: string;
    port: number;
    loopbackOnly: true;
  };
  checks: DashboardSmokeCheck[];
}

interface WorkflowBoardLike {
  activeStageId?: string;
  selectedStageId?: string;
  stages?: Array<{ id?: string; substages?: Array<{ id?: string; status?: string }> }>;
  cleanupChecks?: Array<{ id?: string; status?: string }>;
}

const BAD_RENDER_TOKENS = ["undefined", "NaN", "[object Object]"];
const BAD_STRUCTURED_PAYLOAD_TOKENS = ["NaN", "[object Object]"];
const DEFAULT_SMOKE_TIMEOUT_MS = 10_000;
const API_ENDPOINTS = [
  { id: "dashboard_meta", label: "Dashboard meta API", path: "/api/dashboard-meta" },
  { id: "mission_control", label: "Mission Control API", path: "/api/mission-control" },
  { id: "workflow_board", label: "Workflow board API", path: "/api/workflow-board" },
  { id: "notifications", label: "Notifications API", path: "/api/notifications" },
  { id: "dry_run_preview", label: "Dry-run preview API", path: "/api/dry-run-preview" }
] as const;

/** Run a local dashboard release-readiness smoke check without leaking the dashboard token. */
export async function runDashboardSmoke(repoRoot: string, options: { host?: string; port?: number; timeoutMs?: number } = {}): Promise<DashboardSmokeReport> {
  const server = await startDashboardServer({
    repoRoot,
    targetRepoRoot: repoRoot,
    ...(options.host ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {})
  });
  const checks: DashboardSmokeCheck[] = [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  const deadline = createSmokeDeadline(timeoutMs);
  const startedAt = Date.now();
  try {
    try {
      const html = await getText(server.url, deadline.signal);
      checks.push(checkHttpHtml(html));
      checks.push(checkBadTokens("dashboard_index_tokens", "Dashboard index render tokens", html));
    } catch (error) {
      checks.push({
        id: "dashboard_index",
        label: "Dashboard index",
        status: "failed",
        evidence: smokeFetchError(error, "GET / failed.")
      });
    }

    const apiResults = await Promise.all(API_ENDPOINTS.map((endpoint) => getJsonCheck(server.url, endpoint.path, endpoint.id, endpoint.label, deadline.signal)));
    checks.push(...apiResults.map((item) => item.check));
    checks.push(checkBadTokens(
      "api_payloads",
      "API payload render tokens",
      JSON.stringify(apiResults.map((item) => item.payload).filter((payload) => payload !== undefined)),
      BAD_STRUCTURED_PAYLOAD_TOKENS,
      "warning"
    ));
    const workflow = apiResults.find((item) => item.id === "workflow_board")?.payload;
    checks.push(checkWorkflowBoardSmokeConsistency(workflow));
    checks.push(checkLoadingSettled(deadline.timedOut, Date.now() - startedAt, timeoutMs));
    checks.push({
      id: "live_ui_validation",
      label: "Live UI navigation and console validation",
      status: "incomplete",
      evidence: "CLI smoke does not drive a browser; run Browser validation for navigation, console, and rendered DOM evidence."
    });
    checks.push({
      id: "responsive_viewports",
      label: "Tablet/mobile validation",
      status: "incomplete",
      evidence: "CLI smoke does not control Browser viewport; record Browser evidence separately."
    });
    return report(repoRoot, server, checks);
  } finally {
    deadline.clear();
    await server.close();
  }
}

async function getText(baseUrl: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(baseUrl, { signal });
  if (!response.ok) {
    throw new Error(`GET / failed with HTTP ${response.status}`);
  }
  return await response.text();
}

async function getJsonCheck(baseUrl: string, path: string, id: string, label: string, signal: AbortSignal): Promise<{ id: string; payload?: unknown; check: DashboardSmokeCheck }> {
  try {
    const response = await fetch(new URL(path, baseUrl), { signal });
    if (!response.ok) {
      return {
        id,
        check: { id, label, status: "failed", evidence: `GET ${path} failed with HTTP ${response.status}.` }
      };
    }
    const payload = await response.json();
    return { id, payload, check: dashboardApiSmokeCheck(id, label, payload) };
  } catch (error) {
    return {
      id,
      check: { id, label, status: "failed", evidence: smokeFetchError(error, `GET ${path} failed.`) }
    };
  }
}

function checkHttpHtml(html: string): DashboardSmokeCheck {
  if (!html.includes("/src/main.tsx")) {
    return {
      id: "dashboard_index",
      label: "Dashboard index",
      status: "failed",
      evidence: "Dashboard index did not include the React entrypoint."
    };
  }
  return {
    id: "dashboard_index",
    label: "Dashboard index",
    status: "passed",
    evidence: "Dashboard index loaded with the React entrypoint."
  };
}

/** Convert a dashboard API payload into a smoke check row. */
export function dashboardApiSmokeCheck(id: string, label: string, payload: unknown): DashboardSmokeCheck {
  if (isRecord(payload) && payload.ok === true) {
    return { id, label, status: "passed", evidence: "API returned ok=true." };
  }
  return { id, label, status: "failed", evidence: "API did not return ok=true." };
}

function checkBadTokens(
  id: string,
  label: string,
  text: string,
  tokens = BAD_RENDER_TOKENS,
  foundStatus: DashboardSmokeStatus = "failed"
): DashboardSmokeCheck {
  const token = tokens.find((item) => text.includes(item));
  if (token) {
    return { id, label, status: foundStatus, evidence: `Found token in raw payload; verify rendered DOM separately: ${token}` };
  }
  return { id, label, status: "passed", evidence: "No obvious bad render tokens found." };
}

/** Check high-level workflow board status consistency for release smoke output. */
export function checkWorkflowBoardSmokeConsistency(payload: unknown): DashboardSmokeCheck {
  const data = isRecord(payload) ? payload.data : undefined;
  if (!isWorkflowBoardLike(data)) {
    return {
      id: "workflow_status_consistency",
      label: "Workflow status consistency",
      status: "failed",
      evidence: "Workflow board payload shape was not recognized."
    };
  }
  const stageIds = new Set(data.stages?.map((stage) => stage.id).filter((id): id is string => Boolean(id)) ?? []);
  if (data.activeStageId && !stageIds.has(data.activeStageId)) {
    return {
      id: "workflow_status_consistency",
      label: "Workflow status consistency",
      status: "failed",
      evidence: `Active stage ${data.activeStageId} is missing from stages.`
    };
  }
  if (data.selectedStageId && !stageIds.has(data.selectedStageId)) {
    return {
      id: "workflow_status_consistency",
      label: "Workflow status consistency",
      status: "failed",
      evidence: `Selected stage ${data.selectedStageId} is missing from stages.`
    };
  }
  const cleanupStage = data.stages?.find((stage) => stage.id === "cleanup");
  const cleanupStatuses = new Map((data.cleanupChecks ?? []).map((check) => [check.id, check.status]));
  for (const substage of cleanupStage?.substages ?? []) {
    const rowStatus = cleanupStatuses.get(substage.id);
    if (!rowStatus) continue;
    if (substage.status === "done" && rowStatus !== "passed" && rowStatus !== "skipped") {
      return {
        id: "workflow_status_consistency",
        label: "Workflow status consistency",
        status: "failed",
        evidence: `Cleanup substage ${substage.id} is done while checklist is ${rowStatus}.`
      };
    }
  }
  return {
    id: "workflow_status_consistency",
    label: "Workflow status consistency",
    status: "passed",
    evidence: "Workflow stage and cleanup checklist statuses are consistent."
  };
}

function checkLoadingSettled(timedOut: boolean, elapsedMs: number, timeoutMs: number): DashboardSmokeCheck {
  if (timedOut) {
    return {
      id: "loading_settled",
      label: "Loading settled",
      status: "failed",
      evidence: `Dashboard smoke exceeded the ${timeoutMs}ms request deadline.`
    };
  }
  return {
    id: "loading_settled",
    label: "Loading settled",
    status: "passed",
    evidence: `Dashboard index and API requests completed in ${elapsedMs}ms within the ${timeoutMs}ms request deadline.`
  };
}

function report(repoRoot: string, server: { url: string; host: string; port: number }, checks: DashboardSmokeCheck[]): DashboardSmokeReport {
  const hasFailure = checks.some((check) => check.status === "failed");
  const hasWarning = checks.some((check) => check.status === "warning" || check.status === "incomplete");
  return {
    ok: !hasFailure,
    status: hasFailure ? "fail" : hasWarning ? "warn" : "pass",
    exitCodeContract: "Exit 0 means no failed checks. Inspect status and checks for warning or incomplete Browser validation items.",
    targetRepoRoot: repoRoot,
    dashboard: {
      url: server.url,
      host: server.host,
      port: server.port,
      loopbackOnly: true
    },
    checks
  };
}

function createSmokeDeadline(timeoutMs: number): { signal: AbortSignal; clear: () => void; timedOut: boolean } {
  const controller = new AbortController();
  const deadline = {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
    timedOut: false
  };
  const timer = setTimeout(() => {
    deadline.timedOut = true;
    controller.abort();
  }, timeoutMs);
  return deadline;
}

function smokeFetchError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "Request timed out before the dashboard smoke deadline." : error.message;
  }
  return fallback;
}

function isWorkflowBoardLike(value: unknown): value is WorkflowBoardLike {
  if (!isRecord(value)) return false;
  return Array.isArray(value.stages) && Array.isArray(value.cleanupChecks);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
