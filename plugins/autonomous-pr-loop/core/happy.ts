import { execFileSync } from "node:child_process";

export interface HappyCapability {
  installed: boolean;
  versionText?: string;
  supportsNotify: boolean;
}

/** Detect local Happy notify support without starting sessions or remote bridges. */
export function detectHappy(): HappyCapability {
  const help = runHappyHelp(["--help"]);
  if (!help.ok) {
    return { installed: false, supportsNotify: false };
  }
  const notify = runHappyHelp(["notify", "--help"]);
  const versionText = firstLine(help.output);
  return {
    installed: true,
    ...(versionText ? { versionText } : {}),
    supportsNotify: notify.ok
  };
}

function runHappyHelp(args: string[]): { ok: boolean; output: string } {
  try {
    return {
      ok: true,
      output: execFileSync("happy", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 2_000
      }).trim()
    };
  } catch {
    return { ok: false, output: "" };
  }
}

function firstLine(value: string): string | undefined {
  const line = value.split(/\r?\n/).find((item) => item.trim().length > 0)?.trim();
  return line ? line.slice(0, 200) : undefined;
}
