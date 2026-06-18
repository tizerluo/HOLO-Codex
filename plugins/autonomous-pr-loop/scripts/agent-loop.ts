#!/usr/bin/env node
import { parseCliInvocation, runAgentLoopCli } from "../core/cli.js";

const args = process.argv.slice(2);
const parsedInvocation = parseInvocation(args);
const controller = new AbortController();
let signalCount = 0;
const onSignal = (): void => {
  signalCount += 1;
  if (signalCount > 1) {
    process.exit(130);
  }
  controller.abort();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

let result = await runAgentLoopCli(args, process.cwd(), { signal: controller.signal });
if (controller.signal.aborted && parsedInvocation?.command !== "stop") {
  result = await runAgentLoopCli([
    "stop",
    "--repo",
    parsedInvocation?.targetRepoRoot ?? process.cwd(),
    ...(args.includes("--json") ? ["--json"] : [])
  ], process.cwd());
}
if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}
process.exitCode = result.exitCode;
if ((parsedInvocation?.command ?? args[0]) !== "dashboard" || args.includes("--help") || args.includes("-h")) {
  process.exit(result.exitCode);
}

function parseInvocation(rawArgs: string[]): ReturnType<typeof parseCliInvocation> | undefined {
  try {
    return parseCliInvocation(rawArgs, process.cwd());
  } catch {
    return undefined;
  }
}
