import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createControllerHost, type ControllerHost } from "./controller-host.js";
import { loadConfig } from "./config.js";
import { AgentLoopError, toErrorPayload } from "./errors.js";
import { dashboardUiRoot, defaultPackageRoot } from "./plugin-paths.js";
import type { AgentTimelineSource, GateDecisionInput } from "./types.js";

export interface DashboardServerOptions {
  /** Target repository root used for config, storage, gates, and controller operations. */
  targetRepoRoot?: string;
  /** Backward-compatible target repository root fallback. Prefer targetRepoRoot for new callers. */
  repoRoot: string;
  /** Repository root that contains this plugin and its dashboard UI assets. */
  pluginRoot?: string;
  /** Explicit dashboard UI root; overrides pluginRoot when provided by tests or tooling. */
  uiRoot?: string;
  host?: string;
  port?: number;
  token?: string;
  serveUi?: boolean;
  controllerHost?: ControllerHost;
}

export interface DashboardServerHandle {
  host: string;
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

type JsonValue = Record<string, unknown>;

/** Start the local dashboard HTTP server with loopback and token guards. */
export async function startDashboardServer(options: DashboardServerOptions): Promise<DashboardServerHandle> {
  const targetRepoRoot = options.targetRepoRoot ?? options.repoRoot;
  const configResult = safeLoadConfig(targetRepoRoot);
  const host = options.host ?? configResult?.dashboard?.host ?? "127.0.0.1";
  assertLoopbackHost(host);
  const port = options.port ?? configResult?.dashboard?.port ?? 0;
  const token = options.token ?? process.env.AGENT_LOOP_MCP_TOKEN ?? randomBytes(24).toString("base64url");
  const controllerHost = options.controllerHost ?? createControllerHost({ repoRoot: targetRepoRoot, mcpToken: token });
  const ownsHost = options.controllerHost === undefined;
  const uiRoot = options.uiRoot ?? dashboardUiRoot(options.pluginRoot ?? defaultPackageRoot());
  const vite = options.serveUi === false
    ? undefined
    : await createViteMiddleware(uiRoot);

  const server = createHttpServer(async (request, response) => {
    setSecurityHeaders(response);
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { ok: false, error: { code: "forbidden", message: "Dashboard accepts loopback clients only." } });
      return;
    }
    const handled = await handleApiRequest(request, response, controllerHost, token);
    if (handled) {
      return;
    }
    if (vite) {
      if (isViteClientRequest(request)) {
        sendEmptyModule(response);
        return;
      }
      if (isDashboardIndexRequest(request)) {
        sendDashboardIndex(response, uiRoot, token);
        return;
      }
      vite.middlewares(request, response, () => sendNotFound(response));
      return;
    }
    sendNotFound(response);
  });

  const actualPort = await listen(server, host, port);
  const url = `http://${host}:${actualPort}/`;
  return {
    host,
    port: actualPort,
    token,
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await vite?.close();
      if (ownsHost) {
        controllerHost.dispose();
      }
    }
  };
}

function isViteClientRequest(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  return request.method === "GET" && pathname === "/@vite/client";
}

function sendEmptyModule(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
  response.end([
    "const noop = () => {};",
    "const styles = new Map();",
    "export function updateStyle(id, content) {",
    "  let style = styles.get(id);",
    "  if (!style) {",
    "    style = document.createElement('style');",
    "    style.setAttribute('type', 'text/css');",
    "    style.setAttribute('data-vite-dev-id', id);",
    "    document.head.appendChild(style);",
    "    styles.set(id, style);",
    "  }",
    "  style.textContent = content;",
    "}",
    "export function removeStyle(id) {",
    "  const style = styles.get(id);",
    "  if (style) style.remove();",
    "  styles.delete(id);",
    "}",
    "export function createHotContext() {",
    "  return { accept: noop, prune: noop, dispose: noop, decline: noop, invalidate: noop, on: noop, off: noop, send: noop, data: {} };",
    "}",
    ""
  ].join("\n"));
}

function isDashboardIndexRequest(request: IncomingMessage): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  return pathname === "/" || pathname === "/index.html";
}

function sendDashboardIndex(response: ServerResponse, uiRoot: string, token: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(injectDashboardToken(stripViteClient(readFileSync(join(uiRoot, "index.html"), "utf8")), token));
}

function safeLoadConfig(repoRoot: string): ReturnType<typeof loadConfig>["config"] | undefined {
  try {
    return loadConfig(repoRoot).config;
  } catch {
    return undefined;
  }
}

async function createViteMiddleware(uiRoot: string): Promise<import("vite").ViteDevServer> {
  const vite = await import("vite");
  return await vite.createServer({
    root: uiRoot,
    configFile: false,
    appType: "spa",
    logLevel: "silent",
    plugins: [{
      name: "agent-loop-strip-vite-client",
      transformIndexHtml(html) {
        return stripViteClient(html);
      }
    }],
    server: { middlewareMode: true, hmr: false }
  });
}

function stripViteClient(html: string): string {
  return html.replace(/<script type="module" src="\/@vite\/client"><\/script>\s*/g, "");
}

function injectDashboardToken(html: string, token: string): string {
  const bootstrap = [
    "<script>",
    `window.__AGENT_LOOP_DASHBOARD_TOKEN__ = ${jsonForInlineScript(token)};`,
    "</script>"
  ].join("");
  const appScript = "<script type=\"module\" src=\"/src/main.tsx\"></script>";
  if (html.includes(appScript)) {
    return html.replace(appScript, `${bootstrap}\n    ${appScript}`);
  }
  return html.replace("</head>", `  ${bootstrap}\n  </head>`);
}

function jsonForInlineScript(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    if (character === "<") return "\\u003c";
    if (character === ">") return "\\u003e";
    if (character === "&") return "\\u0026";
    if (character === "\u2028") return "\\u2028";
    return "\\u2029";
  });
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  host: ControllerHost,
  token: string
): Promise<boolean> {
  if (!request.url?.startsWith("/api/")) {
    return false;
  }
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const controller = host.getController();
    const path = url.pathname;
    const method = request.method ?? "GET";
    if (isMutation(method, path)) {
      enforceMutationRequest(request, url, token);
    }

    if (method === "GET" && path === "/api/status") return sendController(response, controller.loopStatus());
    if (method === "GET" && path === "/api/mission-control") return sendController(response, controller.loopMissionControl());
    if (method === "GET" && path === "/api/observe") return sendController(response, controller.loopObserve(numberParam(url, "limit") ?? 20));
    if (method === "GET" && path === "/api/next-action") return sendController(response, controller.loopNextAction());
    if (method === "GET" && path === "/api/gates") return sendController(response, controller.loopListGates());
    if (method === "GET" && path.startsWith("/api/gates/")) {
      return sendController(response, controller.loopExplainGate(decodeTail(path, "/api/gates/")));
    }
    if (method === "GET" && path === "/api/runs") return sendController(response, controller.loopListRuns(numberParam(url, "limit")));
    if (method === "GET" && path === "/api/events") {
      return sendController(response, controller.loopListEvents(numberParam(url, "since"), numberParam(url, "limit")));
    }
    if (method === "GET" && path === "/api/agent-timeline") {
      return sendController(response, controller.loopAgentTimeline(timelineQuery(url)));
    }
    if (method === "GET" && path.startsWith("/api/artifacts/")) {
      enforceTokenHeader(request, token);
      return sendController(response, controller.loopReadArtifact(decodeTail(path, "/api/artifacts/")));
    }
    if (method === "GET" && path === "/api/artifacts") return sendController(response, controller.loopListArtifacts());
    if (method === "GET" && path === "/api/pr") return sendController(response, controller.loopGetPrStatus());
    if (method === "GET" && path === "/api/ci") return sendController(response, controller.loopGetCiStatus());
    if (method === "GET" && path === "/api/review-comments") return sendController(response, controller.loopGetReviewComments());
    if (method === "GET" && path === "/api/workers") {
      const limit = numberParam(url, "limit");
      const workerId = stringParam(url, "workerId");
      return sendController(response, controller.loopListWorkers({
        ...(limit === undefined ? {} : { limit }),
        ...(workerId ? { workerId } : {}),
        includeEvents: truthyParam(url, "events")
      }));
    }
    if (method === "GET" && path === "/api/audit-export") {
      return sendController(response, controller.loopExportAudit({
        runId: requiredStringParam(url, "runId"),
        format: auditFormatParam(url)
      }));
    }
    if (method === "GET" && path === "/api/dashboard-meta") return sendController(response, controller.loopDashboardMeta());
    if (method === "GET" && path === "/api/plan") return sendController(response, controller.loopPlanNavigator());
    if (method === "GET" && path === "/api/policy-config") return sendController(response, controller.loopPolicyConfig());
    if (method === "GET" && path === "/api/dry-run-preview") return sendController(response, controller.loopDryRunPreview());
    if (method === "GET" && path === "/api/notifications") return sendController(response, controller.loopNotifications());
    if (method === "GET" && path === "/api/workflow-board") {
      return sendController(response, controller.loopWorkflowBoard({
        ...(stringParam(url, "runId") ? { runId: requiredStringParam(url, "runId") } : {})
      }));
    }

    if (method === "POST" && path === "/api/run-until-gate") return sendController(response, controller.loopRunUntilGate(token));
    if (method === "POST" && path === "/api/resume") return sendController(response, await controller.loopResume(token));
    if (method === "POST" && path === "/api/step") return sendController(response, await controller.loopStep(token));
    if (method === "POST" && path === "/api/stop") return sendController(response, controller.loopStop(token));
    if (method === "POST" && path === "/api/recover") return sendController(response, controller.loopRecover(token));
    if (method === "POST" && path === "/api/policy-config") {
      const body = await readJsonBody(request);
      return sendController(response, controller.loopSavePolicyConfig(body, token));
    }
    if (method === "POST" && path === "/api/notifications/mark-read") {
      const body = await readJsonBody(request);
      return sendController(response, controller.loopMarkNotificationsRead(body, token));
    }
    if (method === "POST" && path === "/api/notifications/dismiss") {
      const body = await readJsonBody(request);
      return sendController(response, controller.loopDismissNotifications(body, token));
    }
    if (method === "POST" && path === "/api/workflow-board/evidence") {
      const body = await readJsonBody(request);
      return sendController(response, controller.loopAppendWorkflowEvidence(body, token));
    }
    if (method === "POST" && path.endsWith("/mark-handled") && path.startsWith("/api/gates/")) {
      const gateId = decodeTail(path.slice(0, -"mark-handled".length - 1), "/api/gates/");
      return sendController(response, controller.loopMarkHistoricalGateHandled(gateId, token));
    }
    if (method === "POST" && path.endsWith("/re-evaluate") && path.startsWith("/api/gates/")) {
      const gateId = decodeTail(path.slice(0, -"re-evaluate".length - 1), "/api/gates/");
      return sendController(response, controller.loopReevaluateHistoricalGate(gateId, token));
    }
    if (method === "POST" && path.endsWith("/approve") && path.startsWith("/api/gates/")) {
      const body = await readJsonBody(request);
      const gateId = decodeTail(path.slice(0, -"approve".length - 1), "/api/gates/");
      return sendController(response, controller.loopApproveGate(gateId, gateDecisionBody(body), token));
    }
    if (method === "POST" && path.endsWith("/reject") && path.startsWith("/api/gates/")) {
      const body = await readJsonBody(request);
      const gateId = decodeTail(path.slice(0, -"reject".length - 1), "/api/gates/");
      return sendController(response, controller.loopRejectGate(gateId, gateDecisionBody(body), token));
    }
    sendJson(response, 404, { ok: false, error: { code: "not_found", message: `Unknown dashboard endpoint: ${path}` } });
    return true;
  } catch (error) {
    const payload = toErrorPayload(error);
    sendJson(response, httpStatusForCode(payload.code), { ok: false, error: payload });
    return true;
  }
}

function sendController(response: ServerResponse, result: unknown): true {
  const status = isControllerFailure(result) ? httpStatusForCode(result.error?.code) : 200;
  sendJson(response, status, result);
  return true;
}

function isMutation(method: string, path: string): boolean {
  if (method === "GET" && path === "/api/policy-config") {
    return false;
  }
  return path === "/api/run-until-gate" ||
    path === "/api/resume" ||
    path === "/api/step" ||
    path === "/api/stop" ||
    path === "/api/recover" ||
    path === "/api/policy-config" ||
    path === "/api/notifications/mark-read" ||
    path === "/api/notifications/dismiss" ||
    path === "/api/workflow-board/evidence" ||
    path.endsWith("/mark-handled") ||
    path.endsWith("/re-evaluate") ||
    path.endsWith("/approve") ||
    path.endsWith("/reject");
}

function enforceMutationRequest(request: IncomingMessage, url: URL, token: string): void {
  if (request.method !== "POST") {
    throw new AgentLoopError("policy_violation", "Dashboard mutations require POST.");
  }
  const supplied = request.headers["x-agent-loop-token"];
  if (supplied !== token) {
    throw new AgentLoopError("needs_secret_or_login", "Dashboard token is missing or invalid.", { exitCode: 2 });
  }
  const origin = request.headers.origin;
  if (origin && !isAllowedOrigin(origin, request.headers.host)) {
    throw new AgentLoopError("policy_violation", "Dashboard mutation origin is not allowed.");
  }
}

function enforceTokenHeader(request: IncomingMessage, token: string): void {
  const supplied = request.headers["x-agent-loop-token"];
  if (supplied !== token) {
    throw new AgentLoopError("needs_secret_or_login", "Dashboard token is missing or invalid.", { exitCode: 2 });
  }
}

function isControllerFailure(result: unknown): result is { ok: false; error?: { code?: string } } {
  return typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    (result as { ok?: unknown }).ok === false;
}

function httpStatusForCode(code: string | undefined): number {
  if (code === "needs_secret_or_login") return 401;
  if (code === "policy_violation") return 403;
  if (code === "needs_repo_init" || code === "invalid_config") return 400;
  if (code === "artifact_integrity_error" || code === "storage_error") return 404;
  return 500;
}

function isAllowedOrigin(origin: string, hostHeader: string | undefined): boolean {
  try {
    const parsed = new URL(origin);
    return isLoopbackHost(parsed.hostname) && (!hostHeader || parsed.host === hostHeader);
  } catch {
    return false;
  }
}

function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new AgentLoopError("policy_violation", "Dashboard host must be loopback.", { details: { host } });
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === undefined ||
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1";
}

function numberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function stringParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value && value.length > 0 ? value : undefined;
}

function requiredStringParam(url: URL, name: string): string {
  const value = stringParam(url, name);
  if (!value) {
    throw new AgentLoopError("invalid_config", `Missing required query parameter: ${name}`);
  }
  return value;
}

function truthyParam(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  return value === "1" || value === "true" || value === "yes";
}

function auditFormatParam(url: URL): "markdown" | "json" {
  const value = url.searchParams.get("format") ?? "markdown";
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new AgentLoopError("invalid_config", "audit-export format must be markdown or json.");
}

function sourceParams(url: URL): AgentTimelineSource[] | undefined {
  const values = [
    ...url.searchParams.getAll("source"),
    ...url.searchParams.getAll("sources").flatMap((value) => value.split(","))
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length ? values as AgentTimelineSource[] : undefined;
}

function timelineQuery(url: URL): {
  cursor?: string;
  limit?: number;
  sources?: AgentTimelineSource[];
  runId?: string;
  workerId?: string;
} {
  const cursor = stringParam(url, "cursor");
  const limit = numberParam(url, "limit");
  const sources = sourceParams(url);
  const runId = stringParam(url, "runId");
  const workerId = stringParam(url, "workerId");
  return {
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(sources ? { sources } : {}),
    ...(runId ? { runId } : {}),
    ...(workerId ? { workerId } : {})
  };
}

function decodeTail(path: string, prefix: string): string {
  return decodeURIComponent(path.slice(prefix.length));
}

async function readJsonBody(request: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AgentLoopError("invalid_config", "Request body must be valid JSON.");
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as JsonValue : {};
}

function stringBody(body: JsonValue, name: string): string {
  const value = body[name];
  return typeof value === "string" ? value : "";
}

function gateDecisionBody(body: JsonValue): GateDecisionInput {
  const source = stringBody(body, "source");
  const payload = body.payload;
  return {
    note: stringBody(body, "note"),
    source: source === "cli" || source === "api" || source === "ui" || source === "nl" ? source : "ui",
    payload: typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  };
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendNotFound(response: ServerResponse): void {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "frame-ancestors 'none'");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve(address.port);
        return;
      }
      reject(new Error("Dashboard server did not expose a port."));
    });
  });
}
