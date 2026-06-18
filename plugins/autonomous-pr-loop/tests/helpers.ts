import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const tempRepos = new Set<string>();

export function tempRepo(prefix = "agent-loop-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRepos.add(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    ["remote", "add", "origin", "ssh://git@github.com/example/fixture.git"],
    { cwd: dir, stdio: "ignore" }
  );
  mkdirSync(join(dir, "docs", "plans"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        scripts: {
          test: "vitest run",
          lint: "tsc --noEmit"
        }
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return dir;
}

export function cleanupTempRepos(): void {
  for (const dir of tempRepos) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempRepos.clear();
}

export function withFakeExecutable(repoRoot: string, name: string, script: string): () => void {
  const oldPath = process.env.PATH ?? "";
  const binDir = join(repoRoot, "fake-bin");
  const executablePath = join(binDir, name);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(executablePath, script);
  chmodSync(executablePath, 0o755);
  process.env.PATH = `${binDir}:${oldPath}`;
  return () => {
    process.env.PATH = oldPath;
  };
}
