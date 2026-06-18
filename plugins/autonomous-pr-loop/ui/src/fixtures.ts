import type {
  AgentTimelineEntry,
  ArtifactSummary,
  ConfigSnapshot,
  DashboardApi,
  DashboardResult,
  DryRunPreviewData,
  EventSummary,
  MissionControlData,
  WorkflowBoard,
  WorkflowBoardStage,
  WorkflowStageId,
  WorkflowStageStatus
} from "./api.js";

type FixtureName =
  | "blocked"
  | "running"
  | "success"
  | "error"
  | "invalid-profile"
  | "empty"
  | "long-content"
  | "many-events"
  | "mobile-stress"
  | "mobile-table-stress"
  | "observability"
  | "many-agent-events"
  | "worker-event-expand"
  | "long-command-summary"
  | "stale-gate"
  | "historical-worker-failure"
  | "historical-blocked-run"
  | "workflow-build-active"
  | "workflow-verify-failed"
  | "workflow-pr-published"
  | "workflow-review-active"
  | "workflow-merge-blocked"
  | "workflow-cleanup-active"
  | "workflow-unknown-state"
  | "generic-deliverable-ready"
  | "generic-human-gate"
  | "generic-scope-change"
  | "generic-completed";

const timestamp = "2026-06-12T10:00:00.000Z";

export const dashboardFixtureNames: FixtureName[] = [
  "blocked",
  "running",
  "success",
  "error",
  "invalid-profile",
  "empty",
  "long-content",
  "many-events",
  "mobile-stress",
  "mobile-table-stress",
  "observability",
  "many-agent-events",
  "worker-event-expand",
  "long-command-summary",
  "stale-gate",
  "historical-worker-failure",
  "historical-blocked-run",
  "workflow-build-active",
  "workflow-verify-failed",
  "workflow-pr-published",
  "workflow-review-active",
  "workflow-merge-blocked",
  "workflow-cleanup-active",
  "workflow-unknown-state",
  "generic-deliverable-ready",
  "generic-human-gate",
  "generic-scope-change",
  "generic-completed"
];

export function dashboardFixture(name: string | undefined): MissionControlData | undefined {
  if (!name) return undefined;
  if (!dashboardFixtureNames.includes(name as FixtureName)) return undefined;
  return buildFixture(name as FixtureName);
}

export function createFixtureDashboardApi(data: MissionControlData): DashboardApi {
  const artifact = data.artifacts[0] ?? artifactRecord("artifact-empty", "log", "empty.log");
  const ok = <T>(payload: T): Promise<DashboardResult<T>> => Promise.resolve({ ok: true, data: payload });
  return {
    dashboardMeta: () => ok({
      appName: "HOLO-Codex",
      surface: "dashboard",
      targetRepo: { root: "/fixture/repo", repoId: "example/fixture" }
    }),
    missionControl: () => ok(data),
    observe: () => ok({
      dashboard: { url: "http://127.0.0.1:0/", host: "127.0.0.1", port: 0, loopbackOnly: true },
      happy: { installed: false, supportsNotify: false },
      current: data.current,
      timeline: { entries: timelineFromData(data).slice(0, 20) }
    }),
    events: (since) => ok({ events: data.events.filter((event) => since === undefined || event.seq > since) }),
    agentTimeline: (options) => {
      const timeline = timelineFromData(data).filter((entry) =>
        (!options?.runId || entry.runId === options.runId) &&
        (!options?.workerId || entry.workerId === options.workerId) &&
        (!options?.sources?.length || options.sources.includes(entry.source))
      );
      return ok({ entries: timeline.slice(0, options?.limit ?? 50) });
    },
    mutate: (path) => {
      if (path.endsWith("/re-evaluate")) {
        const gate = data.gates.find((item) => item.activity === "historical") ?? data.gates[0];
        return ok({
          fixture: true,
          gate,
          result: gate?.activityReason === "marked_handled" ? "manually_handled" : "overridden_by_current_reality",
          reevaluated: true
        });
      }
      return ok({ fixture: true });
    },
    artifact: (id) => {
      const record = data.artifacts.find((item) => item.id === id) ?? artifact;
      return ok({
        record,
        contentBase64: btoa(`fixture artifact: ${record.name}\n\n${longSentence("Artifact content", 18)}`)
      });
    },
    plan: () => ok({ plan: data.plan ?? baseFixture().plan! }),
    policyConfig: () => ok(policyConfigFixture()),
    dryRunPreview: () => ok(dryRunFixture(data)),
    notifications: () => ok({ notifications: data.notifications ?? [] }),
    workflowBoard: () => ok(workflowBoardFixture(data)),
    appendWorkflowEvidence: () => ok({ fixture: true }),
    auditExport: (options) => ok({
      runId: options.runId,
      format: options.format,
      content: options.format === "json" ? { runId: options.runId, fixture: true } : `# Fixture audit ${options.runId}\n`
    })
  };
}

function buildFixture(name: FixtureName): MissionControlData {
  const base = baseFixture();
  if (name === "running") {
    const { gate: _gate, ...current } = base.current;
    return {
      ...base,
      current: {
        ...current,
        status: "RUNNING",
        nextAction: "Continue autonomous loop until the next material gate."
      },
      gates: [],
      notifications: [{
        id: "note-progress",
        severity: "informational",
        title: "Loop progress",
        reason: "Worker completed scoped edits and supervisor is running checks.",
        source: "event",
        sourceId: "event-2",
        createdAt: timestamp
      }],
      mergeReadiness: {
        state: "collecting_evidence",
        ready: false,
        missingConditions: ["required check green: ci", "review approval observed"],
        evidence: ["scope guard passed"],
        carryoverRecords: []
      }
    };
  }
  if (name === "success") {
    const { gate: _gate, ...current } = base.current;
    return {
      ...base,
      current: {
        ...current,
        status: "READY",
        nextAction: "Ready for operator review or merge confirmation.",
        ...(base.current.run ? { run: { ...base.current.run, status: "READY", currentState: "MERGE" } } : {})
      },
      gates: [],
      notifications: [],
      mergeReadiness: {
        state: "ready",
        ready: true,
        missingConditions: [],
        evidence: ["ci green", "review approved", "self check passed"],
        carryoverRecords: []
      }
    };
  }
  if (name === "error") {
    return {
      ...base,
      current: {
        ...base.current,
        status: "BLOCKED",
        nextAction: "Inspect worker failure and decide whether to resume or recover.",
        gate: { kind: "worker_failed", message: "Worker failed while rendering dashboard polish." }
      },
      gates: [{
        id: "gate-worker-failed",
        kind: "worker_failed",
        status: "open",
        message: "Worker failed while rendering dashboard polish.",
        details: { workerId: "worker-error", exitCode: 1 },
        createdAt: timestamp
      }],
      workers: [{
        id: "worker-error",
        type: "implementation",
        status: "failed",
        startedAt: timestamp,
        completedAt: timestamp,
        error: "dashboard render failed"
      }],
      notifications: [{
        id: "workerfailed:worker-error",
        severity: "blocked",
        title: "worker_failed",
        reason: "Worker failed while rendering dashboard polish.",
        source: "worker",
        sourceId: "worker-error",
        createdAt: timestamp
      }]
    };
  }
  if (name === "invalid-profile") {
    const { profile: _profile, ...withoutProfile } = base;
    return {
      ...withoutProfile,
      current: {
        ...base.current,
        nextAction: "Profile summary is unavailable; dashboard should still render."
      },
      recoveryWarnings: ["Profile summary missing from fixture response."]
    };
  }
  if (name === "observability" || name === "worker-event-expand") {
    return {
      ...base,
      timelineSummary: {
        latest: timelineFromData(base)[0]!,
        activeWorker: { id: "worker-running", type: "implementation", status: "running", startedAt: timestamp },
        hasObservationGap: false
      },
      workers: [
        ...base.workers,
        {
          id: "worker-running",
          type: "implementation",
          status: "running",
          startedAt: "2026-06-12T09:59:00.000Z"
        }
      ]
    };
  }
  if (name === "many-agent-events") {
    return {
      ...base,
      events: numberedEvents(64, "Agent timeline fixture event."),
      timelineSummary: {
        latest: timelineFromData({ ...base, events: numberedEvents(64, "Agent timeline fixture event.") })[0]!,
        hasObservationGap: false
      }
    };
  }
  if (name === "long-command-summary") {
    return {
      ...base,
      workers: [{
        id: "worker-long-command",
        type: "implementation",
        status: "succeeded",
        startedAt: timestamp,
        completedAt: timestamp,
        resultArtifactId: "artifact-fixture"
      }],
      events: numberedEvents(12, longSentence("Long command summary with nested output", 16)),
      timelineSummary: {
        latest: timelineFromData({ ...base, events: numberedEvents(12, longSentence("Long command summary with nested output", 16)) })[0]!,
        hasObservationGap: false
      }
    };
  }
  if (name === "empty") {
    const { pr: _pr, ...withoutPr } = base;
    return {
      ...withoutPr,
      current: {
        status: "IDLE",
        nextAction: "Initialize or start the loop."
      },
      gates: [],
      ci: [],
      reviewComments: [],
      workers: [],
      artifacts: [],
      events: [],
      notifications: [],
      recoveryWarnings: [],
      mergeReadiness: {
        state: "not_started",
        ready: false,
        missingConditions: ["no active run"],
        evidence: [],
        carryoverRecords: []
      }
    };
  }
  if (name === "long-content" || name === "mobile-stress" || name === "mobile-table-stress") {
    const extra = longSentence("A very long dashboard field should wrap without forcing horizontal scroll", 12);
    return {
      ...base,
      current: {
        ...base.current,
        nextAction: extra,
        gate: {
          kind: "confirmation_required",
          message: extra,
          details: { reason: extra, path: "docs/local-release-readiness.md" }
        }
      },
      gates: [
        ...base.gates,
        {
          id: "gate-long-confirmation-required",
          kind: "confirmation_required_with_extremely_long_identifier_for_layout_testing",
          status: "open",
          message: extra,
          details: { evidence: extra },
          createdAt: timestamp
        }
      ],
      reviewComments: [
        ...base.reviewComments,
        {
          id: "comment-long",
          author: "reviewer-with-a-very-long-handle-for-layout",
          path: "plugins/autonomous-pr-loop/ui/src/pages/CommandCenter.tsx",
          body: extra,
          actionable: true,
          isResolved: false,
          isOutdated: false,
          status: "open"
        }
      ],
      artifacts: [
        ...base.artifacts,
        artifactRecord("artifact-long", "command-output", "very-long-command-output-name-that-must-not-break-layout.log"),
        ...(name === "mobile-table-stress"
          ? Array.from({ length: 4 }, (_, index) => artifactRecord(`artifact-mobile-${index}`, "command-output", `extremely-long-artifact-path-${index}-that-should-be-readable-in-a-card.log`))
          : [])
      ],
      events: numberedEvents(name === "mobile-table-stress" ? 28 : 18, extra),
      workers: name === "mobile-table-stress"
        ? Array.from({ length: 6 }, (_, index) => ({
          id: `worker-mobile-stress-${index}-with-long-id`,
          type: index % 2 === 0 ? "implementation" : "reviewer",
          status: index % 3 === 0 ? "running" : "succeeded",
          startedAt: timestamp,
          resultArtifactId: `artifact-mobile-${index}`
        }))
        : base.workers,
      notifications: [
        ...base.notifications!,
        {
          id: "note-long",
          severity: "confirmation_required",
          title: "Confirmation required for conditional merge with carryover",
          reason: extra,
          source: "gate",
          sourceId: "gate-long-confirmation-required",
          createdAt: timestamp,
          payload: { evidence: extra }
        }
      ],
      recoveryWarnings: [extra]
    };
  }
  if (name === "stale-gate" || name === "historical-worker-failure" || name === "historical-blocked-run") {
    return historicalFixture(name, base);
  }
  if (name.startsWith("workflow-")) {
    return workflowMissionFixture(name, base);
  }
  if (name.startsWith("generic-")) {
    return genericFixture(name, base);
  }
  if (name === "many-events") {
    return {
      ...base,
      events: numberedEvents(36, "Fixture event generated for scroll and ledger density checks."),
      workers: Array.from({ length: 10 }, (_, index) => ({
        id: `worker-${index + 1}`,
        type: index % 2 === 0 ? "implementation" : "reviewer",
        status: index % 3 === 0 ? "running" : "succeeded",
        startedAt: timestamp,
        resultArtifactId: `artifact-${index + 1}`
      })),
      artifacts: Array.from({ length: 10 }, (_, index) => artifactRecord(`artifact-${index + 1}`, "log", `worker-${index + 1}.log`))
    };
  }
  return base;
}

function historicalFixture(name: FixtureName, base: MissionControlData): MissionControlData {
  const historicalGate = {
    id: "gate-historical-worker-failed",
    kind: "worker_failed",
    status: "open",
    message: "Worker failed in a previous run; a newer run has already superseded it.",
    details: { workerId: "worker-old-failed", exitCode: 1 },
    createdAt: "2026-06-12T08:30:00.000Z",
    activity: "historical" as const,
    activityReason: name === "stale-gate" ? "overridden_by_reality" : "historical_run"
  };
  const activeGate = {
    id: "gate-active-confirmation",
    kind: "confirmation_required",
    status: "open",
    message: "Current run needs a fresh operator decision.",
    createdAt: timestamp,
    activity: "active" as const,
    activityReason: "current_run"
  };
  const staleWorker = {
    id: "worker-old-failed",
    type: "implementation",
    status: "failed",
    startedAt: "2026-06-12T08:10:00.000Z",
    completedAt: "2026-06-12T08:25:00.000Z",
    error: "Old worker failed before the current run started.",
    activity: "historical" as const,
    activityReason: "stale_worker_failure"
  };
  const current = name === "historical-blocked-run"
    ? {
      status: "READY",
      nextAction: "Historical gates are visible for recovery, but the current run is not blocked.",
      run: {
        id: "run-current-ready",
        status: "READY",
        currentState: "MERGE",
        branch: "codex/current-ready",
        worktreeClean: true,
        updatedAt: timestamp,
        startedAt: "2026-06-12T09:30:00.000Z"
      }
    }
    : {
      ...base.current,
      status: "BLOCKED",
      nextAction: "Handle the current active gate; historical gates are shown separately.",
      gate: { kind: activeGate.kind, message: activeGate.message },
      ...(base.current.run ? {
        run: {
          ...base.current.run,
          id: "run-current-active",
          status: "RUNNING",
          startedAt: "2026-06-12T09:30:00.000Z"
        }
      } : {})
    };
  return {
    ...base,
    current,
    gates: name === "historical-blocked-run" ? [historicalGate] : [activeGate, historicalGate],
    workers: name === "stale-gate"
      ? base.workers
      : [staleWorker, ...base.workers.map((worker) => ({ ...worker, activity: "active" as const, activityReason: "current_run" }))],
    recoveryWarnings: [
      "1 historical open gate belongs to an inactive or superseded run.",
      ...(name === "historical-worker-failure" ? ["1 stale worker failure is from an older run."] : [])
    ],
    notifications: name === "historical-blocked-run" ? [] : [{
      id: "note-active-confirmation",
      severity: "confirmation_required",
      title: activeGate.kind,
      reason: activeGate.message,
      source: "gate",
      sourceId: activeGate.id,
      createdAt: timestamp
    }]
  };
}

function workflowMissionFixture(name: FixtureName, base: MissionControlData): MissionControlData {
  const currentStateByName: Partial<Record<FixtureName, string>> = {
    "workflow-build-active": "IMPLEMENT",
    "workflow-verify-failed": "SELF_CHECK",
    "workflow-pr-published": "COMMIT_PUSH_PR",
    "workflow-review-active": "WAIT_REVIEW_OR_CI",
    "workflow-merge-blocked": "READY_TO_MERGE",
    "workflow-cleanup-active": "MERGE",
    "workflow-unknown-state": "UNEXPECTED_STATE"
  };
  const currentState = currentStateByName[name] ?? "IMPLEMENT";
  const pr = ["workflow-pr-published", "workflow-review-active", "workflow-merge-blocked", "workflow-cleanup-active"].includes(name)
    ? { ...base.pr!, prNumber: 49, url: "https://github.com/example/fixture/pull/49", state: name === "workflow-cleanup-active" ? "MERGED" : "OPEN" }
    : undefined;
  const ci = name === "workflow-verify-failed"
    ? [{ id: "ci-failed", name: "Node 22.x", status: "completed", conclusion: "failure", observedAt: timestamp }]
    : name === "workflow-merge-blocked"
      ? [{ id: "ci-pending", name: "Node 24.x", status: "queued", observedAt: timestamp }]
      : base.ci;
  return {
    ...base,
    current: {
      ...base.current,
      status: name === "workflow-merge-blocked" ? "BLOCKED" : "RUNNING",
      nextAction: "Observe the PR delivery workflow stage.",
      ...(base.current.run ? { run: { ...base.current.run, currentState, status: name === "workflow-merge-blocked" ? "BLOCKED" : "RUNNING" } } : {})
    },
    ...(pr ? { pr } : {}),
    ci,
    reviewComments: name === "workflow-review-active" ? base.reviewComments : [],
    gates: name === "workflow-merge-blocked"
      ? [{ id: "gate-ci-missing", kind: "ci_required_checks_missing", status: "open", message: "Required CI check is still pending.", createdAt: timestamp, activity: "active", activityReason: "current_run" }]
      : [],
    events: [
      ...base.events,
      eventRecord("event-workflow-plan", 20, "workflow_stage_evidence", "Plan accepted for PR O.", "plan"),
      eventRecord("event-workflow-build", 21, "workflow_stage_evidence", "Build stage implementation is active.", "build"),
      ...(name === "workflow-review-active" ? [eventRecord("event-workflow-review", 22, "workflow_stage_evidence", "Claude ACP review evidence source is unknown in fixture.", "review")] : []),
      ...(name === "workflow-cleanup-active" ? [eventRecord("event-workflow-cleanup", 23, "workflow_stage_evidence", "PR merged; cleanup is active.", "cleanup")] : [])
    ],
    ...(name === "workflow-merge-blocked"
      ? { mergeReadiness: { state: "missing_evidence", ready: false, missingConditions: ["required check green: Node 24.x"], evidence: ["review report posted"], carryoverRecords: [] } }
      : base.mergeReadiness ? { mergeReadiness: base.mergeReadiness } : {})
  };
}

function genericFixture(name: FixtureName, base: MissionControlData): MissionControlData {
  const genericState = name === "generic-completed"
    ? "COMPLETE"
    : name === "generic-deliverable-ready"
      ? "DELIVER"
      : name === "generic-scope-change"
        ? "EXECUTE_STEP"
        : "HUMAN_GATE";
  const gateKind = name === "generic-scope-change"
    ? "generic_scope_change_requested"
    : name === "generic-human-gate"
      ? "generic_human_gate"
      : "generic_goal_needs_confirmation";
  const gateDetails = name === "generic-scope-change"
    ? { allowedNextStates: ["PLAN_WORK", "STOPPED"], defaultNextState: "PLAN_WORK", state: "EXECUTE_STEP" }
    : { allowedNextStates: ["DELIVER", "EXECUTE_STEP", "STOPPED"], defaultNextState: "DELIVER", state: "HUMAN_GATE" };
  const blockedByGate = name === "generic-human-gate" || name === "generic-scope-change";
  const { pr: _pr, ...withoutPr } = base;
  return {
    ...withoutPr,
    current: {
      status: name === "generic-completed" ? "READY" : blockedByGate ? "BLOCKED" : "RUNNING",
      nextAction: name === "generic-completed"
        ? "Generic workflow completed and deliverable is ready for audit."
        : blockedByGate
          ? "Operator confirmation is needed before the generic workflow continues."
          : "Package the deliverable and prepare completion evidence.",
      run: {
        id: "run-generic-fixture",
        status: name === "generic-completed" ? "READY" : blockedByGate ? "BLOCKED" : "RUNNING",
        currentState: genericState,
        branch: "main",
        worktreeClean: true,
        updatedAt: timestamp,
        startedAt: "2026-06-12T09:00:00.000Z"
      },
      ...(blockedByGate ? { gate: { kind: gateKind, message: "Generic loop needs operator confirmation." } } : {})
    },
    gates: blockedByGate ? [{
      id: `gate-${gateKind}`,
      kind: gateKind,
      status: "open",
      message: "Generic loop needs operator confirmation.",
      details: gateDetails,
      createdAt: timestamp
    }] : [],
    workers: [{
      id: "worker-generic-deliverable",
      type: "implementation",
      status: name === "generic-completed" || name === "generic-deliverable-ready" ? "succeeded" : "running",
      startedAt: timestamp,
      resultArtifactId: "artifact-generic-deliverable"
    }],
    artifacts: [
      artifactRecord("artifact-generic-plan", "dry-run-plan", "generic-loop-plan.md"),
      artifactRecord("artifact-generic-deliverable", "worker-result", "repo-hygiene-audit.md")
    ],
    events: numberedEvents(10, "Generic loop fixture event."),
    timelineSummary: {
      latest: timelineFromData({ ...base, events: numberedEvents(10, "Generic loop fixture event.") })[0]!,
      ...(name === "generic-completed" ? {} : { activeWorker: { id: "worker-generic-deliverable", type: "implementation", status: "running", startedAt: timestamp } }),
      hasObservationGap: false
    },
    mergeReadiness: {
      state: "not_applicable",
      ready: name === "generic-completed" || name === "generic-deliverable-ready",
      missingConditions: blockedByGate ? ["human confirmation"] : [],
      evidence: ["context collected", "plan reviewed", "deliverable artifact registered"],
      carryoverRecords: []
    },
    notifications: blockedByGate ? [{
      id: `generic:${gateKind}`,
      severity: "confirmation_required",
      title: gateKind,
      reason: "Generic loop needs operator confirmation.",
      source: "gate",
      sourceId: `gate-${gateKind}`,
      createdAt: timestamp
    }] : [],
    profile: genericProfileFixture(genericState),
    selection: {
      mode: "generic_loop",
      ambiguous: false,
      loopShape: "generic-loop",
      workflowProfile: "repo_hygiene_loop",
      reason: "Generic loop fixture does not select a PR.",
      evidence: ["Configured loopShape=generic-loop."]
    },
    plan: {
      convention: base.plan!.convention,
      currentMilestone: base.plan!.currentMilestone,
      completed: base.plan!.completed,
      candidates: [],
      ambiguous: false,
      evidence: ["Generic loop does not use PR spec selection."]
    },
    recoveryWarnings: []
  };
}

function baseFixture(): MissionControlData {
  return {
    current: {
      status: "BLOCKED",
      nextAction: "Review gate evidence, then approve or reject with a note.",
      run: {
        id: "run-fixture",
        status: "BLOCKED",
        currentState: "WAIT_REVIEW_OR_CI",
        branch: "codex/pr-h-bilingual-i18n",
        worktreeClean: true,
        updatedAt: timestamp,
        startedAt: "2026-06-12T09:00:00.000Z"
      },
      gate: { kind: "policy_violation", message: "Self check evidence is required before merge." }
    },
    gates: [{
      id: "gate-fixture",
      kind: "policy_violation",
      status: "open",
      message: "Self check evidence is required before merge.",
      createdAt: timestamp
    }],
    pr: {
      prNumber: 8,
      url: "https://github.test/pr/8",
      branch: "codex/pr-h-bilingual-i18n",
      state: "OPEN",
      draft: false,
      updatedAt: timestamp
    },
    ci: [{
      id: "ci-fixture",
      name: "ci",
      status: "completed",
      conclusion: "success",
      observedAt: timestamp
    }],
    reviewComments: [{
      id: "comment-fixture",
      author: "reviewer",
      path: "plugins/autonomous-pr-loop/ui/src/app.tsx",
      body: "Carry forward low priority visual polish only after current PR scope is complete.",
      actionable: true,
      isResolved: false,
      isOutdated: false,
      status: "open"
    }],
    workers: [{
      id: "worker-fixture",
      type: "reviewer",
      status: "succeeded",
      startedAt: timestamp,
      completedAt: timestamp,
      resultArtifactId: "artifact-fixture"
    }],
    artifacts: [artifactRecord("artifact-fixture", "dry-run-plan", "dry-run-plan.json")],
    events: numberedEvents(8, "Dashboard fixture event."),
    decisions: [{ id: "decision-fixture", kind: "gate_approved", message: "Fixture decision.", createdAt: timestamp }],
    timelineSummary: {
      hasObservationGap: false
    },
    autonomy: {
      autonomyMode: "autonomous_until_gate",
      mergeMode: "conditional",
      notifyMode: "important_only",
      reviewHandling: "fix_scoped_and_carry_forward",
      summary: "Agent advances under configured workflow boundaries; operator watches and intervenes only on material gates.",
      notifyWhen: ["blocked", "confirmation_required", "policy_violation"],
      requiresConfirmation: ["dangerous policy changes", "merge without complete evidence"],
      allowConditionalMerge: true
    },
    mergeReadiness: {
      state: "missing_evidence",
      ready: false,
      missingConditions: ["review approval observed"],
      evidence: ["scope guard passed", "ci green"],
      carryoverRecords: ["docs/local-release-readiness.md"]
    },
    notifications: [{
      id: "note-fixture",
      severity: "blocked",
      title: "policy_violation",
      reason: "A policy guard blocked unsafe progress.",
      source: "gate",
      sourceId: "gate-fixture",
      createdAt: timestamp
    }],
    profile: profileFixture("WAIT_REVIEW_OR_CI"),
    plan: {
      convention: "PR specs use pr-<letter> filenames.",
      currentMilestone: "PR H",
      selectedNext: {
        id: "PR H",
        title: "PR H Bilingual i18n",
        status: "next",
        file: "docs/local-release-readiness.md",
        dependsOn: ["PR G"],
        issueRefs: [],
        whySelected: "Add bilingual dashboard and CLI i18n."
      },
      completed: [],
      candidates: [],
      ambiguous: false,
      evidence: ["Parsed PR H SPEC.", "PR G is complete."]
    },
    recoveryWarnings: []
  };
}

function timelineFromData(data: Pick<MissionControlData, "current" | "events" | "workers">): AgentTimelineEntry[] {
  const runId = data.current.run?.id;
  const eventEntries = data.events.map((event) => ({
    timelineSeq: event.seq,
    occurredAt: event.createdAt,
    cursor: btoa(JSON.stringify({ timelineSeq: event.seq })),
    source: "event" as const,
    kind: event.kind,
    ...(runId ? { runId } : {}),
    ...(event.stateAfter ? { status: event.stateAfter } : {}),
    title: event.kind,
    summary: event.message,
    createdAt: event.createdAt,
    rawRef: { table: "events", id: event.id, seq: event.seq }
  }));
  const workerEntries = data.workers.map((worker, index) => ({
    timelineSeq: 100 + index,
    occurredAt: worker.startedAt,
    cursor: btoa(JSON.stringify({ timelineSeq: 100 + index })),
    source: "worker" as const,
    kind: worker.type,
    ...(runId ? { runId } : {}),
    workerId: worker.id,
    title: `${worker.type} worker ${worker.status}`,
    summary: worker.error ?? worker.resultArtifactId ?? worker.status,
    status: worker.status,
    createdAt: worker.startedAt,
    rawRef: { table: "workers", id: `${worker.id}:${worker.status}` }
  }));
  const workerEventEntries = data.workers.flatMap((worker, workerIndex) =>
    workerEventFixtures(worker.id).map((event, eventIndex) => {
      const timelineSeq = 200 + workerIndex * 10 + eventIndex;
      return {
        timelineSeq,
        occurredAt: worker.completedAt ?? worker.startedAt,
        cursor: btoa(JSON.stringify({ timelineSeq })),
        source: "worker_event" as const,
        kind: event.kind,
        ...(runId ? { runId } : {}),
        workerId: worker.id,
        title: event.title,
        summary: event.summary,
        status: worker.status,
        createdAt: worker.completedAt ?? worker.startedAt,
        rawRef: { table: "worker_events", id: `${worker.id}-${event.kind}`, seq: eventIndex + 1 }
      };
    })
  );
  return [...workerEventEntries, ...workerEntries, ...eventEntries].sort((a, b) =>
    Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.timelineSeq - a.timelineSeq
  );
}

function workerEventFixtures(workerId: string): Array<{ kind: string; title: string; summary: string }> {
  if (workerId !== "worker-running") {
    return [{
      kind: "command_execution",
      title: "command_execution",
      summary: "pnpm test completed with fixture output"
    }];
  }
  return [
    { kind: "command_execution", title: "command_execution", summary: "pnpm test is running" },
    { kind: "file_change", title: "file_change", summary: "src/index.ts updated" },
    { kind: "mcp_tool_call", title: "mcp_tool_call", summary: "gitnexus impact query completed" },
    { kind: "web_search", title: "web_search", summary: "searched official docs" },
    { kind: "todo_list", title: "todo_list", summary: "3 todos, 1 in progress" },
    { kind: "error", title: "error", summary: "worker command failed with exit code 1" }
  ];
}

function policyConfigFixture(): ConfigSnapshot {
  return {
    path: ".agent-loop/config.json",
    hash: "fixture-hash",
    mtimeMs: 1,
    config: {
      repoId: "example/fixture",
      locale: "zh-CN",
      baseBranch: "main",
      branchPrefix: "codex/",
      plansDir: "docs/plans",
      gitnexusRequired: true,
      requiredChecks: ["ci"],
      requireReviewApproval: true,
      autonomyMode: "autonomous_until_gate",
      mergeMode: "conditional",
      notifyMode: "important_only",
      reviewHandling: "fix_scoped_and_carry_forward",
      carryoverTarget: "docs/local-release-readiness.md",
      allowAutoMerge: false,
      maxReviewFixRounds: 3,
      maxTestFixRounds: 2,
      maxCiReruns: 1,
      protectedPaths: [".agent-loop/**"]
    }
  };
}

function dryRunFixture(data: MissionControlData): DryRunPreviewData {
  const nextPr = data.plan?.selectedNext;
  return {
    ...(nextPr ? { nextPr } : {}),
    branchName: "codex/pr-h-bilingual-i18n",
    commandsPlanned: ["pnpm test", "pnpm lint", "pnpm agent-loop dashboard --help"],
    workerType: "implementation",
    possibleGates: ["policy_violation", "confirmation_required"],
    missingConditions: data.mergeReadiness?.missingConditions ?? [],
    filesLikelyTouched: ["plugins/autonomous-pr-loop/ui", "docs/checklists"],
    autonomyForecast: data.autonomy!,
    mergeForecast: data.mergeReadiness!,
    profile: data.profile ?? profileFixture(),
    workflowStages: workflowStageFixtures()
  };
}

const workflowStageOrder: Array<{ id: WorkflowStageId; label: string }> = [
  { id: "work_item", label: "Work Item" },
  { id: "plan", label: "Plan" },
  { id: "build", label: "Build" },
  { id: "verify", label: "Verify" },
  { id: "pr", label: "PR" },
  { id: "review", label: "Review" },
  { id: "merge_readiness", label: "Merge Readiness" },
  { id: "cleanup", label: "Cleanup" }
];

function workflowBoardFixture(data: MissionControlData): WorkflowBoard {
  const state = data.current.run?.currentState;
  const unsupported = data.profile?.loopShape === "generic-loop";
  const unknown = Boolean(state && !["SYNC_MAIN", "DISCOVER_PROGRESS", "SELECT_NEXT_PR", "WRITE_SPEC", "CREATE_BRANCH", "IMPLEMENT", "SELF_CHECK", "COMMIT_PUSH_PR", "WAIT_REVIEW_OR_CI", "FIX_REVIEW", "PUSH_FIX", "READY_TO_MERGE", "MERGE", "BLOCKED", "STOPPED"].includes(state));
  const activeStageId = unsupported || unknown ? "work_item" : stageForFixtureState(state, data);
  const stages = workflowStageOrder.map((stage, index) => fixtureStage(stage, index, activeStageId, data));
  return {
    runId: data.current.run?.id,
    mode: unsupported ? "unsupported" : unknown ? "unknown_state" : data.current.run ? "active" : "empty",
    activeStageId,
    selectedStageId: activeStageId,
    workItem: {
      runId: data.current.run?.id,
      branch: data.current.run?.branch,
      currentState: data.current.run?.currentState,
      status: data.current.status,
      loopShape: data.profile?.loopShape ?? "pr-loop",
      workflowProfile: data.profile?.workflowProfile,
      prUrl: data.pr?.url,
      prNumber: data.pr?.prNumber,
      lastUpdate: data.current.run?.updatedAt,
      activeGate: data.gates.find((gate) => gate.status === "open")?.kind,
      readOnly: false
    },
    stages,
    evidenceRefs: data.events.map((event) => ({
      id: event.id,
      kind: "event",
      label: event.kind,
      summary: event.message,
      interaction: "drill_down_link" as const,
      drillDownTarget: { page: "Event Ledger" },
      createdAt: event.createdAt,
      source: fixtureEventStage(event)
    })),
    reviewReports: [
      { id: "review-claude", agent: "Claude ACP", status: "unknown", prComment: "unknown", severitySummary: "no requirement source", requirement: "unknown", progress: "unknown", result: "unknown", reason: "No required Claude review source in fixture.", evidenceRefIds: [] },
      { id: "review-agy", agent: "AGY/Gemini", status: "unknown", prComment: "unknown", severitySummary: "no requirement source", requirement: "unknown", progress: "unknown", result: "unknown", reason: "No required AGY/Gemini review source in fixture.", evidenceRefIds: [] }
    ],
    verificationChecks: [
      { id: "lint", label: "Lint", status: "unknown", evidence: "no appended evidence", owner: "Codex" },
      { id: "tests", label: "Tests", status: data.ci.some((check) => check.conclusion === "failure") ? "failed" : "unknown", evidence: data.ci[0]?.conclusion ?? "no appended evidence", owner: "Codex" },
      { id: "gitnexus", label: "GitNexus detect", status: "unknown", evidence: "no appended evidence", owner: "GitNexus" }
    ],
    mergeReadinessChecks: [
      ...(data.mergeReadiness?.evidence ?? []).map((item, index) => ({ id: `merge-ok-${index}`, label: item, status: "passed" as const, evidence: item, owner: "Codex" })),
      ...(data.mergeReadiness?.missingConditions ?? []).map((item, index) => ({ id: `merge-missing-${index}`, label: item, status: "blocked" as const, evidence: item, owner: "Codex" })),
      { id: "severity", label: "No unresolved P0/P1/P2", status: "unknown", evidence: "no severity evidence", owner: "Reviewer" }
    ],
    cleanupChecks: [
      { id: "merged", label: "PR merged", status: data.pr?.state === "MERGED" ? "passed" : "pending", evidence: data.pr?.state ?? "no PR", owner: "GitHub" },
      { id: "clean", label: "Worktree clean", status: data.current.run?.worktreeClean ? "passed" : "unknown", evidence: String(data.current.run?.worktreeClean ?? "unknown"), owner: "Codex" }
    ],
    appendEvidenceEnabled: !unsupported && !unknown && Boolean(data.current.run),
    ...(unsupported ? { message: "PR O observes only pr-loop runs." } : unknown ? { message: `Unknown PR loop state: ${state}` } : {})
  };
}

function fixtureStage(stage: { id: WorkflowStageId; label: string }, index: number, activeStageId: WorkflowStageId, data: MissionControlData): WorkflowBoardStage {
  const activeIndex = workflowStageOrder.findIndex((item) => item.id === activeStageId);
  const baseStatus: WorkflowStageStatus = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
  const blocked = data.gates.some((gate) => gate.status === "open") && stage.id === activeStageId;
  const failed = stage.id === "verify" && data.ci.some((check) => check.conclusion === "failure");
  const status: WorkflowStageStatus = blocked ? "blocked" : failed ? "failed" : baseStatus;
  return {
    id: stage.id,
    label: stage.label,
    status,
    actorChips: [{ actor: "codex", label: "Codex", status }],
    evidenceCounts: { events: data.events.filter((event) => fixtureEventStage(event) === stage.id).length, artifacts: 0, gates: blocked ? 1 : 0, prComments: stage.id === "review" ? data.reviewComments.length : 0, gitnexus: 0, browser: 0, ci: stage.id === "merge_readiness" ? data.ci.length : 0, reports: 0 },
    substages: [{ id: `${stage.id}-summary`, label: `${stage.label} summary`, status, evidenceCounts: { events: 0, artifacts: 0, gates: 0, prComments: 0, gitnexus: 0, browser: 0, ci: 0, reports: 0 }, latestEvidence: [], requiredEvidence: [] }],
    latestAction: { label: "Inspect stage evidence", safeToRunFromDashboard: false, requiresConfirmation: false },
    blockers: blocked ? [{ id: data.gates[0]?.id ?? "gate", severity: "ci", title: data.gates[0]?.kind ?? "gate", reason: data.gates[0]?.message ?? "blocked", owner: "Codex", nextAction: "Resolve the blocking gate.", evidenceRefIds: [] }] : [],
    nextAction: "Inspect stage evidence"
  };
}

function stageForFixtureState(state: string | undefined, data: MissionControlData): WorkflowStageId {
  if (state === "IMPLEMENT" || state === "CREATE_BRANCH") return "build";
  if (state === "SELF_CHECK") return "verify";
  if (state === "COMMIT_PUSH_PR" || state === "PUSH_FIX") return "pr";
  if (state === "WAIT_REVIEW_OR_CI" || state === "FIX_REVIEW") return data.reviewComments.length > 0 ? "review" : "merge_readiness";
  if (state === "READY_TO_MERGE") return "merge_readiness";
  if (state === "MERGE") return "cleanup";
  if (state === "WRITE_SPEC") return "plan";
  return "work_item";
}

function fixtureEventStage(event: EventSummary): WorkflowStageId {
  const payload = event as EventSummary & { payload?: { stageId?: WorkflowStageId } };
  if (payload.payload?.stageId) return payload.payload.stageId;
  const message = event.message.toLowerCase();
  if (message.includes("cleanup")) return "cleanup";
  if (message.includes("review")) return "review";
  if (message.includes("build")) return "build";
  if (message.includes("plan")) return "plan";
  return "work_item";
}

function profileFixture(currentState?: string): NonNullable<MissionControlData["profile"]> {
  const roleMapping = [
    {
      state: "WRITE_SPEC",
      alias: "planner",
      label: "Planner",
      workerType: "planner",
      sandbox: "workspace-write"
    },
    {
      state: "IMPLEMENT",
      alias: "implementer",
      label: "Implementer",
      workerType: "implementation",
      sandbox: "workspace-write"
    },
    {
      state: "FIX_REVIEW",
      alias: "review-fix",
      label: "Review fix",
      workerType: "review-fix",
      sandbox: "workspace-write"
    },
    {
      state: "SELF_CHECK",
      alias: "reviewer",
      label: "Reviewer",
      workerType: "reviewer",
      sandbox: "read-only"
    }
  ];
  const currentRole = currentState ? roleMapping.find((role) => role.state === currentState) : undefined;
  return {
    loopShape: "pr-loop",
    workflowProfile: "default_pr_loop",
    workflowLabel: "Default PR loop",
    workflowDescription: "The HOLO-Codex PR delivery behavior with explicit profile audit.",
    roleProfile: "default_pr_roles",
    ...(currentRole ? { currentRole } : {}),
    roleMapping,
    autonomyBoundary: "Autonomous until configured gates, policy violations, CI/review blockers, or unsafe git actions.",
    handoffSummary: "Follow the selected PR spec and hand off concise evidence to the next role.",
    validationPosture: "Use configured lint, tests, GitNexus, CI, and review gates.",
    likelyGates: ["ambiguous_next_pr", "worker_failed", "ci_required_checks_missing", "merge_requires_confirmation"],
    availableWorkflows: [
      { id: "default_pr_loop", label: "Default PR loop", description: "The HOLO-Codex PR delivery behavior with explicit profile audit." },
      { id: "docs_only_loop", label: "Docs-only loop", description: "Bias validation toward documentation consistency while preserving policy and configured checks." },
      { id: "review_fix_loop", label: "Review-fix loop", description: "Focus on scoped PR review repair and carryover discipline." },
      { id: "release_ready_loop", label: "Release-ready loop", description: "Tighten merge readiness explanation without adding a release-manager worker." }
    ],
    availableRoleProfiles: [
      { id: "default_pr_roles", label: "Default PR roles", description: "Readable role aliases mapped onto the existing PR loop worker types." }
    ]
  };
}

function genericProfileFixture(currentState: string): NonNullable<MissionControlData["profile"]> {
  const roleMapping = [
    {
      state: "DEFINE_GOAL",
      alias: "planner",
      label: "Goal planner",
      workerType: "planner",
      sandbox: "read-only"
    },
    {
      state: "COLLECT_CONTEXT",
      alias: "planner",
      label: "Context collector",
      workerType: "planner",
      sandbox: "read-only"
    },
    {
      state: "PLAN_WORK",
      alias: "planner",
      label: "Work planner",
      workerType: "planner",
      sandbox: "read-only"
    },
    {
      state: "EXECUTE_STEP",
      alias: "implementer",
      label: "Executor",
      workerType: "implementation",
      sandbox: "workspace-write"
    },
    {
      state: "SELF_REVIEW",
      alias: "reviewer",
      label: "Reviewer",
      workerType: "reviewer",
      sandbox: "read-only"
    },
    {
      state: "DELIVER",
      alias: "implementer",
      label: "Deliverer",
      workerType: "implementation",
      sandbox: "workspace-write"
    }
  ];
  const currentRole = roleMapping.find((role) => role.state === currentState);
  return {
    loopShape: "generic-loop",
    workflowProfile: "repo_hygiene_loop",
    workflowLabel: "Repo hygiene loop",
    workflowDescription: "Audit repository hygiene and produce a scoped report artifact.",
    roleProfile: "default_pr_roles",
    ...(currentRole ? { currentRole } : {}),
    roleMapping,
    autonomyBoundary: "Read-only until execute/deliver states; write access limited by profile allowed roots.",
    handoffSummary: "List inspected areas, hygiene findings, safe fixes, deferred risks, and deliverable path.",
    validationPosture: "Use profile checklist, self-review, human gate, and audit timeline.",
    likelyGates: ["generic_goal_needs_confirmation", "generic_human_gate", "generic_scope_change_requested", "worker_failed"],
    lifecycleKind: "generic",
    expectedDeliverable: "Repo hygiene audit report",
    allowedWriteRoots: ["docs", "reports"],
    availableWorkflows: [
      { id: "research_report_loop", label: "Research report loop", description: "Gather sources and deliver a report." },
      { id: "document_preparation_loop", label: "Document preparation loop", description: "Prepare a structured document artifact." },
      { id: "repo_hygiene_loop", label: "Repo hygiene loop", description: "Audit and clean repository hygiene tasks." },
      { id: "weekly_review_loop", label: "Weekly review loop", description: "Collect context and produce a weekly review deliverable." },
      { id: "data_extraction_loop", label: "Data extraction loop", description: "Extract data and request human approval before delivery." }
    ],
    availableRoleProfiles: [
      { id: "default_pr_roles", label: "Default PR roles", description: "Readable role aliases mapped onto the existing worker types." }
    ]
  };
}

function workflowStageFixtures(): NonNullable<DryRunPreviewData["workflowStages"]> {
  return [
    { state: "SELECT_NEXT_PR", gateExpected: true },
    { state: "WRITE_SPEC", roleAlias: "planner", workerType: "planner", gateExpected: false },
    { state: "IMPLEMENT", roleAlias: "implementer", workerType: "implementation", gateExpected: false },
    { state: "SELF_CHECK", roleAlias: "reviewer", workerType: "reviewer", gateExpected: false },
    { state: "WAIT_REVIEW_OR_CI", gateExpected: true },
    { state: "FIX_REVIEW", roleAlias: "review-fix", workerType: "review-fix", gateExpected: false },
    { state: "MERGE", gateExpected: false }
  ];
}

function numberedEvents(count: number, message: string): EventSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `event-${index + 1}`,
    seq: index + 1,
    kind: index % 3 === 0 ? "scope.guard.checked" : "dashboard.fixture",
    message,
    stateBefore: "IMPLEMENT",
    stateAfter: index % 3 === 0 ? "SELF_CHECK" : "WAIT_REVIEW_OR_CI",
    createdAt: timestamp,
    artifactIds: index % 4 === 0 ? ["artifact-fixture"] : []
  }));
}

function eventRecord(id: string, seq: number, kind: string, message: string, stageId: WorkflowStageId): EventSummary & { payload: { stageId: WorkflowStageId } } {
  return {
    id,
    seq,
    kind,
    message,
    stateBefore: "IMPLEMENT",
    stateAfter: "SELF_CHECK",
    createdAt: timestamp,
    payload: { stageId }
  };
}

function artifactRecord(id: string, kind: ArtifactSummary["kind"], name: string): ArtifactSummary {
  return {
    id,
    kind,
    name,
    path: `.agent-loop/artifacts/run-fixture/${kind}/${name}`,
    createdAt: timestamp
  };
}

function longSentence(prefix: string, repeats: number): string {
  return Array.from({ length: repeats }, (_, index) => `${prefix} segment-${index + 1}`).join(" / ");
}
