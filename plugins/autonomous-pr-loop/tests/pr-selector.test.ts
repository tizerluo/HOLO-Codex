import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withConfigDefaults } from "../core/config.js";
import { resolvePrSelection } from "../core/pr-selector.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("PR selector", () => {
  afterEach(() => cleanupTempRepos());

  it("selects the open PR that maps to a spec", () => {
    const repoRoot = repoWithSpecIndex();
    const selection = resolvePrSelection(repoRoot, config(), {
      pullRequests: [openPr(9, "codex/pr-h-bilingual-i18n")]
    });

    expect(selection.mode).toBe("current_pr");
    if (selection.mode !== "current_pr") throw new Error("expected current PR");
    expect(selection.item.id).toBe("PR H");
    expect(selection.pr.number).toBe(9);
    expect(selection.branchName).toBe("codex/pr-h-bilingual-i18n");
  });

  it("selects PR I after PR H has been merged", () => {
    const repoRoot = repoWithSpecIndex();
    const selection = resolvePrSelection(repoRoot, config(), {
      pullRequests: [mergedPr(9, "codex/pr-h-bilingual-i18n")]
    });

    expect(selection.mode).toBe("next_spec");
    if (selection.mode !== "next_spec") throw new Error("expected next spec");
    expect(selection.item.id).toBe("PR I");
    expect(selection.branchName).toBe("codex/pr-i-cross-repo-support");
  });

  it("reports ambiguity when multiple open PRs exist", () => {
    const repoRoot = repoWithSpecIndex();
    const selection = resolvePrSelection(repoRoot, config(), {
      pullRequests: [
        openPr(9, "codex/pr-h-bilingual-i18n"),
        openPr(10, "codex/pr-i-cross-repo-support")
      ]
    });

    expect(selection.mode).toBe("ambiguous");
    expect(selection.ambiguous).toBe(true);
    if (selection.mode !== "ambiguous") throw new Error("expected ambiguous selection");
    expect(selection.candidates).toHaveLength(2);
  });
});

function config() {
  return withConfigDefaults({ repoId: "example/fixture" });
}

function openPr(number: number, headRefName: string) {
  return {
    number,
    headRefName,
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    url: `https://example.test/pull/${number}`
  };
}

function mergedPr(number: number, headRefName: string) {
  return {
    ...openPr(number, headRefName),
    state: "MERGED",
    mergedAt: "2026-06-13T00:00:00Z"
  };
}

function repoWithSpecIndex(): string {
  const repoRoot = tempRepo("agent-loop-pr-selector-");
  const specs = join(repoRoot, "docs", "specs");
  mkdirSync(specs, { recursive: true });
  writeFileSync(join(specs, "README.md"), `# Specs\n\n已完成主线顺序：\n\n1. [PR A：First](./pr-a-first.md)\n后续 PR 顺序必须固定：\n\n9. [PR H：Bilingual i18n](./pr-h-bilingual-i18n.md)\n10. [PR I：Cross-Repo Support](./pr-i-cross-repo-support.md)\n`);
  writeFileSync(join(specs, "pr-a-first.md"), "# PR A First\n");
  writeFileSync(join(specs, "pr-h-bilingual-i18n.md"), "# PR H Bilingual i18n\n");
  writeFileSync(join(specs, "pr-i-cross-repo-support.md"), "# PR I Cross-Repo Support\n");
  return repoRoot;
}
