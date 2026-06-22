import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkWorkflowBoardSmokeConsistency, dashboardApiSmokeCheck, runDashboardSmoke } from "../core/dashboard-smoke.js";

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

  it("fails instead of hanging when dashboard requests exceed the smoke deadline", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
        return;
      }
      signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    try {
      const report = await runDashboardSmoke(mkdtempSync(join(tmpdir(), "agent-loop-dashboard-deadline-")), {
        timeoutMs: 1
      });

      expect(report.ok).toBe(false);
      expect(report.status).toBe("fail");
      expect(report.exitCodeContract).toContain("Exit 0 means no failed checks");
      expect(report.checks.find((check) => check.id === "loading_settled")).toMatchObject({
        status: "failed",
        evidence: "Dashboard smoke exceeded the 1ms request deadline."
      });
      expect(report.checks.find((check) => check.id === "dashboard_index")?.evidence).toContain("timed out");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
