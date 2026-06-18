import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlanNavigator } from "../core/plan-parser.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("plan parser", () => {
  afterEach(() => cleanupTempRepos());

  it("parses a completed spec index as exhausted without depending on repository docs", () => {
    const repoRoot = tempRepo("agent-loop-plan-parser-exhausted-");
    writeSpecRepo(repoRoot, {
      readme: `# Specs

PR A-N 已完成。

已完成顺序：

1. [PR A：First](./pr-a-first.md)

PR H 后产品化顺序：

2. [PR H1：Observability](./pr-h1-observability.md)
3. [PR N：Theme Modes](./pr-n-theme-modes.md)
`,
      specs: {
        "pr-a-first.md": "# PR A First\n",
        "pr-h1-observability.md": "# PR H1 Observability\n",
        "pr-n-theme-modes.md": "# PR N Theme Modes\n"
      }
    });

    const model = parsePlanNavigator(repoRoot, "docs/plans");

    expect(model.completed.map((item) => item.id)).toContain("PR A");
    expect(model.completed.map((item) => item.id)).toContain("PR H1");
    expect(model.completed.map((item) => item.id)).toContain("PR N");
    expect(model.currentMilestone).toBe("PR N");
    expect(model.selectedNext).toBeUndefined();
    expect(model.candidates).toEqual([]);
    expect(model.evidence.join("\n")).toContain("Parsed");
  });

  it("selects the first uncompleted PR from an explicit future section", () => {
    const repoRoot = tempRepo("agent-loop-plan-parser-future-");
    writeSpecRepo(repoRoot, {
      readme: `# Specs

已完成主线顺序：

1. [PR A：First](./pr-a-first.md)

后续PR顺序：

2. [PR B：Second](./pr-b-second.md)
3. [PR C：Third](./pr-c-third.md)
`,
      specs: {
        "pr-a-first.md": "# PR A First\n",
        "pr-b-second.md": "# PR B Second\n",
        "pr-c-third.md": "# PR C Third\n"
      }
    });

    const model = parsePlanNavigator(repoRoot, "docs/plans");

    expect(model.completed.map((item) => item.id)).toContain("PR A");
    expect(model.selectedNext?.id).toBe("PR B");
    expect(model.selectedNext?.whySelected).toContain("first uncompleted");
  });

  it("infers the highest unmarked PR as next without hard-coded PR letters", () => {
    const repoRoot = tempRepo("agent-loop-plan-parser-");
    mkdirSync(join(repoRoot, "docs", "specs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "specs", "pr-a-first.md"), "# PR A: First\n");
    writeFileSync(join(repoRoot, "docs", "specs", "pr-b-second.md"), "# PR B: Second\n");

    const model = parsePlanNavigator(repoRoot, "docs/plans");

    expect(model.completed.map((item) => item.id)).toContain("PR A");
    expect(model.selectedNext?.id).toBe("PR B");
    expect(model.selectedNext?.whySelected).toContain("highest uncompleted");
  });
});

function writeSpecRepo(repoRoot: string, input: { readme: string; specs: Record<string, string> }): void {
  const specs = join(repoRoot, "docs", "specs");
  mkdirSync(specs, { recursive: true });
  writeFileSync(join(specs, "README.md"), input.readme);
  for (const [file, text] of Object.entries(input.specs)) {
    writeFileSync(join(specs, file), text);
  }
}
