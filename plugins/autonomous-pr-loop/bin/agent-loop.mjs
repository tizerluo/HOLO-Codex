#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = resolve(packageRoot, "plugins/autonomous-pr-loop/scripts/agent-loop.ts");
const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const child = spawn(process.execPath, ["--import", tsxLoader, script, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  process.stderr.write(`agent-loop: failed to start CLI runner: ${error.message}\n`);
  process.exitCode = 1;
});
