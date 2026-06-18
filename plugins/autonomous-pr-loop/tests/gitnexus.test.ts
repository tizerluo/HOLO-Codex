import { afterEach, describe, expect, it } from "vitest";
import { withConfigDefaults, statePath } from "../core/config.js";
import { AgentLoopError } from "../core/errors.js";
import { gitnexusDetectChanges } from "../core/gitnexus.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo, withFakeExecutable } from "./helpers.js";

describe("gitnexus", () => {
  afterEach(() => cleanupTempRepos());

  it("gates when required gitnexus is unavailable", () => {
    const repoRoot = tempRepo();
    const restore = withFakeExecutable(repoRoot, "npx", `#!/bin/sh
echo "could not determine executable" >&2
exit 127
`);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");

    expect(() =>
      gitnexusDetectChanges(repoRoot, withConfigDefaults({ repoId: "owner/repo" }), storage, run.id)
    ).toThrow(AgentLoopError);
    try {
      gitnexusDetectChanges(repoRoot, withConfigDefaults({ repoId: "owner/repo" }), storage, run.id);
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("required_tool_unavailable");
    }
    storage.close();
    restore();
  });

  it("blocks commit guard when detect_changes fails", () => {
    const repoRoot = tempRepo();
    const restore = withFakeExecutable(repoRoot, "npx", `#!/bin/sh
echo "scope failed" >&2
exit 1
`);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");

    try {
      gitnexusDetectChanges(repoRoot, withConfigDefaults({ repoId: "owner/repo" }), storage, run.id);
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("gitnexus_check_failed");
    }
    storage.close();
    restore();
  });

  it("records alternative evidence when gitnexus is not required", () => {
    const repoRoot = tempRepo();
    const restore = withFakeExecutable(repoRoot, "npx", `#!/bin/sh
echo "not installed" >&2
exit 127
`);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING");

    const result = gitnexusDetectChanges(
      repoRoot,
      withConfigDefaults({ repoId: "owner/repo", gitnexusRequired: false }),
      storage,
      run.id
    );
    const decisions = storage.listDecisions(run.id);
    const artifacts = storage.listArtifacts(run.id);
    storage.close();
    restore();

    expect(result.ok).toBe(false);
    expect(decisions[0]?.kind).toBe("gitnexus_not_required");
    expect(artifacts[0]?.kind).toBe("log");
  });
});
