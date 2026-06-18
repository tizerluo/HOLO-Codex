import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliInvocation, runAgentLoopCli } from "../core/cli.js";
import { configPath, statePath } from "../core/config.js";
import { AgentLoopError } from "../core/errors.js";
import { inspectLocalInstall, installLocalAgentLoop } from "../core/local-install.js";
import { observeCodexHook } from "../core/hook-observer.js";
import { resolveHookRoute, upsertHookBinding } from "../core/hook-router.js";
import { blockRunForTerminalWorker } from "../core/state-machine.js";
import { SqliteAgentLoopStorage } from "../core/storage.js";
import { cleanupTempRepos, tempRepo } from "./helpers.js";

describe("PR B CLI", () => {
  afterEach(() => cleanupTempRepos());

  it("runs through the global bin wrapper with the same status contract", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const binPath = join(import.meta.dirname, "../bin/agent-loop.mjs");

    const direct = JSON.parse((await runAgentLoopCli(["status", "--json"], repoRoot)).stdout);
    const wrapped = JSON.parse(execFileSync("node", [binPath, "status", "--json"], {
      cwd: repoRoot,
      encoding: "utf8"
    }));

    expect(wrapped).toMatchObject({
      ok: true,
      repoId: direct.repoId,
      storagePath: direct.storagePath,
      status: direct.status
    });
  });

  it("supports an agent-loop command on PATH from outside the target repo", async () => {
    const targetRoot = tempRepo("agent-loop-global-target-");
    const callerRoot = mkdtempSync(join(tmpdir(), "agent-loop-global-cwd-"));
    const binDir = mkdtempSync(join(tmpdir(), "agent-loop-global-bin-"));
    const binPath = join(import.meta.dirname, "../bin/agent-loop.mjs");
    symlinkSync(binPath, join(binDir, "agent-loop"));
    await runAgentLoopCli(["init", "--repo", targetRoot], join(import.meta.dirname, "../../.."));

    const payload = JSON.parse(execFileSync("agent-loop", ["--repo", targetRoot, "status", "--json"], {
      cwd: callerRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` }
    }));

    expect(payload.ok).toBe(true);
    expect(payload.storagePath).toBe(statePath(realpathSync(targetRoot)));
  });

  it("installs hooks through a global agent-loop command without using the target repo for hook dist", async () => {
    const targetRoot = tempRepo("agent loop global hooks target-");
    const canonicalTargetRoot = realpathSync(targetRoot);
    const callerRoot = mkdtempSync(join(tmpdir(), "agent-loop-global-hooks-cwd-"));
    const binDir = mkdtempSync(join(tmpdir(), "agent-loop-global-hooks-bin-"));
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-global-hooks-home-"));
    const pluginRoot = join(import.meta.dirname, "../../..");
    const binPath = join(import.meta.dirname, "../bin/agent-loop.mjs");
    symlinkSync(binPath, join(binDir, "agent-loop"));

    const payload = JSON.parse(execFileSync("agent-loop", ["install-hooks", "--repo", targetRoot, "--json"], {
      cwd: callerRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        PATH: `${binDir}:${process.env.PATH ?? ""}`
      }
    }));
    const installedText = readFileSync(join(codexHome, "hooks.json"), "utf8");
    const registryText = readFileSync(join(codexHome, "agent-loop", "hook-bindings.json"), "utf8");

    expect(payload.ok).toBe(true);
    expect(installedText).not.toContain("AGENT_LOOP_REPO_ROOT=");
    expect(installedText).toContain(`node '${join(pluginRoot, "plugins/autonomous-pr-loop/hooks/dist/pre-tool-use.js")}'`);
    expect(installedText).not.toContain(`node '${join(canonicalTargetRoot, "plugins/autonomous-pr-loop/hooks/dist/pre-tool-use.js")}'`);
    expect(registryText).toContain(canonicalTargetRoot);
  });

  it("parses --repo as a global flag before and after the command", async () => {
    const repoRoot = tempRepo();
    const canonicalRepoRoot = realpathSync(repoRoot);
    const childDir = join(repoRoot, "nested", "child");
    mkdirSync(childDir, { recursive: true });

    const beforeCommand = parseCliInvocation(["--repo", childDir, "status", "--json"], process.cwd());
    const afterCommand = parseCliInvocation(["status", `--repo=${childDir}`, "--json"], process.cwd());
    const relativePath = parseCliInvocation(["status", "--repo", relative(process.cwd(), childDir)], process.cwd());
    const missingValue = await runAgentLoopCli(["--repo", "--json"], process.cwd());
    const optionAsValue = await runAgentLoopCli(["init", "--repo", "--dry-run", "--json"], process.cwd());
    const dashboardOptionAsValue = await runAgentLoopCli(["dashboard", "--repo", "--port", "0", "--json"], process.cwd());
    const duplicate = await runAgentLoopCli(["status", "--repo", repoRoot, "--repo", childDir, "--json"], process.cwd());
    const nonRepo = await runAgentLoopCli(["status", "--repo", tmpdir(), "--json"], process.cwd());

    expect(beforeCommand.command).toBe("status");
    expect(beforeCommand.commandArgs).toEqual(["status"]);
    expect(beforeCommand.targetRepoRoot).toBe(canonicalRepoRoot);
    expect(afterCommand.command).toBe("status");
    expect(afterCommand.commandArgs).toEqual(["status"]);
    expect(afterCommand.targetRepoRoot).toBe(canonicalRepoRoot);
    expect(relativePath.targetRepoRoot).toBe(canonicalRepoRoot);
    expect(JSON.parse(missingValue.stdout).error.code).toBe("invalid_config");
    expect(JSON.parse(optionAsValue.stdout).error.code).toBe("invalid_config");
    expect(JSON.parse(dashboardOptionAsValue.stdout).error.code).toBe("invalid_config");
    expect(JSON.parse(duplicate.stdout).error.code).toBe("invalid_config");
    expect(JSON.parse(nonRepo.stdout).error.code).toBe("not_git_repo");
  });

  it("controls a target repo from a different working directory", async () => {
    const targetRoot = tempRepo("agent-loop-target-");
    const canonicalTargetRoot = realpathSync(targetRoot);
    const callerRoot = join(import.meta.dirname, "../../..");

    const dryRun = await runAgentLoopCli(["--repo", targetRoot, "init", "--dry-run", "--json"], callerRoot);
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRun.stdout).configPath).toBe(configPath(canonicalTargetRoot));
    expect(existsSync(configPath(targetRoot))).toBe(false);

    const init = await runAgentLoopCli(["init", "--repo", targetRoot, "--json"], callerRoot);
    const status = await runAgentLoopCli(["--repo", join(targetRoot, "docs"), "status", "--json"], callerRoot);
    const statusPayload = JSON.parse(status.stdout);

    expect(init.exitCode).toBe(0);
    expect(status.exitCode).toBe(0);
    expect(existsSync(configPath(targetRoot))).toBe(true);
    expect(statusPayload.storagePath).toBe(statePath(canonicalTargetRoot));
  });

  it("keeps two --repo targets isolated", async () => {
    const first = tempRepo("agent-loop-first-");
    const second = tempRepo("agent-loop-second-");
    const canonicalFirst = realpathSync(first);
    const canonicalSecond = realpathSync(second);
    const callerRoot = join(import.meta.dirname, "../../..");

    await runAgentLoopCli(["init", "--repo", first], callerRoot);
    await runAgentLoopCli(["init", "--repo", second], callerRoot);
    await runAgentLoopCli(["run", "--dry-run", "--repo", first], callerRoot);

    const firstStatus = JSON.parse((await runAgentLoopCli(["status", "--repo", first, "--json"], callerRoot)).stdout);
    const secondStatus = JSON.parse((await runAgentLoopCli(["status", "--repo", second, "--json"], callerRoot)).stdout);
    const firstStorage = new SqliteAgentLoopStorage(statePath(first));
    const secondStorage = new SqliteAgentLoopStorage(statePath(second));
    const firstEvents = firstStorage.listEvents();
    const secondEvents = secondStorage.listEvents();
    firstStorage.close();
    secondStorage.close();

    expect(firstStatus.storagePath).toBe(statePath(canonicalFirst));
    expect(secondStatus.storagePath).toBe(statePath(canonicalSecond));
    expect(firstEvents.length).toBeGreaterThan(0);
    expect(secondEvents).toHaveLength(0);
  });

  it("run --dry-run writes only .agent-loop state and does not change branch", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const beforeBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    const beforePackage = readFileSync(join(repoRoot, "package.json"), "utf8");

    const result = await runAgentLoopCli(["run", "--dry-run", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.transitions).toEqual([{ from: "SYNC_MAIN", to: "DISCOVER_PROGRESS" }]);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: repoRoot, encoding: "utf8" }).trim()).toBe(beforeBranch);
    expect(readFileSync(join(repoRoot, "package.json"), "utf8")).toBe(beforePackage);
    expect(existsSync(join(repoRoot, ".agent-loop"))).toBe(true);
  });

  it("init adds .agent-loop to gitignore", async () => {
    const repoRoot = tempRepo();

    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli(["init", "--dry-run"], repoRoot);

    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/).filter((line) => line === ".agent-loop/")).toHaveLength(1);
  });

  it("status is read-only for stale needs_repo_init gates and recover resolves them explicitly", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    storage.writeGate({
      kind: "needs_repo_init",
      message: "Missing .agent-loop/config.json. Run `pnpm agent-loop init`."
    });
    storage.close();

    const result = await runAgentLoopCli(["status", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.status).toBe("BLOCKED");
    expect(payload.gate.kind).toBe("needs_repo_init");

    const recover = await runAgentLoopCli(["recover", "--json"], repoRoot);
    const recovered = JSON.parse(recover.stdout);
    expect(recover.exitCode).toBe(0);
    expect(recovered.recovered).toBe(1);
  });

  it("recover resolves an active worker_failed gate so the run can resume", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "WRITE_SPEC" });
    const worker = storage.createWorker({
      runId: run.id,
      type: "planner",
      backend: "codex-exec",
      attempt: 1,
      resumeUsed: true
    });
    storage.updateWorker(worker.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: 1,
      error: "failed to load skill"
    });
    blockRunForTerminalWorker(storage, run);
    expect(storage.getCurrentRun()?.status).toBe("BLOCKED");
    storage.close();

    const recover = await runAgentLoopCli(["recover", "--json"], repoRoot);
    const payload = JSON.parse(recover.stdout);
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const currentRun = after.getCurrentRun();
    const gate = after.listGates(run.id).find((item) => item.kind === "worker_failed");
    const decision = after.listDecisions(run.id).some((item) => item.kind === "worker_failure_recovered");
    after.close();

    expect(recover.exitCode).toBe(0);
    expect(payload.recovered).toBe(1);
    expect(payload.worker.recovered).toBe(1);
    expect(payload.worker.workerIds).toEqual([worker.id]);
    expect(currentRun?.status).toBe("RUNNING");
    expect(gate?.status).toBe("resolved");
    expect(decision).toBe(true);
  });

  it("prints mutating command help without changing gate state", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "WRITE_SPEC" });
    const worker = storage.createWorker({
      runId: run.id,
      type: "planner",
      backend: "codex-exec",
      attempt: 1,
      resumeUsed: false
    });
    storage.updateWorker(worker.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: 1,
      error: "failed before help"
    });
    blockRunForTerminalWorker(storage, run);
    const gateId = storage.listGates(run.id).find((item) => item.kind === "worker_failed")?.id;
    storage.close();

    const topLevelHelp = await runAgentLoopCli(["-h"], repoRoot);
    const mutatingHelp = await Promise.all([
      runAgentLoopCli(["run", "--help"], repoRoot),
      runAgentLoopCli(["step", "--help"], repoRoot),
      runAgentLoopCli(["resume", "--help"], repoRoot),
      runAgentLoopCli(["stop", "--help"], repoRoot),
      runAgentLoopCli(["recover", "--help", "--json"], repoRoot),
      runAgentLoopCli(["install-hooks", "--help"], repoRoot),
      runAgentLoopCli(["approve-gate", "--help"], repoRoot)
    ]);
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const currentRun = after.getCurrentRun();
    const gate = gateId ? after.getGate(gateId) : undefined;
    after.close();

    expect(topLevelHelp.exitCode).toBe(0);
    expect(topLevelHelp.stdout).toContain("agent-loop <command>");
    for (const result of mutatingHelp) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("agent-loop");
      expect(result.stderr).toBe("");
    }
    expect(JSON.parse(mutatingHelp[4]!.stdout).usage).toBe("agent-loop recover [--json]");
    expect(mutatingHelp[6]!.stdout).toContain("agent-loop approve-gate");
    expect(mutatingHelp[6]!.stderr).not.toContain("requires --note");
    expect(currentRun?.status).toBe("BLOCKED");
    expect(gate?.status).toBe("open");
  });

  it("step persists one real state transition", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const before = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = before.createRun("RUNNING", { currentState: "DISCOVER_PROGRESS" });
    before.close();

    const result = await runAgentLoopCli(["step", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const after = storage.getCurrentRun();
    storage.close();

    expect(result.exitCode).toBe(0);
    expect(payload.runId).toBe(run.id);
    expect(payload.transitions).toEqual([{ from: "DISCOVER_PROGRESS", to: "SELECT_NEXT_PR" }]);
    expect(after?.currentState).toBe("SELECT_NEXT_PR");
  });

  it("logs --json returns recorded events", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli(["run", "--dry-run"], repoRoot);

    const result = await runAgentLoopCli(["logs", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.events.length).toBeGreaterThan(0);
  });

  it("appends workflow stage evidence without mutating gates", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "IMPLEMENT" });
    storage.writeGate({ runId: run.id, kind: "worker_failed", message: "blocked worker" });
    const beforeGateCount = storage.listGates().length;
    storage.close();

    const help = await runAgentLoopCli(["evidence", "--help", "--json"], repoRoot);
    const invalid = await runAgentLoopCli(["evidence", "append", "--stage", "not-a-stage", "--summary", "bad", "--json"], repoRoot);
    const result = await runAgentLoopCli([
      "evidence",
      "append",
      "--run",
      run.id,
      "--stage",
      "build",
      "--summary",
      "Build evidence recorded.",
      "--actor",
      "codex",
      "--status",
      "done",
      "--source",
      "cli",
      "--ref",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#issuecomment-1",
      "--json"
    ], repoRoot);
    const payload = JSON.parse(result.stdout);
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const events = after.listEvents(20);
    const afterGateCount = after.listGates().length;
    after.close();

    expect(help.exitCode).toBe(0);
    const helpPayload = JSON.parse(help.stdout);
    expect(helpPayload.usage).toContain("agent-loop evidence append");
    expect(help.stdout).toContain("--reviewer");
    expect(helpPayload.substages).toContainEqual({
      stage: "work_item",
      substages: ["issue_selected", "scope_confirmed", "handoff_checked", "non_goals_recorded"]
    });
    expect(helpPayload.substages).toContainEqual(expect.objectContaining({
      stage: "cleanup",
      substages: expect.arrayContaining(["pr_merged", "worktree_clean"])
    }));
    expect(invalid.exitCode).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(events.some((event) => event.kind === "workflow_stage_evidence" && event.message === "Build evidence recorded.")).toBe(true);
    expect(events.find((event) => event.message === "Build evidence recorded.")?.payload).toMatchObject({
      actor: "codex",
      status: "done",
      source: "cli",
      evidenceRefIds: ["https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#issuecomment-1"]
    });
    expect(afterGateCount).toBe(beforeGateCount);

    const review = await runAgentLoopCli([
      "evidence",
      "append",
      "--run",
      run.id,
      "--stage",
      "review",
      "--substage",
      "claude_acp_review",
      "--summary",
      "Claude ACP review completed with PASS.",
      "--reviewer",
      "claude_acp",
      "--requirement",
      "required",
      "--progress",
      "complete",
      "--result",
      "pass",
      "--severity",
      "none",
      "--model",
      "Claude ACP",
      "--session",
      "session-1",
      "--comment-url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#issuecomment-2",
      "--comment-id",
      "2",
      "--json"
    ], repoRoot);
    const invalidReviewStage = await runAgentLoopCli([
      "evidence",
      "append",
      "--run",
      run.id,
      "--stage",
      "build",
      "--summary",
      "Bad review evidence.",
      "--reviewer",
      "claude_acp",
      "--requirement",
      "required",
      "--progress",
      "started",
      "--result",
      "unknown",
      "--severity",
      "unknown",
      "--json"
    ], repoRoot);
    const invalidComplete = await runAgentLoopCli([
      "evidence",
      "append",
      "--run",
      run.id,
      "--stage",
      "review",
      "--summary",
      "Invalid complete review.",
      "--reviewer",
      "claude_acp",
      "--requirement",
      "required",
      "--progress",
      "complete",
      "--result",
      "pass",
      "--severity",
      "none",
      "--json"
    ], repoRoot);
    const withReview = new SqliteAgentLoopStorage(statePath(repoRoot));
    const reviewEvent = withReview.listEvents(20).find((event) => event.message === "Claude ACP review completed with PASS.");
    withReview.close();

    expect(review.exitCode).toBe(0);
    expect(reviewEvent?.payload).toMatchObject({
      stageId: "review",
      review: {
        reviewer: "claude_acp",
        requirement: "required",
        progress: "complete",
        result: "pass",
        severitySummary: "none",
        model: "Claude ACP",
        sessionId: "session-1",
        commentUrl: "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#issuecomment-2",
        commentId: "2"
      }
    });
    expect(invalidReviewStage.exitCode).toBe(1);
    expect(invalidComplete.exitCode).toBe(1);

    const stopped = new SqliteAgentLoopStorage(statePath(repoRoot));
    const activeRun = stopped.getCurrentRun();
    if (!activeRun) throw new Error("expected current run");
    stopped.updateRunStatus(activeRun.id, activeRun.version, "STOPPED", { currentState: "IMPLEMENT", stoppedAt: new Date().toISOString() });
    const beforeStoppedEvents = stopped.listEvents(20).length;
    stopped.close();

    const stoppedAppend = await runAgentLoopCli(["evidence", "append", "--stage", "build", "--summary", "Stopped run evidence.", "--json"], repoRoot);
    const stoppedPayload = JSON.parse(stoppedAppend.stdout);
    const stoppedAfter = new SqliteAgentLoopStorage(statePath(repoRoot));
    const afterStoppedEvents = stoppedAfter.listEvents(20).length;
    stoppedAfter.close();

    expect(stoppedAppend.exitCode).toBe(2);
    expect(stoppedPayload.error.code).toBe("policy_violation");
    expect(afterStoppedEvents).toBe(beforeStoppedEvents);
  });

  it("binds delivery work items to active runs and rejects different active issues", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);

    const first = await runAgentLoopCli([
      "delivery",
      "bind",
      "--issue",
      "46",
      "--title",
      "Connect pr-delivery-loop to workflow evidence",
      "--url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/46",
      "--json"
    ], repoRoot);
    const firstPayload = JSON.parse(first.stdout);
    const reused = await runAgentLoopCli([
      "delivery",
      "bind",
      "--issue",
      "46",
      "--title",
      "Connect pr-delivery-loop to workflow evidence",
      "--url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/46",
      "--json"
    ], repoRoot);
    const different = await runAgentLoopCli([
      "delivery",
      "bind",
      "--issue",
      "47",
      "--title",
      "Different issue",
      "--url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/47",
      "--json"
    ], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    const events = storage.listEvents(20);
    storage.close();

    expect(first.exitCode).toBe(0);
    expect(firstPayload.run.currentState).toBe("SELECT_NEXT_PR");
    expect(JSON.parse(reused.stdout).reused).toBe(true);
    expect(different.exitCode).toBe(2);
    expect(JSON.parse(different.stdout).error.code).toBe("policy_violation");
    expect(run?.id).toBe(firstPayload.run.id);
    expect(events.some((event) => event.kind === "delivery_work_item_bound")).toBe(true);
    expect(events.some((event) => event.kind === "workflow_stage_evidence" && event.message.includes("Selected issue #46"))).toBe(true);
  });

  it("does not auto-bind an unbound blocked run without an explicit run id", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const oldBlocked = storage.createRun("BLOCKED", { currentState: "READY_TO_MERGE", branch: "codex/old-pr" });
    storage.writeGate({ runId: oldBlocked.id, kind: "merge_requires_confirmation", message: "Old PR blocked." });
    storage.close();

    const result = await runAgentLoopCli([
      "delivery",
      "bind",
      "--issue",
      "46",
      "--title",
      "Connect pr-delivery-loop to workflow evidence",
      "--url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/46",
      "--json"
    ], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.run.id).not.toBe(oldBlocked.id);
    expect(payload.run.status).toBe("RUNNING");
    expect(payload.run.currentState).toBe("SELECT_NEXT_PR");
  });

  it("records explicit delivery stage evidence without mutating run state", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const bind = JSON.parse((await runAgentLoopCli([
      "delivery",
      "bind",
      "--issue",
      "66",
      "--title",
      "Make delivery stage transitions observable",
      "--url",
      "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/66",
      "--json"
    ], repoRoot)).stdout);

    const stage = await runAgentLoopCli([
      "delivery",
      "stage",
      "--run",
      bind.run.id,
      "--stage",
      "build",
      "--substage",
      "implementation_active",
      "--status",
      "active",
      "--summary",
      "Implementation started before file edits.",
      "--json"
    ], repoRoot);
    const invalid = await runAgentLoopCli([
      "delivery",
      "stage",
      "--run",
      bind.run.id,
      "--stage",
      "build",
      "--status",
      "almost_done",
      "--summary",
      "Invalid skipped stage.",
      "--json"
    ], repoRoot);
    const help = await runAgentLoopCli(["delivery", "stage", "--help", "--json"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    const event = storage.listEvents(20).find((item) => item.message === "Implementation started before file edits.");
    storage.close();

    expect(stage.exitCode).toBe(0);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout).error.code).toBe("invalid_config");
    expect(JSON.parse(help.stdout).stages).toContain("build");
    expect(JSON.parse(help.stdout).statuses).toContain("skipped");
    expect(event?.payload).toMatchObject({ stageId: "build", status: "active", source: "delivery_stage" });
    expect(run?.currentState).toBe("SELECT_NEXT_PR");
  });

  it("prints timeline, workers with events, observe, and audit export without dashboard tokens", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("RUNNING", { currentState: "SELF_CHECK" });
    const worker = storage.createWorker({ runId: run.id, type: "implementation", backend: "codex-exec", attempt: 1, resumeUsed: false });
    storage.appendWorkerEvent({
      workerId: worker.id,
      runId: run.id,
      eventType: "item.completed",
      itemType: "command_execution",
      itemId: "item-1",
      itemStatus: "completed",
      summary: { command: "pnpm test", token: "secret-value" }
    });
    storage.appendEvent({ runId: run.id, kind: "cli.seeded", message: "seeded" });
    storage.close();

    const timeline = JSON.parse((await runAgentLoopCli(["timeline", "--run", run.id, "--json"], repoRoot)).stdout);
    const workers = JSON.parse((await runAgentLoopCli(["workers", "--events", "--json"], repoRoot)).stdout);
    const observe = JSON.parse((await runAgentLoopCli(["observe", "--json"], repoRoot)).stdout);
    const observeHuman = await runAgentLoopCli(["observe"], repoRoot);
    const audit = await runAgentLoopCli(["audit-export", "--run", run.id, "--format", "markdown"], repoRoot);

    expect(timeline.ok).toBe(true);
    expect(timeline.entries.length).toBeGreaterThan(0);
    expect(workers.ok).toBe(true);
    expect(workers.eventsByWorker[worker.id][0].source).toBe("worker_event");
    expect(observe.dashboard.url).not.toContain("token=");
    expect(JSON.stringify(observe)).not.toContain("secret-value");
    expect(observeHuman.stdout).toContain("token: run `agent-loop dashboard` and read stderr");
    expect(observeHuman.stdout).not.toContain("token=");
    expect(audit.stdout).toContain(`# Agent Loop Audit: ${run.id}`);
    expect(audit.stdout).not.toContain("secret-value");
  });

  it("resume does not create a new run", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli(["run", "--dry-run"], repoRoot);
    const before = currentRunId(repoRoot);

    const result = await runAgentLoopCli(["resume", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(payload.runId).toBe(before);
    expect(["ambiguous_next_pr", "dirty_unowned_worktree"]).toContain(payload.gate.kind);
    expect(currentRunId(repoRoot)).toBe(before);
  });

  it("resume gates when branch differs from stored reality", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli(["run", "--dry-run"], repoRoot);
    execFileSync("git", ["checkout", "-b", "other"], { cwd: repoRoot, stdio: "ignore" });

    const result = await runAgentLoopCli(["resume", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(payload.gate.kind).toBe("dirty_unowned_worktree");
  });

  it("stop marks the current run as stopped", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli(["run", "--dry-run"], repoRoot);

    const result = await runAgentLoopCli(["stop", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.status).toBe("STOPPED");
  });

  it("stop resolves open gates so status reports STOPPED", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli(["run", "--until=gate"], repoRoot);

    const stopResult = await runAgentLoopCli(["stop", "--json"], repoRoot);
    const statusResult = await runAgentLoopCli(["status", "--json"], repoRoot);
    const statusPayload = JSON.parse(statusResult.stdout);

    expect(stopResult.exitCode).toBe(0);
    expect(statusResult.exitCode).toBe(0);
    expect(statusPayload.status).toBe("STOPPED");
  });

  it("resume --json keeps stopped runs as a non-zero lifecycle signal", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    await runAgentLoopCli(["run", "--dry-run"], repoRoot);
    await runAgentLoopCli(["stop", "--json"], repoRoot);

    const resumeResult = await runAgentLoopCli(["resume", "--json"], repoRoot);
    const payload = JSON.parse(resumeResult.stdout);

    expect(resumeResult.exitCode).toBe(2);
    expect(payload.status).toBe("STOPPED");
    expect(payload.gate).toBeUndefined();
  });

  it("local install help does not write hooks, registry, or snapshots", async () => {
    const repoRoot = tempRepo("agent-loop-local-help-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-local-help-home-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    const top = await runAgentLoopCli(["local", "--help", "--json"], repoRoot);
    const install = await runAgentLoopCli(["local", "install", "--help"], repoRoot);
    const rollback = await runAgentLoopCli(["local", "rollback", "--help"], repoRoot);
    const prune = await runAgentLoopCli(["local", "snapshots", "prune", "--help"], repoRoot);
    process.env.CODEX_HOME = oldCodexHome;

    expect(top.exitCode).toBe(0);
    expect(JSON.parse(top.stdout).commands).toContain("install");
    expect(install.stdout).toContain("agent-loop local install");
    expect(rollback.stdout).toContain("agent-loop local rollback");
    expect(prune.stdout).toContain("agent-loop local snapshots prune");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
    expect(existsSync(join(codexHome, "agent-loop", "hook-bindings.json"))).toBe(false);
    expect(existsSync(join(codexHome, "agent-loop", "backups"))).toBe(false);
  });

  it("local snapshots prune previews by default and deletes only with --apply", async () => {
    const repoRoot = tempRepo("agent-loop-local-prune-target-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-local-prune-home-"));
    const backupsDir = join(codexHome, "agent-loop", "backups");
    mkdirSync(backupsDir, { recursive: true });
    const snapshotPaths = ["01", "02", "03", "04"].map((name, index) => {
      const path = join(backupsDir, `local-install-${name}`);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "snapshot.json"), `${JSON.stringify({
        version: 1,
        createdAt: `2026-06-18T00:0${index}:00.000Z`,
        packageRoot: "/plugin",
        repoRoot,
        codexHome,
        files: [],
        targetAgentLoop: { path: join(repoRoot, ".agent-loop"), exists: false, entries: [] }
      })}\n`);
      return path;
    });
    const malformed = join(backupsDir, "local-install-malformed");
    mkdirSync(malformed, { recursive: true });
    writeFileSync(join(malformed, "snapshot.json"), "{not json");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    let preview: { candidates: Array<{ path: string }>; deleted: string[]; warnings: string[] };
    let listed: { snapshots: Array<{ path: string; invalid?: boolean }> };
    let applied: { candidates: Array<{ path: string }>; deleted: string[]; warnings: string[] };
    try {
      listed = JSON.parse((await runAgentLoopCli(["local", "snapshots", "--json"], repoRoot)).stdout);
      const previewResult = await runAgentLoopCli(["local", "snapshots", "prune", "--keep", "2", "--json"], repoRoot);
      preview = JSON.parse(previewResult.stdout);
      const humanPreview = await runAgentLoopCli(["local", "snapshots", "prune", "--keep", "2"], repoRoot);
      const misuse = await runAgentLoopCli(["local", "snapshots", "--keep", "2", "--json"], repoRoot);
      expect(humanPreview.stdout).toContain(`candidate: ${snapshotPaths[0]!}`);
      expect(misuse.exitCode).toBe(1);
      expect(preview.candidates).toHaveLength(2);
      expect(preview.deleted).toEqual([]);
      expect(preview.warnings[0]).toContain("Skipping malformed snapshot");
      expect(existsSync(snapshotPaths[0]!)).toBe(true);
      const applyResult = await runAgentLoopCli(["local", "snapshots", "prune", "--keep", "2", "--apply", "--json"], repoRoot);
      applied = JSON.parse(applyResult.stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }

    expect(listed.snapshots.find((snapshot) => snapshot.path === malformed)?.invalid).toBe(true);
    expect(applied.deleted).toHaveLength(2);
    expect(existsSync(snapshotPaths[0]!)).toBe(false);
    expect(existsSync(snapshotPaths[1]!)).toBe(false);
    expect(existsSync(snapshotPaths[2]!)).toBe(true);
    expect(existsSync(snapshotPaths[3]!)).toBe(true);
    expect(existsSync(malformed)).toBe(true);
  });

  it("local snapshots prune human apply output lists deleted paths", async () => {
    const repoRoot = tempRepo("agent-loop-local-prune-human-target-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-local-prune-human-home-"));
    const backupsDir = join(codexHome, "agent-loop", "backups");
    mkdirSync(backupsDir, { recursive: true });
    const oldSnapshot = join(backupsDir, "local-install-old");
    const newSnapshot = join(backupsDir, "local-install-new");
    for (const [path, createdAt] of [[oldSnapshot, "2026-06-18T00:00:00.000Z"], [newSnapshot, "2026-06-18T00:01:00.000Z"]] as const) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "snapshot.json"), `${JSON.stringify({
        version: 1,
        createdAt,
        packageRoot: "/plugin",
        repoRoot,
        codexHome,
        files: [],
        targetAgentLoop: { path: join(repoRoot, ".agent-loop"), exists: false, entries: [] }
      })}\n`);
    }
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    let output: string;
    try {
      output = (await runAgentLoopCli(["local", "snapshots", "prune", "--keep", "1", "--apply"], repoRoot)).stdout;
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }

    expect(output).toContain(`candidate: ${oldSnapshot}`);
    expect(output).toContain(`deleted: ${oldSnapshot}`);
    expect(existsSync(oldSnapshot)).toBe(false);
    expect(existsSync(newSnapshot)).toBe(true);
  });

  it("local install snapshots user hook state, installs router binding, and rollback restores it", async () => {
    const repoRoot = tempRepo("agent-loop-local-target-");
    const canonicalRepoRoot = realpathSync(repoRoot);
    await runAgentLoopCli(["init"], repoRoot);
    const packageRoot = join(import.meta.dirname, "../../..");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-local-install-home-"));
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo user hook", timeout: 1 }] }]
      }
    }, null, 2)}\n`);
    const fakeBinDir = mkdtempSync(join(tmpdir(), "agent-loop-local-fake-bin-"));
    const realPnpm = execFileSync("sh", ["-lc", "command -v pnpm"], { encoding: "utf8" }).trim();
    const agentLoopBin = join(import.meta.dirname, "../bin/agent-loop.mjs");
    writeFileSync(join(fakeBinDir, "pnpm"), `#!/bin/sh
if [ "$1" = "build:hooks" ]; then
  echo "fake pnpm $@"
  exit 0
fi
if [ "$1" = "add" ] || [ "$1" = "remove" ]; then
  echo "fake pnpm $@"
  exit 0
fi
if [ "$1" = "agent-loop" ]; then
  shift
  exec node "$AGENT_LOOP_BIN" "$@"
fi
exec "$REAL_PNPM" "$@"
`, { mode: 0o755 });
    const oldCodexHome = process.env.CODEX_HOME;
    const oldPath = process.env.PATH;
    const oldRealPnpm = process.env.REAL_PNPM;
    const oldAgentLoopBin = process.env.AGENT_LOOP_BIN;
    process.env.CODEX_HOME = codexHome;
    process.env.PATH = `${fakeBinDir}:${oldPath ?? ""}`;
    process.env.REAL_PNPM = realPnpm;
    process.env.AGENT_LOOP_BIN = agentLoopBin;

    let installPayload: {
      snapshotPath: string;
      localDoctor: { hooks: { routerInstalled: boolean }; bindings: { currentRepoBindings: number } };
      manifestChanges: string[];
    };
    let rollbackPayload: { restored: string[]; localDoctor: { bindings: { currentRepoBindings: number } } };
    try {
      const install = await runAgentLoopCli(["local", "install", "--repo", repoRoot, "--allow-dirty", "--json"], packageRoot);
      installPayload = JSON.parse(install.stdout);
      const installedHooks = readFileSync(join(codexHome, "hooks.json"), "utf8");
      const registry = readFileSync(join(codexHome, "agent-loop", "hook-bindings.json"), "utf8");
      const snapshots = JSON.parse((await runAgentLoopCli(["local", "snapshots", "--json"], repoRoot)).stdout);
      const hooksBetweenInstallAndRollback = JSON.parse(installedHooks);
      hooksBetweenInstallAndRollback.hooks.Stop.push({
        matcher: "*",
        hooks: [{ type: "command", command: "echo post install user hook", timeout: 1 }]
      });
      writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify(hooksBetweenInstallAndRollback, null, 2)}\n`);
      const registryBetweenInstallAndRollback = JSON.parse(registry);
      registryBetweenInstallAndRollback.bindings.push({
        id: "post-install-binding",
        repoRoot: "/tmp/post-install-repo",
        worktreeRoot: "/tmp/post-install-repo",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      writeFileSync(join(codexHome, "agent-loop", "hook-bindings.json"), `${JSON.stringify(registryBetweenInstallAndRollback, null, 2)}\n`);
      const rollback = await runAgentLoopCli(["local", "rollback", "--snapshot", installPayload.snapshotPath, "--json"], packageRoot);
      rollbackPayload = JSON.parse(rollback.stdout);
      const restoredHooks = readFileSync(join(codexHome, "hooks.json"), "utf8");
      const restoredRegistry = readFileSync(join(codexHome, "agent-loop", "hook-bindings.json"), "utf8");

      expect(install.exitCode).toBe(0);
      expect(installPayload.manifestChanges).toEqual([]);
      expect(installPayload.localDoctor.hooks.routerInstalled).toBe(true);
      expect(installPayload.localDoctor.bindings.currentRepoBindings).toBe(1);
      expect(installedHooks).toContain("echo user hook");
      expect(installedHooks).toContain("autonomous-pr-loop/hooks/dist/pre-tool-use.js");
      expect(registry).toContain(canonicalRepoRoot);
      expect(snapshots.snapshots[0].path).toBe(installPayload.snapshotPath);
      expect(rollback.exitCode).toBe(0);
      expect(rollbackPayload.restored).toContain(join(codexHome, "hooks.json"));
      expect(restoredHooks).toContain("echo user hook");
      expect(restoredHooks).toContain("echo post install user hook");
      expect(restoredHooks).not.toContain("autonomous-pr-loop/hooks/dist/pre-tool-use.js");
      expect(restoredRegistry).toContain("post-install-binding");
      expect(restoredRegistry).not.toContain(canonicalRepoRoot);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
      process.env.PATH = oldPath;
      process.env.REAL_PNPM = oldRealPnpm;
      if (oldAgentLoopBin === undefined) {
        delete process.env.AGENT_LOOP_BIN;
      } else {
        process.env.AGENT_LOOP_BIN = oldAgentLoopBin;
      }
    }
  }, 90_000);

  it("local rollback preserves malformed current hook files before restoring snapshot", async () => {
    const repoRoot = tempRepo("agent-loop-local-rollback-broken-target-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-local-rollback-broken-home-"));
    const snapshotPath = join(codexHome, "agent-loop", "backups", "local-install-broken");
    mkdirSync(join(codexHome, "agent-loop"), { recursive: true });
    mkdirSync(snapshotPath, { recursive: true });
    const hooksPath = join(codexHome, "hooks.json");
    const registryPath = join(codexHome, "agent-loop", "hook-bindings.json");
    writeFileSync(join(snapshotPath, "hooks-hooks.json"), `${JSON.stringify({ hooks: { Stop: [] } }, null, 2)}\n`);
    writeFileSync(join(snapshotPath, "hook-bindings-hook-bindings.json"), `${JSON.stringify({ version: 1, bindings: [] }, null, 2)}\n`);
    writeFileSync(join(snapshotPath, "snapshot.json"), `${JSON.stringify({
      version: 1,
      createdAt: "2026-06-18T00:00:00.000Z",
      packageRoot: join(import.meta.dirname, "../../.."),
      repoRoot,
      codexHome,
      files: [
        { name: "hooks", originalPath: hooksPath, existed: true, backupPath: "hooks-hooks.json" },
        { name: "hook-bindings", originalPath: registryPath, existed: true, backupPath: "hook-bindings-hook-bindings.json" }
      ],
      targetAgentLoop: { path: join(repoRoot, ".agent-loop"), exists: false, entries: [] }
    }, null, 2)}\n`);
    writeFileSync(hooksPath, "{not hooks json");
    writeFileSync(registryPath, "{not registry json");
    const fakeBinDir = mkdtempSync(join(tmpdir(), "agent-loop-local-rollback-broken-bin-"));
    writeFileSync(join(fakeBinDir, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const oldCodexHome = process.env.CODEX_HOME;
    const oldPath = process.env.PATH;
    process.env.CODEX_HOME = codexHome;
    process.env.PATH = `${fakeBinDir}:${oldPath ?? ""}`;

    let payload: { preservedBrokenFiles: string[]; warnings: string[] };
    try {
      const result = await runAgentLoopCli(["local", "rollback", "--snapshot", snapshotPath, "--json"], repoRoot);
      payload = JSON.parse(result.stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
      process.env.PATH = oldPath;
    }

    expect(payload.preservedBrokenFiles).toHaveLength(2);
    expect(payload.preservedBrokenFiles.every((path) => existsSync(path))).toBe(true);
    expect(payload.preservedBrokenFiles.map((path) => statSync(path).mode & 0o777)).toEqual([0o600, 0o600]);
    expect(payload.warnings.join("\n")).toContain("preserved");
    expect(readFileSync(hooksPath, "utf8")).toContain('"Stop"');
    expect(readFileSync(registryPath, "utf8")).toContain('"bindings"');
  });

  it("local install refuses a dirty plugin worktree by default", () => {
    const repoRoot = tempRepo("agent-loop-local-dirty-target-");
    const packageRoot = mkdtempSync(join(tmpdir(), "agent-loop-local-dirty-plugin-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: packageRoot, stdio: "ignore" });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: "codex-auto-pr-loop-plugin" })}\n`);
    writeFileSync(join(packageRoot, "dirty.txt"), "dirty\n");

    expect(() => installLocalAgentLoop({ repoRoot, packageRoot })).toThrow("Plugin worktree is dirty");
  });

  it("local install reports rollback details and restores manifests after install churn", () => {
    const repoRoot = tempRepo("agent-loop-local-churn-target-");
    const packageRoot = mkdtempSync(join(tmpdir(), "agent-loop-local-churn-plugin-"));
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-local-churn-home-"));
    const fakeBinDir = mkdtempSync(join(tmpdir(), "agent-loop-local-churn-bin-"));
    const originalPackageJson = `${JSON.stringify({ name: "codex-auto-pr-loop-plugin" })}\n`;
    writeFileSync(join(packageRoot, "package.json"), originalPackageJson);
    execFileSync("git", ["init", "-b", "main"], { cwd: packageRoot, stdio: "ignore" });
    execFileSync("git", ["add", "package.json"], { cwd: packageRoot, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], { cwd: packageRoot, stdio: "ignore" });
    writeFileSync(join(fakeBinDir, "pnpm"), `#!/bin/sh
if [ "$1" = "build:hooks" ]; then
  exit 0
fi
if [ "$1" = "add" ]; then
  printf '{"name":"codex-auto-pr-loop-plugin","dependencies":{"codex-auto-pr-loop-plugin":"link:."}}\\n' > "$PACKAGE_ROOT/package.json"
  exit 0
fi
exit 0
`, { mode: 0o755 });
    const oldCodexHome = process.env.CODEX_HOME;
    const oldPath = process.env.PATH;
    const oldPackageRoot = process.env.PACKAGE_ROOT;
    process.env.CODEX_HOME = codexHome;
    process.env.PATH = `${fakeBinDir}:${oldPath ?? ""}`;
    process.env.PACKAGE_ROOT = packageRoot;

    try {
      let error: unknown;
      try {
        installLocalAgentLoop({ repoRoot, packageRoot });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(AgentLoopError);
      expect((error as AgentLoopError).details).toMatchObject({
        manifestChanges: ["package.json"]
      });
      expect(JSON.stringify((error as AgentLoopError).details)).toContain("local rollback --snapshot");
      expect(readFileSync(join(packageRoot, "package.json"), "utf8")).toBe(originalPackageJson);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
      process.env.PATH = oldPath;
      process.env.PACKAGE_ROOT = oldPackageRoot;
    }
  });

  it("local doctor detects accidental self-link manifest pollution", () => {
    const repoRoot = tempRepo("agent-loop-local-pollution-target-");
    const packageRoot = mkdtempSync(join(tmpdir(), "agent-loop-local-pollution-plugin-"));
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({
      name: "codex-auto-pr-loop-plugin",
      dependencies: {
        "codex-auto-pr-loop-plugin": "link:"
      }
    }, null, 2)}\n`);
    writeFileSync(join(packageRoot, "pnpm-lock.yaml"), "codex-auto-pr-loop-plugin: link:\n");

    const report = inspectLocalInstall({ repoRoot, packageRoot });

    expect(report.selfLinkPollution.clean).toBe(false);
    expect(report.selfLinkPollution.files).toEqual(expect.arrayContaining(["package.json", "pnpm-lock.yaml"]));
  });

  it("local doctor reports malformed hooks json", async () => {
    const repoRoot = tempRepo("agent-loop-local-bad-hooks-target-");
    const packageRoot = mkdtempSync(join(tmpdir(), "agent-loop-local-bad-hooks-plugin-"));
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-local-bad-hooks-home-"));
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: "codex-auto-pr-loop-plugin" })}\n`);
    writeFileSync(join(codexHome, "hooks.json"), "{not json");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      const report = inspectLocalInstall({ repoRoot, packageRoot });

      expect(report.hooks.hooksJsonError).toBeTruthy();
      expect(report.hooks.routerInstalled).toBe(false);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }
  });

  it("local doctor human output reports binary, router, binding, and lock drift", async () => {
    const repoRoot = tempRepo("agent-loop-local-doctor-drift-target-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-local-doctor-drift-home-"));
    const fakeBinDir = mkdtempSync(join(tmpdir(), "agent-loop-local-doctor-drift-bin-"));
    mkdirSync(join(codexHome, "agent-loop"), { recursive: true });
    writeFileSync(join(fakeBinDir, "agent-loop"), "#!/bin/sh\necho fake\n", { mode: 0o755 });
    writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "node '/tmp/old/autonomous-pr-loop/hooks/dist/pre-tool-use.js'" }] }]
      }
    })}\n`);
    writeFileSync(join(codexHome, "agent-loop", "hook-bindings.json"), `${JSON.stringify({
      version: 1,
      bindings: [
        { id: "missing", repoRoot: "/tmp/agent-loop-missing", worktreeRoot: "/tmp/agent-loop-missing", status: "active", createdAt: "2026-06-18T00:00:00.000Z", updatedAt: "2026-06-18T00:00:00.000Z" },
        { id: "temp", repoRoot: "/private/var/folders/agent-loop-temp", worktreeRoot: "/private/var/folders/agent-loop-temp", status: "active", createdAt: "2026-06-18T00:00:00.000Z", updatedAt: "2026-06-18T00:00:00.000Z" }
      ]
    })}\n`);
    writeFileSync(join(codexHome, "agent-loop", "hook-bindings.json.lock"), `${JSON.stringify({ pid: 999_999, createdAt: "2000-01-01T00:00:00.000Z" })}\n`);
    const oldCodexHome = process.env.CODEX_HOME;
    const oldPath = process.env.PATH;
    process.env.CODEX_HOME = codexHome;
    process.env.PATH = `${fakeBinDir}:${oldPath ?? ""}`;

    let output: string;
    try {
      output = (await runAgentLoopCli(["local", "doctor"], repoRoot)).stdout;
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
      process.env.PATH = oldPath;
    }

    expect(output).toContain("binary points to expected package: no");
    expect(output).toContain("router points to expected dist: no");
    expect(output).toContain("stale/missing path bindings: 2");
    expect(output).toContain("temp path bindings: 1");
    expect(output).toContain("registry lock: stale");
  });

  it("install-hooks merges with existing hooks without overwriting them", async () => {
    const repoRoot = join(import.meta.dirname, "../../..");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-codex-home-"));
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify({
      PreToolUse: [{
        matcher: "Shell",
        hooks: [{ type: "command", command: "echo existing", timeout: 1 }]
      }]
    }, null, 2)}\n`);
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    const result = await runAgentLoopCli(["install-hooks", "--json"], repoRoot);
    const installed = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    process.env.CODEX_HOME = oldCodexHome;

    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(installed)).toContain("echo existing");
    expect(JSON.stringify(installed)).toContain("node");
    expect(JSON.stringify(installed)).toContain("hooks/dist/pre-tool-use.js");
    expect(JSON.stringify(installed)).toContain("hooks/dist/permission-request.js");
    expect(existsSync(join(repoRoot, "plugins/autonomous-pr-loop/hooks/dist/pre-tool-use.js"))).toBe(true);
    expect(Object.keys(installed.hooks)).toEqual(expect.arrayContaining([
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "Stop",
      "SessionStart",
      "PreCompact",
      "PostCompact",
      "PermissionRequest"
    ]));
  });

  it("install-hooks keeps one router hook set while binding multiple repos", async () => {
    const repoA = tempRepo("agent-loop-router-a-");
    const repoB = tempRepo("agent-loop-router-b-");
    const canonicalA = realpathSync(repoA);
    const canonicalB = realpathSync(repoB);
    const pluginRoot = join(import.meta.dirname, "../../..");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-router-home-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    await runAgentLoopCli(["install-hooks", "--repo", repoA, "--json"], pluginRoot);
    await runAgentLoopCli(["install-hooks", "--repo", repoB, "--json"], pluginRoot);
    const installedText = readFileSync(join(codexHome, "hooks.json"), "utf8");
    const registry = JSON.parse(readFileSync(join(codexHome, "agent-loop", "hook-bindings.json"), "utf8"));
    process.env.CODEX_HOME = oldCodexHome;

    expect(installedText.match(new RegExp("autonomous-pr-loop/hooks/dist", "g"))?.length).toBe(8);
    expect(installedText).not.toContain("AGENT_LOOP_REPO_ROOT=");
    expect(JSON.stringify(registry)).toContain(canonicalA);
    expect(JSON.stringify(registry)).toContain(canonicalB);
    expect(registry.bindings).toHaveLength(2);
  });

  it("install-hooks migrates legacy per-repo agent-loop entries while preserving user hooks", async () => {
    const repoRoot = join(import.meta.dirname, "../../..");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-router-migrate-"));
    const legacyCommand = `AGENT_LOOP_REPO_ROOT='${repoRoot}' node '${join(repoRoot, "plugins/autonomous-pr-loop/hooks/dist/pre-tool-use.js")}'`;
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo user", timeout: 1 }] }]
      },
      permissions: {
        allow: ["Bash(git status:*)"]
      },
      PreToolUse: [{
        matcher: "*",
        hooks: [{ type: "command", command: legacyCommand, timeout: 1000 }]
      }]
    }, null, 2)}\n`);
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    const before = JSON.parse((await runAgentLoopCli(["hooks", "doctor", "--json"], repoRoot)).stdout);
    const result = await runAgentLoopCli(["install-hooks", "--json"], repoRoot);
    const installedText = readFileSync(join(codexHome, "hooks.json"), "utf8");
    const installed = JSON.parse(installedText);
    process.env.CODEX_HOME = oldCodexHome;

    expect(before.routerInstalled).toBe(false);
    expect(before.legacyCommands).toHaveLength(1);
    expect(result.exitCode).toBe(0);
    expect(installedText).not.toContain(legacyCommand);
    expect(installedText).toContain("echo user");
    expect(installedText).toContain("hooks/dist/pre-tool-use.js");
    expect(installed.permissions).toEqual({ allow: ["Bash(git status:*)"] });
  });

  it("hooks help does not write hook config or bindings", async () => {
    const repoRoot = join(import.meta.dirname, "../../..");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-router-help-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    const result = await runAgentLoopCli(["hooks", "--help", "--json"], repoRoot);
    process.env.CODEX_HOME = oldCodexHome;

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).usage).toContain("agent-loop hooks");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
    expect(existsSync(join(codexHome, "agent-loop", "hook-bindings.json"))).toBe(false);
  });

  it("hooks doctor reports malformed hook files without crashing", async () => {
    const repoRoot = tempRepo("agent-loop-hooks-doctor-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hooks-doctor-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    let invalidRegistry: Record<string, unknown>;
    let invalidHooks: Record<string, unknown>;
    try {
      await runAgentLoopCli(["install-hooks", "--repo", repoRoot, "--json"], repoRoot);
      writeFileSync(join(codexHome, "agent-loop", "hook-bindings.json"), "{not json");
      invalidRegistry = JSON.parse((await runAgentLoopCli(["hooks", "doctor", "--repo", repoRoot, "--json"], repoRoot)).stdout);
      writeFileSync(join(codexHome, "hooks.json"), "{not json");
      invalidHooks = JSON.parse((await runAgentLoopCli(["hooks", "doctor", "--repo", repoRoot, "--json"], repoRoot)).stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }

    expect(invalidRegistry.registryError).toBeTruthy();
    expect(invalidRegistry.routerInstalled).toBe(true);
    expect(invalidHooks.hooksJsonError).toBeTruthy();
    expect(invalidHooks.routerInstalled).toBe(false);
  });

  it("hooks doctor reports whether hook capture has been observed", async () => {
    const repoRoot = tempRepo("agent-loop-hooks-capture-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hooks-capture-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    let before: { hookCapture: { status: string; currentRepoBindings: number } };
    let routedOnly: { hookCapture: { status: string; lastSeenAt?: string; latestHookEventKind?: string } };
    let after: { hookCapture: { status: string; lastSeenAt?: string; latestHookEventKind?: string } };
    try {
      await runAgentLoopCli(["init", "--json"], repoRoot);
      const bind = JSON.parse((await runAgentLoopCli([
        "delivery",
        "bind",
        "--issue",
        "66",
        "--title",
        "Stage observability",
        "--url",
        "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/66",
        "--json"
      ], repoRoot)).stdout);
      before = JSON.parse((await runAgentLoopCli(["hooks", "doctor", "--json"], repoRoot)).stdout);
      const route = resolveHookRoute({
        cwd: repoRoot,
        session_id: "session-one",
        tool_name: "Bash",
        tool_input: { command: "git status --short" }
      }, { codexHome });
      routedOnly = JSON.parse((await runAgentLoopCli(["hooks", "doctor", "--json"], repoRoot)).stdout);
      observeCodexHook("PostToolUse", {
        cwd: repoRoot,
        session_id: "session-one",
        tool_name: "Bash",
        tool_input: { command: "git status --short" }
      });
      after = JSON.parse((await runAgentLoopCli(["hooks", "doctor", "--json"], repoRoot)).stdout);

      expect(bind.run.id).toBeTruthy();
      expect(route.status).toBe("matched");
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }

    expect(before.hookCapture).toMatchObject({ status: "not_seen", currentRepoBindings: 1 });
    expect(routedOnly.hookCapture.status).toBe("not_seen");
    expect(routedOnly.hookCapture.lastSeenAt).toBeTruthy();
    expect(routedOnly.hookCapture.latestHookEventKind).toBeUndefined();
    expect(after.hookCapture.status).toBe("captured");
    expect(after.hookCapture.lastSeenAt).toBeTruthy();
    expect(after.hookCapture.latestHookEventKind).toBe("hook_post_tool_use");
  });

  it("doctor keeps stale hook capture informational but warns on ambiguous bindings", async () => {
    const staleRepo = tempRepo("agent-loop-hooks-stale-");
    const staleHome = mkdtempSync(join(tmpdir(), "agent-loop-hooks-stale-"));
    const ambiguousRepo = tempRepo("agent-loop-hooks-ambiguous-");
    const ambiguousHome = mkdtempSync(join(tmpdir(), "agent-loop-hooks-ambiguous-"));
    const oldCodexHome = process.env.CODEX_HOME;

    try {
      process.env.CODEX_HOME = staleHome;
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      await runAgentLoopCli(["init", "--json"], staleRepo);
      await runAgentLoopCli(["install-hooks", "--repo", staleRepo, "--json"], staleRepo);
      await runAgentLoopCli([
        "delivery",
        "bind",
        "--issue",
        "66",
        "--title",
        "Stage observability",
        "--url",
        "https://github.com/6tizer/codex-auto-PR-loop-plusin/issues/66",
        "--json"
      ], staleRepo);
      observeCodexHook("PostToolUse", {
        cwd: staleRepo,
        session_id: "stale-session",
        tool_name: "Bash",
        tool_input: { command: "git status --short" }
      });
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const staleHooks = JSON.parse((await runAgentLoopCli(["hooks", "doctor", "--json"], staleRepo)).stdout) as { hookCapture: { status: string } };
      const staleDoctor = JSON.parse((await runAgentLoopCli(["doctor", "--json"], staleRepo)).stdout) as { checks: Array<{ name: string; status: string }> };
      expect(staleHooks.hookCapture.status).toBe("stale");
      expect(staleDoctor.checks.find((check) => check.name === "codex hooks")?.status).toBe("pass");

      vi.useRealTimers();
      process.env.CODEX_HOME = ambiguousHome;
      await runAgentLoopCli(["init", "--json"], ambiguousRepo);
      await runAgentLoopCli(["install-hooks", "--repo", ambiguousRepo, "--json"], ambiguousRepo);
      upsertHookBinding({ repoRoot: ambiguousRepo, runId: "run-one", sessionId: "session-one" }, ambiguousHome);
      upsertHookBinding({ repoRoot: ambiguousRepo, runId: "run-two", sessionId: "session-two" }, ambiguousHome);
      const ambiguousHooks = JSON.parse((await runAgentLoopCli(["hooks", "doctor", "--json"], ambiguousRepo)).stdout) as { hookCapture: { status: string; currentRepoBindings: number } };
      const ambiguousDoctor = JSON.parse((await runAgentLoopCli(["doctor", "--json"], ambiguousRepo)).stdout) as { checks: Array<{ name: string; status: string }> };
      expect(ambiguousHooks.hookCapture).toMatchObject({ status: "ambiguous", currentRepoBindings: 2 });
      expect(ambiguousDoctor.checks.find((check) => check.name === "codex hooks")?.status).toBe("warn");
    } finally {
      vi.useRealTimers();
      process.env.CODEX_HOME = oldCodexHome;
    }
  });

  it("hooks bind, list, and unbind wire session-scoped bindings through the CLI", async () => {
    const repoRoot = tempRepo("agent-loop-hooks-bind-");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-hooks-bind-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    let bind: Record<string, unknown>;
    let listed: { bindings: Array<{ runId?: string; sessionIdHash?: string }> };
    let unbind: { removed: unknown[] };
    let after: { bindings: unknown[] };
    try {
      bind = JSON.parse((await runAgentLoopCli(["hooks", "bind", "--repo", repoRoot, "--run", "run-one", "--session", "session-one", "--json"], repoRoot)).stdout);
      listed = JSON.parse((await runAgentLoopCli(["hooks", "list", "--json"], repoRoot)).stdout);
      unbind = JSON.parse((await runAgentLoopCli(["hooks", "unbind", "--repo", repoRoot, "--session", "session-one", "--json"], repoRoot)).stdout);
      after = JSON.parse((await runAgentLoopCli(["hooks", "list", "--json"], repoRoot)).stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
    }

    expect(bind.ok).toBe(true);
    expect(JSON.stringify(bind)).not.toContain("session-one");
    expect(listed.bindings).toHaveLength(1);
    expect(listed.bindings[0]?.runId).toBe("run-one");
    expect(listed.bindings[0]?.sessionIdHash).toBeTruthy();
    expect(unbind.removed).toHaveLength(1);
    expect(after.bindings).toHaveLength(0);
  });

  it("install-hooks --repo binds hooks to the target repo while using plugin hook dist", async () => {
    const targetRoot = tempRepo("agent loop hook target-");
    const canonicalTargetRoot = realpathSync(targetRoot);
    await runAgentLoopCli(["init", "--repo", targetRoot], join(import.meta.dirname, "../../.."));
    const pluginRoot = join(import.meta.dirname, "../../..");
    const codexHome = mkdtempSync(join(tmpdir(), "agent-loop-codex-home-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    const result = await runAgentLoopCli(["install-hooks", "--repo", targetRoot, "--json"], pluginRoot);
    const installedText = readFileSync(join(codexHome, "hooks.json"), "utf8");
    const registryText = readFileSync(join(codexHome, "agent-loop", "hook-bindings.json"), "utf8");
    process.env.CODEX_HOME = oldCodexHome;

    expect(result.exitCode).toBe(0);
    expect(installedText).not.toContain("AGENT_LOOP_REPO_ROOT=");
    expect(installedText).toContain(`node '${join(pluginRoot, "plugins/autonomous-pr-loop/hooks/dist/pre-tool-use.js")}'`);
    expect(installedText).not.toContain(`node '${join(targetRoot, "plugins/autonomous-pr-loop/hooks/dist/pre-tool-use.js")}'`);
    expect(registryText).toContain(canonicalTargetRoot);

    process.env.CODEX_HOME = codexHome;
    const fakeBinDir = mkdtempSync(join(tmpdir(), "agent-loop-fake-bin-"));
    writeFileSync(join(fakeBinDir, "gh"), "#!/bin/sh\necho \"Logged in to github.com account test (repo, workflow)\"\n", { mode: 0o755 });
    writeFileSync(join(fakeBinDir, "codex"), "#!/bin/sh\necho \"codex-cli 0.0.0-test\"\n", { mode: 0o755 });
    writeFileSync(join(fakeBinDir, "npx"), "#!/bin/sh\necho \"gitnexus 0.0.0-test\"\n", { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${oldPath ?? ""}`;
    let doctor: { checks: Array<{ name: string; status: string; message: string }> };
    try {
      doctor = JSON.parse((await runAgentLoopCli(["doctor", "--repo", targetRoot, "--json"], pluginRoot)).stdout);
    } finally {
      process.env.CODEX_HOME = oldCodexHome;
      process.env.PATH = oldPath;
    }
    const hookCheck = (doctor.checks as Array<{ name: string; status: string; message: string }>).find((check) => check.name === "codex hooks");
    expect(hookCheck).toMatchObject({ status: "pass" });
  });

  it("build:hooks produces compiled node hook runners", () => {
    const repoRoot = join(import.meta.dirname, "../../..");
    execFileSync("pnpm", ["build:hooks"], {
      cwd: repoRoot,
      stdio: "ignore"
    });
    for (const script of [
      "pre-tool-use.js",
      "post-tool-use.js",
      "user-prompt-submit.js",
      "stop.js",
      "session-start.js",
      "pre-compact.js",
      "post-compact.js",
      "permission-request.js"
    ]) {
      expect(existsSync(join(import.meta.dirname, "../hooks/dist", script))).toBe(true);
    }
    const malformed = execFileSync("node", [join(import.meta.dirname, "../hooks/dist/pre-tool-use.js")], {
      cwd: repoRoot,
      input: "{bad-json}",
      encoding: "utf8",
      env: { ...process.env, AGENT_LOOP_REPO_ROOT: repoRoot }
    });
    expect(JSON.parse(malformed)).toMatchObject({
      decision: "deny",
      permissionDecision: "deny",
      continue: false
    });
  });

  it("approve-gate requires a note and records approval", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("BLOCKED");
    storage.writeGate({ runId: run.id, kind: "policy_violation", message: "blocked" });
    const gate = storage.listGates()[0];
    storage.close();

    const missing = await runAgentLoopCli(["approve-gate", gate?.id ?? ""], repoRoot);
    const approved = await runAgentLoopCli(["approve-gate", gate?.id ?? "", "--note", "ok", "--json"], repoRoot);
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const stored = after.getGate(gate?.id ?? "");
    const decisions = after.listDecisions(run.id);
    after.close();

    expect(missing.exitCode).toBe(1);
    expect(approved.exitCode).toBe(0);
    expect(stored?.status).toBe("approved");
    expect(decisions[0]?.kind).toBe("gate_approved");
  });

  it("treats --help as an approve-gate note value when it follows --note", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.createRun("BLOCKED");
    storage.writeGate({ runId: run.id, kind: "policy_violation", message: "blocked" });
    const gate = storage.listGates()[0];
    storage.close();

    const approved = await runAgentLoopCli(["approve-gate", gate?.id ?? "", "--note", "--help", "--json"], repoRoot);
    const payload = JSON.parse(approved.stdout);
    const after = new SqliteAgentLoopStorage(statePath(repoRoot));
    const stored = after.getGate(gate?.id ?? "");
    const decisions = after.listDecisions(run.id);
    after.close();

    expect(approved.exitCode).toBe(0);
    expect(payload.usage).toBeUndefined();
    expect(payload.gate.status).toBe("approved");
    expect(stored?.status).toBe("approved");
    expect(JSON.stringify(decisions[0])).toContain("--help");
  });

  it("prints dashboard help without starting a server", async () => {
    const repoRoot = tempRepo();
    const result = await runAgentLoopCli(["dashboard", "--help"], repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent-loop dashboard");
  });

  it("switches human output locale while leaving json output structured", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);

    const zh = await runAgentLoopCli(["status"], repoRoot);
    const en = await runAgentLoopCli(["status", "--locale", "en-US"], repoRoot);
    const json = await runAgentLoopCli(["status", "--locale", "zh-CN", "--json"], repoRoot);
    const payload = JSON.parse(json.stdout);

    expect(zh.stdout).toContain("基础分支:");
    expect(en.stdout).toContain("baseBranch:");
    expect(json.exitCode).toBe(0);
    expect(payload.baseBranch).toBe("main");
    expect(payload.status).toBe("IDLE");
  });

  it("does not hide invalid config while resolving command locale", async () => {
    const repoRoot = tempRepo();
    await runAgentLoopCli(["init"], repoRoot);
    const config = JSON.parse(readFileSync(configPath(repoRoot), "utf8")) as Record<string, unknown>;
    writeFileSync(configPath(repoRoot), `${JSON.stringify({ ...config, locale: "fr-FR" }, null, 2)}\n`);

    const result = await runAgentLoopCli(["doctor", "--json"], repoRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(payload.error.code).toBe("invalid_config");
  });
});

function currentRunId(repoRoot: string): string | undefined {
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  const run = storage.getCurrentRun();
  storage.close();
  return run?.id;
}
