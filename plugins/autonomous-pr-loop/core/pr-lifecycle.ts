import { CommandRunner } from "./command-runner.js";
import { evaluateCiChecks } from "./ci.js";
import {
  createBranch,
  getChangedFiles,
  getCurrentBranch,
  pushBranch,
  stagePaths,
  commit,
  syncBaseBranch
} from "./git.js";
import {
  createDraftPullRequest,
  fetchReviewThreads,
  type GitHubCommandOptions,
  listPullRequestsByHead,
  mergePullRequest,
  viewPullRequest
} from "./github.js";
import { gitnexusAnalyze, gitnexusDetectChanges, gitnexusStatus } from "./gitnexus.js";
import { actionableReviewComments, parseReviewThreads } from "./review-comments.js";
import { assertAllowedPath } from "./policy.js";
import { AgentLoopError } from "./errors.js";
import { evaluateMergeReadiness } from "./autonomy-policy.js";
import { resolvePrSelection } from "./pr-selector.js";
import { getDeliveryWorkItem } from "./delivery-work-item.js";
import type { AgentLoopRun, AgentLoopConfig, AgentLoopStorage, AgentLoopCiCheck, AgentLoopDecision, AgentLoopReviewComment } from "./types.js";
import type { AgentLoopState } from "./state-types.js";

export interface LifecycleStepResult {
  nextState?: AgentLoopState;
  branch?: string;
  worktreeClean?: boolean;
  message: string;
}

interface LifecycleInput {
  repoRoot: string;
  storage: AgentLoopStorage;
  run: AgentLoopRun;
  config: AgentLoopConfig;
  state?: AgentLoopState;
  signal?: AbortSignal | undefined;
}

/** Execute PR C real lifecycle behavior for one state-machine state. */
export async function executePrLifecycleStep(input: LifecycleInput & { state: AgentLoopState }): Promise<LifecycleStepResult> {
  if (input.state === "SYNC_MAIN") {
    syncBaseBranch(input.repoRoot, input.config.baseBranch);
    gitnexusAnalyze(input.repoRoot, input.config);
    gitnexusStatus(input.repoRoot, input.config);
    return { message: "Base branch synced.", branch: input.config.baseBranch, worktreeClean: true };
  }
  if (input.state === "CREATE_BRANCH") {
    const branch = createBranch(input.repoRoot, branchName(input), {
      storage: input.storage,
      runId: input.run.id
    }).branch;
    return { message: "Lifecycle branch ready.", ...(branch ? { branch } : {}), worktreeClean: true };
  }
  if (input.state === "SELF_CHECK") {
    await runSelfChecks(input.repoRoot, input.storage, input.run.id, input.config, input.signal);
    const detect = gitnexusDetectChanges(input.repoRoot, input.config, input.storage, input.run.id);
    input.storage.recordRunCheck({
      runId: input.run.id,
      kind: "gitnexus_detect_changes",
      status: detect.ok ? "passed" : "skipped",
      details: { ok: detect.ok, skipped: !input.config.gitnexusRequired }
    });
    if (detect.ok) {
      input.storage.appendEvent({
        runId: input.run.id,
        kind: "gitnexus_detect_changes_passed",
        message: "GitNexus detect_changes passed during SELF_CHECK."
      });
    }
    input.storage.recordRunCheck({
      runId: input.run.id,
      kind: "self_check",
      status: "passed"
    });
    input.storage.appendEvent({
      runId: input.run.id,
      kind: "self_check_passed",
      message: "SELF_CHECK passed before publish."
    });
    return { message: "Self checks passed." };
  }
  if (input.state === "COMMIT_PUSH_PR") {
    return await commitPushPr(input);
  }
  if (input.state === "WAIT_REVIEW_OR_CI") {
    return await waitReviewOrCi(input);
  }
  if (input.state === "READY_TO_MERGE") {
    if (input.config.mergeMode === "conditional") {
      assertConditionalMergeReadiness(input);
      return { nextState: "MERGE", message: "Auto-merge enabled; advancing to MERGE." };
    }
    throw new AgentLoopError("merge_requires_confirmation", "Ready to merge; explicit MERGE state required.", {
      exitCode: 2
    });
  }
  if (input.state === "MERGE") {
    return await maybeMerge(input);
  }
  return { message: `No PR C lifecycle action for ${input.state}.` };
}

async function runSelfChecks(
  repoRoot: string,
  storage: AgentLoopStorage,
  runId: string,
  config: AgentLoopConfig,
  signal?: AbortSignal
): Promise<void> {
  const runner = new CommandRunner({ repoRoot, storage, runId, config, signal });
  for (const command of [config.lintCommand, config.testCommand].filter(isDefined)) {
    const plan = parseConfiguredCommand(command, repoRoot);
    const result = await runner.run(plan, false);
    if (result.exitCode !== 0) {
      throw new AgentLoopError("policy_violation", "Configured self-check command failed.", {
        details: { command, exitCode: result.exitCode },
        exitCode: 2
      });
    }
  }
}

async function commitPushPr(input: LifecycleInput): Promise<LifecycleStepResult> {
  const branch = getCurrentBranch(input.repoRoot);
  const existing = (await listPullRequestsByHead({ repoRoot: input.repoRoot, config: input.config }, branch))[0];
  if (existing) {
    input.storage.upsertPrLink({
      runId: input.run.id,
      branch,
      prNumber: existing.number,
      url: existing.url,
      headRef: existing.headRefName,
      baseRef: existing.baseRefName,
      state: existing.state,
      draft: existing.isDraft
    });
    input.storage.appendDecision({
      runId: input.run.id,
      kind: "pr_reused",
      message: `Reused existing PR #${existing.number}.`,
      details: { branch }
    });
    return { nextState: "WAIT_REVIEW_OR_CI", branch, message: "Existing PR reused." };
  }

  assertPublishPrerequisites(input);
  gitnexusDetectChanges(input.repoRoot, input.config, input.storage, input.run.id);
  const changedFiles = getChangedFiles(input.repoRoot).filter((file) => !isRuntimePath(file));
  const branchHasChanges = branchDiffersFromBase(input.repoRoot, input.config.baseBranch);
  if (changedFiles.length === 0 && !branchHasChanges) {
    input.storage.appendDecision({
      runId: input.run.id,
      kind: "no_diff",
      message: "No repository diff; skipped commit, push, and PR creation."
    });
    return { message: "No diff to publish.", branch };
  }
  if (changedFiles.length > 0) {
    for (const file of changedFiles) {
      assertAllowedPath(input.config, file);
    }
    stagePaths(input.repoRoot, changedFiles);
    commit(input.repoRoot, `agent-loop: ${branch}`);
  } else {
    input.storage.appendDecision({
      runId: input.run.id,
      kind: "existing_branch_diff",
      message: "No worktree diff, but branch differs from base; continuing push/PR recovery.",
      details: { branch, baseBranch: input.config.baseBranch }
    });
  }
  pushBranch(input.repoRoot, branch);
  const createdUrl = createDraftPullRequest({
    repoRoot: input.repoRoot,
    config: input.config
  }, {
    title: `Agent Loop: ${branch}`,
    body: "Draft PR created by agent-loop PR C lifecycle.",
    head: branch,
    base: input.config.baseBranch
  });
  input.storage.appendDecision({
    runId: input.run.id,
    kind: "draft_pr_create_returned",
    message: "gh pr create returned a draft PR URL; re-querying by head branch to persist PR metadata.",
    details: { url: createdUrl, branch }
  });
  const created = (await listPullRequestsByHead({ repoRoot: input.repoRoot, config: input.config }, branch))[0];
  if (created) {
    input.storage.upsertPrLink({
      runId: input.run.id,
      branch,
      prNumber: created.number,
      url: created.url,
      headRef: created.headRefName,
      baseRef: created.baseRefName,
      state: created.state,
      draft: created.isDraft
    });
  }
  return { nextState: "WAIT_REVIEW_OR_CI", branch, worktreeClean: true, message: "Draft PR published." };
}

function assertPublishPrerequisites(input: LifecycleInput): void {
  const selfCheckPassed = input.storage.hasRunCheck(input.run.id, "self_check");
  const detectRecorded = input.storage.hasRunCheck(input.run.id, "gitnexus_detect_changes");
  if (!selfCheckPassed || !detectRecorded) {
    throw new AgentLoopError("policy_violation", "Publish prerequisites are not satisfied.", {
      details: { selfCheckPassed, detectRecorded },
      exitCode: 2
    });
  }
}

function assertConditionalMergeReadiness(
  input: LifecycleInput,
  overrides: {
    ci?: AgentLoopCiCheck[];
    reviewComments?: AgentLoopReviewComment[];
    decisions?: AgentLoopDecision[];
  } = {}
): void {
  const readiness = evaluateMergeReadiness({
    config: input.config,
    ci: overrides.ci ?? input.storage.listCiChecks(input.run.id),
    reviewComments: overrides.reviewComments ?? input.storage.listReviewComments(input.run.id),
    gates: input.storage.listGates(input.run.id),
    decisions: overrides.decisions ?? input.storage.listDecisions(input.run.id),
    runChecks: input.storage.listRunChecks(input.run.id)
  });
  if (!readiness.ready) {
    throw new AgentLoopError("merge_requires_confirmation", "Conditional merge evidence is incomplete.", {
      details: {
        state: readiness.state,
        missingConditions: readiness.missingConditions,
        evidence: readiness.evidence
      },
      exitCode: 2
    });
  }
}

function recordReviewApproval(input: LifecycleInput, reviewDecision: string | undefined): void {
  if (!approvalSatisfied(input.config, reviewDecision)) {
    return;
  }
  if (input.storage.listDecisions(input.run.id).some((decision) => decision.kind === "review_approved")) {
    return;
  }
  input.storage.appendDecision({
    runId: input.run.id,
    kind: "review_approved",
    message: "GitHub review decision approved.",
    details: { reviewDecision }
  });
}

async function waitReviewOrCi(input: LifecycleInput): Promise<LifecycleStepResult> {
  const link = input.storage.getPrLink(input.run.id);
  if (!link) {
    throw new AgentLoopError("storage_error", "No PR link exists for WAIT_REVIEW_OR_CI.");
  }
  const deadline = Date.now() + input.config.reviewCiMaxWaitMs;
  while (Date.now() <= deadline) {
    const ghOptions = githubOptions(input);
    const pr = await viewPullRequest(ghOptions, link.prNumber);
    const reviewComments = parseReviewThreads(
      await fetchReviewThreads(ghOptions, link.prNumber)
    );
    input.storage.replaceReviewComments(input.run.id, link.prNumber, reviewComments);
    if (actionableReviewComments(reviewComments).length > 0) {
      return { nextState: "FIX_REVIEW", message: "Review comments need handling." };
    }
    const ci = evaluateCiChecks(input.config, Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []);
    input.storage.replaceCiChecks(input.run.id, link.prNumber, ci.checks);
    if (ci.state === "missing" && ci.gate) {
      throw new AgentLoopError(ci.gate, "Required CI checks are missing or unspecified.", {
        details: { missingRequiredChecks: ci.missingRequiredChecks },
        exitCode: 2
      });
    }
    if (ci.state === "failed") {
      return { nextState: "FIX_REVIEW", message: "CI failed; later PRs will repair." };
    }
    if (ci.state === "green" && approvalSatisfied(input.config, pr.reviewDecision)) {
      recordReviewApproval(input, pr.reviewDecision);
      return { nextState: "READY_TO_MERGE", message: "Review and CI are ready." };
    }
    if (Date.now() + input.config.reviewCiPollIntervalMs > deadline) {
      break;
    }
    await sleep(input.config.reviewCiPollIntervalMs, input.signal);
  }
  throw new AgentLoopError("ci_pending_timeout", "Timed out waiting for review or CI.", { exitCode: 2 });
}

async function maybeMerge(input: LifecycleInput): Promise<LifecycleStepResult> {
  const link = input.storage.getPrLink(input.run.id);
  if (!link) {
    throw new AgentLoopError("storage_error", "No PR link exists for merge.");
  }
  if (input.config.mergeMode !== "conditional") {
    throw new AgentLoopError("merge_requires_confirmation", "Auto-merge is disabled.", {
      details: { prNumber: link.prNumber },
      exitCode: 2
    });
  }
  const pr = await viewPullRequest(githubOptions(input), link.prNumber);
  if (pr.state === "MERGED") {
    input.storage.appendDecision({
      runId: input.run.id,
      kind: "merge_reused",
      message: `PR #${link.prNumber} was already merged.`,
      details: { prNumber: link.prNumber }
    });
    return { nextState: "SYNC_MAIN", message: `PR #${link.prNumber} already merged.` };
  }
  const ci = evaluateCiChecks(input.config, Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []);
  if (ci.state !== "green" || !approvalSatisfied(input.config, pr.reviewDecision)) {
    throw new AgentLoopError("merge_requires_confirmation", "Merge guards are not satisfied.", {
      details: { ciState: ci.state, reviewDecision: pr.reviewDecision },
      exitCode: 2
    });
  }
  recordReviewApproval(input, pr.reviewDecision);
  assertConditionalMergeReadiness(input, {
    ci: ci.checks.map((check) => ({
      id: `${link.prNumber}-${check.name}`,
      runId: input.run.id,
      prNumber: link.prNumber,
      name: check.name,
      status: check.status,
      ...(check.conclusion ? { conclusion: check.conclusion } : {}),
      observedAt: new Date().toISOString()
    })),
    decisions: input.storage.listDecisions(input.run.id)
  });
  mergePullRequest(input.repoRoot, link.prNumber);
  input.storage.appendDecision({
    runId: input.run.id,
    kind: "pr_merged",
    message: `Merged PR #${link.prNumber}.`,
    details: { prNumber: link.prNumber }
  });
  return { nextState: "SYNC_MAIN", message: `Merged PR #${link.prNumber}.` };
}

function branchName(input: LifecycleInput): string {
  const workItem = getDeliveryWorkItem(input.storage, input.run.id);
  const selection = resolvePrSelection(input.repoRoot, input.config, {
    githubRequired: true,
    ...(workItem ? { workItem } : {})
  });
  if (selection.ambiguous) {
    throw new AgentLoopError("ambiguous_next_pr", "Could not uniquely identify the next PR plan.", {
      details: {
        plansDir: input.config.plansDir,
        reason: selection.reason,
        candidates: selection.candidates,
        evidence: selection.evidence
      },
      exitCode: 2
    });
  }
  return selection.branchName;
}

function parseConfiguredCommand(command: string, cwd: string) {
  const [file, ...args] = tokenizeCommand(command);
  if (!file) {
    throw new AgentLoopError("invalid_config", "Configured command is empty.");
  }
  return {
    id: `configured-${file}`,
    file,
    args,
    cwd,
    purpose: "Run configured self-check."
  };
}

function approvalSatisfied(config: AgentLoopConfig, reviewDecision: string | undefined): boolean {
  return !config.requireReviewApproval || reviewDecision === "APPROVED";
}

function githubOptions(input: LifecycleInput): GitHubCommandOptions {
  return input.signal
    ? { repoRoot: input.repoRoot, config: input.config, signal: input.signal }
    : { repoRoot: input.repoRoot, config: input.config };
}

function branchDiffersFromBase(repoRoot: string, baseBranch: string): boolean {
  return getChangedFiles(repoRoot, `${baseBranch}...HEAD`).filter((file) => !isRuntimePath(file)).length > 0;
}

function isRuntimePath(path: string): boolean {
  return path === ".agent-loop" || path.startsWith(".agent-loop/");
}


function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new AgentLoopError("ci_pending_timeout", "Timed out waiting for review or CI was aborted.", {
        exitCode: 2
      }));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) {
    throw new AgentLoopError("invalid_config", "Configured command contains an unterminated quote.");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
