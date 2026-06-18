import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectHappy } from "../core/happy.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn()
}));

describe("Happy capability detection", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("reports unavailable when happy is missing", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("missing");
    });

    expect(detectHappy()).toEqual({ installed: false, supportsNotify: false });
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith("happy", ["--help"], expect.any(Object));
  });

  it("detects notify support without starting a session", () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce("happy 1.0\n")
      .mockReturnValueOnce("notify help\n");

    expect(detectHappy()).toEqual({ installed: true, versionText: "happy 1.0", supportsNotify: true });
    expect(vi.mocked(execFileSync).mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["happy", ["--help"]],
      ["happy", ["notify", "--help"]]
    ]);
    expect(JSON.stringify(vi.mocked(execFileSync).mock.calls)).not.toContain("codex");
  });
});
