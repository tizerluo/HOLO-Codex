import { describe, expect, it } from "vitest";
import { describeAutonomyPosture, evaluateMergeReadiness } from "../core/autonomy-policy.js";
import { withConfigDefaults } from "../core/config.js";

describe("autonomy policy", () => {
  it("fills Human On Loop defaults and derives legacy allowAutoMerge from mergeMode", () => {
    const config = withConfigDefaults({ repoId: "owner/repo", allowAutoMerge: true });

    expect(config.autonomyMode).toBe("autonomous_until_gate");
    expect(config.mergeMode).toBe("conditional");
    expect(config.allowAutoMerge).toBe(true);
    expect(describeAutonomyPosture(config).allowConditionalMerge).toBe(true);
  });

  it("returns ready for conditional merge only when evidence is complete", () => {
    const config = withConfigDefaults({
      repoId: "owner/repo",
      mergeMode: "conditional",
      requiredChecks: ["ci"],
      requireReviewApproval: true
    });
    const ready = evaluateMergeReadiness({
      config,
      ci: [{ id: "ci", runId: "run", prNumber: 1, name: "ci", status: "completed", conclusion: "success", observedAt: "now" }],
      reviewComments: [],
      gates: [],
      decisions: [{ id: "decision", runId: "run", kind: "review_approved", message: "Review approved.", createdAt: "now" }],
      runChecks: [
        { runId: "run", kind: "self_check", status: "passed", createdAt: "now" },
        { runId: "run", kind: "gitnexus_detect_changes", status: "passed", createdAt: "now" },
        { runId: "run", kind: "scope_guard", status: "passed", createdAt: "now" },
        { runId: "run", kind: "protected_paths", status: "passed", createdAt: "now" },
        { runId: "run", kind: "carryover_recorded", status: "skipped", createdAt: "now" }
      ]
    });

    expect(ready.ready).toBe(true);
    expect(ready.state).toBe("ready");
  });

  it("does not require per-merge human confirmation when conditional evidence is missing", () => {
    const config = withConfigDefaults({ repoId: "owner/repo", mergeMode: "conditional", requiredChecks: [] });
    const readiness = evaluateMergeReadiness({
      config,
      ci: [],
      reviewComments: [],
      gates: [],
      decisions: [],
      runChecks: []
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.state).toBe("missing_evidence");
    expect(readiness.missingConditions).toContain("CI checks observed or required checks configured");
    expect(readiness.missingConditions).toContain("scope guard passed");
  });

  it("uses observed green checks when required checks are not configured", () => {
    const config = withConfigDefaults({ repoId: "owner/repo", mergeMode: "conditional", requiredChecks: [] });
    const readiness = evaluateMergeReadiness({
      config,
      ci: [
        { id: "ci-22", runId: "run", prNumber: 1, name: "Node 22.x", status: "COMPLETED", conclusion: "SUCCESS", observedAt: "now" },
        { id: "ci-24", runId: "run", prNumber: 1, name: "Node 24.x", status: "COMPLETED", conclusion: "SUCCESS", observedAt: "now" }
      ],
      reviewComments: [],
      gates: [],
      decisions: [],
      runChecks: []
    });

    expect(readiness.evidence).toContain("observed check green: Node 22.x");
    expect(readiness.evidence).toContain("observed check green: Node 24.x");
    expect(readiness.missingConditions).not.toContain("CI checks observed or required checks configured");
  });
});
