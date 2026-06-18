import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { readArtifact } from "./artifacts.js";
import { describeAutonomyPosture, evaluateMergeReadiness, type MergeReadiness } from "./autonomy-policy.js";
import { readConfigForEdit, saveConfigEdit } from "./config-editor.js";
import { isRecord, loadConfig, statePath } from "./config.js";
import { AgentLoopError, toErrorPayload } from "./errors.js";
import { recoverBlockedRun, TERMINAL_WORKER_GATE_KINDS } from "./gate-recovery.js";
import { detectHappy } from "./happy.js";
import { inspectHookCapture } from "./hook-capture.js";
import { resolveLoopShape } from "./loop-shapes.js";
import { deriveNotifications, type LoopNotification } from "./notification-feed.js";
import { resolvePrSelection, type PrSelection } from "./pr-selector.js";
import { applyProfileConfig, resolveProfile, workflowStages } from "./profiles.js";
import { redactSecrets } from "./redaction.js";
import { blockRunForTerminalWorker, runStateMachine, resumeStateMachine, stopStateMachine } from "./state-machine.js";
import { SqliteAgentLoopStorage } from "./storage.js";
import { executeWorker } from "./worker.js";
import { getDeliveryWorkItem, WORKFLOW_STAGE_EVIDENCE_KIND } from "./delivery-work-item.js";
import { appendWorkflowEvidence, deriveWorkflowBoard, selectWorkflowBoardRun } from "./workflow-board.js";
import type { AgentLoopConfig, AgentLoopEvent, AgentLoopGate, AgentLoopRun, AgentTimelineQuery, AgentTimelineEntry, GateDecisionInput, WorkerRun, WorkerType } from "./types.js";
import type { AgentLoopState } from "./state-types.js";

const NOTIFICATION_EVENT_LIMIT = 100;
const HISTORICAL_EVENT_SCAN_LIMIT = 100_000;
const HISTORICAL_EVENT_KIND = "historical_gate_marked_handled";
const HISTORICAL_REEVALUATED_EVENT_KIND = "historical_gate_re_evaluated";

type HistoricalGateReevaluationResult =
  | "still_historical"
  | "overridden_by_current_reality"
  | "active_again"
  | "manually_handled";

export interface McpControllerOptions {
  repoRoot: string;
  startRun?: (repoRoot: string, runId: string) => boolean | void;
  mcpToken?: string;
}

export interface McpResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: ReturnType<typeof toErrorPayload>;
  gate?: string;
}

/** Shared control-plane API used by MCP tools and CLI gate commands. */
export class McpController {
  constructor(private readonly options: McpControllerOptions) {}

  loopStatus(): McpResult {
    return this.withConfig(() => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      const current = storage.getCurrentStatus();
      return ok({ ...current, nextAction: nextAction(current.status, current.gate?.kind) });
    }));
  }

  loopMissionControl(): McpResult {
    return this.withConfig((config) => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      const snapshot = storage.readTransaction(() => {
        const current = storage.getCurrentStatus();
        const run = current.run ?? storage.getCurrentRun();
        const events = storage.listEvents(NOTIFICATION_EVENT_LIMIT);
        const historicalEvents = storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT);
        const runs = storage.listRuns(20);
        const dismissedHistoricalGateIds = historicalGateHandledIds(historicalEvents);
        const gates = annotateGates({
          gates: storage.listGates(),
          current,
          ...(run ? { run } : {}),
          runs,
          dismissedHistoricalGateIds
        });
        const activeGates = gates.filter((gate) => gate.activity === "active");
        const currentRunGates = gates.filter((gate) => gate.activity === "active" && (gate.runId === run?.id || gate.runId === undefined));
        const missionCurrent = currentForMissionControl(current, gates);
        const effectiveConfig = applyProfileConfig(config);
        const shape = resolveLoopShape(effectiveConfig.loopShape);
        const ci = shape.id === "pr-loop" && run ? storage.listCiChecks(run.id) : [];
        const reviewComments = shape.id === "pr-loop" && run ? storage.listReviewComments(run.id) : [];
        const decisions = shape.id === "pr-loop" && run ? storage.listDecisions(run.id) : [];
        const runChecks = shape.id === "pr-loop" && run ? storage.listRunChecks(run.id) : [];
        const deliveryWorkItem = getDeliveryWorkItem(storage, run?.id);
        const selection = shape.id === "pr-loop" ? resolvePrSelection(this.options.repoRoot, effectiveConfig, {
          ...(deliveryWorkItem ? { workItem: deliveryWorkItem } : {})
        }) : undefined;
        const workers = annotateWorkers({
          workers: storage.listWorkers(undefined, 20),
          gates,
          ...(run ? { run } : {})
        });
        const activeWorkers = workers.filter((worker) => worker.activity === "active");
        const timeline = storage.listAgentTimeline({
          limit: 20,
          ...(run ? { runId: run.id } : {})
        }).entries;
        const mergeReadiness = shape.id === "pr-loop" ? evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates: currentRunGates, decisions, runChecks }) : undefined;
        const missionMergeReadiness = mergeReadiness ? mergeReadinessForMissionDisplay(mergeReadiness, events) : undefined;
        const dismissedIds = notificationDismissedIds(events);
        const notifications = deriveNotifications({ config: effectiveConfig, events, gates: activeGates, timelineEntries: timeline, workers: activeWorkers, ...(mergeReadiness ? { mergeReadiness } : {}), ...(run ? { runId: run.id } : {}), now: new Date(), dismissedIds });
        return {
          current: { ...missionCurrent, nextAction: nextAction(missionCurrent.status, missionCurrent.gate?.kind) },
          gates,
          pr: shape.id === "pr-loop" && run ? storage.getPrLink(run.id) : undefined,
          ci: shape.id === "pr-loop" ? ci : [],
          reviewComments: shape.id === "pr-loop" ? reviewComments : [],
          workers,
          artifacts: run ? storage.listArtifacts(run.id) : [],
          events,
          decisions,
          timelineSummary: buildTimelineSummary({
            timeline,
            workers,
            ...(run ? { currentRunId: run.id } : {}),
            listWorkerEvents: (workerId) => storage.listWorkerEvents(workerId)
          }),
          autonomy: describeAutonomyPosture(effectiveConfig),
          mergeReadiness: missionMergeReadiness,
          notifications,
          profile: resolveProfile(effectiveConfig, run?.currentState as AgentLoopState | undefined),
          plan: selection?.plan,
          selection: selection ? selectionSummary(selection) : genericSelectionSummary(effectiveConfig),
          recoveryWarnings: recoveryWarnings(missionCurrent.gate?.kind, gates, workers)
        };
      });
      return ok(snapshot);
    }));
  }

  loopWorkflowBoard(input: { runId?: string } = {}): McpResult {
    return this.withConfig((config) => this.withStorageReadOnly((storage) => storage.readTransaction(() => {
      const effectiveConfig = applyProfileConfig(config);
      const run = selectWorkflowBoardRun(storage, input.runId);
      const currentRun = storage.getCurrentRun();
      const deliveryWorkItem = getDeliveryWorkItem(storage, run?.id);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      const gates = run ? storage.listGates(run.id) : storage.listGates();
      const ci = shape.id === "pr-loop" && run ? storage.listCiChecks(run.id) : [];
      const reviewComments = shape.id === "pr-loop" && run ? storage.listReviewComments(run.id) : [];
      const decisions = shape.id === "pr-loop" && run ? storage.listDecisions(run.id) : [];
      const runChecks = shape.id === "pr-loop" && run ? storage.listRunChecks(run.id) : [];
      const mergeReadiness = shape.id === "pr-loop" && run
        ? evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates, decisions, runChecks })
        : undefined;
      return ok(deriveWorkflowBoard({
        config: effectiveConfig,
        ...(run ? { run } : {}),
        ...(currentRun ? { currentRun } : {}),
        gates,
        events: storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT).filter((event) => !run || event.runId === run.id || event.runId === undefined),
        workers: run ? storage.listWorkers(run.id, 20) : [],
        artifacts: run ? storage.listArtifacts(run.id) : [],
        pr: run && shape.id === "pr-loop" ? storage.getPrLink(run.id) : undefined,
        ci,
        reviewComments,
        decisions,
        runChecks,
        ...(deliveryWorkItem ? { deliveryWorkItem } : {}),
        ...(mergeReadiness ? { mergeReadiness } : {}),
        hookCapture: inspectHookCapture(this.options.repoRoot)
      }));
    })));
  }

  loopAppendWorkflowEvidence(body: unknown, token?: string): McpResult {
    const auth = this.requireToken(token);
    if (auth) return auth;
    if (!isRecord(body)) {
      return fail(new AgentLoopError("invalid_config", "Workflow evidence append requires a JSON object."));
    }
    return this.withConfig(() => this.withStorage((storage) => ok(appendWorkflowEvidence(storage, {
      runId: typeof body.runId === "string" ? body.runId : undefined,
      stageId: typeof body.stageId === "string" ? body.stageId : undefined,
      substageId: typeof body.substageId === "string" ? body.substageId : undefined,
      summary: typeof body.summary === "string" ? body.summary : undefined,
      evidenceRefIds: body.evidenceRefIds,
      artifactIds: body.artifactIds,
      actor: typeof body.actor === "string" ? body.actor : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
      source: typeof body.source === "string" ? body.source : "dashboard",
      review: body.review
    }))));
  }

  loopAgentTimeline(query: AgentTimelineQuery = {}): McpResult {
    return this.withConfig(() => this.withStorageReadOnly((storage) => ok(storage.listAgentTimeline(query))));
  }

  loopObserve(limit = 20): McpResult {
    return this.withConfig((config) => this.withStorageReadOnly((storage) => storage.readTransaction(() => {
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const timeline = storage.listAgentTimeline({
        limit,
        ...(run ? { runId: run.id } : {})
      });
      return ok({
        dashboard: dashboardInfo(config),
        happy: detectHappy(),
        current: { ...current, nextAction: nextAction(current.status, current.gate?.kind) },
        timeline
      });
    })));
  }

  loopNextAction(): McpResult {
    return this.withConfig(() => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      const current = storage.getCurrentStatus();
      return ok({ nextAction: nextAction(current.status, current.gate?.kind), current });
    }));
  }

  loopStep(token?: string): Promise<McpResult> {
    const auth = this.requireToken(token);
    if (auth) return Promise.resolve(auth);
    return this.withConfigAsync(async () => ok(await runStateMachine({
      repoRoot: this.options.repoRoot,
      dryRun: false,
      untilGate: false,
      singleStep: true
    })));
  }

  loopResume(token?: string): Promise<McpResult> {
    const auth = this.requireToken(token);
    if (auth) return Promise.resolve(auth);
    return this.withConfigAsync(async () => ok(await resumeStateMachine(this.options.repoRoot)));
  }

  loopStop(token?: string): McpResult {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig(() => ok(stopStateMachine(this.options.repoRoot)));
  }

  loopRunUntilGate(token?: string): McpResult {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig((config) => this.withStorage((storage) => {
      const effectiveConfig = applyProfileConfig(config);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      const { run, created } = storage.getOrCreateActiveRun({ currentState: shape.initialState });
      const workerGate = blockRunForTerminalWorker(storage, run);
      if (workerGate) {
        return ok({
          runId: workerGate.runId,
          status: workerGate.status,
          alreadyRunning: !created,
          reconciled: true,
          gate: workerGate.gate
        });
      }
      if (created) {
        storage.appendEvent({
          runId: run.id,
          kind: "mcp_run_until_gate_started",
          message: "MCP requested background run until gate."
        });
        const started = (this.options.startRun ?? startBackgroundRun)(this.options.repoRoot, run.id);
        if (started === false) {
          storage.updateRunStatus(run.id, run.version, "BLOCKED", { currentState: run.currentState ?? shape.initialState });
          storage.writeGate({
            runId: run.id,
            kind: "required_tool_unavailable",
            message: "Could not start background agent-loop run."
          });
          const gate = storage.listGates(run.id).find((item) => item.status === "open");
          return fail(new AgentLoopError("required_tool_unavailable", "Could not start background run.", {
            details: { runId: run.id, gate }
          }));
        }
      }
      return ok({ runId: run.id, status: "RUNNING", alreadyRunning: !created });
    }));
  }

  loopListGates(): McpResult {
    return this.withConfig(() => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      return ok({ gates: annotatedGatesSnapshot(storage) });
    }));
  }

  loopExplainGate(gateId: string): McpResult {
    return this.withConfig(() => this.withStorageReadOnly((storage) => {
      const gate = annotatedGateSnapshot(storage, gateId);
      if (!gate) {
        throw new AgentLoopError("storage_error", `Gate not found: ${gateId}`);
      }
      return ok({ gate, nextAction: nextAction("BLOCKED", gate.kind) });
    }));
  }

  loopApproveGate(gateId: string, input: string | GateDecisionInput, token?: string): McpResult {
    return this.decideGate(gateId, "approved", input, token);
  }

  loopRejectGate(gateId: string, input: string | GateDecisionInput, token?: string): McpResult {
    return this.decideGate(gateId, "rejected", input, token);
  }

  loopListRuns(limit?: number): McpResult {
    return this.withConfig(() => this.withStorageReadOnly((storage) => ok({ runs: storage.listRuns(limit) })));
  }

  loopListWorkers(input?: number | { limit?: number; workerId?: string; includeEvents?: boolean }): McpResult {
    return this.withConfig(() => this.withStorageReadOnly((storage) => {
      const run = storage.getCurrentRun();
      const limit = typeof input === "number" ? input : input?.limit;
      const workerId = typeof input === "number" ? undefined : input?.workerId;
      const includeEvents = typeof input === "number" ? false : input?.includeEvents === true;
      const workers = storage
        .listWorkers(run?.id, limit ?? 50)
        .filter((worker) => !workerId || worker.id === workerId);
      if (!includeEvents) {
        return ok({ workers });
      }
      const eventsByWorker = Object.fromEntries(workers.map((worker) => [
        worker.id,
        storage.listAgentTimeline({ workerId: worker.id, sources: ["worker_event"], limit: 50 }).entries
      ]));
      return ok({ workers, eventsByWorker });
    }));
  }

  loopListEvents(sinceSeq?: number, limit?: number): McpResult {
    return this.withConfig(() => this.withStorageReadOnly((storage) => {
      const options = {
        ...(sinceSeq === undefined ? {} : { sinceSeq }),
        limit: limit ?? 50
      };
      return ok({ events: storage.listEvents(options) });
    }));
  }

  loopReadArtifact(artifactId: string): McpResult {
    return this.withConfig(() => this.withStorageReadOnly((storage) => {
      const artifactRoot = resolve(this.options.repoRoot, ".agent-loop", "artifacts");
      const record = storage.getArtifact(artifactId);
      assertArtifactPathInsideRoot(artifactRoot, record.path, artifactId);
      if (isSensitiveArtifactKind(record.kind)) {
        throw new AgentLoopError("policy_violation", `Artifact kind ${record.kind} is not readable through the dashboard API.`, {
          details: { artifactId, kind: record.kind }
        });
      }
      const artifact = readArtifact(storage, artifactId);
      return ok({
        record: artifact.record,
        contentBase64: artifact.content.toString("base64")
      });
    }));
  }

  loopGetPrStatus(): McpResult {
    return this.withCurrentRun((storage, run) => ok({ pr: storage.getPrLink(run.id) }));
  }

  loopGetCiStatus(): McpResult {
    return this.withCurrentRun((storage, run) => ok({ checks: storage.listCiChecks(run.id) }));
  }

  loopGetReviewComments(): McpResult {
    return this.withCurrentRun((storage, run) => ok({ comments: storage.listReviewComments(run.id) }));
  }

  loopListArtifacts(): McpResult {
    return this.withCurrentRun((storage, run) => ok({ artifacts: storage.listArtifacts(run.id) }));
  }

  loopDashboardMeta(): McpResult {
    return this.withConfig((config) => {
      const effectiveConfig = applyProfileConfig(config);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      return ok({
      appName: "HOLO-Codex",
      surface: "dashboard",
      targetRepo: {
        root: this.options.repoRoot,
        repoId: config.repoId
      },
      pollingMs: 3000,
      autonomy: describeAutonomyPosture(config),
      pages: [
        "Mission Control",
        "Plan Navigator",
        "Policy Config",
        "Dry-run Preview",
        "Notifications",
        "Gate Center",
        ...(shape.id === "pr-loop" ? ["PR Inbox"] : []),
        "Worker Runs",
        "Scope Guard",
        "Event Ledger",
        "Artifact Diff Viewer",
        "Recovery Center"
      ]
    });
    });
  }

  loopPlanNavigator(): McpResult {
    return this.withConfig((config) => {
      const effectiveConfig = applyProfileConfig(config);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      if (shape.id !== "pr-loop") {
        return ok({ plan: undefined, selection: genericSelectionSummary(effectiveConfig) });
      }
      const selection = resolvePrSelection(this.options.repoRoot, effectiveConfig);
      return ok({ plan: selection.plan, selection: selectionSummary(selection) });
    });
  }

  loopPolicyConfig(): McpResult {
    return this.withConfig(() => ok(readConfigForEdit(this.options.repoRoot)));
  }

  loopSavePolicyConfig(body: unknown, token?: string): McpResult {
    const auth = this.requireToken(token);
    if (auth) return auth;
    if (!isRecord(body) || !isRecord(body.nextConfig) || typeof body.expectedHash !== "string") {
      return fail(new AgentLoopError("invalid_config", "Policy config save requires nextConfig and expectedHash."));
    }
    const expectedHash = body.expectedHash;
    return this.withConfig(() => ok(saveConfigEdit(this.options.repoRoot, {
      nextConfig: body.nextConfig as never,
      expectedHash,
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      ...(typeof body.confirmationToken === "string" ? { confirmationToken: body.confirmationToken } : {})
    })));
  }

  loopDryRunPreview(): McpResult {
    return this.withConfig((config) => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const effectiveConfig = applyProfileConfig(config);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      const profile = resolveProfile(effectiveConfig, run?.currentState as AgentLoopState | undefined);
      const selection = shape.id === "pr-loop" ? resolvePrSelection(this.options.repoRoot, effectiveConfig) : undefined;
      const gates = run ? storage.listGates(run.id) : storage.listGates();
      const openGates = gates.filter((gate) => gate.status === "open");
      const ci = run ? storage.listCiChecks(run.id) : [];
      const reviewComments = run ? storage.listReviewComments(run.id) : [];
      const decisions = run ? storage.listDecisions(run.id) : [];
      const runChecks = run ? storage.listRunChecks(run.id) : [];
      const mergeForecast = evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates, decisions, runChecks });
      return ok({
        nextPr: selection && !selection.ambiguous ? selection.item : undefined,
        branchName: selection && !selection.ambiguous ? selection.branchName : undefined,
        selection: selection ? selectionSummary(selection) : genericSelectionSummary(effectiveConfig),
        profile,
        workflowStages: workflowStages(effectiveConfig),
        commandsPlanned: [
          "git status --short --branch",
          "pnpm agent-loop run --until=gate",
          effectiveConfig.lintCommand,
          effectiveConfig.testCommand
        ].filter(Boolean),
        workerType: profile.roleMapping.find((role) => role.state === (shape.id === "generic-loop" ? "EXECUTE_STEP" : "IMPLEMENT"))?.workerType ?? "implementation",
        possibleGates: openGates.map((gate) => gate.kind),
        missingConditions: shape.id === "pr-loop" ? mergeForecast.missingConditions : openGates.map((gate) => gate.kind),
        filesLikelyTouched: shape.id === "pr-loop" ? likelyTouchedFiles(this.options.repoRoot, effectiveConfig.plansDir, selection && !selection.ambiguous ? selection.item.file : undefined) : genericLikelyTouchedFiles(effectiveConfig),
        autonomyForecast: describeAutonomyPosture(effectiveConfig),
        mergeForecast: shape.id === "pr-loop" ? mergeForecast : undefined
      });
    }));
  }

  loopNotifications(): McpResult {
    return this.withConfig((config) => this.withStorageReadOnly((storage) => {
      const notifications = storage.readTransaction(() => {
        const effectiveConfig = applyProfileConfig(config);
        const shape = resolveLoopShape(effectiveConfig.loopShape);
        const current = storage.getCurrentStatus();
        const run = current.run ?? storage.getCurrentRun();
        const gates = run ? storage.listGates(run.id) : storage.listGates();
        const events = storage.listEvents(NOTIFICATION_EVENT_LIMIT);
        const workers = run ? storage.listWorkers(run.id, 20) : storage.listWorkers(undefined, 20);
        const ci = shape.id === "pr-loop" && run ? storage.listCiChecks(run.id) : [];
        const reviewComments = shape.id === "pr-loop" && run ? storage.listReviewComments(run.id) : [];
        const decisions = shape.id === "pr-loop" && run ? storage.listDecisions(run.id) : [];
        const runChecks = shape.id === "pr-loop" && run ? storage.listRunChecks(run.id) : [];
        const mergeReadiness = shape.id === "pr-loop" ? evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates, decisions, runChecks }) : undefined;
        const timelineEntries = run ? storage.listAgentTimeline({ runId: run.id, limit: 50 }).entries : [];
        return deriveNotifications({
          config: effectiveConfig,
          events,
          gates,
          timelineEntries,
          workers,
          ...(mergeReadiness ? { mergeReadiness } : {}),
          ...(run ? { runId: run.id } : {}),
          now: new Date(),
          dismissedIds: notificationDismissedIds(events)
        });
      });
      return ok({ notifications });
    }));
  }

  loopMarkNotificationsRead(body: unknown, token?: string): McpResult {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig((config) => this.withStorage((storage) => {
      const effectiveConfig = applyProfileConfig(config);
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const events = storage.listEvents(NOTIFICATION_EVENT_LIMIT);
      const gates = run ? storage.listGates(run.id) : storage.listGates();
      const workers = run ? storage.listWorkers(run.id, 20) : storage.listWorkers(undefined, 20);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      const ci = shape.id === "pr-loop" && run ? storage.listCiChecks(run.id) : [];
      const reviewComments = shape.id === "pr-loop" && run ? storage.listReviewComments(run.id) : [];
      const decisions = shape.id === "pr-loop" && run ? storage.listDecisions(run.id) : [];
      const runChecks = shape.id === "pr-loop" && run ? storage.listRunChecks(run.id) : [];
      const mergeReadiness = shape.id === "pr-loop" ? evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates, decisions, runChecks }) : undefined;
      const notifications = deriveNotifications({
        config: effectiveConfig,
        events,
        gates,
        timelineEntries: run ? storage.listAgentTimeline({ runId: run.id, limit: 50 }).entries : [],
        workers,
        ...(mergeReadiness ? { mergeReadiness } : {}),
        ...(run ? { runId: run.id } : {}),
        now: new Date(),
        dismissedIds: notificationDismissedIds(events)
      });
      const requestedIds = isRecord(body) && Array.isArray(body.notificationIds)
        ? body.notificationIds.filter((id): id is string => typeof id === "string")
        : notifications.map((notification) => notification.id);
      const notificationIds = requestedIds.filter((id) => notifications.some((notification) => notification.id === id));
      storage.appendEvent({
        ...(current.run ? { runId: current.run.id } : {}),
        kind: "notification_marked_read",
        message: `Marked ${notificationIds.length} notification(s) read.`,
        payload: { notificationIds, source: "dashboard" }
      });
      return ok({ markedRead: notificationIds.length, notificationIds });
    }));
  }

  loopDismissNotifications(body: unknown, token?: string): McpResult {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig((config) => this.withStorage((storage) => {
      const effectiveConfig = applyProfileConfig(config);
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const events = storage.listEvents(NOTIFICATION_EVENT_LIMIT);
      const gates = run ? storage.listGates(run.id) : storage.listGates();
      const workers = run ? storage.listWorkers(run.id, 20) : storage.listWorkers(undefined, 20);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      const ci = shape.id === "pr-loop" && run ? storage.listCiChecks(run.id) : [];
      const reviewComments = shape.id === "pr-loop" && run ? storage.listReviewComments(run.id) : [];
      const decisions = shape.id === "pr-loop" && run ? storage.listDecisions(run.id) : [];
      const runChecks = shape.id === "pr-loop" && run ? storage.listRunChecks(run.id) : [];
      const mergeReadiness = shape.id === "pr-loop" ? evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates, decisions, runChecks }) : undefined;
      const notifications = deriveNotifications({
        config: effectiveConfig,
        events,
        gates,
        timelineEntries: run ? storage.listAgentTimeline({ runId: run.id, limit: 50 }).entries : [],
        workers,
        ...(mergeReadiness ? { mergeReadiness } : {}),
        ...(run ? { runId: run.id } : {}),
        now: new Date(),
        dismissedIds: notificationDismissedIds(events)
      });
      const requestedIds = isRecord(body) && Array.isArray(body.notificationIds)
        ? body.notificationIds.filter((id): id is string => typeof id === "string")
        : [];
      const oneShotIds = requestedIds
        .filter((id) => id.startsWith("longrunning:"))
        .filter((id) => notifications.some((notification) => notification.id === id));
      storage.appendEvent({
        ...(current.run ? { runId: current.run.id } : {}),
        kind: "notification_dismissed",
        message: `Dismissed ${oneShotIds.length} notification(s).`,
        payload: { notificationIds: oneShotIds, source: "dashboard" }
      });
      return ok({ dismissed: oneShotIds.length, notificationIds: oneShotIds });
    }));
  }

  loopExportAudit(input: { runId: string; format: "markdown" | "json" }): McpResult {
    return this.withConfig(() => this.withStorageReadOnly((storage) => storage.readTransaction(() => {
      const run = storage.listRuns(200).find((item) => item.id === input.runId);
      if (!run) {
        throw new AgentLoopError("storage_error", `Run not found: ${input.runId}`);
      }
      const data = buildAuditData(storage, run);
      const content = input.format === "json" ? data : renderAuditMarkdown(data);
      return ok({ runId: run.id, format: input.format, content });
    })));
  }

  loopRecover(token?: string): McpResult {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig(() => ok(recoverBlockedRun(this.options.repoRoot, "dashboard")));
  }

  loopMarkHistoricalGateHandled(gateId: string, token?: string): McpResult {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig(() => this.withStorage((storage) => {
      const gate = storage.getGate(gateId);
      if (!gate) {
        throw new AgentLoopError("storage_error", `Gate not found: ${gateId}`);
      }
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const annotated = annotateGates({
        gates: storage.listGates(),
        current,
        ...(run ? { run } : {}),
        runs: storage.listRuns(20),
        dismissedHistoricalGateIds: historicalGateHandledIds(storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT))
      }).find((item) => item.id === gate.id);
      if (annotated?.activity === "active") {
        throw new AgentLoopError("invalid_config", "Active gates must be approved, rejected, or recovered; they cannot be marked handled.");
      }
      const payload = {
        gateId: gate.id,
        gateKind: gate.kind,
        gateRunId: gate.runId,
        gateStatus: gate.status,
        activity: annotated?.activity ?? "historical",
        activityReason: annotated?.activityReason ?? "historical_run",
        source: "dashboard"
      };
      storage.appendEvent({
        ...(gate.runId ? { runId: gate.runId } : {}),
        kind: HISTORICAL_EVENT_KIND,
        message: `Marked historical gate ${gate.id} as handled in the dashboard view.`,
        payload
      });
      if (gate.runId) {
        storage.appendDecision({
          runId: gate.runId,
          kind: HISTORICAL_EVENT_KIND,
          message: `Marked historical gate ${gate.id} as handled in the dashboard view.`,
          details: payload
        });
      }
      return ok({ gate: { ...gate, activity: "historical", activityReason: "marked_handled" }, markedHandled: true });
    }));
  }

  loopReevaluateHistoricalGate(gateId: string, token?: string): McpResult {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig(() => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      const gate = storage.getGate(gateId);
      if (!gate) {
        throw new AgentLoopError("storage_error", `Gate not found: ${gateId}`);
      }
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const annotated = annotateGates({
        gates: storage.listGates(),
        current,
        ...(run ? { run } : {}),
        runs: storage.listRuns(20),
        dismissedHistoricalGateIds: historicalGateHandledIds(storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT))
      }).find((item) => item.id === gate.id);
      const result = reevaluationResult(annotated?.activity, annotated?.activityReason);
      const payload = {
        gateId: gate.id,
        gateKind: gate.kind,
        gateRunId: gate.runId,
        gateStatus: gate.status,
        activity: annotated?.activity ?? "historical",
        activityReason: annotated?.activityReason ?? "historical_run",
        result,
        source: "dashboard"
      };
      storage.appendEvent({
        ...(gate.runId ? { runId: gate.runId } : {}),
        kind: HISTORICAL_REEVALUATED_EVENT_KIND,
        message: `Re-evaluated historical gate ${gate.id} in the dashboard view.`,
        payload
      });
      if (gate.runId) {
        storage.appendDecision({
          runId: gate.runId,
          kind: HISTORICAL_REEVALUATED_EVENT_KIND,
          message: `Re-evaluated historical gate ${gate.id} in the dashboard view.`,
          details: payload
        });
      }
      return ok({ gate: { ...gate, activity: payload.activity, activityReason: payload.activityReason }, result, reevaluated: true });
    }));
  }

  async loopSpawnWorker(type: WorkerType, dryRun = true, token?: string): Promise<McpResult> {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return await this.withConfigAsync(async (config) => {
      const storage = new SqliteAgentLoopStorage(statePath(this.options.repoRoot));
      try {
        const run = storage.getCurrentRun();
        if (!run) {
          throw new AgentLoopError("storage_error", "No current run exists.");
        }
        storage.appendDecision({
          runId: run.id,
          kind: "mcp_spawn_worker_requested",
          message: `MCP requested ${type} worker.`,
          details: { type, dryRun }
        });
        return ok(await executeWorker({
          repoRoot: this.options.repoRoot,
          storage,
          run,
          config,
          state: workerState(run.currentState),
          type,
          dryRun
        }));
      } catch (error) {
        return fail(error);
      } finally {
        storage.close();
      }
    });
  }

  loopOpenDashboard(): McpResult {
    return this.withConfig((config) => {
      if (!config.dashboard?.enabled) {
        return ok({ enabled: false, message: "Run `pnpm agent-loop dashboard` to start the local dashboard." });
      }
      const port = config.dashboard.port ?? 0;
      return ok({ enabled: true, url: `http://${config.dashboard.host}:${port}` });
    });
  }

  private decideGate(gateId: string, decision: "approved" | "rejected", input: string | GateDecisionInput, token?: string): McpResult {
    const auth = this.requireToken(token);
    if (auth) return auth;
    const decisionInput = normalizeGateDecisionInput(input);
    const note = decisionInput.note;
    if (note.trim().length === 0) {
      return fail(new AgentLoopError("invalid_config", "Gate approval note is required."));
    }
    return this.withConfig(() => this.withStorage((storage) => {
      const gate = storage.decideGate(gateId, decision, note);
      const runId = gate.runId ?? storage.getCurrentRun()?.id;
      if (runId) {
        storage.appendDecision({
          runId,
          kind: `gate_${decision}`,
          message: `${decision} gate ${gate.id}.`,
          details: {
            gateId: gate.id,
            gateKind: gate.kind,
            state: gateState(gate.details),
            note,
            source: decisionInput.source ?? "api",
            payload: decisionInput.payload ?? {},
            gateDetails: gate.details
          }
        });
      }
      return ok({ gate });
    }));
  }

  private withConfig(fn: (config: ReturnType<typeof loadConfig>["config"]) => McpResult): McpResult {
    try {
      const { config } = loadConfig(this.options.repoRoot);
      return fn(config);
    } catch (error) {
      return fail(error);
    }
  }

  private async withConfigAsync(fn: (config: ReturnType<typeof loadConfig>["config"]) => Promise<McpResult>): Promise<McpResult> {
    try {
      const { config } = loadConfig(this.options.repoRoot);
      return await fn(config);
    } catch (error) {
      return fail(error);
    }
  }

  private withStorage(fn: (storage: SqliteAgentLoopStorage) => McpResult): McpResult {
    const storage = new SqliteAgentLoopStorage(statePath(this.options.repoRoot));
    try {
      return fn(storage);
    } catch (error) {
      return fail(error);
    } finally {
      storage.close();
    }
  }

  private withStorageReadOnly(fn: (storage: SqliteAgentLoopStorage) => McpResult): McpResult {
    const storage = new SqliteAgentLoopStorage(statePath(this.options.repoRoot), { mode: "ro" });
    try {
      return fn(storage);
    } catch (error) {
      return fail(error);
    } finally {
      storage.close();
    }
  }

  private withCurrentRun(fn: (storage: SqliteAgentLoopStorage, run: AgentLoopRun) => McpResult): McpResult {
    return this.withConfig(() => this.withStorageReadOnly((storage) => {
      const run = storage.getCurrentRun();
      if (!run) {
        throw new AgentLoopError("storage_error", "No current run exists.");
      }
      return fn(storage, run);
    }));
  }

  private requireToken(token: string | undefined): McpResult | undefined {
    return requireMcpToken(token, this.options.mcpToken);
  }

  private reconcileTerminalWorker(storage: SqliteAgentLoopStorage): void {
    const run = storage.getCurrentRun();
    if (run) {
      blockRunForTerminalWorker(storage, run);
    }
  }
}

function isSensitiveArtifactKind(kind: string): boolean {
  return ["worker-prompt", "worker-jsonl", "worker-result"].includes(kind);
}

function normalizeGateDecisionInput(input: string | GateDecisionInput): GateDecisionInput {
  if (typeof input === "string") {
    return { note: input };
  }
  return {
    note: input.note,
    ...(input.source ? { source: input.source } : {}),
    ...(input.payload ? { payload: input.payload } : {})
  };
}

function gateState(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  return typeof details.state === "string" ? details.state : undefined;
}

function selectionSummary(selection: PrSelection): Record<string, unknown> {
  if (selection.mode === "ambiguous") {
    return {
      mode: selection.mode,
      ambiguous: true,
      reason: selection.reason,
      candidates: selection.candidates,
      evidence: selection.evidence
    };
  }
  return {
    mode: selection.mode,
    ambiguous: false,
    item: selection.item,
    branchName: selection.branchName,
    ...(selection.mode === "current_pr" ? {
      prNumber: selection.pr.number,
      prUrl: selection.pr.url
    } : {}),
    evidence: selection.evidence
  };
}

function genericSelectionSummary(config: AgentLoopConfig): Record<string, unknown> {
  return {
    mode: "generic_loop",
    ambiguous: false,
    loopShape: config.loopShape,
    workflowProfile: config.workflowProfile,
    evidence: ["generic-loop uses workflow profile state, not legacy PR spec selection."]
  };
}

function genericLikelyTouchedFiles(config: AgentLoopConfig): string[] {
  const profile = resolveProfile(config);
  const allowedRoots = profile.allowedWriteRoots ?? [];
  return [
    ...allowedRoots.map((root) => `${root}/`),
    ".agent-loop/artifacts/"
  ];
}

function dashboardInfo(config: AgentLoopConfig): { url: string; host: string; port: number; loopbackOnly: true } {
  const host = config.dashboard?.host ?? "127.0.0.1";
  const port = config.dashboard?.port ?? 0;
  return { url: `http://${host}:${port}/`, host, port, loopbackOnly: true };
}

function notificationReadIds(events: AgentLoopEvent[]): Set<string> {
  return notificationIdsForKind(events, "notification_marked_read");
}

function notificationDismissedIds(events: AgentLoopEvent[]): Set<string> {
  return notificationIdsForKind(events, "notification_dismissed");
}

function notificationIdsForKind(events: AgentLoopEvent[], kind: string): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind !== kind || typeof event.payload !== "object" || event.payload === null) {
      continue;
    }
    const notificationIds = (event.payload as { notificationIds?: unknown }).notificationIds;
    if (Array.isArray(notificationIds)) {
      for (const id of notificationIds) {
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  return ids;
}

function mergeReadinessForMissionDisplay(readiness: MergeReadiness, events: AgentLoopEvent[]): MergeReadiness {
  if (!hasWorkflowCleanupEvidence(events)) {
    return readiness;
  }
  return {
    ...readiness,
    state: "ready",
    ready: true,
    missingConditions: [],
    evidence: [...readiness.evidence, "cleanup evidence recorded after merge"]
  };
}

function hasWorkflowCleanupEvidence(events: AgentLoopEvent[]): boolean {
  return events.some((event) => {
    if (event.kind !== WORKFLOW_STAGE_EVIDENCE_KIND || !isRecord(event.payload)) {
      return false;
    }
    return event.payload.stageId === "cleanup";
  });
}

function buildAuditData(storage: SqliteAgentLoopStorage, run: AgentLoopRun): Record<string, unknown> {
  const gates = storage.listGates(run.id).map((gate) => ({
    id: gate.id,
    runId: gate.runId,
    kind: gate.kind,
    status: gate.status,
    message: redactSecrets(gate.message),
    details: redactAuditValue(gate.details),
    createdAt: gate.createdAt,
    resolvedAt: gate.resolvedAt,
    decisionNote: gate.decisionNote ? redactSecrets(gate.decisionNote) : undefined,
    decidedAt: gate.decidedAt
  }));
  const ci = storage.listCiChecks(run.id);
  const reviewComments = storage.listReviewComments(run.id).map((comment) => ({
    id: comment.id,
    prNumber: comment.prNumber,
    url: comment.url,
    author: comment.author,
    path: comment.path,
    line: comment.line,
    actionable: comment.actionable,
    isResolved: comment.isResolved,
    isOutdated: comment.isOutdated,
    status: comment.status
  }));
  const timeline = storage.listAgentTimeline({ runId: run.id, limit: 200 }).entries.map((entry) => ({
    timelineSeq: entry.timelineSeq,
    occurredAt: entry.occurredAt,
    source: entry.source,
    kind: entry.kind,
    workerId: entry.workerId,
    threadId: entry.threadId,
    title: redactSecrets(entry.title),
    summary: redactSecrets(entry.summary).slice(0, 2_000),
    status: entry.status,
    artifactIds: entry.artifactIds
  }));
  return {
    generatedAt: new Date().toISOString(),
    run,
    pr: storage.getPrLink(run.id),
    ci,
    reviewComments,
    workers: storage.listWorkers(run.id, 100).map((worker) => ({
      ...worker,
      ...(worker.error ? { error: redactSecrets(worker.error) } : {})
    })),
    gates,
    decisions: storage.listDecisions(run.id).map((decision) => ({
      ...decision,
      message: redactSecrets(decision.message),
      details: redactAuditValue(decision.details)
    })),
    artifacts: storage.listArtifacts(run.id).map((artifact) => ({
      id: artifact.id,
      runId: artifact.runId,
      kind: artifact.kind,
      name: redactSecrets(artifact.name),
      path: redactSecrets(artifact.path),
      sha256: artifact.sha256,
      createdAt: artifact.createdAt
    })),
    timeline
  };
}

function renderAuditMarkdown(data: Record<string, unknown>): string {
  const run = data.run as AgentLoopRun;
  const pr = data.pr as { prNumber?: number; url?: string; state?: string } | undefined;
  const workers = data.workers as WorkerRun[];
  const gates = data.gates as Array<{ kind: string; status: string; message: string }>;
  const timeline = data.timeline as Array<{ occurredAt: string; source: string; title: string; status?: string }>;
  const lines = [
    `# Agent Loop Audit: ${run.id}`,
    "",
    `- Status: ${run.status}`,
    `- State: ${run.currentState ?? "unknown"}`,
    `- Branch: ${run.branch ?? "unknown"}`,
    `- Generated: ${data.generatedAt}`,
    pr ? `- PR: #${pr.prNumber ?? "unknown"} ${pr.state ?? ""} ${pr.url ?? ""}` : "- PR: none",
    "",
    "## Gates",
    ...listLines(gates.map((gate) => `${gate.kind} / ${gate.status} - ${redactSecrets(gate.message)}`)),
    "",
    "## Workers",
    ...listLines(workers.map((worker) => `${worker.id} / ${worker.type} / ${worker.status}`)),
    "",
    "## Timeline",
    ...listLines(timeline.slice(0, 80).map((entry) => `${entry.occurredAt} ${entry.source} ${entry.status ?? ""} - ${entry.title}`))
  ];
  return `${lines.join("\n")}\n`;
}

function listLines(items: string[]): string[] {
  return items.length === 0 ? ["- none"] : items.map((item) => `- ${item}`);
}

function redactAuditValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value).slice(0, 2_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactAuditValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([key, nested]) => [
    key,
    redactAuditField(key, nested)
  ]));
}

function redactAuditField(key: string, value: unknown): unknown {
  if (/token|api_key|authorization|password|secret/i.test(key)) {
    return "[redacted]";
  }
  if (/stdout|stderr|output|rawJsonl|contentBase64|prompt/i.test(key)) {
    return {
      omitted: true,
      reason: "raw content is excluded from audit exports",
      length: typeof value === "string" ? value.length : JSON.stringify(value ?? "").length,
      type: Array.isArray(value) ? "array" : typeof value
    };
  }
  return redactAuditValue(value);
}

function buildTimelineSummary(input: {
  timeline: AgentTimelineEntry[];
  workers: WorkerRun[];
  currentRunId?: string;
  nowMs?: number;
  listWorkerEvents: (workerId: string) => Array<{ eventType: string; itemType?: string; createdAt: string }>;
}): Record<string, unknown> {
  const activeWorker = input.workers.find((worker) => worker.status === "running");
  const lastFailure = input.timeline.find((entry) =>
    entry.source === "worker" &&
    (entry.status === "failed" || entry.status === "timed_out" || entry.status === "invalid_output")
  );
  const summary: Record<string, unknown> = {
    hasObservationGap: hasObservationGap(input.workers, input.listWorkerEvents, input.nowMs),
    ...(input.currentRunId ? { runId: input.currentRunId } : {})
  };
  if (input.timeline[0]) {
    summary.latest = input.timeline[0];
  }
  if (lastFailure) {
    summary.lastFailure = lastFailure;
  }
  if (activeWorker) {
    summary.activeWorker = {
      id: activeWorker.id,
      type: activeWorker.type,
      status: activeWorker.status,
      ...(activeWorker.threadId ? { threadId: activeWorker.threadId } : {}),
      startedAt: activeWorker.startedAt
    };
  }
  return summary;
}

function hasObservationGap(
  workers: WorkerRun[],
  listWorkerEvents: (workerId: string) => Array<{ eventType: string; itemType?: string; createdAt: string }>,
  nowMs = Date.now()
): boolean {
  return workers.some((worker) => {
    const events = listWorkerEvents(worker.id);
    if (events.length === 0 && !worker.rawJsonlArtifactId) {
      return true;
    }
    const hasSummary = events.some((event) =>
      event.eventType === "thread.started" ||
      event.eventType === "turn.completed" ||
      event.itemType === "command_execution" ||
      event.itemType === "file_change" ||
      event.itemType === "agent_message" ||
      event.itemType === "mcp_tool_call" ||
      event.itemType === "web_search" ||
      event.itemType === "todo_list" ||
      event.itemType === "error"
    );
    if (worker.rawJsonlArtifactId && !hasSummary) {
      return true;
    }
    if (worker.status !== "running") {
      return false;
    }
    const startedAt = Date.parse(worker.startedAt);
    if (Number.isNaN(startedAt) || nowMs - startedAt <= 60_000) {
      return false;
    }
    const newestEventMs = events.reduce((latest, event) => {
      const value = Date.parse(event.createdAt);
      return Number.isNaN(value) ? latest : Math.max(latest, value);
    }, 0);
    return newestEventMs < startedAt || nowMs - newestEventMs > 60_000;
  });
}

function assertArtifactPathInsideRoot(artifactRoot: string, path: string, artifactId: string): void {
  try {
    const rootRealPath = realpathSync(artifactRoot);
    const artifactRealPath = realpathSync(path);
    const relativePath = relative(rootRealPath, artifactRealPath);
    if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith("/")) {
      throw new AgentLoopError("artifact_integrity_error", "Artifact path escapes artifact root.", {
        details: { artifactId, path }
      });
    }
  } catch (error) {
    if (error instanceof AgentLoopError) {
      throw error;
    }
    throw new AgentLoopError("artifact_integrity_error", "Artifact path cannot be verified.", {
      details: { artifactId, path, cause: error instanceof Error ? error.message : String(error) }
    });
  }
}

function startBackgroundRun(repoRoot: string, runId: string): boolean {
  try {
    execFileSync("which", ["pnpm"], { stdio: "ignore" });
  } catch (error) {
    markBackgroundRunFailed(repoRoot, runId, error);
    return false;
  }
  const child = spawn("pnpm", ["agent-loop", "run", "--until=gate"], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    shell: false
  });
  let handledStartFailure = false;
  const failStartOnce = (error: unknown): void => {
    if (handledStartFailure) {
      return;
    }
    handledStartFailure = true;
    markBackgroundRunFailed(repoRoot, runId, error);
  };
  child.on("error", (error) => {
    failStartOnce(error);
  });
  if (!child.pid) {
    failStartOnce(new Error("Background process did not start."));
    return false;
  }
  child.unref();
  return true;
}

function markBackgroundRunFailed(repoRoot: string, runId: string, error: unknown): void {
  let storage: SqliteAgentLoopStorage | undefined;
  try {
    storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    if (run?.id === runId && run.status === "RUNNING") {
      try {
        storage.updateRunStatus(run.id, run.version, "BLOCKED", {
          ...(run.currentState ? { currentState: run.currentState } : {})
        });
      } catch {
        // Best-effort cleanup; the run may have advanced concurrently.
      }
    }
    try {
      storage.writeGate({
        runId,
        kind: "required_tool_unavailable",
        message: "Could not start background agent-loop run.",
        details: { cause: error instanceof Error ? error.message : String(error) }
      });
      storage.appendEvent({
        runId,
        kind: "background_run_start_failed",
        message: "Could not start background agent-loop run.",
        payload: { cause: error instanceof Error ? error.message : String(error) }
      });
    } catch {
      // Async process-start failure handling must never crash the MCP server.
    }
  } catch {
    // Best-effort cleanup path.
  } finally {
    storage?.close();
  }
}

function nextAction(status: string, gate?: string): string {
  if (gate === "needs_repo_init") {
    return "Run `pnpm agent-loop init`.";
  }
  if (gate) {
    return "Inspect the gate, fix the cause, then approve or reject with a note.";
  }
  if (status === "IDLE" || status === "READY") {
    return "Run until the next gate.";
  }
  if (status === "STOPPED") {
    return "Resume only after confirming the stopped run should continue.";
  }
  return "Poll status.";
}

function ok<T>(data: T): McpResult<T> {
  return { ok: true, data };
}

function fail(error: unknown): McpResult {
  const payload = toErrorPayload(error);
  return {
    ok: false,
    error: payload,
    ...(payload.code ? { gate: payload.code } : {})
  };
}

function requireMcpToken(token: string | undefined, expectedToken?: string): McpResult | undefined {
  const expected = expectedToken ?? process.env.AGENT_LOOP_MCP_TOKEN;
  if (!expected) {
    return fail(new AgentLoopError("needs_secret_or_login", "AGENT_LOOP_MCP_TOKEN is required for mutating MCP tools.", {
      exitCode: 2
    }));
  }
  if (token !== expected) {
    return fail(new AgentLoopError("needs_secret_or_login", "MCP token is missing or invalid.", {
      exitCode: 2
    }));
  }
  return undefined;
}

function recoveryWarnings(
  gate: string | undefined,
  gates: Array<AgentLoopGate & { activity?: "active" | "historical"; activityReason?: string }> = [],
  workers: Array<WorkerRun & { activity?: "active" | "historical"; activityReason?: string }> = []
): string[] {
  const warnings = gate === "needs_repo_init"
    ? ["needs_repo_init is visible; use explicit recovery after config is valid."]
    : [];
  const historicalOpen = gates.filter((item) => item.status === "open" && item.activity === "historical");
  if (historicalOpen.length > 0) {
    warnings.push(`${historicalOpen.length} historical open gate(s) belong to an inactive or superseded run.`);
  }
  const staleWorkers = workers.filter((item) => item.activityReason === "stale_worker_failure");
  if (staleWorkers.length > 0) {
    warnings.push(`${staleWorkers.length} stale worker failure(s) are from an older run or before the current run started.`);
  }
  return warnings;
}

function currentForMissionControl(
  current: ReturnType<SqliteAgentLoopStorage["getCurrentStatus"]>,
  gates: Array<AgentLoopGate & { activity?: "active" | "historical"; activityReason?: string }>
): ReturnType<SqliteAgentLoopStorage["getCurrentStatus"]> {
  const activeGate = gates.find((gate) => gate.status === "open" && gate.activity === "active");
  if (activeGate) {
    return {
      ...current,
      status: "BLOCKED",
      gate: {
        kind: activeGate.kind,
        message: activeGate.message,
        ...(activeGate.details === undefined ? {} : { details: activeGate.details })
      }
    };
  }
  if (!current.gate) {
    return current;
  }
  const { gate: _gate, ...withoutGate } = current;
  return {
    ...withoutGate,
    status: current.run?.status ?? current.status
  };
}

function annotatedGatesSnapshot(storage: SqliteAgentLoopStorage): Array<AgentLoopGate & { activity: "active" | "historical"; activityReason: string }> {
  return storage.readTransaction(() => {
    const current = storage.getCurrentStatus();
    const run = current.run ?? storage.getCurrentRun();
    const historicalEvents = storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT);
    return annotateGates({
      gates: storage.listGates(),
      current,
      ...(run ? { run } : {}),
      runs: storage.listRuns(20),
      dismissedHistoricalGateIds: historicalGateHandledIds(historicalEvents)
    });
  });
}

function annotatedGateSnapshot(storage: SqliteAgentLoopStorage, gateId: string): (AgentLoopGate & { activity: "active" | "historical"; activityReason: string }) | undefined {
  return storage.readTransaction(() => {
    const gate = storage.getGate(gateId);
    if (!gate) return undefined;
    const current = storage.getCurrentStatus();
    const run = current.run ?? storage.getCurrentRun();
    const historicalEvents = storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT);
    return annotateGates({
      gates: [gate],
      current,
      ...(run ? { run } : {}),
      runs: includeRun(storage.listRuns(20), run),
      dismissedHistoricalGateIds: historicalGateHandledIds(historicalEvents)
    })[0];
  });
}

function includeRun(runs: AgentLoopRun[], run: AgentLoopRun | undefined): AgentLoopRun[] {
  if (!run || runs.some((item) => item.id === run.id)) return runs;
  return [run, ...runs];
}

function annotateGates(input: {
  gates: AgentLoopGate[];
  current: ReturnType<SqliteAgentLoopStorage["getCurrentStatus"]>;
  run?: AgentLoopRun;
  runs: AgentLoopRun[];
  dismissedHistoricalGateIds: Set<string>;
}): Array<AgentLoopGate & { activity: "active" | "historical"; activityReason: string }> {
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const currentRunId = input.run?.id;
  const currentStartedAt = input.run?.startedAt ? Date.parse(input.run.startedAt) : (input.run?.createdAt ? Date.parse(input.run.createdAt) : undefined);
  return input.gates.map((gate) => {
    const gateRun = gate.runId ? runById.get(gate.runId) : undefined;
    const activeRun = gateRun ? isActiveRun(gateRun) && gateRun.id === currentRunId : input.current.gate?.kind === gate.kind;
    const inactiveGateRun = gateRun ? !isActiveRun(gateRun) : false;
    const gateCreatedAt = Date.parse(gate.createdAt);
    const supersededByCurrentRun = gate.runId !== undefined &&
      gate.runId !== currentRunId &&
      currentRunId !== undefined &&
      (inactiveGateRun || (
        currentStartedAt !== undefined &&
        !Number.isNaN(gateCreatedAt) &&
        gateCreatedAt < currentStartedAt
      ));
    if (gate.status === "open" && activeRun && !supersededByCurrentRun) {
      return { ...gate, activity: "active" as const, activityReason: gate.runId ? "current_run" : "repo_gate" };
    }
    if (input.dismissedHistoricalGateIds.has(gate.id)) {
      return { ...gate, activity: "historical" as const, activityReason: "marked_handled" };
    }
    if (supersededByCurrentRun) {
      return { ...gate, activity: "historical" as const, activityReason: "overridden_by_reality" };
    }
    if (gate.status !== "open") {
      return { ...gate, activity: "historical" as const, activityReason: "handled_gate" };
    }
    return { ...gate, activity: "historical" as const, activityReason: gateRun ? "historical_run" : "repo_gate_not_current" };
  });
}

function annotateWorkers(input: {
  workers: WorkerRun[];
  gates: Array<AgentLoopGate & { activity?: "active" | "historical"; activityReason?: string }>;
  run?: AgentLoopRun;
}): Array<WorkerRun & { activity: "active" | "historical"; activityReason: string }> {
  const currentRunId = input.run?.id;
  const currentStartedAt = input.run?.startedAt ? Date.parse(input.run.startedAt) : undefined;
  return input.workers.map((worker) => {
    const terminalFailure = worker.status === "failed" || worker.status === "invalid_output" || worker.status === "timed_out";
    const workerTime = Date.parse(worker.completedAt ?? worker.startedAt);
    const olderThanCurrentRun = currentStartedAt !== undefined && !Number.isNaN(workerTime) && workerTime < currentStartedAt;
    const workerGate = input.gates.find((gate) =>
      TERMINAL_WORKER_GATE_KINDS.includes(gate.kind) &&
      isRecord(gate.details) &&
      gate.details.workerId === worker.id
    );
    if (terminalFailure && (worker.runId !== currentRunId || olderThanCurrentRun || workerGate?.activity === "historical")) {
      return { ...worker, activity: "historical" as const, activityReason: "stale_worker_failure" };
    }
    if (worker.runId === currentRunId && input.run && isActiveRun(input.run)) {
      return { ...worker, activity: "active" as const, activityReason: "current_run" };
    }
    return { ...worker, activity: "historical" as const, activityReason: "historical_run" };
  });
}

function isActiveRun(run: AgentLoopRun): boolean {
  return run.status === "RUNNING" || run.status === "BLOCKED";
}

function historicalGateHandledIds(events: AgentLoopEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind !== HISTORICAL_EVENT_KIND || !isRecord(event.payload)) {
      continue;
    }
    const gateId = event.payload.gateId;
    if (typeof gateId === "string") {
      ids.add(gateId);
    }
  }
  return ids;
}

function reevaluationResult(activity: "active" | "historical" | undefined, activityReason: string | undefined): HistoricalGateReevaluationResult {
  if (activity === "active") {
    return "active_again";
  }
  if (activityReason === "marked_handled") {
    return "manually_handled";
  }
  if (activityReason === "overridden_by_reality") {
    return "overridden_by_current_reality";
  }
  return "still_historical";
}

function workerState(value: string | undefined): AgentLoopState {
  if (value === "WRITE_SPEC" || value === "IMPLEMENT" || value === "FIX_REVIEW" || value === "SELF_CHECK") {
    return value;
  }
  return "SELF_CHECK";
}

function likelyTouchedFiles(repoRoot: string, plansDir: string, selectedFile: string | undefined): string[] {
  const paths = new Set([plansDir, ".agent-loop/config.json"]);
  if (selectedFile) {
    paths.add(relative(repoRoot, selectedFile).replaceAll("\\", "/"));
  }
  return [...paths];
}
