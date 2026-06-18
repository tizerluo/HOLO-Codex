import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withConfigDefaults } from "../core/config.js";
import { AgentLoopError } from "../core/errors.js";
import {
  checkGhAuth,
  createDraftPullRequest,
  listPullRequestsByHead,
  runGhJson
} from "../core/github.js";
import { cleanupTempRepos, tempRepo, withFakeExecutable } from "./helpers.js";

describe("github cli wrapper", () => {
  afterEach(() => cleanupTempRepos());

  it("classifies missing gh auth as a login gate", () => {
    const repoRoot = tempRepo();
    const restore = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
echo "not logged in" >&2
exit 1
`);

    expect(() => checkGhAuth(repoRoot)).toThrow(AgentLoopError);
    try {
      checkGhAuth(repoRoot);
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("needs_secret_or_login");
    }
    restore();
  });

  it("retries transient gh read failures", async () => {
    const repoRoot = tempRepo();
    const count = join(repoRoot, "count");
    const restore = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
count=$(cat "${count}" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "${count}"
if [ "$count" -lt 3 ]; then echo "API rate limit" >&2; exit 1; fi
echo "[]"
`);

    const stdout = await runGhJson({
      repoRoot,
      config: withConfigDefaults({
        repoId: "owner/repo",
        githubRetryMaxAttempts: 3,
        githubRetryBaseDelayMs: 1
      })
    }, ["pr", "list", "--head", "branch", "--json", "number"]);
    restore();

    expect(stdout).toBe("[]");
    expect(readFileSync(count, "utf8").trim()).toBe("3");
  });

  it("classifies missing GitHub resources separately", async () => {
    const repoRoot = tempRepo();
    const restore = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
echo "not found" >&2
exit 1
`);

    try {
      await runGhJson({
        repoRoot,
        config: withConfigDefaults({ repoId: "owner/repo" })
      }, ["pr", "view", "99", "--json", "number"]);
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("github_resource_not_found");
      expect((error as AgentLoopError).details).toMatchObject({ classification: "not_found" });
    }
    restore();
  });

  it("creates draft PRs and parses existing PRs", async () => {
    const repoRoot = tempRepo();
    const log = join(repoRoot, "gh.log");
    const restore = withFakeExecutable(repoRoot, "gh", `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[{"number":7,"url":"https://github.test/pr/7","headRefName":"codex/x","baseRefName":"main","state":"OPEN","isDraft":true}]'
  exit 0
fi
echo "https://github.test/pr/7"
`);
    const options = { repoRoot, config: withConfigDefaults({ repoId: "owner/repo" }) };

    const prs = await listPullRequestsByHead(options, "codex/x");
    createDraftPullRequest(options, {
      title: "Title",
      body: "Body",
      head: "codex/x",
      base: "main"
    });
    restore();

    expect(prs[0]?.number).toBe(7);
    expect(readFileSync(log, "utf8")).toContain("pr create --draft");
  });
});
