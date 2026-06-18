import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoopError } from "../core/errors.js";
import { configPath, loadConfig, validateConfig, withConfigDefaults } from "../core/config.js";
import { LOCALE_SETTINGS } from "../core/locale.js";
import { STORAGE_SCHEMA_VERSION } from "../core/storage.js";
import configSchema from "../schemas/config.schema.json" with { type: "json" };

describe("config", () => {
  it("returns needs_repo_init semantics when config is missing", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "agent-loop-config-"));

    expect(() => loadConfig(repoRoot)).toThrow(AgentLoopError);
    try {
      loadConfig(repoRoot);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentLoopError);
      expect((error as AgentLoopError).code).toBe("needs_repo_init");
      expect((error as AgentLoopError).exitCode).toBe(2);
    }
  });

  it("fills default config values", () => {
    const config = withConfigDefaults({ repoId: "owner/repo" });

    expect(config).toMatchObject({
      repoId: "owner/repo",
      locale: "zh-CN",
      loopShape: "pr-loop",
      workflowProfile: "default_pr_loop",
      roleProfile: "default_pr_roles",
      baseBranch: "main",
      branchPrefix: "codex/",
      plansDir: "docs/plans",
      gitnexusRequired: true,
      requiredChecks: [],
      requireReviewApproval: true,
      allowAutoMerge: false,
      maxReviewFixRounds: 3,
      maxTestFixRounds: 2,
      maxCiReruns: 1,
      commandTimeoutMs: 600_000,
      commandOutputLimitBytes: 65_536,
      githubRetryMaxAttempts: 3,
      githubRetryBaseDelayMs: 1_000,
      reviewCiPollIntervalMs: 30_000,
      reviewCiMaxWaitMs: 1_800_000,
      protectedPaths: [".git/**", ".agent-loop/**", ".claude/**", "AGENTS.md", "CLAUDE.md", ".env*", "**/*secret*"]
    });
  });

  it("returns structured invalid_config errors", () => {
    expect(() => validateConfig({ repoId: "", requiredChecks: "bad" })).toThrow(AgentLoopError);
    try {
      validateConfig({ repoId: "", requiredChecks: "bad" });
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("invalid_config");
    }
  });

  it("validates locale values with the current storage schema", () => {
    expect(validateConfig({ repoId: "owner/repo", locale: "en-US" }).locale).toBe("en-US");
    expect(validateConfig({ repoId: "owner/repo", locale: "system" }).locale).toBe("system");
    expect(() => validateConfig({ repoId: "owner/repo", locale: "fr-FR" })).toThrow(AgentLoopError);
    expect(STORAGE_SCHEMA_VERSION).toBe(8);
    expect(configSchema.properties.locale.enum).toEqual([...LOCALE_SETTINGS]);
  });

  it("validates workflow and role profile config without changing storage schema", () => {
    const config = validateConfig({
      repoId: "owner/repo",
      loopShape: "pr-loop",
      workflowProfile: "docs_only_loop",
      roleProfile: "default_pr_roles"
    });

    expect(config.loopShape).toBe("pr-loop");
    expect(config.workflowProfile).toBe("docs_only_loop");
    expect(config.roleProfile).toBe("default_pr_roles");
    expect(configSchema.properties.loopShape.enum).toEqual(["pr-loop", "generic-loop"]);
    expect(configSchema.properties.workflowProfile.enum).toContain("release_ready_loop");
    expect(configSchema.properties.workflowProfile.enum).toContain("research_report_loop");
    expect(configSchema.properties.roleProfile.enum).toEqual(["default_pr_roles"]);
    expect(STORAGE_SCHEMA_VERSION).toBe(8);
  });

  it("rejects invalid workflow profile fields", () => {
    expect(validateConfig({ repoId: "owner/repo", loopShape: "generic-loop", workflowProfile: "research_report_loop" }).loopShape).toBe("generic-loop");
    expect(() => validateConfig({ repoId: "owner/repo", loopShape: "generic-loop" })).toThrow(AgentLoopError);
    expect(() => validateConfig({ repoId: "owner/repo", workflowProfile: "missing" })).toThrow(AgentLoopError);
    expect(() => validateConfig({ repoId: "owner/repo", roleProfile: "missing" })).toThrow(AgentLoopError);
    expect(() => validateConfig({ repoId: "owner/repo", roleProfile: { aliasFor: "reviewer" } })).toThrow(AgentLoopError);
  });

  it("keeps codex-exec as the default backend and allows explicit app-server probe mode", () => {
    expect(withConfigDefaults({ repoId: "owner/repo" }).workerBackend).toBe("codex-exec");
    expect(validateConfig({ repoId: "owner/repo", workerBackend: "codex-app-server" }).workerBackend).toBe("codex-app-server");
    expect(() => validateConfig({ repoId: "owner/repo", workerBackend: "other" })).toThrow(AgentLoopError);
    expect(configSchema.properties.workerBackend.enum).toEqual(["codex-exec", "codex-app-server"]);
  });

  it("rejects unknown config fields instead of silently dropping them", () => {
    expect(() => validateConfig({ repoId: "owner/repo", typoCommand: "pnpm test" })).toThrow(
      AgentLoopError
    );
    try {
      validateConfig({ repoId: "owner/repo", typoCommand: "pnpm test" });
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("invalid_config");
      expect((error as AgentLoopError).details).toEqual({ fields: ["typoCommand"] });
    }
  });

  it("validates dashboard config shape", () => {
    expect(() =>
      validateConfig({
        repoId: "owner/repo",
        dashboard: { enabled: true, host: "127.0.0.1", port: 70_000 }
      })
    ).toThrow(AgentLoopError);
    expect(() =>
      validateConfig({
        repoId: "owner/repo",
        dashboard: { enabled: true, host: "127.0.0.1", typo: true }
      })
    ).toThrow(AgentLoopError);
  });

  it("loads and validates a config file", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "agent-loop-config-file-"));
    mkdirSync(join(repoRoot, ".agent-loop"), { recursive: true });
    writeFileSync(
      configPath(repoRoot),
      `${JSON.stringify({ repoId: "owner/repo", requiredChecks: ["ci"] })}\n`
    );

    const loaded = loadConfig(repoRoot);

    expect(loaded.config.repoId).toBe("owner/repo");
    expect(loaded.config.requiredChecks).toEqual(["ci"]);
    expect(loaded.config.baseBranch).toBe("main");
  });
});
