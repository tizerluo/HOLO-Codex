import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cliText, parseLocaleOverride, resolveCliLocale, stripLocaleArgs } from "./cli-i18n.js";
import { redactRemote } from "./command.js";
import { configPath, loadConfig, statePath, withConfigDefaults } from "./config.js";
import { McpController, type McpResult } from "./mcp-controller.js";
import { startDashboardServer } from "./dashboard-server.js";
import { runDoctor } from "./doctor.js";
import { AgentLoopError, isGateCode, toErrorPayload, type AgentLoopErrorCode } from "./errors.js";
import { recoverBlockedRun } from "./gate-recovery.js";
import { commandsReferencingLegacyPrivateRepo, inspectAgentLoopBinary, inspectBundledHooksConfig, redactDiagnosticText, type AgentLoopBinaryInspection, type BundledHooksConfigInspection } from "./hook-diagnostics.js";
import { agentLoopRouterHookEntries, collectHookCommands, isAgentLoopHookCommand, isLegacyAgentLoopHookCommand } from "./hook-installation.js";
import { hookRegistryPath, inspectHookRegistryLock, listHookBindings, removeHookBinding, upsertHookBinding } from "./hook-router.js";
import { inspectLocalInstall, installLocalAgentLoop, listLocalInstallSnapshots, pruneLocalInstallSnapshots, rollbackLocalAgentLoop } from "./local-install.js";
import { defaultPackageRoot, hookSourceRoot } from "./plugin-paths.js";
import { resumeStateMachine, runStateMachine, stopStateMachine } from "./state-machine.js";
import { SqliteAgentLoopStorage } from "./storage.js";
import { resolveRepoRoot } from "./repo-root.js";
import { bindDeliveryWorkItem } from "./delivery-work-item.js";
import { appendWorkflowEvidence, WORKFLOW_STAGE_DEFINITIONS, WORKFLOW_STAGE_IDS } from "./workflow-board.js";
import { inspectHookCapture } from "./hook-capture.js";
import type { StateMachineResult } from "./state-types.js";
import type { AgentLoopConfig, AgentTimelineSource, DoctorReport } from "./types.js";
import type { EffectiveLocale, LocaleSetting } from "./locale.js";

const DELIVERY_STAGE_STATUSES = ["pending", "active", "blocked", "done", "skipped", "manual", "failed"] as const;

export interface CliResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

export interface ParsedCliInvocation {
  command: string;
  commandArgs: string[];
  json: boolean;
  localeOverride?: LocaleSetting;
  targetRepoRoot: string;
  targetPath: string;
}

/** Parse global CLI flags and resolve the target repository before command dispatch. */
export function parseCliInvocation(args: string[], cwd = process.cwd()): ParsedCliInvocation {
  const json = args.includes("--json");
  const localeOverride = parseCliLocale(args);
  const withoutJson = args.filter((arg) => arg !== "--json");
  const withoutLocale = stripLocaleArgs(withoutJson);
  const { filtered, targetPath } = stripRepoArgs(withoutLocale, cwd);
  return {
    command: filtered[0] ?? "status",
    commandArgs: filtered,
    json,
    ...(localeOverride ? { localeOverride } : {}),
    targetPath,
    targetRepoRoot: resolveRepoRoot(targetPath)
  };
}

/** Execute the `agent-loop` CLI and return captured output plus the intended exit code. */
export async function runAgentLoopCli(
  args: string[],
  cwd = process.cwd(),
  options: { signal?: AbortSignal } = {}
): Promise<CliResult> {
  let json = args.includes("--json");

  try {
    const parsed = parseCliInvocation(args, cwd);
    json = parsed.json;
    const { command, commandArgs: filtered, localeOverride, targetRepoRoot } = parsed;
    const fallbackLocale = helpLocale(localeOverride);

    if (command === "help" || command === "--help" || command === "-h") {
      return helpResult(json);
    }
    if (isHelpRequest(filtered)) {
      if (command === "evidence") {
        return evidenceHelpResult(json);
      }
      if (command === "delivery") {
        return deliveryHelpResult(json);
      }
      if (command === "local") {
        return localHelpResult(json, filtered[1], filtered[2]);
      }
      const usage = commandHelpUsage(command);
      if (usage) {
        return helpResult(json, usage);
      }
    }
    if (command === "status") {
      return await status(targetRepoRoot, json, localeOverride);
    }
    if (command === "init") {
      return await init(targetRepoRoot, filtered.includes("--dry-run"), json, fallbackLocale);
    }
    if (command === "doctor") {
      return await doctor(targetRepoRoot, json, localeOverride);
    }
    if (command === "run") {
      return await run(targetRepoRoot, filtered, json, localeOverride, options.signal);
    }
    if (command === "step") {
      return await step(targetRepoRoot, json, localeOverride, options.signal);
    }
    if (command === "resume") {
      return await resume(targetRepoRoot, json, localeOverride);
    }
    if (command === "stop") {
      return await stop(targetRepoRoot, json, localeOverride);
    }
    if (command === "logs") {
      return await logs(targetRepoRoot, json, localeOverride);
    }
    if (command === "timeline") {
      return timeline(targetRepoRoot, filtered, json, localeOverride);
    }
    if (command === "workers") {
      return workers(targetRepoRoot, filtered, json, localeOverride);
    }
    if (command === "observe") {
      return observe(targetRepoRoot, filtered, json, localeOverride);
    }
    if (command === "audit-export") {
      return auditExport(targetRepoRoot, filtered, json, localeOverride);
    }
    if (command === "recover") {
      return recover(targetRepoRoot, json, localeOverride);
    }
    if (command === "install-hooks") {
      return installHooks(targetRepoRoot, json, localeOverride);
    }
    if (command === "hooks") {
      return hooks(targetRepoRoot, filtered, json, localeOverride);
    }
    if (command === "local") {
      return local(targetRepoRoot, filtered, json);
    }
    if (command === "approve-gate") {
      return approveGate(targetRepoRoot, filtered, json, localeOverride);
    }
    if (command === "evidence") {
      return evidence(targetRepoRoot, filtered, json, localeOverride);
    }
    if (command === "delivery") {
      return delivery(targetRepoRoot, filtered, json, localeOverride);
    }
    if (command === "dashboard") {
      return await dashboard(targetRepoRoot, filtered, json, localeOverride);
    }
    throw new AgentLoopError("unknown_command", `Unknown command: ${command}`);
  } catch (error) {
    const payload = toErrorPayload(error);
    const exitCode = error instanceof AgentLoopError ? error.exitCode : 1;
    const stdout = json ? `${JSON.stringify({ ok: false, error: payload }, null, 2)}\n` : "";
    const stderr = json ? "" : `${payload.code}: ${payload.message}\n${formatSafeErrorDetails(payload.details)}`;
    return { exitCode, stdout, stderr };
  }
}

function isHelpRequest(args: string[]): boolean {
  return args.some((arg, index) => (arg === "--help" || arg === "-h") && !isOptionValue(args, index));
}

function isOptionValue(args: string[], index: number): boolean {
  const previous = args[index - 1];
  return previous !== undefined && OPTIONS_WITH_VALUES.has(previous);
}

function helpResult(json: boolean, usage = "agent-loop <command> [options]"): CliResult {
  const commands = [
    "status",
    "init",
    "doctor",
    "run",
    "step",
    "resume",
    "stop",
    "logs",
    "timeline",
    "workers",
    "observe",
    "audit-export",
    "recover",
    "install-hooks",
    "hooks",
    "local",
    "approve-gate",
    "dashboard",
    "evidence",
    "delivery"
  ];
  return ok(json, { ok: true, usage, commands }, [
    `Usage: ${usage}`,
    `Commands: ${commands.join(", ")}`
  ]);
}

function commandHelpUsage(command: string): string | undefined {
  const usages: Record<string, string> = {
    status: "agent-loop status [--json]",
    init: "agent-loop init [--dry-run] [--json]",
    doctor: "agent-loop doctor [--json]",
    run: "agent-loop run [--dry-run] [--until=gate] [--json]",
    step: "agent-loop step [--json]",
    resume: "agent-loop resume [--json]",
    stop: "agent-loop stop [--json]",
    logs: "agent-loop logs [--json]",
    timeline: "agent-loop timeline [--limit N] [--cursor CURSOR] [--run RUN_ID] [--worker WORKER_ID] [--source SOURCE] [--json]",
    workers: "agent-loop workers [--limit N] [--worker WORKER_ID] [--events] [--json]",
    observe: "agent-loop observe [--limit N] [--json]",
    "audit-export": "agent-loop audit-export --run RUN_ID --format markdown|json [--output PATH] [--json]",
    recover: "agent-loop recover [--json]",
    "install-hooks": "agent-loop install-hooks [--repo /path/to/repo] [--json]",
    hooks: "agent-loop hooks install-router|bind|list|doctor|unbind [--session SESSION_ID] [--run RUN_ID] [--json]",
    local: "agent-loop local install|rollback|doctor|snapshots [--repo /path/to/repo] [--snapshot PATH] [--json]",
    "approve-gate": "agent-loop approve-gate <gate-id> --note \"...\" [--next-state STATE] [--json]",
    dashboard: "agent-loop dashboard [--host 127.0.0.1] [--port 0] [--json]",
    evidence: "agent-loop evidence append --stage STAGE --summary \"...\" [--run RUN_ID] [--substage ID] [--actor ACTOR] [--status STATUS] [--source SOURCE] [--ref REF] [--artifact ID] [--json]",
    delivery: "agent-loop delivery bind|stage [options] [--json]"
  };
  return usages[command];
}

const OPTIONS_WITH_VALUES = new Set([
  "--cursor",
  "--format",
  "--host",
  "--actor",
  "--artifact",
  "--branch",
  "--keep",
  "--limit",
  "--next-state",
  "--note",
  "--output",
  "--port",
  "--issue",
  "--ref",
  "--run",
  "--source",
  "--stage",
  "--status",
  "--session",
  "--snapshot",
  "--substage",
  "--summary",
  "--title",
  "--url",
  "--worker"
]);

async function status(repoRoot: string, json: boolean, localeOverride: LocaleSetting | undefined): Promise<CliResult> {
  const { config } = loadConfig(repoRoot);
  const locale = resolveCliLocale(localeOverride, config.locale);
  const path = statePath(repoRoot);
  const storage = new SqliteAgentLoopStorage(path);
  let current: ReturnType<SqliteAgentLoopStorage["getCurrentStatus"]>;
  try {
    current = storage.getCurrentStatus();
  } finally {
    storage.close();
  }
  const payload = {
    ok: true,
    repoId: config.repoId,
    baseBranch: config.baseBranch,
    plansDir: config.plansDir,
    storagePath: path,
    status: current.status,
    gate: current.gate
  };
  return {
    ...ok(json, payload, [
      `${cliText(locale, "repoId")}: ${payload.repoId}`,
      `${cliText(locale, "baseBranch")}: ${payload.baseBranch}`,
      `${cliText(locale, "plansDir")}: ${payload.plansDir}`,
      `${cliText(locale, "storage")}: ${payload.storagePath}`,
      `${cliText(locale, "status")}: ${payload.status}`,
      payload.gate ? `${cliText(locale, "gate")}: ${payload.gate.kind} - ${payload.gate.message}` : undefined
    ]),
    exitCode: json ? 0 : current.status === "BLOCKED" || current.status === "STOPPED" ? 2 : 0
  };
}

function recover(repoRoot: string, json: boolean, localeOverride: LocaleSetting | undefined): CliResult {
  const locale = localeForRepo(repoRoot, localeOverride);
  const result = recoverBlockedRun(repoRoot, "cli");
  return ok(json, result, [
    `${cliText(locale, "recovered")}: ${result.recovered}`,
    `repo gates: ${result.repo.recovered}`,
    result.worker.recovered > 0
      ? `worker gates: ${result.worker.recovered} (${result.worker.gateKinds.join(", ")})`
      : "worker gates: 0",
    ...(result.worker.recovered > 0 ? [`resume: agent-loop resume`] : [])
  ]);
}

async function init(repoRoot: string, dryRun: boolean, json: boolean, locale: EffectiveLocale): Promise<CliResult> {
  const configFile = configPath(repoRoot);
  if (!dryRun && existsSync(configFile)) {
    throw new AgentLoopError(
      "config_exists",
      ".agent-loop/config.json already exists. PR A does not implement --force."
    );
  }

  const remote = git(repoRoot, ["remote", "get-url", "origin"]);
  const currentBranch = getCurrentBranch(repoRoot);
  if (!remote.includes("github.com")) {
    throw new AgentLoopError("unsupported_remote", "origin remote is not a GitHub remote.", {
      details: { remote: redactRemote(remote) },
      exitCode: 2
    });
  }

  const config = inferConfig(repoRoot, remote);
  const payload = {
    ok: true,
    dryRun,
    configPath: configFile,
    storagePath: statePath(repoRoot),
    currentBranch,
    config
  };

  if (!dryRun) {
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    ensureAgentLoopGitignore(repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    try {
      storage.writeRepoConfig(config);
    } finally {
      storage.close();
    }
  }

  return ok(json, payload, [
    dryRun ? cliText(locale, "initDryRun") : cliText(locale, "initDone"),
    `${cliText(locale, "currentBranch")}: ${currentBranch}`,
    `${cliText(locale, "repoId")}: ${config.repoId}`,
    `${cliText(locale, "baseBranch")}: ${config.baseBranch}`,
    `${cliText(locale, "plansDir")}: ${config.plansDir}`,
    `${cliText(locale, "config")}: ${configFile}`,
    `${cliText(locale, "storage")}: ${statePath(repoRoot)}`
  ]);
}

async function doctor(repoRoot: string, json: boolean, localeOverride: LocaleSetting | undefined): Promise<CliResult> {
  const locale = localeForRepo(repoRoot, localeOverride);
  const report = runDoctor(repoRoot);
  const exitCode: 0 | 1 | 2 = report.gate ? 2 : report.status === "fail" ? 1 : 0;
  if (json) {
    return { exitCode, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: "" };
  }
  return {
    exitCode,
    stdout: formatDoctor(report, locale),
    stderr: ""
  };
}

async function run(repoRoot: string, args: string[], json: boolean, localeOverride: LocaleSetting | undefined, signal?: AbortSignal): Promise<CliResult> {
  const locale = localeForRepo(repoRoot, localeOverride);
  const result = await runStateMachine({
    repoRoot,
    dryRun: args.includes("--dry-run"),
    untilGate: args.includes("--until=gate"),
    signal
  });
  return stateResult(json, result, locale);
}

async function step(repoRoot: string, json: boolean, localeOverride: LocaleSetting | undefined, signal?: AbortSignal): Promise<CliResult> {
  const locale = localeForRepo(repoRoot, localeOverride);
  const result = await runStateMachine({
    repoRoot,
    dryRun: false,
    untilGate: false,
    singleStep: true,
    signal
  });
  return stateResult(json, result, locale);
}

async function resume(repoRoot: string, json: boolean, localeOverride: LocaleSetting | undefined): Promise<CliResult> {
  return stateResult(json, await resumeStateMachine(repoRoot), localeForRepo(repoRoot, localeOverride));
}

async function stop(repoRoot: string, json: boolean, localeOverride: LocaleSetting | undefined): Promise<CliResult> {
  return stateResult(json, stopStateMachine(repoRoot), localeForRepo(repoRoot, localeOverride), { jsonStoppedOk: true });
}

async function logs(repoRoot: string, json: boolean, localeOverride: LocaleSetting | undefined): Promise<CliResult> {
  localeForRepo(repoRoot, localeOverride);
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const events = storage.listEvents(50);
    const payload = { ok: true, events };
    // Event kind/message values are persisted ledger protocol data; do not translate them.
    return ok(
      json,
      payload,
      events.map((event) => `${event.createdAt} ${event.kind}: ${event.message}`)
    );
  } finally {
    storage.close();
  }
}

function timeline(repoRoot: string, args: string[], json: boolean, localeOverride: LocaleSetting | undefined): CliResult {
  localeForRepo(repoRoot, localeOverride);
  const source = optionArg(args, "--source");
  const result = new McpController({ repoRoot }).loopAgentTimeline({
    ...numberOption(args, "--limit", "timeline --limit must be a non-negative integer."),
    ...stringOption(args, "--cursor", "cursor"),
    ...stringOption(args, "--run", "runId"),
    ...stringOption(args, "--worker", "workerId"),
    ...(source ? { sources: [parseTimelineSource(source)] } : {})
  });
  return controllerResult(json, result, (data) =>
    (data.entries as Array<{ occurredAt: string; source: string; title: string; summary: string }>).map((entry) =>
      `${entry.occurredAt} ${entry.source}: ${entry.title}${entry.summary ? ` - ${entry.summary}` : ""}`
    )
  );
}

function workers(repoRoot: string, args: string[], json: boolean, localeOverride: LocaleSetting | undefined): CliResult {
  localeForRepo(repoRoot, localeOverride);
  const result = new McpController({ repoRoot }).loopListWorkers({
    ...numberOption(args, "--limit", "workers --limit must be a non-negative integer."),
    ...stringOption(args, "--worker", "workerId"),
    includeEvents: args.includes("--events")
  });
  return controllerResult(json, result, (data) =>
    (data.workers as Array<{ id: string; type: string; status: string; startedAt: string }>).map((worker) =>
      `${worker.id} ${worker.type} ${worker.status} ${worker.startedAt}`
    )
  );
}

function observe(repoRoot: string, args: string[], json: boolean, localeOverride: LocaleSetting | undefined): CliResult {
  localeForRepo(repoRoot, localeOverride);
  const limit = numberOption(args, "--limit", "observe --limit must be a non-negative integer.").limit ?? 20;
  const result = new McpController({ repoRoot }).loopObserve(limit);
  return controllerResult(json, result, (data) => {
    const observeData = data as {
      dashboard: { url: string; loopbackOnly: boolean };
      happy: { installed: boolean; supportsNotify: boolean };
      current: { status: string; gate?: { kind: string } };
      timeline: { entries: unknown[] };
    };
    return [
      `dashboard: ${observeData.dashboard.url} (${observeData.dashboard.loopbackOnly ? "loopback only" : "unknown"})`,
      "token: run `agent-loop dashboard` and read stderr",
      `status: ${observeData.current.status}`,
      observeData.current.gate ? `gate: ${observeData.current.gate.kind}` : undefined,
      `happy notify: ${observeData.happy.installed && observeData.happy.supportsNotify ? "available" : "unavailable"}`,
      `timeline: ${observeData.timeline.entries.length} entries`
    ].filter((line): line is string => Boolean(line));
  });
}

function auditExport(repoRoot: string, args: string[], json: boolean, localeOverride: LocaleSetting | undefined): CliResult {
  localeForRepo(repoRoot, localeOverride);
  const runId = optionArg(args, "--run");
  if (!runId) {
    throw new AgentLoopError("unknown_command", "Usage: agent-loop audit-export --run RUN_ID --format markdown|json [--output PATH]");
  }
  const format = parseAuditFormat(optionArg(args, "--format") ?? "markdown");
  const result = new McpController({ repoRoot }).loopExportAudit({ runId, format });
  if (!result.ok || !result.data) {
    return controllerResult(json, result, () => []);
  }
  const data = result.data as { content: string | Record<string, unknown> };
  const output = optionArg(args, "--output");
  const content = typeof data.content === "string" ? data.content : `${JSON.stringify(data.content, null, 2)}\n`;
  if (output) {
    writeFileSync(output, content);
  }
  if (json) {
    return ok(true, { ok: true, ...result.data, ...(output ? { output } : {}) }, []);
  }
  return {
    exitCode: 0,
    stdout: output ? `audit export written: ${output}\n` : content,
    stderr: ""
  };
}

function evidence(repoRoot: string, args: string[], json: boolean, localeOverride: LocaleSetting | undefined): CliResult {
  localeForRepo(repoRoot, localeOverride);
  const subcommand = args[1];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return evidenceHelpResult(json);
  }
  if (subcommand !== "append") {
    throw new AgentLoopError("unknown_command", "Usage: agent-loop evidence append --stage STAGE --summary \"...\" [--substage ID] [--artifact ID]");
  }
  const stageId = optionArg(args, "--stage");
  const summary = optionArg(args, "--summary");
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const result = appendWorkflowEvidence(storage, {
      runId: optionArg(args, "--run"),
      stageId,
      summary,
      substageId: optionArg(args, "--substage"),
      evidenceRefIds: optionArgs(args, "--ref"),
      artifactIds: optionArgs(args, "--artifact"),
      actor: optionArg(args, "--actor"),
      status: optionArg(args, "--status"),
      source: optionArg(args, "--source") ?? "cli",
      review: reviewEvidenceFromArgs(args)
    });
    return ok(json, { ok: true, ...result }, [
      `workflow evidence: ${result.event.id}`,
      result.event.message
    ]);
  } finally {
    storage.close();
  }
}

function evidenceHelpResult(json: boolean): CliResult {
  const substages = workflowEvidenceSubstageHelp();
  return ok(json, {
    ok: true,
    usage: commandHelpUsage("evidence"),
    stages: WORKFLOW_STAGE_IDS,
    substages,
    reviewFlags: ["--reviewer", "--requirement", "--progress", "--result", "--severity", "--model", "--session", "--conversation", "--comment-url", "--comment-id", "--reason"]
  }, [
    "Usage: agent-loop evidence append --stage STAGE --summary \"...\" [--substage ID] [--artifact ID]",
    "Review evidence: add --stage review --reviewer claude_acp --requirement required --progress started|complete --result pass|block|warn|unknown --severity none|p3_only|p2_or_higher|unknown [--model NAME] [--session ID] [--conversation ID] [--comment-url URL] [--comment-id ID] [--reason TEXT]",
    `Stages: ${WORKFLOW_STAGE_IDS.join(", ")}`,
    "Substages:",
    ...substages.map((entry) => `  ${entry.stage}: ${entry.substages.join(", ")}`)
  ]);
}

function reviewEvidenceFromArgs(args: string[]): Record<string, string> | undefined {
  const pairs: Array<[string, string]> = [
    ["reviewer", "--reviewer"],
    ["requirement", "--requirement"],
    ["progress", "--progress"],
    ["result", "--result"],
    ["model", "--model"],
    ["sessionId", "--session"],
    ["conversationId", "--conversation"],
    ["commentUrl", "--comment-url"],
    ["commentId", "--comment-id"],
    ["severitySummary", "--severity"],
    ["reason", "--reason"]
  ];
  const review = Object.fromEntries(pairs.flatMap(([key, flag]) => {
    const value = optionArg(args, flag);
    return value ? [[key, value]] : [];
  }));
  return Object.keys(review).length > 0 ? review : undefined;
}

function workflowEvidenceSubstageHelp(): Array<{ stage: string; substages: string[] }> {
  return WORKFLOW_STAGE_DEFINITIONS.map((stage) => ({
    stage: stage.id,
    substages: stage.substages.map((substage) => substage.id)
  }));
}

function delivery(repoRoot: string, args: string[], json: boolean, localeOverride: LocaleSetting | undefined): CliResult {
  localeForRepo(repoRoot, localeOverride);
  const subcommand = args[1];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return deliveryHelpResult(json);
  }
  if (subcommand !== "bind" && subcommand !== "stage") {
    throw new AgentLoopError("unknown_command", "Usage: agent-loop delivery bind|stage [options]");
  }
  const { config } = loadConfig(repoRoot);
  if (config.loopShape !== "pr-loop") {
    throw new AgentLoopError("invalid_config", "delivery is only supported for pr-loop repositories.");
  }
  if (subcommand === "stage") {
    return deliveryStage(repoRoot, args, json);
  }
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const result = bindDeliveryWorkItem(storage, {
      ...optionalCliValue(args, "--issue", "issue"),
      ...optionalCliValue(args, "--title", "title"),
      ...optionalCliValue(args, "--url", "url"),
      ...optionalCliValue(args, "--branch", "branch"),
      ...optionalCliValue(args, "--run", "runId"),
      source: "cli"
    });
    const hookBinding = upsertHookBinding({ repoRoot, runId: result.run.id });
    return ok(json, { ok: true, ...result, hookBinding }, [
      `delivery run: ${result.run.id}`,
      `issue: #${result.workItem.issue}`,
      result.bound ? "bound: yes" : "bound: reused",
      `hook binding: ${hookBinding.id}`
    ]);
  } finally {
    storage.close();
  }
}

function deliveryStage(repoRoot: string, args: string[], json: boolean): CliResult {
  const status = optionArg(args, "--status") ?? "active";
  if (!DELIVERY_STAGE_STATUSES.includes(status as (typeof DELIVERY_STAGE_STATUSES)[number])) {
    throw new AgentLoopError("invalid_config", `delivery stage --status must be one of: ${DELIVERY_STAGE_STATUSES.join(", ")}.`);
  }
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const result = appendWorkflowEvidence(storage, {
      runId: optionArg(args, "--run"),
      stageId: optionArg(args, "--stage"),
      substageId: optionArg(args, "--substage"),
      summary: optionArg(args, "--summary"),
      evidenceRefIds: optionArgs(args, "--ref"),
      actor: optionArg(args, "--actor") ?? "codex",
      status,
      source: "delivery_stage"
    });
    return ok(json, { ok: true, ...result }, [
      `delivery stage: ${result.evidence.label}`,
      result.event.message
    ]);
  } finally {
    storage.close();
  }
}

function deliveryHelpResult(json: boolean): CliResult {
  const substages = workflowEvidenceSubstageHelp();
  return ok(json, {
    ok: true,
    usage: commandHelpUsage("delivery"),
    stages: WORKFLOW_STAGE_IDS,
    statuses: DELIVERY_STAGE_STATUSES,
    substages
  }, [
    "Usage: agent-loop delivery bind --issue N --title \"...\" --url https://github.com/OWNER/REPO/issues/N [--branch BRANCH] [--run RUN_ID]",
    `Usage: agent-loop delivery stage --run RUN_ID --stage STAGE --status ${DELIVERY_STAGE_STATUSES.join("|")} --summary "..." [--substage ID] [--actor codex] [--ref URL]`,
    `Stages: ${WORKFLOW_STAGE_IDS.join(", ")}`,
    "Substages:",
    ...substages.map((entry) => `  ${entry.stage}: ${entry.substages.join(", ")}`)
  ]);
}

function installHooks(repoRoot: string, json: boolean, localeOverride: LocaleSetting | undefined): CliResult {
  const locale = localeForRepo(repoRoot, localeOverride);
  const packageRoot = defaultPackageRoot();
  buildHookDist(packageRoot);
  const install = installRouterHooks(packageRoot);
  const binding = upsertHookBinding({ repoRoot });
  return ok(json, {
    ok: true,
    hooksPath: install.hooksPath,
    registryPath: hookRegistryPath(),
    binding,
    removedLegacyCommands: install.removedLegacyCommands
  }, [
    cliText(locale, "hooksInstalled"),
    `${cliText(locale, "hooks")}: ${install.hooksPath}`,
    `hook binding: ${binding.id}`
  ]);
}

function hooks(repoRoot: string, args: string[], json: boolean, localeOverride: LocaleSetting | undefined): CliResult {
  const subcommand = args[1];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return ok(json, {
      ok: true,
      usage: commandHelpUsage("hooks"),
      commands: ["install-router", "bind", "list", "doctor", "unbind"]
    }, [
      `Usage: ${commandHelpUsage("hooks")}`,
      "Commands: install-router, bind, list, doctor, unbind"
    ]);
  }
  const packageRoot = defaultPackageRoot();
  if (subcommand === "install-router") {
    buildHookDist(packageRoot);
    const install = installRouterHooks(packageRoot);
    return ok(json, { ok: true, ...install }, [
      "agent-loop hook router installed",
      `hooks: ${install.hooksPath}`
    ]);
  }
  if (subcommand === "bind") {
    const binding = upsertHookBinding({
      repoRoot,
      ...optionalCliValue(args, "--run", "runId"),
      ...optionalCliValue(args, "--session", "sessionId")
    });
    return ok(json, { ok: true, binding, registryPath: hookRegistryPath() }, [
      `hook binding: ${binding.id}`,
      `repo: ${binding.repoRoot}`
    ]);
  }
  if (subcommand === "list") {
    const bindings = listHookBindings();
    return ok(json, { ok: true, registryPath: hookRegistryPath(), bindings }, bindings.length > 0
      ? bindings.map((binding) => `${binding.status}: ${binding.repoRoot}${binding.sessionIdHash ? ` sessionHash=${binding.sessionIdHash.slice(0, 12)}` : ""}`)
      : ["no agent-loop hook bindings"]);
  }
  if (subcommand === "doctor") {
    const report = hookInstallReport(repoRoot, packageRoot);
    return ok(json, { ok: true, ...report }, [
      report.routerInstalled ? "hook router installed" : "hook router missing",
      `active bindings: ${report.activeBindings}`,
      `legacy entries: ${report.legacyCommands.length}`,
      `old private repo hook refs: ${report.legacyPrivateRepoCommands.length}`,
      `bundled hooks config: ${report.bundledHooksConfig.valid ? "valid" : "invalid"}`,
      `binary old private repo refs: ${report.agentLoopBinary.legacyPrivateRepoReferences.length}`,
      `hook capture: ${report.hookCapture.status} - ${report.hookCapture.reason}`
    ]);
  }
  if (subcommand === "unbind") {
    const removed = removeHookBinding({
      repoRoot,
      ...optionalCliValue(args, "--session", "sessionId")
    });
    return ok(json, { ok: true, removed, registryPath: hookRegistryPath() }, [
      `removed hook bindings: ${removed.length}`
    ]);
  }
  throw new AgentLoopError("unknown_command", `Unknown hooks command: ${subcommand}`);
}

function local(repoRoot: string, args: string[], json: boolean): CliResult {
  const subcommand = args[1];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return localHelpResult(json);
  }
  if (subcommand === "install") {
    const result = installLocalAgentLoop({
      repoRoot,
      allowDirty: args.includes("--allow-dirty")
    });
    return ok(json, result, [
      "agent-loop local install complete",
      `snapshot: ${result.snapshotPath}`,
      `rollback: ${result.rollbackCommand}`,
      `router installed: ${result.localDoctor.hooks.routerInstalled}`,
      `current repo bindings: ${result.localDoctor.bindings.currentRepoBindings}`
    ]);
  }
  if (subcommand === "rollback") {
    const snapshotPath = optionArg(args, "--snapshot");
    if (!snapshotPath) {
      throw new AgentLoopError("invalid_config", "local rollback requires --snapshot PATH.");
    }
    const result = rollbackLocalAgentLoop({ snapshotPath });
    return ok(json, result, [
      "agent-loop local rollback complete",
      `snapshot: ${result.snapshotPath}`,
      `restored: ${result.restored.length}`,
      `removed: ${result.removed.length}`,
      ...result.warnings
    ]);
  }
  if (subcommand === "doctor") {
    const result = inspectLocalInstall({ repoRoot });
    return ok(json, result, [
      "agent-loop local doctor",
      `binary: ${result.binary.path ?? "not found"}`,
      `binary points to expected package: ${result.binary.pointsToExpectedPackage ? "yes" : "no"}`,
      `binary old private repo refs: ${result.binary.legacyPrivateRepoReferences.length}`,
      `bundled hooks config: ${result.hooks.bundledHooksConfig.valid ? "valid" : "invalid"}`,
      `router installed: ${result.hooks.routerInstalled}`,
      `router points to expected dist: ${result.hooks.routerCommandsPointToExpectedDist ? "yes" : "no"}`,
      `legacy entries: ${result.hooks.legacyCommands.length}`,
      `old private repo hook refs: ${result.hooks.legacyPrivateRepoCommands.length}`,
      `current repo bindings: ${result.bindings.currentRepoBindings}`,
      `stale/missing path bindings: ${result.bindings.staleOrMissingPathBindings}`,
      `temp path bindings: ${result.bindings.tempPathBindings}`,
      `registry lock: ${result.bindings.lock.exists ? result.bindings.lock.stale ? "stale" : "active" : "none"}`,
      `self-link pollution: ${result.selfLinkPollution.clean ? "clean" : result.selfLinkPollution.files.join(", ")}`
    ]);
  }
  if (subcommand === "snapshots") {
    if (args[2] === "prune") {
      const keep = parsePositiveIntOption(args, "--keep", "local snapshots prune requires --keep with a positive integer.");
      const result = pruneLocalInstallSnapshots({ keep, apply: args.includes("--apply") });
      return ok(json, result, [
        `snapshot prune: ${result.apply ? "applied" : "dry-run"}`,
        `keep: ${result.keep}`,
        `candidates: ${result.candidates.length}`,
        ...result.candidates.map((snapshot) => `candidate: ${snapshot.path}`),
        `deleted: ${result.deleted.length}`,
        ...result.deleted.map((path) => `deleted: ${path}`),
        ...result.warnings
      ]);
    }
    if (args.includes("--keep") || args.includes("--apply")) {
      throw new AgentLoopError("invalid_config", "Use `agent-loop local snapshots prune --keep N [--apply]` to prune snapshots.");
    }
    const result = listLocalInstallSnapshots();
    return ok(json, result, [
      `snapshots: ${result.snapshots.length}`,
      ...result.snapshots.map((snapshot) => snapshot.invalid ? `${snapshot.path} (invalid: ${snapshot.error ?? "unknown error"})` : snapshot.path)
    ]);
  }
  throw new AgentLoopError("unknown_command", `Unknown local command: ${subcommand}`);
}

function localHelpResult(json: boolean, subcommand?: string, nested?: string): CliResult {
  const usages: Record<string, string> = {
    install: "agent-loop local install --repo /path/to/repo [--allow-dirty] [--json]",
    rollback: "agent-loop local rollback --snapshot /path/to/snapshot [--json]",
    doctor: "agent-loop local doctor [--repo /path/to/repo] [--json]",
    snapshots: "agent-loop local snapshots [--json]",
    "snapshots prune": "agent-loop local snapshots prune --keep N [--apply] [--json]"
  };
  const usageKey = subcommand === "snapshots" && nested === "prune" ? "snapshots prune" : subcommand;
  const usage = usageKey && usages[usageKey] ? usages[usageKey] : commandHelpUsage("local") ?? "agent-loop local <command>";
  return ok(json, {
    ok: true,
    usage,
    commands: ["install", "rollback", "doctor", "snapshots", "snapshots prune"]
  }, [
    `Usage: ${usage}`,
    "Commands: install, rollback, doctor, snapshots, snapshots prune"
  ]);
}

function installRouterHooks(packageRoot: string): { hooksPath: string; removedLegacyCommands: string[] } {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const hooksPath = join(codexHome, "hooks.json");
  const existing = readJsonObjectIfExists(hooksPath);
  const { next, removedLegacyCommands } = mergeRouterHooks(existing, agentLoopRouterHookEntries(packageRoot));
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify(next, null, 2)}\n`);
  return { hooksPath, removedLegacyCommands };
}

function buildHookDist(pluginRootPath: string): void {
  const hookSource = join(hookSourceRoot(pluginRootPath), "pre-tool-use.ts");
  const distScripts = agentLoopHookDistScripts(pluginRootPath);
  const distReady = distScripts.every((script) => existsSync(script));
  if (distReady && !existsSync(join(pluginRootPath, "pnpm-lock.yaml"))) {
    return;
  }
  if (!existsSync(hookSource)) {
    if (distReady) {
      return;
    }
    throw new AgentLoopError("required_tool_unavailable", "agent-loop hook sources are missing in this repository.", {
      details: { hookSource },
      exitCode: 2
    });
  }
  try {
    execFileSync("pnpm", ["build:hooks"], {
      cwd: pluginRootPath,
      stdio: "pipe",
      encoding: "utf8"
    });
  } catch (error) {
    throw new AgentLoopError("required_tool_unavailable", "Failed to build agent-loop hook runners before installing hooks.", {
      details: {
        cause: error instanceof Error ? error.message : String(error)
      },
      exitCode: 2
    });
  }
}

function agentLoopHookDistScripts(pluginRootPath: string): string[] {
  const distRoot = join(hookSourceRoot(pluginRootPath), "dist");
  return Object.values(agentLoopRouterHookEntries(pluginRootPath))
    .flatMap(collectHookCommands)
    .map((command) => command.match(/node '([^']+)'/)?.[1])
    .filter((script): script is string => typeof script === "string" && script.startsWith(distRoot));
}

function approveGate(repoRoot: string, args: string[], json: boolean, localeOverride: LocaleSetting | undefined): CliResult {
  const locale = localeForRepo(repoRoot, localeOverride);
  const gateId = args[1];
  const note = optionArg(args, "--note");
  const nextState = optionArg(args, "--next-state");
  if (!gateId) {
    throw new AgentLoopError("unknown_command", "Usage: agent-loop approve-gate <gate-id> --note \"...\" [--next-state STATE]");
  }
  if (!note || note.trim().length === 0) {
    throw new AgentLoopError("invalid_config", "approve-gate requires --note.");
  }
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const gate = storage.decideGate(gateId, "approved", note);
    const runId = gate.runId ?? storage.getCurrentRun()?.id;
    if (runId) {
      storage.appendDecision({
        runId,
        kind: "gate_approved",
        message: `Approved gate ${gate.id}.`,
        details: {
          gateId: gate.id,
          gateKind: gate.kind,
          state: gateState(gate.details),
          note,
          source: "cli",
          payload: nextState ? { nextState } : {},
          gateDetails: gate.details
        }
      });
    }
    return ok(json, { ok: true, gate }, [
      `${cliText(locale, "approvedGate")}: ${gate.id}`,
      `${cliText(locale, "note")}: ${note}`
    ]);
  } finally {
    storage.close();
  }
}

function gateState(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const state = (details as { state?: unknown }).state;
  return typeof state === "string" ? state : undefined;
}

async function dashboard(repoRoot: string, args: string[], json: boolean, localeOverride: LocaleSetting | undefined): Promise<CliResult> {
  if (args.includes("--help") || args.includes("-h")) {
    const locale = helpLocale(localeOverride);
    return ok(json, {
      ok: true,
      usage: "agent-loop dashboard [--host 127.0.0.1] [--port 0] [--json]"
    }, [
      "Usage: agent-loop dashboard [--host 127.0.0.1] [--port 0]",
      cliText(locale, "dashboardHelp")
    ]);
  }
  const repoLocale = localeForRepo(repoRoot, localeOverride);
  const host = optionArg(args, "--host");
  const portValue = optionArg(args, "--port");
  let parsedPort: number | undefined;
  if (portValue !== undefined) {
    const candidate = Number(portValue);
    if (!Number.isInteger(candidate) || candidate < 0 || candidate > 65_535) {
      throw new AgentLoopError("invalid_config", "dashboard --port must be an integer from 0 to 65535.");
    }
    parsedPort = candidate;
  }
  const server = await startDashboardServer({
    repoRoot,
    targetRepoRoot: repoRoot,
    pluginRoot: defaultPackageRoot(),
    ...(host ? { host } : {}),
    ...(parsedPort !== undefined ? { port: parsedPort } : {})
  });
  const stdout = json
    ? `${JSON.stringify({ ok: true, url: server.url, host: server.host, port: server.port, loopbackOnly: true, targetRepoRoot: repoRoot }, null, 2)}\n`
    : `${[cliText(repoLocale, "dashboardStarted"), `${cliText(repoLocale, "url")}: ${server.url}`, `targetRepoRoot: ${repoRoot}`].join("\n")}\n`;
  return {
    exitCode: 0,
    stdout,
    stderr: `dashboard token: ${server.token}\n# do not log or redirect this token\n`
  };
}

function inferConfig(repoRoot: string, remote: string): AgentLoopConfig {
  const scripts = readPackageScripts(repoRoot);
  const runner = detectPackageRunner(repoRoot);
  const input: Parameters<typeof withConfigDefaults>[0] = {
    repoId: parseGitHubRepoId(remote)
  };
  if (scripts.has("lint")) {
    input.lintCommand = `${runner} lint`;
  }
  if (scripts.has("test")) {
    input.testCommand = `${runner} test`;
  }
  return withConfigDefaults(input);
}

function readPackageScripts(repoRoot: string): Set<string> {
  const packagePath = join(repoRoot, "package.json");
  if (!existsSync(packagePath)) {
    return new Set();
  }
  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
  return new Set(Object.keys(parsed.scripts ?? {}));
}

function ensureAgentLoopGitignore(repoRoot: string): void {
  const path = join(repoRoot, ".gitignore");
  const entry = ".agent-loop/";
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry)) {
    return;
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${prefix}${entry}\n`);
}

function parseGitHubRepoId(remote: string): string {
  const normalized = remote.trim().replace(/\.git$/, "");
  const sshMatch = /github\.com[:/]([^/]+\/[^/]+)$/.exec(normalized);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }
  throw new AgentLoopError("unsupported_remote", "Could not parse GitHub owner/repo from origin.", {
    details: { remote: redactRemote(remote) },
    exitCode: 2
  });
}

function detectPackageRunner(repoRoot: string): "pnpm" | "npm" | "yarn" | "bun" {
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(repoRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync(join(repoRoot, "package-lock.json")) || existsSync(join(repoRoot, "npm-shrinkwrap.json"))) {
    return "npm";
  }
  return "pnpm";
}

function readJsonObjectIfExists(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function mergeHooks(existing: Record<string, unknown>, additions: Record<string, unknown[]>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const [event, entries] of Object.entries(additions)) {
    const current = normalizeHookEntries(next[event]);
    const commands = new Set(current.flatMap((entry) => hookCommands(entry)));
    for (const entry of entries) {
      const duplicate = hookCommands(entry).some((command) => commands.has(command));
      if (!duplicate) {
        current.push(entry);
        for (const command of hookCommands(entry)) {
          commands.add(command);
        }
      }
    }
    next[event] = current;
  }
  return next;
}

function mergeRouterHooks(existing: Record<string, unknown>, additions: Record<string, unknown[]>): { next: Record<string, unknown>; removedLegacyCommands: string[] } {
  const next: Record<string, unknown> = { ...existing };
  const rootHooks = typeof next.hooks === "object" && next.hooks !== null && !Array.isArray(next.hooks)
    ? { ...(next.hooks as Record<string, unknown>) }
    : {};
  const removedLegacyCommands: string[] = [];

  for (const event of new Set([...Object.keys(additions), ...Object.keys(rootHooks)])) {
    const rootCurrent = normalizeHookEntries(rootHooks[event]);
    const topCurrent = event === "hooks" ? [] : normalizeHookEntries(next[event]);
    const filteredRoot = filterManagedAgentLoopEntries(rootCurrent, removedLegacyCommands);
    const filteredTop = filterManagedAgentLoopEntries(topCurrent, removedLegacyCommands);

    if (event in additions) {
      const current = [...filteredRoot];
      const commands = new Set(current.flatMap((entry) => hookCommands(entry)));
      for (const entry of additions[event] ?? []) {
        const duplicate = hookCommands(entry).some((command) => commands.has(command));
        if (!duplicate) {
          current.push(entry);
          for (const command of hookCommands(entry)) {
            commands.add(command);
          }
        }
      }
      rootHooks[event] = current;
    } else if (filteredRoot.length > 0) {
      rootHooks[event] = filteredRoot;
    } else {
      delete rootHooks[event];
    }

    if (event !== "hooks") {
      if (filteredTop.length > 0) {
        next[event] = filteredTop;
      } else if (topCurrent.length > 0) {
        delete next[event];
      }
    }
  }

  next.hooks = rootHooks;
  return { next, removedLegacyCommands };
}

function filterManagedAgentLoopEntries(entries: unknown[], removedLegacyCommands: string[]): unknown[] {
  return entries
    .map((entry) => filterHookEntry(entry, removedLegacyCommands))
    .filter((entry): entry is unknown => entry !== undefined);
}

function filterHookEntry(entry: unknown, removedLegacyCommands: string[]): unknown | undefined {
  if (typeof entry !== "object" || entry === null || !("hooks" in entry) || !Array.isArray((entry as { hooks?: unknown }).hooks)) {
    return entry;
  }
  const hooks = (entry as { hooks: unknown[] }).hooks.filter((hook) => {
    const command = typeof hook === "object" && hook !== null && "command" in hook ? (hook as { command?: unknown }).command : undefined;
    if (typeof command !== "string" || !isAgentLoopHookCommand(command)) {
      return true;
    }
    if (isLegacyAgentLoopHookCommand(command)) {
      removedLegacyCommands.push(command);
    }
    return false;
  });
  return hooks.length > 0 ? { ...entry, hooks } : undefined;
}

function hookInstallReport(repoRoot: string, packageRoot: string): {
  hooksPath: string;
  registryPath: string;
  routerInstalled: boolean;
  missingRouterEvents: string[];
  legacyCommands: string[];
  legacyPrivateRepoCommands: string[];
  bundledHooksConfig: BundledHooksConfigInspection;
  agentLoopBinary: AgentLoopBinaryInspection;
  activeBindings: number;
  currentRepoBindings: number;
  lock: ReturnType<typeof inspectHookRegistryLock>;
  hooksJsonError?: string;
  registryError?: string;
  hookCapture: ReturnType<typeof inspectHookCapture>;
} {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const hooksPath = join(codexHome, "hooks.json");
  let existing: Record<string, unknown>;
  let hooksJsonError: string | undefined;
  try {
    existing = readJsonObjectIfExists(hooksPath);
  } catch (error) {
    existing = {};
    hooksJsonError = error instanceof Error ? error.message : String(error);
  }
  const commands = collectHookCommands(existing);
  const routerEntries = agentLoopRouterHookEntries(packageRoot);
  const missingRouterEvents = Object.entries(routerEntries)
    .filter(([, entries]) => !entries.some((entry) => hookCommands(entry).every((command) => commands.includes(command))))
    .map(([event]) => event);
  const legacyCommands = commands.filter(isLegacyAgentLoopHookCommand).map(redactDiagnosticText);
  const legacyPrivateRepoCommands = commandsReferencingLegacyPrivateRepo(commands);
  const bundledHooksConfig = inspectBundledHooksConfig(packageRoot);
  const agentLoopBinary = inspectAgentLoopBinary(packageRoot);
  let bindings: ReturnType<typeof listHookBindings>;
  let registryError: string | undefined;
  try {
    bindings = listHookBindings(codexHome);
  } catch (error) {
    bindings = [];
    registryError = error instanceof Error ? error.message : String(error);
  }
  const activeBindings = bindings.filter((binding) => binding.status === "active").length;
  const currentRepoBindings = bindings.filter((binding) => binding.status === "active" && binding.repoRoot === repoRoot).length;
  const lock = inspectHookRegistryLock(codexHome);
  const hookCapture = inspectHookCapture(repoRoot, codexHome);
  return {
    hooksPath,
    registryPath: hookRegistryPath(codexHome),
    routerInstalled: hooksJsonError === undefined && missingRouterEvents.length === 0,
    missingRouterEvents,
    legacyCommands,
    legacyPrivateRepoCommands,
    bundledHooksConfig,
    agentLoopBinary,
    activeBindings,
    currentRepoBindings,
    lock,
    hookCapture,
    ...(hooksJsonError ? { hooksJsonError } : {}),
    ...(registryError ? { registryError } : {})
  };
}

function normalizeHookEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (typeof value === "object" && value !== null) {
    return [value];
  }
  return [];
}

function hookCommands(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null || !("hooks" in entry) || !Array.isArray((entry as { hooks?: unknown }).hooks)) {
    return [];
  }
  return ((entry as { hooks: unknown[] }).hooks)
    .map((hook) => typeof hook === "object" && hook !== null && "command" in hook ? (hook as { command?: unknown }).command : undefined)
    .filter((command): command is string => typeof command === "string");
}

function stripRepoArgs(args: string[], cwd: string): { filtered: string[]; targetPath: string } {
  const filtered: string[] = [];
  let repoArg: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new AgentLoopError("invalid_config", "--repo requires a path.");
      }
      if (repoArg !== undefined) {
        throw new AgentLoopError("invalid_config", "--repo may only be provided once.");
      }
      repoArg = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length);
      if (!value) {
        throw new AgentLoopError("invalid_config", "--repo requires a path.");
      }
      if (repoArg !== undefined) {
        throw new AgentLoopError("invalid_config", "--repo may only be provided once.");
      }
      repoArg = value;
      continue;
    }
    filtered.push(arg);
  }
  return {
    filtered,
    targetPath: repoArg ? resolve(cwd, repoArg) : cwd
  };
}

function optionArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parsePositiveIntOption(args: string[], name: string, message: string): number {
  const value = optionArg(args, name);
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AgentLoopError("invalid_config", message);
  }
  return parsed;
}

function optionArgs(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      values.push(args[index + 1]!);
      index += 1;
    }
  }
  return values;
}

function optionalCliValue<K extends string>(args: string[], option: string, key: K): Partial<Record<K, string>> {
  const value = optionArg(args, option);
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, string>>;
}

function numberOption(args: string[], name: string, message: string): { limit?: number } {
  const value = optionArg(args, name);
  if (value === undefined) {
    return {};
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AgentLoopError("invalid_config", message);
  }
  return { limit: parsed };
}

function stringOption(args: string[], name: string, key: "cursor" | "runId" | "workerId"): Record<string, string> {
  const value = optionArg(args, name);
  return value ? { [key]: value } : {};
}

function parseTimelineSource(value: string): AgentTimelineSource {
  const sources = new Set(["event", "worker_event", "worker", "state", "gate", "artifact", "decision"]);
  if (!sources.has(value)) {
    throw new AgentLoopError("invalid_config", "timeline --source must be event, worker_event, worker, state, gate, artifact, or decision.");
  }
  return value as AgentTimelineSource;
}

function parseAuditFormat(value: string): "markdown" | "json" {
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new AgentLoopError("invalid_config", "audit-export --format must be markdown or json.");
}

function controllerResult(json: boolean, result: McpResult, lines: (data: Record<string, unknown>) => Array<string | undefined>): CliResult {
  if (!result.ok || !result.data) {
    const error = result.error ?? toErrorPayload(new AgentLoopError("storage_error", "Controller command failed."));
    return {
      exitCode: isGateCode(error.code as AgentLoopErrorCode) ? 2 : 1,
      stdout: json ? `${JSON.stringify({ ok: false, error }, null, 2)}\n` : "",
      stderr: json ? "" : `${error.code}: ${error.message}\n`
    };
  }
  const payload = { ok: true, ...(result.data as Record<string, unknown>) };
  return {
    exitCode: 0,
    stdout: json ? `${JSON.stringify(payload, null, 2)}\n` : `${lines(result.data as Record<string, unknown>).filter(Boolean).join("\n")}\n`,
    stderr: ""
  };
}

function getCurrentBranch(repoRoot: string): string {
  try {
    const branch = git(repoRoot, ["branch", "--show-current"]);
    if (branch) {
      return branch;
    }
  } catch {
    // Fall through to symbolic-ref for unborn repositories.
  }
  return git(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function ok(json: boolean, payload: unknown, lines: Array<string | undefined>): CliResult {
  return {
    exitCode: 0,
    stdout: json ? `${JSON.stringify(payload, null, 2)}\n` : `${lines.filter(Boolean).join("\n")}\n`,
    stderr: ""
  };
}

function formatSafeErrorDetails(details: unknown): string {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return "";
  }
  const record = details as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof record.snapshotPath === "string") {
    lines.push(`snapshot: ${record.snapshotPath}`);
  }
  if (typeof record.rollbackCommand === "string") {
    lines.push(`rollback: ${record.rollbackCommand}`);
  }
  if (Array.isArray(record.manifestChanges) && record.manifestChanges.every((value) => typeof value === "string")) {
    lines.push(`manifest changes: ${record.manifestChanges.join(", ")}`);
  }
  if (Array.isArray(record.preservedBrokenFiles) && record.preservedBrokenFiles.every((value) => typeof value === "string")) {
    lines.push(`preserved broken files: ${record.preservedBrokenFiles.join(", ")}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function stateResult(json: boolean, result: StateMachineResult, locale: EffectiveLocale, options: { jsonStoppedOk?: boolean } = {}): CliResult {
  const exitCode: 0 | 1 | 2 = result.status === "BLOCKED" || result.status === "STOPPED" ? 2 : 0;
  if (json) {
    const jsonExitCode = result.gate || (result.status === "STOPPED" && !options.jsonStoppedOk) ? 2 : 0;
    return { exitCode: jsonExitCode, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "" };
  }
  return {
    exitCode,
    stdout: `${[
      `${cliText(locale, "status")}: ${result.status}`,
      result.currentState ? `${cliText(locale, "state")}: ${result.currentState}` : undefined,
      result.runId ? `${cliText(locale, "runId")}: ${result.runId}` : undefined,
      ...result.transitions.map((transition) => `${transition.from} -> ${transition.to}`),
      result.gate ? `${cliText(locale, "gate")}: ${result.gate.kind} - ${result.gate.message}` : undefined
    ]
      .filter(Boolean)
      .join("\n")}\n`,
    stderr: ""
  };
}

function formatDoctor(report: DoctorReport, locale: EffectiveLocale): string {
  const lines = [`${cliText(locale, "doctor")}: ${report.status}`];
  if (report.gate) {
    lines.push(`${cliText(locale, "gate")}: ${report.gate}`);
  }
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.name}: ${check.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseCliLocale(args: string[]): LocaleSetting | undefined {
  const hasLocale = args.includes("--locale");
  const locale = parseLocaleOverride(args);
  if (hasLocale && locale === undefined) {
    throw new AgentLoopError("invalid_config", "--locale must be zh-CN, en-US, or system.");
  }
  return locale;
}

function localeForRepo(repoRoot: string, override: LocaleSetting | undefined): EffectiveLocale {
  try {
    return resolveCliLocale(override, loadConfig(repoRoot).config.locale);
  } catch (error) {
    if (error instanceof AgentLoopError && error.code === "needs_repo_init") {
      return resolveCliLocale(override, undefined);
    }
    throw error;
  }
}

function helpLocale(override: LocaleSetting | undefined): EffectiveLocale {
  return resolveCliLocale(override, undefined);
}
