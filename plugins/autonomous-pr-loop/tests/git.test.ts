import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoopError } from "../core/errors.js";
import { createBranch, getChangedFiles, git, syncBaseBranch } from "../core/git.js";
import { cleanupTempRepos, tempRepo, withFakeExecutable } from "./helpers.js";

describe("git lifecycle", () => {
  afterEach(() => cleanupTempRepos());

  it("syncs base branch with checkout and ff-only pull", () => {
    const repoRoot = tempRepo();
    const log = join(repoRoot, "git.log");
    const restore = withFakeExecutable(repoRoot, "git", `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "remote" ]; then echo "ssh://git@github.com/owner/repo.git"; exit 0; fi
if [ "$1" = "status" ]; then exit 0; fi
exit 0
`);

    syncBaseBranch(repoRoot, "main");
    restore();

    expect(readFileSync(log, "utf8")).toContain("checkout main");
    expect(readFileSync(log, "utf8")).toContain("pull --ff-only origin main");
  });

  it("gates dirty worktrees and unsupported remotes", () => {
    const dirtyRepo = tempRepo();
    const dirtyRestore = withFakeExecutable(dirtyRepo, "git", `#!/bin/sh
if [ "$1" = "remote" ]; then echo "ssh://git@github.com/owner/repo.git"; exit 0; fi
if [ "$1" = "status" ]; then echo " M file"; exit 0; fi
exit 0
`);
    expect(() => syncBaseBranch(dirtyRepo, "main")).toThrow(AgentLoopError);
    dirtyRestore();

    const unsupportedRepo = tempRepo();
    const unsupportedRestore = withFakeExecutable(unsupportedRepo, "git", `#!/bin/sh
if [ "$1" = "remote" ]; then echo "ssh://git@example.com/owner/repo.git"; exit 0; fi
exit 0
`);
    try {
      syncBaseBranch(unsupportedRepo, "main");
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("unsupported_remote");
    }
    unsupportedRestore();
  });

  it("creates a suffixed branch when the requested branch already exists", () => {
    const repoRoot = tempRepo();
    const log = join(repoRoot, "git.log");
    const restore = withFakeExecutable(repoRoot, "git", `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "rev-parse" ] && [ "$3" = "codex/next" ]; then echo "abc123"; exit 0; fi
if [ "$1" = "rev-parse" ]; then exit 1; fi
if [ "$1" = "ls-remote" ]; then exit 1; fi
exit 0
`);

    const result = createBranch(repoRoot, "codex/next");
    restore();

    expect(result.branch).toBe("codex/next-2");
    expect(readFileSync(log, "utf8")).toContain("checkout -b codex/next-2");
  });

  it("rejects dangerous git commands before execution", () => {
    expect(() => git(tempRepo(), ["reset", "--hard"])).toThrow(AgentLoopError);
    expect(() => git(tempRepo(), ["clean", "-fdx"])).toThrow(AgentLoopError);
    expect(() => git(tempRepo(), ["push", "--force"])).toThrow(AgentLoopError);
    expect(() => git(tempRepo(), ["rebase", "main"])).toThrow(AgentLoopError);
  });

  it("lists staged, unstaged, and untracked files from porcelain status", () => {
    const repoRoot = tempRepo();
    const restore = withFakeExecutable(repoRoot, "git", `#!/bin/sh
if [ "$1" = "status" ]; then
  printf 'M  staged.ts\\n M unstaged.ts\\n?? new-file.ts\\nR  old.ts -> renamed.ts\\n'
  exit 0
fi
exit 1
`);

    const files = getChangedFiles(repoRoot);
    restore();

    expect(files).toEqual(["staged.ts", "unstaged.ts", "new-file.ts", "renamed.ts"]);
  });
});
