import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statePath, withConfigDefaults } from "../core/config.js";
import { captureScopeBaseline, evaluateWorkerScope } from "../core/scope-guard.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import type { WorkerResult } from "../core/types.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("scope guard", () => {
  afterEach(() => cleanupTempRepos());

  it("gates protected path changes", () => {
    const { repoRoot, storage, run, workerId } = setup();
    const baseline = captureScopeBaseline(repoRoot);
    writeFileSync(join(repoRoot, ".env"), "secret=1\n");

    const report = evaluateWorkerScope({
      repoRoot,
      storage,
      runId: run.id,
      workerId,
      config: withConfigDefaults({ repoId: "example/fixture" }),
      baseline,
      result: workerResult({ changedFiles: [".env"] })
    });
    storage.close();

    expect(report.gate).toBe("policy_violation");
    expect(report.protectedPathHits).toEqual([".env"]);
  });

  it("does not broadly ignore worker writes under artifact directories", () => {
    const { repoRoot, storage, run, workerId } = setup();
    const baseline = captureScopeBaseline(repoRoot);
    mkdirSync(join(repoRoot, ".agent-loop", "artifacts", run.id, "evil"), { recursive: true });
    writeFileSync(join(repoRoot, ".agent-loop", "artifacts", run.id, "evil", "secret.txt"), "bad\n");

    const report = evaluateWorkerScope({
      repoRoot,
      storage,
      runId: run.id,
      workerId,
      config: withConfigDefaults({ repoId: "example/fixture" }),
      baseline,
      result: workerResult({
        changedFiles: [`.agent-loop/artifacts/${run.id}/evil/secret.txt`]
      })
    });
    storage.close();

    expect(report.gate).toBe("policy_violation");
  });

  it("detects worker edits to files that were already dirty at baseline", () => {
    const { repoRoot, storage, run, workerId } = setup();
    writeFileSync(join(repoRoot, ".env"), "before=1\n");
    const baseline = captureScopeBaseline(repoRoot);
    writeFileSync(join(repoRoot, ".env"), "after=2\n");

    const report = evaluateWorkerScope({
      repoRoot,
      storage,
      runId: run.id,
      workerId,
      config: withConfigDefaults({ repoId: "example/fixture" }),
      baseline,
      result: workerResult({ changedFiles: [".env"] })
    });
    storage.close();

    expect(report.gate).toBe("policy_violation");
    expect(report.actualChangedFiles).toEqual([".env"]);
  });

  it("records changedFiles mismatches and trusts git reality", () => {
    const { repoRoot, storage, run, workerId } = setup();
    const baseline = captureScopeBaseline(repoRoot);
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "actual.ts"), "export const actual = true;\n");

    const report = evaluateWorkerScope({
      repoRoot,
      storage,
      runId: run.id,
      workerId,
      config: withConfigDefaults({ repoId: "example/fixture" }),
      baseline,
      result: workerResult({ changedFiles: ["src/reported.ts"] })
    });
    const events = storage.listEvents();
    storage.close();

    expect(report.actualChangedFiles).toEqual(["src/actual.ts"]);
    expect(report.missingFromReport).toEqual(["src/actual.ts"]);
    expect(events[0]?.kind).toBe("worker_changed_files_mismatch");
  });

  it("gates out-of-scope and missing required GitNexus results", () => {
    const { repoRoot, storage, run, workerId } = setup();
    const baseline = captureScopeBaseline(repoRoot);

    const outOfScope = evaluateWorkerScope({
      repoRoot,
      storage,
      runId: run.id,
      workerId,
      config: withConfigDefaults({ repoId: "example/fixture" }),
      baseline,
      result: workerResult({ outOfScope: [{ item: "src/x.ts", reason: "not this PR" }] })
    });
    const missingGitNexus = evaluateWorkerScope({
      repoRoot,
      storage,
      runId: run.id,
      workerId,
      config: withConfigDefaults({ repoId: "example/fixture" }),
      baseline,
      result: workerResult({ gitnexus: { impactRun: false, detectChangesRun: true } })
    });
    storage.close();

    expect(outOfScope.gate).toBe("review_out_of_scope");
    expect(missingGitNexus.gate).toBe("policy_violation");
  });

  it("rejects unsafe worker-reported paths", () => {
    const { repoRoot, storage, run, workerId } = setup();
    const baseline = captureScopeBaseline(repoRoot);

    const report = evaluateWorkerScope({
      repoRoot,
      storage,
      runId: run.id,
      workerId,
      config: withConfigDefaults({ repoId: "example/fixture" }),
      baseline,
      result: workerResult({
        changedFiles: ["../../../etc/passwd"],
        outOfScope: [{ item: "/tmp/secret", reason: "absolute" }]
      })
    });
    storage.close();

    expect(report.gate).toBe("policy_violation");
    expect(report.invalidWorkerPaths).toEqual(["../../../etc/passwd", "/tmp/secret"]);
  });
});

function setup(): {
  repoRoot: string;
  storage: SqliteAgentLoopStorage;
  run: ReturnType<SqliteAgentLoopStorage["createRun"]>;
  workerId: string;
} {
  const repoRoot = tempRepo();
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  const run = storage.createRun("RUNNING");
  const worker = storage.createWorker({
    runId: run.id,
    type: "implementation",
    backend: "codex-exec",
    attempt: 0,
    resumeUsed: false
  });
  return { repoRoot, storage, run, workerId: worker.id };
}

function workerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    ok: true,
    summary: "done",
    changedFiles: [],
    commandsRun: [],
    testsRun: [],
    gitnexus: { impactRun: true, detectChangesRun: true },
    outOfScope: [],
    followUps: [],
    ...overrides
  };
}
