import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoopError } from "../core/errors.js";
import { executePrLifecycleStep } from "../core/pr-lifecycle.js";
import { statePath, withConfigDefaults } from "../core/config.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo, withFakeExecutable } from "./helpers.js";

describe("pr lifecycle", () => {
  afterEach(() => cleanupTempRepos());

  it("reuses an existing PR instead of creating a duplicate", async () => {
    const repoRoot = tempRepo();
    const restoreGit = withFakeExecutable(repoRoot, "git", `#!/bin/sh
if [ "$1" = "branch" ]; then echo "codex/next"; exit 0; fi
exit 0
`);
    const restoreGh = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "duplicate create" >&2; exit 1; fi
echo '[{"number":9,"url":"https://github.test/pr/9","headRefName":"codex/next","baseRefName":"main","state":"OPEN","isDraft":true}]'
`);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "COMMIT_PUSH_PR" });

    const result = await executePrLifecycleStep({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "owner/repo" }),
      state: "COMMIT_PUSH_PR"
    });
    const link = storage.getPrLink(run.id);
    const decisions = storage.listDecisions(run.id);
    storage.close();
    restoreGh();
    restoreGit();

    expect(result.nextState).toBe("WAIT_REVIEW_OR_CI");
    expect(link?.prNumber).toBe(9);
    expect(decisions[0]?.kind).toBe("pr_reused");
  });

  it("times out waiting for pending CI", async () => {
    const repoRoot = tempRepo();
    const restoreGh = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
if [ "$1" = "api" ]; then echo '{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}'; exit 0; fi
echo '{"number":9,"url":"https://github.test/pr/9","headRefName":"codex/next","baseRefName":"main","state":"OPEN","isDraft":true,"reviewDecision":"APPROVED","statusCheckRollup":[{"name":"ci","status":"IN_PROGRESS"}]}'
`);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "WAIT_REVIEW_OR_CI" });
    storage.upsertPrLink({
      runId: run.id,
      branch: "codex/next",
      prNumber: 9,
      url: "https://github.test/pr/9",
      headRef: "codex/next",
      baseRef: "main",
      state: "OPEN",
      draft: true
    });

    await expect(executePrLifecycleStep({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({
        repoId: "owner/repo",
        requiredChecks: ["ci"],
        reviewCiPollIntervalMs: 1,
        reviewCiMaxWaitMs: 1
      }),
      state: "WAIT_REVIEW_OR_CI"
    })).rejects.toMatchObject({ code: "ci_pending_timeout" } satisfies Partial<AgentLoopError>);
    storage.close();
    restoreGh();
  });

  it("does not merge when auto-merge is disabled", async () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "READY_TO_MERGE" });
    storage.upsertPrLink({
      runId: run.id,
      branch: "codex/next",
      prNumber: 9,
      url: "https://github.test/pr/9",
      headRef: "codex/next",
      baseRef: "main",
      state: "OPEN",
      draft: false
    });

    await expect(executePrLifecycleStep({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "owner/repo", allowAutoMerge: false }),
      state: "READY_TO_MERGE"
    })).rejects.toMatchObject({ code: "merge_requires_confirmation" } satisfies Partial<AgentLoopError>);
    storage.close();
  });

  it("blocks READY_TO_MERGE when conditional merge evidence is incomplete", async () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "READY_TO_MERGE" });

    await expect(executePrLifecycleStep({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "owner/repo", allowAutoMerge: true }),
      state: "READY_TO_MERGE"
    })).rejects.toMatchObject({ code: "merge_requires_confirmation" } satisfies Partial<AgentLoopError>);
    storage.close();
  });

  it("advances to MERGE from READY_TO_MERGE when conditional evidence is complete", async () => {
    const repoRoot = tempRepo();
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "READY_TO_MERGE" });
    seedMergeReadiness(storage, run.id);

    const result = await executePrLifecycleStep({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "owner/repo", allowAutoMerge: true, requiredChecks: ["ci"] }),
      state: "READY_TO_MERGE"
    });
    storage.close();

    expect(result.nextState).toBe("MERGE");
  });

  it("blocks protected paths before staging", async () => {
    const repoRoot = tempRepo();
    const gitLog = join(repoRoot, "git.log");
    const restoreGit = withFakeExecutable(repoRoot, "git", `#!/bin/sh
echo "$@" >> "${gitLog}"
if [ "$1" = "branch" ]; then echo "codex/next"; exit 0; fi
if [ "$1" = "status" ]; then echo "?? .env"; exit 0; fi
if [ "$1" = "diff" ]; then echo ".env"; exit 0; fi
exit 0
`);
    const restoreGh = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
echo '[]'
`);
    const restoreNpx = withFakeExecutable(repoRoot, "npx", `#!/bin/sh
exit 0
`);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "COMMIT_PUSH_PR" });
    seedPublishPrerequisites(storage, run.id);

    await expect(executePrLifecycleStep({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "owner/repo" }),
      state: "COMMIT_PUSH_PR"
    })).rejects.toMatchObject({ code: "policy_violation" } satisfies Partial<AgentLoopError>);
    storage.close();
    restoreNpx();
    restoreGh();
    restoreGit();

    expect(readFileSync(gitLog, "utf8")).not.toContain("add -- .env");
  });

  it("does not add, commit, or push when GitNexus detect_changes fails", async () => {
    const repoRoot = tempRepo();
    const gitLog = join(repoRoot, "git.log");
    const restoreGit = withFakeExecutable(repoRoot, "git", `#!/bin/sh
echo "$@" >> "${gitLog}"
if [ "$1" = "branch" ]; then echo "codex/next"; exit 0; fi
exit 0
`);
    const restoreGh = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
echo '[]'
`);
    const restoreNpx = withFakeExecutable(repoRoot, "npx", `#!/bin/sh
echo "detect failed" >&2
exit 1
`);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "COMMIT_PUSH_PR" });
    seedPublishPrerequisites(storage, run.id);

    await expect(executePrLifecycleStep({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "owner/repo" }),
      state: "COMMIT_PUSH_PR"
    })).rejects.toMatchObject({ code: "gitnexus_check_failed" } satisfies Partial<AgentLoopError>);
    storage.close();
    restoreNpx();
    restoreGh();
    restoreGit();

    const log = readFileSync(gitLog, "utf8");
    expect(log).not.toContain("add --");
    expect(log).not.toContain("commit -m");
    expect(log).not.toContain("push -u");
  });

  it("continues push and PR creation when a clean branch already differs from base", async () => {
    const repoRoot = tempRepo();
    const gitLog = join(repoRoot, "git.log");
    const ghCount = join(repoRoot, "gh-count");
    const restoreGit = withFakeExecutable(repoRoot, "git", `#!/bin/sh
echo "$@" >> "${gitLog}"
if [ "$1" = "branch" ]; then echo "codex/next"; exit 0; fi
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "diff" ]; then echo "src/file.ts"; exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "codex/next" ]; then echo "abc"; exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "origin/codex/next" ]; then exit 1; fi
exit 0
`);
    const restoreGh = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
count=$(cat "${ghCount}" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "${ghCount}"
if [ "$1" = "pr" ] && [ "$2" = "list" ] && [ "$count" -eq 1 ]; then echo '[]'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[{"number":10,"url":"https://github.test/pr/10","headRefName":"codex/next","baseRefName":"main","state":"OPEN","isDraft":true}]'
  exit 0
fi
echo "https://github.test/pr/10"
`);
    const restoreNpx = withFakeExecutable(repoRoot, "npx", `#!/bin/sh
exit 0
`);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "COMMIT_PUSH_PR" });
    seedPublishPrerequisites(storage, run.id);

    const result = await executePrLifecycleStep({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "owner/repo" }),
      state: "COMMIT_PUSH_PR"
    });
    const link = storage.getPrLink(run.id);
    const decisions = storage.listDecisions(run.id);
    storage.close();
    restoreNpx();
    restoreGh();
    restoreGit();

    const log = readFileSync(gitLog, "utf8");
    expect(result.nextState).toBe("WAIT_REVIEW_OR_CI");
    expect(link?.prNumber).toBe(10);
    expect(decisions.map((decision) => decision.kind)).toContain("existing_branch_diff");
    expect(log).toContain("push -u origin codex/next");
    expect(log).not.toContain("add --");
    expect(log).not.toContain("commit -m");
  });

  it("does not add, commit, or push when publish prerequisites are missing", async () => {
    const repoRoot = tempRepo();
    const gitLog = join(repoRoot, "git.log");
    const restoreGit = withFakeExecutable(repoRoot, "git", `#!/bin/sh
echo "$@" >> "${gitLog}"
if [ "$1" = "branch" ]; then echo "codex/next"; exit 0; fi
exit 0
`);
    const restoreGh = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
echo '[]'
`);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "COMMIT_PUSH_PR" });

    await expect(executePrLifecycleStep({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "owner/repo" }),
      state: "COMMIT_PUSH_PR"
    })).rejects.toMatchObject({ code: "policy_violation" } satisfies Partial<AgentLoopError>);
    storage.close();
    restoreGh();
    restoreGit();

    const log = readFileSync(gitLog, "utf8");
    expect(log).not.toContain("add --");
    expect(log).not.toContain("commit -m");
    expect(log).not.toContain("push -u");
  });
});

function seedPublishPrerequisites(storage: SqliteAgentLoopStorage, runId: string): void {
  storage.recordRunCheck({
    runId,
    kind: "gitnexus_detect_changes",
    status: "passed"
  });
  storage.recordRunCheck({
    runId,
    kind: "self_check",
    status: "passed"
  });
}

function seedMergeReadiness(storage: SqliteAgentLoopStorage, runId: string): void {
  seedPublishPrerequisites(storage, runId);
  storage.recordRunCheck({
    runId,
    kind: "scope_guard",
    status: "passed"
  });
  storage.recordRunCheck({
    runId,
    kind: "protected_paths",
    status: "passed"
  });
  storage.recordRunCheck({
    runId,
    kind: "carryover_recorded",
    status: "skipped"
  });
  storage.replaceCiChecks(runId, 1, [{ name: "ci", status: "completed", conclusion: "success" }]);
  storage.appendDecision({
    runId,
    kind: "review_approved",
    message: "Review approved."
  });
}
