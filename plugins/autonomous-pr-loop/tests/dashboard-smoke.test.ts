import { describe, expect, it } from "vitest";
import { checkWorkflowBoardSmokeConsistency, dashboardApiSmokeCheck } from "../core/dashboard-smoke.js";

describe("dashboard smoke checks", () => {
  it("marks non-ok API payloads as failed", () => {
    expect(dashboardApiSmokeCheck("mission_control", "Mission Control API", { ok: false })).toMatchObject({
      id: "mission_control",
      status: "failed"
    });
  });

  it("fails workflow consistency when selected stages are absent", () => {
    expect(checkWorkflowBoardSmokeConsistency({
      ok: true,
      data: {
        activeStageId: "review",
        selectedStageId: "cleanup",
        stages: [{ id: "verify" }],
        cleanupChecks: []
      }
    })).toMatchObject({
      status: "failed",
      evidence: "Active stage review is missing from stages."
    });
  });

  it("fails workflow consistency when cleanup sidebar and checklist disagree", () => {
    expect(checkWorkflowBoardSmokeConsistency({
      ok: true,
      data: {
        activeStageId: "cleanup",
        selectedStageId: "cleanup",
        stages: [{
          id: "cleanup",
          substages: [{ id: "worktree_clean", status: "done" }]
        }],
        cleanupChecks: [{ id: "worktree_clean", status: "pending" }]
      }
    })).toMatchObject({
      status: "failed",
      evidence: "Cleanup substage worktree_clean is done while checklist is pending."
    });
  });
});
