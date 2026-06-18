import { describe, expect, it } from "vitest";
import { withConfigDefaults, validateConfig } from "../core/config.js";
import { GENERIC_LOOP_SHAPE, PR_LOOP_SHAPE, resolveLoopShape } from "../core/loop-shapes.js";
import { applyProfileConfig, resolveProfile, workflowProfileDefinition, workflowStages } from "../core/profiles.js";
import { LOOP_STATES, TERMINAL_STATES, TRANSITIONS, validateTransitionTable } from "../core/state-machine.js";
import { workerSandbox } from "../core/worker-prompts.js";

describe("loop shapes and profiles", () => {
  it("wraps the current PR loop without changing state machine data", () => {
    expect(PR_LOOP_SHAPE.id).toBe("pr-loop");
    expect(new Set(LOOP_STATES)).toEqual(new Set([...PR_LOOP_SHAPE.states, ...GENERIC_LOOP_SHAPE.states]));
    expect(TRANSITIONS).toEqual([...PR_LOOP_SHAPE.transitions, ...GENERIC_LOOP_SHAPE.transitions]);
    expect(new Set(TERMINAL_STATES)).toEqual(new Set([...PR_LOOP_SHAPE.terminalStates, ...GENERIC_LOOP_SHAPE.terminalStates]));
    expect(PR_LOOP_SHAPE.defaultRoleForState("WRITE_SPEC")).toBe("planner");
    expect(PR_LOOP_SHAPE.defaultRoleForState("IMPLEMENT")).toBe("implementation");
    expect(PR_LOOP_SHAPE.defaultRoleForState("SELF_CHECK")).toBe("reviewer");
    expect(PR_LOOP_SHAPE.defaultRoleForState("FIX_REVIEW")).toBe("review-fix");
    expect(validateTransitionTable()).toEqual([]);
  });

  it("resolves the generic loop shape", () => {
    const shape = resolveLoopShape("generic-loop");

    expect(shape.initialState).toBe("DEFINE_GOAL");
    expect(shape.lifecycleKind).toBe("generic");
    expect(shape.defaultRoleForState("DEFINE_GOAL")).toBe("planner");
    expect(shape.defaultRoleForState("EXECUTE_STEP")).toBe("implementation");
    expect(shape.defaultRoleForState("SELF_REVIEW")).toBe("reviewer");
    expect(validateTransitionTable()).toEqual([]);
  });

  it("resolves the default workflow profile and role mapping", () => {
    const config = withConfigDefaults({ repoId: "owner/repo" });
    const profile = resolveProfile(config, "SELF_CHECK");

    expect(profile.loopShape).toBe("pr-loop");
    expect(profile.workflowProfile).toBe("default_pr_loop");
    expect(profile.roleProfile).toBe("default_pr_roles");
    expect(profile.currentRole).toMatchObject({
      state: "SELF_CHECK",
      alias: "reviewer",
      workerType: "reviewer",
      sandbox: "read-only"
    });
    expect(profile.roleMapping.map((role) => [role.state, role.workerType])).toContainEqual(["IMPLEMENT", "implementation"]);
  });

  it("keeps role aliases inside the existing worker sandbox model", () => {
    const config = validateConfig({ repoId: "owner/repo", workflowProfile: "release_ready_loop" });
    const profile = resolveProfile(config);

    for (const role of profile.roleMapping) {
      expect(role.sandbox).toBe(workerSandbox(role.workerType));
    }
    expect(profile.roleMapping.some((role) => role.alias === "release-manager")).toBe(false);
  });

  it("applies profile config as conservative effective config", () => {
    const config = withConfigDefaults({
      repoId: "owner/repo",
      workflowProfile: "docs_only_loop",
      requiredChecks: ["ci"],
      protectedPaths: ["AGENTS.md"],
      maxCiReruns: 2
    });
    const effective = applyProfileConfig(config);

    expect(effective.requiredChecks).toEqual(["ci"]);
    expect(effective.protectedPaths).toEqual(["AGENTS.md"]);
    expect(effective.maxCiReruns).toBe(0);
    expect(effective.requireReviewApproval).toBe(true);
  });

  it("forecasts workflow stages from the actual PR loop shape", () => {
    const stages = workflowStages(withConfigDefaults({ repoId: "owner/repo" }));

    expect(stages.map((stage) => stage.state)).toContain("WAIT_REVIEW_OR_CI");
    expect(stages.find((stage) => stage.state === "IMPLEMENT")).toMatchObject({
      roleAlias: "implementer",
      workerType: "implementation"
    });
    expect(stages.some((stage) => stage.state === "BLOCKED")).toBe(false);
  });

  it("forecasts generic workflow stages without PR lifecycle states", () => {
    const config = validateConfig({ repoId: "owner/repo", loopShape: "generic-loop", workflowProfile: "research_report_loop" });
    const profile = resolveProfile(config, "PLAN_WORK");
    const stages = workflowStages(config);

    expect(profile.loopShape).toBe("generic-loop");
    expect(profile.expectedDeliverable).toBe("Markdown research report");
    expect(profile.allowedWriteRoots).toEqual(["docs", "reports"]);
    expect(stages.map((stage) => stage.state)).toContain("DEFINE_GOAL");
    expect(stages.map((stage) => stage.state)).toContain("HUMAN_GATE");
    expect(stages.map((stage) => stage.state)).not.toContain("SELECT_NEXT_PR");
    expect(stages.find((stage) => stage.state === "PLAN_WORK")).toMatchObject({ sandbox: "read-only" });
    expect(stages.find((stage) => stage.state === "EXECUTE_STEP")).toMatchObject({ sandbox: "workspace-write" });
  });

  it("exposes repo hygiene metadata used by the generic-loop example", () => {
    const config = validateConfig({ repoId: "owner/repo", loopShape: "generic-loop", workflowProfile: "repo_hygiene_loop" });
    const profile = resolveProfile(config, "EXECUTE_STEP");
    const workflow = workflowProfileDefinition("repo_hygiene_loop");
    const stages = workflowStages(config);

    expect(profile.loopShape).toBe("generic-loop");
    expect(profile.workflowProfile).toBe("repo_hygiene_loop");
    expect(profile.roleProfile).toBe("default_pr_roles");
    expect(profile.expectedDeliverable).toBe("Repo hygiene audit report");
    expect(profile.allowedWriteRoots).toEqual(["docs", "reports"]);
    expect(workflow.requiredEvidence).toEqual(["checked files/commands", "finding severity", "recommended action"]);
    expect(profile.likelyGates).toEqual(expect.arrayContaining(["generic_goal_needs_confirmation", "generic_human_gate", "generic_scope_change_requested"]));
    expect(stages.find((stage) => stage.state === "PLAN_WORK")).toMatchObject({ sandbox: "read-only" });
    expect(stages.find((stage) => stage.state === "EXECUTE_STEP")).toMatchObject({ sandbox: "workspace-write" });
    expect(stages.find((stage) => stage.state === "HUMAN_GATE")).toBeTruthy();
  });
});
