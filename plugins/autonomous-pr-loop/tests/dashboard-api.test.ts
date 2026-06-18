import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeArtifact } from "../core/artifacts.js";
import { withConfigDefaults } from "../core/config.js";
import { createControllerHost } from "../core/controller-host.js";
import { startDashboardServer, type DashboardServerHandle } from "../core/dashboard-server.js";
import { bindDeliveryWorkItem } from "../core/delivery-work-item.js";
import { AgentLoopError } from "../core/errors.js";
import { blockRunForTerminalWorker } from "../core/state-machine.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

const handles: DashboardServerHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
  cleanupTempRepos();
  delete process.env.AGENT_LOOP_MCP_TOKEN;
});

describe("dashboard API", () => {
  it("aggregates mission control data through the shared controller", async () => {
    const repoRoot = seededRepo();
    const host = createControllerHost({ repoRoot, mcpToken: "test-token" });
    const server = await startDashboardServer({
      repoRoot,
      token: "test-token",
      serveUi: false,
      controllerHost: host
    });
    handles.push(server);
    expect(server.url).toBe(`${base(server)}/`);
    expect(server.url).not.toContain("test-token");

    const response = await fetch(`${base(server)}/api/mission-control`);
    const payload = await response.json() as {
      ok: boolean;
      data: {
        gates: unknown[];
        ci: unknown[];
        reviewComments: unknown[];
        workers: unknown[];
        profile?: { loopShape: string; workflowProfile: string; roleProfile: string };
      };
    };
    const dryRunResponse = await fetch(`${base(server)}/api/dry-run-preview`);
    const dryRun = await dryRunResponse.json() as {
      ok: boolean;
      data: {
        profile?: { loopShape: string; workflowProfile: string; roleProfile: string };
        workflowStages?: Array<{ state: string; role?: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(payload.ok).toBe(true);
    expect(payload.data.gates).toHaveLength(1);
    expect(payload.data.ci).toHaveLength(1);
    expect(payload.data.reviewComments).toHaveLength(1);
    expect(payload.data.workers).toHaveLength(1);
    expect(payload.data.profile).toMatchObject({
      loopShape: "pr-loop",
      workflowProfile: "default_pr_loop",
      roleProfile: "default_pr_roles"
    });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.data.profile).toMatchObject({
      loopShape: "pr-loop",
      workflowProfile: "default_pr_loop",
      roleProfile: "default_pr_roles"
    });
    expect(dryRun.data.workflowStages?.map((stage) => stage.state)).toContain("IMPLEMENT");
  });

  it("serves workflow board and appends stage evidence through guarded API", async () => {
    const repoRoot = seededRepo();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);
    const beforeStorage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const beforeGateCount = beforeStorage.listGates().length;
    beforeStorage.close();

    const boardResponse = await fetch(`${base(server)}/api/workflow-board`);
    const board = await boardResponse.json() as {
      ok: boolean;
      data: { activeStageId: string; stages: Array<{ id: string; status: string }>; appendEvidenceEnabled: boolean };
    };
    const noToken = await fetch(`${base(server)}/api/workflow-board/evidence`, {
      method: "POST",
      body: JSON.stringify({ stageId: "build", summary: "Evidence without token" })
    });
    const badOrigin = await fetch(`${base(server)}/api/workflow-board/evidence`, {
      method: "POST",
      headers: { "x-agent-loop-token": "test-token", origin: "http://evil.test" },
      body: JSON.stringify({ stageId: "build", summary: "Bad origin" })
    });
    const invalid = await fetch(`${base(server)}/api/workflow-board/evidence`, {
      method: "POST",
      headers: { "x-agent-loop-token": "test-token" },
      body: JSON.stringify({ stageId: "not-a-stage", summary: "Invalid stage" })
    });
    const invalidStatus = await fetch(`${base(server)}/api/workflow-board/evidence`, {
      method: "POST",
      headers: { "x-agent-loop-token": "test-token" },
      body: JSON.stringify({ stageId: "build", status: "almost_done", summary: "Invalid status" })
    });
    const invalidReview = await fetch(`${base(server)}/api/workflow-board/evidence`, {
      method: "POST",
      headers: { "x-agent-loop-token": "test-token" },
      body: JSON.stringify({
        stageId: "review",
        summary: "Invalid complete review.",
        review: {
          reviewer: "claude_acp",
          requirement: "required",
          progress: "complete",
          result: "pass",
          severitySummary: "none"
        }
      })
    });
    const invalidJson = await fetch(`${base(server)}/api/workflow-board/evidence`, {
      method: "POST",
      headers: { "x-agent-loop-token": "test-token" },
      body: "{"
    });
    const invalidJsonPayload = await invalidJson.json() as { ok: boolean; error?: { code: string } };
    const append = await fetch(`${base(server)}/api/workflow-board/evidence`, {
      method: "POST",
      headers: { "x-agent-loop-token": "test-token" },
      body: JSON.stringify({ stageId: "build", summary: "Implemented workflow board shell.", source: "dashboard" })
    });
    const reviewAppend = await fetch(`${base(server)}/api/workflow-board/evidence`, {
      method: "POST",
      headers: { "x-agent-loop-token": "test-token" },
      body: JSON.stringify({
        stageId: "review",
        substageId: "claude_acp_review",
        summary: "Claude ACP review posted PASS.",
        review: {
          reviewer: "claude_acp",
          requirement: "required",
          progress: "complete",
          result: "pass",
          severitySummary: "none",
          commentUrl: "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#pullrequestreview-77",
          commentId: "77"
        }
      })
    });
    const appendPayload = await append.json() as { ok: boolean; data: { event: { kind: string; message: string } } };
    const reviewAppendPayload = await reviewAppend.json() as { ok: boolean; data: { event: { payload: unknown } } };
    const afterBoard = await (await fetch(`${base(server)}/api/workflow-board`)).json() as { data: { evidenceRefs: Array<{ summary: string; source: string }> } };
    const afterStorage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const afterGateCount = afterStorage.listGates().length;
    const run = afterStorage.getCurrentRun();
    if (!run) throw new Error("expected seeded run");
    afterStorage.updateRunStatus(run.id, run.version, "STOPPED", { currentState: "IMPLEMENT", stoppedAt: new Date().toISOString() });
    const beforeHistoricalEventCount = afterStorage.listEvents(100).length;
    afterStorage.close();
    const historicalAppend = await fetch(`${base(server)}/api/workflow-board/evidence`, {
      method: "POST",
      headers: { "x-agent-loop-token": "test-token" },
      body: JSON.stringify({ runId: run.id, stageId: "build", summary: "Should not write to historical run.", source: "dashboard" })
    });
    const historicalPayload = await historicalAppend.json() as { ok: boolean; error?: { code: string } };
    const historicalStorage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const afterHistoricalEventCount = historicalStorage.listEvents(100).length;
    historicalStorage.close();

    expect(boardResponse.status).toBe(200);
    expect(board.ok).toBe(true);
    expect(board.data.stages.map((stage) => stage.id)).toContain("merge_readiness");
    expect(board.data.appendEvidenceEnabled).toBe(true);
    expect(noToken.status).toBe(401);
    expect(badOrigin.status).toBe(403);
    expect(invalid.status).toBe(400);
    expect(invalidStatus.status).toBe(400);
    expect(invalidReview.status).toBe(400);
    expect(invalidJson.status).toBe(400);
    expect(invalidJsonPayload.error?.code).toBe("invalid_config");
    expect(append.status).toBe(200);
    expect(reviewAppend.status).toBe(200);
    expect(appendPayload.ok).toBe(true);
    expect(appendPayload.data.event.kind).toBe("workflow_stage_evidence");
    expect(appendPayload.data.event.message).toBe("Implemented workflow board shell.");
    expect(reviewAppendPayload.data.event.payload).toMatchObject({
      review: {
        reviewer: "claude_acp",
        progress: "complete",
        commentUrl: "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#pullrequestreview-77"
      }
    });
    expect(afterBoard.data.evidenceRefs.some((ref) => ref.summary === "Implemented workflow board shell." && ref.source === "build")).toBe(true);
    expect(afterGateCount).toBe(beforeGateCount);
    expect(historicalAppend.status).toBe(403);
    expect(historicalPayload.ok).toBe(false);
    expect(historicalPayload.error?.code).toBe("policy_violation");
    expect(afterHistoricalEventCount).toBe(beforeHistoricalEventCount);
  });

  it("does not select an unbound old blocked PR run as the default workflow board", async () => {
    const repoRoot = seededRepo();
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const boundRun = storage.getCurrentRun();
    if (!boundRun) throw new Error("missing bound run");
    storage.updateRunStatus(boundRun.id, boundRun.version, "STOPPED", { currentState: "STOPPED", stoppedAt: new Date().toISOString() });
    storage.createRun("BLOCKED", { currentState: "READY_TO_MERGE", branch: "codex/old-unbound-pr" });
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const boardResponse = await fetch(`${base(server)}/api/workflow-board`);
    const board = await boardResponse.json() as { ok: boolean; data: { mode: string; runId?: string; message?: string } };
    const explicit = await (await fetch(`${base(server)}/api/workflow-board?runId=${encodeURIComponent(boundRun.id)}`)).json() as { data: { mode: string; runId?: string } };

    expect(board.ok).toBe(true);
    expect(board.data.mode).toBe("empty");
    expect(board.data.runId).toBeUndefined();
    expect(board.data.message).toContain("No active PR delivery run");
    expect(explicit.data.mode).toBe("historical");
    expect(explicit.data.runId).toBe(boundRun.id);
  });

  it("advances a stale selected-work-item state from workflow evidence", async () => {
    const repoRoot = boundWorkflowRepo("SELECT_NEXT_PR");
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing bound run");
    appendStageEvidence(storage, run.id, "plan", "Plan persisted.");
    appendStageEvidence(storage, run.id, "build", "Implementation completed.");
    appendStageEvidence(storage, run.id, "review", "Claude ACP review posted PASS.");
    appendStageEvidence(storage, run.id, "merge_readiness", "No unresolved P0/P1/P2 remain.");
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const board = await (await fetch(`${base(server)}/api/workflow-board`)).json() as {
      ok: boolean;
      data: {
        activeStageId: string;
        workItem: { currentState?: string };
        stages: Array<{ id: string; status: string }>;
      };
    };
    const stateAfterRead = currentRunState(repoRoot);

    expect(board.ok).toBe(true);
    expect(board.data.workItem.currentState).toBe("SELECT_NEXT_PR");
    expect(board.data.activeStageId).toBe("merge_readiness");
    expect(board.data.stages.find((stage) => stage.id === "review")?.status).toBe("done");
    expect(stateAfterRead).toBe("SELECT_NEXT_PR");
  });

  it("uses explicit active workflow evidence as the current stage source", async () => {
    const repoRoot = boundWorkflowRepo("SELECT_NEXT_PR");
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing bound run");
    appendStageEvidence(storage, run.id, "plan", "Plan persisted.", "plan_written", "done");
    appendStageEvidence(storage, run.id, "build", "Implementation started before file edits.", "implementation_active", "active");
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const board = await (await fetch(`${base(server)}/api/workflow-board`)).json() as {
      ok: boolean;
      data: {
        activeStageId: string;
        stageSource: string;
        stageSourceEvent?: { status: string };
        workItem: { currentState?: string };
      };
    };

    expect(board.ok).toBe(true);
    expect(board.data.workItem.currentState).toBe("SELECT_NEXT_PR");
    expect(board.data.activeStageId).toBe("build");
    expect(board.data.stageSource).toBe("workflow_evidence");
    expect(board.data.stageSourceEvent?.status).toBe("active");
  });

  it("lets newer done evidence advance past an older active stage signal", async () => {
    const repoRoot = boundWorkflowRepo("SELECT_NEXT_PR");
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing bound run");
    appendStageEvidence(storage, run.id, "build", "Implementation started.", "implementation_active", "active");
    appendStageEvidence(storage, run.id, "verify", "Focused tests passed.", "focused_tests", "done");
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const board = await (await fetch(`${base(server)}/api/workflow-board`)).json() as {
      ok: boolean;
      data: {
        activeStageId: string;
        stageSource: string;
        stageSourceEvent?: { status: string };
      };
    };

    expect(board.ok).toBe(true);
    expect(board.data.activeStageId).toBe("verify");
    expect(board.data.stageSource).toBe("workflow_evidence");
    expect(board.data.stageSourceEvent?.status).toBe("done");
  });

  it("keeps an active stage when a later done evidence belongs to an earlier stage", async () => {
    const repoRoot = boundWorkflowRepo("SELECT_NEXT_PR");
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing bound run");
    appendStageEvidence(storage, run.id, "build", "Implementation started.", "implementation_active", "active");
    appendStageEvidence(storage, run.id, "plan", "Plan was backfilled.", "plan_written", "done");
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const board = await (await fetch(`${base(server)}/api/workflow-board`)).json() as {
      ok: boolean;
      data: {
        activeStageId: string;
        stageSource: string;
        stageSourceEvent?: { status: string };
      };
    };

    expect(board.ok).toBe(true);
    expect(board.data.activeStageId).toBe("build");
    expect(board.data.stageSource).toBe("workflow_evidence");
    expect(board.data.stageSourceEvent?.status).toBe("active");
  });

  it("derives review report rows from structured review evidence", async () => {
    const repoRoot = boundWorkflowRepo("WAIT_REVIEW_OR_CI");
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing bound run");
    appendReviewEvidence(storage, run.id, "Claude ACP requested.", {
      reviewer: "claude_acp",
      requirement: "required",
      progress: "started",
      result: "unknown",
      severitySummary: "unknown",
      model: "Claude ACP",
      sessionId: "session-1"
    });
    appendReviewEvidence(storage, run.id, "AGY/Gemini report posted PASS.", {
      reviewer: "agy_gemini",
      requirement: "required",
      progress: "complete",
      result: "pass",
      severitySummary: "none",
      model: "Gemini 3.1 Pro",
      commentUrl: "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#issuecomment-101",
      commentId: "101"
    });
    appendReviewEvidence(storage, run.id, "Internal reviewer blocked on P2.", {
      reviewer: "internal_reviewer",
      requirement: "required",
      progress: "complete",
      result: "block",
      severitySummary: "p2_or_higher",
      commentUrl: "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#issuecomment-102"
    });
    appendReviewEvidence(storage, run.id, "Human review skipped.", {
      reviewer: "human",
      requirement: "not_required",
      progress: "complete",
      result: "unknown",
      severitySummary: "unknown",
      reason: "Docs-only owner review covered this path."
    });
    appendReviewEvidence(storage, run.id, "Custom optional review skipped.", {
      reviewer: "custom",
      requirement: "not_required",
      progress: "skipped",
      result: "unknown",
      severitySummary: "unknown",
      reason: "External UI review not required for this docs-only path."
    });
    appendReviewEvidence(storage, run.id, "GitHub review requirement is not complete yet.", {
      reviewer: "github",
      requirement: "required",
      progress: "unknown",
      result: "unknown",
      severitySummary: "unknown"
    });
    appendReviewEvidence(storage, run.id, "Internal tester warned about polish.", {
      reviewer: "internal_tester",
      requirement: "optional",
      progress: "complete",
      result: "warn",
      severitySummary: "p3_only",
      commentUrl: "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#pullrequestreview-103"
    });
    appendStageEvidence(storage, run.id, "review", "No unresolved P0/P1/P2 remain.", "reports_posted");
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const board = await (await fetch(`${base(server)}/api/workflow-board`)).json() as {
      data: {
        reviewReports: Array<{
          agent: string;
          requirement?: string;
          progress?: string;
          result?: string;
          status?: string;
          prComment: string;
          severitySummary: string;
          commentUrl?: string;
        }>;
        mergeReadinessChecks: Array<{ id: string; status: string; evidence: string }>;
      };
    };

    const claude = board.data.reviewReports.find((row) => row.agent === "Claude ACP");
    const agy = board.data.reviewReports.find((row) => row.agent === "AGY/Gemini");
    const internal = board.data.reviewReports.find((row) => row.agent === "Internal reviewer");
    const human = board.data.reviewReports.find((row) => row.agent === "Human");
    const custom = board.data.reviewReports.find((row) => row.agent === "Custom reviewer");
    const github = board.data.reviewReports.find((row) => row.agent === "GitHub");
    const tester = board.data.reviewReports.find((row) => row.agent === "Internal tester");
    const legacy = board.data.reviewReports.find((row) => row.agent === "Review evidence");

    expect(claude).toMatchObject({ requirement: "required", progress: "started", result: "unknown", prComment: "missing" });
    expect(agy).toMatchObject({ requirement: "required", progress: "complete", result: "pass", prComment: "posted", severitySummary: "none" });
    expect(agy?.commentUrl).toContain("#issuecomment-101");
    expect(internal).toMatchObject({ requirement: "required", progress: "complete", result: "block", prComment: "posted", severitySummary: "P2 or higher" });
    expect(human).toMatchObject({ requirement: "not_required", progress: "complete", prComment: "not_required" });
    expect(custom).toMatchObject({ requirement: "not_required", progress: "skipped", prComment: "not_required" });
    expect(github).toMatchObject({ requirement: "required", progress: "incomplete", prComment: "missing" });
    expect(tester).toMatchObject({ requirement: "optional", progress: "complete", result: "warn", status: "warn", prComment: "posted", severitySummary: "P3 only" });
    expect(legacy).toMatchObject({ severitySummary: "no severity evidence", status: "pass" });
    expect(board.data.mergeReadinessChecks.find((row) => row.id === "findings_gate")).toMatchObject({
      status: "blocked",
      evidence: "Internal reviewer blocked on P2."
    });
  });

  it("uses the latest structured review evidence per reviewer for merge findings", async () => {
    const repoRoot = boundWorkflowRepo("WAIT_REVIEW_OR_CI");
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing bound run");
    appendReviewEvidence(storage, run.id, "Claude found a blocking issue.", {
      reviewer: "claude_acp",
      requirement: "required",
      progress: "complete",
      result: "block",
      severitySummary: "p2_or_higher",
      commentUrl: "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#issuecomment-201"
    });
    appendReviewEvidence(storage, run.id, "Claude re-review passed after fixes.", {
      reviewer: "claude_acp",
      requirement: "required",
      progress: "complete",
      result: "pass",
      severitySummary: "none",
      commentUrl: "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1/files?diff=split#discussion_r202"
    });
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const board = await (await fetch(`${base(server)}/api/workflow-board`)).json() as {
      data: {
        reviewReports: Array<{ agent: string; result?: string; commentUrl?: string }>;
        mergeReadinessChecks: Array<{ id: string; status: string; evidence: string }>;
      };
    };

    expect(board.data.reviewReports.find((row) => row.agent === "Claude ACP")).toMatchObject({
      result: "pass",
      commentUrl: "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1/files?diff=split#discussion_r202"
    });
    expect(board.data.mergeReadinessChecks.find((row) => row.id === "findings_gate")).toMatchObject({
      status: "passed",
      evidence: "all required structured reviews passed without P0/P1/P2 evidence"
    });
  });

  it("does not keep merge readiness blocked after cleanup evidence is recorded", async () => {
    const repoRoot = boundWorkflowRepo("SELECT_NEXT_PR");
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing bound run");
    appendStageEvidence(storage, run.id, "merge_readiness", "Manual merge gate was satisfied.");
    appendStageEvidence(storage, run.id, "cleanup", "PR was merged.", "pr_merged");
    appendStageEvidence(storage, run.id, "cleanup", "Switched to main.", "switched_main");
    appendStageEvidence(storage, run.id, "cleanup", "Pulled latest main.", "pulled_latest");
    appendStageEvidence(storage, run.id, "cleanup", "GitNexus was reindexed.", "gitnexus_reindexed");
    appendStageEvidence(storage, run.id, "cleanup", "Worktree is clean.", "worktree_clean");
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const board = await (await fetch(`${base(server)}/api/workflow-board`)).json() as {
      data: {
        activeStageId: string;
        stages: Array<{ id: string; status: string }>;
        mergeReadinessChecks: Array<{ id: string; status: string }>;
        cleanupChecks: Array<{ id: string; status: string; evidence: string }>;
      };
    };
    const mission = await (await fetch(`${base(server)}/api/mission-control`)).json() as {
      data: { mergeReadiness?: { ready: boolean; missingConditions: string[]; evidence: string[] } };
    };

    expect(board.data.activeStageId).toBe("cleanup");
    expect(board.data.stages.find((stage) => stage.id === "merge_readiness")?.status).toBe("done");
    expect(board.data.mergeReadinessChecks.every((check) => check.status !== "blocked")).toBe(true);
    expect(board.data.cleanupChecks.find((check) => check.id === "pr_merged")?.status).toBe("passed");
    expect(board.data.cleanupChecks.find((check) => check.id === "worktree_clean")?.evidence).toBe("Worktree is clean.");
    expect(mission.data.mergeReadiness?.ready).toBe(true);
    expect(mission.data.mergeReadiness?.missingConditions).toEqual([]);
    expect(mission.data.mergeReadiness?.evidence).toContain("cleanup evidence recorded after merge");
  });

  it("keeps a stale selected-work-item state on review when review is the furthest evidence", async () => {
    const repoRoot = boundWorkflowRepo("SELECT_NEXT_PR");
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing bound run");
    appendStageEvidence(storage, run.id, "plan", "Plan persisted.");
    appendStageEvidence(storage, run.id, "build", "Implementation completed.");
    appendStageEvidence(storage, run.id, "review", "AGY review is active.");
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const board = await (await fetch(`${base(server)}/api/workflow-board`)).json() as {
      data: { activeStageId: string; stages: Array<{ id: string; status: string }> };
    };

    expect(board.data.activeStageId).toBe("review");
    expect(board.data.stages.find((stage) => stage.id === "merge_readiness")?.status).toBe("pending");
  });

  it("binds dashboard API to targetRepoRoot while keeping plugin repo separate", async () => {
    const targetRepoRoot = seededRepo();
    const pluginRoot = join(import.meta.dirname, "../../..");
    const server = await startDashboardServer({
      repoRoot: pluginRoot,
      targetRepoRoot,
      token: "test-token",
      serveUi: false
    });
    handles.push(server);

    const metaResponse = await fetch(`${base(server)}/api/dashboard-meta`);
    const missionResponse = await fetch(`${base(server)}/api/mission-control`);
    const meta = await metaResponse.json() as { ok: boolean; data: { targetRepo: { root: string; repoId: string } } };
    const mission = await missionResponse.json() as { ok: boolean; data: { gates: unknown[] } };

    expect(meta.ok).toBe(true);
    expect(meta.data.targetRepo.root).toBe(targetRepoRoot);
    expect(meta.data.targetRepo.repoId).toBe("example/fixture");
    expect(mission.ok).toBe(true);
    expect(mission.data.gates).toHaveLength(1);
  });

  it("serves dashboard UI from an explicit plugin ui root with a no-store runtime token bootstrap", async () => {
    const repoRoot = seededRepo();
    const uiRoot = join(import.meta.dirname, "../ui");
    const server = await startDashboardServer({
      repoRoot,
      token: "test-token</script>&",
      uiRoot
    });
    handles.push(server);

    const response = await fetch(`${base(server)}/`);
    const html = await response.text();
    const clientResponse = await fetch(`${base(server)}/@vite/client`);
    const client = await clientResponse.text();
    const cssResponse = await fetch(`${base(server)}/src/styles.css`);
    const cssModule = await cssResponse.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("HOLO-Codex Dashboard");
    expect(html).not.toContain("@vite/client");
    expect(html).toContain("window.__AGENT_LOOP_DASHBOARD_TOKEN__");
    expect(html).toContain("test-token\\u003c/script\\u003e\\u0026");
    expect(html.indexOf("__AGENT_LOOP_DASHBOARD_TOKEN__")).toBeLessThan(html.indexOf("/src/main.tsx"));
    expect(clientResponse.status).toBe(200);
    expect(client).toContain("export function updateStyle");
    expect(client).toContain("document.createElement('style')");
    expect(client).not.toContain("WebSocket");
    expect(cssResponse.status).toBe(200);
    expect(cssModule).toContain("updateStyle");
  });

  it("serves dashboard UI from the plugin root when controlling a separate target repo", async () => {
    const targetRepoRoot = seededRepo();
    const pluginRoot = join(import.meta.dirname, "../../..");
    const server = await startDashboardServer({
      repoRoot: pluginRoot,
      targetRepoRoot,
      token: "test-token"
    });
    handles.push(server);

    const response = await fetch(`${base(server)}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("HOLO-Codex Dashboard");
    expect(html).not.toContain("@vite/client");
  });

  it("serves observe and audit export without leaking dashboard token or artifact content", async () => {
    const repoRoot = seededRepo();
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing run");
    storage.writeGate({
      runId: run.id,
      kind: "policy_violation",
      message: "raw output gate",
      details: {
        stdout: "raw stdout should not appear",
        stderr: "raw stderr should not appear",
        prompt: "prompt text should not appear",
        rawJsonl: "{\"secret\":\"raw\"}",
        token: "secret-token"
      }
    });
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);
    const runId = currentRunId(repoRoot);
    expect(runId).toBeTruthy();

    const observeResponse = await fetch(`${base(server)}/api/observe?limit=3`);
    const observe = await observeResponse.json() as { ok: boolean; data: { dashboard: { url: string }; timeline: { entries: unknown[] } } };
    const auditResponse = await fetch(`${base(server)}/api/audit-export?runId=${encodeURIComponent(runId ?? "")}&format=json`);
    const audit = await auditResponse.json() as { ok: boolean; data: { content: unknown } };
    const auditText = JSON.stringify(audit);

    expect(observeResponse.status).toBe(200);
    expect(observe.ok).toBe(true);
    expect(observe.data.dashboard.url).toBe("http://127.0.0.1:0/");
    expect(JSON.stringify(observe)).not.toContain("test-token");
    expect(auditResponse.status).toBe(200);
    expect(audit.ok).toBe(true);
    expect(auditText).not.toContain("test-token");
    expect(auditText).not.toContain("contentBase64");
    expect(auditText).not.toContain("worker completed");
    expect(auditText).not.toContain("secret-value");
    expect(auditText).not.toContain("raw stdout should not appear");
    expect(auditText).not.toContain("raw stderr should not appear");
    expect(auditText).not.toContain("prompt text should not appear");
    expect(auditText).not.toContain("secret-token");
    expect(auditText).toContain("raw content is excluded from audit exports");
    expect(auditText).toContain("[redacted]");
  });

  it("does not mutate notification state from untrusted GET polling", async () => {
    const repoRoot = seededRepo();
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing run");
    const worker = storage.createWorker({ runId: run.id, type: "implementation", backend: "codex-exec", attempt: 1, resumeUsed: false });
    storage.appendWorkerEvent({
      workerId: worker.id,
      runId: run.id,
      eventType: "item.started",
      itemType: "command_execution",
      itemId: "long-command",
      itemStatus: "started",
      summary: { id: "long-command", command: "pnpm test", startedAt: "2000-01-01T00:00:00.000Z" }
    });
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const first = await (await fetch(`${base(server)}/api/notifications`)).json() as { data: { notifications: Array<{ id: string }> } };
    const second = await (await fetch(`${base(server)}/api/notifications`)).json() as { data: { notifications: Array<{ id: string }> } };
    const afterPollStorage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const notificationEvents = afterPollStorage.listEvents(50).filter((event) => event.kind === "notification_marked_read" || event.kind === "notification_dismissed");
    afterPollStorage.close();
    const notificationId = `longrunning:${worker.id}:long-command`;

    expect(first.data.notifications.map((item) => item.id)).toContain(notificationId);
    expect(second.data.notifications.map((item) => item.id)).toEqual(first.data.notifications.map((item) => item.id));
    expect(notificationEvents).toHaveLength(0);

    const untrustedDismiss = await fetch(`${base(server)}/api/notifications/dismiss`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ notificationIds: [notificationId] })
    });
    expect(untrustedDismiss.status).toBe(401);

    const dismissed = await fetch(`${base(server)}/api/notifications/dismiss`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-loop-token": "test-token",
        origin: base(server)
      },
      body: JSON.stringify({ notificationIds: [notificationId] })
    });
    const afterDismiss = await (await fetch(`${base(server)}/api/notifications`)).json() as { data: { notifications: Array<{ id: string }> } };
    const dismissedStorage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const dismissedEvents = dismissedStorage.listEvents(50).filter((event) => event.kind === "notification_dismissed");
    dismissedStorage.close();
    expect(dismissed.status).toBe(200);
    expect(afterDismiss.data.notifications.map((item) => item.id)).not.toContain(notificationId);
    expect(dismissedEvents).toHaveLength(1);
  });

  it("serves agent timeline from the same controller data as mission control", async () => {
    const repoRoot = seededRepo();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const missionResponse = await fetch(`${base(server)}/api/mission-control`);
    const timelineResponse = await fetch(`${base(server)}/api/agent-timeline?limit=1`);
    const mission = await missionResponse.json() as { data: { timelineSummary: { latest: { timelineSeq: number } }; workers: Array<{ id: string }> } };
    const workerId = mission.data.workers[0]?.id;
    expect(workerId).toBeTruthy();
    const workerTimelineResponse = await fetch(`${base(server)}/api/agent-timeline?source=worker_event&workerId=${encodeURIComponent(workerId ?? "")}`);
    const timeline = await timelineResponse.json() as { ok: boolean; data: { entries: Array<{ timelineSeq: number; summary: string }> } };
    const workerTimeline = await workerTimelineResponse.json() as { data: { entries: Array<{ source: string; summary: string }> } };

    expect(timelineResponse.status).toBe(200);
    expect(timeline.ok).toBe(true);
    expect(timeline.data.entries[0]?.timelineSeq).toBe(mission.data.timelineSummary.latest.timelineSeq);
    expect(workerTimeline.data.entries[0]?.source).toBe("worker_event");
    expect(workerTimeline.data.entries[0]?.summary).not.toContain("secret-value");
    expect(workerTimeline.data.entries[0]?.summary).toContain("[redacted]");
  });

  it("requires token and operator note for gate approval", async () => {
    const repoRoot = seededRepo();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);
    expect(process.env.AGENT_LOOP_MCP_TOKEN).toBeUndefined();
    const gateId = openGateId(repoRoot);

    const noToken = await fetch(`${base(server)}/api/gates/${gateId}/approve`, {
      method: "POST",
      body: JSON.stringify({ note: "reviewed" })
    });
    expect(noToken.status).toBe(401);

    const queryToken = await fetch(`${base(server)}/api/gates/${gateId}/approve?token=test-token`, {
      method: "POST",
      body: JSON.stringify({ note: "reviewed" })
    });
    expect(queryToken.status).toBe(401);

    const noNote = await fetch(`${base(server)}/api/gates/${gateId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-loop-token": "test-token" },
      body: JSON.stringify({ note: "" })
    });
    const rejected = await noNote.json() as { ok: boolean; error?: { code: string } };
    expect(noNote.status).toBe(400);
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("invalid_config");

    const approved = await fetch(`${base(server)}/api/gates/${gateId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-loop-token": "test-token" },
      body: JSON.stringify({ note: "reviewed" })
    });
    const payload = await approved.json() as { ok: boolean; data: { gate: { status: string } } };
    expect(payload.ok).toBe(true);
    expect(payload.data.gate.status).toBe("approved");
  });

  it("marks historical gates handled without resolving the original gate", async () => {
    const repoRoot = tempRepo();
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    writeFileSync(join(repoRoot, ".agent-loop", "config.json"), `${JSON.stringify(withConfigDefaults({ repoId: "example/fixture" }))}\n`);
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    storage.writeRepoConfig(withConfigDefaults({ repoId: "example/fixture" }));
    const oldRun = storage.createRun("BLOCKED", { currentState: "IMPLEMENT" });
    storage.writeGate({ runId: oldRun.id, kind: "worker_failed", message: "Old worker failed." });
    const gateId = storage.listGates(oldRun.id)[0]?.id ?? "";
    storage.updateRunStatus(oldRun.id, oldRun.version, "STOPPED", { currentState: "IMPLEMENT", stoppedAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    storage.createRun("RUNNING", { currentState: "SELF_CHECK" });
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const noToken = await fetch(`${base(server)}/api/gates/${gateId}/mark-handled`, { method: "POST" });
    expect(noToken.status).toBe(401);

    const badOrigin = await fetch(`${base(server)}/api/gates/${gateId}/mark-handled`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-loop-token": "test-token", origin: "http://evil.test" },
      body: "{}"
    });
    expect(badOrigin.status).toBe(403);

    const response = await fetch(`${base(server)}/api/gates/${gateId}/mark-handled`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-loop-token": "test-token", origin: base(server) },
      body: "{}"
    });
    const payload = await response.json() as { ok: boolean; data: { markedHandled: boolean } };
    const after = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    for (let index = 0; index < 101; index += 1) {
      after.appendEvent({
        runId: oldRun.id,
        kind: "historical_gate_noise",
        message: `Noise event ${index}`
      });
    }
    const gate = after.getGate(gateId);
    const event = after.listEvents(20).find((item) => item.kind === "historical_gate_marked_handled");
    const decision = after.listDecisions(oldRun.id).find((item) => item.kind === "historical_gate_marked_handled");
    after.close();
    const mission = await fetch(`${base(server)}/api/mission-control`);
    const missionPayload = await mission.json() as {
      ok: boolean;
      data: { gates: Array<{ id: string; activity?: string; activityReason?: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.data.markedHandled).toBe(true);
    expect(gate?.status).toBe("open");
    expect(event).toBeUndefined();
    expect(decision?.details).toMatchObject({ gateId, source: "dashboard" });
    expect(missionPayload.data.gates.find((item) => item.id === gateId)).toMatchObject({
      activity: "historical",
      activityReason: "marked_handled"
    });
  });

  it("re-evaluates historical gates without resolving the original gate", async () => {
    const repoRoot = tempRepo();
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    writeFileSync(join(repoRoot, ".agent-loop", "config.json"), `${JSON.stringify(withConfigDefaults({ repoId: "example/fixture" }))}\n`);
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    storage.writeRepoConfig(withConfigDefaults({ repoId: "example/fixture" }));
    const oldRun = storage.createRun("BLOCKED", { currentState: "IMPLEMENT" });
    storage.writeGate({ runId: oldRun.id, kind: "worker_failed", message: "Old worker failed." });
    const gateId = storage.listGates(oldRun.id)[0]?.id ?? "";
    storage.updateRunStatus(oldRun.id, oldRun.version, "STOPPED", { currentState: "IMPLEMENT", stoppedAt: new Date().toISOString() });
    storage.createRun("RUNNING", { currentState: "SELF_CHECK" });
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const noToken = await fetch(`${base(server)}/api/gates/${gateId}/re-evaluate`, { method: "POST" });
    expect(noToken.status).toBe(401);

    const badOrigin = await fetch(`${base(server)}/api/gates/${gateId}/re-evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-loop-token": "test-token", origin: "http://evil.test" },
      body: "{}"
    });
    expect(badOrigin.status).toBe(403);

    const response = await fetch(`${base(server)}/api/gates/${gateId}/re-evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-loop-token": "test-token", origin: base(server) },
      body: "{}"
    });
    const payload = await response.json() as { ok: boolean; data: { result: string; reevaluated: boolean; gate: { activity?: string; activityReason?: string } } };
    const after = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const gate = after.getGate(gateId);
    const event = after.listEvents(20).find((item) => item.kind === "historical_gate_re_evaluated");
    const decision = after.listDecisions(oldRun.id).find((item) => item.kind === "historical_gate_re_evaluated");
    after.close();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.reevaluated).toBe(true);
    expect(payload.data.result).toBe("overridden_by_current_reality");
    expect(payload.data.gate).toMatchObject({ activity: "historical", activityReason: "overridden_by_reality" });
    expect(gate?.status).toBe("open");
    expect(event?.payload).toMatchObject({ gateId, result: "overridden_by_current_reality", source: "dashboard" });
    expect(decision?.details).toMatchObject({ gateId, result: "overridden_by_current_reality", source: "dashboard" });
  });

  it("reports handled, active, and missing gate re-evaluate states", async () => {
    const repoRoot = tempRepo();
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    writeFileSync(join(repoRoot, ".agent-loop", "config.json"), `${JSON.stringify(withConfigDefaults({ repoId: "example/fixture" }))}\n`);
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    storage.writeRepoConfig(withConfigDefaults({ repoId: "example/fixture" }));
    const oldRun = storage.createRun("BLOCKED", { currentState: "IMPLEMENT" });
    storage.writeGate({ runId: oldRun.id, kind: "worker_failed", message: "Old worker failed." });
    const handledGateId = storage.listGates(oldRun.id)[0]?.id ?? "";
    storage.updateRunStatus(oldRun.id, oldRun.version, "STOPPED", { currentState: "IMPLEMENT", stoppedAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const currentRun = storage.createRun("BLOCKED", { currentState: "SELF_CHECK" });
    storage.writeGate({ runId: currentRun.id, kind: "policy_violation", message: "Current policy gate." });
    const activeGateId = storage.listGates(currentRun.id)[0]?.id ?? "";
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    await fetch(`${base(server)}/api/gates/${handledGateId}/mark-handled`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-loop-token": "test-token", origin: base(server) },
      body: "{}"
    });
    const handledResponse = await fetch(`${base(server)}/api/gates/${handledGateId}/re-evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-loop-token": "test-token", origin: base(server) },
      body: "{}"
    });
    const activeResponse = await fetch(`${base(server)}/api/gates/${activeGateId}/re-evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-loop-token": "test-token", origin: base(server) },
      body: "{}"
    });
    const missingResponse = await fetch(`${base(server)}/api/gates/missing-gate/re-evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-loop-token": "test-token", origin: base(server) },
      body: "{}"
    });
    const handled = await handledResponse.json() as { data: { result: string } };
    const active = await activeResponse.json() as { data: { result: string } };
    const after = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const missingEvents = after.listEvents().filter((item) => item.kind === "historical_gate_re_evaluated" && item.message.includes("missing-gate"));
    after.close();

    expect(handled.data.result).toBe("manually_handled");
    expect(active.data.result).toBe("active_again");
    expect(missingResponse.status).toBe(404);
    expect(missingEvents).toHaveLength(0);
  });

  it("reports missing config without creating storage", async () => {
    const repoRoot = tempRepo("agent-loop-dashboard-missing-config-");
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const response = await fetch(`${base(server)}/api/mission-control`);
    const payload = await response.json() as { ok: boolean; error?: { code: string } };

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("needs_repo_init");
    expect(existsSync(join(repoRoot, ".agent-loop", "state.sqlite"))).toBe(false);
  });

  it("surfaces stale needs_repo_init gates until explicit recovery runs", async () => {
    const repoRoot = seededRepo();
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    storage.writeGate({
      kind: "needs_repo_init",
      message: "Missing .agent-loop/config.json. Run `pnpm agent-loop init`."
    });
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const response = await fetch(`${base(server)}/api/mission-control`);
    const payload = await response.json() as { ok: boolean; data: { current: { gate?: { kind: string } } } };
    const after = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const repoInitGate = after.listGates().find((gate) => gate.kind === "needs_repo_init");
    after.close();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.current.gate?.kind).toBe("needs_repo_init");
    expect(repoInitGate?.status).toBe("open");

    const recoveredResponse = await fetch(`${base(server)}/api/recover`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-loop-token": "test-token",
        origin: base(server)
      },
      body: "{}"
    });
    const recoveredPayload = await recoveredResponse.json() as { ok: boolean; data: { recovered: number } };
    expect(recoveredResponse.status).toBe(200);
    expect(recoveredPayload.data.recovered).toBe(1);

    const recoveredStorage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const recoveryEvent = recoveredStorage.listEvents().find((event) => event.kind === "gate_recovery");
    const recoveryDecision = recoveredStorage.listDecisions(recoveredStorage.getCurrentRun()?.id ?? "").find((decision) => decision.kind === "gate_recovery");
    recoveredStorage.close();
    expect(recoveryEvent?.payload).toMatchObject({ reason: "config_exists_and_valid", gateIds: expect.any(Array) });
    expect(recoveryDecision?.details).toMatchObject({ source: "dashboard", scope: "repo" });
  });

  it("recovers an active worker_failed gate and leaves mission control consistent across pages", async () => {
    const repoRoot = tempRepo("agent-loop-dashboard-");
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    const config = withConfigDefaults({ repoId: "example/fixture" });
    writeFileSync(join(repoRoot, ".agent-loop", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    storage.writeRepoConfig(config);
    const run = storage.createRun("RUNNING", { currentState: "WRITE_SPEC", branch: "main", worktreeClean: true });
    const worker = storage.createWorker({
      runId: run.id,
      type: "planner",
      backend: "codex-exec",
      attempt: 1,
      resumeUsed: false
    });
    storage.updateWorker(worker.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: 1,
      error: "failed to load skill"
    });
    blockRunForTerminalWorker(storage, run);
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const before = await fetch(`${base(server)}/api/mission-control`);
    const beforePayload = await before.json() as { ok: boolean; data: { current: { gate?: { kind: string } } } };
    expect(beforePayload.data.current.gate?.kind).toBe("worker_failed");

    const recoveredResponse = await fetch(`${base(server)}/api/recover`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-loop-token": "test-token",
        origin: base(server)
      },
      body: "{}"
    });
    const recoveredPayload = await recoveredResponse.json() as { ok: boolean; data: { recovered: number; worker: { recovered: number; workerIds: string[] } } };
    expect(recoveredResponse.status).toBe(200);
    expect(recoveredPayload.data.recovered).toBe(1);
    expect(recoveredPayload.data.worker.recovered).toBe(1);
    expect(recoveredPayload.data.worker.workerIds).toEqual([worker.id]);

    const afterResponse = await fetch(`${base(server)}/api/mission-control`);
    const afterPayload = await afterResponse.json() as {
      ok: boolean;
      data: {
        current: { status: string; gate?: { kind: string } };
        gates: Array<{ kind: string; status: string; activity: string; activityReason: string }>;
        workers: Array<{ id: string; status: string; activity: string; activityReason: string }>;
      };
    };
    // Mission Control no longer reports an active worker_failed gate or a blocked run.
    expect(afterPayload.data.current.gate?.kind).not.toBe("worker_failed");
    expect(afterPayload.data.current.status).not.toBe("BLOCKED");
    // The recovered failure stays visible as historical (not silently hidden), with an audit reason.
    const workerGate = afterPayload.data.gates.find((item) => item.kind === "worker_failed");
    expect(workerGate?.status).toBe("resolved");
    expect(workerGate?.activity).toBe("historical");
    const failedWorker = afterPayload.data.workers.find((item) => item.id === worker.id);
    expect(failedWorker?.activity).toBe("historical");
    expect(failedWorker?.activityReason).toBe("stale_worker_failure");
  });

  it("recovers an active worker_output_invalid gate and marks the terminal worker historical", async () => {
    const repoRoot = tempRepo("agent-loop-dashboard-");
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    const config = withConfigDefaults({ repoId: "example/fixture" });
    writeFileSync(join(repoRoot, ".agent-loop", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    storage.writeRepoConfig(config);
    const run = storage.createRun("RUNNING", { currentState: "IMPLEMENT", branch: "main", worktreeClean: true });
    const worker = storage.createWorker({
      runId: run.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 1,
      resumeUsed: false
    });
    storage.updateWorker(worker.id, {
      status: "invalid_output",
      completedAt: new Date().toISOString(),
      exitCode: 0,
      error: "output did not match schema"
    });
    blockRunForTerminalWorker(storage, run);
    expect(storage.getCurrentRun()?.status).toBe("BLOCKED");
    expect(storage.listGates(run.id).some((item) => item.kind === "worker_output_invalid")).toBe(true);
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const before = await fetch(`${base(server)}/api/mission-control`);
    const beforePayload = await before.json() as { ok: boolean; data: { current: { gate?: { kind: string } } } };
    expect(beforePayload.data.current.gate?.kind).toBe("worker_output_invalid");

    const recoveredResponse = await fetch(`${base(server)}/api/recover`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-loop-token": "test-token",
        origin: base(server)
      },
      body: "{}"
    });
    const recoveredPayload = await recoveredResponse.json() as { ok: boolean; data: { recovered: number; worker: { recovered: number; workerIds: string[] } } };
    expect(recoveredResponse.status).toBe(200);
    expect(recoveredPayload.data.worker.recovered).toBe(1);
    expect(recoveredPayload.data.worker.workerIds).toEqual([worker.id]);

    const afterResponse = await fetch(`${base(server)}/api/mission-control`);
    const afterPayload = await afterResponse.json() as {
      ok: boolean;
      data: {
        current: { status: string; gate?: { kind: string } };
        gates: Array<{ kind: string; status: string; activity: string; activityReason: string }>;
        workers: Array<{ id: string; status: string; activity: string; activityReason: string }>;
      };
    };
    // Mission Control no longer reports an active worker_output_invalid gate or a blocked run.
    expect(afterPayload.data.current.gate?.kind).not.toBe("worker_output_invalid");
    expect(afterPayload.data.current.status).not.toBe("BLOCKED");
    const workerGate = afterPayload.data.gates.find((item) => item.kind === "worker_output_invalid");
    expect(workerGate?.status).toBe("resolved");
    expect(workerGate?.activity).toBe("historical");
    // The terminal worker must be historical once its (non-worker_failed) gate is recovered;
    // otherwise the Worker Runs page would still show it active and disagree with Mission/Gate.
    const terminalWorker = afterPayload.data.workers.find((item) => item.id === worker.id);
    expect(terminalWorker?.activity).toBe("historical");
    expect(terminalWorker?.activityReason).toBe("stale_worker_failure");

    // Recovery stays visible on the agent timeline as both a gate_recovery event and an
    // operator worker_failure_recovered decision, scoped to the recovered run.
    const timelineResponse = await fetch(`${base(server)}/api/agent-timeline?runId=${encodeURIComponent(run.id)}`);
    const timeline = await timelineResponse.json() as { ok: boolean; data: { entries: Array<{ source: string; kind: string }> } };
    const timelineKeys = timeline.data.entries.map((entry) => `${entry.source}:${entry.kind}`);
    expect(timeline.ok).toBe(true);
    expect(timelineKeys).toContain("event:gate_recovery");
    expect(timelineKeys).toContain("decision:worker_failure_recovered");
  });

  it("allows policy config reads without treating GET as a mutation", async () => {
    const repoRoot = seededRepo();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const response = await fetch(`${base(server)}/api/policy-config`);
    const payload = await response.json() as { ok: boolean; data: { config: { repoId: string } } };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.config.repoId).toBe("example/fixture");
  });

  it("marks notifications read through the shared controller", async () => {
    const repoRoot = seededRepo();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const before = await (await fetch(`${base(server)}/api/notifications`)).json() as { data: { notifications: Array<{ id: string }> } };
    expect(before.data.notifications.length).toBeGreaterThan(0);

    const marked = await fetch(`${base(server)}/api/notifications/mark-read`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-loop-token": "test-token",
        origin: base(server)
      },
      body: JSON.stringify({ notificationIds: before.data.notifications.map((notification) => notification.id) })
    });
    const markedPayload = await marked.json() as { ok: boolean; data: { markedRead: number } };
    expect(marked.status).toBe(200);
    expect(markedPayload.data.markedRead).toBe(before.data.notifications.length);

    const after = await (await fetch(`${base(server)}/api/notifications`)).json() as { data: { notifications: unknown[] } };
    expect(after.data.notifications).toHaveLength(0);
  });

  it("uses the same notification event window for mission control and notifications page", async () => {
    const repoRoot = seededRepo();
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing run");
    const hiddenByShortWindow = storage.appendEvent({ runId: run.id, kind: "ci_failed", message: "CI failed before later progress." });
    for (let index = 0; index < 30; index += 1) {
      storage.appendEvent({ runId: run.id, kind: "state_advanced", message: `progress ${index}` });
    }
    storage.close();
    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);

    const mission = await (await fetch(`${base(server)}/api/mission-control`)).json() as { data: { notifications: Array<{ id: string }> } };
    const notifications = await (await fetch(`${base(server)}/api/notifications`)).json() as { data: { notifications: Array<{ id: string }> } };
    const expectedId = `event:${hiddenByShortWindow.id}`;

    expect(mission.data.notifications.map((item) => item.id)).toContain(expectedId);
    expect(mission.data.notifications.map((item) => item.id)).toEqual(notifications.data.notifications.map((item) => item.id));
  });

  it("rejects unsafe host binding and mutation origin", async () => {
    const repoRoot = seededRepo();
    await expect(startDashboardServer({ repoRoot, host: "0.0.0.0", serveUi: false }))
      .rejects.toMatchObject({ code: "policy_violation" } satisfies Partial<AgentLoopError>);

    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);
    const response = await fetch(`${base(server)}/api/stop`, {
      method: "POST",
      headers: {
        "x-agent-loop-token": "test-token",
        origin: "http://malicious.test"
      }
    });
    const payload = await response.json() as { ok: boolean; error?: { code: string } };
    expect(response.status).toBe(403);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("policy_violation");
  });

  it("supports event since cursors and rejects artifact traversal", async () => {
    const repoRoot = seededRepo();
    const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
    const run = storage.getCurrentRun();
    if (!run) throw new Error("missing run");
    const first = storage.appendEvent({ runId: run.id, kind: "one", message: "first" });
    storage.appendEvent({ runId: run.id, kind: "two", message: "second" });
    storage.insertArtifact({
      id: "bad-artifact",
      runId: run.id,
      kind: "log",
      name: "escape.log",
      path: join(repoRoot, "escape.log"),
      sha256: "bad",
      createdAt: new Date().toISOString()
    });
    storage.close();

    const server = await startDashboardServer({ repoRoot, token: "test-token", serveUi: false });
    handles.push(server);
    const events = await (await fetch(`${base(server)}/api/events?since=${first.seq}`)).json() as { data: { events: Array<{ kind: string }> } };
    expect(events.data.events.map((event) => event.kind)).toContain("two");

    const noToken = await fetch(`${base(server)}/api/artifacts/bad-artifact`);
    expect(noToken.status).toBe(401);

    const artifact = await (await fetch(`${base(server)}/api/artifacts/bad-artifact`, {
      headers: { "x-agent-loop-token": "test-token" }
    })).json() as { ok: boolean; error?: { code: string } };
    expect(artifact.ok).toBe(false);
    expect(artifact.error?.code).toBe("artifact_integrity_error");
  });
});

function seededRepo(): string {
  const repoRoot = tempRepo("agent-loop-dashboard-");
  mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".agent-loop", "config.json"),
    `${JSON.stringify(withConfigDefaults({ repoId: "example/fixture" }), null, 2)}\n`
  );
  const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
  storage.writeRepoConfig(withConfigDefaults({ repoId: "example/fixture" }));
  const run = storage.createRun("RUNNING", {
    currentState: "SELF_CHECK",
    branch: "codex/pr-f-p0-dashboard",
    worktreeClean: true
  });
  bindDeliveryWorkItem(storage, {
    issue: "46",
    title: "Connect pr-delivery-loop to workflow evidence",
    url: "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/46",
    branch: "codex/pr-f-p0-dashboard",
    source: "cli"
  });
  storage.writeGate({ runId: run.id, kind: "policy_violation", message: "Self check required." });
  storage.upsertPrLink({
    runId: run.id,
    branch: "codex/pr-f-p0-dashboard",
    prNumber: 42,
    url: "https://github.test/pr/42",
    headRef: "codex/pr-f-p0-dashboard",
    baseRef: "main",
    state: "OPEN",
    draft: true
  });
  storage.replaceCiChecks(run.id, 42, [{ name: "ci", status: "completed", conclusion: "success" }]);
  storage.replaceReviewComments(run.id, 42, [{
    commentId: "c1",
    url: "https://github.test/comment",
    author: "reviewer",
    body: "Please tighten dashboard tests.",
    path: "plugins/autonomous-pr-loop/ui/src/app.tsx",
    diffHunk: "@@",
    isResolved: false,
    isOutdated: false,
    actionable: true,
    status: "open"
  }]);
  const worker = storage.createWorker({ runId: run.id, type: "reviewer", backend: "codex-exec", attempt: 0, resumeUsed: false });
  storage.appendWorkerEvent({
    workerId: worker.id,
    runId: run.id,
    eventType: "item.completed",
    itemType: "command_execution",
    summary: { command: "pnpm test", secret: "secret-value" }
  });
  storage.updateWorker(worker.id, { status: "succeeded", completedAt: new Date().toISOString(), exitCode: 0 });
  writeArtifact(repoRoot, storage, run.id, "log", "worker.log", "worker completed");
  storage.appendEvent({ runId: run.id, kind: "dashboard.seeded", message: "Dashboard fixture ready." });
  storage.close();
  return repoRoot;
}

function boundWorkflowRepo(currentState: string): string {
  const repoRoot = tempRepo("agent-loop-workflow-");
  mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".agent-loop", "config.json"),
    `${JSON.stringify(withConfigDefaults({ repoId: "example/fixture" }), null, 2)}\n`
  );
  const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
  storage.writeRepoConfig(withConfigDefaults({ repoId: "example/fixture" }));
  storage.createRun("RUNNING", {
    currentState,
    branch: "codex/issue-46-pr-delivery-loop-stage-evidence",
    worktreeClean: true
  });
  bindDeliveryWorkItem(storage, {
    issue: "46",
    title: "Connect pr-delivery-loop to workflow evidence",
    url: "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/46",
    branch: "codex/issue-46-pr-delivery-loop-stage-evidence",
    source: "cli"
  });
  storage.close();
  return repoRoot;
}

function appendStageEvidence(storage: SqliteAgentLoopStorage, runId: string, stageId: string, summary: string, substageId?: string, status = "done"): void {
  storage.appendEvent({
    runId,
    kind: "workflow_stage_evidence",
    message: summary,
    payload: {
      stageId,
      ...(substageId ? { substageId } : {}),
      source: "test",
      status
    }
  });
}

function appendReviewEvidence(
  storage: SqliteAgentLoopStorage,
  runId: string,
  summary: string,
  review: Record<string, string>
): void {
  storage.appendEvent({
    runId,
    kind: "workflow_stage_evidence",
    message: summary,
    payload: {
      stageId: "review",
      substageId: "reports_posted",
      source: "test",
      status: "done",
      evidenceRefIds: review.commentUrl ? [review.commentUrl] : [],
      review
    }
  });
}

function currentRunState(repoRoot: string): string | undefined {
  const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
  try {
    return storage.getCurrentRun()?.currentState;
  } finally {
    storage.close();
  }
}

function openGateId(repoRoot: string): string {
  const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
  try {
    return storage.listGates()[0]?.id ?? "";
  } finally {
    storage.close();
  }
}

function currentRunId(repoRoot: string): string | undefined {
  const storage = new SqliteAgentLoopStorage(join(repoRoot, ".agent-loop", "state.sqlite"));
  try {
    return storage.getCurrentRun()?.id;
  } finally {
    storage.close();
  }
}

function base(server: DashboardServerHandle): string {
  return `http://${server.host}:${server.port}`;
}
