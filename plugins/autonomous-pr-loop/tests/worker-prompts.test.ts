import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "../core/worker-prompts.js";
import { withConfigDefaults } from "../core/config.js";
import { resolveProfile } from "../core/profiles.js";
import type { WorkerType } from "../core/types.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("worker prompts", () => {
  afterEach(() => cleanupTempRepos());

  it("builds safe prompts for every worker type", () => {
    const repoRoot = tempRepo();
    writeFileSync(join(repoRoot, "AGENTS.md"), "始终使用简体中文\n");
    const config = withConfigDefaults({
      repoId: "example/fixture",
      lintCommand: "pnpm lint",
      testCommand: "pnpm test"
    });
    const types: WorkerType[] = ["planner", "implementation", "review-fix", "ci-fix", "reviewer"];

    for (const type of types) {
      const prompt = buildWorkerPrompt({
        repoRoot,
        run: {
          id: "run-1",
          status: "RUNNING",
          version: 0,
          createdAt: "2026-06-12T00:00:00.000Z",
          updatedAt: "2026-06-12T00:00:00.000Z"
        },
        state: "IMPLEMENT",
        type,
        config,
        profile: resolveProfile(config, "IMPLEMENT")
      });

      expect(prompt).toContain(`Worker: ${type}`);
      expect(prompt).toContain("Do not commit.");
      expect(prompt).toContain("Do not push.");
      expect(prompt).toContain("Do not create, update, ready, merge, or close pull requests.");
      expect(prompt).toContain("GitNexus");
      expect(prompt).toContain("Workflow Profile");
      expect(prompt).toContain("Default PR loop");
      expect(prompt).toContain("worker-result.schema.json");
      expect(prompt).toContain("始终使用简体中文");
    }
  });

  it("builds generic-loop prompts without PR scope language", () => {
    const repoRoot = tempRepo();
    const config = withConfigDefaults({
      repoId: "example/fixture",
      loopShape: "generic-loop",
      workflowProfile: "research_report_loop"
    });
    const prompt = buildWorkerPrompt({
      repoRoot,
      run: {
        id: "run-1",
        status: "RUNNING",
        version: 0,
        createdAt: "2026-06-12T00:00:00.000Z",
        updatedAt: "2026-06-12T00:00:00.000Z"
      },
      state: "EXECUTE_STEP",
      type: "implementation",
      config,
      profile: resolveProfile(config, "EXECUTE_STEP")
    });

    expect(prompt).toContain("loopShape: generic-loop");
    expect(prompt).toContain("# Generic Loop Worker: implementation");
    expect(prompt).toContain("inside the configured Generic Loop");
    expect(prompt).toContain("Expected deliverable: Markdown research report");
    expect(prompt).toContain("Complete only the generic-loop responsibility for EXECUTE_STEP");
    expect(prompt).toContain("prefix blocking repair items with `fix:`");
    expect(prompt).toContain("Allowed write roots: docs, reports");
    expect(prompt).toContain("Do not run release, deploy, publishing, notification, payment, or production-control side effects.");
    expect(prompt).not.toContain("baseBranch");
    expect(prompt).not.toContain("plansDir");
    expect(prompt).not.toContain("selected PR scope");
  });
});
