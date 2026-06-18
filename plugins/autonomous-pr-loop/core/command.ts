import { execFileSync } from "node:child_process";

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  combined: string;
}

/** Run a local command and capture stdout/stderr without throwing. */
export function runCommand(file: string, args: string[], cwd: string): CommandResult {
  try {
    const stdout = execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return { ok: true, stdout, stderr: "", combined: stdout };
  } catch (error) {
    const typed = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stdout = Buffer.isBuffer(typed.stdout)
      ? typed.stdout.toString("utf8")
      : (typed.stdout ?? "").toString();
    const stderr = Buffer.isBuffer(typed.stderr)
      ? typed.stderr.toString("utf8")
      : (typed.stderr ?? typed.message ?? "").toString();
    return {
      ok: false,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      combined: `${stdout}\n${stderr}`.trim()
    };
  }
}

/** Redact credentials and owner/repo details from remote URLs before diagnostic output. */
export function redactRemote(remote: string): string {
  if (remote.includes("github.com")) {
    return "github.com/<owner>/<repo>";
  }
  try {
    const parsed = new URL(remote);
    return `${parsed.protocol}//${parsed.host}/<redacted>`;
  } catch {
    return "<redacted-remote>";
  }
}
