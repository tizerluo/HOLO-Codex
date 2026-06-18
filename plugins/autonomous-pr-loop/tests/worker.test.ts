import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statePath, withConfigDefaults } from "../core/config.js";
import { AgentLoopError } from "../core/errors.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { executeWorker } from "../core/worker.js";
import { cleanupTempRepos, tempRepo, withFakeExecutable } from "./helpers.js";

describe("worker runner", () => {
  afterEach(() => cleanupTempRepos());

  it("dry-runs by writing prompt and command plan without executing codex", async () => {
    const { repoRoot, storage, run } = setup();

    const result = await executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture" }),
      state: "WRITE_SPEC",
      type: "planner",
      dryRun: true
    });
    const events = storage.listEvents();
    const planArtifact = result.artifacts.find((artifact) => artifact.kind === "dry-run-plan");
    const commandPlan = JSON.parse(readFileSync(planArtifact?.path ?? "", "utf8")) as { cwd: string; outputSchemaPath: string };
    storage.close();

    expect(result.worker.status).toBe("succeeded");
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(["worker-prompt", "dry-run-plan"]);
    expect(commandPlan.cwd).toBe(repoRoot);
    expect(commandPlan.outputSchemaPath).toBe(join(import.meta.dirname, "../../../plugins/autonomous-pr-loop/schemas/worker-result.schema.json"));
    expect(commandPlan.outputSchemaPath).not.toContain(`${repoRoot}/plugins/autonomous-pr-loop`);
    expect(events[0]?.kind).toBe("worker_dry_run");
  });

  it("parses a successful worker result and records scope", async () => {
    const { repoRoot, storage, run } = setup();
    const restore = withFakeExecutable(repoRoot, "codex", successCodexScript("src/worker.ts"));

    const result = await executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", gitnexusRequired: true }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false
    });
    const workerEvents = storage.listWorkerEvents(result.worker.id);
    restore();
    storage.close();

    expect(result.worker.status).toBe("succeeded");
    expect(result.worker.threadId).toBe("thread-1");
    expect(result.result?.changedFiles).toEqual(["src/worker.ts"]);
    expect(result.scope?.ok).toBe(true);
    expect(workerEvents.some((event) => event.itemType === "file_change")).toBe(true);
  });

  it("gates invalid worker output without retrying", async () => {
    const { repoRoot, storage, run } = setup();
    const restore = withFakeExecutable(repoRoot, "codex", invalidOutputScript());

    await expect(executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerMaxRetries: 0 }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false
    })).rejects.toMatchObject({ code: "worker_output_invalid" } satisfies Partial<AgentLoopError>);
    const workers = storage.listWorkerEvents(storage.getRunningWorker()?.id ?? "missing");
    restore();
    storage.close();

    expect(workers).toEqual([]);
  });

  it("gates workers that exit before reading stdin", async () => {
    const { repoRoot, storage, run } = setup();
    const restore = withFakeExecutable(repoRoot, "codex", "#!/bin/sh\nexit 1\n");

    await expect(executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerMaxRetries: 0 }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false
    })).rejects.toMatchObject({ code: "worker_failed" } satisfies Partial<AgentLoopError>);
    restore();
    storage.close();
  });

  it("gates codex-app-server backend before creating a worker when probe fails", async () => {
    const { repoRoot, storage, run } = setup();
    const restore = withFakeExecutable(repoRoot, "codex", "#!/bin/sh\nexit 2\n");

    await expect(executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerBackend: "codex-app-server" }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false
    })).rejects.toMatchObject({ code: "required_tool_unavailable" } satisfies Partial<AgentLoopError>);
    const workers = storage.listWorkers(run.id);
    const artifacts = storage.listArtifacts(run.id);
    restore();
    storage.close();

    expect(workers).toEqual([]);
    expect(artifacts.some((artifact) => artifact.name === "codex-app-server-probe.json")).toBe(true);
  });

  it("gates codex-app-server backend distinctly when probe succeeds but execution is deferred", async () => {
    const { repoRoot, storage, run } = setup();
    const restore = withFakeExecutable(repoRoot, "codex", `#!/bin/sh
set -eu
if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then
  echo "codex app-server"
  exit 0
fi
if [ "$1" = "app-server" ]; then
  read line
  printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"test"}}\\n'
  exit 0
fi
exit 2
`);

    await expect(executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerBackend: "codex-app-server" }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false
    })).rejects.toMatchObject({ code: "worker_failed" } satisfies Partial<AgentLoopError>);
    const workers = storage.listWorkers(run.id);
    const artifacts = storage.listArtifacts(run.id);
    restore();
    storage.close();

    expect(workers).toEqual([]);
    expect(artifacts.some((artifact) => artifact.name === "codex-app-server-probe.json")).toBe(true);
  });

  it("retries invalid worker output once using resume thread id", async () => {
    const { repoRoot, storage, run } = setup();
    const restore = withFakeExecutable(repoRoot, "codex", invalidThenValidScript());

    const result = await executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerMaxRetries: 1 }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false
    });
    restore();
    storage.close();

    expect(result.worker.status).toBe("succeeded");
    expect(result.worker.attempt).toBe(1);
    expect(result.worker.resumeUsed).toBe(true);
    expect(result.result?.changedFiles).toEqual(["src/invalid-retry.ts"]);
  });

  it("gates valid worker results that report ok false", async () => {
    const { repoRoot, storage, run } = setup();
    const restore = withFakeExecutable(repoRoot, "codex", okFalseScript());

    await expect(executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerMaxRetries: 0 }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false
    })).rejects.toMatchObject({ code: "worker_failed" } satisfies Partial<AgentLoopError>);
    restore();
    storage.close();
  });

  it("blocks worker attempts to run git side effects through PATH shims", async () => {
    const { repoRoot, storage, run } = setup();
    const restore = withFakeExecutable(repoRoot, "codex", "#!/bin/sh\nset -eu\ngit commit -m bad\n");

    await expect(executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerMaxRetries: 0 }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false
    })).rejects.toMatchObject({ code: "worker_failed" } satisfies Partial<AgentLoopError>);
    restore();
    storage.close();
  });

  it("retries non-schema failures once using resume thread id", async () => {
    const { repoRoot, storage, run } = setup();
    const restore = withFakeExecutable(repoRoot, "codex", retryCodexScript());

    const result = await executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerMaxRetries: 1 }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false
    });
    restore();
    storage.close();

    expect(result.worker.status).toBe("succeeded");
    expect(result.worker.attempt).toBe(1);
    expect(result.worker.resumeUsed).toBe(true);
  });

  it("gates timeouts and refuses a second running worker", async () => {
    const { repoRoot, storage, run } = setup();
    const running = storage.createWorker({
      runId: run.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });

    await expect(executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture" }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: true
    })).rejects.toMatchObject({ code: "worker_already_running" } satisfies Partial<AgentLoopError>);
    storage.updateWorker(running.id, { status: "failed", completedAt: new Date().toISOString() });
    const restore = withFakeExecutable(repoRoot, "codex", "#!/bin/sh\ntrap '' TERM\nsleep 5\n");

    await expect(executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerTimeoutMs: 20 }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false
    })).rejects.toMatchObject({ code: "worker_timeout" } satisfies Partial<AgentLoopError>);
    restore();
    storage.close();
  });

  it("cleans stale running workers before spawning", async () => {
    const { repoRoot, storage, run } = setup();
    const stale = storage.createWorker({
      runId: run.id,
      type: "implementation",
      backend: "codex-exec",
      attempt: 0,
      resumeUsed: false
    });
    const oldStartedAt = new Date(Date.now() - 10_000).toISOString();
    const db = (storage as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare("update workers set started_at = ? where id = ?").run(oldStartedAt, stale.id);

    const result = await executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerTimeoutMs: 1 }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: true
    });
    const events = storage.listEvents({ sinceSeq: 0, limit: 20 });
    storage.close();

    expect(result.worker.status).toBe("succeeded");
    expect(events.some((event) => event.kind === "stale_worker_cleaned")).toBe(true);
  });

  it("aborts workers without leaving a running worker", async () => {
    const { repoRoot, storage, run } = setup();
    const restore = withFakeExecutable(repoRoot, "codex", "#!/bin/sh\ntrap '' TERM\nsleep 5\n");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(executeWorker({
      repoRoot,
      storage,
      run,
      config: withConfigDefaults({ repoId: "example/fixture", workerTimeoutMs: 5_000 }),
      state: "IMPLEMENT",
      type: "implementation",
      dryRun: false,
      signal: controller.signal
    })).rejects.toMatchObject({ code: "worker_timeout" } satisfies Partial<AgentLoopError>);
    const running = storage.getRunningWorker();
    restore();
    storage.close();

    expect(running).toBeUndefined();
  });
});

function setup(): {
  repoRoot: string;
  storage: SqliteAgentLoopStorage;
  run: ReturnType<SqliteAgentLoopStorage["createRun"]>;
} {
  const repoRoot = tempRepo();
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  const run = storage.createRun("RUNNING");
  return { repoRoot, storage, run };
}

function successCodexScript(changedFile: string): string {
  return `#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
mkdir -p "$(dirname "$out")" src
printf 'export const worker = true;\\n' > "${changedFile}"
cat > "$out" <<'JSON'
{"ok":true,"summary":"done","changedFiles":["${changedFile}"],"commandsRun":[],"testsRun":[],"gitnexus":{"impactRun":true,"detectChangesRun":true},"outOfScope":[],"followUps":[]}
JSON
printf '{"type":"thread.started","thread":{"id":"thread-1"}}\\n'
printf '{"type":"item.completed","item":{"type":"file_change","path":"${changedFile}"}}\\n'
printf '{"type":"turn.completed","usage":{"total_tokens":3}}\\n'
`;
}

function invalidOutputScript(): string {
  return `#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
mkdir -p "$(dirname "$out")"
printf 'not-json' > "$out"
printf '{"type":"thread.started","thread":{"id":"thread-invalid"}}\\n'
`;
}

function invalidThenValidScript(): string {
  return `#!/bin/sh
set -eu
marker=".agent-loop/invalid-retry-marker"
out=""
prev=""
resume=0
for arg in "$@"; do
  if [ "$arg" = "resume" ]; then resume=1; fi
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
if [ ! -f "$marker" ]; then
  mkdir -p .agent-loop "$(dirname "$out")"
  touch "$marker"
  printf 'not-json' > "$out"
  printf '{"type":"thread.started","thread":{"id":"thread-invalid-retry"}}\\n'
  exit 0
fi
test "$resume" = "1"
mkdir -p "$(dirname "$out")" src
printf 'export const invalidRetry = true;\\n' > src/invalid-retry.ts
cat > "$out" <<'JSON'
{"ok":true,"summary":"retried","changedFiles":["src/invalid-retry.ts"],"commandsRun":[],"testsRun":[],"gitnexus":{"impactRun":true,"detectChangesRun":true},"outOfScope":[],"followUps":[]}
JSON
printf '{"type":"thread.started","thread":{"id":"thread-invalid-retry"}}\\n'
`;
}

function okFalseScript(): string {
  return `#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
{"ok":false,"summary":"failed","changedFiles":[],"commandsRun":[],"testsRun":[],"gitnexus":{"impactRun":true,"detectChangesRun":true},"outOfScope":[],"followUps":[],"error":{"kind":"test","message":"failed"}}
JSON
printf '{"type":"thread.started","thread":{"id":"thread-failed"}}\\n'
`;
}

function retryCodexScript(): string {
  return `#!/bin/sh
set -eu
marker=".agent-loop/retry-marker"
out=""
prev=""
resume=0
for arg in "$@"; do
  if [ "$arg" = "resume" ]; then resume=1; fi
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
if [ ! -f "$marker" ]; then
  mkdir -p .agent-loop
  touch "$marker"
  printf '{"type":"thread.started","thread":{"id":"thread-retry"}}\\n'
  exit 1
fi
test "$resume" = "1"
mkdir -p "$(dirname "$out")" src
printf 'export const retry = true;\\n' > src/retry.ts
cat > "$out" <<'JSON'
{"ok":true,"summary":"retried","changedFiles":["src/retry.ts"],"commandsRun":[],"testsRun":[],"gitnexus":{"impactRun":true,"detectChangesRun":true},"outOfScope":[],"followUps":[]}
JSON
printf '{"type":"thread.started","thread":{"id":"thread-retry"}}\\n'
`;
}
