import { afterEach, describe, expect, it } from "vitest";
import { readConfigForEdit, saveConfigEdit } from "../core/config-editor.js";
import { runAgentLoopCli } from "../core/cli.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("config editor", () => {
  afterEach(() => cleanupTempRepos());

  it("saves valid config with diff and derives allowAutoMerge from mergeMode", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const snapshot = readConfigForEdit(repoRoot);
    const result = saveConfigEdit(repoRoot, {
      expectedHash: snapshot.hash,
      note: "Enable conditional merge after external reviewer guards are configured.",
      confirmationToken: "CONFIRM",
      nextConfig: {
        ...snapshot.config,
        mergeMode: "conditional",
        requiredChecks: ["ci"],
        carryoverTarget: "docs/local-release-readiness.md"
      }
    });

    expect(result.config.mergeMode).toBe("conditional");
    expect(result.config.allowAutoMerge).toBe(true);
    expect(result.diff.map((entry) => entry.field)).toContain("mergeMode");
    expect(result.snapshot.hash).not.toBe(snapshot.hash);
  });

  it("rejects high-risk config changes without note", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const snapshot = readConfigForEdit(repoRoot);

    expect(() => saveConfigEdit(repoRoot, {
      expectedHash: snapshot.hash,
      nextConfig: { ...snapshot.config, mergeMode: "conditional" }
    })).toThrow(/operator note/);
  });

  it("requires explicit confirmation for dangerous policy changes", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const snapshot = readConfigForEdit(repoRoot);

    expect(() => saveConfigEdit(repoRoot, {
      expectedHash: snapshot.hash,
      note: "Enable conditional merge.",
      confirmationToken: "yes",
      nextConfig: {
        ...snapshot.config,
        mergeMode: "conditional",
        carryoverTarget: "docs/local-release-readiness.md"
      }
    })).toThrow(/CONFIRM/);
  });
});
