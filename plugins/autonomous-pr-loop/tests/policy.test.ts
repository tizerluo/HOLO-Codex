import { describe, expect, it } from "vitest";
import { AgentLoopError } from "../core/errors.js";
import { assertAllowedPath, matchesProtectedPath } from "../core/policy.js";
import { withConfigDefaults } from "../core/config.js";

describe("policy", () => {
  it("matches protected path globs used by default config", () => {
    expect(matchesProtectedPath(".git/**", ".git")).toBe(true);
    expect(matchesProtectedPath(".git/**", ".git/config")).toBe(true);
    expect(matchesProtectedPath(".agent-loop/**", ".agent-loop/state.sqlite")).toBe(true);
    expect(matchesProtectedPath(".env*", ".env.local")).toBe(true);
    expect(matchesProtectedPath(".env*", "subdir/.env.local")).toBe(true);
    expect(matchesProtectedPath("**/*secret*", "secret.txt")).toBe(true);
    expect(matchesProtectedPath("**/*secret*", "src/mysecret-value.ts")).toBe(true);
    expect(matchesProtectedPath("**/*secret*", "src/MySecret-value.ts")).toBe(false);
    expect(matchesProtectedPath("**/*secret*", "src/normal.ts")).toBe(false);
  });

  it("raises policy_violation for protected paths", () => {
    const config = withConfigDefaults({ repoId: "owner/repo" });

    expect(() => assertAllowedPath(config, "secret.txt")).toThrow(AgentLoopError);
    try {
      assertAllowedPath(config, "secret.txt");
    } catch (error) {
      expect((error as AgentLoopError).code).toBe("policy_violation");
    }
  });
});
