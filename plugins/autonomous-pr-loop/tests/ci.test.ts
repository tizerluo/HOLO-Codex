import { describe, expect, it } from "vitest";
import { evaluateCiChecks } from "../core/ci.js";
import { withConfigDefaults } from "../core/config.js";

describe("ci", () => {
  it("classifies required checks as green", () => {
    const result = evaluateCiChecks(withConfigDefaults({
      repoId: "owner/repo",
      requiredChecks: ["test"]
    }), [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-01-01T00:00:00Z" }
    ]);

    expect(result.state).toBe("green");
  });

  it("uses the latest check when names repeat", () => {
    const result = evaluateCiChecks(withConfigDefaults({
      repoId: "owner/repo",
      requiredChecks: ["test"]
    }), [
      { name: "test", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-01-01T00:00:00Z" },
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-01-01T00:01:00Z" }
    ]);

    expect(result.state).toBe("green");
  });

  it("classifies failed, pending, missing, and empty required checks", () => {
    expect(evaluateCiChecks(withConfigDefaults({
      repoId: "owner/repo",
      requiredChecks: ["test"]
    }), [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }]).state).toBe("failed");
    expect(evaluateCiChecks(withConfigDefaults({
      repoId: "owner/repo",
      requiredChecks: ["test"]
    }), [{ name: "test", status: "IN_PROGRESS" }]).state).toBe("pending");
    expect(evaluateCiChecks(withConfigDefaults({
      repoId: "owner/repo",
      requiredChecks: ["test"]
    }), [{ name: "test", status: "COMPLETED", conclusion: "CANCELLED" }]).state).toBe("pending");
    expect(evaluateCiChecks(withConfigDefaults({
      repoId: "owner/repo",
      requiredChecks: ["test"]
    }), []).gate).toBe("ci_required_checks_missing");
    expect(evaluateCiChecks(withConfigDefaults({ repoId: "owner/repo" }), []).gate).toBe(
      "ci_required_checks_missing"
    );
  });

  it("uses observed checks when required checks are not configured", () => {
    expect(evaluateCiChecks(withConfigDefaults({ repoId: "owner/repo" }), [
      { name: "Node 22.x", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Node 24.x", status: "COMPLETED", conclusion: "SUCCESS" }
    ]).state).toBe("green");
    expect(evaluateCiChecks(withConfigDefaults({ repoId: "owner/repo" }), [
      { name: "Node 22.x", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "Node 24.x", status: "COMPLETED", conclusion: "SUCCESS" }
    ]).state).toBe("failed");
    expect(evaluateCiChecks(withConfigDefaults({ repoId: "owner/repo" }), [
      { name: "Node 22.x", status: "IN_PROGRESS" }
    ]).state).toBe("pending");
  });

  it("normalizes legacy status context state values", () => {
    expect(evaluateCiChecks(withConfigDefaults({ repoId: "owner/repo" }), [
      { context: "ci", state: "SUCCESS" }
    ]).state).toBe("green");
    expect(evaluateCiChecks(withConfigDefaults({ repoId: "owner/repo" }), [
      { context: "ci", state: "ERROR" }
    ]).state).toBe("failed");
    expect(evaluateCiChecks(withConfigDefaults({ repoId: "owner/repo" }), [
      { context: "ci", state: "PENDING" }
    ]).state).toBe("pending");
  });
});
