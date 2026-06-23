import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runReleaseDoctor, type ReleaseDoctorOptions } from "../core/release-doctor.js";
import type { CommandResult } from "../core/command.js";

describe("release doctor", () => {
  it("passes when release preflight state is clean and target version is unpublished", () => {
    const repoRoot = releaseFixture("0.2.0");
    const report = runReleaseDoctor(repoRoot, {
      commandRunner: cleanCommandRunner()
    });

    expect(report.status).toBe("pass");
    expect(report.ok).toBe(true);
    expect(report.version).toBe("0.2.0");
    expect(report.checks.find((check) => check.id === "version_metadata")).toMatchObject({ status: "pass" });
    expect(report.checks.find((check) => check.id === "npm_version")).toMatchObject({ status: "pass" });
  });

  it("fails when package version metadata is not synchronized", () => {
    const repoRoot = releaseFixture("0.2.0");
    writeFileSync(join(repoRoot, "plugins/autonomous-pr-loop/package.json"), `${JSON.stringify({
      name: "autonomous-pr-loop",
      version: "0.1.9"
    })}\n`);

    const report = runReleaseDoctor(repoRoot, {
      commandRunner: cleanCommandRunner()
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "version_metadata")).toMatchObject({
      status: "fail",
      message: "Release version metadata is not synchronized."
    });
  });

  it("fails when npm or GitHub already has the target release", () => {
    const repoRoot = releaseFixture("0.2.0");
    const report = runReleaseDoctor(repoRoot, {
      commandRunner: (file, args, cwd) => {
        if (file === "npm" && args[0] === "view") {
          return ok("\"0.2.0\"");
        }
        if (file === "gh" && args[0] === "release" && args[1] === "view") {
          return ok(JSON.stringify({ tagName: "v0.2.0", url: "https://github.com/owner/repo/releases/tag/v0.2.0" }));
        }
        return cleanCommandRunner()(file, args, cwd);
      }
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "npm_version")).toMatchObject({ status: "fail" });
    expect(report.checks.find((check) => check.id === "github_release")).toMatchObject({ status: "fail" });
  });

  it("fails when an open issue body marks a release blocker", () => {
    const repoRoot = releaseFixture("0.2.0");
    const report = runReleaseDoctor(repoRoot, {
      commandRunner: (file, args, cwd) => {
        if (file === "gh" && args[0] === "issue") {
          return ok(JSON.stringify([{
            number: 99,
            title: "Investigate release risk",
            body: "This is a P1 release-blocker until fixed.",
            url: "https://github.com/owner/repo/issues/99",
            labels: []
          }]));
        }
        return cleanCommandRunner()(file, args, cwd);
      }
    });

    expect(report.status).toBe("fail");
    expect(report.summary.releaseBlockers).toBe(1);
    expect(report.checks.find((check) => check.id === "release_blocking_issues")).toMatchObject({ status: "fail" });
  });

  it("fails when an open issue label marks a release blocker with spaces", () => {
    const repoRoot = releaseFixture("0.2.0");
    const report = runReleaseDoctor(repoRoot, {
      commandRunner: (file, args, cwd) => {
        if (file === "gh" && args[0] === "issue") {
          return ok(JSON.stringify([{
            number: 100,
            title: "Release risk",
            body: "",
            url: "https://github.com/owner/repo/issues/100",
            labels: [{ name: "release blocker" }]
          }]));
        }
        return cleanCommandRunner()(file, args, cwd);
      }
    });

    expect(report.status).toBe("fail");
    expect(report.summary.releaseBlockers).toBe(1);
    expect(report.checks.find((check) => check.id === "release_blocking_issues")).toMatchObject({ status: "fail" });
  });

  it("warns when generated dist files are older than source files", () => {
    const repoRoot = releaseFixture("0.2.0");
    const source = join(repoRoot, "plugins/autonomous-pr-loop/hooks/pre-tool-use.ts");
    const dist = join(repoRoot, "plugins/autonomous-pr-loop/hooks/dist/pre-tool-use.js");
    const now = new Date();
    utimesSync(dist, new Date(now.getTime() - 10_000), new Date(now.getTime() - 10_000));
    utimesSync(source, now, now);

    const report = runReleaseDoctor(repoRoot, {
      commandRunner: cleanCommandRunner()
    });

    expect(report.status).toBe("warn");
    expect(report.checks.find((check) => check.id === "generated_dist")).toMatchObject({ status: "warn" });
  });

  it("fails when generated dist files are missing", () => {
    const repoRoot = releaseFixture("0.2.0");
    writeFileSync(join(repoRoot, "plugins/autonomous-pr-loop/hooks/dist/pre-tool-use.js"), "");
    rmSync(join(repoRoot, "plugins/autonomous-pr-loop/hooks/dist/pre-tool-use.js"));

    const report = runReleaseDoctor(repoRoot, {
      commandRunner: cleanCommandRunner()
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "generated_dist")).toMatchObject({ status: "fail" });
  });

  it("redacts secrets from command diagnostics before reporting", () => {
    const repoRoot = releaseFixture("0.2.0");
    const report = runReleaseDoctor(repoRoot, {
      commandRunner: (file, args, cwd) => {
        if (file === "gh" && args[0] === "release") {
          return err("failed with Bearer abcdefghijklmnopqrstuvwxyz token=ghp_123456789012345678901234567890123456");
        }
        return cleanCommandRunner()(file, args, cwd);
      }
    });
    const text = JSON.stringify(report);

    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("ghp_123456789012345678901234567890123456");
    expect(text).toContain("Bearer <redacted-token>");
    expect(text).toContain("token=<redacted>");
  });

  it("fails when the release workflow is missing required release markers", () => {
    const repoRoot = releaseFixture("0.2.0");
    writeFileSync(join(repoRoot, ".github/workflows/release.yml"), "name: Release\non:\n  workflow_dispatch:\n");

    const report = runReleaseDoctor(repoRoot, {
      commandRunner: cleanCommandRunner()
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "release_workflow")).toMatchObject({ status: "fail" });
  });
});

function releaseFixture(version: string): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "agent-loop-release-doctor-"));
  mkdirSync(join(repoRoot, "plugins/autonomous-pr-loop/.codex-plugin"), { recursive: true });
  mkdirSync(join(repoRoot, "plugins/autonomous-pr-loop/mcp-server/src"), { recursive: true });
  mkdirSync(join(repoRoot, "plugins/autonomous-pr-loop/mcp-server/dist"), { recursive: true });
  mkdirSync(join(repoRoot, "plugins/autonomous-pr-loop/core"), { recursive: true });
  mkdirSync(join(repoRoot, "plugins/autonomous-pr-loop/hooks/dist"), { recursive: true });
  mkdirSync(join(repoRoot, ".github/workflows"), { recursive: true });
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  writeFileSync(join(repoRoot, "package.json"), `${JSON.stringify({
    name: "holo-codex",
    version,
    scripts: {
      lint: "tsc --noEmit",
      test: "vitest run",
      "build:hooks": "esbuild hooks"
    }
  }, null, 2)}\n`);
  writeFileSync(join(repoRoot, "plugins/autonomous-pr-loop/package.json"), `${JSON.stringify({
    name: "autonomous-pr-loop",
    version
  })}\n`);
  writeFileSync(join(repoRoot, "plugins/autonomous-pr-loop/.codex-plugin/plugin.json"), `${JSON.stringify({
    name: "autonomous-pr-loop",
    version
  })}\n`);
  const serverInfo = `serverInfo: { name: "autonomous-pr-loop", version: "${version}" }`;
  writeFileSync(join(repoRoot, "plugins/autonomous-pr-loop/mcp-server/src/index.ts"), serverInfo);
  writeFileSync(join(repoRoot, "plugins/autonomous-pr-loop/mcp-server/dist/index.js"), serverInfo);
  for (const name of ["pre-tool-use", "post-tool-use", "user-prompt-submit", "stop", "session-start", "pre-compact", "post-compact", "permission-request"]) {
    writeFileSync(join(repoRoot, "plugins/autonomous-pr-loop/hooks", `${name}.ts`), `export const name = "${name}";\n`);
    writeFileSync(join(repoRoot, "plugins/autonomous-pr-loop/hooks/dist", `${name}.js`), `export const name = "${name}";\n`);
  }
  writeFileSync(join(repoRoot, "plugins/autonomous-pr-loop/core/cli.ts"), "Usage: agent-loop dashboard smoke --json\n");
  writeFileSync(join(repoRoot, "docs/release-checklist.md"), "npm pack --ignore-scripts --dry-run --json\n");
  writeFileSync(join(repoRoot, ".github/workflows/release.yml"), [
    "name: Release",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      version:",
    "      tag:",
    "      dry_run:",
    "jobs:",
    "  validate:",
    "    steps:",
    "      - run: pnpm lint",
    "      - run: pnpm exec vitest run",
    "      - run: pnpm build:hooks",
    "      - run: npm pack --ignore-scripts --json",
    "      - name: Tarball install smoke",
    "      - run: npm publish"
  ].join("\n"));
  return repoRoot;
}

function cleanCommandRunner(): NonNullable<ReleaseDoctorOptions["commandRunner"]> {
  return (file, args) => {
    if (file === "git" && args.join(" ") === "branch --show-current") return ok("main");
    if (file === "git" && args.join(" ") === "status --short") return ok("");
    if (file === "git" && args.join(" ") === "rev-parse HEAD") return ok("abc123");
    if (file === "git" && args.join(" ") === "rev-parse origin/main") return ok("abc123");
    if (file === "git" && args.join(" ") === "remote get-url origin") return ok("https://github.com/owner/repo.git");
    if (file === "git" && args.join(" ") === "ls-remote origin refs/heads/main") return ok("abc123\trefs/heads/main");
    if (file === "git" && args.join(" ").startsWith("ls-remote origin refs/tags/")) return ok("");
    if (file === "gh" && args[0] === "repo") return ok(JSON.stringify({ nameWithOwner: "owner/repo", defaultBranchRef: { name: "main" } }));
    if (file === "gh" && args[0] === "issue") return ok("[]");
    if (file === "gh" && args[0] === "pr") return ok("[]");
    if (file === "gh" && args[0] === "release") return err("release not found");
    if (file === "npm" && args[0] === "view") return err("E404 not found");
    return err(`unexpected command: ${file} ${args.join(" ")}`);
  };
}

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: "", combined: stdout };
}

function err(stderr: string): CommandResult {
  return { ok: false, stdout: "", stderr, combined: stderr };
}
