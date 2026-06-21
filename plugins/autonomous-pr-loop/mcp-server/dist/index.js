#!/usr/bin/env tsx

// plugins/autonomous-pr-loop/mcp-server/src/index.ts
import readline from "node:readline";

// plugins/autonomous-pr-loop/core/repo-root.ts
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

// plugins/autonomous-pr-loop/core/errors.ts
var AgentLoopError = class extends Error {
  code;
  details;
  exitCode;
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AgentLoopError";
    this.code = code;
    this.details = options.details;
    this.exitCode = options.exitCode ?? (isGateCode(code) ? 2 : 1);
  }
};
function isGateCode(code) {
  return code === "needs_repo_init" || code === "unsupported_remote" || code === "needs_secret_or_login" || code === "policy_violation" || code === "ambiguous_next_pr" || code === "dirty_unowned_worktree" || code === "required_tool_unavailable" || code === "ci_required_checks_missing" || code === "ci_pending_timeout" || code === "merge_requires_confirmation" || code === "github_transient_failure" || code === "gitnexus_check_failed" || code === "github_resource_not_found" || code === "worker_failed" || code === "worker_output_invalid" || code === "review_out_of_scope" || code === "worker_timeout" || code === "worker_already_running" || code === "generic_goal_needs_confirmation" || code === "generic_human_gate" || code === "generic_scope_change_requested";
}
function toErrorPayload(error) {
  if (error instanceof AgentLoopError) {
    const payload = {
      code: error.code,
      message: error.message
    };
    if (error.details !== void 0) {
      payload.details = error.details;
    }
    return payload;
  }
  if (error instanceof Error) {
    return { code: "error", message: error.message };
  }
  return { code: "error", message: String(error) };
}

// plugins/autonomous-pr-loop/core/repo-root.ts
function resolveRepoRoot(path) {
  const targetPath = resolve(path);
  try {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: targetPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return realpathSync(repoRoot);
  } catch {
    throw new AgentLoopError("not_git_repo", "Target path is not inside a git repository.", {
      details: { targetPath },
      exitCode: 2
    });
  }
}

// plugins/autonomous-pr-loop/core/mcp-controller.ts
import { execFileSync as execFileSync9, spawn as spawn2 } from "node:child_process";
import { realpathSync as realpathSync3 } from "node:fs";
import { relative, resolve as resolve4 } from "node:path";

// plugins/autonomous-pr-loop/core/artifacts.ts
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// plugins/autonomous-pr-loop/core/state-types.ts
var ARTIFACT_KINDS = [
  "spec",
  "command-output",
  "dry-run-plan",
  "state-snapshot",
  "log",
  "worker-prompt",
  "worker-result",
  "worker-jsonl",
  "generic-context",
  "generic-plan",
  "generic-deliverable"
];

// plugins/autonomous-pr-loop/core/artifacts.ts
function writeArtifact(repoRoot, storage, runId, kind, name, content) {
  assertArtifactKind(kind);
  const id = randomUUID();
  const safeName2 = sanitizeName(name);
  const path = join(repoRoot, ".agent-loop", "artifacts", runId, kind, safeName2);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const record = {
    id,
    runId,
    kind,
    name: safeName2,
    path,
    sha256: sha256(readFileSync(path)),
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  storage.insertArtifact(record);
  return record;
}
function createArtifactWriter(repoRoot, storage, runId, kind, name) {
  assertArtifactKind(kind);
  const id = randomUUID();
  const safeName2 = sanitizeName(name);
  const path = join(repoRoot, ".agent-loop", "artifacts", runId, kind, safeName2);
  const hash = createHash("sha256");
  let finalized;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return {
    id,
    path,
    append(content) {
      if (finalized) {
        throw new AgentLoopError("artifact_integrity_error", `Artifact writer is already finalized: ${id}`);
      }
      appendFileSync(path, content);
      hash.update(content);
    },
    finalize() {
      if (finalized) {
        return finalized;
      }
      finalized = {
        id,
        runId,
        kind,
        name: safeName2,
        path,
        sha256: hash.digest("hex"),
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      storage.insertArtifact(finalized);
      return finalized;
    }
  };
}
function readArtifact(storage, artifactId) {
  const record = readArtifactRecord(storage, artifactId);
  if (!existsSync(record.path)) {
    throw new AgentLoopError("artifact_integrity_error", `Artifact file is missing: ${record.id}`);
  }
  const content = readFileSync(record.path);
  const actual = sha256(content);
  if (actual !== record.sha256) {
    throw new AgentLoopError("artifact_integrity_error", `Artifact sha256 mismatch: ${record.id}`, {
      details: { expected: record.sha256, actual }
    });
  }
  return { record: toArtifactRecord(record), content };
}
function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
function sanitizeName(name) {
  return name.replaceAll("\\", "/").split("/").filter(Boolean).join("-");
}
function assertArtifactKind(kind) {
  if (!ARTIFACT_KINDS.includes(kind)) {
    throw new AgentLoopError("storage_error", `Unsupported artifact kind: ${kind}`);
  }
}
function readArtifactRecord(storage, artifactId) {
  try {
    return storage.getArtifact(artifactId);
  } catch (error) {
    if (error instanceof AgentLoopError) {
      throw new AgentLoopError("artifact_integrity_error", `Artifact metadata is unavailable: ${artifactId}`, {
        details: { cause: error.message, code: error.code }
      });
    }
    throw error;
  }
}
function toArtifactRecord(record) {
  return {
    ...record,
    kind: record.kind
  };
}

// plugins/autonomous-pr-loop/core/autonomy-policy.ts
function describeAutonomyPosture(config) {
  return {
    autonomyMode: config.autonomyMode,
    mergeMode: config.mergeMode,
    notifyMode: config.notifyMode,
    reviewHandling: config.reviewHandling,
    summary: postureSummary(config),
    notifyWhen: notifyRules(config),
    requiresConfirmation: confirmationRules(config),
    allowConditionalMerge: config.mergeMode === "conditional"
  };
}
function evaluateMergeReadiness(input) {
  const missing = [];
  const evidence = [];
  const carryoverRecords = input.decisions.filter((decision) => decision.kind.includes("carryover") || decision.kind.includes("follow_up")).map((decision) => decision.message);
  if (input.config.mergeMode === "disabled") {
    return baseReadiness("disabled", false, ["merge mode disabled"], evidence, carryoverRecords);
  }
  if (input.config.mergeMode === "manual") {
    return baseReadiness("manual", false, ["manual merge mode"], evidence, carryoverRecords);
  }
  const requiredChecks = new Set(input.config.requiredChecks);
  if (requiredChecks.size === 0) {
    if (input.ci.length === 0) {
      missing.push("CI checks observed or required checks configured");
    } else {
      for (const check of input.ci) {
        if (!ciCheckGreen(check)) {
          missing.push(`observed check green: ${check.name}`);
        } else {
          evidence.push(`observed check green: ${check.name}`);
        }
      }
    }
  } else {
    for (const checkName of requiredChecks) {
      const latest = input.ci.find((check) => check.name === checkName);
      if (!latest || !ciCheckGreen(latest)) {
        missing.push(`required check green: ${checkName}`);
      } else {
        evidence.push(`check green: ${checkName}`);
      }
    }
  }
  const openActionable = input.reviewComments.filter(
    (comment) => comment.actionable && !comment.isResolved && !comment.isOutdated && comment.status === "open"
  );
  if (openActionable.length > 0) {
    missing.push("no open actionable review comments");
  } else {
    evidence.push("review comments clear");
  }
  if (input.config.requireReviewApproval) {
    const approved = input.decisions.some(
      (decision) => decision.kind.includes("review") && decision.kind.includes("approved")
    );
    if (!approved) {
      missing.push("required review approval recorded");
    } else {
      evidence.push("review approval recorded");
    }
  }
  if (input.gates.some((gate) => gate.status === "open")) {
    missing.push("no open gates");
  } else {
    evidence.push("no open gates");
  }
  const gitnexusPassed = input.runChecks.some(
    (check) => check.kind === "gitnexus_detect_changes" && check.status === "passed"
  );
  if (input.config.gitnexusRequired && !gitnexusPassed) {
    missing.push("GitNexus detect_changes passed");
  } else {
    evidence.push(input.config.gitnexusRequired ? "GitNexus passed" : "GitNexus not required");
  }
  const scopePassed = input.runChecks.some((check) => check.kind === "self_check" && check.status === "passed");
  if (!scopePassed) {
    missing.push("self check passed");
  } else {
    evidence.push("self check passed");
  }
  const scopeGuardPassed = input.runChecks.some((check) => check.kind === "scope_guard" && check.status === "passed");
  if (!scopeGuardPassed) {
    missing.push("scope guard passed");
  } else {
    evidence.push("scope guard passed");
  }
  const protectedPathsPassed = input.runChecks.some((check) => check.kind === "protected_paths" && check.status === "passed");
  if (!protectedPathsPassed) {
    missing.push("protected paths clear");
  } else {
    evidence.push("protected paths clear");
  }
  const carryoverChecked = input.runChecks.some(
    (check) => check.kind === "carryover_recorded" && (check.status === "passed" || check.status === "skipped")
  );
  if (input.config.reviewHandling === "fix_scoped_and_carry_forward") {
    if (!carryoverChecked && carryoverRecords.length === 0) {
      missing.push("carryover evaluated or recorded");
    } else {
      evidence.push(carryoverRecords.length > 0 ? "carryover recorded" : "carryover evaluated");
    }
  }
  return baseReadiness(
    missing.length === 0 ? "ready" : "missing_evidence",
    missing.length === 0,
    missing,
    evidence,
    carryoverRecords
  );
}
function ciCheckGreen(check) {
  return check.conclusion?.toLowerCase() === "success" && check.status.toLowerCase() === "completed";
}
function baseReadiness(state, ready, missingConditions, evidence, carryoverRecords) {
  return { state, ready, missingConditions, evidence, carryoverRecords };
}
function postureSummary(config) {
  const autonomy = config.autonomyMode.replaceAll("_", " ");
  const merge = config.mergeMode === "conditional" ? "conditional merge when evidence passes" : `${config.mergeMode} merge`;
  return `Agent runs ${autonomy}; ${merge}; notifications are ${config.notifyMode.replaceAll("_", " ")}.`;
}
function notifyRules(config) {
  if (config.notifyMode === "blockers_only") {
    return ["blocked", "confirmation_required"];
  }
  if (config.notifyMode === "all_gates") {
    return ["all gates", "CI/review attention", "worker failures", "merge completion"];
  }
  return ["blocked", "confirmation_required", "high-risk policy changes", "external reviewer or CI failures"];
}
function confirmationRules(config) {
  const rules = ["dangerous policy changes", "protected path changes"];
  if (config.mergeMode !== "conditional") {
    rules.push("manual merge decision");
  }
  if (config.autonomyMode === "supervised") {
    rules.push("run progression beyond one step");
  }
  return rules;
}

// plugins/autonomous-pr-loop/core/config-editor.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync5, readFileSync as readFileSync4, statSync, writeFileSync as writeFileSync2 } from "node:fs";

// plugins/autonomous-pr-loop/core/config.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";

// plugins/autonomous-pr-loop/core/locale.ts
var LOCALE_SETTINGS = ["zh-CN", "en-US", "system"];
var DEFAULT_LOCALE = "zh-CN";

// plugins/autonomous-pr-loop/core/loop-shapes.ts
var PR_LOOP_STATES = [
  "SYNC_MAIN",
  "DISCOVER_PROGRESS",
  "SELECT_NEXT_PR",
  "WRITE_SPEC",
  "CREATE_BRANCH",
  "IMPLEMENT",
  "SELF_CHECK",
  "COMMIT_PUSH_PR",
  "WAIT_REVIEW_OR_CI",
  "FIX_REVIEW",
  "PUSH_FIX",
  "READY_TO_MERGE",
  "MERGE",
  "BLOCKED",
  "STOPPED"
];
var PR_LOOP_TERMINAL_STATES = ["BLOCKED", "STOPPED"];
var PR_LOOP_TRANSITIONS = [
  { from: "SYNC_MAIN", to: "DISCOVER_PROGRESS", trigger: "step", guard: "config_present" },
  { from: "DISCOVER_PROGRESS", to: "SELECT_NEXT_PR", trigger: "step", guard: "config_present" },
  { from: "SELECT_NEXT_PR", to: "WRITE_SPEC", trigger: "step", guard: "next_pr_unique" },
  { from: "WRITE_SPEC", to: "CREATE_BRANCH", trigger: "step", guard: "always" },
  { from: "CREATE_BRANCH", to: "IMPLEMENT", trigger: "step", guard: "always" },
  { from: "IMPLEMENT", to: "SELF_CHECK", trigger: "step", guard: "always" },
  { from: "SELF_CHECK", to: "COMMIT_PUSH_PR", trigger: "step", guard: "always" },
  { from: "COMMIT_PUSH_PR", to: "WAIT_REVIEW_OR_CI", trigger: "step", guard: "always" },
  { from: "WAIT_REVIEW_OR_CI", to: "FIX_REVIEW", trigger: "step", guard: "always" },
  { from: "FIX_REVIEW", to: "PUSH_FIX", trigger: "step", guard: "always" },
  { from: "PUSH_FIX", to: "WAIT_REVIEW_OR_CI", trigger: "step", guard: "always" },
  { from: "WAIT_REVIEW_OR_CI", to: "READY_TO_MERGE", trigger: "step", guard: "always" },
  { from: "READY_TO_MERGE", to: "MERGE", trigger: "step", guard: "always" },
  { from: "MERGE", to: "SYNC_MAIN", trigger: "step", guard: "always" },
  { from: "SYNC_MAIN", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "DISCOVER_PROGRESS", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "SELECT_NEXT_PR", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "WRITE_SPEC", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "CREATE_BRANCH", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "IMPLEMENT", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "SELF_CHECK", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "COMMIT_PUSH_PR", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "WAIT_REVIEW_OR_CI", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "FIX_REVIEW", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "PUSH_FIX", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "READY_TO_MERGE", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "MERGE", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "BLOCKED", to: "STOPPED", trigger: "stop", guard: "always" }
];
function prLoopDefaultRoleForState(state) {
  if (state === "WRITE_SPEC") {
    return "planner";
  }
  if (state === "IMPLEMENT") {
    return "implementation";
  }
  if (state === "FIX_REVIEW") {
    return "review-fix";
  }
  if (state === "SELF_CHECK") {
    return "reviewer";
  }
  return void 0;
}
var PR_LOOP_SHAPE = {
  id: "pr-loop",
  label: "PR Loop",
  lifecycleKind: "pr",
  initialState: "SYNC_MAIN",
  states: PR_LOOP_STATES,
  transitions: PR_LOOP_TRANSITIONS,
  terminalStates: PR_LOOP_TERMINAL_STATES,
  defaultRoleForState: prLoopDefaultRoleForState
};
var GENERIC_LOOP_STATES = [
  "DEFINE_GOAL",
  "COLLECT_CONTEXT",
  "PLAN_WORK",
  "EXECUTE_STEP",
  "SELF_REVIEW",
  "HUMAN_GATE",
  "DELIVER",
  "COMPLETE",
  "BLOCKED",
  "STOPPED"
];
var GENERIC_LOOP_TERMINAL_STATES = ["COMPLETE", "BLOCKED", "STOPPED"];
var GENERIC_LOOP_TRANSITIONS = [
  // Raised by a missing goal-confirmation decision before lifecycle returns a guard.
  { from: "DEFINE_GOAL", to: "BLOCKED", trigger: "step", guard: "goal_unclear" },
  { from: "DEFINE_GOAL", to: "COLLECT_CONTEXT", trigger: "step", guard: "goal_clear" },
  { from: "DEFINE_GOAL", to: "PLAN_WORK", trigger: "step", guard: "skip_context" },
  { from: "DEFINE_GOAL", to: "STOPPED", trigger: "step", guard: "rejected" },
  { from: "COLLECT_CONTEXT", to: "PLAN_WORK", trigger: "step", guard: "always" },
  { from: "PLAN_WORK", to: "EXECUTE_STEP", trigger: "step", guard: "always" },
  { from: "EXECUTE_STEP", to: "BLOCKED", trigger: "step", guard: "scope_change_requested" },
  { from: "EXECUTE_STEP", to: "PLAN_WORK", trigger: "step", guard: "scope_change_approved" },
  { from: "EXECUTE_STEP", to: "SELF_REVIEW", trigger: "step", guard: "always" },
  { from: "EXECUTE_STEP", to: "STOPPED", trigger: "step", guard: "rejected" },
  { from: "SELF_REVIEW", to: "EXECUTE_STEP", trigger: "step", guard: "fix_needed_cycles_remain" },
  { from: "SELF_REVIEW", to: "HUMAN_GATE", trigger: "step", guard: "review_passed" },
  { from: "SELF_REVIEW", to: "HUMAN_GATE", trigger: "step", guard: "review_cycles_exhausted" },
  { from: "HUMAN_GATE", to: "DELIVER", trigger: "step", guard: "deliverable_approved" },
  { from: "HUMAN_GATE", to: "EXECUTE_STEP", trigger: "step", guard: "request_changes" },
  { from: "HUMAN_GATE", to: "STOPPED", trigger: "step", guard: "rejected" },
  { from: "DELIVER", to: "COMPLETE", trigger: "step", guard: "always" },
  { from: "DEFINE_GOAL", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "COLLECT_CONTEXT", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "PLAN_WORK", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "EXECUTE_STEP", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "SELF_REVIEW", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "HUMAN_GATE", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "DELIVER", to: "STOPPED", trigger: "stop", guard: "always" },
  { from: "BLOCKED", to: "STOPPED", trigger: "stop", guard: "always" }
];
function genericLoopDefaultRoleForState(state) {
  if (state === "DEFINE_GOAL" || state === "COLLECT_CONTEXT" || state === "PLAN_WORK") {
    return "planner";
  }
  if (state === "EXECUTE_STEP" || state === "DELIVER") {
    return "implementation";
  }
  if (state === "SELF_REVIEW") {
    return "reviewer";
  }
  return void 0;
}
var GENERIC_LOOP_SHAPE = {
  id: "generic-loop",
  label: "Generic Loop",
  lifecycleKind: "generic",
  initialState: "DEFINE_GOAL",
  states: GENERIC_LOOP_STATES,
  transitions: GENERIC_LOOP_TRANSITIONS,
  terminalStates: GENERIC_LOOP_TERMINAL_STATES,
  defaultRoleForState: genericLoopDefaultRoleForState
};
var LOOP_SHAPES = {
  "pr-loop": PR_LOOP_SHAPE,
  "generic-loop": GENERIC_LOOP_SHAPE
};
function resolveLoopShape(id) {
  if (id in LOOP_SHAPES) {
    return LOOP_SHAPES[id];
  }
  throw new AgentLoopError("invalid_config", "Config loopShape is invalid.");
}
function loopShapeIds() {
  return Object.keys(LOOP_SHAPES);
}
function sandboxForShapeState(shapeId, state, workerType) {
  if (shapeId === "generic-loop" && ["DEFINE_GOAL", "COLLECT_CONTEXT", "PLAN_WORK", "SELF_REVIEW"].includes(state)) {
    return "read-only";
  }
  return workerType === "reviewer" ? "read-only" : "workspace-write";
}

// plugins/autonomous-pr-loop/core/worker-prompts.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function buildWorkerPrompt(input) {
  const requiredCommands = requiredCommandsFor(input.type, input.config);
  const genericLoop = input.config.loopShape === "generic-loop";
  return [
    `# ${genericLoop ? "Generic Loop Worker" : "HOLO-Codex PR Loop Worker"}: ${input.type}`,
    "",
    genericLoop ? "You are a delegated worker inside the configured Generic Loop." : "You are a delegated worker inside the HOLO-Codex PR delivery loop.",
    "You may edit repository files within the allowed scope, then return only the structured final result.",
    "",
    "## Current Run",
    `- runId: ${input.run.id}`,
    `- state: ${input.state}`,
    `- workerType: ${input.type}`,
    ...genericLoop ? [] : [
      `- baseBranch: ${input.config.baseBranch}`,
      `- plansDir: ${input.config.plansDir}`
    ],
    `- loopShape: ${input.profile?.loopShape ?? input.config.loopShape}`,
    `- workflowProfile: ${input.profile?.workflowProfile ?? input.config.workflowProfile}`,
    `- roleProfile: ${input.profile?.roleProfile ?? input.config.roleProfile}`,
    `- sandbox: ${input.policy?.sandbox ?? workerSandbox(input.type)}`,
    "",
    "## Workflow Profile",
    ...profileLines(input),
    "",
    "## Allowed Scope",
    ...allowedScope(input).map((line) => `- ${line}`),
    "",
    "## Required Commands",
    ...requiredCommands.map((line) => `- ${line}`),
    "",
    "## AGENTS.md Summary",
    summarizeAgents(input.repoRoot),
    "",
    "## Hard Prohibitions",
    ...genericLoop ? [
      "- Do not treat this as PR automation unless the workflow explicitly asks for PR-related documentation.",
      "- Do not create, update, ready, merge, or close pull requests.",
      "- Do not run release, deploy, publishing, notification, payment, or production-control side effects."
    ] : [
      "- Do not commit.",
      "- Do not push.",
      "- Do not create, update, ready, merge, or close pull requests."
    ],
    "- Do not run git reset, git clean, git rebase, force push, or history rewriting commands.",
    "- Do not request danger-full-access or bypass sandbox approvals.",
    "",
    "## GitNexus Requirements",
    input.config.gitnexusRequired ? "- GitNexus impact and detect changes are required. Set gitnexus.impactRun and gitnexus.detectChangesRun truthfully." : "- GitNexus is best-effort. Record notes if unavailable.",
    "",
    "## Context",
    JSON.stringify(input.context ?? {}, null, 2),
    "",
    "## Output Schema",
    "Return a JSON object matching worker-result.schema.json with these fields:",
    "`ok`, `summary`, `changedFiles`, `commandsRun`, `testsRun`, `gitnexus`, `outOfScope`, `followUps`, optional `error`.",
    "Do not include Markdown fences in the final answer."
  ].join("\n");
}
function workerSandbox(type) {
  return type === "reviewer" ? "read-only" : "workspace-write";
}
function allowedScope(input) {
  const currentRole = input.profile?.currentRole;
  const rolePrefix = currentRole ? `${currentRole.label} (${currentRole.alias} -> ${currentRole.workerType}). ` : "";
  if (input.policy?.sandbox === "read-only") {
    return [
      `${rolePrefix}Read-only state. Do not modify files.`,
      `Protected paths still apply: ${input.policy.protectedPaths.join(", ")}`
    ];
  }
  if (input.config.loopShape === "generic-loop") {
    return [
      `${rolePrefix}Work only toward the generic-loop deliverable: ${input.profile?.expectedDeliverable ?? "deliverable"}.`,
      `Allowed write roots: ${(input.policy?.allowedPaths ?? []).join(", ") || "none"}.`,
      `Do not touch protected paths: ${(input.policy?.protectedPaths ?? input.config.protectedPaths).join(", ")}`
    ];
  }
  if (input.type === "planner") {
    return [`${rolePrefix}Write specs under ${input.config.plansDir}/`, "Do not modify runtime state or secrets."];
  }
  if (input.type === "reviewer") {
    return [`${rolePrefix}Read-only review. Do not modify files.`];
  }
  return [
    `${rolePrefix}Modify only files needed for the current PR.`,
    `Do not touch protected paths: ${input.config.protectedPaths.join(", ")}`
  ];
}
function requiredCommandsFor(type, config) {
  const commands = [];
  if (config.lintCommand) {
    commands.push(config.lintCommand);
  }
  if (config.testCommand) {
    commands.push(config.testCommand);
  }
  if (config.gitnexusRequired && type !== "planner") {
    commands.push("npx gitnexus impact");
    commands.push("npx gitnexus detect_changes");
  }
  return commands.length > 0 ? commands : ["No configured commands; explain why none were run."];
}
function summarizeAgents(repoRoot) {
  const path = join2(repoRoot, "AGENTS.md");
  if (!existsSync2(path)) {
    return "No AGENTS.md found.";
  }
  const content = readFileSync2(path, "utf8").trim();
  if (content.length <= 4e3) {
    return content;
  }
  return `${content.slice(0, 4e3)}
[truncated]`;
}
function profileLines(input) {
  const profile = input.profile;
  if (!profile) {
    return ["- No resolved profile summary was provided; follow the configured PR loop defaults."];
  }
  return [
    `- Workflow: ${profile.workflowLabel} (${profile.workflowProfile})`,
    `- Description: ${profile.workflowDescription}`,
    `- Current role: ${profile.currentRole ? `${profile.currentRole.label} (${profile.currentRole.alias})` : "none"}`,
    `- Autonomy boundary: ${profile.autonomyBoundary}`,
    `- Handoff: ${profile.handoffSummary}`,
    `- Validation posture: ${profile.validationPosture}`,
    ...profile.expectedDeliverable ? [`- Expected deliverable: ${profile.expectedDeliverable}`] : [],
    ...profile.allowedWriteRoots ? [`- Allowed write roots: ${profile.allowedWriteRoots.join(", ")}`] : [],
    `- Likely gates: ${profile.likelyGates.join(", ") || "none"}`,
    "- Role instruction:",
    `  ${roleInstruction(input)}`
  ];
}
function roleInstruction(input) {
  const role = input.profile?.currentRole;
  if (!role) {
    return "Use the default worker instructions for this state.";
  }
  if (input.config.workflowProfile === "docs_only_loop") {
    return "Treat documentation consistency as primary; if code or config changes are involved, still run the configured validation and report the spillover.";
  }
  if (input.config.loopShape === "generic-loop") {
    return `Complete only the generic-loop responsibility for ${input.state}. Produce evidence for ${input.profile?.expectedDeliverable ?? "the configured deliverable"}; follow the handoff and validation posture, and record any remaining work as followUps. For SELF_REVIEW, prefix blocking repair items with \`fix:\`; use \`note:\` for non-blocking carryover.`;
  }
  if (role.workerType === "reviewer") {
    return "Read evidence directly, do not trust worker self-report, and avoid all file writes.";
  }
  if (role.workerType === "review-fix") {
    return "Fix only scoped review findings and record out-of-scope carryover.";
  }
  if (role.workerType === "ci-fix") {
    return "Focus on failing checks and avoid feature expansion.";
  }
  return "Stay inside the selected PR scope and hand off concise evidence.";
}

// plugins/autonomous-pr-loop/core/profiles.ts
var WORKFLOW_PROFILE_IDS = [
  "default_pr_loop",
  "docs_only_loop",
  "review_fix_loop",
  "release_ready_loop",
  "research_report_loop",
  "document_preparation_loop",
  "repo_hygiene_loop",
  "weekly_review_loop",
  "data_extraction_loop"
];
var ROLE_PROFILE_IDS = ["default_pr_roles"];
var DEFAULT_LOOP_SHAPE_ID = "pr-loop";
var DEFAULT_WORKFLOW_PROFILE_ID = "default_pr_loop";
var DEFAULT_ROLE_PROFILE_ID = "default_pr_roles";
var DEFAULT_ROLE_PROFILE = {
  id: "default_pr_roles",
  label: "Default PR roles",
  description: "Readable role aliases mapped onto the existing PR loop worker types.",
  aliases: {
    planner: {
      id: "planner",
      label: "Planner",
      aliasFor: "planner",
      description: "Plan the next PR scope and produce spec-level handoff.",
      systemPrompt: "Plan narrowly, cite repository evidence, and hand off a scoped implementation target.",
      scope: "workspace-write"
    },
    implementer: {
      id: "implementer",
      label: "Implementer",
      aliasFor: "implementation",
      description: "Implement the selected PR without owning Git or GitHub lifecycle actions.",
      systemPrompt: "Implement only the selected PR scope. Keep changes small, tested, and ready for review.",
      scope: "workspace-write"
    },
    reviewer: {
      id: "reviewer",
      label: "Reviewer",
      aliasFor: "reviewer",
      description: "Perform read-only self-review using repository evidence.",
      systemPrompt: "Review read-only. Prioritize correctness, safety boundaries, and missing tests.",
      scope: "read-only"
    },
    "review-fix": {
      id: "review-fix",
      label: "Review fix",
      aliasFor: "review-fix",
      description: "Fix scoped review findings and carry forward out-of-scope work.",
      systemPrompt: "Address only scoped review findings. Record out-of-scope items as follow-ups.",
      scope: "workspace-write"
    },
    "ci-fix": {
      id: "ci-fix",
      label: "CI fix",
      aliasFor: "ci-fix",
      description: "Fix failing checks without expanding feature scope.",
      systemPrompt: "Focus on test and CI failures. Avoid unrelated refactors.",
      scope: "workspace-write"
    },
    "release-manager": {
      id: "release-manager",
      label: "Release manager",
      aliasFor: "reviewer",
      description: "Display-only release readiness posture; not an executable worker in PR L.",
      systemPrompt: "Summarize release readiness. Do not execute as a worker.",
      scope: "read-only"
    }
  }
};
var WORKFLOW_PROFILES = {
  default_pr_loop: {
    id: "default_pr_loop",
    label: "Default PR loop",
    description: "The HOLO-Codex PR delivery behavior with explicit profile audit.",
    loopShape: "pr-loop",
    shapeConfig: { roleOverrides: {} },
    configOverrides: {},
    validationPosture: "Use configured lint, tests, GitNexus, CI, and review gates.",
    likelyGates: ["ambiguous_next_pr", "worker_failed", "ci_required_checks_missing", "merge_requires_confirmation"],
    handoffTemplate: "Follow the selected PR spec and hand off concise evidence to the next role.",
    autonomyBoundary: "Autonomous until configured gates, policy violations, CI/review blockers, or unsafe git actions."
  },
  docs_only_loop: {
    id: "docs_only_loop",
    label: "Docs-only loop",
    description: "Bias validation toward documentation consistency while preserving policy and configured checks.",
    loopShape: "pr-loop",
    shapeConfig: { roleOverrides: {} },
    configOverrides: { maxCiReruns: 0 },
    validationPosture: "Prefer docs consistency checks; if code or config changes, existing tests and policy still decide.",
    likelyGates: ["ambiguous_next_pr", "worker_failed", "policy_violation"],
    handoffTemplate: "Call out docs touched, references updated, and any code/config spillover.",
    autonomyBoundary: "Docs-focused autonomy; policy guards and explicit configured checks remain authoritative."
  },
  review_fix_loop: {
    id: "review_fix_loop",
    label: "Review-fix loop",
    description: "Focus on scoped PR review repair and carryover discipline.",
    loopShape: "pr-loop",
    shapeConfig: { roleOverrides: {} },
    configOverrides: { maxCiReruns: 0 },
    validationPosture: "Prioritize review comments, scoped fixes, and targeted validation.",
    likelyGates: ["review_out_of_scope", "worker_failed", "ci_pending_timeout"],
    handoffTemplate: "Summarize handled findings, unresolved carryover, and validation evidence.",
    autonomyBoundary: "Repair only review-scoped issues; defer unrelated requests through carryover."
  },
  release_ready_loop: {
    id: "release_ready_loop",
    label: "Release-ready loop",
    description: "Tighten merge readiness explanation without adding a release-manager worker.",
    loopShape: "pr-loop",
    shapeConfig: { roleOverrides: {} },
    configOverrides: { autonomyMode: "supervised" },
    validationPosture: "Favor readiness evidence, review status, CI status, and explicit merge confirmation.",
    likelyGates: ["merge_requires_confirmation", "ci_required_checks_missing", "github_transient_failure"],
    handoffTemplate: "List readiness evidence, missing conditions, and any merge risk.",
    autonomyBoundary: "Supervised release posture; merge-related actions require visible confirmation."
  },
  research_report_loop: {
    id: "research_report_loop",
    label: "Research report loop",
    description: "Collect evidence, draft a report, review it, and request human approval before delivery.",
    loopShape: "generic-loop",
    shapeConfig: { roleOverrides: {} },
    configOverrides: { autonomyMode: "autonomous_until_gate" },
    validationPosture: "Require cited evidence, a coherent report artifact, and human approval before delivery.",
    likelyGates: ["generic_goal_needs_confirmation", "generic_human_gate", "generic_scope_change_requested", "worker_failed"],
    handoffTemplate: "Summarize research question, sources checked, claims supported, gaps, and deliverable path.",
    autonomyBoundary: "Autonomous for research and drafting inside allowed write roots; final delivery waits for human approval.",
    expectedDeliverable: "Markdown research report",
    allowedWriteRoots: ["docs", "reports"],
    requiredEvidence: ["source list", "claim-to-evidence summary", "known gaps"],
    reviewChecklist: ["Claims cite evidence", "Uncertainty is explicit", "No raw secrets or prompt content included"],
    maxExecutionReviewCycles: 3
  },
  document_preparation_loop: {
    id: "document_preparation_loop",
    label: "Document preparation loop",
    description: "Prepare a structured document from provided context and deliver it after review.",
    loopShape: "generic-loop",
    shapeConfig: { roleOverrides: {} },
    configOverrides: { autonomyMode: "autonomous_until_gate" },
    validationPosture: "Validate structure, completeness, and requested format before human approval.",
    likelyGates: ["generic_goal_needs_confirmation", "generic_human_gate", "generic_scope_change_requested", "worker_failed"],
    handoffTemplate: "List document purpose, audience, sections prepared, missing input, and deliverable path.",
    autonomyBoundary: "May write only document artifacts under allowed roots; final delivery waits for human approval.",
    expectedDeliverable: "Prepared Markdown document",
    allowedWriteRoots: ["docs", "reports"],
    requiredEvidence: ["source context summary", "document outline", "completion checklist"],
    reviewChecklist: ["Audience and format match the goal", "Sections are complete", "No unsupported claims"],
    maxExecutionReviewCycles: 3
  },
  repo_hygiene_loop: {
    id: "repo_hygiene_loop",
    label: "Repo hygiene loop",
    description: "Audit repository hygiene and produce a scoped report or safe cleanup artifact.",
    loopShape: "generic-loop",
    shapeConfig: { roleOverrides: {} },
    configOverrides: { autonomyMode: "autonomous_until_gate" },
    validationPosture: "Prefer read-only audit; write only report artifacts unless the goal explicitly asks for safe cleanup.",
    likelyGates: ["generic_goal_needs_confirmation", "generic_human_gate", "generic_scope_change_requested", "policy_violation"],
    handoffTemplate: "List inspected areas, hygiene findings, safe fixes, deferred risks, and deliverable path.",
    autonomyBoundary: "Repository inspection is read-only by default; write actions are limited to allowed report roots.",
    expectedDeliverable: "Repo hygiene audit report",
    allowedWriteRoots: ["docs", "reports"],
    requiredEvidence: ["checked files/commands", "finding severity", "recommended action"],
    reviewChecklist: ["No destructive commands", "Findings have repo evidence", "Out-of-scope cleanup is deferred"],
    maxExecutionReviewCycles: 2
  },
  weekly_review_loop: {
    id: "weekly_review_loop",
    label: "Weekly review loop",
    description: "Collect activity signals, summarize progress, and deliver a weekly review artifact.",
    loopShape: "generic-loop",
    shapeConfig: { roleOverrides: {} },
    configOverrides: { autonomyMode: "autonomous_until_gate" },
    validationPosture: "Require summarized evidence and a concise deliverable suitable for human review.",
    likelyGates: ["generic_goal_needs_confirmation", "generic_human_gate", "generic_scope_change_requested", "worker_failed"],
    handoffTemplate: "List timeframe, activity sources, decisions, blockers, follow-ups, and deliverable path.",
    autonomyBoundary: "May summarize local/repo facts and write review artifacts; final delivery waits for approval.",
    expectedDeliverable: "Weekly review Markdown summary",
    allowedWriteRoots: ["docs", "reports"],
    requiredEvidence: ["timeframe", "activity source summary", "follow-up list"],
    reviewChecklist: ["Timeframe is explicit", "Actions are separated from FYI", "No private raw logs included"],
    maxExecutionReviewCycles: 2
  },
  data_extraction_loop: {
    id: "data_extraction_loop",
    label: "Data extraction loop",
    description: "Extract structured data into an auditable artifact, then wait for human approval.",
    loopShape: "generic-loop",
    shapeConfig: { roleOverrides: {} },
    configOverrides: { autonomyMode: "autonomous_until_gate" },
    validationPosture: "Require extraction criteria, sample validation, and artifact metadata before delivery.",
    likelyGates: ["generic_goal_needs_confirmation", "generic_human_gate", "generic_scope_change_requested", "worker_failed"],
    handoffTemplate: "List extraction target, criteria, row/item count, validation sample, and deliverable path.",
    autonomyBoundary: "May write extracted artifacts only under allowed roots; no external side effects.",
    expectedDeliverable: "Structured extraction artifact",
    allowedWriteRoots: ["docs", "reports", "data"],
    requiredEvidence: ["extraction criteria", "sample validation", "count summary"],
    reviewChecklist: ["Schema is documented", "Sample rows match source", "Secrets are redacted"],
    maxExecutionReviewCycles: 3
  }
};
function resolveProfile(config, currentState) {
  const shape = resolveLoopShape(config.loopShape);
  const workflow = workflowProfile(config.workflowProfile);
  const roleProfile = roleProfileById(config.roleProfile);
  if (workflow.loopShape !== shape.id) {
    throw new AgentLoopError("invalid_config", "Workflow profile loopShape does not match config loopShape.");
  }
  validateRoleProfile(roleProfile);
  validateWorkflowProfile(workflow, roleProfile);
  const roleMapping = shape.states.map((state) => roleMappingForState(state, workflow, roleProfile)).filter((item) => item !== void 0);
  const currentRole = currentState ? roleMappingForState(currentState, workflow, roleProfile) : void 0;
  return {
    loopShape: shape.id,
    workflowProfile: workflow.id,
    workflowLabel: workflow.label,
    workflowDescription: workflow.description,
    roleProfile: roleProfile.id,
    lifecycleKind: shape.lifecycleKind,
    ...workflow.expectedDeliverable ? { expectedDeliverable: workflow.expectedDeliverable } : {},
    ...workflow.allowedWriteRoots ? { allowedWriteRoots: workflow.allowedWriteRoots } : {},
    ...currentRole ? { currentRole } : {},
    roleMapping,
    autonomyBoundary: workflow.autonomyBoundary,
    handoffSummary: workflow.handoffTemplate,
    validationPosture: workflow.validationPosture,
    likelyGates: workflow.likelyGates,
    availableWorkflows: Object.values(WORKFLOW_PROFILES).map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description
    })),
    availableRoleProfiles: [{
      id: roleProfile.id,
      label: roleProfile.label,
      description: roleProfile.description
    }]
  };
}
function applyProfileConfig(config) {
  const workflow = workflowProfile(config.workflowProfile);
  validateWorkflowProfile(workflow, roleProfileById(config.roleProfile));
  const override = workflow.configOverrides;
  return {
    ...config,
    ...override.lintCommand && !config.lintCommand ? { lintCommand: override.lintCommand } : {},
    requireReviewApproval: config.requireReviewApproval || override.requireReviewApproval === true,
    maxCiReruns: minNumber(config.maxCiReruns, override.maxCiReruns),
    workerTimeoutMs: minNumber(config.workerTimeoutMs, override.workerTimeoutMs),
    commandTimeoutMs: minNumber(config.commandTimeoutMs, override.commandTimeoutMs),
    autonomyMode: tighterAutonomy(config.autonomyMode, override.autonomyMode),
    protectedPaths: [.../* @__PURE__ */ new Set([...config.protectedPaths, ...override.protectedPaths ?? []])]
  };
}
function workflowStages(config) {
  const workflow = workflowProfile(config.workflowProfile);
  const roleProfile = roleProfileById(config.roleProfile);
  const shape = resolveLoopShape(workflow.loopShape);
  return shape.states.filter((state) => !shape.terminalStates.includes(state)).map((state) => {
    const role = roleMappingForState(state, workflow, roleProfile);
    return {
      state,
      ...role ? { roleAlias: role.alias, workerType: role.workerType } : {},
      ...role ? { sandbox: role.sandbox } : {},
      gateExpected: workflow.likelyGates.length > 0 && gateExpectedForState(workflow.loopShape, state),
      ...workflow.expectedDeliverable && ["HUMAN_GATE", "DELIVER"].includes(state) ? { deliverable: workflow.expectedDeliverable } : {}
    };
  });
}
function workflowProfile(id) {
  const profile = WORKFLOW_PROFILES[id];
  if (!profile) {
    throw new AgentLoopError("invalid_config", "Config workflowProfile is invalid.");
  }
  return profile;
}
function roleProfileById(id) {
  if (id !== DEFAULT_ROLE_PROFILE.id) {
    throw new AgentLoopError("invalid_config", "Config roleProfile is invalid.");
  }
  return DEFAULT_ROLE_PROFILE;
}
function validateRoleProfile(profile) {
  for (const alias of Object.values(profile.aliases)) {
    if (alias.id === "release-manager") {
      continue;
    }
    if (alias.scope !== workerSandbox(alias.aliasFor)) {
      throw new AgentLoopError("invalid_config", "Role profile scope cannot change worker sandbox.", {
        details: { role: alias.id, aliasFor: alias.aliasFor, scope: alias.scope, sandbox: workerSandbox(alias.aliasFor) }
      });
    }
  }
}
function validateWorkflowProfile(workflow, profile) {
  const shape = resolveLoopShape(workflow.loopShape);
  for (const [state, roleAlias] of Object.entries(workflow.shapeConfig.roleOverrides)) {
    if (!shape.states.includes(state)) {
      throw new AgentLoopError("invalid_config", "Workflow profile references an unknown state.", { details: { state } });
    }
    if (roleAlias === "release-manager") {
      throw new AgentLoopError("invalid_config", "release-manager is display-only and cannot be used as an executable role.");
    }
    const role = profile.aliases[roleAlias ?? ""];
    const defaultRole = shape.defaultRoleForState(state);
    if (!role || role.aliasFor !== defaultRole) {
      throw new AgentLoopError("invalid_config", "Workflow role override cannot change the state's worker sandbox.", {
        details: { state, roleAlias, aliasFor: role?.aliasFor, defaultRole }
      });
    }
  }
}
function roleMappingForState(state, workflow, profile) {
  const shape = resolveLoopShape(workflow.loopShape);
  const workerType = shape.defaultRoleForState(state);
  if (!workerType) return void 0;
  const aliasId = workflow.shapeConfig.roleOverrides[state] ?? defaultAliasFor(workerType);
  const role = profile.aliases[aliasId];
  if (!role || role.aliasFor !== workerType) {
    throw new AgentLoopError("invalid_config", "Could not resolve role mapping for workflow profile.", { details: { state, aliasId, workerType } });
  }
  return {
    state,
    alias: role.id,
    workerType,
    label: role.label,
    sandbox: sandboxForShapeState(workflow.loopShape, state, workerType)
  };
}
function workflowProfileDefinition(id) {
  return workflowProfile(id);
}
function defaultAliasFor(workerType) {
  const aliases = {
    planner: "planner",
    implementation: "implementer",
    reviewer: "reviewer",
    "review-fix": "review-fix",
    "ci-fix": "ci-fix"
  };
  return aliases[workerType];
}
function minNumber(current, override) {
  return override === void 0 ? current : Math.min(current, override);
}
function tighterAutonomy(current, override) {
  if (!override) return current;
  const rank = {
    supervised: 0,
    autonomous_until_gate: 1,
    autonomous_until_terminal: 2
  };
  return rank[override] < rank[current] ? override : current;
}
function gateExpectedForState(loopShape, state) {
  if (loopShape === "pr-loop") {
    return ["SELECT_NEXT_PR", "WAIT_REVIEW_OR_CI", "READY_TO_MERGE"].includes(state);
  }
  return ["DEFINE_GOAL", "EXECUTE_STEP", "HUMAN_GATE"].includes(state);
}

// plugins/autonomous-pr-loop/core/config.ts
var CONFIG_DIR = ".agent-loop";
var CONFIG_FILE = "config.json";
var DEFAULT_PROTECTED_PATHS = [
  ".git/**",
  ".agent-loop/**",
  ".claude/**",
  "AGENTS.md",
  "CLAUDE.md",
  ".env*",
  "**/*secret*"
];
var AUTONOMY_MODES = ["supervised", "autonomous_until_gate", "autonomous_until_terminal"];
var MERGE_MODES = ["manual", "conditional", "disabled"];
var NOTIFY_MODES = ["all_gates", "important_only", "blockers_only"];
var WORKER_BACKENDS = ["codex-exec", "codex-app-server"];
var REVIEW_HANDLING_MODES = [
  "fix_scoped_and_carry_forward",
  "ask_on_any_review",
  "require_zero_open_findings"
];
function configPath(repoRoot) {
  return join3(repoRoot, CONFIG_DIR, CONFIG_FILE);
}
function statePath(repoRoot) {
  return join3(repoRoot, CONFIG_DIR, "state.sqlite");
}
function withConfigDefaults(input) {
  const mergeMode = input.mergeMode ?? (input.allowAutoMerge ? "conditional" : "manual");
  return {
    repoId: input.repoId,
    locale: input.locale ?? DEFAULT_LOCALE,
    loopShape: input.loopShape ?? DEFAULT_LOOP_SHAPE_ID,
    workflowProfile: input.workflowProfile ?? DEFAULT_WORKFLOW_PROFILE_ID,
    roleProfile: input.roleProfile ?? DEFAULT_ROLE_PROFILE_ID,
    baseBranch: input.baseBranch ?? "main",
    branchPrefix: input.branchPrefix ?? "codex/",
    plansDir: input.plansDir ?? "docs/plans",
    ...input.lintCommand ? { lintCommand: input.lintCommand } : {},
    ...input.testCommand ? { testCommand: input.testCommand } : {},
    ...input.gitnexusRepo ? { gitnexusRepo: input.gitnexusRepo } : {},
    gitnexusRequired: input.gitnexusRequired ?? true,
    requiredChecks: input.requiredChecks ?? [],
    requireReviewApproval: input.requireReviewApproval ?? true,
    autonomyMode: input.autonomyMode ?? "autonomous_until_gate",
    mergeMode,
    notifyMode: input.notifyMode ?? "important_only",
    reviewHandling: input.reviewHandling ?? "fix_scoped_and_carry_forward",
    ...input.carryoverTarget ? { carryoverTarget: input.carryoverTarget } : {},
    allowAutoMerge: mergeMode === "conditional",
    maxReviewFixRounds: input.maxReviewFixRounds ?? 3,
    maxTestFixRounds: input.maxTestFixRounds ?? 2,
    maxCiReruns: input.maxCiReruns ?? 1,
    commandTimeoutMs: input.commandTimeoutMs ?? 6e5,
    commandOutputLimitBytes: input.commandOutputLimitBytes ?? 65536,
    githubRetryMaxAttempts: input.githubRetryMaxAttempts ?? 3,
    githubRetryBaseDelayMs: input.githubRetryBaseDelayMs ?? 1e3,
    reviewCiPollIntervalMs: input.reviewCiPollIntervalMs ?? 3e4,
    reviewCiMaxWaitMs: input.reviewCiMaxWaitMs ?? 18e5,
    workerBackend: input.workerBackend ?? "codex-exec",
    workerTimeoutMs: input.workerTimeoutMs ?? 18e5,
    workerMaxRetries: input.workerMaxRetries ?? 1,
    workerEphemeral: input.workerEphemeral ?? false,
    protectedPaths: input.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
    ...input.dashboard ? { dashboard: input.dashboard } : {}
  };
}
function loadConfig(repoRoot) {
  const path = configPath(repoRoot);
  if (!existsSync3(path)) {
    throw new AgentLoopError(
      "needs_repo_init",
      "Missing .agent-loop/config.json. Run `pnpm agent-loop init`.",
      { details: { path }, exitCode: 2 }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync3(path, "utf8"));
  } catch (error) {
    throw new AgentLoopError("invalid_config", "Config is not valid JSON.", {
      details: { path, cause: error instanceof Error ? error.message : String(error) }
    });
  }
  const config = validateConfig(parsed);
  return { path, config };
}
function validateConfig(value) {
  if (!isRecord(value)) {
    throw new AgentLoopError("invalid_config", "Config must be a JSON object.");
  }
  assertKnownTopLevelKeys(value);
  if (typeof value.repoId !== "string" || value.repoId.length === 0) {
    throw new AgentLoopError("invalid_config", "Config repoId is required.");
  }
  const config = withConfigDefaults(value);
  const stringFields = ["baseBranch", "branchPrefix", "plansDir"];
  for (const field of stringFields) {
    if (typeof config[field] !== "string" || config[field].length === 0) {
      throw new AgentLoopError("invalid_config", `Config ${field} must be a non-empty string.`);
    }
  }
  const optionalStrings = ["lintCommand", "testCommand", "gitnexusRepo"];
  for (const field of optionalStrings) {
    if (config[field] !== void 0 && typeof config[field] !== "string") {
      throw new AgentLoopError("invalid_config", `Config ${field} must be a string.`);
    }
  }
  if (!WORKER_BACKENDS.includes(config.workerBackend)) {
    throw new AgentLoopError("invalid_config", "Config workerBackend is invalid.");
  }
  if (!AUTONOMY_MODES.includes(config.autonomyMode)) {
    throw new AgentLoopError("invalid_config", "Config autonomyMode is invalid.");
  }
  if (!MERGE_MODES.includes(config.mergeMode)) {
    throw new AgentLoopError("invalid_config", "Config mergeMode is invalid.");
  }
  if (!NOTIFY_MODES.includes(config.notifyMode)) {
    throw new AgentLoopError("invalid_config", "Config notifyMode is invalid.");
  }
  if (!REVIEW_HANDLING_MODES.includes(config.reviewHandling)) {
    throw new AgentLoopError("invalid_config", "Config reviewHandling is invalid.");
  }
  if (!LOCALE_SETTINGS.includes(config.locale)) {
    throw new AgentLoopError("invalid_config", "Config locale is invalid.");
  }
  if (!loopShapeIds().includes(config.loopShape)) {
    throw new AgentLoopError("invalid_config", "Config loopShape is invalid.");
  }
  if (!WORKFLOW_PROFILE_IDS.includes(config.workflowProfile)) {
    throw new AgentLoopError("invalid_config", "Config workflowProfile is invalid.");
  }
  if (!ROLE_PROFILE_IDS.includes(config.roleProfile)) {
    throw new AgentLoopError("invalid_config", "Config roleProfile is invalid.");
  }
  resolveProfile(config);
  if (config.carryoverTarget !== void 0 && typeof config.carryoverTarget !== "string") {
    throw new AgentLoopError("invalid_config", "Config carryoverTarget must be a string.");
  }
  const booleans = ["gitnexusRequired", "requireReviewApproval", "allowAutoMerge", "workerEphemeral"];
  for (const field of booleans) {
    if (typeof config[field] !== "boolean") {
      throw new AgentLoopError("invalid_config", `Config ${field} must be a boolean.`);
    }
  }
  const numbers = ["maxReviewFixRounds", "maxTestFixRounds", "maxCiReruns", "workerMaxRetries"];
  for (const field of numbers) {
    if (!Number.isInteger(config[field]) || config[field] < 0) {
      throw new AgentLoopError("invalid_config", `Config ${field} must be a non-negative integer.`);
    }
  }
  const positiveNumbers = [
    "commandTimeoutMs",
    "commandOutputLimitBytes",
    "githubRetryMaxAttempts",
    "githubRetryBaseDelayMs",
    "reviewCiPollIntervalMs",
    "reviewCiMaxWaitMs",
    "workerTimeoutMs"
  ];
  for (const field of positiveNumbers) {
    if (!Number.isInteger(config[field]) || config[field] < 1) {
      throw new AgentLoopError("invalid_config", `Config ${field} must be a positive integer.`);
    }
  }
  if (!Array.isArray(config.requiredChecks) || !config.requiredChecks.every(isString)) {
    throw new AgentLoopError("invalid_config", "Config requiredChecks must be a string array.");
  }
  if (!Array.isArray(config.protectedPaths) || !config.protectedPaths.every(isString)) {
    throw new AgentLoopError("invalid_config", "Config protectedPaths must be a string array.");
  }
  if (config.dashboard) {
    assertKnownDashboardKeys(config.dashboard);
    if (typeof config.dashboard.enabled !== "boolean" || typeof config.dashboard.host !== "string" || config.dashboard.host.length === 0) {
      throw new AgentLoopError("invalid_config", "Config dashboard is invalid.");
    }
    if (config.dashboard.port !== void 0 && (!Number.isInteger(config.dashboard.port) || config.dashboard.port < 1 || config.dashboard.port > 65535)) {
      throw new AgentLoopError("invalid_config", "Config dashboard.port is invalid.");
    }
  }
  return config;
}
function assertKnownTopLevelKeys(value) {
  const allowed = /* @__PURE__ */ new Set([
    "repoId",
    "locale",
    "loopShape",
    "workflowProfile",
    "roleProfile",
    "baseBranch",
    "branchPrefix",
    "plansDir",
    "lintCommand",
    "testCommand",
    "gitnexusRepo",
    "gitnexusRequired",
    "requiredChecks",
    "requireReviewApproval",
    "autonomyMode",
    "mergeMode",
    "notifyMode",
    "reviewHandling",
    "carryoverTarget",
    "allowAutoMerge",
    "maxReviewFixRounds",
    "maxTestFixRounds",
    "maxCiReruns",
    "commandTimeoutMs",
    "commandOutputLimitBytes",
    "githubRetryMaxAttempts",
    "githubRetryBaseDelayMs",
    "reviewCiPollIntervalMs",
    "reviewCiMaxWaitMs",
    "workerBackend",
    "workerTimeoutMs",
    "workerMaxRetries",
    "workerEphemeral",
    "protectedPaths",
    "dashboard"
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new AgentLoopError("invalid_config", "Config contains unknown fields.", {
      details: { fields: unknown }
    });
  }
}
function assertKnownDashboardKeys(value) {
  const allowed = /* @__PURE__ */ new Set(["enabled", "host", "port"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new AgentLoopError("invalid_config", "Config dashboard contains unknown fields.", {
      details: { fields: unknown }
    });
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value) {
  return typeof value === "string";
}

// plugins/autonomous-pr-loop/core/storage.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// plugins/autonomous-pr-loop/core/redaction.ts
function redactSecrets(value) {
  return value.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/\b[A-Za-z0-9._%+-]+:[^@\s]+@/g, "[redacted]@").replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]").replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]").replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]").replace(/((?:token|api_key|authorization|password|secret)\s*[:=]\s*)(["'])(?:(?!\2).)*\2/gi, "$1$2[redacted]$2").replace(/((?:token|api_key|authorization|password|secret)\s*[:=]\s*)[^\n\r,;}]+/gi, "$1[redacted]");
}
function isSecretKey(key) {
  return /token|api_key|authorization|password|secret/i.test(key);
}

// plugins/autonomous-pr-loop/core/storage.ts
var STORAGE_SCHEMA_VERSION = 8;
var SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3, 4, 5, 6, 7, STORAGE_SCHEMA_VERSION];
var TIMELINE_SOURCES = ["event", "worker_event", "worker", "state", "gate", "artifact", "decision"];
var TIMELINE_TRIGGER_NAMES = [
  "timeline_events_insert",
  "timeline_worker_events_insert",
  "timeline_workers_insert",
  "timeline_workers_status_update",
  "timeline_states_insert",
  "timeline_gates_insert",
  "timeline_artifacts_insert",
  "timeline_decisions_insert"
];
var PR_C_TABLES_SQL = `
  create table if not exists pr_links (
    id text primary key,
    run_id text not null,
    branch text not null,
    pr_number integer not null,
    url text not null,
    head_ref text not null,
    base_ref text not null,
    state text not null,
    draft integer not null,
    created_at text not null,
    updated_at text not null,
    unique(run_id, pr_number),
    foreign key(run_id) references runs(id)
  );

  create table if not exists ci_checks (
    id text primary key,
    run_id text not null,
    pr_number integer not null,
    name text not null,
    status text not null,
    conclusion text,
    url text,
    started_at text,
    completed_at text,
    observed_at text not null,
    foreign key(run_id) references runs(id)
  );

  create table if not exists review_comments (
    id text primary key,
    run_id text not null,
    pr_number integer not null,
    comment_id text not null,
    url text not null,
    author text not null,
    body text not null,
    path text not null,
    line integer,
    diff_hunk text not null,
    is_resolved integer not null,
    is_outdated integer not null,
    actionable integer not null,
    status text not null,
    observed_at text not null,
    unique(run_id, comment_id),
    foreign key(run_id) references runs(id)
  );

  create table if not exists decisions (
    id text primary key,
    run_id text not null,
    kind text not null,
    message text not null,
    details_json text,
    created_at text not null,
    foreign key(run_id) references runs(id)
  );
`;
var PR_D_TABLES_SQL = `
  create table if not exists workers (
    id text primary key,
    run_id text not null,
    type text not null,
    backend text not null,
    status text not null,
    thread_id text,
    attempt integer not null,
    resume_used integer not null,
    started_at text not null,
    completed_at text,
    exit_code integer,
    result_artifact_id text,
    raw_jsonl_artifact_id text,
    error text,
    foreign key(run_id) references runs(id)
  );

  create table if not exists worker_events (
    seq integer primary key autoincrement,
    id text not null unique,
    worker_id text not null,
    run_id text not null,
    event_type text not null,
    item_type text,
    item_id text,
    item_status text,
    thread_id text,
    backend text,
    summary_json text,
    usage_json text,
    artifact_ids_json text,
    created_at text not null,
    foreign key(worker_id) references workers(id),
    foreign key(run_id) references runs(id)
  );

  create unique index if not exists workers_single_running
    on workers(status)
    where status = 'running';
`;
var PR_E_INDEXES_SQL = `
  create unique index if not exists runs_single_running
    on runs(status)
    where status = 'RUNNING';
`;
var PR_E_TABLES_SQL = `
  create table if not exists run_checks (
    run_id text not null,
    kind text not null,
    status text not null,
    details_json text,
    created_at text not null,
    primary key(run_id, kind),
    foreign key(run_id) references runs(id)
  );
`;
var TIMELINE_INDEX_SQL = `
  create table if not exists timeline_index (
    timeline_seq integer primary key autoincrement,
    source text not null,
    source_id text not null,
    source_seq integer,
    run_id text,
    worker_id text,
    created_at text not null,
    unique(source, source_id)
  );

  create index if not exists timeline_index_created
    on timeline_index(created_at desc, timeline_seq desc);
  create index if not exists timeline_index_run
    on timeline_index(run_id, timeline_seq desc);
  create index if not exists timeline_index_worker
    on timeline_index(worker_id, timeline_seq desc);
`;
var TIMELINE_TRIGGERS_SQL = `
  create trigger if not exists timeline_events_insert
  after insert on events
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('event', new.id, new.seq, new.run_id, null, new.created_at);
  end;

  create trigger if not exists timeline_worker_events_insert
  after insert on worker_events
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('worker_event', new.id, new.seq, new.run_id, new.worker_id, new.created_at);
  end;

  create trigger if not exists timeline_workers_insert
  after insert on workers
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('worker', new.id || ':' || new.status, null, new.run_id, new.id, new.started_at);
  end;

  create trigger if not exists timeline_workers_status_update
  after update of status on workers
  when old.status is not new.status
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values (
      'worker',
      new.id || ':' || new.status,
      null,
      new.run_id,
      new.id,
      coalesce(new.completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  end;

  create trigger if not exists timeline_states_insert
  after insert on states
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('state', cast(new.id as text), new.id, new.run_id, null, new.created_at);
  end;

  create trigger if not exists timeline_gates_insert
  after insert on gates
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('gate', new.id, null, new.run_id, null, new.created_at);
  end;

  create trigger if not exists timeline_artifacts_insert
  after insert on artifacts
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('artifact', new.id, null, new.run_id, null, new.created_at);
  end;

  create trigger if not exists timeline_decisions_insert
  after insert on decisions
  begin
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    values ('decision', new.id, null, new.run_id, null, new.created_at);
  end;
`;
var SCHEMA_SQL = `
  create table if not exists runs (
    id text primary key,
    status text not null,
    current_state text,
    version integer not null default 0,
    branch text,
    worktree_clean integer,
    started_at text,
    stopped_at text,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists states (
    id integer primary key autoincrement,
    run_id text,
    status text not null,
    state text,
    version integer not null,
    payload_json text,
    created_at text not null,
    foreign key(run_id) references runs(id)
  );

  create table if not exists events (
    seq integer primary key autoincrement,
    id text not null unique,
    run_id text,
    kind text not null,
    message text not null,
    state_before text,
    state_after text,
    payload_json text,
    artifact_ids_json text,
    created_at text not null,
    foreign key(run_id) references runs(id)
  );

  create table if not exists gates (
    id text primary key,
    run_id text,
    kind text not null,
    status text not null,
    message text not null,
    details_json text,
    created_at text not null,
    resolved_at text,
    decision_note text,
    decided_at text,
    foreign key(run_id) references runs(id)
  );

  create table if not exists artifacts (
    id text primary key,
    run_id text,
    kind text not null,
    name text,
    path text not null,
    sha256 text,
    metadata_json text,
    created_at text not null,
    foreign key(run_id) references runs(id)
  );

  create table if not exists repo_config (
    id integer primary key check (id = 1),
    schema_version integer not null,
    config_json text not null,
    updated_at text not null
  );

  ${PR_C_TABLES_SQL}
  ${PR_D_TABLES_SQL}
  ${PR_E_TABLES_SQL}
  ${PR_E_INDEXES_SQL}
`;
var SqliteAgentLoopStorage = class {
  constructor(path, options = {}) {
    this.path = path;
    this.mode = options.mode ?? "rw";
    if (this.mode === "rw") {
      mkdirSync2(dirname2(path), { recursive: true });
    } else if (!existsSync4(path)) {
      throw new AgentLoopError("storage_error", "Read-only storage file does not exist.", {
        details: { path }
      });
    }
    this.db = new DatabaseSync(path, {
      readOnly: this.mode === "ro",
      enableForeignKeyConstraints: true,
      timeout: 5e3
    });
    try {
      this.db.exec("PRAGMA foreign_keys=ON");
      this.db.exec("PRAGMA busy_timeout=5000");
      if (this.mode === "rw") {
        this.db.exec("PRAGMA journal_mode=WAL");
      }
      this.ensureSchema();
      if (this.mode === "rw") {
        this.ensureRepoConfigVersion();
      } else {
        this.validateRepoConfigVersion();
      }
      const workersSql = `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                                 started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
                          from workers`;
      this.listWorkersByRunStatement = this.db.prepare(`${workersSql} where run_id = ? order by started_at desc limit ?`);
      this.listWorkersStatement = this.db.prepare(`${workersSql} order by started_at desc limit ?`);
    } catch (error) {
      this.db.close();
      throw toStorageError(error, "Failed to open agent-loop storage.");
    }
  }
  path;
  db;
  mode;
  listWorkersByRunStatement;
  listWorkersStatement;
  close() {
    this.db.close();
  }
  writeRepoConfig(config) {
    const snapshot = JSON.stringify({ schemaVersion: STORAGE_SCHEMA_VERSION, ...config });
    this.transaction(() => {
      this.db.prepare(
        `insert into repo_config (id, schema_version, config_json, updated_at)
           values (1, ?, ?, ?)
           on conflict(id) do update set
             schema_version = excluded.schema_version,
             config_json = excluded.config_json,
             updated_at = excluded.updated_at`
      ).run(STORAGE_SCHEMA_VERSION, snapshot, now());
    });
  }
  readRepoConfig() {
    const row = this.db.prepare("select schema_version, config_json from repo_config where id = 1").get();
    if (!row) {
      return void 0;
    }
    if (!isSupportedSchemaVersion(row.schema_version)) {
      throw new AgentLoopError(
        "storage_schema_mismatch",
        `Stored repo config schema version ${row.schema_version} is not supported.`,
        { details: { expected: STORAGE_SCHEMA_VERSION, actual: row.schema_version } }
      );
    }
    const parsed = parseJson(row.config_json, "Stored repo config JSON is invalid.");
    const { schemaVersion: _schemaVersion, ...config } = parsed;
    return config;
  }
  createRun(status, options = {}) {
    const createdAt = now();
    const run = {
      id: randomUUID2(),
      status,
      ...options.currentState ? { currentState: options.currentState } : {},
      version: 0,
      ...options.branch ? { branch: options.branch } : {},
      ...options.worktreeClean !== void 0 ? { worktreeClean: options.worktreeClean } : {},
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt
    };
    try {
      this.transaction(() => {
        this.db.prepare(
          `insert into runs (
               id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
             )
             values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)`
        ).run(
          run.id,
          run.status,
          run.currentState ?? null,
          run.version,
          run.branch ?? null,
          boolToDb(run.worktreeClean),
          run.startedAt ?? null,
          run.createdAt,
          run.updatedAt
        );
        this.db.prepare(
          `insert into states (run_id, status, state, version, payload_json, created_at)
             values (?, ?, ?, ?, null, ?)`
        ).run(run.id, run.status, run.currentState ?? run.status, run.version, run.updatedAt);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AgentLoopError("version_conflict", "Another active run already exists.", {
          details: { status },
          exitCode: 2
        });
      }
      throw error;
    }
    return run;
  }
  getOrCreateActiveRun(options = {}) {
    return this.transaction(() => {
      const active = this.getActiveRun();
      if (active) {
        return { run: active, created: false };
      }
      const createdAt = now();
      const run = {
        id: randomUUID2(),
        status: "RUNNING",
        ...options.currentState ? { currentState: options.currentState } : {},
        version: 0,
        ...options.branch ? { branch: options.branch } : {},
        ...options.worktreeClean !== void 0 ? { worktreeClean: options.worktreeClean } : {},
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt
      };
      this.db.prepare(
        `insert into runs (
             id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
           )
           values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)`
      ).run(
        run.id,
        run.status,
        run.currentState ?? null,
        run.version,
        run.branch ?? null,
        boolToDb(run.worktreeClean),
        run.startedAt ?? null,
        run.createdAt,
        run.updatedAt
      );
      this.db.prepare(
        `insert into states (run_id, status, state, version, payload_json, created_at)
           values (?, ?, ?, ?, null, ?)`
      ).run(run.id, run.status, run.currentState ?? run.status, run.version, run.updatedAt);
      return { run, created: true };
    });
  }
  recordRunCheck(check) {
    const stored = { ...check, createdAt: now() };
    this.transaction(() => {
      this.db.prepare(
        `insert into run_checks (run_id, kind, status, details_json, created_at)
           values (?, ?, ?, ?, ?)
           on conflict(run_id, kind) do update set
             status = excluded.status,
             details_json = excluded.details_json,
             created_at = excluded.created_at`
      ).run(
        stored.runId,
        stored.kind,
        stored.status,
        stored.details === void 0 ? null : JSON.stringify(stored.details),
        stored.createdAt
      );
    });
    return stored;
  }
  hasRunCheck(runId, kind) {
    const row = this.db.prepare("select 1 from run_checks where run_id = ? and kind = ? and status in ('passed', 'skipped') limit 1").get(runId, kind);
    return row !== void 0;
  }
  listRunChecks(runId) {
    const rows = this.db.prepare("select run_id, kind, status, details_json, created_at from run_checks where run_id = ? order by created_at desc").all(runId);
    return rows.map(fromRunCheckRow);
  }
  updateRunStatus(runId, expectedVersion, status, options = {}) {
    const updatedAt = now();
    return this.transaction(() => {
      const result = this.db.prepare(
        `update runs
           set status = ?,
               current_state = coalesce(?, current_state),
               branch = coalesce(?, branch),
               worktree_clean = coalesce(?, worktree_clean),
               stopped_at = coalesce(?, stopped_at),
               version = version + 1,
               updated_at = ?
           where id = ? and version = ?`
      ).run(
        status,
        options.currentState ?? null,
        options.branch ?? null,
        boolToDb(options.worktreeClean),
        options.stoppedAt ?? null,
        updatedAt,
        runId,
        expectedVersion
      );
      if (result.changes !== 1) {
        throw new AgentLoopError(
          "version_conflict",
          `Run ${runId} was updated by another writer.`,
          { details: { runId, expectedVersion } }
        );
      }
      const run = this.getRun(runId);
      if (!run) {
        throw new AgentLoopError("storage_error", `Run not found: ${runId}`);
      }
      this.db.prepare(
        `insert into states (run_id, status, state, version, payload_json, created_at)
           values (?, ?, ?, ?, null, ?)`
      ).run(run.id, run.status, run.currentState ?? run.status, run.version, run.updatedAt);
      return run;
    });
  }
  appendEvent(event) {
    const stored = {
      id: randomUUID2(),
      ...event,
      createdAt: now()
    };
    let seq = 0;
    this.transaction(() => {
      this.db.prepare(
        `insert into events (
             id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
           )
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        stored.id,
        stored.runId ?? null,
        stored.kind,
        stored.message,
        stored.stateBefore ?? null,
        stored.stateAfter ?? null,
        stored.payload === void 0 ? null : JSON.stringify(stored.payload),
        stored.artifactIds === void 0 ? null : JSON.stringify(stored.artifactIds),
        stored.createdAt
      );
      seq = Number(this.db.prepare("select last_insert_rowid() as seq").get().seq);
    });
    return { seq, ...stored };
  }
  writeGate(gate) {
    this.transaction(() => {
      this.db.prepare(
        `insert into gates (id, run_id, kind, status, message, details_json, created_at, resolved_at)
           values (?, ?, ?, 'open', ?, ?, ?, null)`
      ).run(
        randomUUID2(),
        gate.runId ?? null,
        gate.kind,
        gate.message,
        gate.details === void 0 ? null : JSON.stringify(gate.details),
        now()
      );
    });
  }
  resolveOpenGates(runId) {
    this.transaction(() => {
      this.db.prepare(
        `update gates
           set status = 'resolved', resolved_at = ?
           where run_id = ? and status = 'open'`
      ).run(now(), runId);
    });
  }
  resolveOpenGatesByKind(kind, options = {}) {
    const scope = options.scope ?? (options.runId ? "run" : "repo");
    this.transaction(() => {
      if (scope === "run") {
        if (!options.runId) {
          throw new AgentLoopError("storage_error", "runId is required for run-scoped gate recovery.");
        }
        this.db.prepare(
          `update gates
             set status = 'resolved', resolved_at = ?
             where kind = ? and run_id = ? and status = 'open'`
        ).run(now(), kind, options.runId);
        return;
      }
      if (scope === "repo") {
        this.db.prepare(
          `update gates
             set status = 'resolved', resolved_at = ?
             where kind = ? and run_id is null and status = 'open'`
        ).run(now(), kind);
        return;
      }
      this.db.prepare(
        `update gates
           set status = 'resolved', resolved_at = ?
           where kind = ? and status = 'open'`
      ).run(now(), kind);
    });
  }
  listGates(runId) {
    const sql = `select id, run_id, kind, status, message, details_json, created_at,
                        resolved_at, decision_note, decided_at
                 from gates
                 ${runId ? "where run_id = ?" : ""}
                 order by created_at desc
                 limit 100`;
    const rows = runId ? this.db.prepare(sql).all(runId) : this.db.prepare(sql).all();
    return rows.map(fromGateRow);
  }
  getGate(gateId) {
    const row = this.db.prepare(
      `select id, run_id, kind, status, message, details_json, created_at,
                resolved_at, decision_note, decided_at
         from gates
         where id = ?`
    ).get(gateId);
    return row ? fromGateRow(row) : void 0;
  }
  decideGate(gateId, decision, note) {
    if (note.trim().length === 0) {
      throw new AgentLoopError("invalid_config", "Gate decision note is required.");
    }
    const decidedAt = now();
    this.transaction(() => {
      const result = this.db.prepare(
        `update gates
           set status = ?, decision_note = ?, decided_at = ?, resolved_at = coalesce(resolved_at, ?)
           where id = ? and status = 'open'`
      ).run(decision, note, decidedAt, decidedAt, gateId);
      if (result.changes !== 1) {
        const gate2 = this.getGate(gateId);
        if (!gate2) {
          throw new AgentLoopError("storage_error", `Gate not found: ${gateId}`);
        }
        throw new AgentLoopError("storage_error", `Gate ${gateId} is not open.`, {
          details: { gateId, status: gate2.status }
        });
      }
    });
    const gate = this.getGate(gateId);
    if (!gate) {
      throw new AgentLoopError("storage_error", `Gate not found after decision: ${gateId}`);
    }
    return gate;
  }
  getCurrentStatus() {
    const repoGate = this.db.prepare(
      `select kind, message, details_json
         from gates
         where status = 'open' and run_id is null
         order by created_at desc
         limit 1`
    ).get();
    if (repoGate) {
      return {
        status: "BLOCKED",
        gate: statusGateFromRow(repoGate)
      };
    }
    const row = this.db.prepare(
      `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         order by updated_at desc, rowid desc
         limit 1`
    ).get();
    if (!row) {
      return { status: "IDLE" };
    }
    const run = fromRunRow(row);
    const runGate = this.db.prepare(
      `select kind, message, details_json
         from gates
         where status = 'open' and run_id = ?
         order by created_at desc
         limit 1`
    ).get(run.id);
    if (runGate) {
      return {
        status: "BLOCKED",
        run,
        gate: statusGateFromRow(runGate)
      };
    }
    if (run.status === "BLOCKED" && latestGateSatisfied(this.db, run.id)) {
      return { status: "READY", run: { ...run, status: "READY" } };
    }
    return { status: run.status, run };
  }
  listEvents(options = 50) {
    const limit = typeof options === "number" ? options : options.limit ?? 50;
    const sinceSeq = typeof options === "number" ? void 0 : options.sinceSeq;
    const rows = sinceSeq === void 0 ? this.db.prepare(
      `select seq, id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
           from events
           order by seq desc
           limit ?`
    ).all(limit) : this.db.prepare(
      `select seq, id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
           from events
           where seq > ?
           order by seq asc
           limit ?`
    ).all(sinceSeq, limit);
    return rows.map(fromEventRow);
  }
  findLatestEvent(runId, kind) {
    const row = this.db.prepare(
      `select seq, id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
         from events
         where run_id = ? and kind = ?
         order by seq desc
         limit 1`
    ).get(runId, kind);
    return row ? fromEventRow(row) : void 0;
  }
  listAgentTimeline(query = {}) {
    const limit = clampLimit(query.limit ?? 50);
    const cursor = query.cursor ? decodeTimelineCursor(query.cursor) : void 0;
    const params = [];
    const where = [];
    if (cursor) {
      where.push("(created_at < ? or (created_at = ? and timeline_seq < ?))");
      params.push(cursor.occurredAt, cursor.occurredAt, cursor.timelineSeq);
    }
    if (query.sources?.length) {
      const sources = normalizeTimelineSources(query.sources);
      where.push(`source in (${sources.map(() => "?").join(", ")})`);
      params.push(...sources);
    }
    if (query.runId) {
      where.push("run_id = ?");
      params.push(query.runId);
    }
    if (query.workerId) {
      where.push("worker_id = ?");
      params.push(query.workerId);
    }
    params.push(limit + 1);
    const rows = this.db.prepare(
      `select timeline_seq, source, source_id, source_seq, run_id, worker_id, created_at
         from timeline_index
         ${where.length ? `where ${where.join(" and ")}` : ""}
         order by created_at desc, timeline_seq desc
         limit ?`
    ).all(...params);
    const pageRows = rows.slice(0, limit);
    const entries = pageRows.map((row) => this.timelineEntry(row)).filter((entry) => entry !== void 0);
    const last = pageRows[pageRows.length - 1];
    return {
      entries,
      ...rows.length > limit && last ? { nextCursor: encodeTimelineCursor(last.timeline_seq, last.created_at) } : {}
    };
  }
  checkTimelineIntegrity() {
    const missingTable = !hasTable(this.db, "timeline_index");
    const triggers = new Set(this.db.prepare("select name from sqlite_master where type = 'trigger' and name like 'timeline_%'").all().map((row) => row.name));
    const missingTriggers = TIMELINE_TRIGGER_NAMES.filter((name) => !triggers.has(name));
    const sourceCounts = Object.fromEntries(TIMELINE_SOURCES.map((source) => [source, 0]));
    const missingSourceRows = [];
    if (!missingTable) {
      const rows = this.db.prepare("select source, count(*) as count from timeline_index group by source").all();
      for (const row of rows) {
        if (TIMELINE_SOURCES.includes(row.source)) {
          sourceCounts[row.source] = row.count;
        }
      }
      missingSourceRows.push(...timelineMissingSourceRows(this.db));
    }
    const ok2 = !missingTable && missingTriggers.length === 0 && missingSourceRows.length === 0;
    return {
      ok: ok2,
      missingTable,
      missingTriggers,
      missingSourceRows,
      sourceCounts,
      repair: "Run storage migration or rebuild timeline_index by dropping timeline_index/triggers and reopening storage in read-write mode."
    };
  }
  upsertPrLink(link) {
    const createdAt = now();
    const id = randomUUID2();
    this.transaction(() => {
      this.db.prepare(
        `insert into pr_links (
             id, run_id, branch, pr_number, url, head_ref, base_ref, state, draft, created_at, updated_at
           )
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(run_id, pr_number) do update set
             branch = excluded.branch,
             url = excluded.url,
             head_ref = excluded.head_ref,
             base_ref = excluded.base_ref,
             state = excluded.state,
             draft = excluded.draft,
             updated_at = excluded.updated_at`
      ).run(
        id,
        link.runId,
        link.branch,
        link.prNumber,
        link.url,
        link.headRef,
        link.baseRef,
        link.state,
        boolToDb(link.draft),
        createdAt,
        createdAt
      );
    });
    const stored = this.getPrLink(link.runId);
    if (!stored) {
      throw new AgentLoopError("storage_error", "PR link was not stored.");
    }
    return stored;
  }
  getPrLink(runId) {
    const row = this.db.prepare(
      `select id, run_id, branch, pr_number, url, head_ref, base_ref, state, draft, created_at, updated_at
         from pr_links
         where run_id = ?
         order by updated_at desc
         limit 1`
    ).get(runId);
    return row ? fromPrLinkRow(row) : void 0;
  }
  replaceCiChecks(runId, prNumber, checks) {
    const observedAt = now();
    this.transaction(() => {
      this.db.prepare("delete from ci_checks where run_id = ? and pr_number = ?").run(runId, prNumber);
      for (const check of checks) {
        this.db.prepare(
          `insert into ci_checks (
               id, run_id, pr_number, name, status, conclusion, url, started_at, completed_at, observed_at
             )
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID2(),
          runId,
          prNumber,
          check.name,
          check.status,
          check.conclusion ?? null,
          check.url ?? null,
          check.startedAt ?? null,
          check.completedAt ?? null,
          observedAt
        );
      }
    });
    return this.listCiChecks(runId);
  }
  listCiChecks(runId) {
    const rows = this.db.prepare(
      `select id, run_id, pr_number, name, status, conclusion, url, started_at, completed_at, observed_at
         from ci_checks
         where run_id = ?
         order by observed_at desc, name asc`
    ).all(runId);
    return rows.map(fromCiCheckRow);
  }
  replaceReviewComments(runId, prNumber, comments) {
    const observedAt = now();
    this.transaction(() => {
      this.db.prepare("delete from review_comments where run_id = ? and pr_number = ?").run(runId, prNumber);
      for (const comment of comments) {
        this.db.prepare(
          `insert into review_comments (
               id, run_id, pr_number, comment_id, url, author, body, path, line, diff_hunk,
               is_resolved, is_outdated, actionable, status, observed_at
             )
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID2(),
          runId,
          prNumber,
          comment.commentId,
          comment.url,
          comment.author,
          comment.body,
          comment.path,
          comment.line ?? null,
          comment.diffHunk,
          boolToDb(comment.isResolved),
          boolToDb(comment.isOutdated),
          boolToDb(comment.actionable),
          comment.status,
          observedAt
        );
      }
    });
    return this.listReviewComments(runId);
  }
  listReviewComments(runId) {
    const rows = this.db.prepare(
      `select id, run_id, pr_number, comment_id, url, author, body, path, line, diff_hunk,
                is_resolved, is_outdated, actionable, status, observed_at
         from review_comments
         where run_id = ?
         order by observed_at desc, path asc`
    ).all(runId);
    return rows.map(fromReviewCommentRow);
  }
  appendDecision(decision) {
    const stored = { id: randomUUID2(), ...decision, createdAt: now() };
    this.transaction(() => {
      this.db.prepare(
        `insert into decisions (id, run_id, kind, message, details_json, created_at)
           values (?, ?, ?, ?, ?, ?)`
      ).run(
        stored.id,
        stored.runId,
        stored.kind,
        stored.message,
        stored.details === void 0 ? null : JSON.stringify(stored.details),
        stored.createdAt
      );
    });
    return stored;
  }
  listDecisions(runId) {
    const rows = this.db.prepare(
      `select id, run_id, kind, message, details_json, created_at
         from decisions
         where run_id = ?
         order by created_at desc`
    ).all(runId);
    return rows.map(fromDecisionRow);
  }
  createWorker(worker) {
    const id = randomUUID2();
    const startedAt = now();
    try {
      this.transaction(() => {
        this.db.prepare(
          `insert into workers (
               id, run_id, type, backend, status, thread_id, attempt, resume_used,
               started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
             )
             values (?, ?, ?, ?, 'running', null, ?, ?, ?, null, null, null, null, null)`
        ).run(id, worker.runId, worker.type, worker.backend, worker.attempt, boolToDb(worker.resumeUsed), startedAt);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AgentLoopError("worker_already_running", "Another worker is already running.", {
          details: { runId: worker.runId },
          exitCode: 2
        });
      }
      throw error;
    }
    return this.getWorker(id);
  }
  updateWorker(workerId, patch) {
    this.transaction(() => {
      this.db.prepare(
        `update workers
           set status = coalesce(?, status),
               thread_id = coalesce(?, thread_id),
               completed_at = coalesce(?, completed_at),
               exit_code = coalesce(?, exit_code),
               result_artifact_id = coalesce(?, result_artifact_id),
               raw_jsonl_artifact_id = coalesce(?, raw_jsonl_artifact_id),
               error = coalesce(?, error)
           where id = ?`
      ).run(
        patch.status ?? null,
        patch.threadId ?? null,
        patch.completedAt ?? null,
        patch.exitCode ?? null,
        patch.resultArtifactId ?? null,
        patch.rawJsonlArtifactId ?? null,
        patch.error ?? null,
        workerId
      );
    });
    return this.getWorker(workerId);
  }
  getRunningWorker() {
    const row = this.db.prepare(
      `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
         from workers
         where status = 'running'
         order by started_at desc
         limit 1`
    ).get();
    return row ? fromWorkerRow(row) : void 0;
  }
  listWorkers(runId, limit = 50) {
    const rows = runId ? this.listWorkersByRunStatement.all(runId, limit) : this.listWorkersStatement.all(limit);
    return rows.map(fromWorkerRow);
  }
  appendWorkerEvent(event) {
    const existing = this.findDuplicateWorkerEvent(event);
    if (existing) {
      return existing;
    }
    const stored = { id: randomUUID2(), ...event, createdAt: now() };
    let seq = 0;
    this.transaction(() => {
      this.db.prepare(
        `insert into worker_events (
             id, worker_id, run_id, event_type, item_type, item_id, item_status,
             thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           )
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        stored.id,
        stored.workerId,
        stored.runId,
        stored.eventType,
        stored.itemType ?? null,
        stored.itemId ?? null,
        stored.itemStatus ?? null,
        stored.threadId ?? null,
        stored.backend ?? null,
        stored.summary === void 0 ? null : JSON.stringify(stored.summary),
        stored.usage === void 0 ? null : JSON.stringify(stored.usage),
        stored.artifactIds === void 0 ? null : JSON.stringify(stored.artifactIds),
        stored.createdAt
      );
      seq = Number(this.db.prepare("select last_insert_rowid() as seq").get().seq);
    });
    return { seq, ...stored };
  }
  listWorkerEvents(workerId) {
    const rows = this.db.prepare(
      `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
         from worker_events
         where worker_id = ?
         order by seq asc`
    ).all(workerId);
    return rows.map(fromWorkerEventRow);
  }
  findDuplicateWorkerEvent(event) {
    if (!event.threadId) {
      return void 0;
    }
    const row = event.itemId ? this.db.prepare(
      `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                  thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           from worker_events
           where thread_id = ? and item_id = ? and coalesce(item_status, '') = ?
           limit 1`
    ).get(event.threadId, event.itemId, event.itemStatus ?? "") : this.db.prepare(
      `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                  thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           from worker_events
           where thread_id = ? and event_type = ? and item_id is null
           limit 1`
    ).get(event.threadId, event.eventType);
    return row ? fromWorkerEventRow(row) : void 0;
  }
  insertArtifact(record) {
    this.transaction(() => {
      this.db.prepare(
        `insert into artifacts (id, run_id, kind, name, path, sha256, metadata_json, created_at)
           values (?, ?, ?, ?, ?, ?, null, ?)`
      ).run(
        record.id,
        record.runId,
        record.kind,
        record.name,
        record.path,
        record.sha256,
        record.createdAt
      );
    });
  }
  getArtifact(artifactId) {
    const row = this.db.prepare(
      `select id, run_id, kind, name, path, sha256, created_at
         from artifacts
         where id = ?`
    ).get(artifactId);
    if (!row) {
      throw new AgentLoopError("storage_error", `Artifact not found: ${artifactId}`);
    }
    return fromArtifactRow(row);
  }
  listArtifacts(runId) {
    const rows = this.db.prepare(
      `select id, run_id, kind, name, path, sha256, created_at
         from artifacts
         where run_id = ?
         order by created_at asc`
    ).all(runId);
    return rows.map(fromArtifactRow);
  }
  linkArtifactToEvent(eventId, artifactId) {
    this.transaction(() => {
      const row = this.db.prepare("select artifact_ids_json from events where id = ?").get(eventId);
      if (!row) {
        throw new AgentLoopError("storage_error", `Event not found: ${eventId}`);
      }
      const ids = row.artifact_ids_json ? parseJson(row.artifact_ids_json, "Stored artifact id list is invalid.") : [];
      if (!ids.includes(artifactId)) {
        ids.push(artifactId);
      }
      this.db.prepare("update events set artifact_ids_json = ? where id = ?").run(JSON.stringify(ids), eventId);
    });
  }
  getCurrentRun() {
    const row = this.db.prepare(
      `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         order by updated_at desc
         limit 1`
    ).get();
    return row ? fromRunRow(row) : void 0;
  }
  listRuns(limit = 50) {
    const rows = this.db.prepare(
      `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         order by updated_at desc
         limit ?`
    ).all(limit);
    return rows.map(fromRunRow);
  }
  /** Run a group of read queries against one SQLite snapshot. */
  readTransaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AgentLoopError("storage_error", "Read transaction rollback failed.", {
          details: {
            cause: error instanceof Error ? error.message : String(error),
            rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }
        });
      }
      throw error;
    }
  }
  ensureSchema() {
    const currentVersion = this.getUserVersion();
    if (currentVersion !== 0 && !isSupportedSchemaVersion(currentVersion)) {
      throw new AgentLoopError(
        "storage_schema_mismatch",
        `SQLite schema version ${currentVersion} is not supported.`,
        { details: { expected: STORAGE_SCHEMA_VERSION, actual: currentVersion } }
      );
    }
    if (currentVersion === STORAGE_SCHEMA_VERSION) {
      if (this.mode !== "ro") {
        this.transaction(() => this.reconcileHighFidelityWorkerEventsV8());
      }
      return;
    }
    if (this.mode === "ro") {
      throw new AgentLoopError(
        "storage_schema_mismatch",
        `SQLite schema version ${currentVersion} requires migration before read-only use.`,
        { details: { expected: STORAGE_SCHEMA_VERSION, actual: currentVersion } }
      );
    }
    this.transaction(() => {
      const lockedVersion = this.getUserVersion();
      if (lockedVersion === STORAGE_SCHEMA_VERSION) {
        return;
      }
      if (lockedVersion !== 0 && !isSupportedSchemaVersion(lockedVersion)) {
        throw new AgentLoopError(
          "storage_schema_mismatch",
          `SQLite schema version ${lockedVersion} is not supported.`,
          { details: { expected: STORAGE_SCHEMA_VERSION, actual: lockedVersion } }
        );
      }
      this.db.exec(SCHEMA_SQL);
      this.migratePrC();
      this.migratePrD();
      this.migratePrE();
      this.migrateF0();
      this.migrateTimelineV7();
      this.migrateHighFidelityWorkerEventsV8();
      this.markSchemaVersion();
    });
  }
  migratePrC() {
    addColumnIfMissing(this.db, "runs", "current_state", "text");
    addColumnIfMissing(this.db, "runs", "branch", "text");
    addColumnIfMissing(this.db, "runs", "worktree_clean", "integer");
    addColumnIfMissing(this.db, "runs", "started_at", "text");
    addColumnIfMissing(this.db, "runs", "stopped_at", "text");
    addColumnIfMissing(this.db, "states", "state", "text");
    addColumnIfMissing(this.db, "states", "payload_json", "text");
    addColumnIfMissing(this.db, "events", "state_before", "text");
    addColumnIfMissing(this.db, "events", "state_after", "text");
    addColumnIfMissing(this.db, "events", "artifact_ids_json", "text");
    addColumnIfMissing(this.db, "artifacts", "name", "text");
    addColumnIfMissing(this.db, "artifacts", "sha256", "text");
    this.db.exec(PR_C_TABLES_SQL);
  }
  migratePrD() {
    this.db.exec(PR_D_TABLES_SQL);
  }
  migratePrE() {
    addColumnIfMissing(this.db, "gates", "decision_note", "text");
    addColumnIfMissing(this.db, "gates", "decided_at", "text");
    this.db.exec(PR_E_TABLES_SQL);
    this.db.exec(PR_E_INDEXES_SQL);
  }
  migrateF0() {
    rebuildEventsWithSeq(this.db);
    rebuildWorkerEventsWithSeq(this.db);
  }
  migrateTimelineV7() {
    this.db.exec(TIMELINE_INDEX_SQL);
    this.db.exec(TIMELINE_TRIGGERS_SQL);
    backfillTimelineIndex(this.db);
  }
  migrateHighFidelityWorkerEventsV8() {
    addColumnIfMissing(this.db, "worker_events", "item_id", "text");
    addColumnIfMissing(this.db, "worker_events", "item_status", "text");
    addColumnIfMissing(this.db, "worker_events", "thread_id", "text");
    addColumnIfMissing(this.db, "worker_events", "backend", "text");
    addColumnIfMissing(this.db, "worker_events", "artifact_ids_json", "text");
    this.reconcileHighFidelityWorkerEventsV8();
  }
  reconcileHighFidelityWorkerEventsV8() {
    dedupeHighFidelityWorkerEventsV8(this.db);
    this.db.exec(`
      drop index if exists worker_events_thread_item_unique;
      create unique index if not exists worker_events_thread_item_status_unique
        on worker_events(thread_id, item_id, coalesce(item_status, ''))
        where item_id is not null;
      create unique index if not exists worker_events_thread_event_unique
        on worker_events(thread_id, event_type)
        where item_id is null;
    `);
  }
  markSchemaVersion() {
    this.db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
  }
  ensureRepoConfigVersion() {
    this.validateRepoConfigVersion(true);
  }
  validateRepoConfigVersion(rewrite = false) {
    let row;
    try {
      row = this.db.prepare("select schema_version, config_json from repo_config where id = 1").get();
    } catch (error) {
      throw toStorageError(error, "Could not read stored repo config metadata.");
    }
    if (!row) {
      return;
    }
    if (!isSupportedSchemaVersion(row.schema_version)) {
      throw new AgentLoopError(
        "storage_schema_mismatch",
        `Stored repo config schema version ${row.schema_version} is not supported.`,
        { details: { expected: STORAGE_SCHEMA_VERSION, actual: row.schema_version } }
      );
    }
    const parsed = parseJson(row.config_json, "Stored repo config snapshot JSON is invalid.");
    if (parsed.schemaVersion === STORAGE_SCHEMA_VERSION) {
      return;
    }
    if (rewrite && isSupportedSchemaVersion(parsed.schemaVersion ?? 0) && typeof parsed.repoId === "string") {
      this.writeRepoConfig(withConfigDefaults(parsed));
      return;
    }
    throw new AgentLoopError("storage_error", "Stored repo config snapshot schemaVersion is invalid.", {
      details: { expected: STORAGE_SCHEMA_VERSION, actual: parsed.schemaVersion }
    });
  }
  getUserVersion() {
    const row = this.db.prepare("PRAGMA user_version").get();
    return row.user_version;
  }
  getRun(runId) {
    const row = this.db.prepare(
      `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         where id = ?`
    ).get(runId);
    return row ? fromRunRow(row) : void 0;
  }
  getActiveRun() {
    const row = this.db.prepare(
      `select id, status, current_state, version, branch, worktree_clean, started_at, stopped_at, created_at, updated_at
         from runs
         where status = 'RUNNING'
         order by updated_at desc
         limit 1`
    ).get();
    return row ? fromRunRow(row) : void 0;
  }
  getWorker(workerId) {
    const row = this.db.prepare(
      `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
         from workers
         where id = ?`
    ).get(workerId);
    if (!row) {
      throw new AgentLoopError("storage_error", `Worker not found: ${workerId}`);
    }
    return fromWorkerRow(row);
  }
  timelineEntry(row) {
    if (!isTimelineSource(row.source)) {
      return void 0;
    }
    if (row.source === "event") {
      const sourceRow2 = this.db.prepare(
        `select seq, id, run_id, kind, message, artifact_ids_json, created_at
           from events where id = ?`
      ).get(row.source_id);
      if (!sourceRow2) return void 0;
      const artifactIds = sourceRow2.artifact_ids_json ? parseJson(sourceRow2.artifact_ids_json, "Stored event artifact list JSON is invalid.") : void 0;
      return timelineEntry(row, {
        kind: sourceRow2.kind,
        title: sourceRow2.kind,
        summary: sourceRow2.message,
        ...sourceRow2.run_id ? { runId: sourceRow2.run_id } : {},
        ...artifactIds ? { artifactIds } : {},
        rawRef: { table: "events", id: sourceRow2.id, seq: sourceRow2.seq }
      });
    }
    if (row.source === "worker_event") {
      const sourceRow2 = this.db.prepare(
        `select seq, id, worker_id, run_id, event_type, item_type, item_id, item_status,
                  thread_id, backend, summary_json, usage_json, artifact_ids_json, created_at
           from worker_events where id = ?`
      ).get(row.source_id);
      if (!sourceRow2) return void 0;
      const worker = this.db.prepare("select thread_id from workers where id = ?").get(sourceRow2.worker_id);
      const summary = sourceRow2.summary_json ? summarizeTimelinePayload(parseJson(sourceRow2.summary_json, "Stored worker event summary JSON is invalid.")) : sourceRow2.event_type;
      const artifactIds = sourceRow2.artifact_ids_json ? parseJson(sourceRow2.artifact_ids_json, "Stored worker event artifact list JSON is invalid.") : void 0;
      return timelineEntry(row, {
        kind: sourceRow2.item_type ?? sourceRow2.event_type,
        title: workerEventTimelineTitle(sourceRow2),
        summary,
        runId: sourceRow2.run_id,
        workerId: sourceRow2.worker_id,
        ...sourceRow2.thread_id ? { threadId: sourceRow2.thread_id } : worker?.thread_id ? { threadId: worker.thread_id } : {},
        ...sourceRow2.item_status ? { status: sourceRow2.item_status } : {},
        ...artifactIds?.length ? { artifactIds } : {},
        rawRef: { table: "worker_events", id: sourceRow2.id, seq: sourceRow2.seq }
      });
    }
    if (row.source === "worker") {
      const sourceRow2 = this.db.prepare(
        `select id, run_id, type, backend, status, thread_id, attempt, resume_used,
                  started_at, completed_at, exit_code, result_artifact_id, raw_jsonl_artifact_id, error
           from workers where id = ?`
      ).get(row.worker_id ?? workerIdFromSourceId(row.source_id));
      if (!sourceRow2) return void 0;
      const status = statusFromWorkerSourceId(row.source_id) ?? sourceRow2.status;
      return timelineEntry(row, {
        kind: sourceRow2.type,
        title: `${sourceRow2.type} worker ${status}`,
        summary: summarizeTimelinePayload({
          status,
          attempt: sourceRow2.attempt,
          backend: sourceRow2.backend,
          exitCode: sourceRow2.exit_code,
          error: sourceRow2.error
        }),
        runId: sourceRow2.run_id,
        workerId: sourceRow2.id,
        ...sourceRow2.thread_id ? { threadId: sourceRow2.thread_id } : {},
        status,
        artifactIds: [sourceRow2.result_artifact_id, sourceRow2.raw_jsonl_artifact_id].filter((id) => Boolean(id)),
        rawRef: { table: "workers", id: row.source_id }
      });
    }
    if (row.source === "state") {
      const sourceRow2 = this.db.prepare("select id, run_id, status, state, version, created_at from states where id = ?").get(Number(row.source_id));
      if (!sourceRow2) return void 0;
      return timelineEntry(row, {
        kind: sourceRow2.state ?? sourceRow2.status,
        title: "State changed",
        summary: summarizeTimelinePayload({ status: sourceRow2.status, state: sourceRow2.state, version: sourceRow2.version }),
        ...sourceRow2.run_id ? { runId: sourceRow2.run_id } : {},
        status: sourceRow2.status,
        rawRef: { table: "states", id: String(sourceRow2.id), seq: sourceRow2.id }
      });
    }
    if (row.source === "gate") {
      const sourceRow2 = this.db.prepare(
        `select id, run_id, kind, status, message, details_json, created_at,
                  resolved_at, decision_note, decided_at
           from gates where id = ?`
      ).get(row.source_id);
      if (!sourceRow2) return void 0;
      return timelineEntry(row, {
        kind: sourceRow2.kind,
        title: `Gate opened: ${sourceRow2.kind}`,
        summary: sourceRow2.message,
        ...sourceRow2.run_id ? { runId: sourceRow2.run_id } : {},
        status: sourceRow2.status,
        rawRef: { table: "gates", id: sourceRow2.id }
      });
    }
    if (row.source === "artifact") {
      const sourceRow2 = this.db.prepare("select id, run_id, kind, name, path, sha256, created_at from artifacts where id = ?").get(row.source_id);
      if (!sourceRow2) return void 0;
      return timelineEntry(row, {
        kind: sourceRow2.kind,
        title: `Artifact: ${sourceRow2.name ?? sourceRow2.id}`,
        summary: summarizeTimelinePayload({ name: sourceRow2.name ?? sourceRow2.id, kind: sourceRow2.kind, sha256: sourceRow2.sha256 }),
        runId: sourceRow2.run_id,
        artifactIds: [sourceRow2.id],
        rawRef: { table: "artifacts", id: sourceRow2.id }
      });
    }
    const sourceRow = this.db.prepare("select id, run_id, kind, message, created_at from decisions where id = ?").get(row.source_id);
    if (!sourceRow) return void 0;
    return timelineEntry(row, {
      kind: sourceRow.kind,
      title: sourceRow.kind,
      summary: sourceRow.message,
      runId: sourceRow.run_id,
      rawRef: { table: "decisions", id: sourceRow.id }
    });
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AgentLoopError("storage_error", "Transaction rollback failed.", {
          details: {
            cause: error instanceof Error ? error.message : String(error),
            rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }
        });
      }
      throw error;
    }
  }
};
function timelineEntry(row, entry) {
  return {
    timelineSeq: row.timeline_seq,
    occurredAt: row.created_at,
    cursor: encodeTimelineCursor(row.timeline_seq, row.created_at),
    source: row.source,
    kind: entry.kind,
    ...entry.runId ? { runId: entry.runId } : {},
    ...entry.workerId ? { workerId: entry.workerId } : {},
    ...entry.threadId ? { threadId: entry.threadId } : {},
    title: truncateTimelineText(redactTimelineText(entry.title), 160),
    summary: truncateTimelineText(redactTimelineText(entry.summary), 1e3),
    ...entry.status ? { status: entry.status } : {},
    ...entry.artifactIds?.length ? { artifactIds: entry.artifactIds } : {},
    createdAt: row.created_at,
    rawRef: entry.rawRef
  };
}
function backfillTimelineIndex(db) {
  db.exec(`
    insert or ignore into timeline_index (source, source_id, source_seq, run_id, worker_id, created_at)
    select source, source_id, source_seq, run_id, worker_id, created_at
    from (
      select 'event' as source, id as source_id, seq as source_seq, run_id, null as worker_id, created_at
        from events
      union all
      select 'worker_event' as source, id as source_id, seq as source_seq, run_id, worker_id, created_at
        from worker_events
      union all
      select 'worker' as source, id || ':' || status as source_id, null as source_seq, run_id, id as worker_id, started_at as created_at
        from workers
      union all
      select 'state' as source, cast(id as text) as source_id, id as source_seq, run_id, null as worker_id, created_at
        from states
      union all
      select 'gate' as source, id as source_id, null as source_seq, run_id, null as worker_id, created_at
        from gates
      union all
      select 'artifact' as source, id as source_id, null as source_seq, run_id, null as worker_id, created_at
        from artifacts
      union all
      select 'decision' as source, id as source_id, null as source_seq, run_id, null as worker_id, created_at
        from decisions
    )
    order by created_at asc, source asc, source_id asc;
  `);
}
function normalizeTimelineSources(sources) {
  const unique2 = [...new Set(sources)];
  if (unique2.some((source) => !isTimelineSource(source))) {
    throw new AgentLoopError("invalid_config", "Unsupported timeline source.", { details: { sources } });
  }
  return unique2;
}
function isTimelineSource(value) {
  return TIMELINE_SOURCES.includes(value);
}
function clampLimit(value) {
  if (!Number.isFinite(value)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 200);
}
function encodeTimelineCursor(timelineSeq, occurredAt) {
  return Buffer.from(JSON.stringify({ timelineSeq, ...occurredAt ? { occurredAt } : {} }), "utf8").toString("base64url");
}
function decodeTimelineCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const timelineSeq = parsed.timelineSeq;
      const occurredAt = parsed.occurredAt;
      if (typeof timelineSeq === "number" && Number.isInteger(timelineSeq) && timelineSeq > 0 && typeof occurredAt === "string" && occurredAt.length > 0) {
        return { timelineSeq, occurredAt };
      }
    }
  } catch {
  }
  throw new AgentLoopError("invalid_config", "Timeline cursor is invalid.");
}
function timelineMissingSourceRows(db) {
  const checks = [
    {
      source: "event",
      sql: `select count(*) as count
            from events source
            left join timeline_index ti on ti.source = 'event' and ti.source_id = source.id
            where ti.timeline_seq is null`
    },
    {
      source: "worker_event",
      sql: `select count(*) as count
            from worker_events source
            left join timeline_index ti on ti.source = 'worker_event' and ti.source_id = source.id
            where ti.timeline_seq is null`
    },
    {
      source: "worker",
      sql: `select count(*) as count
            from workers source
            left join timeline_index ti on ti.source = 'worker' and ti.source_id = source.id || ':' || source.status
            where ti.timeline_seq is null`
    },
    {
      source: "state",
      sql: `select count(*) as count
            from states source
            left join timeline_index ti on ti.source = 'state' and ti.source_id = cast(source.id as text)
            where ti.timeline_seq is null`
    },
    {
      source: "gate",
      sql: `select count(*) as count
            from gates source
            left join timeline_index ti on ti.source = 'gate' and ti.source_id = source.id
            where ti.timeline_seq is null`
    },
    {
      source: "artifact",
      sql: `select count(*) as count
            from artifacts source
            left join timeline_index ti on ti.source = 'artifact' and ti.source_id = source.id
            where ti.timeline_seq is null`
    },
    {
      source: "decision",
      sql: `select count(*) as count
            from decisions source
            left join timeline_index ti on ti.source = 'decision' and ti.source_id = source.id
            where ti.timeline_seq is null`
    }
  ];
  return checks.flatMap((check) => {
    const row = db.prepare(check.sql).get();
    const missing = row?.count ?? 0;
    return missing > 0 ? [{ source: check.source, missing }] : [];
  });
}
function summarizeTimelinePayload(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === void 0 || value === null) {
    return "";
  }
  return JSON.stringify(redactTimelineValue(value));
}
function redactTimelineValue(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactTimelineValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const redacted = {};
  for (const [key, nested] of Object.entries(value).slice(0, 40)) {
    redacted[key] = isSecretKey(key) ? "[redacted]" : redactTimelineValue(nested);
  }
  return redacted;
}
function redactTimelineText(value) {
  return redactSecrets(value);
}
function truncateTimelineText(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
function statusFromWorkerSourceId(sourceId) {
  const status = sourceId.split(":").at(-1);
  return status && ["running", "succeeded", "failed", "timed_out", "invalid_output"].includes(status) ? status : void 0;
}
function workerIdFromSourceId(sourceId) {
  return sourceId.split(":")[0] ?? sourceId;
}
function fromRunRow(row) {
  return {
    id: row.id,
    status: row.status,
    ...row.current_state ? { currentState: row.current_state } : {},
    version: row.version,
    ...row.branch ? { branch: row.branch } : {},
    ...row.worktree_clean !== null ? { worktreeClean: row.worktree_clean === 1 } : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...row.started_at ? { startedAt: row.started_at } : {},
    ...row.stopped_at ? { stoppedAt: row.stopped_at } : {}
  };
}
function fromEventRow(row) {
  return {
    id: row.id,
    seq: row.seq,
    ...row.run_id ? { runId: row.run_id } : {},
    kind: row.kind,
    message: row.message,
    ...row.state_before ? { stateBefore: row.state_before } : {},
    ...row.state_after ? { stateAfter: row.state_after } : {},
    ...row.payload_json ? { payload: parseJson(row.payload_json, "Stored event payload JSON is invalid.") } : {},
    ...row.artifact_ids_json ? { artifactIds: parseJson(row.artifact_ids_json, "Stored event artifact list JSON is invalid.") } : {},
    createdAt: row.created_at
  };
}
function statusGateFromRow(row) {
  return {
    kind: row.kind,
    message: row.message,
    ...row.details_json ? { details: parseJson(row.details_json, "Stored gate details JSON is invalid.") } : {}
  };
}
function latestGateSatisfied(db, runId) {
  const row = db.prepare(
    `select status
       from gates
       where run_id = ?
       order by created_at desc
       limit 1`
  ).get(runId);
  return row?.status === "approved" || row?.status === "resolved";
}
function fromGateRow(row) {
  return {
    id: row.id,
    ...row.run_id ? { runId: row.run_id } : {},
    kind: row.kind,
    status: row.status,
    message: row.message,
    ...row.details_json ? { details: parseJson(row.details_json, "Stored gate details JSON is invalid.") } : {},
    createdAt: row.created_at,
    ...row.resolved_at ? { resolvedAt: row.resolved_at } : {},
    ...row.decision_note ? { decisionNote: row.decision_note } : {},
    ...row.decided_at ? { decidedAt: row.decided_at } : {}
  };
}
function fromArtifactRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    name: row.name ?? row.id,
    path: row.path,
    sha256: row.sha256 ?? "",
    createdAt: row.created_at
  };
}
function fromPrLinkRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    branch: row.branch,
    prNumber: row.pr_number,
    url: row.url,
    headRef: row.head_ref,
    baseRef: row.base_ref,
    state: row.state,
    draft: row.draft === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function fromCiCheckRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    prNumber: row.pr_number,
    name: row.name,
    status: row.status,
    ...row.conclusion ? { conclusion: row.conclusion } : {},
    ...row.url ? { url: row.url } : {},
    ...row.started_at ? { startedAt: row.started_at } : {},
    ...row.completed_at ? { completedAt: row.completed_at } : {},
    observedAt: row.observed_at
  };
}
function fromReviewCommentRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    prNumber: row.pr_number,
    commentId: row.comment_id,
    url: row.url,
    author: row.author,
    body: row.body,
    path: row.path,
    ...row.line === null ? {} : { line: row.line },
    diffHunk: row.diff_hunk,
    isResolved: row.is_resolved === 1,
    isOutdated: row.is_outdated === 1,
    actionable: row.actionable === 1,
    status: row.status,
    observedAt: row.observed_at
  };
}
function fromDecisionRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    message: row.message,
    ...row.details_json ? { details: parseJson(row.details_json, "Stored decision details JSON is invalid.") } : {},
    createdAt: row.created_at
  };
}
function fromRunCheckRow(row) {
  return {
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    ...row.details_json ? { details: JSON.parse(row.details_json) } : {},
    createdAt: row.created_at
  };
}
function fromWorkerRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    backend: row.backend,
    status: row.status,
    ...row.thread_id ? { threadId: row.thread_id } : {},
    attempt: row.attempt,
    resumeUsed: row.resume_used === 1,
    startedAt: row.started_at,
    ...row.completed_at ? { completedAt: row.completed_at } : {},
    ...row.exit_code === null ? {} : { exitCode: row.exit_code },
    ...row.result_artifact_id ? { resultArtifactId: row.result_artifact_id } : {},
    ...row.raw_jsonl_artifact_id ? { rawJsonlArtifactId: row.raw_jsonl_artifact_id } : {},
    ...row.error ? { error: row.error } : {}
  };
}
function fromWorkerEventRow(row) {
  return {
    id: row.id,
    seq: row.seq,
    workerId: row.worker_id,
    runId: row.run_id,
    eventType: row.event_type,
    ...row.item_type ? { itemType: row.item_type } : {},
    ...row.item_id ? { itemId: row.item_id } : {},
    ...row.item_status ? { itemStatus: row.item_status } : {},
    ...row.thread_id ? { threadId: row.thread_id } : {},
    ...row.backend ? { backend: row.backend } : {},
    ...row.summary_json ? { summary: parseJson(row.summary_json, "Stored worker event summary JSON is invalid.") } : {},
    ...row.usage_json ? { usage: parseJson(row.usage_json, "Stored worker event usage JSON is invalid.") } : {},
    ...row.artifact_ids_json ? { artifactIds: parseJson(row.artifact_ids_json, "Stored worker event artifact list JSON is invalid.") } : {},
    createdAt: row.created_at
  };
}
function workerEventTimelineTitle(row) {
  const item = row.item_type ?? row.event_type;
  return row.item_status ? `${row.item_status} ${item}` : item;
}
function isSupportedSchemaVersion(value) {
  return SUPPORTED_SCHEMA_VERSIONS.includes(value);
}
function rebuildEventsWithSeq(db) {
  if (hasColumn(db, "events", "seq")) {
    return;
  }
  db.exec(`
    alter table events rename to events_legacy_v6;
    create table events (
      seq integer primary key autoincrement,
      id text not null unique,
      run_id text,
      kind text not null,
      message text not null,
      state_before text,
      state_after text,
      payload_json text,
      artifact_ids_json text,
      created_at text not null,
      foreign key(run_id) references runs(id)
    );
    insert into events (
      id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
    )
    select id, run_id, kind, message, state_before, state_after, payload_json, artifact_ids_json, created_at
      from events_legacy_v6
      order by created_at asc, id asc;
    drop table events_legacy_v6;
  `);
}
function rebuildWorkerEventsWithSeq(db) {
  if (hasColumn(db, "worker_events", "seq")) {
    return;
  }
  db.exec(`
    alter table worker_events rename to worker_events_legacy_v6;
    create table worker_events (
      seq integer primary key autoincrement,
      id text not null unique,
      worker_id text not null,
      run_id text not null,
      event_type text not null,
      item_type text,
      summary_json text,
      usage_json text,
      created_at text not null,
      foreign key(worker_id) references workers(id),
      foreign key(run_id) references runs(id)
    );
    insert into worker_events (
      id, worker_id, run_id, event_type, item_type, summary_json, usage_json, created_at
    )
    select id, worker_id, run_id, event_type, item_type, summary_json, usage_json, created_at
      from worker_events_legacy_v6
      order by created_at asc, id asc;
    drop table worker_events_legacy_v6;
  `);
}
function dedupeHighFidelityWorkerEventsV8(db) {
  db.exec(`
    create temp table if not exists worker_event_dedupe_ids (
      id text primary key
    );
    delete from worker_event_dedupe_ids;
    insert or ignore into worker_event_dedupe_ids (id)
    select id from (
      select id from (
        select id,
               seq,
               row_number() over (
                 partition by thread_id, item_id, coalesce(item_status, '')
                 order by seq asc
               ) as duplicate_rank
        from worker_events
        where thread_id is not null and item_id is not null
      )
      where duplicate_rank > 1
    );
    insert or ignore into worker_event_dedupe_ids (id)
    select id from (
      select id from (
        select id,
               seq,
               row_number() over (
                 partition by thread_id, event_type
                 order by seq asc
               ) as duplicate_rank
        from worker_events
        where thread_id is not null and item_id is null
      )
      where duplicate_rank > 1
    );
    delete from timeline_index
    where source = 'worker_event'
      and source_id in (select id from worker_event_dedupe_ids);
    delete from worker_events
    where id in (select id from worker_event_dedupe_ids);
    delete from worker_event_dedupe_ids;
  `);
}
function hasColumn(db, tableName, columnName) {
  validateSqlIdentifier(tableName);
  validateSqlIdentifier(columnName);
  const columns = db.prepare(`pragma table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}
function hasTable(db, tableName) {
  validateSqlIdentifier(tableName);
  const row = db.prepare("select 1 from sqlite_master where type = 'table' and name = ? limit 1").get(tableName);
  return row !== void 0;
}
function boolToDb(value) {
  if (value === void 0) {
    return null;
  }
  return value ? 1 : 0;
}
function addColumnIfMissing(db, tableName, columnName, definition) {
  validateSqlIdentifier(tableName);
  validateSqlIdentifier(columnName);
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`alter table ${tableName} add column ${columnName} ${definition}`);
  }
}
function validateSqlIdentifier(value) {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new AgentLoopError("storage_error", `Unsafe SQLite identifier: ${value}`);
  }
}
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function parseJson(value, message) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new AgentLoopError("storage_error", message, {
      details: { cause: error instanceof Error ? error.message : String(error) }
    });
  }
}
function isUniqueConstraintError(error) {
  return error instanceof Error && /unique constraint/i.test(error.message);
}
function toStorageError(error, message) {
  if (error instanceof AgentLoopError) {
    return error;
  }
  return new AgentLoopError("storage_error", message, {
    details: { cause: error instanceof Error ? error.message : String(error) }
  });
}

// plugins/autonomous-pr-loop/core/config-editor.ts
function readConfigForEdit(repoRoot) {
  const loaded = loadConfig(repoRoot);
  const raw = readFileSync4(loaded.path, "utf8");
  return {
    path: loaded.path,
    hash: sha2562(raw),
    mtimeMs: statSync(loaded.path).mtimeMs,
    config: loaded.config
  };
}
function diffConfig(before, after) {
  return Object.keys({ ...before, ...after }).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])).map((field) => ({
    field,
    before: before[field],
    after: after[field],
    risk: highRiskFields.has(field) ? "high" : "low"
  }));
}
function saveConfigEdit(repoRoot, input) {
  const snapshot = readConfigForEdit(repoRoot);
  if (snapshot.hash !== input.expectedHash) {
    throw new AgentLoopError("invalid_config", "Config changed on disk; reload before saving.");
  }
  const config = validateConfig(input.nextConfig);
  const diff = diffConfig(snapshot.config, config);
  assertPolicySaveAllowed(diff, config, input.note, input.confirmationToken);
  writeFileSync2(configPath(repoRoot), `${JSON.stringify(config, null, 2)}
`);
  auditConfigSave(repoRoot, diff, input.note);
  return { config, diff, snapshot: readConfigForEdit(repoRoot) };
}
function assertPolicySaveAllowed(diff, config, note, confirmationToken) {
  const hasHighRisk = diff.some((entry) => entry.risk === "high");
  if (hasHighRisk && !note?.trim()) {
    throw new AgentLoopError("invalid_config", "High-risk policy changes require an operator note.");
  }
  if (requiresExplicitConfirmation(diff) && confirmationToken?.trim() !== "CONFIRM") {
    throw new AgentLoopError("invalid_config", "Dangerous policy changes require confirmation token CONFIRM.");
  }
  if (!config.gitnexusRequired && !note?.trim()) {
    throw new AgentLoopError("invalid_config", "Disabling GitNexus required needs a note.");
  }
  if (config.reviewHandling === "fix_scoped_and_carry_forward" && !config.carryoverTarget?.trim()) {
    throw new AgentLoopError("invalid_config", "Carryover review handling requires a carryover target.");
  }
}
function requiresExplicitConfirmation(diff) {
  return diff.some(
    (entry) => entry.field === "mergeMode" && entry.after === "conditional" || entry.field === "requireReviewApproval" && entry.after === false
  );
}
function auditConfigSave(repoRoot, diff, note) {
  if (!existsSync5(statePath(repoRoot))) {
    return;
  }
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    storage.writeRepoConfig(loadConfig(repoRoot).config);
    const run = storage.getCurrentRun();
    const message = `Dashboard config changed ${diff.length} field(s).`;
    storage.appendEvent({
      ...run ? { runId: run.id } : {},
      kind: "config_changed",
      message,
      payload: { diff, note: note ?? "" }
    });
    if (run) {
      storage.appendDecision({
        runId: run.id,
        kind: "config_changed",
        message,
        details: { diff, note: note ?? "" }
      });
    }
  } finally {
    storage.close();
  }
}
function sha2562(value) {
  return createHash2("sha256").update(value).digest("hex");
}
var highRiskFields = /* @__PURE__ */ new Set([
  "mergeMode",
  "requireReviewApproval",
  "gitnexusRequired",
  "protectedPaths",
  "reviewHandling",
  "carryoverTarget"
]);

// plugins/autonomous-pr-loop/core/gate-recovery.ts
var TERMINAL_WORKER_GATE_KINDS = [
  "worker_failed",
  "worker_output_invalid",
  "worker_timeout"
];
var WORKER_FAILURE_RECOVERED_DECISION = "worker_failure_recovered";
function recoverSatisfiedRepoGates(repoRoot, source = "cli") {
  loadConfig(repoRoot);
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const before = storage.listGates().filter(
      (gate) => gate.kind === "needs_repo_init" && gate.status === "open" && gate.runId === void 0
    );
    storage.resolveOpenGatesByKind("needs_repo_init", { scope: "repo" });
    const after = storage.listGates().filter(
      (gate) => gate.kind === "needs_repo_init" && gate.status === "open" && gate.runId === void 0
    );
    const recovered = before.length - after.length;
    if (recovered > 0) {
      const gateIds = before.slice(0, recovered).map((gate) => gate.id);
      const payload = {
        source,
        scope: "repo",
        kind: "needs_repo_init",
        recovered,
        gateIds,
        reason: "config_exists_and_valid"
      };
      storage.appendEvent({
        kind: "gate_recovery",
        message: "Recovered repo-level needs_repo_init gate after config became valid.",
        payload
      });
      const run = storage.getCurrentRun();
      if (run) {
        storage.appendDecision({
          runId: run.id,
          kind: "gate_recovery",
          message: "Explicit recovery resolved repo-level needs_repo_init gate.",
          details: payload
        });
      }
    }
    return { ok: true, recovered, scope: "repo", kind: "needs_repo_init", warnings: [] };
  } finally {
    storage.close();
  }
}
function recoverTerminalWorkerGate(storage, source = "cli") {
  const empty = { recovered: 0, gateKinds: [], gateIds: [], workerIds: [] };
  const run = storage.getCurrentRun();
  if (!run || run.status === "STOPPED") {
    return empty;
  }
  const openWorkerGates = storage.listGates(run.id).filter((gate) => gate.status === "open" && TERMINAL_WORKER_GATE_KINDS.includes(gate.kind));
  if (openWorkerGates.length === 0) {
    return { ...empty, runId: run.id };
  }
  const gateKinds = [...new Set(openWorkerGates.map((gate) => gate.kind))];
  const gateIds = openWorkerGates.map((gate) => gate.id);
  const workerIds = [...new Set(openWorkerGates.map((gate) => gateWorkerId(gate.details)).filter((id) => Boolean(id)))];
  for (const kind of gateKinds) {
    storage.resolveOpenGatesByKind(kind, { scope: "run", runId: run.id });
  }
  const payload = {
    source,
    scope: "run",
    reason: "operator_marked_obsolete",
    gateKinds,
    gateIds,
    workerIds,
    runId: run.id
  };
  storage.appendEvent({
    runId: run.id,
    kind: "gate_recovery",
    message: "Recovered active terminal-worker gate; resume will re-attempt the worker.",
    payload
  });
  storage.appendDecision({
    runId: run.id,
    kind: WORKER_FAILURE_RECOVERED_DECISION,
    message: "Operator marked the active worker failure obsolete and cleared the gate for resume.",
    details: payload
  });
  if (run.status === "BLOCKED") {
    storage.updateRunStatus(run.id, run.version, "RUNNING", run.currentState ? { currentState: run.currentState } : {});
  }
  return { recovered: openWorkerGates.length, runId: run.id, gateKinds, gateIds, workerIds };
}
function gateWorkerId(details) {
  if (!isRecord(details)) return void 0;
  return typeof details.workerId === "string" ? details.workerId : void 0;
}
function recoverBlockedRun(repoRoot, source = "cli") {
  loadConfig(repoRoot);
  const repoResult = recoverSatisfiedRepoGates(repoRoot, source);
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const worker = recoverTerminalWorkerGate(storage, source);
    return {
      ok: true,
      recovered: repoResult.recovered + worker.recovered,
      repo: { recovered: repoResult.recovered, kind: "needs_repo_init" },
      worker,
      warnings: repoResult.warnings
    };
  } finally {
    storage.close();
  }
}

// plugins/autonomous-pr-loop/core/happy.ts
import { execFileSync as execFileSync2 } from "node:child_process";
function detectHappy() {
  const help = runHappyHelp(["--help"]);
  if (!help.ok) {
    return { installed: false, supportsNotify: false };
  }
  const notify = runHappyHelp(["notify", "--help"]);
  const versionText = firstLine(help.output);
  return {
    installed: true,
    ...versionText ? { versionText } : {},
    supportsNotify: notify.ok
  };
}
function runHappyHelp(args) {
  try {
    return {
      ok: true,
      output: execFileSync2("happy", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 2e3
      }).trim()
    };
  } catch {
    return { ok: false, output: "" };
  }
}
function firstLine(value) {
  const line = value.split(/\r?\n/).find((item) => item.trim().length > 0)?.trim();
  return line ? line.slice(0, 200) : void 0;
}

// plugins/autonomous-pr-loop/core/hook-capture.ts
import { existsSync as existsSync7 } from "node:fs";

// plugins/autonomous-pr-loop/core/hook-router.ts
import { createHash as createHash3, randomUUID as randomUUID3 } from "node:crypto";
import { closeSync, existsSync as existsSync6, mkdirSync as mkdirSync3, openSync, readFileSync as readFileSync5, realpathSync as realpathSync2, renameSync, rmSync, statSync as statSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname3, isAbsolute, join as join4, resolve as resolve2 } from "node:path";
function hookRegistryPath(codexHome = codexHomePath()) {
  return join4(codexHome, "agent-loop", "hook-bindings.json");
}
function codexHomePath() {
  return process.env.CODEX_HOME ?? join4(homedir(), ".codex");
}
function listHookBindings(codexHome = codexHomePath()) {
  return readRegistry(codexHome).bindings;
}
function readRegistry(codexHome) {
  const path = hookRegistryPath(codexHome);
  if (!existsSync6(path)) {
    return { version: 1, bindings: [] };
  }
  const parsed = JSON.parse(readFileSync5(path, "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
    throw new Error(`Invalid hook binding registry: expected { version: 1, bindings: [...] } in ${path}`);
  }
  const bindings = parsed.bindings.map(parseBinding);
  const invalid = bindings.findIndex((binding) => binding === void 0);
  if (invalid >= 0) {
    throw new Error(`Invalid hook binding registry: invalid binding at index ${invalid} in ${path}`);
  }
  return {
    version: 1,
    bindings: bindings.filter((binding) => binding !== void 0)
  };
}
function parseBinding(value) {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.repoRoot !== "string" || typeof value.worktreeRoot !== "string") {
    return void 0;
  }
  const status = value.status === "stale" || value.status === "disabled" ? value.status : "active";
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return void 0;
  }
  return {
    id: value.id,
    repoRoot: value.repoRoot,
    worktreeRoot: value.worktreeRoot,
    ...typeof value.gitCommonDir === "string" ? { gitCommonDir: value.gitCommonDir } : {},
    ...typeof value.branch === "string" ? { branch: value.branch } : {},
    ...typeof value.runId === "string" ? { runId: value.runId } : {},
    ...typeof value.sessionIdHash === "string" ? { sessionIdHash: value.sessionIdHash } : typeof value.sessionId === "string" ? { sessionIdHash: sha2563(value.sessionId) } : {},
    ...typeof value.transcriptPathSha256 === "string" ? { transcriptPathSha256: value.transcriptPathSha256 } : {},
    status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...typeof value.lastSeenAt === "string" ? { lastSeenAt: value.lastSeenAt } : {}
  };
}
function sha2563(value) {
  return createHash3("sha256").update(value).digest("hex");
}

// plugins/autonomous-pr-loop/core/hook-capture.ts
var RECENT_CAPTURE_MS = 5 * 60 * 1e3;
function inspectHookCapture(repoRoot, codexHome = codexHomePath()) {
  let bindings;
  try {
    bindings = listHookBindings(codexHome);
  } catch (error) {
    return unavailable(`Hook binding registry could not be read: ${errorMessage(error)}`);
  }
  const active = bindings.filter((binding2) => binding2.status === "active");
  const current = active.filter((binding2) => binding2.repoRoot === repoRoot);
  if (current.length === 0) {
    return {
      status: "unavailable",
      reason: "No active hook binding exists for this repo.",
      currentRepoBindings: 0,
      sessionScopedBindings: 0,
      activeBindings: active.length
    };
  }
  if (current.length > 1) {
    return {
      status: "ambiguous",
      reason: "Multiple active hook bindings exist for this repo.",
      currentRepoBindings: current.length,
      sessionScopedBindings: current.filter((binding2) => binding2.sessionIdHash).length,
      activeBindings: active.length
    };
  }
  const binding = current[0];
  const hookEvent = latestHookEvent(repoRoot, binding.runId);
  const hookEventRecent = hookEvent ? Date.now() - Date.parse(hookEvent.createdAt) <= RECENT_CAPTURE_MS : false;
  const base = {
    currentRepoBindings: current.length,
    sessionScopedBindings: current.filter((item) => item.sessionIdHash).length,
    activeBindings: active.length,
    ...binding.lastSeenAt ? { lastSeenAt: binding.lastSeenAt } : {},
    ...hookEvent ? { latestHookEventAt: hookEvent.createdAt, latestHookEventKind: hookEvent.kind } : {},
    ...binding.runId ? { runId: binding.runId } : {}
  };
  if (hookEventRecent) {
    return {
      status: "captured",
      reason: "Recent hook event was captured for this repo.",
      ...base
    };
  }
  if (hookEvent) {
    return {
      status: "stale",
      reason: "Hook events were captured before, but not recently.",
      ...base
    };
  }
  if (binding.lastSeenAt) {
    return {
      status: "not_seen",
      reason: "Hook routing matched this repo, but no hook event has been captured.",
      ...base
    };
  }
  return {
    status: "not_seen",
    reason: "Hook router is installed, but this repo binding has not observed the current Codex session.",
    ...base
  };
}
function latestHookEvent(repoRoot, runId) {
  const path = statePath(repoRoot);
  if (!existsSync7(path)) return void 0;
  const storage = new SqliteAgentLoopStorage(path, { mode: "ro" });
  try {
    return storage.listEvents(1e3).filter((event) => event.kind.startsWith("hook_") && (!runId || event.runId === runId)).map((event) => ({ kind: event.kind, createdAt: event.createdAt })).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  } finally {
    storage.close();
  }
}
function unavailable(reason) {
  return {
    status: "unavailable",
    reason,
    currentRepoBindings: 0,
    sessionScopedBindings: 0,
    activeBindings: 0
  };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// plugins/autonomous-pr-loop/core/notification-feed.ts
function deriveNotifications(input) {
  const readIds = /* @__PURE__ */ new Set([
    ...notificationReadIds(input.events),
    ...notificationDismissedIds(input.events),
    ...input.dismissedIds ?? []
  ]);
  const gateNotifications = input.gates.filter((gate) => gate.status === "open").map((gate) => ({
    id: `gate:${gate.id}`,
    severity: severityForGate(gate.kind),
    title: gate.kind,
    reason: reasonForGate(gate.kind),
    source: "gate",
    sourceId: gate.id,
    createdAt: gate.createdAt,
    payload: redactPayload(gate.details)
  }));
  const eventNotifications = input.events.map((event) => notificationForEvent(event)).filter((item) => item !== void 0);
  const timelineNotifications = timelineDerivedNotifications(input.timelineEntries ?? [], input.workers ?? [], input.now ?? /* @__PURE__ */ new Date());
  const mergeRunId = input.runId ?? currentRunId(input.workers);
  const mergeNotifications = input.mergeReadiness?.ready && mergeRunId ? [mergeReadyNotification(mergeRunId, input.mergeReadiness, input.now ?? /* @__PURE__ */ new Date())] : [];
  return [...gateNotifications, ...eventNotifications, ...timelineNotifications, ...mergeNotifications].filter((notification) => !readIds.has(notification.id)).filter((notification) => isVisibleForMode(input.config.notifyMode, notification.severity)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function notificationReadIds(events) {
  return notificationIdsForKind(events, "notification_marked_read");
}
function notificationDismissedIds(events) {
  return notificationIdsForKind(events, "notification_dismissed");
}
function notificationIdsForKind(events, kind) {
  const ids = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.kind !== kind || !isRecord(event.payload)) {
      continue;
    }
    const notificationIds = event.payload.notificationIds;
    if (Array.isArray(notificationIds)) {
      for (const id of notificationIds) {
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  return ids;
}
function notificationForEvent(event) {
  const severity = severityForEvent(event.kind);
  if (!severity) {
    return void 0;
  }
  return {
    id: `event:${event.id}`,
    severity,
    title: event.kind,
    reason: reasonForEvent(event.kind, severity),
    source: "event",
    sourceId: event.id,
    createdAt: event.createdAt,
    payload: redactPayload(event.payload)
  };
}
function timelineDerivedNotifications(entries, workers, now2) {
  const notifications = [];
  const workerStatuses = new Map(workers.map((worker) => [worker.id, worker.status]));
  for (const worker of workers) {
    if (worker.status === "failed" || worker.status === "timed_out" || worker.status === "invalid_output") {
      notifications.push({
        id: `worker:${worker.id}:${worker.status}`,
        severity: "attention",
        title: worker.status === "failed" ? "worker_failed" : `worker_${worker.status}`,
        reason: "A worker reached a terminal failure state.",
        source: "worker",
        sourceId: worker.id,
        createdAt: worker.completedAt ?? worker.startedAt,
        payload: redactPayload({ type: worker.type, error: worker.error })
      });
    }
  }
  for (const entry of entries) {
    if (isPermissionRequestEntry(entry)) {
      const workerId = entry.workerId ?? "unknown";
      const itemId = timelineItemId(entry);
      notifications.push({
        id: `permission:${workerId}:${itemId}`,
        severity: "confirmation_required",
        title: "permission_requested",
        reason: "A permission request is visible in the agent timeline.",
        source: "timeline",
        sourceId: entry.rawRef.id,
        createdAt: entry.occurredAt,
        payload: redactPayload({ title: entry.title, summary: entry.summary })
      });
    }
    if (entry.source === "worker_event" && entry.kind === "command_execution" && !isTerminalWorkerStatus(workerStatuses.get(entry.workerId ?? "")) && isLongRunningCommand(entry, now2)) {
      const workerId = entry.workerId ?? "unknown";
      const itemId = timelineItemId(entry);
      notifications.push({
        id: `longrunning:${workerId}:${itemId}`,
        severity: "attention",
        title: "long_running_command",
        reason: "A command has been running for more than 60 seconds without a terminal event.",
        source: "timeline",
        sourceId: entry.rawRef.id,
        createdAt: entry.occurredAt,
        payload: redactPayload({ title: entry.title, summary: entry.summary })
      });
    }
  }
  return notifications;
}
function isPermissionRequestEntry(entry) {
  return entry.kind === "PermissionRequest" || entry.kind === "permission_request" || entry.kind === "permission.requested" || entry.kind === "permission_requested";
}
function isTerminalWorkerStatus(status) {
  return status === "succeeded" || status === "failed" || status === "timed_out" || status === "invalid_output";
}
function mergeReadyNotification(runId, mergeReadiness, now2) {
  return {
    id: `mergeready:${runId}`,
    severity: "confirmation_required",
    title: "merge_ready",
    reason: "Merge readiness evidence is complete under the configured policy.",
    source: "merge",
    sourceId: runId,
    createdAt: now2.toISOString(),
    payload: redactPayload({ state: mergeReadiness.state, evidence: mergeReadiness.evidence })
  };
}
function currentRunId(workers) {
  return workers?.[0]?.runId;
}
function isLongRunningCommand(entry, now2) {
  if (entry.status && entry.status !== "started" && entry.status !== "running") {
    return false;
  }
  const summary = parseSummary(entry.summary);
  const startedAt = typeof summary?.startedAt === "string" ? summary.startedAt : entry.createdAt;
  const startedMs = Date.parse(startedAt);
  return !Number.isNaN(startedMs) && now2.getTime() - startedMs > 6e4;
}
function parseSummary(summary) {
  try {
    const parsed = JSON.parse(summary);
    return isRecord(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function timelineItemId(entry) {
  const summary = parseSummary(entry.summary);
  return typeof summary?.id === "string" && summary.id.length > 0 ? summary.id : entry.rawRef.id;
}
function redactPayload(value) {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactPayload);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, nested]) => [
    key,
    /token|api_key|authorization|password|secret/i.test(key) ? "[redacted]" : redactPayload(nested)
  ]));
}
function severityForGate(kind) {
  if (kind === "merge_requires_confirmation") return "confirmation_required";
  if (kind.includes("timeout") || kind.includes("policy") || kind.includes("unavailable")) return "blocked";
  if (kind.includes("ci") || kind.includes("review") || kind.includes("github")) return "attention";
  return "blocked";
}
function severityForEvent(kind) {
  if (kind.includes("merge_completed") || kind.includes("pr_merged")) return "informational";
  if (kind.includes("ci_failed") || kind.includes("review_arrived")) return "attention";
  if (kind.includes("worker") && (kind.includes("failed") || kind.includes("invalid"))) return "attention";
  if (kind.includes("loop_stopped")) return "informational";
  return void 0;
}
function isVisibleForMode(mode, severity) {
  if (mode === "blockers_only") {
    return severity === "blocked" || severity === "confirmation_required";
  }
  if (mode === "important_only") {
    return severity !== "informational";
  }
  return true;
}
function reasonForGate(kind) {
  if (kind === "merge_requires_confirmation") {
    return "Policy requires an explicit confirmation before the loop can continue.";
  }
  if (kind.includes("ci")) return "CI evidence is missing, pending, or failed.";
  if (kind.includes("review")) return "Review evidence needs attention before autonomous progress.";
  if (kind.includes("policy")) return "A policy guard blocked unsafe progress.";
  return "The loop cannot safely continue until this gate is resolved.";
}
function reasonForEvent(kind, severity) {
  if (severity === "informational") {
    return "Progress was recorded without requiring operator attention.";
  }
  if (kind.includes("worker")) return "A worker output or execution issue needs attention.";
  if (kind.includes("ci")) return "CI changed in a way that may affect loop progress.";
  return "This event may require operator attention under the current policy.";
}

// plugins/autonomous-pr-loop/core/pr-selector.ts
import { existsSync as existsSync9, readdirSync as readdirSync2 } from "node:fs";
import { basename as basename2, join as join6 } from "node:path";

// plugins/autonomous-pr-loop/core/github.ts
import { execFileSync as execFileSync3 } from "node:child_process";
var REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              id
              url
              body
              path
              line
              diffHunk
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}`;
async function listPullRequestsByHead(options, branch) {
  const stdout = await runGhJson(options, [
    "pr",
    "list",
    "--head",
    branch,
    "--json",
    "number,url,title,body,headRefName,baseRefName,state,isDraft,mergedAt"
  ]);
  return parseJson2(stdout, "Could not parse gh pr list output.");
}
function listPullRequests(options) {
  const stdout = runGh(options.repoRoot, [
    "pr",
    "list",
    "--state",
    "all",
    "--limit",
    "100",
    "--json",
    "number,url,title,body,headRefName,baseRefName,state,isDraft,mergedAt"
  ]);
  return parseJson2(stdout, "Could not parse gh pr list output.");
}
async function viewPullRequest(options, prNumber) {
  const stdout = await runGhJson(options, [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,url,headRefName,baseRefName,state,isDraft,mergedAt,reviewDecision,statusCheckRollup"
  ]);
  return parseJson2(stdout, "Could not parse gh pr view output.");
}
async function fetchReviewThreads(options, prNumber) {
  const [owner, name] = options.config.repoId.split("/");
  if (!owner || !name) {
    throw new AgentLoopError("invalid_config", "Config repoId must be owner/repo.");
  }
  const stdout = await runGhJson(options, [
    "api",
    "graphql",
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${prNumber}`
  ]);
  return parseJson2(stdout, "Could not parse gh GraphQL output.");
}
function createDraftPullRequest(options, input) {
  return runGh(options.repoRoot, [
    "pr",
    "create",
    "--draft",
    "--title",
    input.title,
    "--body",
    input.body,
    "--head",
    input.head,
    "--base",
    input.base
  ]);
}
function mergePullRequest(repoRoot, prNumber) {
  runGh(repoRoot, ["pr", "merge", String(prNumber), "--merge"]);
}
async function runGhJson(options, args, signal = options.signal) {
  let lastError;
  const attempts = options.config.githubRetryMaxAttempts;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return runGh(options.repoRoot, args);
    } catch (error) {
      lastError = error;
      if (!(error instanceof AgentLoopError) || error.code !== "github_transient_failure") {
        throw error;
      }
      if (attempt < attempts) {
        await sleep(options.config.githubRetryBaseDelayMs * 2 ** (attempt - 1), signal);
      }
    }
  }
  if (lastError instanceof AgentLoopError) {
    throw lastError;
  }
  throw new AgentLoopError("github_transient_failure", "GitHub command failed after retries.", {
    details: { args },
    exitCode: 2
  });
}
function runGh(repoRoot, args) {
  try {
    return execFileSync3("gh", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    throw classifyGhError(error, args);
  }
}
function classifyGhError(error, args) {
  const detail = error;
  const text = `${detail.stderr ?? ""}
${detail.stdout ?? ""}
${detail.message ?? ""}`.toLowerCase();
  const details = { args, status: detail.status, stderr: detail.stderr };
  if (text.includes("not logged") || text.includes("authentication") || text.includes("http 401")) {
    return new AgentLoopError("needs_secret_or_login", "GitHub CLI authentication is required.", {
      details,
      exitCode: 2
    });
  }
  if (isResourceLookup(args) && (text.includes("not found") || text.includes("could not resolve"))) {
    return new AgentLoopError("github_resource_not_found", "GitHub resource was not found.", {
      details: { ...details, classification: "not_found" }
    });
  }
  if (text.includes("rate limit") || text.includes("secondary rate") || text.includes("network") || text.includes("timed out") || text.includes("http 5")) {
    return new AgentLoopError("github_transient_failure", "GitHub transient failure.", {
      details,
      exitCode: 2
    });
  }
  return new AgentLoopError("storage_error", "GitHub CLI command failed.", { details });
}
function parseJson2(value, message) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new AgentLoopError("storage_error", message, {
      details: { cause: error instanceof Error ? error.message : String(error) }
    });
  }
}
function isResourceLookup(args) {
  return args[0] === "pr" || args[0] === "api" && args[1] === "graphql";
}
function sleep(ms, signal) {
  return new Promise((resolve5, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve5();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new AgentLoopError("github_transient_failure", "GitHub retry was aborted.", { exitCode: 2 }));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// plugins/autonomous-pr-loop/core/plan-parser.ts
import { existsSync as existsSync8, readdirSync, readFileSync as readFileSync6 } from "node:fs";
import { basename, join as join5 } from "node:path";
function parsePlanNavigator(repoRoot, plansDir) {
  const convention = "PR plan documents use files named pr-<letter>-<slug>.md with a top-level `# PR X ...` heading; legacy spec indexes are supported when present.";
  const specDir = join5(repoRoot, "docs", "specs");
  const planDir = join5(repoRoot, plansDir);
  const specIndex = readSpecIndex(specDir);
  const files = [
    ...markdownFiles(specDir).filter((file) => /^pr-[a-z0-9]+-/i.test(basename(file))),
    ...markdownFiles(planDir)
  ];
  const items = files.map((file) => parsePlanFile(file)).filter((item) => item !== void 0);
  const unique2 = inferStatuses(dedupeById(items).sort(compareBySpecIndex(specIndex)), specIndex);
  const completed = unique2.filter((item) => item.status === "completed");
  const candidates = unique2.filter((item) => item.status === "next" || item.status === "current" || item.status === "unknown");
  const nextCandidates = candidates.filter((item) => item.status === "next");
  const selectedNext = nextCandidates.length === 1 ? nextCandidates[0] : candidates[0];
  return {
    convention,
    currentMilestone: selectedNext?.id ?? completed.at(-1)?.id ?? "unknown",
    ...selectedNext ? { selectedNext } : {},
    completed,
    candidates,
    ambiguous: nextCandidates.length > 1 || !selectedNext && unique2.length === 0,
    evidence: evidenceFor(unique2, nextCandidates)
  };
}
function markdownFiles(dir) {
  if (!existsSync8(dir)) {
    return [];
  }
  return readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => join5(dir, name));
}
function readSpecIndex(specDir) {
  const readmePath = join5(specDir, "README.md");
  if (!existsSync8(readmePath)) {
    return { orderedIds: [], completedIds: /* @__PURE__ */ new Set() };
  }
  const text = readFileSync6(readmePath, "utf8");
  const completedIds = /* @__PURE__ */ new Set();
  const orderedIds = [];
  let inFutureSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (isFutureSpecSection(line)) {
      inFutureSection = true;
    }
    const id = /^\s*\d+\.\s+\[PR\s+([A-Z0-9]+)/i.exec(line)?.[1]?.toUpperCase();
    if (!id) {
      continue;
    }
    const normalized = `PR ${id}`;
    orderedIds.push(normalized);
    if (!inFutureSection) {
      completedIds.add(normalized);
    }
  }
  return { orderedIds, completedIds };
}
function isFutureSpecSection(line) {
  return /(?:后续|未来|待办)\s*PR\s*顺序/i.test(line) || /future\s+PR\s+order/i.test(line);
}
function parsePlanFile(file) {
  const text = readFileSync6(file, "utf8");
  const heading = /^#\s+(?:SPEC[:：]\s*)?(PR\s+[A-Z0-9]+[^\n]*)/m.exec(text)?.[1];
  const id = /PR\s+([A-Z0-9]+)/i.exec(heading ?? basename(file))?.[1]?.toUpperCase();
  if (!id) {
    return void 0;
  }
  const markerStatus = /status:\s*(completed|current|next|unknown)/i.exec(text)?.[1]?.toLowerCase();
  return {
    id: `PR ${id}`,
    title: heading ?? basename(file, ".md"),
    status: statusFromMarker(markerStatus),
    file,
    dependsOn: [...text.matchAll(/depends(?:On| on)[:：]\s*([A-Z0-9,\s]+)/gi)].flatMap(
      (match) => (match[1] ?? "").split(/,\s*/).filter(Boolean)
    ),
    issueRefs: [...text.matchAll(/#(\d+)/g)].map((match) => `#${match[1]}`)
  };
}
function statusFromMarker(markerStatus) {
  if (markerStatus === "completed" || markerStatus === "current" || markerStatus === "next" || markerStatus === "unknown") {
    return markerStatus;
  }
  return "unknown";
}
function inferStatuses(items, specIndex) {
  if (items.some((item) => item.status === "next" || item.status === "current")) {
    return items.map((item) => item.status === "next" && item.whySelected === void 0 ? { ...item, whySelected: "Marked next in the plan/spec document." } : item);
  }
  const indexedNext = specIndex.orderedIds.find((id) => !specIndex.completedIds.has(id) && items.some((item) => item.id === id));
  if (indexedNext) {
    return items.map((item) => {
      if (item.status !== "unknown") return item;
      if (specIndex.completedIds.has(item.id)) return { ...item, status: "completed" };
      if (item.id === indexedNext) {
        return { ...item, status: "next", whySelected: "Selected as the first uncompleted PR from the legacy spec index." };
      }
      return item;
    });
  }
  if (specIndex.orderedIds.length > 0) {
    return items.map((item) => item.status === "unknown" && specIndex.completedIds.has(item.id) ? { ...item, status: "completed" } : item);
  }
  const lastUnknownIndex = findLastIndex(items, (item) => item.status === "unknown");
  if (lastUnknownIndex < 0) {
    return items;
  }
  return items.map((item, index) => {
    if (item.status !== "unknown") return item;
    if (index === lastUnknownIndex) {
      return { ...item, status: "next", whySelected: "Selected as the highest uncompleted PR from parsed plan/spec documents." };
    }
    return { ...item, status: "completed" };
  });
}
function dedupeById(items) {
  const map = /* @__PURE__ */ new Map();
  for (const item of items) {
    const existing = map.get(item.id);
    if (!existing || item.file.includes("/docs/specs/")) {
      map.set(item.id, item);
    }
  }
  return [...map.values()];
}
function evidenceFor(items, nextCandidates) {
  if (items.length === 0) {
    return ["No parseable PR plan/spec files found."];
  }
  if (nextCandidates.length > 1) {
    return nextCandidates.map((item) => `${item.id}: ${item.file}`);
  }
  return [`Parsed ${items.length} PR plan/spec documents.`];
}
function compareBySpecIndex(specIndex) {
  return (a, b) => {
    const left = specIndex.orderedIds.indexOf(a.id);
    const right = specIndex.orderedIds.indexOf(b.id);
    if (left >= 0 && right >= 0) return left - right;
    if (left >= 0) return -1;
    if (right >= 0) return 1;
    return comparePlanItems(a, b);
  };
}
function comparePlanItems(a, b) {
  return planSortKey(a.id).localeCompare(planSortKey(b.id), void 0, { numeric: true });
}
function planSortKey(id) {
  const value = /PR\s+([A-Z]+)(\d*)/i.exec(id);
  if (!value) {
    return id;
  }
  return `${value[1]}${value[2] ? value[2].padStart(3, "0") : "000"}`;
}
function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

// plugins/autonomous-pr-loop/core/delivery-work-item.ts
var DELIVERY_WORK_ITEM_BOUND_KIND = "delivery_work_item_bound";
var WORKFLOW_STAGE_EVIDENCE_KIND = "workflow_stage_evidence";
function getDeliveryWorkItem(storage, runId) {
  if (!runId) return void 0;
  const event = latestEventLookup(storage)?.findLatestEvent(runId, DELIVERY_WORK_ITEM_BOUND_KIND) ?? storage.listEvents(1e5).find((item) => item.runId === runId && item.kind === DELIVERY_WORK_ITEM_BOUND_KIND);
  return parseDeliveryWorkItem(event?.payload);
}
function selectDefaultDeliveryRun(storage) {
  return storage.listRuns(200).find((run) => isLiveRun(run) && getDeliveryWorkItem(storage, run.id) !== void 0);
}
function defaultIssueBranch(issue, title, prefix) {
  const slug = `${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${prefix}issue-${issue}${slug ? `-${slug}` : ""}`;
}
function isLiveRun(run) {
  return run.status === "RUNNING" || run.status === "BLOCKED";
}
function latestEventLookup(storage) {
  const candidate = storage;
  return typeof candidate.findLatestEvent === "function" ? { findLatestEvent: candidate.findLatestEvent.bind(storage) } : void 0;
}
function parseDeliveryWorkItem(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return void 0;
  }
  const record = payload;
  if (typeof record.issue !== "number" || !Number.isInteger(record.issue) || typeof record.title !== "string" || typeof record.url !== "string") {
    return void 0;
  }
  const source = record.source === "dashboard" || record.source === "state_machine" ? record.source : "cli";
  return {
    issue: record.issue,
    title: record.title,
    url: record.url,
    ...typeof record.branch === "string" ? { branch: record.branch } : {},
    source
  };
}

// plugins/autonomous-pr-loop/core/pr-selector.ts
function resolvePrSelection(repoRoot, config, options = {}) {
  const plan = parsePlanNavigator(repoRoot, config.plansDir);
  const pullRequests = options.pullRequests ?? safeListPullRequests(repoRoot, config, options.githubRequired ?? false);
  const openPullRequests = pullRequests.filter((pr) => pr.state.toUpperCase() === "OPEN");
  if (options.workItem) {
    return explicitWorkItemSelection(config, plan, openPullRequests, options.workItem);
  }
  if (openPullRequests.length > 1) {
    return ambiguous(plan, "Multiple open pull requests exist.", openPullRequests.map(prCandidate));
  }
  if (openPullRequests.length === 1) {
    const pr = openPullRequests[0];
    const item = itemForPullRequest(plan, pr);
    if (!item) {
      return ambiguous(plan, "Open pull request could not be mapped to a PR spec.", [prCandidate(pr)]);
    }
    return {
      mode: "current_pr",
      ambiguous: false,
      plan,
      item,
      pr,
      branchName: pr.headRefName,
      evidence: [`Mapped open PR #${pr.number} (${pr.headRefName}) to ${item.id}.`]
    };
  }
  const nextItem = nextUncompletedItem(plan, pullRequests);
  if (nextItem && !plan.ambiguous) {
    return {
      mode: "next_spec",
      ambiguous: false,
      plan,
      item: nextItem,
      branchName: branchNameForItem(config, nextItem),
      evidence: [
        ...plan.evidence,
        ...mergedEvidence(pullRequests),
        `Selected ${nextItem.id} as the next unresolved spec.`
      ]
    };
  }
  const legacy = legacyNextPr(repoRoot, config);
  if (legacy) {
    return legacy;
  }
  return ambiguous(plan, "Could not uniquely identify the next PR.", plan.candidates.map(itemCandidate));
}
function explicitWorkItemSelection(config, plan, openPullRequests, workItem) {
  const item = itemForWorkItem(workItem);
  const branchName2 = workItem.branch ?? defaultIssueBranch(workItem.issue, workItem.title, config.branchPrefix);
  const pr = openPullRequests.find((candidate) => candidate.headRefName === branchName2);
  if (pr) {
    return {
      mode: "current_pr",
      ambiguous: false,
      plan,
      item,
      pr,
      branchName: branchName2,
      evidence: [`Bound issue #${workItem.issue} matched open PR #${pr.number} (${branchName2}).`]
    };
  }
  const referencedPrs = openPullRequests.filter((candidate) => pullRequestReferencesIssue(candidate, workItem.issue));
  if (referencedPrs.length === 1) {
    const referencedPr = referencedPrs[0];
    return {
      mode: "current_pr",
      ambiguous: false,
      plan,
      item,
      pr: referencedPr,
      branchName: referencedPr.headRefName,
      evidence: [`Bound issue #${workItem.issue} matched open PR #${referencedPr.number} by issue reference.`]
    };
  }
  if (referencedPrs.length > 1) {
    return ambiguous(plan, `Multiple open pull requests reference bound issue #${workItem.issue}.`, referencedPrs.map(prCandidate));
  }
  return {
    mode: "next_spec",
    ambiguous: false,
    plan,
    item,
    branchName: branchName2,
    evidence: [`Bound issue #${workItem.issue} selected as the explicit delivery work item.`]
  };
}
function pullRequestReferencesIssue(pr, issue) {
  const text = `${pr.title ?? ""} ${pr.body ?? ""}`;
  const issuePattern = new RegExp(`(^|[^0-9])#${issue}([^0-9]|$)`);
  const issueSlugPattern = new RegExp(`(^|[^a-z0-9])issue-${issue}([^a-z0-9]|$)`, "i");
  return issuePattern.test(text) || issueSlugPattern.test(pr.headRefName);
}
function itemForWorkItem(workItem) {
  return {
    id: `#${workItem.issue}`,
    title: workItem.title,
    status: "next",
    file: workItem.url,
    dependsOn: [],
    issueRefs: [`#${workItem.issue}`],
    whySelected: "Selected from explicit delivery work item binding."
  };
}
function branchNameForItem(config, item) {
  const fileSlug = basename2(item.file, ".md");
  const slug = fileSlug.match(/^pr-[a-z0-9]+-/i) ? fileSlug : item.id.toLowerCase().replace(/\s+/g, "-");
  return `${config.branchPrefix}${slugify(slug)}`;
}
function safeListPullRequests(repoRoot, config, required) {
  try {
    return listPullRequests({ repoRoot, config });
  } catch (error) {
    if (error instanceof AgentLoopError) {
      if (required) {
        throw error;
      }
      return [];
    }
    throw error;
  }
}
function itemForPullRequest(plan, pr) {
  const id = prIdFromBranch(pr.headRefName);
  if (!id) {
    return void 0;
  }
  return [...plan.completed, ...plan.candidates].find((item) => item.id === id);
}
function nextUncompletedItem(plan, pullRequests) {
  if (plan.ambiguous) {
    return void 0;
  }
  const completed = /* @__PURE__ */ new Set([
    ...plan.completed.map((item) => item.id),
    ...pullRequests.flatMap((pr) => mergedPrId(pr) ?? [])
  ]);
  return [...plan.completed, ...plan.candidates].find((item) => !completed.has(item.id));
}
function mergedPrId(pr) {
  if (pr.state.toUpperCase() !== "MERGED" && !pr.mergedAt) {
    return void 0;
  }
  return prIdFromBranch(pr.headRefName);
}
function mergedEvidence(pullRequests) {
  return pullRequests.flatMap((pr) => {
    const id = mergedPrId(pr);
    return id ? [`Observed merged PR #${pr.number} (${pr.headRefName}) as ${id}.`] : [];
  });
}
function prIdFromBranch(branch) {
  const id = /(?:^|\/)pr-([a-z]+[0-9]*)-/i.exec(branch)?.[1]?.toUpperCase();
  return id ? `PR ${id}` : void 0;
}
function legacyNextPr(repoRoot, config) {
  const path = join6(repoRoot, config.plansDir);
  if (!existsSync9(path)) {
    return void 0;
  }
  const files = readdirSync2(path).filter((name) => /^next-pr.*\.md$/i.test(name));
  if (files.length !== 1) {
    return void 0;
  }
  const file = join6(path, files[0]);
  const id = /next-pr-([a-z0-9]+)/i.exec(files[0])?.[1]?.toUpperCase() ?? "NEXT";
  const item = {
    id: `PR ${id}`,
    title: `PR ${id}`,
    status: "next",
    file,
    dependsOn: [],
    issueRefs: [],
    whySelected: "Selected from legacy next-pr plan file."
  };
  return {
    mode: "next_spec",
    ambiguous: false,
    plan: {
      convention: "Legacy PR docs use next-pr*.md files in the configured plans directory.",
      currentMilestone: item.id,
      selectedNext: item,
      completed: [],
      candidates: [item],
      ambiguous: false,
      evidence: [`Selected ${files[0]} from ${config.plansDir}.`]
    },
    item,
    branchName: `${config.branchPrefix}${slugify(basename2(files[0], ".md"))}`,
    evidence: [`Selected ${files[0]} from ${config.plansDir}.`]
  };
}
function ambiguous(plan, reason, candidates) {
  return {
    mode: "ambiguous",
    ambiguous: true,
    plan,
    reason,
    candidates,
    evidence: [...plan.evidence, reason]
  };
}
function prCandidate(pr) {
  return {
    number: pr.number,
    headRefName: pr.headRefName,
    state: pr.state,
    url: pr.url
  };
}
function itemCandidate(item) {
  return {
    id: item.id,
    status: item.status,
    file: item.file
  };
}
function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "next-pr";
}

// plugins/autonomous-pr-loop/core/state-machine.ts
import { execFileSync as execFileSync8 } from "node:child_process";

// plugins/autonomous-pr-loop/core/command-runner.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var CommandRunner = class {
  constructor(options) {
    this.options = options;
  }
  options;
  async run(plan, dryRun) {
    const started = Date.now();
    const policy = evaluatePolicy(plan);
    if (!policy.allowed) {
      const reason = policy.reason ?? "Command rejected.";
      const result = this.result(plan, dryRun, false, 126, "", reason, started, false, [], reason);
      this.recordCommandResult(result, "policy_violation");
      return result;
    }
    if (dryRun) {
      const result = this.result(plan, true, true, 0, "", "", started, false, []);
      this.recordCommandResult(result, "command_dry_run");
      return result;
    }
    try {
      const output = await execFileAsync(plan.file, plan.args, {
        cwd: plan.cwd,
        shell: false,
        timeout: plan.timeoutMs ?? this.options.config.commandTimeoutMs,
        maxBuffer: Math.max((plan.outputLimitBytes ?? this.options.config.commandOutputLimitBytes) * 4, 1048576),
        signal: this.options.signal
      });
      const result = this.result(
        plan,
        false,
        true,
        0,
        output.stdout,
        output.stderr,
        started,
        false,
        []
      );
      this.recordCommandResult(result, "command_executed");
      return result;
    } catch (error) {
      const typed = error;
      const outputLimited = typed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || typed.message?.toLowerCase().includes("maxbuffer") === true;
      const timedOut = !outputLimited && (typed.code === "ETIMEDOUT" || typed.killed === true || typed.signal === "SIGTERM");
      const result = this.result(
        plan,
        false,
        true,
        typeof typed.code === "number" ? typed.code : timedOut ? 124 : outputLimited ? 1 : 1,
        typed.stdout ?? "",
        typed.stderr ?? typed.message ?? "",
        started,
        timedOut,
        [],
        outputLimited ? "Command output exceeded maxBuffer." : void 0
      );
      this.recordCommandResult(result, timedOut ? "command_timeout" : outputLimited ? "command_output_limit" : "command_failed");
      return result;
    }
  }
  result(plan, dryRun, allowed, exitCode, stdout, stderr, started, timedOut, artifactIds, rejectionReason) {
    return {
      plan,
      dryRun,
      allowed,
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      timedOut,
      artifactIds,
      ...rejectionReason ? { rejectionReason } : {}
    };
  }
  recordCommandResult(result, kind) {
    const limit = result.plan.outputLimitBytes ?? this.options.config.commandOutputLimitBytes;
    const output = `stdout:
${result.stdout}

stderr:
${result.stderr}`;
    const artifactIds = [...result.artifactIds];
    let stdout = truncate(result.stdout, limit);
    let stderr = truncate(result.stderr, limit);
    if (Buffer.byteLength(output) > limit) {
      const artifact = writeArtifact(
        this.options.repoRoot,
        this.options.storage,
        this.options.runId,
        "command-output",
        `${result.plan.id}.txt`,
        output
      );
      artifactIds.push(artifact.id);
      result.artifactIds.push(artifact.id);
      stdout = truncate(result.stdout, Math.floor(limit / 2));
      stderr = truncate(result.stderr, Math.floor(limit / 2));
    }
    this.options.storage.appendEvent({
      runId: this.options.runId,
      kind,
      message: `${result.plan.file} ${result.plan.args.join(" ")}`.trim(),
      payload: {
        plan: result.plan,
        exitCode: result.exitCode,
        stdout,
        stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        allowed: result.allowed,
        dryRun: result.dryRun,
        rejectionReason: result.rejectionReason
      },
      artifactIds
    });
  }
};
function evaluatePolicy(plan) {
  if (matchesDenylist(plan)) {
    return { allowed: false, reason: "Command denied by destructive command policy." };
  }
  if (!matchesAllowlist(plan)) {
    return { allowed: false, reason: "Command is not in the PR B allowlist." };
  }
  return { allowed: true };
}
function matchesAllowlist(plan) {
  if ([
    ["git", "status", "--short", "--branch"],
    ["git", "branch", "--show-current"],
    ["git", "rev-parse", "--is-inside-work-tree"],
    ["gh", "auth", "status"],
    ["codex", "--version"],
    ["npx", "gitnexus", "--version"],
    ["pnpm", "--version"]
  ].some(([file, ...args]) => plan.file === file && sameArgs(plan.args, args))) {
    return true;
  }
  if (plan.file === "git") {
    return matchesGitAllowlist(plan.args);
  }
  if (plan.file === "gh") {
    return matchesGhAllowlist(plan.args);
  }
  if (plan.file === "npx" && plan.args[0] === "gitnexus") {
    return ["status", "analyze", "detect_changes", "impact"].includes(plan.args[1] ?? "");
  }
  if (plan.file === "pnpm") {
    return plan.args.length === 1 && (plan.args[0] === "lint" || plan.args[0] === "test");
  }
  if (plan.file === "npm") {
    return plan.args.length === 2 && plan.args[0] === "run" && (plan.args[1] === "lint" || plan.args[1] === "test");
  }
  if (plan.file === "yarn") {
    return plan.args.length === 1 && (plan.args[0] === "lint" || plan.args[0] === "test");
  }
  if (plan.file === "bun") {
    return plan.args.length === 2 && plan.args[0] === "run" && (plan.args[1] === "lint" || plan.args[1] === "test");
  }
  if (plan.file === "codex") {
    return matchesCodexAllowlist(plan.args);
  }
  return false;
}
function matchesDenylist(plan) {
  const args = stripGitGlobalOptions(plan.args);
  if (plan.file === "git") {
    if (args[0] === "reset" && args.includes("--hard")) {
      return true;
    }
    if (args[0] === "clean" && args.some((arg) => /^-.*f/.test(arg))) {
      return true;
    }
    if (args[0] === "rebase") {
      return true;
    }
    if (args[0] === "push" && args.some((arg) => arg === "-f" || arg === "--force" || arg === "--force-with-lease")) {
      return true;
    }
  }
  if (plan.file === "rm") {
    return args.some((arg) => arg.startsWith("-") && arg.includes("r") && arg.includes("f"));
  }
  if (plan.file === "gh" && args[0] === "repo" && args[1] === "delete") {
    return true;
  }
  if (plan.file === "codex") {
    return args.includes("danger-full-access") || args.includes("--dangerously-bypass-approvals-and-sandbox");
  }
  return false;
}
function matchesCodexAllowlist(args) {
  const fresh = parseCodexBaseArgs(args);
  if (!fresh) {
    return false;
  }
  const trailing = args.slice(fresh.nextIndex);
  if (trailing.length === 0) {
    return true;
  }
  return trailing.length === 3 && trailing[0] === "resume" && isOptionValue(trailing[1]) && typeof trailing[2] === "string" && trailing[2].length > 0;
}
function parseCodexBaseArgs(args) {
  if (args.length < 10 || args[0] !== "exec") {
    return void 0;
  }
  const cwd = optionValue(args, "-C");
  const sandbox = optionValue(args, "-s");
  const outputSchema = optionValue(args, "--output-schema");
  const outputLastMessage = optionValue(args, "--output-last-message");
  if (!cwd || !outputSchema || !outputLastMessage || sandbox !== "read-only" && sandbox !== "workspace-write") {
    return void 0;
  }
  const expected = [
    "exec",
    "-C",
    cwd,
    "-s",
    sandbox,
    "--json",
    "--output-schema",
    outputSchema,
    "--output-last-message",
    outputLastMessage
  ];
  if (!sameArgs(args.slice(0, expected.length), expected)) {
    return void 0;
  }
  const nextIndex = expected.length;
  if (args[nextIndex] === "--ephemeral") {
    return { nextIndex: nextIndex + 1 };
  }
  return { nextIndex };
}
function matchesGitAllowlist(args) {
  if (hasGitWorkingTreeOverride(args)) {
    return false;
  }
  const stripped = stripGitGlobalOptions(args);
  if (stripped[0] === "checkout") {
    return stripped.length === 2 || stripped.length === 3 && stripped[1] === "-b";
  }
  if (stripped[0] === "pull") {
    return stripped.length === 4 && stripped[1] === "--ff-only" && stripped[2] === "origin";
  }
  if (stripped[0] === "status") {
    return sameArgs(stripped, ["status", "--short"]) || sameArgs(stripped, ["status", "--short", "--branch"]) || sameArgs(stripped, ["status", "--porcelain=v1", "--untracked-files=all"]);
  }
  if (stripped[0] === "branch") {
    return sameArgs(stripped, ["branch", "--show-current"]);
  }
  if (stripped[0] === "rev-parse") {
    return stripped.length === 2 || sameArgs(stripped, ["rev-parse", "--is-inside-work-tree"]) || stripped.length === 3 && stripped[1] === "--verify";
  }
  if (stripped[0] === "diff") {
    return sameArgs(stripped, ["diff", "--name-only"]) || sameArgs(stripped, ["diff", "--cached", "--quiet"]) || stripped.length === 3 && stripped[1] === "--name-only";
  }
  if (stripped[0] === "add") {
    return stripped.length >= 3 && stripped[1] === "--";
  }
  if (stripped[0] === "commit") {
    return stripped.length === 3 && stripped[1] === "-m";
  }
  if (stripped[0] === "push") {
    return stripped.length === 4 && stripped[1] === "-u" && stripped[2] === "origin";
  }
  if (stripped[0] === "ls-remote") {
    return stripped.length === 4 && stripped[1] === "--heads" && stripped[2] === "origin";
  }
  return false;
}
function matchesGhAllowlist(args) {
  if (sameArgs(args, ["auth", "status"])) {
    return true;
  }
  if (args[0] === "pr" && args[1] === "list") {
    return args.length === 6 && args[2] === "--head" && args[4] === "--json";
  }
  if (args[0] === "pr" && args[1] === "view") {
    return args.length === 5 && args[3] === "--json";
  }
  if (args[0] === "pr" && args[1] === "create") {
    return args.length === 11 && args[2] === "--draft" && args[3] === "--title" && args[5] === "--body" && args[7] === "--head" && args[9] === "--base";
  }
  if (args[0] === "pr" && args[1] === "comment") {
    return args.length === 5 && args[3] === "--body";
  }
  if (args[0] === "pr" && args[1] === "ready") {
    return args.length === 3;
  }
  if (args[0] === "pr" && args[1] === "merge") {
    return args.length === 4 && args[3] === "--merge";
  }
  if (args[0] === "api" && args[1] === "graphql") {
    return args.length === 10 && args[2] === "-f" && startsWith(args[3], "query=") && args[4] === "-F" && startsWith(args[5], "owner=") && args[6] === "-F" && startsWith(args[7], "name=") && args[8] === "-F" && startsWith(args[9], "number=");
  }
  return false;
}
function startsWith(value, prefix) {
  return value?.startsWith(prefix) ?? false;
}
function optionValue(args, option) {
  const index = args.indexOf(option);
  const value = index >= 0 ? args[index + 1] : void 0;
  return isOptionValue(value) ? value : void 0;
}
function isOptionValue(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("-");
}
function hasGitWorkingTreeOverride(args) {
  return args.some((arg) => arg === "-C" || arg === "--git-dir" || arg === "--work-tree" || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree="));
}
function stripGitGlobalOptions(args) {
  const result = [...args];
  while (result.length > 0) {
    const first = result[0];
    if (first === "-C" || first === "--git-dir" || first === "--work-tree") {
      result.splice(0, 2);
      continue;
    }
    if (first?.startsWith("--git-dir=") || first?.startsWith("--work-tree=")) {
      result.shift();
      continue;
    }
    break;
  }
  return result;
}
function sameArgs(actual, expected) {
  return actual.length === expected.length && expected.every((arg, index) => actual[index] === arg);
}
function truncate(value, limit) {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= limit) {
    return value;
  }
  if (limit <= 0) {
    return "[truncated]";
  }
  return `${utf8Prefix(buffer, limit)}
[truncated]`;
}
function utf8Prefix(buffer, limit) {
  let end = Math.min(limit, buffer.byteLength);
  let value = buffer.subarray(0, end).toString("utf8");
  while (end > 0 && value.endsWith("\uFFFD")) {
    end -= 1;
    value = buffer.subarray(0, end).toString("utf8");
  }
  return value;
}

// plugins/autonomous-pr-loop/core/generic-lifecycle.ts
function executeGenericPreWorkerStep(input) {
  if (input.state !== "EXECUTE_STEP") {
    return {};
  }
  const scopeDecision = latestGateDecision(input.storage, input.run.id, "generic_scope_change_requested", "EXECUTE_STEP");
  if (!scopeDecision) {
    return {};
  }
  if (decisionStatus(scopeDecision) === "rejected") {
    if (!input.dryRun) markConsumed(input.storage, input.run.id, scopeDecision, "STOPPED");
    return { transitionGuard: "rejected", status: "STOPPED" };
  }
  const nextState = decisionNextState(scopeDecision, ["PLAN_WORK", "STOPPED"], "generic_scope_change_requested", "EXECUTE_STEP", "PLAN_WORK");
  if (!input.dryRun) markConsumed(input.storage, input.run.id, scopeDecision, nextState);
  return {
    transitionGuard: nextState === "PLAN_WORK" ? "scope_change_approved" : "rejected",
    ...nextState === "STOPPED" ? { status: "STOPPED" } : {}
  };
}
async function executeGenericLifecycleStep(input) {
  const profile = workflowProfileDefinition(input.config.workflowProfile);
  if (input.state === "DEFINE_GOAL") {
    const gateDecision = latestGateDecision(input.storage, input.run.id, "generic_goal_needs_confirmation", "DEFINE_GOAL");
    if (!gateDecision) {
      throw new AgentLoopError("generic_goal_needs_confirmation", "Generic loop goal needs confirmation before work starts.", {
        details: {
          loopShape: "generic-loop",
          workflowProfile: input.config.workflowProfile,
          state: "DEFINE_GOAL",
          expectedDeliverable: profile.expectedDeliverable,
          allowedNextStates: ["COLLECT_CONTEXT", "PLAN_WORK", "STOPPED"],
          defaultNextState: "COLLECT_CONTEXT",
          requiredPayload: { nextState: "COLLECT_CONTEXT", source: "ui" }
        },
        exitCode: 2
      });
    }
    if (decisionStatus(gateDecision) === "rejected") {
      if (!input.dryRun) markConsumed(input.storage, input.run.id, gateDecision, "STOPPED");
      return { transitionGuard: "rejected", status: "STOPPED" };
    }
    const nextState = decisionNextState(gateDecision, ["COLLECT_CONTEXT", "PLAN_WORK", "STOPPED"], "generic_goal_needs_confirmation", "DEFINE_GOAL", "COLLECT_CONTEXT");
    if (!input.dryRun) markConsumed(input.storage, input.run.id, gateDecision, nextState);
    return { transitionGuard: guardForGoalDecision(nextState), ...nextState === "STOPPED" ? { status: "STOPPED" } : {} };
  }
  if (input.state === "COLLECT_CONTEXT") {
    return {
      transitionGuard: "always",
      artifacts: [writeGenericArtifact(input, "generic-context", "context.md", genericArtifactContent(input, "Context collected"))]
    };
  }
  if (input.state === "PLAN_WORK") {
    if (!input.dryRun) {
      input.storage.appendDecision({
        runId: input.run.id,
        kind: "generic_plan_ready",
        message: "Generic loop plan is ready.",
        details: { workflowProfile: input.config.workflowProfile, expectedDeliverable: profile.expectedDeliverable }
      });
    }
    return {
      transitionGuard: "always",
      artifacts: [writeGenericArtifact(input, "generic-plan", "plan.md", genericArtifactContent(input, "Plan ready"))]
    };
  }
  if (input.state === "EXECUTE_STEP") {
    return { transitionGuard: "always" };
  }
  if (input.state === "SELF_REVIEW") {
    const anchor = latestReviewCycleAnchor(input.storage, input.run.id);
    const cycles = executionReviewCycles(input.storage, input.run.id, anchor);
    const maxCycles = profile.maxExecutionReviewCycles ?? 3;
    const review = classifySelfReview(input.workerResult);
    if (!review.needsFix) {
      if (!input.dryRun) {
        input.storage.appendDecision({
          runId: input.run.id,
          kind: "generic_review_passed",
          message: "Generic self-review passed.",
          details: { anchorId: anchor?.id, workflowProfile: input.config.workflowProfile, summary: input.workerResult?.summary }
        });
      }
      return { transitionGuard: "review_passed" };
    }
    if (cycles < maxCycles) {
      if (!input.dryRun) {
        input.storage.appendDecision({
          runId: input.run.id,
          kind: "generic_execute_review_cycle",
          message: "Generic self-review requested another execution pass.",
          details: {
            cycle: cycles + 1,
            maxCycles,
            anchorId: anchor?.id,
            workflowProfile: input.config.workflowProfile,
            reasons: review.reasons,
            followUps: input.workerResult?.followUps ?? [],
            outOfScope: input.workerResult?.outOfScope ?? []
          }
        });
      }
      return { transitionGuard: "fix_needed_cycles_remain" };
    }
    if (!input.dryRun) {
      input.storage.appendDecision({
        runId: input.run.id,
        kind: "generic_review_cycles_exhausted",
        message: "Generic self-review cycles exhausted; escalating to human gate.",
        details: {
          cycles,
          maxCycles,
          anchorId: anchor?.id,
          workflowProfile: input.config.workflowProfile,
          reasons: review.reasons,
          followUps: input.workerResult?.followUps ?? [],
          outOfScope: input.workerResult?.outOfScope ?? []
        }
      });
    }
    return { transitionGuard: "review_cycles_exhausted" };
  }
  if (input.state === "HUMAN_GATE") {
    const reason = humanGateReason(input.storage, input.run.id);
    const approval = latestGateDecision(input.storage, input.run.id, "generic_human_gate", "HUMAN_GATE");
    if (!approval) {
      throw new AgentLoopError("generic_human_gate", "Generic deliverable needs human approval before delivery.", {
        details: {
          loopShape: "generic-loop",
          workflowProfile: input.config.workflowProfile,
          state: "HUMAN_GATE",
          expectedDeliverable: profile.expectedDeliverable,
          reason,
          allowedNextStates: ["DELIVER", "EXECUTE_STEP", "STOPPED"],
          defaultNextState: "DELIVER",
          requiredPayload: { nextState: "DELIVER", source: "ui" }
        },
        exitCode: 2
      });
    }
    if (decisionStatus(approval) === "rejected") {
      if (!input.dryRun) markConsumed(input.storage, input.run.id, approval, "STOPPED");
      return { transitionGuard: "rejected", status: "STOPPED" };
    }
    const nextState = decisionNextState(approval, ["DELIVER", "EXECUTE_STEP", "STOPPED"], "generic_human_gate", "HUMAN_GATE", "DELIVER");
    if (!input.dryRun) markConsumed(input.storage, input.run.id, approval, nextState);
    return { transitionGuard: guardForHumanGateDecision(nextState), ...nextState === "STOPPED" ? { status: "STOPPED" } : {} };
  }
  if (input.state === "DELIVER") {
    return {
      transitionGuard: "always",
      artifacts: [writeGenericArtifact(input, "generic-deliverable", "deliverable.md", genericArtifactContent(input, "Deliverable approved"))]
    };
  }
  if (input.state === "COMPLETE") {
    if (!input.storage.listDecisions(input.run.id).some((decision) => decision.kind === "generic_loop_completed")) {
      input.storage.appendDecision({
        runId: input.run.id,
        kind: "generic_loop_completed",
        message: "Generic loop completed.",
        details: { workflowProfile: input.config.workflowProfile, expectedDeliverable: profile.expectedDeliverable }
      });
      input.storage.appendEvent({
        runId: input.run.id,
        kind: "generic_loop_completed",
        message: "Generic loop completed.",
        stateBefore: "DELIVER",
        stateAfter: "COMPLETE",
        payload: { workflowProfile: input.config.workflowProfile, expectedDeliverable: profile.expectedDeliverable }
      });
    }
    return { nextState: "COMPLETE", status: "READY" };
  }
  return {};
}
function writeGenericArtifact(input, kind, name, content) {
  return writeArtifact(input.repoRoot, input.storage, input.run.id, kind, name, content);
}
function genericArtifactContent(input, title) {
  const profile = workflowProfileDefinition(input.config.workflowProfile);
  return [
    `# ${title}`,
    "",
    `- loopShape: ${input.config.loopShape}`,
    `- workflowProfile: ${input.config.workflowProfile}`,
    `- state: ${input.state}`,
    `- expectedDeliverable: ${profile.expectedDeliverable ?? "deliverable"}`,
    `- allowedWriteRoots: ${(profile.allowedWriteRoots ?? []).join(", ") || "none"}`,
    `- requiredEvidence: ${(profile.requiredEvidence ?? []).join(", ") || "none"}`,
    `- reviewChecklist: ${(profile.reviewChecklist ?? []).join(", ") || "none"}`,
    `- handoff: ${profile.handoffTemplate}`,
    "",
    "This artifact records the generic-loop lifecycle handoff. Worker output and detailed evidence remain in worker artifacts and timeline entries."
  ].join("\n");
}
function latestGateDecision(storage, runId, gateKind, state) {
  const gate = storage.listGates(runId).find((item) => {
    if (item.kind !== gateKind || item.status === "open") {
      return false;
    }
    return state === void 0 || gateState(item.details) === state;
  });
  if (!gate) {
    return void 0;
  }
  return storage.listDecisions(runId).find((decision) => {
    if (decision.kind !== "gate_approved" && decision.kind !== "gate_rejected") {
      return false;
    }
    const details = decision.details;
    if (typeof details !== "object" || details === null || details.gateKind !== gateKind) {
      return false;
    }
    const matches = details.gateId === gate.id && (state === void 0 || details.state === state);
    return matches && !isConsumed(storage, runId, decision);
  });
}
function gateState(details) {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return void 0;
  const state = details.state;
  return typeof state === "string" ? state : void 0;
}
function decisionGateId(decision) {
  if (typeof decision.details !== "object" || decision.details === null || Array.isArray(decision.details)) return void 0;
  const gateId = decision.details.gateId;
  return typeof gateId === "string" ? gateId : void 0;
}
function decisionGateKind(decision) {
  if (typeof decision.details !== "object" || decision.details === null || Array.isArray(decision.details)) return void 0;
  const gateKind = decision.details.gateKind;
  return typeof gateKind === "string" ? gateKind : void 0;
}
function isConsumed(storage, runId, decision) {
  const gateId = decisionGateId(decision);
  return storage.listDecisions(runId).some((item) => {
    if (item.kind !== "generic_gate_decision_consumed" || typeof item.details !== "object" || item.details === null || Array.isArray(item.details)) {
      return false;
    }
    const details = item.details;
    return details.decisionId === decision.id || gateId !== void 0 && details.gateId === gateId;
  });
}
function markConsumed(storage, runId, decision, nextState) {
  storage.appendDecision({
    runId,
    kind: "generic_gate_decision_consumed",
    message: `Consumed generic gate decision for ${nextState}.`,
    details: { gateId: decisionGateId(decision), decisionId: decision.id, nextState }
  });
  if (nextState === "EXECUTE_STEP" && decisionGateKind(decision) === "generic_human_gate") {
    storage.appendDecision({
      runId,
      kind: "generic_review_cycles_reset",
      message: "Generic review cycles reset after human requested changes.",
      details: { gateId: decisionGateId(decision), decisionId: decision.id, nextState }
    });
  }
}
function classifySelfReview(result) {
  if (!result) {
    return { needsFix: false, reasons: ["no reviewer output; treating dry-run review as passed"] };
  }
  const blockingFollowUps = result.followUps.filter(isBlockingFollowUp);
  const reasons = [
    ...blockingFollowUps.length > 0 ? [`blockingFollowUps:${blockingFollowUps.length}`] : [],
    ...result.outOfScope.length > 0 ? [`outOfScope:${result.outOfScope.length}`] : [],
    ...result.error ? [`error:${result.error.kind}`] : []
  ];
  return { needsFix: reasons.length > 0, reasons };
}
function guardForGoalDecision(nextState) {
  if (nextState === "COLLECT_CONTEXT") return "goal_clear";
  if (nextState === "PLAN_WORK") return "skip_context";
  if (nextState === "STOPPED") return "rejected";
  return "rejected";
}
function guardForHumanGateDecision(nextState) {
  if (nextState === "DELIVER") return "deliverable_approved";
  if (nextState === "EXECUTE_STEP") return "request_changes";
  if (nextState === "STOPPED") return "rejected";
  return "rejected";
}
function isBlockingFollowUp(value) {
  return /^(fix|fix-needed|needs-fix|must-fix|blocker|blocking|required|request-changes|changes-required)(?=[:\s-]|$)|^(必须|阻塞|需要修复)(?=[:：\s-]|$)/i.test(value.trim());
}
function humanGateReason(storage, runId) {
  const anchor = latestReviewCycleAnchor(storage, runId);
  const latest = decisionsSinceLatestPlan(storage, runId, anchor).find((decision) => (decision.kind === "generic_review_cycles_exhausted" || decision.kind === "generic_review_passed") && decisionMatchesAnchor(decision, anchor));
  return latest?.kind === "generic_review_cycles_exhausted" ? "review_overridden" : "review_passed";
}
function decisionStatus(decision) {
  return decision.kind === "gate_rejected" ? "rejected" : "approved";
}
function decisionNextState(decision, allowed, gateKind, state, defaultNextState) {
  const details = typeof decision.details === "object" && decision.details !== null ? decision.details : {};
  const value = details.payload?.nextState ?? details.nextState;
  if (typeof value === "string" && allowed.includes(value)) {
    return value;
  }
  throw new AgentLoopError(gateKind, "Generic gate decision payload must include a valid next state.", {
    details: {
      gateKind,
      state,
      allowedNextStates: allowed,
      defaultNextState,
      requiredPayload: { nextState: defaultNextState, source: "ui" },
      receivedNextState: value
    },
    exitCode: 2
  });
}
function executionReviewCycles(storage, runId, anchor) {
  return decisionsSinceLatestPlan(storage, runId, anchor).filter((decision) => decision.kind === "generic_execute_review_cycle" && decisionMatchesAnchor(decision, anchor)).length;
}
function decisionsSinceLatestPlan(storage, runId, anchor = latestReviewCycleAnchor(storage, runId)) {
  const decisions = storage.listDecisions(runId);
  return anchor ? decisions.filter((decision) => decision.createdAt >= anchor.createdAt) : decisions;
}
function latestReviewCycleAnchor(storage, runId) {
  return storage.listDecisions(runId).find((decision) => decision.kind === "generic_plan_ready" || decision.kind === "generic_review_cycles_reset");
}
function decisionMatchesAnchor(decision, anchor) {
  if (!anchor) return true;
  if (typeof decision.details !== "object" || decision.details === null || Array.isArray(decision.details)) {
    return anchor.kind === "generic_review_cycles_reset" ? false : decision.createdAt >= anchor.createdAt;
  }
  const anchorId = decision.details.anchorId;
  return anchorId === anchor.id || anchorId === void 0 && anchor.kind !== "generic_review_cycles_reset" && decision.createdAt >= anchor.createdAt;
}

// plugins/autonomous-pr-loop/core/ci.ts
function evaluateCiChecks(config, rollup) {
  const checks = latestByName(rollup.map(normalizeCheck).filter((check) => check.name.length > 0));
  if (config.requiredChecks.length === 0) {
    return evaluateObservedChecks(checks);
  }
  const byName = new Map(checks.map((check) => [check.name, check]));
  const missingRequiredChecks = config.requiredChecks.filter((name) => !byName.has(name));
  if (missingRequiredChecks.length > 0) {
    return {
      state: "missing",
      gate: "ci_required_checks_missing",
      checks,
      missingRequiredChecks
    };
  }
  const required = config.requiredChecks.map((name) => byName.get(name)).filter(isDefined);
  if (required.some((check) => isFailure(check.conclusion))) {
    return { state: "failed", checks, missingRequiredChecks: [] };
  }
  if (required.some((check) => !isSuccess(check.conclusion) || check.status.toLowerCase() !== "completed")) {
    return { state: "pending", checks, missingRequiredChecks: [] };
  }
  return { state: "green", checks, missingRequiredChecks: [] };
}
function evaluateObservedChecks(checks) {
  if (checks.length === 0) {
    return {
      state: "missing",
      gate: "ci_required_checks_missing",
      checks,
      missingRequiredChecks: []
    };
  }
  if (checks.some((check) => isFailure(check.conclusion))) {
    return { state: "failed", checks, missingRequiredChecks: [] };
  }
  if (checks.some((check) => !isSuccess(check.conclusion) || check.status.toLowerCase() !== "completed")) {
    return { state: "pending", checks, missingRequiredChecks: [] };
  }
  return { state: "green", checks, missingRequiredChecks: [] };
}
function normalizeCheck(value) {
  if (!isRecord(value)) {
    return { name: "", status: "unknown" };
  }
  const name = stringValue(value.name) || stringValue(value.context) || stringValue(value.workflowName);
  const state = stringValue(value.state);
  return {
    name,
    status: stringValue(value.status) || statusFromState(state),
    ...stringValue(value.conclusion) || conclusionFromState(state) ? { conclusion: stringValue(value.conclusion) || conclusionFromState(state) } : {},
    ...stringValue(value.url) || stringValue(value.detailsUrl) ? { url: stringValue(value.url) || stringValue(value.detailsUrl) } : {},
    ...stringValue(value.startedAt) ? { startedAt: stringValue(value.startedAt) } : {},
    ...stringValue(value.completedAt) ? { completedAt: stringValue(value.completedAt) } : {}
  };
}
function statusFromState(state) {
  const normalized = state.toLowerCase();
  if (["success", "failure", "failed", "error", "cancelled", "skipped"].includes(normalized)) {
    return "COMPLETED";
  }
  if (["pending", "queued", "in_progress", "requested", "waiting"].includes(normalized)) {
    return "IN_PROGRESS";
  }
  return "unknown";
}
function conclusionFromState(state) {
  const normalized = state.toLowerCase();
  if (normalized === "success") return "SUCCESS";
  if (normalized === "failure" || normalized === "failed" || normalized === "error") return "FAILURE";
  if (normalized === "cancelled") return "CANCELLED";
  if (normalized === "skipped") return "SKIPPED";
  return "";
}
function latestByName(checks) {
  const byName = /* @__PURE__ */ new Map();
  for (const check of checks) {
    const previous = byName.get(check.name);
    if (!previous || timestamp(check) >= timestamp(previous)) {
      byName.set(check.name, check);
    }
  }
  return [...byName.values()];
}
function timestamp(check) {
  return Date.parse(check.completedAt ?? check.startedAt ?? "") || 0;
}
function isSuccess(value) {
  return value?.toLowerCase() === "success";
}
function isFailure(value) {
  const normalized = value?.toLowerCase();
  return normalized === "failure" || normalized === "failed" || normalized === "timed_out";
}
function stringValue(value) {
  return typeof value === "string" ? value : "";
}
function isDefined(value) {
  return value !== void 0;
}

// plugins/autonomous-pr-loop/core/git.ts
import { execFileSync as execFileSync4 } from "node:child_process";

// plugins/autonomous-pr-loop/core/command.ts
function redactRemote(remote) {
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

// plugins/autonomous-pr-loop/core/git.ts
function getCurrentBranch(repoRoot) {
  return git(repoRoot, ["branch", "--show-current"]);
}
function isWorktreeClean(repoRoot) {
  return git(repoRoot, ["status", "--short"]).length === 0;
}
function getOriginRemote(repoRoot) {
  return git(repoRoot, ["remote", "get-url", "origin"]);
}
function assertGitHubRemote(repoRoot) {
  const remote = getOriginRemote(repoRoot);
  if (!remote.includes("github.com")) {
    throw new AgentLoopError("unsupported_remote", "origin remote is not a GitHub remote.", {
      details: { remote: redactRemote(remote) },
      exitCode: 2
    });
  }
}
function syncBaseBranch(repoRoot, baseBranch) {
  assertGitHubRemote(repoRoot);
  if (!isWorktreeClean(repoRoot)) {
    throw new AgentLoopError("dirty_unowned_worktree", "Worktree must be clean before syncing base branch.", {
      details: { baseBranch },
      exitCode: 2
    });
  }
  git(repoRoot, ["checkout", baseBranch]);
  git(repoRoot, ["pull", "--ff-only", "origin", baseBranch]);
  return { skipped: false, message: `Synced ${baseBranch}.`, branch: baseBranch };
}
function createBranch(repoRoot, branchName2, options = {}) {
  const linked = options.runId && options.storage ? options.storage.getPrLink(options.runId) : void 0;
  if (branchExists(repoRoot, branchName2)) {
    if (linked?.branch === branchName2) {
      git(repoRoot, ["checkout", branchName2]);
      recordDecision(options, "branch_reused", `Reused branch ${branchName2}.`, { branchName: branchName2 });
      return { skipped: true, message: `Reused current run branch ${branchName2}.`, branch: branchName2 };
    }
    const suffixed = nextAvailableBranch(repoRoot, branchName2);
    git(repoRoot, ["checkout", "-b", suffixed]);
    recordDecision(options, "branch_renamed", `Created suffixed branch ${suffixed}.`, {
      requested: branchName2,
      actual: suffixed
    });
    return { skipped: false, message: `Created ${suffixed}.`, branch: suffixed };
  }
  git(repoRoot, ["checkout", "-b", branchName2]);
  return { skipped: false, message: `Created ${branchName2}.`, branch: branchName2 };
}
function stagePaths(repoRoot, paths) {
  if (paths.length === 0) {
    return { skipped: true, message: "No paths to stage." };
  }
  git(repoRoot, ["add", "--", ...paths]);
  return { skipped: false, message: `Staged ${paths.length} paths.` };
}
function commit(repoRoot, message) {
  if (!hasStagedDiff(repoRoot)) {
    return { skipped: true, message: "No staged diff to commit." };
  }
  git(repoRoot, ["commit", "-m", message]);
  return { skipped: false, message };
}
function pushBranch(repoRoot, branchName2) {
  const local = git(repoRoot, ["rev-parse", branchName2]);
  const remote = tryGit(repoRoot, ["rev-parse", `origin/${branchName2}`]);
  if (remote && remote === local) {
    return { skipped: true, message: `origin/${branchName2} already matches local.`, branch: branchName2 };
  }
  git(repoRoot, ["push", "-u", "origin", branchName2]);
  return { skipped: false, message: `Pushed ${branchName2}.`, branch: branchName2 };
}
function getChangedFiles(repoRoot, baseRef) {
  if (baseRef) {
    return git(repoRoot, ["diff", "--name-only", baseRef]).split("\n").filter(Boolean);
  }
  return git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean).map((line) => parsePorcelainPath(line)).filter((path, index, paths) => path.length > 0 && paths.indexOf(path) === index);
}
function git(repoRoot, args) {
  rejectUnsafeGit(args);
  return execFileSync4("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function tryGit(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return void 0;
  }
}
function branchExists(repoRoot, branchName2) {
  return Boolean(tryGit(repoRoot, ["rev-parse", "--verify", branchName2])) || Boolean(tryGit(repoRoot, ["ls-remote", "--heads", "origin", branchName2]));
}
function nextAvailableBranch(repoRoot, branchName2) {
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${branchName2}-${index}`;
    if (!branchExists(repoRoot, candidate)) {
      return candidate;
    }
  }
  throw new AgentLoopError("policy_violation", "Could not find an available branch suffix.", {
    details: { branchName: branchName2 },
    exitCode: 2
  });
}
function hasStagedDiff(repoRoot) {
  try {
    git(repoRoot, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}
function parsePorcelainPath(line) {
  const renamed = line.slice(3).split(" -> ");
  return (renamed.at(-1) ?? "").trim().replace(/^"|"$/g, "");
}
function recordDecision(options, kind, message, details) {
  if (options.storage && options.runId) {
    options.storage.appendDecision({ runId: options.runId, kind, message, details });
  }
}
function rejectUnsafeGit(args) {
  const command = stripGitGlobalOptions2(args);
  if (command[0] === "reset" && command.includes("--hard")) {
    throw new AgentLoopError("policy_violation", "git reset --hard is not allowed.", { exitCode: 2 });
  }
  if (command[0] === "clean") {
    throw new AgentLoopError("policy_violation", "git clean is not allowed.", { exitCode: 2 });
  }
  if (command[0] === "rebase") {
    throw new AgentLoopError("policy_violation", "git rebase is not allowed.", { exitCode: 2 });
  }
  if (command[0] === "push" && command.some((arg) => arg === "-f" || arg.startsWith("--force"))) {
    throw new AgentLoopError("policy_violation", "force push is not allowed.", { exitCode: 2 });
  }
}
function stripGitGlobalOptions2(args) {
  const result = [...args];
  while (result.length > 0) {
    const first = result[0];
    if (first === "-C" || first === "--git-dir" || first === "--work-tree") {
      result.splice(0, 2);
      continue;
    }
    if (first?.startsWith("--git-dir=") || first?.startsWith("--work-tree=")) {
      result.shift();
      continue;
    }
    break;
  }
  return result;
}

// plugins/autonomous-pr-loop/core/gitnexus.ts
import { execFileSync as execFileSync5 } from "node:child_process";
function gitnexusStatus(repoRoot, config) {
  return runGitNexus(repoRoot, ["status"], config.gitnexusRequired);
}
function gitnexusAnalyze(repoRoot, config) {
  return runGitNexus(repoRoot, ["analyze"], config.gitnexusRequired);
}
function gitnexusDetectChanges(repoRoot, config, storage, runId) {
  const result = runGitNexus(repoRoot, ["detect_changes"], config.gitnexusRequired);
  if (!result.ok && config.gitnexusRequired) {
    throw new AgentLoopError("gitnexus_check_failed", "GitNexus detect_changes did not pass.", {
      details: { stdout: result.stdout, stderr: result.stderr },
      exitCode: 2
    });
  }
  if (!config.gitnexusRequired) {
    const artifact = writeArtifact(
      repoRoot,
      storage,
      runId,
      "log",
      "gitnexus-alternative-scope-check.txt",
      `stdout:
${result.stdout}

stderr:
${result.stderr}
`
    );
    storage.appendDecision({
      runId,
      kind: "gitnexus_not_required",
      message: "GitNexus detect_changes was not required; stored alternative scope evidence.",
      details: { artifactId: artifact.id, ok: result.ok }
    });
  }
  return result;
}
function runGitNexus(repoRoot, args, required) {
  try {
    const stdout = execFileSync5("npx", ["gitnexus", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, skipped: false, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const typed = error;
    const result = {
      ok: false,
      skipped: false,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message ?? ""
    };
    if (required && isToolUnavailable(typed)) {
      throw new AgentLoopError("required_tool_unavailable", "GitNexus is required but unavailable.", {
        details: { args, stderr: result.stderr, status: typed.status },
        exitCode: 2
      });
    }
    return result;
  }
}
function isToolUnavailable(error) {
  const text = `${error.stderr ?? ""}
${error.message ?? ""}`.toLowerCase();
  return error.status === 127 || text.includes("not found") || text.includes("could not determine executable");
}

// plugins/autonomous-pr-loop/core/review-comments.ts
function parseReviewThreads(payload) {
  const threads = findNodes(payload, "reviewThreads");
  return threads.flatMap(parseThread);
}
function actionableReviewComments(comments) {
  return comments.filter((comment) => comment.actionable && comment.status === "open");
}
function parseThread(thread) {
  if (!isRecord(thread)) {
    return [];
  }
  const isResolved = Boolean(thread.isResolved);
  const isOutdated = Boolean(thread.isOutdated);
  return findNodes(thread, "comments").map((comment) => normalizeComment(comment, isResolved, isOutdated));
}
function normalizeComment(comment, isResolved, isOutdated) {
  const row = isRecord(comment) ? comment : {};
  const actionable = !isResolved && !isOutdated && stringValue2(row.body).trim().length > 0;
  const line = numberValue(row.line);
  const normalized = {
    commentId: stringValue2(row.id),
    url: stringValue2(row.url),
    author: authorLogin(row.author),
    body: stringValue2(row.body),
    path: stringValue2(row.path),
    diffHunk: stringValue2(row.diffHunk),
    isResolved,
    isOutdated,
    actionable,
    status: actionable ? "open" : isOutdated ? "stale" : "handled"
  };
  if (line !== void 0) {
    normalized.line = line;
  }
  return normalized;
}
function findNodes(value, key) {
  if (!isRecord(value)) {
    return [];
  }
  const direct = value[key];
  if (isRecord(direct) && Array.isArray(direct.nodes)) {
    return direct.nodes;
  }
  const repository = value.repository;
  const pullRequest = isRecord(repository) ? repository.pullRequest : void 0;
  if (isRecord(pullRequest)) {
    return findNodes(pullRequest, key);
  }
  return [];
}
function authorLogin(value) {
  return isRecord(value) ? stringValue2(value.login) : "";
}
function numberValue(value) {
  return typeof value === "number" ? value : void 0;
}
function stringValue2(value) {
  return typeof value === "string" ? value : "";
}

// plugins/autonomous-pr-loop/core/policy.ts
function assertAllowedPath(config, path) {
  const blocked = config.protectedPaths.some((pattern) => matchesProtectedPath(pattern, path));
  if (blocked) {
    throw new AgentLoopError(
      "policy_violation",
      `Path is protected by agent-loop policy: ${path}`,
      { details: { path } }
    );
  }
}
function matchesProtectedPath(pattern, path) {
  const normalizedPattern = normalizePath(pattern);
  const normalizedPath = normalizePath(path);
  if (!normalizedPattern.includes("/")) {
    const basename3 = normalizedPath.split("/").at(-1) ?? normalizedPath;
    return globToRegExp(normalizedPattern).test(basename3);
  }
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (normalizedPath === prefix) {
      return true;
    }
  }
  return globToRegExp(normalizedPattern).test(normalizedPath);
}
function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  return new RegExp(`^${source}$`);
}
function escapeRegExp(value) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

// plugins/autonomous-pr-loop/core/pr-lifecycle.ts
async function executePrLifecycleStep(input) {
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
    return { message: "Lifecycle branch ready.", ...branch ? { branch } : {}, worktreeClean: true };
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
async function runSelfChecks(repoRoot, storage, runId, config, signal) {
  const runner = new CommandRunner({ repoRoot, storage, runId, config, signal });
  for (const command of [config.lintCommand, config.testCommand].filter(isDefined2)) {
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
async function commitPushPr(input) {
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
function assertPublishPrerequisites(input) {
  const selfCheckPassed = input.storage.hasRunCheck(input.run.id, "self_check");
  const detectRecorded = input.storage.hasRunCheck(input.run.id, "gitnexus_detect_changes");
  if (!selfCheckPassed || !detectRecorded) {
    throw new AgentLoopError("policy_violation", "Publish prerequisites are not satisfied.", {
      details: { selfCheckPassed, detectRecorded },
      exitCode: 2
    });
  }
}
function assertConditionalMergeReadiness(input, overrides = {}) {
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
function recordReviewApproval(input, reviewDecision) {
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
async function waitReviewOrCi(input) {
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
    await sleep2(input.config.reviewCiPollIntervalMs, input.signal);
  }
  throw new AgentLoopError("ci_pending_timeout", "Timed out waiting for review or CI.", { exitCode: 2 });
}
async function maybeMerge(input) {
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
      ...check.conclusion ? { conclusion: check.conclusion } : {},
      observedAt: (/* @__PURE__ */ new Date()).toISOString()
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
function branchName(input) {
  const workItem = getDeliveryWorkItem(input.storage, input.run.id);
  const selection = resolvePrSelection(input.repoRoot, input.config, {
    githubRequired: true,
    ...workItem ? { workItem } : {}
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
function parseConfiguredCommand(command, cwd) {
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
function approvalSatisfied(config, reviewDecision) {
  return !config.requireReviewApproval || reviewDecision === "APPROVED";
}
function githubOptions(input) {
  return input.signal ? { repoRoot: input.repoRoot, config: input.config, signal: input.signal } : { repoRoot: input.repoRoot, config: input.config };
}
function branchDiffersFromBase(repoRoot, baseBranch) {
  return getChangedFiles(repoRoot, `${baseBranch}...HEAD`).filter((file) => !isRuntimePath(file)).length > 0;
}
function isRuntimePath(path) {
  return path === ".agent-loop" || path.startsWith(".agent-loop/");
}
function sleep2(ms, signal) {
  return new Promise((resolve5, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve5();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new AgentLoopError("ci_pending_timeout", "Timed out waiting for review or CI was aborted.", {
        exitCode: 2
      }));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function tokenizeCommand(command) {
  const tokens = [];
  let current = "";
  let quote;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      if (char === quote) {
        quote = void 0;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
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
function isDefined2(value) {
  return value !== void 0;
}

// plugins/autonomous-pr-loop/core/worker.ts
import { spawn } from "node:child_process";
import { execFileSync as execFileSync7 } from "node:child_process";
import { randomUUID as randomUUID4, createHash as createHash6 } from "node:crypto";
import { chmodSync, existsSync as existsSync11, mkdirSync as mkdirSync4, readFileSync as readFileSync7, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname4, join as join8, resolve as resolve3 } from "node:path";

// plugins/autonomous-pr-loop/core/worker-policy.ts
function resolveWorkerPolicy(input) {
  const shape = resolveLoopShape(input.config.loopShape);
  const sandbox = sandboxForShapeState(shape.id, input.state, input.workerType);
  const allowedPaths = allowedPathsFor(input.config, input.state, input.workerType, sandbox);
  if (shape.id === "generic-loop" && sandbox === "workspace-write" && (!allowedPaths || allowedPaths.length === 0)) {
    throw new AgentLoopError("generic_scope_change_requested", "Generic write state has no allowed write roots.", {
      details: {
        loopShape: shape.id,
        state: input.state,
        workflowProfile: input.config.workflowProfile,
        required: "Configure a generic workflow profile with allowed write roots or approve a scoped change."
      },
      exitCode: 2
    });
  }
  return {
    sandbox,
    ...allowedPaths ? { allowedPaths } : {},
    protectedPaths: input.config.protectedPaths,
    commandPolicy: {
      lifecycleOwnedBySupervisor: true,
      allowedWriteRoots: allowedPaths ?? [],
      genericReadOnlyState: shape.id === "generic-loop" && sandbox === "read-only"
    }
  };
}
function allowedPathsFor(config, state, workerType, sandbox) {
  if (config.loopShape === "pr-loop") {
    if (workerType === "planner") {
      return [config.plansDir];
    }
    if (workerType === "reviewer") {
      return [];
    }
    return void 0;
  }
  if (sandbox === "read-only") {
    return [];
  }
  if (state === "EXECUTE_STEP" || state === "DELIVER") {
    return workflowProfileDefinition(config.workflowProfile).allowedWriteRoots ?? [];
  }
  return [];
}

// plugins/autonomous-pr-loop/core/worker-events.ts
import { createHash as createHash4 } from "node:crypto";
var KNOWN_ITEM_TYPES = [
  "agent_message",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "error"
];
var SUMMARY_LIMIT_BYTES = 8 * 1024;
function createWorkerJsonlStreamIngestor(input) {
  return new StreamingWorkerEventIngestor(input);
}
var StreamingWorkerEventIngestor = class {
  constructor(input) {
    this.input = input;
    this.rawWriter = createArtifactWriter(
      input.repoRoot,
      input.storage,
      input.runId,
      "worker-jsonl",
      `${input.workerId}.jsonl`
    );
  }
  input;
  buffer = "";
  rawWriter;
  currentThreadId;
  currentUsage;
  unknownCount = 0;
  finalized = false;
  get threadId() {
    return this.currentThreadId;
  }
  get unknownEventCount() {
    return this.unknownCount;
  }
  get rawJsonl() {
    return "";
  }
  ingestChunk(chunk) {
    if (this.finalized || chunk.length === 0) {
      return;
    }
    this.rawWriter.append(chunk);
    this.buffer += chunk;
    let newline = this.buffer.search(/\r?\n/);
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      const delimiterLength = this.buffer[newline] === "\r" && this.buffer[newline + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(newline + delimiterLength);
      this.ingestLine(line);
      newline = this.buffer.search(/\r?\n/);
    }
  }
  finalize() {
    if (!this.finalized) {
      if (this.buffer.trim().length > 0) {
        if (parseLine(this.buffer)) {
          this.ingestLine(this.buffer);
        } else {
          this.appendEvent("worker_jsonl_partial_line", void 0, {
            truncated: true,
            length: this.buffer.length,
            sha256: sha2564(this.buffer)
          });
        }
        this.buffer = "";
      }
      this.finalized = true;
    }
    const raw = this.rawWriter.finalize();
    return {
      ...this.currentThreadId ? { threadId: this.currentThreadId } : {},
      unknownEventCount: this.unknownCount,
      ...this.currentUsage ? { usage: this.currentUsage } : {},
      rawJsonlArtifactId: raw.id
    };
  }
  ingestLine(line) {
    if (line.trim().length === 0) {
      return;
    }
    const parsed = parseLine(line);
    if (!parsed) {
      this.unknownCount += 1;
      return;
    }
    const type = eventType(parsed);
    const threadId = extractThreadId(parsed) ?? this.currentThreadId;
    this.currentThreadId = threadId;
    const usage = extractUsage(parsed);
    this.currentUsage = usage ?? this.currentUsage;
    if (type === "thread.started") {
      this.appendEvent(type, void 0, { threadId }, { ...threadId ? { threadId } : {} });
      return;
    }
    if (type === "turn.started" || type === "turn.completed" || type === "turn.failed") {
      this.appendEvent(type, void 0, summarizeTurn(parsed), {
        ...threadId ? { threadId } : {},
        ...usage ? { usage } : {}
      });
      return;
    }
    if (type === "item.started" || type === "item.updated" || type === "item.completed" || type === "item.failed") {
      const itemType = extractItemType(parsed);
      if (!isKnownItemType(itemType)) {
        this.unknownCount += 1;
        return;
      }
      this.appendEvent(type, itemType, summarizeItem(parsed, itemType), {
        ...threadId ? { threadId } : {},
        ...optionalString("itemId", extractItemId(parsed)),
        ...optionalString("itemStatus", extractItemStatus(parsed, type)),
        ...usage ? { usage } : {}
      });
      return;
    }
    this.unknownCount += 1;
  }
  appendEvent(eventTypeValue, itemType, summary, options = {}) {
    const normalized = normalizeSummary(summary, {
      repoRoot: this.input.repoRoot,
      storage: this.input.storage,
      runId: this.input.runId,
      workerId: this.input.workerId,
      eventType: eventTypeValue,
      ...options.itemId ? { itemId: options.itemId } : {}
    });
    return this.input.storage.appendWorkerEvent({
      workerId: this.input.workerId,
      runId: this.input.runId,
      eventType: eventTypeValue,
      ...itemType ? { itemType } : {},
      ...options.itemId ? { itemId: options.itemId } : {},
      ...options.itemStatus ? { itemStatus: options.itemStatus } : {},
      ...options.threadId ? { threadId: options.threadId } : this.currentThreadId ? { threadId: this.currentThreadId } : {},
      backend: this.input.backend,
      summary: normalized.summary,
      ...options.usage ? { usage: options.usage } : {},
      ...normalized.artifactIds.length ? { artifactIds: normalized.artifactIds } : {}
    });
  }
};
function parseLine(line) {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function eventType(value) {
  return stringValue3(value.type) ?? stringValue3(value.event) ?? stringValue3(value.eventType) ?? "unknown";
}
function extractThreadId(value) {
  return stringValue3(value.thread_id) ?? stringValue3(value.threadId) ?? stringValue3(value.id) ?? stringValue3(recordValue(value.thread)?.id) ?? stringValue3(recordValue(value.session)?.id);
}
function extractItemType(value) {
  const item = recordValue(value.item);
  return stringValue3(value.item_type) ?? stringValue3(value.itemType) ?? stringValue3(item?.type);
}
function extractItemId(value) {
  const item = recordValue(value.item);
  return stringValue3(value.item_id) ?? stringValue3(value.itemId) ?? stringValue3(item?.id);
}
function extractItemStatus(value, eventTypeValue) {
  const item = recordValue(value.item);
  return stringValue3(value.item_status) ?? stringValue3(value.itemStatus) ?? stringValue3(item?.status) ?? eventTypeValue.split(".").at(-1);
}
function extractUsage(value) {
  return value.usage ?? recordValue(value.turn)?.usage;
}
function summarizeTurn(value) {
  return redactSummary({
    type: eventType(value),
    threadId: extractThreadId(value),
    usage: extractUsage(value),
    error: stringValue3(value.error) ?? stringValue3(recordValue(value.turn)?.error)
  });
}
function summarizeItem(value, itemType) {
  const item = recordValue(value.item) ?? value;
  const base = {
    id: extractItemId(value),
    type: itemType,
    status: extractItemStatus(value, eventType(value))
  };
  if (itemType === "agent_message") {
    const text = stringValue3(item.text) ?? stringValue3(item.message) ?? stringValue3(item.content);
    return redactSummary({ ...base, message: text ? summarizeText(text) : void 0 });
  }
  if (itemType === "command_execution") {
    return redactSummary({
      ...base,
      command: item.command,
      exitCode: item.exit_code ?? item.exitCode,
      stdout: summarizeMaybeText(item.stdout),
      stderr: summarizeMaybeText(item.stderr),
      startedAt: stringValue3(item.started_at) ?? stringValue3(item.startedAt),
      completedAt: stringValue3(item.completed_at) ?? stringValue3(item.completedAt)
    });
  }
  if (itemType === "file_change") {
    return redactSummary({ ...base, path: item.path, operation: item.operation, changes: summarizeOpaquePayload(item.changes) });
  }
  if (itemType === "mcp_tool_call") {
    return redactSummary({ ...base, server: item.server, tool: item.tool ?? item.name, result: summarizeMaybeText(item.result) });
  }
  if (itemType === "web_search") {
    return redactSummary({ ...base, query: item.query, url: item.url, resultCount: item.result_count ?? item.resultCount });
  }
  if (itemType === "todo_list") {
    const todos = Array.isArray(item.todos) ? item.todos : Array.isArray(item.items) ? item.items : void 0;
    return redactSummary({ ...base, count: todos?.length, todos: todos?.slice(0, 20) });
  }
  return redactSummary({ ...base, message: item.message, error: item.error });
}
function summarizeMaybeText(value) {
  return typeof value === "string" ? summarizeText(value) : value;
}
function summarizeOpaquePayload(value) {
  if (value === void 0) {
    return void 0;
  }
  const redacted = redactSummary(value);
  const json = JSON.stringify(redacted);
  return {
    length: json.length,
    sha256: sha2564(json),
    type: Array.isArray(value) ? "array" : typeof value
  };
}
function summarizeText(text) {
  return {
    length: text.length,
    sha256: sha2564(text),
    preview: redactSecrets(text.slice(0, 240)),
    truncated: text.length > 240
  };
}
function normalizeSummary(summary, artifactContext) {
  const redacted = redactSummary(summary);
  const json = JSON.stringify(redacted);
  if (Buffer.byteLength(json, "utf8") <= SUMMARY_LIMIT_BYTES) {
    return { summary: redacted, artifactIds: [] };
  }
  const hash = sha2564(json);
  const artifact = writeArtifact(
    artifactContext.repoRoot,
    artifactContext.storage,
    artifactContext.runId,
    "log",
    `${artifactContext.workerId}-${safeName(artifactContext.eventType)}-${safeName(artifactContext.itemId ?? hash.slice(0, 12))}.summary.json`,
    json
  );
  return {
    summary: {
      truncated: true,
      length: json.length,
      sha256: hash,
      artifactId: artifact.id
    },
    artifactIds: [artifact.id]
  };
}
function redactSummary(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactSummary);
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const redacted = {};
  for (const [key, nested] of Object.entries(value).slice(0, 40)) {
    redacted[key] = isSecretKey(key) ? "[redacted]" : redactSummary(nested);
  }
  return redacted;
}
function isKnownItemType(value) {
  return value !== void 0 && KNOWN_ITEM_TYPES.includes(value);
}
function recordValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function stringValue3(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function optionalString(key, value) {
  return value ? { [key]: value } : {};
}
function sha2564(value) {
  return createHash4("sha256").update(value).digest("hex");
}
function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "event";
}

// plugins/autonomous-pr-loop/core/scope-guard.ts
import { execFileSync as execFileSync6 } from "node:child_process";
import { createHash as createHash5 } from "node:crypto";
import { closeSync as closeSync2, existsSync as existsSync10, openSync as openSync2, readSync, statSync as statSync3 } from "node:fs";
import { join as join7 } from "node:path";
function captureScopeBaseline(repoRoot) {
  return readPorcelainPaths(repoRoot).map((path) => ({ path, digest: digestPath(repoRoot, path) }));
}
function evaluateWorkerScope(input) {
  const after = readPorcelainPaths(input.repoRoot).map((path) => ({ path, digest: digestPath(input.repoRoot, path) }));
  const baseline = new Map(input.baseline.map((entry) => [entry.path, entry.digest]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry.digest]));
  const actualChangedFiles = unique([...baseline.keys(), ...afterMap.keys()]).filter((path) => baseline.get(path) !== afterMap.get(path)).filter((path) => !isSupervisorRuntimePath(path, input.runId, input.workerId));
  const workerPaths = [...input.result.changedFiles, ...input.result.outOfScope.map((item) => item.item)];
  const invalidWorkerPaths = unique(workerPaths.filter((path) => !isSafeRepoRelativePath(path)));
  const reportedChangedFiles = unique(input.result.changedFiles.filter(isSafeRepoRelativePath));
  const missingFromReport = actualChangedFiles.filter((path) => !reportedChangedFiles.includes(path));
  const extraInReport = reportedChangedFiles.filter((path) => !actualChangedFiles.includes(path));
  const protectedPathHits = actualChangedFiles.filter(
    (path) => input.config.protectedPaths.some((pattern) => matchesProtectedPath(pattern, path))
  );
  const outOfScope = [
    ...input.result.outOfScope,
    ...actualChangedFiles.filter((path) => !isAllowed(path, input.allowedPaths)).map((path) => ({ item: path, reason: "Changed path is outside worker allowed paths." }))
  ];
  const gate = invalidWorkerPaths.length > 0 ? "policy_violation" : protectedPathHits.length > 0 ? "policy_violation" : outOfScope.length > 0 ? input.outOfScopeGate ?? "review_out_of_scope" : input.config.gitnexusRequired && (!input.result.gitnexus.impactRun || !input.result.gitnexus.detectChangesRun) ? "policy_violation" : void 0;
  if (missingFromReport.length > 0 || extraInReport.length > 0) {
    input.storage.appendEvent({
      runId: input.runId,
      kind: "worker_changed_files_mismatch",
      message: "Worker changedFiles did not match git status.",
      payload: {
        workerId: input.workerId,
        actualChangedFiles,
        reportedChangedFiles,
        missingFromReport,
        extraInReport
      }
    });
  }
  return {
    ok: gate === void 0,
    actualChangedFiles,
    reportedChangedFiles,
    missingFromReport,
    extraInReport,
    protectedPathHits,
    invalidWorkerPaths,
    outOfScope,
    ...gate ? { gate } : {}
  };
}
function readPorcelainPaths(repoRoot) {
  const output = execFileSync6("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return parsePorcelainPaths(output);
}
function digestPath(repoRoot, path) {
  const absolutePath = join7(repoRoot, path);
  if (!existsSync10(absolutePath)) {
    return null;
  }
  const stat = statSync3(absolutePath);
  if (!stat.isFile()) {
    return "directory";
  }
  return hashFile(absolutePath);
}
function hashFile(path) {
  const hash = createHash5("sha256");
  const fd = openSync2(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    }
    return hash.digest("hex");
  } finally {
    closeSync2(fd);
  }
}
function parsePorcelainPaths(output) {
  const records = output.toString("utf8").split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path) {
      paths.push(normalizePath2(path));
    }
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }
  return unique(paths);
}
function isAllowed(path, allowedPaths) {
  if (!allowedPaths) {
    return true;
  }
  return allowedPaths.some((allowedPath) => {
    const normalized = normalizePath2(allowedPath);
    const file = normalizePath2(path);
    return file === normalized || file.startsWith(`${normalized.replace(/\/$/, "")}/`);
  });
}
function normalizePath2(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
function isSafeRepoRelativePath(path) {
  const normalized = normalizePath2(path);
  return normalized.length > 0 && !normalized.startsWith("/") && !normalized.split("/").includes("..");
}
function unique(values) {
  return [...new Set(values)];
}
function isSupervisorRuntimePath(path, runId, workerId) {
  return path === `.agent-loop/artifacts/${runId}/worker-jsonl/${workerId}.jsonl` || path === `.agent-loop/artifacts/${runId}/worker-result/${workerId}-worker-final.json` || path === ".agent-loop/state.sqlite" || path === ".agent-loop/state.sqlite-shm" || path === ".agent-loop/state.sqlite-wal";
}

// plugins/autonomous-pr-loop/core/worker.ts
async function executeWorker(input) {
  if (input.config.workerBackend === "codex-app-server") {
    const probe = await probeCodexAppServer(input.repoRoot, input.config.workerTimeoutMs);
    const probeArtifact = writeArtifact(
      input.repoRoot,
      input.storage,
      input.run.id,
      "log",
      "codex-app-server-probe.json",
      `${JSON.stringify(probe, null, 2)}
`
    );
    const code = probe.status === "success" ? "worker_failed" : "required_tool_unavailable";
    const message = probe.status === "success" ? "codex-app-server capability probe succeeded, but worker execution through app-server is not implemented in PR H2." : "codex-app-server backend is unavailable.";
    throw new AgentLoopError(code, message, {
      details: { backend: "codex-app-server", probe, artifactId: probeArtifact.id },
      exitCode: 2
    });
  }
  clearOrRejectRunningWorker(input.storage, input.config.workerTimeoutMs);
  const policy = resolveWorkerPolicy({
    config: input.config,
    state: input.state,
    workerType: input.type
  });
  const worker = input.storage.createWorker({
    runId: input.run.id,
    type: input.type,
    backend: input.config.workerBackend,
    attempt: 0,
    resumeUsed: false
  });
  const prompt = buildWorkerPrompt({ ...input, profile: resolveProfile(input.config, input.state), policy });
  const promptArtifact = writeArtifact(
    input.repoRoot,
    input.storage,
    input.run.id,
    "worker-prompt",
    `${worker.id}.md`,
    prompt
  );
  const commandPlan = buildWorkerCommandPlan(input.repoRoot, input.run.id, input.config, input.type, promptArtifact.path, worker.id, policy.sandbox);
  assertWorkerCommandAllowed(commandPlan);
  if (input.dryRun) {
    const planArtifact = writeArtifact(
      input.repoRoot,
      input.storage,
      input.run.id,
      "dry-run-plan",
      `${worker.id}-worker-command.json`,
      `${JSON.stringify(commandPlan, null, 2)}
`
    );
    const updated = input.storage.updateWorker(worker.id, {
      status: "succeeded",
      completedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    input.storage.appendEvent({
      runId: input.run.id,
      kind: "worker_dry_run",
      message: `Prepared ${input.type} worker prompt without executing codex.`,
      payload: { workerId: worker.id, commandPlan },
      artifactIds: [promptArtifact.id, planArtifact.id]
    });
    return { worker: updated, artifacts: [promptArtifact, planArtifact], commandPlan };
  }
  return await runWithRetry({
    ...input,
    initialWorker: worker,
    prompt,
    promptArtifact,
    commandPlan
  });
}
function buildWorkerCommandPlan(repoRoot, runId, config, type, promptPath, workerId, sandbox = workerSandbox(type), resumeThreadId) {
  const outputSchemaPath = join8(pluginRoot(), "plugins", "autonomous-pr-loop", "schemas", "worker-result.schema.json");
  const outputLastMessagePath = join8(
    repoRoot,
    ".agent-loop",
    "artifacts",
    runId,
    "worker-result",
    `${workerId}-worker-final.json`
  );
  mkdirSync4(dirname4(outputLastMessagePath), { recursive: true });
  const args = [
    "exec",
    "-C",
    repoRoot,
    "-s",
    sandbox,
    "--json",
    "--output-schema",
    outputSchemaPath,
    "--output-last-message",
    outputLastMessagePath
  ];
  if (config.workerEphemeral) {
    args.push("--ephemeral");
  }
  if (resumeThreadId) {
    args.push("resume", resumeThreadId, "Retry once. Return valid JSON matching the required schema.");
  }
  return {
    file: "codex",
    args,
    cwd: repoRoot,
    sandbox,
    promptPath,
    outputSchemaPath,
    outputLastMessagePath
  };
}
function pluginRoot() {
  return resolve3(import.meta.dirname, "../../..");
}
function assertWorkerCommandAllowed(plan) {
  const policy = evaluatePolicy({ file: plan.file, args: plan.args });
  if (!policy.allowed) {
    throw new AgentLoopError("policy_violation", policy.reason ?? "Worker command rejected by policy.", {
      details: { plan },
      exitCode: 2
    });
  }
}
async function runWithRetry(input) {
  let worker = input.initialWorker;
  let commandPlan = input.commandPlan;
  let threadId;
  for (let attempt = 0; attempt <= input.config.workerMaxRetries; attempt += 1) {
    const spawnContext = createWorkerSpawnContext(commandPlan.cwd, worker.id, commandPlan.file);
    const baseline = captureScopeBaseline(input.repoRoot);
    const ingestor = createWorkerJsonlStreamIngestor({
      repoRoot: input.repoRoot,
      storage: input.storage,
      runId: input.run.id,
      workerId: worker.id,
      backend: input.config.workerBackend
    });
    const runResult = await spawnCodexWorker(
      commandPlan,
      input.prompt,
      input.config.workerTimeoutMs,
      spawnContext,
      (chunk) => ingestor.ingestChunk(chunk),
      input.signal
    );
    const ingest = ingestor.finalize();
    threadId = ingest.threadId ?? threadId;
    const rawJsonlArtifactId = ingest.rawJsonlArtifactId;
    if (runResult.timedOut) {
      input.storage.updateWorker(worker.id, {
        status: "timed_out",
        ...threadId ? { threadId } : {},
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        exitCode: 124,
        rawJsonlArtifactId,
        error: "Worker timed out."
      });
      throw new AgentLoopError("worker_timeout", "Codex worker timed out.", {
        details: workerGateDetails(worker, {
          ...threadId ? { threadId } : {},
          timeoutMs: input.config.workerTimeoutMs
        }),
        exitCode: 2
      });
    }
    if (runResult.exitCode !== 0) {
      input.storage.updateWorker(worker.id, {
        status: "failed",
        ...threadId ? { threadId } : {},
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        exitCode: runResult.exitCode,
        rawJsonlArtifactId,
        error: runResult.stderr || `codex exited ${runResult.exitCode}`
      });
      if (attempt < input.config.workerMaxRetries) {
        worker = input.storage.createWorker({
          runId: input.run.id,
          type: input.type,
          backend: input.config.workerBackend,
          attempt: attempt + 1,
          resumeUsed: threadId !== void 0
        });
        commandPlan = buildWorkerCommandPlan(
          input.repoRoot,
          input.run.id,
          input.config,
          input.type,
          input.promptArtifact.path,
          worker.id,
          resolveWorkerPolicy({ config: input.config, state: input.state, workerType: input.type }).sandbox,
          threadId
        );
        assertWorkerCommandAllowed(commandPlan);
        continue;
      }
      throw new AgentLoopError("worker_failed", "Codex worker failed.", {
        details: workerGateDetails(worker, {
          ...threadId ? { threadId } : {},
          exitCode: runResult.exitCode,
          error: runResult.stderr || `codex exited ${runResult.exitCode}`
        }),
        exitCode: 1
      });
    }
    const parsed = parseWorkerResult(commandPlan.outputLastMessagePath);
    if (!parsed.ok) {
      input.storage.updateWorker(worker.id, {
        status: "invalid_output",
        ...threadId ? { threadId } : {},
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        exitCode: 0,
        rawJsonlArtifactId,
        error: parsed.error
      });
      if (attempt < input.config.workerMaxRetries) {
        worker = input.storage.createWorker({
          runId: input.run.id,
          type: input.type,
          backend: input.config.workerBackend,
          attempt: attempt + 1,
          resumeUsed: threadId !== void 0
        });
        commandPlan = buildWorkerCommandPlan(
          input.repoRoot,
          input.run.id,
          input.config,
          input.type,
          input.promptArtifact.path,
          worker.id,
          resolveWorkerPolicy({ config: input.config, state: input.state, workerType: input.type }).sandbox,
          threadId
        );
        assertWorkerCommandAllowed(commandPlan);
        continue;
      }
      throw new AgentLoopError("worker_output_invalid", "Worker output did not match schema.", {
        details: workerGateDetails(worker, {
          ...threadId ? { threadId } : {},
          error: parsed.error
        }),
        exitCode: 2
      });
    }
    const resultArtifact = persistExistingResult(
      input.repoRoot,
      input.storage,
      input.run.id,
      commandPlan.outputLastMessagePath,
      `${worker.id}-worker-final.json`
    );
    if (!parsed.result.ok) {
      input.storage.updateWorker(worker.id, {
        status: "failed",
        ...threadId ? { threadId } : {},
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        exitCode: 0,
        resultArtifactId: resultArtifact.id,
        rawJsonlArtifactId,
        error: parsed.result.error?.message ?? parsed.result.summary
      });
      throw new AgentLoopError("worker_failed", "Worker reported failure.", {
        details: workerGateDetails(worker, {
          ...threadId ? { threadId } : {},
          error: parsed.result.error?.message ?? parsed.result.summary,
          result: parsed.result
        }),
        exitCode: 1
      });
    }
    const scope = evaluateWorkerScope({
      repoRoot: input.repoRoot,
      storage: input.storage,
      runId: input.run.id,
      workerId: worker.id,
      config: input.config,
      baseline,
      result: parsed.result,
      ...optionalAllowedPaths(input.type, input.config, input.state),
      ...input.config.loopShape === "generic-loop" ? { outOfScopeGate: "generic_scope_change_requested" } : {}
    });
    const updated = input.storage.updateWorker(worker.id, {
      status: "succeeded",
      ...threadId ? { threadId } : {},
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      exitCode: 0,
      resultArtifactId: resultArtifact.id,
      rawJsonlArtifactId
    });
    input.storage.appendEvent({
      runId: input.run.id,
      kind: "worker_completed",
      message: `${input.type} worker completed.`,
      payload: { workerId: worker.id, result: parsed.result, scope },
      artifactIds: [input.promptArtifact.id, resultArtifact.id, rawJsonlArtifactId]
    });
    if (scope.gate) {
      throw new AgentLoopError(scope.gate, "Worker scope guard blocked progress.", {
        details: scope.gate === "generic_scope_change_requested" ? genericScopeGateDetails(input.config, input.state, scope) : scope,
        exitCode: 2
      });
    }
    return {
      worker: updated,
      result: parsed.result,
      scope,
      artifacts: [input.promptArtifact, resultArtifact],
      commandPlan
    };
  }
  throw new AgentLoopError("storage_error", "Worker retry loop ended unexpectedly.");
}
function workerGateDetails(worker, extra) {
  return {
    workerId: worker.id,
    workerType: worker.type,
    attempt: worker.attempt,
    ...worker.threadId === void 0 ? {} : { threadId: worker.threadId },
    ...extra
  };
}
async function probeCodexAppServer(repoRoot, workerTimeoutMs) {
  const codexPath = resolveOptionalExecutable("codex", process.env.PATH ?? "");
  if (!codexPath) {
    return { success: false, status: "command_missing" };
  }
  try {
    execFileSync7(codexPath, ["app-server", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Math.min(workerTimeoutMs, 5e3)
    });
  } catch (error) {
    const helpExitCode = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : void 0;
    const result = {
      success: false,
      status: "help_failed",
      stderr: error instanceof Error ? error.message : String(error)
    };
    if (typeof helpExitCode === "number" && Number.isFinite(helpExitCode)) {
      result.helpExitCode = helpExitCode;
    }
    return result;
  }
  return await new Promise((resolve5) => {
    const child = spawn(codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve5(result);
    };
    const timer = setTimeout(() => {
      finish({ success: false, status: "handshake_timeout", responsePreview: stdout.slice(0, 500), stderr: stderr.slice(0, 500) });
    }, 3e3);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1 && parsed.result !== void 0) {
            finish({ success: true, status: "success", responsePreview: line.slice(0, 500) });
            return;
          }
          if (parsed.id === 1 && parsed.error !== void 0) {
            finish({ success: false, status: "protocol_mismatch", responsePreview: line.slice(0, 500) });
            return;
          }
        } catch {
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ success: false, status: "startup_failed", stderr: error.message });
    });
    child.on("close", () => {
      finish({ success: false, status: stdout ? "protocol_mismatch" : "startup_failed", responsePreview: stdout.slice(0, 500), stderr: stderr.slice(0, 500) });
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}
`);
  });
}
async function spawnCodexWorker(plan, prompt, timeoutMs, spawnContext, onStdoutChunk, signal) {
  return await new Promise((resolve5) => {
    const child = spawn(spawnContext.executablePath, plan.args, {
      cwd: plan.cwd,
      env: spawnContext.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer;
    const appendStderr = (message) => {
      stderr = `${stderr}${stderr ? "\n" : ""}${message}`;
    };
    const finish = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        resolve5(result);
      }
    };
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        signalProcessTree(child.pid, child, "SIGTERM");
        killTimer = setTimeout(() => {
          signalProcessTree(child.pid, child, "SIGKILL");
          finish({ exitCode: 124, stderr, timedOut: true });
        }, 1e3);
      }
    }, timeoutMs);
    const abort = () => {
      if (!settled) {
        timedOut = true;
        signalProcessTree(child.pid, child, "SIGTERM");
        killTimer = setTimeout(() => {
          signalProcessTree(child.pid, child, "SIGKILL");
          finish({ exitCode: 130, stderr, timedOut: true });
        }, 1e3);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      onStdoutChunk(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      appendStderr(error.message);
      finish({ exitCode: 1, stderr, timedOut: false });
    });
    child.on("close", (code, closeSignal) => {
      signal?.removeEventListener("abort", abort);
      finish({ exitCode: code ?? 1, stderr, timedOut: timedOut || closeSignal === "SIGTERM" });
    });
    child.stdin.on("error", (error) => {
      if (!isClosedWorkerStdinError(error)) {
        appendStderr(error.message);
      }
    });
    try {
      child.stdin.end(prompt);
    } catch (error) {
      if (!isClosedWorkerStdinError(error)) {
        appendStderr(errorMessage2(error));
      }
    }
  });
}
function isClosedWorkerStdinError(error) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
function createWorkerSpawnContext(repoRoot, workerId, executable) {
  const originalPath = process.env.PATH ?? "";
  const executablePath = resolveExecutable(executable, originalPath);
  const binDir = join8(repoRoot, ".agent-loop", "worker-policy-bin", workerId);
  mkdirSync4(binDir, { recursive: true });
  writeShim(join8(binDir, "git"), gitShim(resolveOptionalExecutable("git", originalPath)));
  writeShim(join8(binDir, "gh"), ghShim(resolveOptionalExecutable("gh", originalPath)));
  writeShim(join8(binDir, "codex"), codexShim(resolveOptionalExecutable("codex", originalPath)));
  return {
    executablePath,
    env: {
      ...process.env,
      PATH: `${binDir}:${originalPath}`,
      AGENT_LOOP_WORKER_POLICY: "1"
    }
  };
}
function writeShim(path, content) {
  writeFileSync4(path, content);
  chmodSync(path, 493);
}
function gitShim(realPath) {
  return `#!/bin/sh
cmd="$1"
while [ "$cmd" = "-c" ] || [ "$cmd" = "-C" ]; do
  shift 2 || exit 126
  cmd="$1"
done
case "$cmd" in
  commit|push|rebase|reset|clean|merge) echo "agent-loop worker policy denied git side effect" >&2; exit 126 ;;
esac
${execLine(realPath)}
`;
}
function ghShim(realPath) {
  return `#!/bin/sh
case "$1 $2" in
  "repo delete"|"pr create"|"pr ready"|"pr merge"|"pr close"|"pr comment") echo "agent-loop worker policy denied gh side effect" >&2; exit 126 ;;
esac
${execLine(realPath)}
`;
}
function codexShim(realPath) {
  return `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --dangerously-bypass-approvals-and-sandbox|danger-full-access) echo "agent-loop worker policy denied danger sandbox" >&2; exit 126 ;;
  esac
done
if [ "$1" = "exec" ]; then
  echo "agent-loop worker policy denied nested codex exec" >&2
  exit 126
fi
${execLine(realPath)}
`;
}
function execLine(realPath) {
  return realPath ? `exec ${shellQuote(realPath)} "$@"` : 'echo "command unavailable" >&2; exit 127';
}
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function resolveExecutable(file, pathValue) {
  const resolved = resolveOptionalExecutable(file, pathValue);
  if (!resolved) {
    throw new AgentLoopError("required_tool_unavailable", `Required executable not found: ${file}`, {
      details: { file },
      exitCode: 2
    });
  }
  return resolved;
}
function resolveOptionalExecutable(file, pathValue) {
  try {
    return execFileSync7("which", [file], {
      encoding: "utf8",
      env: { ...process.env, PATH: pathValue },
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return void 0;
  }
}
function signalProcessTree(pid, child, signal) {
  try {
    if (pid) {
      process.kill(-pid, signal);
      return;
    }
  } catch {
  }
  child.kill(signal);
}
function parseWorkerResult(path) {
  if (!existsSync11(path)) {
    return { ok: false, error: `Missing worker final output: ${path}` };
  }
  try {
    const parsed = JSON.parse(readFileSync7(path, "utf8"));
    return isWorkerResult(parsed) ? { ok: true, result: parsed } : { ok: false, error: "Worker final output failed structural validation." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function isWorkerResult(value) {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.ok === "boolean" && typeof value.summary === "string" && isStringArray(value.changedFiles) && Array.isArray(value.commandsRun) && value.commandsRun.every(isCommandRun) && isStringArray(value.testsRun) && isRecord(value.gitnexus) && typeof value.gitnexus.impactRun === "boolean" && typeof value.gitnexus.detectChangesRun === "boolean" && Array.isArray(value.outOfScope) && value.outOfScope.every(isOutOfScope) && isStringArray(value.followUps);
}
function isCommandRun(value) {
  return isRecord(value) && typeof value.command === "string" && Number.isInteger(value.exitCode);
}
function isOutOfScope(value) {
  return isRecord(value) && typeof value.item === "string" && typeof value.reason === "string";
}
function persistExistingResult(repoRoot, storage, runId, path, name) {
  const content = readFileSync7(path);
  const record = {
    id: randomUUID4(),
    runId,
    kind: "worker-result",
    name,
    path,
    sha256: createHash6("sha256").update(content).digest("hex"),
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  storage.insertArtifact(record);
  return record;
}
function clearOrRejectRunningWorker(storage, workerTimeoutMs) {
  const running = storage.getRunningWorker();
  if (!running) {
    return;
  }
  const ageMs = Date.now() - Date.parse(running.startedAt);
  if (Number.isFinite(ageMs) && ageMs > workerTimeoutMs) {
    storage.updateWorker(running.id, {
      status: "failed",
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      exitCode: 124,
      error: "Stale running worker cleaned before spawning a new worker."
    });
    storage.appendEvent({
      runId: running.runId,
      kind: "stale_worker_cleaned",
      message: `Cleaned stale running worker ${running.id}.`,
      payload: { workerId: running.id, ageMs, workerTimeoutMs }
    });
    return;
  }
  throw new AgentLoopError("worker_already_running", "Another worker is already running.", {
    details: { workerId: running.id, runId: running.runId, startedAt: running.startedAt },
    exitCode: 2
  });
}
function optionalAllowedPaths(type, config, state) {
  const allowedPaths = resolveWorkerPolicy({ config, state, workerType: type }).allowedPaths;
  return allowedPaths ? { allowedPaths } : {};
}
function genericScopeGateDetails(config, state, scope) {
  return {
    ...typeof scope === "object" && scope !== null && !Array.isArray(scope) ? scope : {},
    loopShape: config.loopShape,
    workflowProfile: config.workflowProfile,
    state,
    allowedNextStates: ["PLAN_WORK", "STOPPED"],
    defaultNextState: "PLAN_WORK",
    requiredPayload: { nextState: "PLAN_WORK", source: "ui" }
  };
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// plugins/autonomous-pr-loop/core/state-machine.ts
var LOOP_STATES = [.../* @__PURE__ */ new Set([...PR_LOOP_SHAPE.states, ...GENERIC_LOOP_SHAPE.states])];
var TERMINAL_STATES = [.../* @__PURE__ */ new Set([...PR_LOOP_SHAPE.terminalStates, ...GENERIC_LOOP_SHAPE.terminalStates])];
var TRANSITIONS = [...PR_LOOP_SHAPE.transitions, ...GENERIC_LOOP_SHAPE.transitions];
function validateTransitionTable() {
  const errors = [];
  for (const shape of [PR_LOOP_SHAPE, GENERIC_LOOP_SHAPE]) {
    const states = new Set(shape.states);
    for (const transition of shape.transitions) {
      if (!states.has(transition.from)) {
        errors.push(`${shape.id}: unknown from state: ${transition.from}`);
      }
      if (!states.has(transition.to)) {
        errors.push(`${shape.id}: unknown to state: ${transition.to}`);
      }
    }
    for (const state of shape.states) {
      const terminal = shape.terminalStates.includes(state);
      const hasExit = shape.transitions.some((transition) => transition.from === state);
      if (!terminal && !hasExit) {
        errors.push(`${shape.id}: state has no exit: ${state}`);
      }
      if (state !== "STOPPED" && state !== "COMPLETE" && !shape.transitions.some((transition) => transition.from === state && transition.to === "STOPPED" && transition.trigger === "stop")) {
        errors.push(`${shape.id}: state has no stop transition: ${state}`);
      }
    }
    const reachable = /* @__PURE__ */ new Set([shape.initialState]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const transition of shape.transitions) {
        if (reachable.has(transition.from) && !reachable.has(transition.to)) {
          reachable.add(transition.to);
          changed = true;
        }
      }
    }
    for (const state of shape.states.filter((item) => !shape.terminalStates.includes(item))) {
      if (!reachable.has(state)) {
        errors.push(`${shape.id}: state is unreachable: ${state}`);
      }
    }
  }
  return errors;
}
function planState(state, repoRoot) {
  if (state === "SYNC_MAIN") {
    return [
      {
        id: "git-status",
        file: "git",
        args: ["status", "--short", "--branch"],
        cwd: repoRoot,
        purpose: "Inspect current worktree before loop progress."
      },
      {
        id: "git-branch",
        file: "git",
        args: ["branch", "--show-current"],
        cwd: repoRoot,
        purpose: "Record branch for resume reality checks."
      }
    ];
  }
  if (state === "DISCOVER_PROGRESS") {
    return [
      {
        id: "git-work-tree",
        file: "git",
        args: ["rev-parse", "--is-inside-work-tree"],
        cwd: repoRoot,
        purpose: "Confirm repo context before selecting next PR."
      }
    ];
  }
  return [];
}
async function runStateMachine(options) {
  assertTransitionTable();
  const storage = new SqliteAgentLoopStorage(statePath(options.repoRoot));
  try {
    const configResult = tryLoadConfig(options.repoRoot);
    const shape = configResult.ok ? resolveLoopShape(applyProfileConfig(configResult.config).loopShape) : PR_LOOP_SHAPE;
    const run = ensureRun(storage, options.repoRoot, shape);
    if (!configResult.ok) {
      return blockRun(storage, run, "needs_repo_init", configResult.error.message, configResult.error.details);
    }
    const effectiveConfig = applyProfileConfig(configResult.config);
    auditProfileSelection(storage, run, effectiveConfig);
    let currentRun = run;
    const openGate = storage.listGates(run.id).find((item) => item.status === "open");
    if (run.status === "BLOCKED" && openGate) {
      const workItem = getDeliveryWorkItem(storage, currentRun.id);
      if (shape.id === "pr-loop" && !options.dryRun && openGate.kind === "ambiguous_next_pr" && !resolvePrSelection(options.repoRoot, effectiveConfig, selectionOptions(options.pullRequests, options.dryRun, workItem)).ambiguous) {
        storage.resolveOpenGatesByKind("ambiguous_next_pr", { scope: "run", runId: run.id });
        currentRun = storage.updateRunStatus(run.id, run.version, "RUNNING", { currentState: normalizeState(run.currentState, shape) });
        storage.appendEvent({
          runId: currentRun.id,
          kind: "gate_recovery",
          message: "Resolved ambiguous_next_pr after PR selector found a unique target.",
          payload: { gate: "ambiguous_next_pr", source: "state_machine" }
        });
      } else {
        return {
          ok: false,
          runId: run.id,
          status: "BLOCKED",
          currentState: normalizeState(run.currentState, shape),
          transitions: [],
          gate: { kind: openGate.kind, message: openGate.message, ...openGate.details === void 0 ? {} : { details: openGate.details } },
          artifacts: []
        };
      }
    }
    const workerGate = blockRunForTerminalWorker(storage, currentRun);
    if (workerGate) {
      return workerGate;
    }
    const transitions = [];
    const artifacts = [];
    let current = normalizeState(currentRun.currentState, shape);
    if (shape.id === "generic-loop" && currentRun.status === "READY" && current === "COMPLETE") {
      return {
        ok: true,
        runId: currentRun.id,
        status: "READY",
        currentState: "COMPLETE",
        transitions,
        artifacts
      };
    }
    const maxSteps = options.untilGate ? 10 : 1;
    for (let index = 0; index < maxSteps; index += 1) {
      if (shape.id === "pr-loop" && current === "SELECT_NEXT_PR") {
        const workItem = getDeliveryWorkItem(storage, currentRun.id);
        const selection = resolvePrSelection(options.repoRoot, effectiveConfig, selectionOptions(options.pullRequests, options.dryRun, workItem));
        if (selection.ambiguous) {
          return blockRun(
            storage,
            currentRun,
            "ambiguous_next_pr",
            "Could not uniquely identify the next PR from the configured plans directory.",
            {
              plansDir: effectiveConfig.plansDir,
              reason: selection.reason,
              candidates: selection.candidates,
              evidence: selection.evidence
            }
          );
        }
        if (selection.mode === "current_pr") {
          if (!options.dryRun) {
            storage.upsertPrLink({
              runId: currentRun.id,
              branch: selection.pr.headRefName,
              prNumber: selection.pr.number,
              url: selection.pr.url,
              headRef: selection.pr.headRefName,
              baseRef: selection.pr.baseRefName,
              state: selection.pr.state,
              draft: selection.pr.isDraft
            });
            storage.appendDecision({
              runId: currentRun.id,
              kind: "pr_reused",
              message: `Selected existing PR #${selection.pr.number} for ${selection.item.id}.`,
              details: { branch: selection.pr.headRefName, spec: selection.item.file }
            });
          }
          const nextState2 = "WAIT_REVIEW_OR_CI";
          transitions.push({ from: current, to: nextState2 });
          if (!options.dryRun) {
            currentRun = storage.updateRunStatus(currentRun.id, currentRun.version, "RUNNING", {
              currentState: nextState2,
              branch: selection.pr.headRefName,
              worktreeClean: true
            });
          } else {
            currentRun = { ...currentRun, currentState: nextState2, branch: selection.pr.headRefName, worktreeClean: true };
          }
          storage.appendEvent({
            runId: currentRun.id,
            kind: "state_transition",
            message: `${current} -> ${nextState2}`,
            stateBefore: current,
            stateAfter: nextState2,
            payload: { selectedPr: selection.item.id, prNumber: selection.pr.number, branch: selection.pr.headRefName, explicitWorkItem: workItem }
          });
          current = nextState2;
          continue;
        }
      }
      const next = nextTransition(shape, current, "step", "progress", { includeTerminal: shape.id === "generic-loop" });
      if (!next) {
        break;
      }
      const preWorkerGenericLifecycle = shape.id === "generic-loop" ? executeGenericPreWorkerStep({ storage, run: currentRun, state: current, dryRun: options.dryRun }) : {};
      if (preWorkerGenericLifecycle.transitionGuard) {
        const transition = nextTransition(shape, current, "step", "progress", {
          guard: preWorkerGenericLifecycle.transitionGuard,
          includeTerminal: true
        });
        if (!transition) {
          throw new AgentLoopError("storage_error", `No generic transition from ${current} for guard ${preWorkerGenericLifecycle.transitionGuard}.`);
        }
        const nextState2 = transition.to;
        const nextStatus2 = preWorkerGenericLifecycle.status ?? (nextState2 === "STOPPED" ? "STOPPED" : "RUNNING");
        if (!options.dryRun) {
          currentRun = storage.updateRunStatus(currentRun.id, currentRun.version, nextStatus2, { currentState: nextState2 });
        } else {
          currentRun = { ...currentRun, currentState: nextState2, status: nextStatus2 };
        }
        storage.appendEvent({
          runId: currentRun.id,
          kind: "state_transition",
          message: `${current} -> ${nextState2}`,
          stateBefore: current,
          stateAfter: nextState2,
          payload: { dryRun: options.dryRun, loopShape: shape.id, genericLifecycle: preWorkerGenericLifecycle }
        });
        transitions.push({ from: current, to: nextState2 });
        current = nextState2;
        if (options.singleStep || shape.terminalStates.includes(current)) {
          break;
        }
        continue;
      }
      const plans = planState(current, options.repoRoot);
      const artifact = writeArtifact(
        options.repoRoot,
        storage,
        currentRun.id,
        "dry-run-plan",
        `${current.toLowerCase()}.json`,
        `${JSON.stringify({ state: current, dryRun: options.dryRun, plans }, null, 2)}
`
      );
      artifacts.push(artifact);
      const commandResults = await applyCommandPlans(
        options.repoRoot,
        storage,
        currentRun.id,
        effectiveConfig,
        plans,
        options.dryRun,
        options.signal
      );
      let workerResult;
      let lifecycle;
      let genericLifecycle;
      try {
        const workerType = shape.defaultRoleForState(current);
        if (workerType) {
          workerResult = await executeWorker({
            repoRoot: options.repoRoot,
            storage,
            run: currentRun,
            config: effectiveConfig,
            state: current,
            type: workerType,
            dryRun: options.dryRun,
            signal: options.signal
          });
          artifacts.push(...workerResult.artifacts);
        }
        lifecycle = shape.id === "pr-loop" && !options.dryRun ? await executePrLifecycleStep({
          repoRoot: options.repoRoot,
          storage,
          run: currentRun,
          config: effectiveConfig,
          state: current,
          signal: options.signal
        }) : void 0;
        genericLifecycle = shape.id === "generic-loop" ? await executeGenericLifecycleStep({
          repoRoot: options.repoRoot,
          storage,
          run: currentRun,
          config: effectiveConfig,
          state: current,
          dryRun: options.dryRun,
          ...workerResult?.result ? { workerResult: workerResult.result } : {}
        }) : void 0;
      } catch (error) {
        if (error instanceof AgentLoopError && isGateCode(error.code)) {
          return blockRun(storage, currentRun, error.code, error.message, error.details);
        }
        throw error;
      }
      const selectedGenericTransition = shape.id === "generic-loop" ? nextTransition(shape, current, "step", "progress", {
        guard: genericLifecycle?.transitionGuard ?? "always",
        includeTerminal: true
      }) : void 0;
      if (shape.id === "generic-loop" && !selectedGenericTransition) {
        throw new AgentLoopError("storage_error", `No generic transition from ${current} for guard ${genericLifecycle?.transitionGuard ?? "always"}.`);
      }
      const nextState = lifecycle?.nextState ?? selectedGenericTransition?.to ?? next.to;
      artifacts.push(...genericLifecycle?.artifacts ?? []);
      const nextStatus = genericLifecycle?.status ?? (shape.id === "generic-loop" && nextState === "COMPLETE" ? "READY" : nextState === "STOPPED" ? "STOPPED" : "RUNNING");
      const updateOptions = { currentState: nextState };
      if (lifecycle?.branch !== void 0) {
        updateOptions.branch = lifecycle.branch;
      }
      if (lifecycle?.worktreeClean !== void 0) {
        updateOptions.worktreeClean = lifecycle.worktreeClean;
      }
      if (!options.dryRun) {
        currentRun = storage.updateRunStatus(currentRun.id, currentRun.version, nextStatus, updateOptions);
      } else {
        currentRun = { ...currentRun, currentState: nextState, status: nextStatus };
      }
      if (shape.id === "generic-loop" && nextState === "COMPLETE" && !options.dryRun) {
        storage.appendDecision({
          runId: currentRun.id,
          kind: "generic_loop_completed",
          message: "Generic loop completed.",
          details: { loopShape: shape.id, workflowProfile: effectiveConfig.workflowProfile }
        });
      }
      storage.appendEvent({
        runId: currentRun.id,
        kind: "state_transition",
        message: `${current} -> ${nextState}`,
        stateBefore: current,
        stateAfter: nextState,
        payload: { dryRun: options.dryRun, loopShape: shape.id, plans, commandResults, worker: workerResult, lifecycle, genericLifecycle },
        artifactIds: [artifact.id, ...workerResult?.artifacts.map((item) => item.id) ?? [], ...genericLifecycle?.artifacts?.map((item) => item.id) ?? []]
      });
      transitions.push({ from: current, to: nextState });
      current = nextState;
      if (options.singleStep) {
        break;
      }
      if (shape.terminalStates.includes(current)) {
        break;
      }
    }
    const result = {
      ok: true,
      runId: currentRun.id,
      status: currentRun.status,
      currentState: normalizeState(currentRun.currentState, shape),
      transitions,
      artifacts
    };
    return result;
  } finally {
    storage.close();
  }
}
async function resumeStateMachine(repoRoot) {
  assertTransitionTable();
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    const run = storage.getCurrentRun();
    if (!run) {
      return await runStateMachine({ repoRoot, dryRun: true, untilGate: false });
    }
    const configResult = tryLoadConfig(repoRoot);
    const shape = configResult.ok ? resolveLoopShape(applyProfileConfig(configResult.config).loopShape) : shapeForStoredState(run.currentState);
    if (shape.id === "generic-loop" && run.status === "READY" && normalizeState(run.currentState, shape) === "COMPLETE") {
      return {
        ok: true,
        runId: run.id,
        status: "READY",
        currentState: "COMPLETE",
        transitions: [],
        artifacts: []
      };
    }
    if (run.status === "STOPPED") {
      return {
        ok: false,
        runId: run.id,
        status: run.status,
        currentState: normalizeState(run.currentState, shape),
        transitions: [],
        artifacts: []
      };
    }
    let currentRun = run;
    if (currentRun.status === "BLOCKED") {
      const openGate = storage.listGates(currentRun.id).find((gate) => gate.status === "open");
      if (openGate?.kind === "ambiguous_next_pr") {
        const effectiveConfig = configResult.ok ? applyProfileConfig(configResult.config) : void 0;
        const workItem = effectiveConfig ? getDeliveryWorkItem(storage, currentRun.id) : void 0;
        if (effectiveConfig && !resolvePrSelection(repoRoot, effectiveConfig, { githubRequired: true, ...workItem ? { workItem } : {} }).ambiguous) {
          storage.resolveOpenGatesByKind("ambiguous_next_pr", { scope: "run", runId: currentRun.id });
          currentRun = storage.updateRunStatus(currentRun.id, currentRun.version, "RUNNING", { currentState: normalizeState(currentRun.currentState, resolveLoopShape(effectiveConfig.loopShape)) });
          storage.appendEvent({
            runId: currentRun.id,
            kind: "gate_recovery",
            message: "Resolved ambiguous_next_pr before resume after PR selector found a unique target.",
            payload: { gate: "ambiguous_next_pr", source: "resume" }
          });
        }
      }
      if (storage.listGates(currentRun.id).some((gate) => gate.status === "open")) {
        return {
          ok: false,
          runId: currentRun.id,
          status: currentRun.status,
          currentState: normalizeState(currentRun.currentState),
          transitions: [],
          artifacts: []
        };
      }
      if (currentRun.status === "BLOCKED") {
        currentRun = storage.updateRunStatus(currentRun.id, currentRun.version, "RUNNING");
      }
    }
    const workerGate = blockRunForTerminalWorker(storage, currentRun);
    if (workerGate) {
      return workerGate;
    }
    const reality = readReality(repoRoot);
    if (currentRun.branch && currentRun.branch !== reality.branch || currentRun.worktreeClean !== void 0 && currentRun.worktreeClean !== reality.worktreeClean) {
      return blockRun(storage, currentRun, "dirty_unowned_worktree", "Reality check failed before resume.", {
        expected: { branch: currentRun.branch, worktreeClean: currentRun.worktreeClean },
        actual: reality
      });
    }
    return await runStateMachine({ repoRoot, dryRun: false, untilGate: false, singleStep: true });
  } finally {
    storage.close();
  }
}
function stopStateMachine(repoRoot) {
  assertTransitionTable();
  const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
  try {
    let run = storage.getCurrentRun();
    if (!run) {
      return {
        ok: true,
        status: "STOPPED",
        currentState: "STOPPED",
        transitions: [],
        artifacts: []
      };
    }
    const shape = shapeForStoredState(run.currentState);
    const stateBefore = normalizeState(run.currentState, shape);
    const stopTransition = nextTransition(shape, stateBefore, "stop", "terminal");
    if (!stopTransition) {
      throw new AgentLoopError("storage_error", `No stop transition for state ${normalizeState(run.currentState, shape)}.`);
    }
    storage.resolveOpenGates(run.id);
    const runningWorker = storage.getRunningWorker();
    if (runningWorker) {
      storage.updateWorker(runningWorker.id, {
        status: "failed",
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        exitCode: 130,
        error: "Stopped by supervisor."
      });
    }
    let stopped;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        stopped = storage.updateRunStatus(run.id, run.version, "STOPPED", {
          currentState: "STOPPED",
          stoppedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
        break;
      } catch (error) {
        if (!(error instanceof AgentLoopError) || error.code !== "version_conflict" || attempt === 2) {
          throw error;
        }
        run = storage.getCurrentRun() ?? run;
      }
    }
    if (!stopped) {
      throw new AgentLoopError("storage_error", "Run stop did not complete.");
    }
    storage.appendEvent({
      runId: stopped.id,
      kind: "run_stopped",
      message: "Run stopped by CLI.",
      stateBefore,
      stateAfter: "STOPPED"
    });
    return {
      ok: true,
      runId: stopped.id,
      status: "STOPPED",
      currentState: "STOPPED",
      transitions: [{ from: stopTransition.from, to: "STOPPED" }],
      artifacts: []
    };
  } finally {
    storage.close();
  }
}
function ensureRun(storage, repoRoot, shape) {
  const existing = storage.getCurrentRun();
  if (existing && existing.status !== "STOPPED") {
    return existing;
  }
  const reality = readReality(repoRoot);
  return storage.createRun("RUNNING", {
    currentState: shape.initialState,
    branch: reality.branch,
    worktreeClean: reality.worktreeClean
  });
}
function auditProfileSelection(storage, run, config) {
  if (storage.listDecisions(run.id).some((decision) => decision.kind === "profile_selected")) {
    return;
  }
  const profile = resolveProfile(config, normalizeState(run.currentState, resolveLoopShape(config.loopShape)));
  const details = {
    loopShape: profile.loopShape,
    workflowProfile: profile.workflowProfile,
    roleProfile: profile.roleProfile,
    currentRole: profile.currentRole,
    roleMapping: profile.roleMapping,
    autonomyBoundary: profile.autonomyBoundary,
    validationPosture: profile.validationPosture,
    source: "config_or_default"
  };
  storage.appendDecision({
    runId: run.id,
    kind: "profile_selected",
    message: `Selected workflow profile ${profile.workflowProfile} for ${profile.loopShape}.`,
    details
  });
  storage.appendEvent({
    runId: run.id,
    kind: "profile_selected",
    message: `Selected workflow profile ${profile.workflowProfile}.`,
    payload: details
  });
}
function blockRun(storage, run, kind, message, details) {
  const stateBefore = stateFromGateDetails(details) ?? normalizeState(run.currentState, shapeForStoredState(run.currentState));
  const blocked = storage.updateRunStatus(run.id, run.version, "BLOCKED", {
    currentState: stateBefore
  });
  storage.writeGate({ runId: blocked.id, kind, message, details });
  storage.appendEvent({
    runId: blocked.id,
    kind: "gate_opened",
    message,
    stateBefore,
    stateAfter: "BLOCKED",
    payload: { gate: kind, details }
  });
  return {
    ok: false,
    runId: blocked.id,
    status: "BLOCKED",
    currentState: stateBefore,
    transitions: [{ from: stateBefore, to: "BLOCKED" }],
    gate: { kind, message, ...details === void 0 ? {} : { details } },
    artifacts: []
  };
}
function stateFromGateDetails(details) {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return void 0;
  const state = details.state;
  return typeof state === "string" ? normalizeState(state, shapeForStoredState(state)) : void 0;
}
function blockRunForTerminalWorker(storage, run) {
  if (run.status !== "RUNNING" || storage.listGates(run.id).some((gate2) => gate2.status === "open")) {
    return void 0;
  }
  const recoveredWorkerIds = collectRecoveredWorkerIds(storage, run.id);
  const workers = storage.listWorkers(run.id, 20);
  if (workers.length === 0 || workers.some((item) => item.status === "running")) {
    return void 0;
  }
  const latestStartedAt = workers.reduce((latest, item) => item.startedAt > latest ? item.startedAt : latest, workers[0]?.startedAt ?? "");
  const latestWorkers = workers.filter((item) => item.startedAt === latestStartedAt);
  if (latestWorkers.some((item) => item.status === "succeeded")) {
    return void 0;
  }
  const worker = latestWorkers.find((item) => gateForTerminalWorker(item) !== void 0 && !recoveredWorkerIds.has(item.id));
  if (!worker) return void 0;
  const gate = gateForTerminalWorker(worker);
  if (!gate) {
    return void 0;
  }
  return blockRun(storage, run, gate, messageForTerminalWorker(worker), detailsForTerminalWorker(worker));
}
function collectRecoveredWorkerIds(storage, runId) {
  const ids = /* @__PURE__ */ new Set();
  for (const decision of storage.listDecisions(runId)) {
    if (decision.kind !== WORKER_FAILURE_RECOVERED_DECISION || !isRecord(decision.details)) {
      continue;
    }
    const workerIds = decision.details.workerIds;
    if (Array.isArray(workerIds)) {
      for (const id of workerIds) {
        if (typeof id === "string") {
          ids.add(id);
        }
      }
    }
  }
  return ids;
}
function gateForTerminalWorker(worker) {
  const gates = {
    failed: "worker_failed",
    invalid_output: "worker_output_invalid",
    timed_out: "worker_timeout"
  };
  return gates[worker.status];
}
function messageForTerminalWorker(worker) {
  if (worker.status === "invalid_output") {
    return "Worker output did not match schema.";
  }
  if (worker.status === "timed_out") {
    return "Codex worker timed out.";
  }
  return worker.error ?? "Codex worker failed.";
}
function detailsForTerminalWorker(worker) {
  return {
    workerId: worker.id,
    workerType: worker.type,
    attempt: worker.attempt,
    ...worker.exitCode === void 0 ? {} : { exitCode: worker.exitCode },
    ...worker.error === void 0 ? {} : { error: worker.error },
    ...worker.threadId === void 0 ? {} : { threadId: worker.threadId }
  };
}
function selectionOptions(pullRequests, dryRun, workItem) {
  return {
    ...pullRequests === void 0 ? {} : { pullRequests },
    githubRequired: !dryRun,
    ...workItem ? { workItem } : {}
  };
}
function assertTransitionTable() {
  const errors = validateTransitionTable();
  if (errors.length > 0) {
    throw new AgentLoopError("storage_error", "State transition table is invalid.", {
      details: { errors }
    });
  }
}
function nextTransition(shape, state, trigger, mode, options = {}) {
  return shape.transitions.find((transition) => {
    if (transition.from !== state || transition.trigger !== trigger) {
      return false;
    }
    if (options.guard !== void 0 && transition.guard !== options.guard) {
      return false;
    }
    const terminal = shape.terminalStates.includes(transition.to);
    if (options.includeTerminal && mode === "progress") {
      return true;
    }
    return mode === "terminal" ? terminal : !terminal;
  });
}
function tryLoadConfig(repoRoot) {
  try {
    return { ok: true, config: loadConfig(repoRoot).config };
  } catch (error) {
    if (error instanceof AgentLoopError) {
      return { ok: false, error };
    }
    throw error;
  }
}
function normalizeState(value, shape = PR_LOOP_SHAPE) {
  return shape.states.includes(value) ? value : shape.initialState;
}
function shapeForStoredState(value) {
  return value && GENERIC_LOOP_SHAPE.states.includes(value) ? GENERIC_LOOP_SHAPE : PR_LOOP_SHAPE;
}
function readReality(repoRoot) {
  try {
    return {
      branch: execFileSync8("git", ["branch", "--show-current"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim(),
      worktreeClean: execFileSync8("git", ["status", "--short"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim().length === 0
    };
  } catch (error) {
    throw new AgentLoopError("not_git_repo", "Could not read git reality for this repository.", {
      details: { cause: error instanceof Error ? error.message : String(error) }
    });
  }
}
async function applyCommandPlans(repoRoot, storage, runId, config, plans, dryRun, signal) {
  const runner = new CommandRunner({ repoRoot, storage, runId, config, signal });
  const results = [];
  for (const plan of plans) {
    results.push(await runner.run(plan, dryRun));
  }
  return results;
}

// plugins/autonomous-pr-loop/core/workflow-board.ts
var WORKFLOW_STAGE_IDS = [
  "work_item",
  "plan",
  "build",
  "verify",
  "pr",
  "review",
  "merge_readiness",
  "cleanup"
];
var WORKFLOW_STAGE_DEFINITIONS = [
  {
    id: "work_item",
    label: "Work Item",
    nextAction: "Write or confirm the plan.",
    substages: [
      { id: "issue_selected", label: "Issue selected" },
      { id: "scope_confirmed", label: "Scope confirmed" },
      { id: "handoff_checked", label: "Handoff checked" },
      { id: "non_goals_recorded", label: "Non-goals recorded" }
    ]
  },
  {
    id: "plan",
    label: "Plan",
    nextAction: "Create branch and implement.",
    substages: [
      { id: "impact_checked", label: "Impact checked" },
      { id: "plan_written", label: "Plan written" },
      { id: "test_plan_defined", label: "Test plan defined" },
      { id: "review_rules_confirmed", label: "Review rules confirmed" }
    ]
  },
  {
    id: "build",
    label: "Build",
    nextAction: "Run verification.",
    substages: [
      { id: "branch_created", label: "Branch created" },
      { id: "implementation_active", label: "Implementation active" },
      { id: "files_changed", label: "Files changed" },
      { id: "local_smoke", label: "Local smoke" }
    ]
  },
  {
    id: "verify",
    label: "Verify",
    nextAction: "Publish the PR.",
    substages: [
      { id: "lint", label: "Lint" },
      { id: "focused_tests", label: "Focused tests" },
      { id: "full_tests", label: "Full tests" },
      { id: "gitnexus_detect", label: "GitNexus detect" },
      { id: "browser_validation", label: "Browser validation" },
      { id: "internal_tester", label: "Internal tester" },
      { id: "internal_reviewer", label: "Internal reviewer" }
    ]
  },
  {
    id: "pr",
    label: "PR",
    nextAction: "Run post-PR reviews.",
    substages: [
      { id: "commit_created", label: "Commit created" },
      { id: "branch_pushed", label: "Branch pushed" },
      { id: "pr_opened", label: "PR opened" },
      { id: "pr_body_completed", label: "PR body completed" },
      { id: "delivery_comment_posted", label: "Delivery comment posted" }
    ]
  },
  {
    id: "review",
    label: "Review",
    nextAction: "Wait for CI and merge readiness.",
    substages: [
      { id: "claude_acp_review", label: "Claude ACP review" },
      { id: "agy_gemini_review", label: "AGY/Gemini review" },
      { id: "github_comments_inspected", label: "GitHub comments inspected" },
      { id: "findings_classified", label: "Findings classified" },
      { id: "reports_posted", label: "Reports posted to PR" }
    ]
  },
  {
    id: "merge_readiness",
    label: "Merge Readiness",
    nextAction: "Merge PR, or fix the blocking condition in this PR.",
    substages: [
      { id: "ci_checks", label: "CI checks" },
      { id: "review_approval", label: "Review approval" },
      { id: "findings_gate", label: "Findings gate" },
      { id: "scope_guard", label: "Scope guard" },
      { id: "merge_policy", label: "Merge policy" }
    ]
  },
  {
    id: "cleanup",
    label: "Cleanup",
    nextAction: "Move to the next issue.",
    substages: [
      { id: "pr_merged", label: "PR merged" },
      { id: "switched_main", label: "Switched to main" },
      { id: "pulled_latest", label: "Pulled latest" },
      { id: "gitnexus_reindexed", label: "GitNexus index rebuilt" },
      { id: "worktree_clean", label: "Worktree clean" },
      { id: "next_issue_selected", label: "Next issue selected" }
    ]
  }
];
var STAGE_BY_ID = new Map(WORKFLOW_STAGE_DEFINITIONS.map((stage) => [stage.id, stage]));
var PR_STATES = new Set(PR_LOOP_STATES);
var WORKFLOW_EVIDENCE_KIND = "workflow_stage_evidence";
var MAX_SUMMARY_LENGTH = 280;
var REVIEW_REVIEWERS = ["claude_acp", "agy_gemini", "internal_tester", "internal_reviewer", "github", "human", "custom"];
var REVIEW_REQUIREMENTS = ["required", "optional", "not_required", "unknown"];
var REVIEW_PROGRESS = ["requested", "started", "in_progress", "incomplete", "complete", "skipped", "unknown"];
var REVIEW_RESULTS = ["pass", "block", "warn", "unknown"];
var REVIEW_SEVERITIES = ["none", "p3_only", "p2_or_higher", "unknown"];
function selectWorkflowBoardRun(storage, runId) {
  const runs = storage.listRuns(200);
  if (runId) {
    return runs.find((run) => run.id === runId);
  }
  return selectDefaultDeliveryRun(storage);
}
function deriveWorkflowBoard(input) {
  const run = input.run;
  const loopShape = input.config.loopShape;
  if (!run) {
    return emptyBoard(loopShape);
  }
  const readOnly = !(run.status === "RUNNING" || run.status === "BLOCKED");
  const deliveryWorkItem = input.deliveryWorkItem;
  const workItem = {
    ...deliveryWorkItem ? {
      issueNumber: deliveryWorkItem.issue,
      issueTitle: deliveryWorkItem.title,
      issueUrl: deliveryWorkItem.url
    } : {},
    runId: run.id,
    branch: run.branch,
    currentState: run.currentState,
    status: run.status,
    loopShape,
    workflowProfile: input.config.workflowProfile,
    prUrl: input.pr?.url,
    prNumber: input.pr?.prNumber,
    lastUpdate: run.updatedAt,
    activeGate: input.gates.find((gate) => gate.status === "open")?.kind,
    readOnly
  };
  if (loopShape !== "pr-loop") {
    return unsupportedBoard(workItem, "PR O observes only $pr-delivery-loop / pr-loop runs.");
  }
  if (run.currentState && !PR_STATES.has(run.currentState)) {
    return unknownStateBoard(workItem, `Unknown PR loop state: ${run.currentState}`);
  }
  const appendedRefs = appendedEvidenceRefs(input.events);
  const evidenceRefs = [
    ...appendedRefs,
    ...gateEvidenceRefs(input.gates),
    ...eventEvidenceRefs(input.events),
    ...artifactEvidenceRefs(input.artifacts),
    ...ciEvidenceRefs(input.ci),
    ...reviewEvidenceRefs(input.reviewComments),
    ...workerEvidenceRefs(input.workers)
  ];
  const activeGate = input.gates.find((gate) => gate.status === "open");
  const effectiveState = effectivePrState(run.currentState, input.events);
  const stateStage = boardStageForState(effectiveState, input);
  const stageSignal = workflowStageSignal(input.events);
  const signalOverridesState = stageSignal ? isCurrentStageSignalStatus(stageSignal.status) : false;
  const stageFromState = signalOverridesState && stageSignal ? stageSignal.stageId : advanceStageWithEvidence(
    stateStage,
    stageSignal?.stageId,
    effectiveState
  );
  const activeStageId = activeGate ? stageForGate(activeGate, stageFromState) : stageFromState;
  const stageSignalApplies = Boolean(stageSignal && !activeGate && (signalOverridesState || stageSignal.stageId === activeStageId && activeStageId !== stateStage));
  const stageSource = activeGate ? "gate" : readOnly ? "historical" : stageSignalApplies ? "workflow_evidence" : activeStageId === stateStage ? "run_state" : "workflow_evidence";
  const statusOverride = {};
  if (activeGate) {
    statusOverride[activeStageId] = "blocked";
  } else if (stageSignalApplies && stageSignal) {
    statusOverride[stageSignal.stageId] = stageSignal.status;
  } else if (readOnly) {
    statusOverride[activeStageId] = "pending";
  }
  const profile = resolveProfile(input.config, isAgentLoopState(effectiveState) ? effectiveState : void 0);
  const stageMetadata = workflowStages(input.config);
  const stages = WORKFLOW_STAGE_DEFINITIONS.map(
    (definition) => buildStage({
      definition,
      activeStageId,
      statusOverride,
      evidenceRefs,
      input,
      profileRoleMapping: profile.roleMapping,
      stageMetadata
    })
  );
  const blockers = activeGate ? [gateBlocker(activeGate, activeStageId)] : [];
  const blockedStage = stages.find((stage) => stage.id === activeStageId);
  if (blockedStage && blockers.length > 0) {
    blockedStage.blockers = blockers;
  }
  return {
    runId: run.id,
    mode: readOnly ? "historical" : "active",
    activeStageId,
    selectedStageId: activeStageId,
    stageSource,
    ...stageSignalApplies && stageSignal ? { stageSourceEvent: { id: stageSignal.event.id, status: stageSignal.status, createdAt: stageSignal.event.createdAt } } : {},
    ...input.hookCapture ? { hookCapture: workflowBoardHookCapture(input.hookCapture) } : {},
    workItem,
    stages,
    evidenceRefs,
    reviewReports: reviewRows(input, appendedRefs),
    verificationChecks: verificationRows(input),
    mergeReadinessChecks: mergeReadinessRows(input),
    cleanupChecks: cleanupRows(input),
    appendEvidenceEnabled: !readOnly,
    ...readOnly ? { message: "Historical run; workflow board is read-only." } : {}
  };
}
function appendWorkflowEvidence(storage, input) {
  const currentRun = input.runId ? storage.listRuns(200).find((run) => run.id === input.runId) : storage.getCurrentRun();
  if (!currentRun) {
    throw new AgentLoopError("storage_error", "No run is available for workflow evidence.");
  }
  if (currentRun.status !== "RUNNING" && currentRun.status !== "BLOCKED") {
    throw new AgentLoopError("policy_violation", "Workflow evidence can only be appended to a running or blocked run.", {
      details: { runId: currentRun.id, status: currentRun.status }
    });
  }
  const normalized = normalizeWorkflowEvidenceInput(input);
  const event = storage.appendEvent({
    runId: currentRun.id,
    kind: WORKFLOW_EVIDENCE_KIND,
    message: normalized.summary,
    payload: {
      stageId: normalized.stageId,
      ...normalized.substageId ? { substageId: normalized.substageId } : {},
      evidenceRefIds: normalized.evidenceRefIds,
      actor: normalized.actor,
      status: normalized.status,
      source: normalized.source,
      ...normalized.review ? { review: normalized.review } : {}
    },
    artifactIds: normalized.artifactIds
  });
  return {
    event,
    evidence: {
      id: event.id,
      kind: evidenceKindFromSource(normalized.source),
      label: WORKFLOW_STAGE_DEFINITIONS.find((stage) => stage.id === normalized.stageId)?.label ?? normalized.stageId,
      summary: normalized.summary,
      interaction: "drill_down_link",
      drillDownTarget: { page: "Event Ledger" },
      createdAt: event.createdAt,
      source: normalized.source
    }
  };
}
function normalizeWorkflowEvidenceInput(input) {
  const stageId = input.stageId;
  if (!isWorkflowStageId(stageId)) {
    throw new AgentLoopError("invalid_config", "workflow evidence stageId is invalid.");
  }
  const stage = STAGE_BY_ID.get(stageId);
  const substageId = typeof input.substageId === "string" && input.substageId.trim().length > 0 ? input.substageId.trim() : void 0;
  if (substageId && !stage?.substages.some((substage) => substage.id === substageId)) {
    throw new AgentLoopError("invalid_config", "workflow evidence substageId is invalid.");
  }
  const rawSummary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (rawSummary.length === 0) {
    throw new AgentLoopError("invalid_config", "workflow evidence summary is required.");
  }
  if (rawSummary.length > MAX_SUMMARY_LENGTH) {
    throw new AgentLoopError("invalid_config", `workflow evidence summary must be ${MAX_SUMMARY_LENGTH} characters or shorter.`);
  }
  const summary = redactSecrets(rawSummary);
  const actor = isWorkflowActor(input.actor) ? input.actor : "codex";
  const status = input.status === void 0 ? "done" : workflowStageStatus(input.status);
  const source = typeof input.source === "string" && input.source.trim().length > 0 ? input.source.trim() : "cli";
  const review = normalizeReviewEvidence(input.review, stageId);
  return {
    stageId,
    ...substageId ? { substageId } : {},
    summary,
    evidenceRefIds: stringArray(input.evidenceRefIds),
    artifactIds: stringArray(input.artifactIds),
    actor,
    status,
    source,
    ...review ? { review } : {}
  };
}
function workflowStageStatus(value) {
  if (isWorkflowStageStatus(value)) return value;
  throw new AgentLoopError("invalid_config", "workflow evidence status is invalid.");
}
function workflowBoardHookCapture(report) {
  return {
    status: report.status,
    reason: report.reason
  };
}
function normalizeReviewEvidence(value, stageId) {
  if (value === void 0) return void 0;
  if (stageId !== "review") {
    throw new AgentLoopError("invalid_config", "structured review evidence is only valid for the review stage.");
  }
  if (!isRecord2(value)) {
    throw new AgentLoopError("invalid_config", "structured review evidence must be an object.");
  }
  const reviewer = enumValue(value.reviewer, REVIEW_REVIEWERS, "reviewer");
  const requirement = enumValue(value.requirement, REVIEW_REQUIREMENTS, "requirement");
  const progress = enumValue(value.progress, REVIEW_PROGRESS, "progress");
  const result = enumValue(value.result, REVIEW_RESULTS, "result");
  const severitySummary = enumValue(value.severitySummary, REVIEW_SEVERITIES, "severitySummary");
  const commentUrl = optionalRedactedString(value.commentUrl, "commentUrl");
  const commentId = optionalRedactedString(value.commentId, "commentId");
  if (commentUrl && !isGitHubIssueCommentUrl(commentUrl)) {
    throw new AgentLoopError("invalid_config", "review evidence commentUrl must be a GitHub PR comment, review, or discussion URL.");
  }
  if (progress === "complete" && requirement !== "not_required" && !commentUrl) {
    throw new AgentLoopError("invalid_config", "complete review evidence requires a valid --comment-url.");
  }
  if (progress === "skipped" && requirement !== "not_required") {
    throw new AgentLoopError("invalid_config", "skipped review evidence must use requirement not_required.");
  }
  return {
    reviewer,
    requirement,
    progress,
    result,
    severitySummary,
    ...optionalReviewField("model", value.model),
    ...optionalReviewField("sessionId", value.sessionId),
    ...optionalReviewField("conversationId", value.conversationId),
    ...commentUrl ? { commentUrl } : {},
    ...commentId ? { commentId } : {},
    ...optionalReviewField("reason", value.reason)
  };
}
function enumValue(value, allowed, field) {
  if (typeof value === "string" && allowed.includes(value)) return value;
  throw new AgentLoopError("invalid_config", `review evidence ${field} is invalid.`);
}
function optionalReviewField(key, value) {
  const normalized = optionalRedactedString(value, String(key));
  return normalized ? { [key]: normalized } : {};
}
function optionalRedactedString(value, field) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (typeof value !== "string") {
    throw new AgentLoopError("invalid_config", `review evidence ${field} must be a string.`);
  }
  const normalized = redactSecrets(value.trim());
  if (normalized.length > MAX_SUMMARY_LENGTH) {
    throw new AgentLoopError("invalid_config", `review evidence ${field} must be ${MAX_SUMMARY_LENGTH} characters or shorter.`);
  }
  return normalized.length > 0 ? normalized : void 0;
}
function isGitHubIssueCommentUrl(value) {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:\/files)?(?:\?[^#\s]+)?#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+)(?:\?[^#\s]+)?$/i.test(value);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isWorkflowStageId(value) {
  return typeof value === "string" && WORKFLOW_STAGE_IDS.includes(value);
}
function emptyCounts() {
  return { events: 0, artifacts: 0, gates: 0, prComments: 0, gitnexus: 0, browser: 0, ci: 0, reports: 0 };
}
function emptyBoard(loopShape) {
  const stages = WORKFLOW_STAGE_DEFINITIONS.map((definition) => buildEmptyStage(definition));
  return {
    mode: "empty",
    selectedStageId: "work_item",
    stageSource: "historical",
    workItem: { loopShape, readOnly: true },
    stages,
    evidenceRefs: [],
    reviewReports: [],
    verificationChecks: [],
    mergeReadinessChecks: [],
    cleanupChecks: [],
    appendEvidenceEnabled: false,
    message: "No active PR delivery run is selected."
  };
}
function unsupportedBoard(workItem, message) {
  return {
    runId: workItem.runId,
    mode: "unsupported",
    selectedStageId: "work_item",
    stageSource: "historical",
    workItem: { ...workItem, readOnly: true },
    stages: WORKFLOW_STAGE_DEFINITIONS.map((definition) => ({ ...buildEmptyStage(definition), status: "skipped" })),
    evidenceRefs: [],
    reviewReports: [],
    verificationChecks: [],
    mergeReadinessChecks: [],
    cleanupChecks: [],
    appendEvidenceEnabled: false,
    message
  };
}
function unknownStateBoard(workItem, message) {
  return {
    runId: workItem.runId,
    mode: "unknown_state",
    selectedStageId: "work_item",
    stageSource: "historical",
    workItem: { ...workItem, readOnly: true },
    stages: WORKFLOW_STAGE_DEFINITIONS.map((definition) => buildEmptyStage(definition)),
    evidenceRefs: [],
    reviewReports: [],
    verificationChecks: [],
    mergeReadinessChecks: [],
    cleanupChecks: [],
    appendEvidenceEnabled: false,
    message
  };
}
function buildEmptyStage(definition) {
  return {
    id: definition.id,
    label: definition.label,
    status: "pending",
    actorChips: actorChipsForStage(definition.id, "pending"),
    evidenceCounts: emptyCounts(),
    substages: definition.substages.map((substage) => ({
      ...substage,
      status: "pending",
      evidenceCounts: emptyCounts(),
      latestEvidence: [],
      requiredEvidence: []
    })),
    blockers: [],
    nextAction: definition.nextAction
  };
}
function buildStage(input) {
  const index = WORKFLOW_STAGE_IDS.indexOf(input.definition.id);
  const activeIndex = WORKFLOW_STAGE_IDS.indexOf(input.activeStageId);
  const baseStatus = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
  const status = input.statusOverride[input.definition.id] ?? inferredStageStatus(input.definition.id, baseStatus, input.input);
  const stageEvidence = evidenceForStage(input.definition.id, input.evidenceRefs);
  const counts = evidenceCounts(stageEvidence);
  return {
    id: input.definition.id,
    label: input.definition.label,
    status,
    actorChips: actorChipsForStage(input.definition.id, status, input.profileRoleMapping, input.stageMetadata),
    evidenceCounts: counts,
    substages: input.definition.substages.map((substage, substageIndex) => ({
      ...substage,
      status: substageIndex === 0 && status === "active" ? "active" : status === "done" ? "done" : "pending",
      evidenceCounts: counts,
      latestEvidence: stageEvidence.slice(0, 3),
      requiredEvidence: []
    })),
    latestAction: { label: status === "blocked" ? "Resolve blocker" : input.definition.nextAction, safeToRunFromDashboard: false, requiresConfirmation: false },
    blockers: [],
    nextAction: input.definition.nextAction
  };
}
function inferredStageStatus(stageId, baseStatus, input) {
  if (stageId === "verify" && input.ci.some((check) => check.conclusion === "failure" || check.conclusion === "timed_out")) {
    return "failed";
  }
  if (stageId === "pr" && baseStatus === "active" && !input.pr) {
    return "manual";
  }
  if (stageId === "merge_readiness" && input.mergeReadiness && !input.mergeReadiness.ready && baseStatus === "active") {
    return "blocked";
  }
  return baseStatus;
}
function effectivePrState(state, events) {
  if (state !== "BLOCKED" && state !== "STOPPED") return state;
  const historical = [...events].sort((a, b) => b.seq - a.seq);
  for (const event of historical) {
    const candidates = [event.stateBefore, event.stateAfter];
    for (const candidate of candidates) {
      if (candidate && PR_STATES.has(candidate) && candidate !== "BLOCKED" && candidate !== "STOPPED") {
        return candidate;
      }
    }
  }
  return void 0;
}
function advanceStageWithEvidence(stateStage, evidenceStage, state) {
  if (!evidenceStage || state === "SYNC_MAIN") return stateStage;
  return stageIndex(evidenceStage) > stageIndex(stateStage) ? evidenceStage : stateStage;
}
function workflowStageSignal(events) {
  let latestDone;
  for (const event of [...events].filter((event2) => event2.kind === WORKFLOW_EVIDENCE_KIND).sort((left, right) => right.seq - left.seq)) {
    const status = payloadString(event, "status") ?? "done";
    const stageId = payloadStage(event);
    if (status === "done") {
      const doneSignal = { event, stageId, status };
      if (!latestDone || stageIndex(stageId) > stageIndex(latestDone.stageId)) {
        latestDone = doneSignal;
      }
      continue;
    }
    if (!isCurrentStageSignalStatus(status)) continue;
    if (latestDone && stageIndex(latestDone.stageId) >= stageIndex(stageId)) {
      return latestDone;
    }
    return { event, stageId, status };
  }
  return latestDone;
}
function isCurrentStageSignalStatus(value) {
  return value === "active" || value === "manual" || value === "blocked" || value === "failed";
}
function stageIndex(stageId) {
  return WORKFLOW_STAGE_IDS.indexOf(stageId);
}
function boardStageForState(state, input) {
  if (state === "WRITE_SPEC") return "plan";
  if (state === "CREATE_BRANCH" || state === "IMPLEMENT") return "build";
  if (state === "SELF_CHECK") return "verify";
  if (state === "COMMIT_PUSH_PR" || state === "PUSH_FIX") return "pr";
  if (state === "FIX_REVIEW") return "review";
  if (state === "READY_TO_MERGE") return "merge_readiness";
  if (state === "MERGE") return "cleanup";
  if (state === "WAIT_REVIEW_OR_CI") return reviewOrMergeReadiness(input);
  if (state === "SYNC_MAIN") return hasCleanupEvidence(input) ? "cleanup" : "work_item";
  if (state === "DISCOVER_PROGRESS" || state === "SELECT_NEXT_PR" || state === void 0) {
    return "work_item";
  }
  return "work_item";
}
function reviewOrMergeReadiness(input) {
  if (input.reviewComments.some((comment) => comment.actionable && !comment.isResolved && !comment.isOutdated)) {
    return "review";
  }
  if (input.events.some((event) => event.kind === WORKFLOW_EVIDENCE_KIND && payloadStage(event) === "review")) {
    return "review";
  }
  return "merge_readiness";
}
function hasCleanupEvidence(input) {
  return input.events.some((event) => {
    const text = `${event.kind} ${event.message}`.toLowerCase();
    return payloadStage(event) === "cleanup" || text.includes("merged") || text.includes("gitnexus analyze") || text.includes("pulled latest");
  });
}
function stageForGate(gate, fallback) {
  const map = {
    needs_repo_init: "work_item",
    unsupported_remote: "work_item",
    needs_secret_or_login: "work_item",
    ambiguous_next_pr: "work_item",
    generic_goal_needs_confirmation: "work_item",
    policy_violation: "plan",
    required_tool_unavailable: "plan",
    gitnexus_check_failed: "verify",
    dirty_unowned_worktree: "build",
    worker_failed: "build",
    worker_output_invalid: "build",
    worker_timeout: "build",
    worker_already_running: "build",
    review_out_of_scope: "review",
    generic_human_gate: "review",
    generic_scope_change_requested: "review",
    ci_required_checks_missing: "merge_readiness",
    ci_pending_timeout: "merge_readiness",
    merge_requires_confirmation: "merge_readiness",
    github_transient_failure: fallback === "pr" ? "pr" : "merge_readiness",
    github_resource_not_found: fallback === "pr" ? "pr" : "merge_readiness"
  };
  return map[gate.kind] ?? fallback;
}
function gateBlocker(gate, stageId) {
  return {
    id: gate.id,
    severity: gate.kind.startsWith("ci_") ? "ci" : gate.kind.startsWith("review_") ? "review" : "policy",
    title: gate.kind,
    reason: gate.message,
    owner: stageId === "merge_readiness" ? "GitHub / Codex" : "Codex",
    nextAction: "Inspect the gate and resolve the required condition.",
    evidenceRefIds: [gate.id]
  };
}
function actorChipsForStage(stageId, status, profileRoleMapping = [], stageMetadata = []) {
  const active = status === "active" || status === "blocked" || status === "manual";
  const metadataActors = stageMetadata.filter((item) => stageForProfileState(item.state) === stageId && item.workerType).map((item) => {
    const role = profileRoleMapping.find((mapping) => mapping.state === item.state);
    return {
      actor: workflowActorForWorkerType(item.workerType),
      label: role?.label ?? item.roleAlias ?? item.workerType ?? "Worker",
      status: active ? status : status === "done" ? "done" : "pending",
      ...item.workerType ? { model: `${item.workerType}${item.sandbox ? ` / ${item.sandbox}` : ""}` } : {}
    };
  });
  if (metadataActors.length > 0) return uniqueActorChips(metadataActors);
  const stageActors = {
    work_item: [{ actor: "codex", label: "Codex" }, { actor: "human", label: "Human" }],
    plan: [{ actor: "codex", label: "Codex" }, { actor: "gitnexus", label: "GitNexus" }],
    build: [{ actor: "codex", label: "Codex" }, { actor: "worker", label: "Worker" }],
    verify: [{ actor: "codex", label: "Codex" }, { actor: "tester", label: "Tester" }, { actor: "reviewer", label: "Reviewer" }],
    pr: [{ actor: "codex", label: "Codex" }, { actor: "github", label: "GitHub" }],
    review: [{ actor: "claude_acp", label: "Claude ACP" }, { actor: "agy_gemini", label: "AGY/Gemini" }, { actor: "github", label: "GitHub" }],
    merge_readiness: [{ actor: "github_ci", label: "GitHub CI" }, { actor: "reviewer", label: "Reviewer" }, { actor: "human", label: "Human" }],
    cleanup: [{ actor: "codex", label: "Codex" }, { actor: "gitnexus", label: "GitNexus" }]
  };
  return stageActors[stageId].map((item) => ({
    ...item,
    status: active ? status : status === "done" ? "done" : "pending"
  }));
}
function stageForProfileState(state) {
  return boardStageForState(state, {
    config: {},
    gates: [],
    events: [],
    workers: [],
    artifacts: [],
    ci: [],
    reviewComments: [],
    decisions: [],
    runChecks: []
  });
}
function workflowActorForWorkerType(workerType) {
  if (workerType === "reviewer") return "reviewer";
  if (workerType === "review-fix") return "reviewer";
  return "worker";
}
function uniqueActorChips(chips) {
  const seen = /* @__PURE__ */ new Set();
  return chips.filter((chip) => {
    const key = `${chip.actor}:${chip.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function evidenceCounts(refs) {
  return refs.reduce((counts, ref) => {
    if (ref.kind === "event") counts.events += 1;
    if (ref.kind === "artifact") counts.artifacts += 1;
    if (ref.kind === "gate") counts.gates += 1;
    if (ref.kind === "pr_comment") counts.prComments += 1;
    if (ref.kind === "gitnexus") counts.gitnexus += 1;
    if (ref.kind === "browser") counts.browser += 1;
    if (ref.kind === "github_check") counts.ci += 1;
    if (ref.kind === "report") counts.reports += 1;
    return counts;
  }, emptyCounts());
}
function evidenceForStage(stageId, refs) {
  return refs.filter((ref) => ref.source === stageId || ref.id.startsWith(`${stageId}:`));
}
function appendedEvidenceRefs(events) {
  return events.filter((event) => event.kind === WORKFLOW_EVIDENCE_KIND).map((event) => ({
    id: event.id,
    kind: evidenceKindFromSource(payloadString(event, "source") ?? "manual"),
    label: stageLabel(payloadStage(event)),
    summary: redactSecrets(event.message),
    interaction: "drill_down_link",
    drillDownTarget: { page: "Event Ledger" },
    createdAt: event.createdAt,
    source: payloadStage(event)
  }));
}
function gateEvidenceRefs(gates) {
  return gates.map((gate) => ({
    id: gate.id,
    kind: "gate",
    label: gate.kind,
    summary: gate.message,
    interaction: "drill_down_link",
    drillDownTarget: { page: "Gate Center" },
    createdAt: gate.createdAt,
    source: stageForGate(gate, "work_item")
  }));
}
function eventEvidenceRefs(events) {
  return events.filter((event) => event.kind !== WORKFLOW_EVIDENCE_KIND).slice(0, 20).map((event) => ({
    id: event.id,
    kind: event.kind.includes("gitnexus") ? "gitnexus" : event.kind.includes("browser") ? "browser" : "event",
    label: event.kind,
    summary: redactSecrets(event.message),
    interaction: "drill_down_link",
    drillDownTarget: { page: event.kind.includes("gitnexus") ? "Scope Guard" : "Event Ledger" },
    createdAt: event.createdAt,
    source: eventStageGuess(event)
  }));
}
function artifactEvidenceRefs(artifacts) {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    kind: "artifact",
    label: artifact.name,
    summary: artifact.kind,
    interaction: "drill_down_link",
    drillDownTarget: { page: "Artifact Diff Viewer" },
    createdAt: artifact.createdAt,
    source: artifact.kind.includes("spec") ? "plan" : "build"
  }));
}
function ciEvidenceRefs(ci) {
  return ci.map((check) => ({
    id: check.id,
    kind: "github_check",
    label: check.name,
    summary: check.conclusion ?? check.status,
    interaction: "drill_down_link",
    drillDownTarget: { page: "PR Inbox" },
    createdAt: check.observedAt,
    source: "merge_readiness"
  }));
}
function reviewEvidenceRefs(comments) {
  return comments.map((comment) => ({
    id: comment.id,
    kind: "pr_comment",
    label: comment.author,
    summary: redactSecrets(comment.body.slice(0, 180)),
    interaction: "drill_down_link",
    drillDownTarget: { page: "PR Inbox" },
    createdAt: comment.observedAt,
    source: "review"
  }));
}
function workerEvidenceRefs(workers) {
  return workers.map((worker) => ({
    id: worker.id,
    kind: "event",
    label: worker.type,
    summary: worker.error ? redactSecrets(worker.error) : worker.status,
    interaction: "drill_down_link",
    drillDownTarget: { page: "Worker Runs" },
    createdAt: worker.completedAt ?? worker.startedAt,
    source: worker.type === "reviewer" ? "verify" : "build"
  }));
}
function reviewRows(input, appended) {
  const rows = [];
  const structured = latestStructuredReviewEvidence(input.events);
  for (const { event, review } of structured.values()) {
    const ref = appended.find((item) => item.id === event.id);
    rows.push(reviewRowFromEvidence(event, review, ref));
  }
  rows.push(...input.reviewComments.map((comment) => ({
    id: comment.id,
    agent: comment.author,
    status: comment.actionable && !comment.isResolved ? "block" : "unknown",
    prComment: "posted",
    severitySummary: "no severity evidence",
    nextAction: comment.actionable && !comment.isResolved ? "Classify and fix or reply." : "No action from available evidence.",
    evidenceRefIds: [comment.id]
  })));
  for (const event of input.events.filter((item) => item.kind === WORKFLOW_EVIDENCE_KIND && payloadStage(item) === "review")) {
    if (parseStoredReviewEvidence(event)) continue;
    const ref = appended.find((item) => item.id === event.id);
    const refs = payloadStringArray(event, "evidenceRefIds");
    const actor = payloadString(event, "actor");
    const status = payloadString(event, "status");
    rows.push({
      id: event.id,
      agent: reportAgentLabel(actor, event.message),
      status: status === "skipped" ? "skipped" : status === "blocked" || status === "failed" ? "block" : status === "done" ? "pass" : "unknown",
      prComment: refs.some(isGitHubIssueCommentUrl) ? "posted" : "unknown",
      severitySummary: "no severity evidence",
      reason: status === "skipped" ? event.message : void 0,
      nextAction: "Inspect legacy review evidence; structured completion data is unavailable.",
      evidenceRefIds: ref ? [ref.id, ...refs] : [event.id, ...refs]
    });
  }
  if (!rows.some((row) => row.agent === "Claude ACP")) {
    rows.push({
      id: "review:claude-unknown",
      agent: "Claude ACP",
      status: "unknown",
      prComment: "unknown",
      severitySummary: "no requirement source",
      requirement: "unknown",
      progress: "unknown",
      result: "unknown",
      reason: "No required Claude review evidence source exists yet.",
      nextAction: "Attach Claude review evidence when this work requires it.",
      evidenceRefIds: []
    });
  }
  if (!rows.some((row) => row.agent === "AGY/Gemini")) {
    rows.push({
      id: "review:agy-unknown",
      agent: "AGY/Gemini",
      status: "unknown",
      prComment: "unknown",
      severitySummary: "no requirement source",
      requirement: "unknown",
      progress: "unknown",
      result: "unknown",
      reason: "No required AGY/Gemini review evidence source exists yet.",
      nextAction: "Attach AGY/Gemini review evidence when this work requires it.",
      evidenceRefIds: []
    });
  }
  return rows;
}
function latestStructuredReviewEvidence(events) {
  const latest = /* @__PURE__ */ new Map();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.kind !== WORKFLOW_EVIDENCE_KIND || payloadStage(event) !== "review") continue;
    const review = parseStoredReviewEvidence(event);
    if (review) latest.set(review.reviewer, { event, review });
  }
  return latest;
}
function reviewRowFromEvidence(event, review, ref) {
  const refs = payloadStringArray(event, "evidenceRefIds");
  const progress = effectiveReviewProgress(review);
  const prComment = review.requirement === "not_required" || progress === "skipped" ? "not_required" : review.commentUrl ? "posted" : review.requirement === "required" ? "missing" : "unknown";
  return {
    id: event.id,
    agent: reviewAgentLabel(review.reviewer),
    model: review.model,
    status: reviewStatus(review, progress),
    prComment,
    severitySummary: reviewSeverityLabel(review.severitySummary),
    requirement: review.requirement,
    progress,
    result: review.result,
    commentUrl: review.commentUrl,
    commentId: review.commentId,
    sessionId: review.sessionId,
    conversationId: review.conversationId,
    reason: review.reason,
    nextAction: reviewNextAction(review, progress, prComment),
    evidenceRefIds: [
      ...ref ? [ref.id] : [event.id],
      ...refs,
      ...review.commentUrl ? [review.commentUrl] : []
    ]
  };
}
function effectiveReviewProgress(review) {
  if (review.requirement === "not_required" && review.progress === "skipped") return "skipped";
  if (review.requirement === "not_required" && review.progress === "complete") return "complete";
  if (review.progress === "complete" && !review.commentUrl) return "incomplete";
  if (review.requirement === "required" && review.progress === "unknown") return "incomplete";
  return review.progress;
}
function reviewStatus(review, progress) {
  if (progress === "skipped") return "skipped";
  if (review.result === "block") return "block";
  if (review.result === "warn") return "warn";
  if (review.result === "pass") return "pass";
  if (progress === "requested" || progress === "started" || progress === "in_progress" || progress === "incomplete") return "pending";
  return "unknown";
}
function reviewNextAction(review, progress, prComment) {
  if (review.result === "block" || review.severitySummary === "p2_or_higher") return "Fix or route blocking findings before merge.";
  if (progress === "incomplete") return "Attach the missing required report evidence.";
  if (progress === "requested" || progress === "started" || progress === "in_progress") return "Wait for the reviewer report and PR comment.";
  if (prComment === "missing") return "Post or link the PR review report comment.";
  if (progress === "skipped") return review.reason ?? "Reviewer explicitly skipped.";
  if (progress === "complete") return "Keep report linked in PR evidence.";
  return "Attach structured review evidence when available.";
}
function reviewAgentLabel(reviewer) {
  const labels = {
    claude_acp: "Claude ACP",
    agy_gemini: "AGY/Gemini",
    internal_tester: "Internal tester",
    internal_reviewer: "Internal reviewer",
    github: "GitHub",
    human: "Human",
    custom: "Custom reviewer"
  };
  return labels[reviewer];
}
function reviewSeverityLabel(severity) {
  const labels = {
    none: "none",
    p3_only: "P3 only",
    p2_or_higher: "P2 or higher",
    unknown: "no severity evidence"
  };
  return labels[severity];
}
function verificationRows(input) {
  const checks = [
    { id: "lint", label: "Lint", status: "unknown", evidence: "no appended evidence", owner: "Codex" },
    { id: "focused_tests", label: "Focused tests", status: "unknown", evidence: "no appended evidence", owner: "Codex" },
    { id: "full_tests", label: "Full tests", status: "unknown", evidence: "no appended evidence", owner: "Codex" },
    { id: "gitnexus_detect", label: "GitNexus detect", status: "unknown", evidence: "no appended evidence", owner: "GitNexus" }
  ];
  for (const check of input.ci) {
    checks.push({
      id: `ci:${check.id}`,
      label: check.name,
      status: check.conclusion === "success" ? "passed" : check.conclusion ? "failed" : "pending",
      evidence: check.conclusion ?? check.status,
      owner: "GitHub CI"
    });
  }
  return checks;
}
function mergeReadinessRows(input) {
  const readiness = input.mergeReadiness;
  if (hasCleanupEvidence(input)) {
    return [
      { id: "merge_policy", label: "Merge policy", status: "passed", evidence: "cleanup evidence supersedes pre-merge blockers", owner: "Codex" },
      { id: "findings_gate", label: "No unresolved P0/P1/P2", status: "passed", evidence: "cleanup evidence recorded after merge", owner: "Reviewer" }
    ];
  }
  if (!readiness) {
    return [{ id: "merge_policy", label: "Merge policy", status: "unknown", evidence: "merge readiness not available", owner: "Codex" }];
  }
  const evidenceRows = readiness.evidence.map((item, index) => ({
    id: `merge:evidence:${index}`,
    label: item,
    status: "passed",
    evidence: item,
    owner: "Codex"
  }));
  const missingRows = readiness.missingConditions.map((item, index) => ({
    id: `merge:missing:${index}`,
    label: item,
    status: "blocked",
    evidence: item,
    owner: "Codex"
  }));
  const blockingReview = blockingReviewEvidence(input.events);
  const satisfiedReview = satisfiedReviewEvidence(input.events);
  const findingsGate = blockingReview ? { id: "findings_gate", label: "No unresolved P0/P1/P2", status: "blocked", evidence: blockingReview.message, owner: reviewAgentLabel(blockingReview.review.reviewer) } : satisfiedReview ? { id: "findings_gate", label: "No unresolved P0/P1/P2", status: "passed", evidence: satisfiedReview, owner: "Reviewer" } : { id: "findings_gate", label: "No unresolved P0/P1/P2", status: "unknown", evidence: "no severity evidence", owner: "Reviewer" };
  return [
    ...evidenceRows,
    ...missingRows,
    findingsGate
  ];
}
function blockingReviewEvidence(events) {
  for (const { event, review } of latestStructuredReviewEvidence(events).values()) {
    if (review && (review.result === "block" || review.severitySummary === "p2_or_higher")) {
      return { message: event.message, review };
    }
  }
  return void 0;
}
function satisfiedReviewEvidence(events) {
  const required = [...latestStructuredReviewEvidence(events).values()].filter(({ review }) => review.requirement === "required");
  if (required.length === 0) return void 0;
  const allClear = required.every(
    ({ review }) => effectiveReviewProgress(review) === "complete" && review.result === "pass" && (review.severitySummary === "none" || review.severitySummary === "p3_only")
  );
  return allClear ? "all required structured reviews passed without P0/P1/P2 evidence" : void 0;
}
function cleanupRows(input) {
  const evidence = cleanupEvidenceBySubstage(input.events);
  return [
    cleanupCheck("pr_merged", "PR merged", "GitHub", evidence, input.pr?.state === "MERGED", input.pr?.state ?? "no PR link"),
    cleanupCheck("switched_main", "Switched to main", "Codex", evidence),
    cleanupCheck("pulled_latest", "Pulled latest", "Codex", evidence),
    cleanupCheck("gitnexus_reindexed", "GitNexus index rebuilt", "GitNexus", evidence),
    cleanupCheck("worktree_clean", "Worktree clean", "Codex", evidence, input.run?.worktreeClean === true, String(input.run?.worktreeClean ?? "unknown"))
  ];
}
function cleanupCheck(id, label, owner, evidence, fallbackPassed = false, fallbackEvidence = "no appended evidence") {
  const event = evidence.get(id);
  if (event) {
    return { id, label, status: "passed", evidence: event.message, owner };
  }
  return { id, label, status: fallbackPassed ? "passed" : "pending", evidence: fallbackEvidence, owner };
}
function cleanupEvidenceBySubstage(events) {
  const bySubstage = /* @__PURE__ */ new Map();
  for (const event of [...events].sort((left, right) => right.seq - left.seq)) {
    if (event.kind !== WORKFLOW_EVIDENCE_KIND || payloadStage(event) !== "cleanup") continue;
    const substageId = payloadString(event, "substageId");
    if (substageId && !bySubstage.has(substageId)) {
      bySubstage.set(substageId, event);
    }
  }
  return bySubstage;
}
function payloadStage(event) {
  const stageId = payloadString(event, "stageId");
  return isWorkflowStageId(stageId) ? stageId : eventStageGuess(event);
}
function payloadString(event, key) {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return void 0;
  }
  const value = payload[key];
  return typeof value === "string" ? value : void 0;
}
function payloadStringArray(event, key) {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [];
  }
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function parseStoredReviewEvidence(event) {
  if (!isRecord2(event.payload)) return void 0;
  const review = event.payload.review;
  if (!isRecord2(review)) return void 0;
  if (!isWorkflowReviewReviewer(review.reviewer)) return void 0;
  if (!isWorkflowReviewRequirement(review.requirement)) return void 0;
  if (!isWorkflowReviewProgress(review.progress)) return void 0;
  if (!isWorkflowReviewResult(review.result)) return void 0;
  if (!isWorkflowReviewSeverity(review.severitySummary)) return void 0;
  const commentUrl = typeof review.commentUrl === "string" ? review.commentUrl : void 0;
  return {
    reviewer: review.reviewer,
    requirement: review.requirement,
    progress: review.progress,
    result: review.result,
    severitySummary: review.severitySummary,
    ...optionalStoredReviewString("model", review.model),
    ...optionalStoredReviewString("sessionId", review.sessionId),
    ...optionalStoredReviewString("conversationId", review.conversationId),
    ...commentUrl && isGitHubIssueCommentUrl(commentUrl) ? { commentUrl } : {},
    ...optionalStoredReviewString("commentId", review.commentId),
    ...optionalStoredReviewString("reason", review.reason)
  };
}
function optionalStoredReviewString(key, value) {
  return typeof value === "string" && value.trim().length > 0 ? { [key]: value } : {};
}
function isWorkflowReviewReviewer(value) {
  return typeof value === "string" && REVIEW_REVIEWERS.includes(value);
}
function isWorkflowReviewRequirement(value) {
  return typeof value === "string" && REVIEW_REQUIREMENTS.includes(value);
}
function isWorkflowReviewProgress(value) {
  return typeof value === "string" && REVIEW_PROGRESS.includes(value);
}
function isWorkflowReviewResult(value) {
  return typeof value === "string" && REVIEW_RESULTS.includes(value);
}
function isWorkflowReviewSeverity(value) {
  return typeof value === "string" && REVIEW_SEVERITIES.includes(value);
}
function eventStageGuess(event) {
  const text = `${event.kind} ${event.message}`.toLowerCase();
  if (text.includes("review")) return "review";
  if (text.includes("ci") || text.includes("merge readiness")) return "merge_readiness";
  if (text.includes("pr ") || text.includes("pull request")) return "pr";
  if (text.includes("test") || text.includes("lint") || text.includes("gitnexus")) return "verify";
  if (text.includes("branch") || text.includes("implement") || text.includes("worker")) return "build";
  if (text.includes("plan") || text.includes("spec")) return "plan";
  if (text.includes("merge") || text.includes("cleanup")) return "cleanup";
  return "work_item";
}
function stageLabel(stageId) {
  return STAGE_BY_ID.get(stageId)?.label ?? stageId;
}
function evidenceKindFromSource(source) {
  const normalized = source.toLowerCase();
  if (normalized.includes("gitnexus")) return "gitnexus";
  if (normalized.includes("browser")) return "browser";
  if (normalized.includes("review") || normalized.includes("claude") || normalized.includes("agy") || normalized.includes("gemini")) return "report";
  if (normalized.includes("ci")) return "github_check";
  return "event";
}
function reportAgentLabel(actor, summary) {
  const lower = summary.toLowerCase();
  if (actor === "agy_gemini" || lower.includes("agy") || lower.includes("gemini")) return "AGY/Gemini";
  if (actor === "claude_acp" || lower.includes("claude")) return "Claude ACP";
  if (actor === "tester") return "Internal tester";
  if (actor === "reviewer") return "Internal reviewer";
  return "Review evidence";
}
function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim().length > 0) : [];
}
function isWorkflowActor(value) {
  return typeof value === "string" && [
    "codex",
    "worker",
    "tester",
    "reviewer",
    "claude_acp",
    "agy_gemini",
    "github",
    "github_ci",
    "gitnexus",
    "browser",
    "human"
  ].includes(value);
}
function isWorkflowStageStatus(value) {
  return typeof value === "string" && ["pending", "active", "blocked", "done", "skipped", "manual", "failed"].includes(value);
}
function isAgentLoopState(value) {
  return typeof value === "string" && PR_STATES.has(value);
}

// plugins/autonomous-pr-loop/core/mcp-controller.ts
var NOTIFICATION_EVENT_LIMIT = 100;
var HISTORICAL_EVENT_SCAN_LIMIT = 1e5;
var HISTORICAL_EVENT_KIND = "historical_gate_marked_handled";
var HISTORICAL_REEVALUATED_EVENT_KIND = "historical_gate_re_evaluated";
var McpController = class {
  constructor(options) {
    this.options = options;
  }
  options;
  loopStatus() {
    return this.withConfig(() => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      const current = storage.getCurrentStatus();
      return ok({ ...current, nextAction: nextAction(current.status, current.gate?.kind) });
    }));
  }
  loopMissionControl() {
    return this.withConfig((config) => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      const snapshot = storage.readTransaction(() => {
        const current = storage.getCurrentStatus();
        const run = current.run ?? storage.getCurrentRun();
        const events = storage.listEvents(NOTIFICATION_EVENT_LIMIT);
        const historicalEvents = storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT);
        const runs = storage.listRuns(20);
        const dismissedHistoricalGateIds = historicalGateHandledIds(historicalEvents);
        const gates = annotateGates({
          gates: storage.listGates(),
          current,
          ...run ? { run } : {},
          runs,
          dismissedHistoricalGateIds
        });
        const activeGates = gates.filter((gate) => gate.activity === "active");
        const currentRunGates = gates.filter((gate) => gate.activity === "active" && (gate.runId === run?.id || gate.runId === void 0));
        const missionCurrent = currentForMissionControl(current, gates);
        const effectiveConfig = applyProfileConfig(config);
        const shape = resolveLoopShape(effectiveConfig.loopShape);
        const ci = shape.id === "pr-loop" && run ? storage.listCiChecks(run.id) : [];
        const reviewComments = shape.id === "pr-loop" && run ? storage.listReviewComments(run.id) : [];
        const decisions = shape.id === "pr-loop" && run ? storage.listDecisions(run.id) : [];
        const runChecks = shape.id === "pr-loop" && run ? storage.listRunChecks(run.id) : [];
        const deliveryWorkItem = getDeliveryWorkItem(storage, run?.id);
        const selection = shape.id === "pr-loop" ? resolvePrSelection(this.options.repoRoot, effectiveConfig, {
          ...deliveryWorkItem ? { workItem: deliveryWorkItem } : {}
        }) : void 0;
        const workers = annotateWorkers({
          workers: storage.listWorkers(void 0, 20),
          gates,
          ...run ? { run } : {}
        });
        const activeWorkers = workers.filter((worker) => worker.activity === "active");
        const timeline = storage.listAgentTimeline({
          limit: 20,
          ...run ? { runId: run.id } : {}
        }).entries;
        const mergeReadiness = shape.id === "pr-loop" ? evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates: currentRunGates, decisions, runChecks }) : void 0;
        const missionMergeReadiness = mergeReadiness ? mergeReadinessForMissionDisplay(mergeReadiness, events) : void 0;
        const dismissedIds = notificationDismissedIds2(events);
        const notifications = deriveNotifications({ config: effectiveConfig, events, gates: activeGates, timelineEntries: timeline, workers: activeWorkers, ...mergeReadiness ? { mergeReadiness } : {}, ...run ? { runId: run.id } : {}, now: /* @__PURE__ */ new Date(), dismissedIds });
        return {
          current: { ...missionCurrent, nextAction: nextAction(missionCurrent.status, missionCurrent.gate?.kind) },
          gates,
          pr: shape.id === "pr-loop" && run ? storage.getPrLink(run.id) : void 0,
          ci: shape.id === "pr-loop" ? ci : [],
          reviewComments: shape.id === "pr-loop" ? reviewComments : [],
          workers,
          artifacts: run ? storage.listArtifacts(run.id) : [],
          events,
          decisions,
          timelineSummary: buildTimelineSummary({
            timeline,
            workers,
            ...run ? { currentRunId: run.id } : {},
            listWorkerEvents: (workerId) => storage.listWorkerEvents(workerId)
          }),
          autonomy: describeAutonomyPosture(effectiveConfig),
          mergeReadiness: missionMergeReadiness,
          notifications,
          profile: resolveProfile(effectiveConfig, run?.currentState),
          plan: selection?.plan,
          selection: selection ? selectionSummary(selection) : genericSelectionSummary(effectiveConfig),
          recoveryWarnings: recoveryWarnings(missionCurrent.gate?.kind, gates, workers)
        };
      });
      return ok(snapshot);
    }));
  }
  loopWorkflowBoard(input = {}) {
    return this.withConfig((config) => this.withStorageReadOnly((storage) => storage.readTransaction(() => {
      const effectiveConfig = applyProfileConfig(config);
      const run = selectWorkflowBoardRun(storage, input.runId);
      const currentRun = storage.getCurrentRun();
      const deliveryWorkItem = getDeliveryWorkItem(storage, run?.id);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      const gates = run ? storage.listGates(run.id) : storage.listGates();
      const ci = shape.id === "pr-loop" && run ? storage.listCiChecks(run.id) : [];
      const reviewComments = shape.id === "pr-loop" && run ? storage.listReviewComments(run.id) : [];
      const decisions = shape.id === "pr-loop" && run ? storage.listDecisions(run.id) : [];
      const runChecks = shape.id === "pr-loop" && run ? storage.listRunChecks(run.id) : [];
      const mergeReadiness = shape.id === "pr-loop" && run ? evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates, decisions, runChecks }) : void 0;
      return ok(deriveWorkflowBoard({
        config: effectiveConfig,
        ...run ? { run } : {},
        ...currentRun ? { currentRun } : {},
        gates,
        events: storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT).filter((event) => !run || event.runId === run.id || event.runId === void 0),
        workers: run ? storage.listWorkers(run.id, 20) : [],
        artifacts: run ? storage.listArtifacts(run.id) : [],
        pr: run && shape.id === "pr-loop" ? storage.getPrLink(run.id) : void 0,
        ci,
        reviewComments,
        decisions,
        runChecks,
        ...deliveryWorkItem ? { deliveryWorkItem } : {},
        ...mergeReadiness ? { mergeReadiness } : {},
        hookCapture: inspectHookCapture(this.options.repoRoot)
      }));
    })));
  }
  loopAppendWorkflowEvidence(body, token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    if (!isRecord(body)) {
      return fail(new AgentLoopError("invalid_config", "Workflow evidence append requires a JSON object."));
    }
    return this.withConfig(() => this.withStorage((storage) => ok(appendWorkflowEvidence(storage, {
      runId: typeof body.runId === "string" ? body.runId : void 0,
      stageId: typeof body.stageId === "string" ? body.stageId : void 0,
      substageId: typeof body.substageId === "string" ? body.substageId : void 0,
      summary: typeof body.summary === "string" ? body.summary : void 0,
      evidenceRefIds: body.evidenceRefIds,
      artifactIds: body.artifactIds,
      actor: typeof body.actor === "string" ? body.actor : void 0,
      status: typeof body.status === "string" ? body.status : void 0,
      source: typeof body.source === "string" ? body.source : "dashboard",
      review: body.review
    }))));
  }
  loopAgentTimeline(query = {}) {
    return this.withConfig(() => this.withStorageReadOnly((storage) => ok(storage.listAgentTimeline(query))));
  }
  loopObserve(limit = 20) {
    return this.withConfig((config) => this.withStorageReadOnly((storage) => storage.readTransaction(() => {
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const timeline = storage.listAgentTimeline({
        limit,
        ...run ? { runId: run.id } : {}
      });
      return ok({
        dashboard: dashboardInfo(config),
        happy: detectHappy(),
        current: { ...current, nextAction: nextAction(current.status, current.gate?.kind) },
        timeline
      });
    })));
  }
  loopNextAction() {
    return this.withConfig(() => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      const current = storage.getCurrentStatus();
      return ok({ nextAction: nextAction(current.status, current.gate?.kind), current });
    }));
  }
  loopStep(token) {
    const auth = this.requireToken(token);
    if (auth) return Promise.resolve(auth);
    return this.withConfigAsync(async () => ok(await runStateMachine({
      repoRoot: this.options.repoRoot,
      dryRun: false,
      untilGate: false,
      singleStep: true
    })));
  }
  loopResume(token) {
    const auth = this.requireToken(token);
    if (auth) return Promise.resolve(auth);
    return this.withConfigAsync(async () => ok(await resumeStateMachine(this.options.repoRoot)));
  }
  loopStop(token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig(() => ok(stopStateMachine(this.options.repoRoot)));
  }
  loopRunUntilGate(token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig((config) => this.withStorage((storage) => {
      const effectiveConfig = applyProfileConfig(config);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      const { run, created } = storage.getOrCreateActiveRun({ currentState: shape.initialState });
      const workerGate = blockRunForTerminalWorker(storage, run);
      if (workerGate) {
        return ok({
          runId: workerGate.runId,
          status: workerGate.status,
          alreadyRunning: !created,
          reconciled: true,
          gate: workerGate.gate
        });
      }
      if (created) {
        storage.appendEvent({
          runId: run.id,
          kind: "mcp_run_until_gate_started",
          message: "MCP requested background run until gate."
        });
        const started = (this.options.startRun ?? startBackgroundRun)(this.options.repoRoot, run.id);
        if (started === false) {
          storage.updateRunStatus(run.id, run.version, "BLOCKED", { currentState: run.currentState ?? shape.initialState });
          storage.writeGate({
            runId: run.id,
            kind: "required_tool_unavailable",
            message: "Could not start background agent-loop run."
          });
          const gate = storage.listGates(run.id).find((item) => item.status === "open");
          return fail(new AgentLoopError("required_tool_unavailable", "Could not start background run.", {
            details: { runId: run.id, gate }
          }));
        }
      }
      return ok({ runId: run.id, status: "RUNNING", alreadyRunning: !created });
    }));
  }
  loopListGates() {
    return this.withConfig(() => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      return ok({ gates: annotatedGatesSnapshot(storage) });
    }));
  }
  loopExplainGate(gateId) {
    return this.withConfig(() => this.withStorageReadOnly((storage) => {
      const gate = annotatedGateSnapshot(storage, gateId);
      if (!gate) {
        throw new AgentLoopError("storage_error", `Gate not found: ${gateId}`);
      }
      return ok({ gate, nextAction: nextAction("BLOCKED", gate.kind) });
    }));
  }
  loopApproveGate(gateId, input, token) {
    return this.decideGate(gateId, "approved", input, token);
  }
  loopRejectGate(gateId, input, token) {
    return this.decideGate(gateId, "rejected", input, token);
  }
  loopListRuns(limit) {
    return this.withConfig(() => this.withStorageReadOnly((storage) => ok({ runs: storage.listRuns(limit) })));
  }
  loopListWorkers(input) {
    return this.withConfig(() => this.withStorageReadOnly((storage) => {
      const run = storage.getCurrentRun();
      const limit = typeof input === "number" ? input : input?.limit;
      const workerId = typeof input === "number" ? void 0 : input?.workerId;
      const includeEvents = typeof input === "number" ? false : input?.includeEvents === true;
      const workers = storage.listWorkers(run?.id, limit ?? 50).filter((worker) => !workerId || worker.id === workerId);
      if (!includeEvents) {
        return ok({ workers });
      }
      const eventsByWorker = Object.fromEntries(workers.map((worker) => [
        worker.id,
        storage.listAgentTimeline({ workerId: worker.id, sources: ["worker_event"], limit: 50 }).entries
      ]));
      return ok({ workers, eventsByWorker });
    }));
  }
  loopListEvents(sinceSeq, limit) {
    return this.withConfig(() => this.withStorageReadOnly((storage) => {
      const options = {
        ...sinceSeq === void 0 ? {} : { sinceSeq },
        limit: limit ?? 50
      };
      return ok({ events: storage.listEvents(options) });
    }));
  }
  loopReadArtifact(artifactId) {
    return this.withConfig(() => this.withStorageReadOnly((storage) => {
      const artifactRoot = resolve4(this.options.repoRoot, ".agent-loop", "artifacts");
      const record = storage.getArtifact(artifactId);
      assertArtifactPathInsideRoot(artifactRoot, record.path, artifactId);
      if (isSensitiveArtifactKind(record.kind)) {
        throw new AgentLoopError("policy_violation", `Artifact kind ${record.kind} is not readable through the dashboard API.`, {
          details: { artifactId, kind: record.kind }
        });
      }
      const artifact = readArtifact(storage, artifactId);
      return ok({
        record: artifact.record,
        contentBase64: artifact.content.toString("base64")
      });
    }));
  }
  loopGetPrStatus() {
    return this.withCurrentRun((storage, run) => ok({ pr: storage.getPrLink(run.id) }));
  }
  loopGetCiStatus() {
    return this.withCurrentRun((storage, run) => ok({ checks: storage.listCiChecks(run.id) }));
  }
  loopGetReviewComments() {
    return this.withCurrentRun((storage, run) => ok({ comments: storage.listReviewComments(run.id) }));
  }
  loopListArtifacts() {
    return this.withCurrentRun((storage, run) => ok({ artifacts: storage.listArtifacts(run.id) }));
  }
  loopDashboardMeta() {
    return this.withConfig((config) => {
      const effectiveConfig = applyProfileConfig(config);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      return ok({
        appName: "HOLO-Codex",
        surface: "dashboard",
        targetRepo: {
          root: this.options.repoRoot,
          repoId: config.repoId
        },
        pollingMs: 3e3,
        autonomy: describeAutonomyPosture(config),
        pages: [
          "Mission Control",
          "Plan Navigator",
          "Policy Config",
          "Dry-run Preview",
          "Notifications",
          "Gate Center",
          ...shape.id === "pr-loop" ? ["PR Inbox"] : [],
          "Worker Runs",
          "Scope Guard",
          "Event Ledger",
          "Artifact Diff Viewer",
          "Recovery Center"
        ]
      });
    });
  }
  loopPlanNavigator() {
    return this.withConfig((config) => {
      const effectiveConfig = applyProfileConfig(config);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      if (shape.id !== "pr-loop") {
        return ok({ plan: void 0, selection: genericSelectionSummary(effectiveConfig) });
      }
      const selection = resolvePrSelection(this.options.repoRoot, effectiveConfig);
      return ok({ plan: selection.plan, selection: selectionSummary(selection) });
    });
  }
  loopPolicyConfig() {
    return this.withConfig(() => ok(readConfigForEdit(this.options.repoRoot)));
  }
  loopSavePolicyConfig(body, token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    if (!isRecord(body) || !isRecord(body.nextConfig) || typeof body.expectedHash !== "string") {
      return fail(new AgentLoopError("invalid_config", "Policy config save requires nextConfig and expectedHash."));
    }
    const expectedHash = body.expectedHash;
    return this.withConfig(() => ok(saveConfigEdit(this.options.repoRoot, {
      nextConfig: body.nextConfig,
      expectedHash,
      ...typeof body.note === "string" ? { note: body.note } : {},
      ...typeof body.confirmationToken === "string" ? { confirmationToken: body.confirmationToken } : {}
    })));
  }
  loopDryRunPreview() {
    return this.withConfig((config) => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const effectiveConfig = applyProfileConfig(config);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      const profile = resolveProfile(effectiveConfig, run?.currentState);
      const selection = shape.id === "pr-loop" ? resolvePrSelection(this.options.repoRoot, effectiveConfig) : void 0;
      const gates = run ? storage.listGates(run.id) : storage.listGates();
      const openGates = gates.filter((gate) => gate.status === "open");
      const ci = run ? storage.listCiChecks(run.id) : [];
      const reviewComments = run ? storage.listReviewComments(run.id) : [];
      const decisions = run ? storage.listDecisions(run.id) : [];
      const runChecks = run ? storage.listRunChecks(run.id) : [];
      const mergeForecast = evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates, decisions, runChecks });
      return ok({
        nextPr: selection && !selection.ambiguous ? selection.item : void 0,
        branchName: selection && !selection.ambiguous ? selection.branchName : void 0,
        selection: selection ? selectionSummary(selection) : genericSelectionSummary(effectiveConfig),
        profile,
        workflowStages: workflowStages(effectiveConfig),
        commandsPlanned: [
          "git status --short --branch",
          "pnpm agent-loop run --until=gate",
          effectiveConfig.lintCommand,
          effectiveConfig.testCommand
        ].filter(Boolean),
        workerType: profile.roleMapping.find((role) => role.state === (shape.id === "generic-loop" ? "EXECUTE_STEP" : "IMPLEMENT"))?.workerType ?? "implementation",
        possibleGates: openGates.map((gate) => gate.kind),
        missingConditions: shape.id === "pr-loop" ? mergeForecast.missingConditions : openGates.map((gate) => gate.kind),
        filesLikelyTouched: shape.id === "pr-loop" ? likelyTouchedFiles(this.options.repoRoot, effectiveConfig.plansDir, selection && !selection.ambiguous ? selection.item.file : void 0) : genericLikelyTouchedFiles(effectiveConfig),
        autonomyForecast: describeAutonomyPosture(effectiveConfig),
        mergeForecast: shape.id === "pr-loop" ? mergeForecast : void 0
      });
    }));
  }
  loopNotifications() {
    return this.withConfig((config) => this.withStorageReadOnly((storage) => {
      const notifications = storage.readTransaction(() => {
        const effectiveConfig = applyProfileConfig(config);
        const shape = resolveLoopShape(effectiveConfig.loopShape);
        const current = storage.getCurrentStatus();
        const run = current.run ?? storage.getCurrentRun();
        const gates = run ? storage.listGates(run.id) : storage.listGates();
        const events = storage.listEvents(NOTIFICATION_EVENT_LIMIT);
        const workers = run ? storage.listWorkers(run.id, 20) : storage.listWorkers(void 0, 20);
        const ci = shape.id === "pr-loop" && run ? storage.listCiChecks(run.id) : [];
        const reviewComments = shape.id === "pr-loop" && run ? storage.listReviewComments(run.id) : [];
        const decisions = shape.id === "pr-loop" && run ? storage.listDecisions(run.id) : [];
        const runChecks = shape.id === "pr-loop" && run ? storage.listRunChecks(run.id) : [];
        const mergeReadiness = shape.id === "pr-loop" ? evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates, decisions, runChecks }) : void 0;
        const timelineEntries = run ? storage.listAgentTimeline({ runId: run.id, limit: 50 }).entries : [];
        return deriveNotifications({
          config: effectiveConfig,
          events,
          gates,
          timelineEntries,
          workers,
          ...mergeReadiness ? { mergeReadiness } : {},
          ...run ? { runId: run.id } : {},
          now: /* @__PURE__ */ new Date(),
          dismissedIds: notificationDismissedIds2(events)
        });
      });
      return ok({ notifications });
    }));
  }
  loopMarkNotificationsRead(body, token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig((config) => this.withStorage((storage) => {
      const effectiveConfig = applyProfileConfig(config);
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const events = storage.listEvents(NOTIFICATION_EVENT_LIMIT);
      const gates = run ? storage.listGates(run.id) : storage.listGates();
      const workers = run ? storage.listWorkers(run.id, 20) : storage.listWorkers(void 0, 20);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      const ci = shape.id === "pr-loop" && run ? storage.listCiChecks(run.id) : [];
      const reviewComments = shape.id === "pr-loop" && run ? storage.listReviewComments(run.id) : [];
      const decisions = shape.id === "pr-loop" && run ? storage.listDecisions(run.id) : [];
      const runChecks = shape.id === "pr-loop" && run ? storage.listRunChecks(run.id) : [];
      const mergeReadiness = shape.id === "pr-loop" ? evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates, decisions, runChecks }) : void 0;
      const notifications = deriveNotifications({
        config: effectiveConfig,
        events,
        gates,
        timelineEntries: run ? storage.listAgentTimeline({ runId: run.id, limit: 50 }).entries : [],
        workers,
        ...mergeReadiness ? { mergeReadiness } : {},
        ...run ? { runId: run.id } : {},
        now: /* @__PURE__ */ new Date(),
        dismissedIds: notificationDismissedIds2(events)
      });
      const requestedIds = isRecord(body) && Array.isArray(body.notificationIds) ? body.notificationIds.filter((id) => typeof id === "string") : notifications.map((notification) => notification.id);
      const notificationIds = requestedIds.filter((id) => notifications.some((notification) => notification.id === id));
      storage.appendEvent({
        ...current.run ? { runId: current.run.id } : {},
        kind: "notification_marked_read",
        message: `Marked ${notificationIds.length} notification(s) read.`,
        payload: { notificationIds, source: "dashboard" }
      });
      return ok({ markedRead: notificationIds.length, notificationIds });
    }));
  }
  loopDismissNotifications(body, token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig((config) => this.withStorage((storage) => {
      const effectiveConfig = applyProfileConfig(config);
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const events = storage.listEvents(NOTIFICATION_EVENT_LIMIT);
      const gates = run ? storage.listGates(run.id) : storage.listGates();
      const workers = run ? storage.listWorkers(run.id, 20) : storage.listWorkers(void 0, 20);
      const shape = resolveLoopShape(effectiveConfig.loopShape);
      const ci = shape.id === "pr-loop" && run ? storage.listCiChecks(run.id) : [];
      const reviewComments = shape.id === "pr-loop" && run ? storage.listReviewComments(run.id) : [];
      const decisions = shape.id === "pr-loop" && run ? storage.listDecisions(run.id) : [];
      const runChecks = shape.id === "pr-loop" && run ? storage.listRunChecks(run.id) : [];
      const mergeReadiness = shape.id === "pr-loop" ? evaluateMergeReadiness({ config: effectiveConfig, ci, reviewComments, gates, decisions, runChecks }) : void 0;
      const notifications = deriveNotifications({
        config: effectiveConfig,
        events,
        gates,
        timelineEntries: run ? storage.listAgentTimeline({ runId: run.id, limit: 50 }).entries : [],
        workers,
        ...mergeReadiness ? { mergeReadiness } : {},
        ...run ? { runId: run.id } : {},
        now: /* @__PURE__ */ new Date(),
        dismissedIds: notificationDismissedIds2(events)
      });
      const requestedIds = isRecord(body) && Array.isArray(body.notificationIds) ? body.notificationIds.filter((id) => typeof id === "string") : [];
      const oneShotIds = requestedIds.filter((id) => id.startsWith("longrunning:")).filter((id) => notifications.some((notification) => notification.id === id));
      storage.appendEvent({
        ...current.run ? { runId: current.run.id } : {},
        kind: "notification_dismissed",
        message: `Dismissed ${oneShotIds.length} notification(s).`,
        payload: { notificationIds: oneShotIds, source: "dashboard" }
      });
      return ok({ dismissed: oneShotIds.length, notificationIds: oneShotIds });
    }));
  }
  loopExportAudit(input) {
    return this.withConfig(() => this.withStorageReadOnly((storage) => storage.readTransaction(() => {
      const run = storage.listRuns(200).find((item) => item.id === input.runId);
      if (!run) {
        throw new AgentLoopError("storage_error", `Run not found: ${input.runId}`);
      }
      const data = buildAuditData(storage, run);
      const content = input.format === "json" ? data : renderAuditMarkdown(data);
      return ok({ runId: run.id, format: input.format, content });
    })));
  }
  loopRecover(token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig(() => ok(recoverBlockedRun(this.options.repoRoot, "dashboard")));
  }
  loopMarkHistoricalGateHandled(gateId, token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig(() => this.withStorage((storage) => {
      const gate = storage.getGate(gateId);
      if (!gate) {
        throw new AgentLoopError("storage_error", `Gate not found: ${gateId}`);
      }
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const annotated = annotateGates({
        gates: storage.listGates(),
        current,
        ...run ? { run } : {},
        runs: storage.listRuns(20),
        dismissedHistoricalGateIds: historicalGateHandledIds(storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT))
      }).find((item) => item.id === gate.id);
      if (annotated?.activity === "active") {
        throw new AgentLoopError("invalid_config", "Active gates must be approved, rejected, or recovered; they cannot be marked handled.");
      }
      const payload = {
        gateId: gate.id,
        gateKind: gate.kind,
        gateRunId: gate.runId,
        gateStatus: gate.status,
        activity: annotated?.activity ?? "historical",
        activityReason: annotated?.activityReason ?? "historical_run",
        source: "dashboard"
      };
      storage.appendEvent({
        ...gate.runId ? { runId: gate.runId } : {},
        kind: HISTORICAL_EVENT_KIND,
        message: `Marked historical gate ${gate.id} as handled in the dashboard view.`,
        payload
      });
      if (gate.runId) {
        storage.appendDecision({
          runId: gate.runId,
          kind: HISTORICAL_EVENT_KIND,
          message: `Marked historical gate ${gate.id} as handled in the dashboard view.`,
          details: payload
        });
      }
      return ok({ gate: { ...gate, activity: "historical", activityReason: "marked_handled" }, markedHandled: true });
    }));
  }
  loopReevaluateHistoricalGate(gateId, token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return this.withConfig(() => this.withStorage((storage) => {
      this.reconcileTerminalWorker(storage);
      const gate = storage.getGate(gateId);
      if (!gate) {
        throw new AgentLoopError("storage_error", `Gate not found: ${gateId}`);
      }
      const current = storage.getCurrentStatus();
      const run = current.run ?? storage.getCurrentRun();
      const annotated = annotateGates({
        gates: storage.listGates(),
        current,
        ...run ? { run } : {},
        runs: storage.listRuns(20),
        dismissedHistoricalGateIds: historicalGateHandledIds(storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT))
      }).find((item) => item.id === gate.id);
      const result = reevaluationResult(annotated?.activity, annotated?.activityReason);
      const payload = {
        gateId: gate.id,
        gateKind: gate.kind,
        gateRunId: gate.runId,
        gateStatus: gate.status,
        activity: annotated?.activity ?? "historical",
        activityReason: annotated?.activityReason ?? "historical_run",
        result,
        source: "dashboard"
      };
      storage.appendEvent({
        ...gate.runId ? { runId: gate.runId } : {},
        kind: HISTORICAL_REEVALUATED_EVENT_KIND,
        message: `Re-evaluated historical gate ${gate.id} in the dashboard view.`,
        payload
      });
      if (gate.runId) {
        storage.appendDecision({
          runId: gate.runId,
          kind: HISTORICAL_REEVALUATED_EVENT_KIND,
          message: `Re-evaluated historical gate ${gate.id} in the dashboard view.`,
          details: payload
        });
      }
      return ok({ gate: { ...gate, activity: payload.activity, activityReason: payload.activityReason }, result, reevaluated: true });
    }));
  }
  async loopSpawnWorker(type, dryRun = true, token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    return await this.withConfigAsync(async (config) => {
      const storage = new SqliteAgentLoopStorage(statePath(this.options.repoRoot));
      try {
        const run = storage.getCurrentRun();
        if (!run) {
          throw new AgentLoopError("storage_error", "No current run exists.");
        }
        storage.appendDecision({
          runId: run.id,
          kind: "mcp_spawn_worker_requested",
          message: `MCP requested ${type} worker.`,
          details: { type, dryRun }
        });
        return ok(await executeWorker({
          repoRoot: this.options.repoRoot,
          storage,
          run,
          config,
          state: workerState(run.currentState),
          type,
          dryRun
        }));
      } catch (error) {
        return fail(error);
      } finally {
        storage.close();
      }
    });
  }
  loopOpenDashboard() {
    return this.withConfig((config) => {
      if (!config.dashboard?.enabled) {
        return ok({ enabled: false, message: "Run `pnpm agent-loop dashboard` to start the local dashboard." });
      }
      const port = config.dashboard.port ?? 0;
      return ok({ enabled: true, url: `http://${config.dashboard.host}:${port}` });
    });
  }
  decideGate(gateId, decision, input, token) {
    const auth = this.requireToken(token);
    if (auth) return auth;
    const decisionInput = normalizeGateDecisionInput(input);
    const note = decisionInput.note;
    if (note.trim().length === 0) {
      return fail(new AgentLoopError("invalid_config", "Gate approval note is required."));
    }
    return this.withConfig(() => this.withStorage((storage) => {
      const gate = storage.decideGate(gateId, decision, note);
      const runId = gate.runId ?? storage.getCurrentRun()?.id;
      if (runId) {
        storage.appendDecision({
          runId,
          kind: `gate_${decision}`,
          message: `${decision} gate ${gate.id}.`,
          details: {
            gateId: gate.id,
            gateKind: gate.kind,
            state: gateState2(gate.details),
            note,
            source: decisionInput.source ?? "api",
            payload: decisionInput.payload ?? {},
            gateDetails: gate.details
          }
        });
      }
      return ok({ gate });
    }));
  }
  withConfig(fn) {
    try {
      const { config } = loadConfig(this.options.repoRoot);
      return fn(config);
    } catch (error) {
      return fail(error);
    }
  }
  async withConfigAsync(fn) {
    try {
      const { config } = loadConfig(this.options.repoRoot);
      return await fn(config);
    } catch (error) {
      return fail(error);
    }
  }
  withStorage(fn) {
    const storage = new SqliteAgentLoopStorage(statePath(this.options.repoRoot));
    try {
      return fn(storage);
    } catch (error) {
      return fail(error);
    } finally {
      storage.close();
    }
  }
  withStorageReadOnly(fn) {
    const storage = new SqliteAgentLoopStorage(statePath(this.options.repoRoot), { mode: "ro" });
    try {
      return fn(storage);
    } catch (error) {
      return fail(error);
    } finally {
      storage.close();
    }
  }
  withCurrentRun(fn) {
    return this.withConfig(() => this.withStorageReadOnly((storage) => {
      const run = storage.getCurrentRun();
      if (!run) {
        throw new AgentLoopError("storage_error", "No current run exists.");
      }
      return fn(storage, run);
    }));
  }
  requireToken(token) {
    return requireMcpToken(token, this.options.mcpToken);
  }
  reconcileTerminalWorker(storage) {
    const run = storage.getCurrentRun();
    if (run) {
      blockRunForTerminalWorker(storage, run);
    }
  }
};
function isSensitiveArtifactKind(kind) {
  return ["worker-prompt", "worker-jsonl", "worker-result"].includes(kind);
}
function normalizeGateDecisionInput(input) {
  if (typeof input === "string") {
    return { note: input };
  }
  return {
    note: input.note,
    ...input.source ? { source: input.source } : {},
    ...input.payload ? { payload: input.payload } : {}
  };
}
function gateState2(details) {
  if (!isRecord(details)) return void 0;
  return typeof details.state === "string" ? details.state : void 0;
}
function selectionSummary(selection) {
  if (selection.mode === "ambiguous") {
    return {
      mode: selection.mode,
      ambiguous: true,
      reason: selection.reason,
      candidates: selection.candidates,
      evidence: selection.evidence
    };
  }
  return {
    mode: selection.mode,
    ambiguous: false,
    item: selection.item,
    branchName: selection.branchName,
    ...selection.mode === "current_pr" ? {
      prNumber: selection.pr.number,
      prUrl: selection.pr.url
    } : {},
    evidence: selection.evidence
  };
}
function genericSelectionSummary(config) {
  return {
    mode: "generic_loop",
    ambiguous: false,
    loopShape: config.loopShape,
    workflowProfile: config.workflowProfile,
    evidence: ["generic-loop uses workflow profile state, not legacy PR spec selection."]
  };
}
function genericLikelyTouchedFiles(config) {
  const profile = resolveProfile(config);
  const allowedRoots = profile.allowedWriteRoots ?? [];
  return [
    ...allowedRoots.map((root) => `${root}/`),
    ".agent-loop/artifacts/"
  ];
}
function dashboardInfo(config) {
  const host = config.dashboard?.host ?? "127.0.0.1";
  const port = config.dashboard?.port ?? 0;
  return { url: `http://${host}:${port}/`, host, port, loopbackOnly: true };
}
function notificationDismissedIds2(events) {
  return notificationIdsForKind2(events, "notification_dismissed");
}
function notificationIdsForKind2(events, kind) {
  const ids = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.kind !== kind || typeof event.payload !== "object" || event.payload === null) {
      continue;
    }
    const notificationIds = event.payload.notificationIds;
    if (Array.isArray(notificationIds)) {
      for (const id of notificationIds) {
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  return ids;
}
function mergeReadinessForMissionDisplay(readiness, events) {
  if (!hasWorkflowCleanupEvidence(events)) {
    return readiness;
  }
  return {
    ...readiness,
    state: "ready",
    ready: true,
    missingConditions: [],
    evidence: [...readiness.evidence, "cleanup evidence recorded after merge"]
  };
}
function hasWorkflowCleanupEvidence(events) {
  return events.some((event) => {
    if (event.kind !== WORKFLOW_STAGE_EVIDENCE_KIND || !isRecord(event.payload)) {
      return false;
    }
    return event.payload.stageId === "cleanup";
  });
}
function buildAuditData(storage, run) {
  const gates = storage.listGates(run.id).map((gate) => ({
    id: gate.id,
    runId: gate.runId,
    kind: gate.kind,
    status: gate.status,
    message: redactSecrets(gate.message),
    details: redactAuditValue(gate.details),
    createdAt: gate.createdAt,
    resolvedAt: gate.resolvedAt,
    decisionNote: gate.decisionNote ? redactSecrets(gate.decisionNote) : void 0,
    decidedAt: gate.decidedAt
  }));
  const ci = storage.listCiChecks(run.id);
  const reviewComments = storage.listReviewComments(run.id).map((comment) => ({
    id: comment.id,
    prNumber: comment.prNumber,
    url: comment.url,
    author: comment.author,
    path: comment.path,
    line: comment.line,
    actionable: comment.actionable,
    isResolved: comment.isResolved,
    isOutdated: comment.isOutdated,
    status: comment.status
  }));
  const timeline = storage.listAgentTimeline({ runId: run.id, limit: 200 }).entries.map((entry) => ({
    timelineSeq: entry.timelineSeq,
    occurredAt: entry.occurredAt,
    source: entry.source,
    kind: entry.kind,
    workerId: entry.workerId,
    threadId: entry.threadId,
    title: redactSecrets(entry.title),
    summary: redactSecrets(entry.summary).slice(0, 2e3),
    status: entry.status,
    artifactIds: entry.artifactIds
  }));
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    run,
    pr: storage.getPrLink(run.id),
    ci,
    reviewComments,
    workers: storage.listWorkers(run.id, 100).map((worker) => ({
      ...worker,
      ...worker.error ? { error: redactSecrets(worker.error) } : {}
    })),
    gates,
    decisions: storage.listDecisions(run.id).map((decision) => ({
      ...decision,
      message: redactSecrets(decision.message),
      details: redactAuditValue(decision.details)
    })),
    artifacts: storage.listArtifacts(run.id).map((artifact) => ({
      id: artifact.id,
      runId: artifact.runId,
      kind: artifact.kind,
      name: redactSecrets(artifact.name),
      path: redactSecrets(artifact.path),
      sha256: artifact.sha256,
      createdAt: artifact.createdAt
    })),
    timeline
  };
}
function renderAuditMarkdown(data) {
  const run = data.run;
  const pr = data.pr;
  const workers = data.workers;
  const gates = data.gates;
  const timeline = data.timeline;
  const lines = [
    `# Agent Loop Audit: ${run.id}`,
    "",
    `- Status: ${run.status}`,
    `- State: ${run.currentState ?? "unknown"}`,
    `- Branch: ${run.branch ?? "unknown"}`,
    `- Generated: ${data.generatedAt}`,
    pr ? `- PR: #${pr.prNumber ?? "unknown"} ${pr.state ?? ""} ${pr.url ?? ""}` : "- PR: none",
    "",
    "## Gates",
    ...listLines(gates.map((gate) => `${gate.kind} / ${gate.status} - ${redactSecrets(gate.message)}`)),
    "",
    "## Workers",
    ...listLines(workers.map((worker) => `${worker.id} / ${worker.type} / ${worker.status}`)),
    "",
    "## Timeline",
    ...listLines(timeline.slice(0, 80).map((entry) => `${entry.occurredAt} ${entry.source} ${entry.status ?? ""} - ${entry.title}`))
  ];
  return `${lines.join("\n")}
`;
}
function listLines(items) {
  return items.length === 0 ? ["- none"] : items.map((item) => `- ${item}`);
}
function redactAuditValue(value) {
  if (typeof value === "string") {
    return redactSecrets(value).slice(0, 2e3);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactAuditValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, nested]) => [
    key,
    redactAuditField(key, nested)
  ]));
}
function redactAuditField(key, value) {
  if (/token|api_key|authorization|password|secret/i.test(key)) {
    return "[redacted]";
  }
  if (/stdout|stderr|output|rawJsonl|contentBase64|prompt/i.test(key)) {
    return {
      omitted: true,
      reason: "raw content is excluded from audit exports",
      length: typeof value === "string" ? value.length : JSON.stringify(value ?? "").length,
      type: Array.isArray(value) ? "array" : typeof value
    };
  }
  return redactAuditValue(value);
}
function buildTimelineSummary(input) {
  const activeWorker = input.workers.find((worker) => worker.status === "running");
  const lastFailure = input.timeline.find(
    (entry) => entry.source === "worker" && (entry.status === "failed" || entry.status === "timed_out" || entry.status === "invalid_output")
  );
  const summary = {
    hasObservationGap: hasObservationGap(input.workers, input.listWorkerEvents, input.nowMs),
    ...input.currentRunId ? { runId: input.currentRunId } : {}
  };
  if (input.timeline[0]) {
    summary.latest = input.timeline[0];
  }
  if (lastFailure) {
    summary.lastFailure = lastFailure;
  }
  if (activeWorker) {
    summary.activeWorker = {
      id: activeWorker.id,
      type: activeWorker.type,
      status: activeWorker.status,
      ...activeWorker.threadId ? { threadId: activeWorker.threadId } : {},
      startedAt: activeWorker.startedAt
    };
  }
  return summary;
}
function hasObservationGap(workers, listWorkerEvents, nowMs = Date.now()) {
  return workers.some((worker) => {
    const events = listWorkerEvents(worker.id);
    if (events.length === 0 && !worker.rawJsonlArtifactId) {
      return true;
    }
    const hasSummary = events.some(
      (event) => event.eventType === "thread.started" || event.eventType === "turn.completed" || event.itemType === "command_execution" || event.itemType === "file_change" || event.itemType === "agent_message" || event.itemType === "mcp_tool_call" || event.itemType === "web_search" || event.itemType === "todo_list" || event.itemType === "error"
    );
    if (worker.rawJsonlArtifactId && !hasSummary) {
      return true;
    }
    if (worker.status !== "running") {
      return false;
    }
    const startedAt = Date.parse(worker.startedAt);
    if (Number.isNaN(startedAt) || nowMs - startedAt <= 6e4) {
      return false;
    }
    const newestEventMs = events.reduce((latest, event) => {
      const value = Date.parse(event.createdAt);
      return Number.isNaN(value) ? latest : Math.max(latest, value);
    }, 0);
    return newestEventMs < startedAt || nowMs - newestEventMs > 6e4;
  });
}
function assertArtifactPathInsideRoot(artifactRoot, path, artifactId) {
  try {
    const rootRealPath = realpathSync3(artifactRoot);
    const artifactRealPath = realpathSync3(path);
    const relativePath = relative(rootRealPath, artifactRealPath);
    if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith("/")) {
      throw new AgentLoopError("artifact_integrity_error", "Artifact path escapes artifact root.", {
        details: { artifactId, path }
      });
    }
  } catch (error) {
    if (error instanceof AgentLoopError) {
      throw error;
    }
    throw new AgentLoopError("artifact_integrity_error", "Artifact path cannot be verified.", {
      details: { artifactId, path, cause: error instanceof Error ? error.message : String(error) }
    });
  }
}
function startBackgroundRun(repoRoot, runId) {
  try {
    execFileSync9("which", ["pnpm"], { stdio: "ignore" });
  } catch (error) {
    markBackgroundRunFailed(repoRoot, runId, error);
    return false;
  }
  const child = spawn2("pnpm", ["agent-loop", "run", "--until=gate"], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    shell: false
  });
  let handledStartFailure = false;
  const failStartOnce = (error) => {
    if (handledStartFailure) {
      return;
    }
    handledStartFailure = true;
    markBackgroundRunFailed(repoRoot, runId, error);
  };
  child.on("error", (error) => {
    failStartOnce(error);
  });
  if (!child.pid) {
    failStartOnce(new Error("Background process did not start."));
    return false;
  }
  child.unref();
  return true;
}
function markBackgroundRunFailed(repoRoot, runId, error) {
  let storage;
  try {
    storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    const run = storage.getCurrentRun();
    if (run?.id === runId && run.status === "RUNNING") {
      try {
        storage.updateRunStatus(run.id, run.version, "BLOCKED", {
          ...run.currentState ? { currentState: run.currentState } : {}
        });
      } catch {
      }
    }
    try {
      storage.writeGate({
        runId,
        kind: "required_tool_unavailable",
        message: "Could not start background agent-loop run.",
        details: { cause: error instanceof Error ? error.message : String(error) }
      });
      storage.appendEvent({
        runId,
        kind: "background_run_start_failed",
        message: "Could not start background agent-loop run.",
        payload: { cause: error instanceof Error ? error.message : String(error) }
      });
    } catch {
    }
  } catch {
  } finally {
    storage?.close();
  }
}
function nextAction(status, gate) {
  if (gate === "needs_repo_init") {
    return "Run `pnpm agent-loop init`.";
  }
  if (gate) {
    return "Inspect the gate, fix the cause, then approve or reject with a note.";
  }
  if (status === "IDLE" || status === "READY") {
    return "Run until the next gate.";
  }
  if (status === "STOPPED") {
    return "Resume only after confirming the stopped run should continue.";
  }
  return "Poll status.";
}
function ok(data) {
  return { ok: true, data };
}
function fail(error) {
  const payload = toErrorPayload(error);
  return {
    ok: false,
    error: payload,
    ...payload.code ? { gate: payload.code } : {}
  };
}
function requireMcpToken(token, expectedToken) {
  const expected = expectedToken ?? process.env.AGENT_LOOP_MCP_TOKEN;
  if (!expected) {
    return fail(new AgentLoopError("needs_secret_or_login", "AGENT_LOOP_MCP_TOKEN is required for mutating MCP tools.", {
      exitCode: 2
    }));
  }
  if (token !== expected) {
    return fail(new AgentLoopError("needs_secret_or_login", "MCP token is missing or invalid.", {
      exitCode: 2
    }));
  }
  return void 0;
}
function recoveryWarnings(gate, gates = [], workers = []) {
  const warnings = gate === "needs_repo_init" ? ["needs_repo_init is visible; use explicit recovery after config is valid."] : [];
  const historicalOpen = gates.filter((item) => item.status === "open" && item.activity === "historical");
  if (historicalOpen.length > 0) {
    warnings.push(`${historicalOpen.length} historical open gate(s) belong to an inactive or superseded run.`);
  }
  const staleWorkers = workers.filter((item) => item.activityReason === "stale_worker_failure");
  if (staleWorkers.length > 0) {
    warnings.push(`${staleWorkers.length} stale worker failure(s) are from an older run or before the current run started.`);
  }
  return warnings;
}
function currentForMissionControl(current, gates) {
  const activeGate = gates.find((gate) => gate.status === "open" && gate.activity === "active");
  if (activeGate) {
    return {
      ...current,
      status: "BLOCKED",
      gate: {
        kind: activeGate.kind,
        message: activeGate.message,
        ...activeGate.details === void 0 ? {} : { details: activeGate.details }
      }
    };
  }
  if (!current.gate) {
    return current;
  }
  const { gate: _gate, ...withoutGate } = current;
  return {
    ...withoutGate,
    status: current.run?.status ?? current.status
  };
}
function annotatedGatesSnapshot(storage) {
  return storage.readTransaction(() => {
    const current = storage.getCurrentStatus();
    const run = current.run ?? storage.getCurrentRun();
    const historicalEvents = storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT);
    return annotateGates({
      gates: storage.listGates(),
      current,
      ...run ? { run } : {},
      runs: storage.listRuns(20),
      dismissedHistoricalGateIds: historicalGateHandledIds(historicalEvents)
    });
  });
}
function annotatedGateSnapshot(storage, gateId) {
  return storage.readTransaction(() => {
    const gate = storage.getGate(gateId);
    if (!gate) return void 0;
    const current = storage.getCurrentStatus();
    const run = current.run ?? storage.getCurrentRun();
    const historicalEvents = storage.listEvents(HISTORICAL_EVENT_SCAN_LIMIT);
    return annotateGates({
      gates: [gate],
      current,
      ...run ? { run } : {},
      runs: includeRun(storage.listRuns(20), run),
      dismissedHistoricalGateIds: historicalGateHandledIds(historicalEvents)
    })[0];
  });
}
function includeRun(runs, run) {
  if (!run || runs.some((item) => item.id === run.id)) return runs;
  return [run, ...runs];
}
function annotateGates(input) {
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const currentRunId2 = input.run?.id;
  const currentStartedAt = input.run?.startedAt ? Date.parse(input.run.startedAt) : input.run?.createdAt ? Date.parse(input.run.createdAt) : void 0;
  return input.gates.map((gate) => {
    const gateRun = gate.runId ? runById.get(gate.runId) : void 0;
    const activeRun = gateRun ? isActiveRun(gateRun) && gateRun.id === currentRunId2 : input.current.gate?.kind === gate.kind;
    const inactiveGateRun = gateRun ? !isActiveRun(gateRun) : false;
    const gateCreatedAt = Date.parse(gate.createdAt);
    const supersededByCurrentRun = gate.runId !== void 0 && gate.runId !== currentRunId2 && currentRunId2 !== void 0 && (inactiveGateRun || currentStartedAt !== void 0 && !Number.isNaN(gateCreatedAt) && gateCreatedAt < currentStartedAt);
    if (gate.status === "open" && activeRun && !supersededByCurrentRun) {
      return { ...gate, activity: "active", activityReason: gate.runId ? "current_run" : "repo_gate" };
    }
    if (input.dismissedHistoricalGateIds.has(gate.id)) {
      return { ...gate, activity: "historical", activityReason: "marked_handled" };
    }
    if (supersededByCurrentRun) {
      return { ...gate, activity: "historical", activityReason: "overridden_by_reality" };
    }
    if (gate.status !== "open") {
      return { ...gate, activity: "historical", activityReason: "handled_gate" };
    }
    return { ...gate, activity: "historical", activityReason: gateRun ? "historical_run" : "repo_gate_not_current" };
  });
}
function annotateWorkers(input) {
  const currentRunId2 = input.run?.id;
  const currentStartedAt = input.run?.startedAt ? Date.parse(input.run.startedAt) : void 0;
  return input.workers.map((worker) => {
    const terminalFailure = worker.status === "failed" || worker.status === "invalid_output" || worker.status === "timed_out";
    const workerTime = Date.parse(worker.completedAt ?? worker.startedAt);
    const olderThanCurrentRun = currentStartedAt !== void 0 && !Number.isNaN(workerTime) && workerTime < currentStartedAt;
    const workerGate = input.gates.find(
      (gate) => TERMINAL_WORKER_GATE_KINDS.includes(gate.kind) && isRecord(gate.details) && gate.details.workerId === worker.id
    );
    if (terminalFailure && (worker.runId !== currentRunId2 || olderThanCurrentRun || workerGate?.activity === "historical")) {
      return { ...worker, activity: "historical", activityReason: "stale_worker_failure" };
    }
    if (worker.runId === currentRunId2 && input.run && isActiveRun(input.run)) {
      return { ...worker, activity: "active", activityReason: "current_run" };
    }
    return { ...worker, activity: "historical", activityReason: "historical_run" };
  });
}
function isActiveRun(run) {
  return run.status === "RUNNING" || run.status === "BLOCKED";
}
function historicalGateHandledIds(events) {
  const ids = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.kind !== HISTORICAL_EVENT_KIND || !isRecord(event.payload)) {
      continue;
    }
    const gateId = event.payload.gateId;
    if (typeof gateId === "string") {
      ids.add(gateId);
    }
  }
  return ids;
}
function reevaluationResult(activity, activityReason) {
  if (activity === "active") {
    return "active_again";
  }
  if (activityReason === "marked_handled") {
    return "manually_handled";
  }
  if (activityReason === "overridden_by_reality") {
    return "overridden_by_current_reality";
  }
  return "still_historical";
}
function workerState(value) {
  if (value === "WRITE_SPEC" || value === "IMPLEMENT" || value === "FIX_REVIEW" || value === "SELF_CHECK") {
    return value;
  }
  return "SELF_CHECK";
}
function likelyTouchedFiles(repoRoot, plansDir, selectedFile) {
  const paths = /* @__PURE__ */ new Set([plansDir, ".agent-loop/config.json"]);
  if (selectedFile) {
    paths.add(relative(repoRoot, selectedFile).replaceAll("\\", "/"));
  }
  return [...paths];
}

// plugins/autonomous-pr-loop/core/controller-host.ts
function createControllerHost(options) {
  const controller = new McpController(options);
  return {
    controller,
    getController: () => controller,
    dispose: () => {
    }
  };
}

// plugins/autonomous-pr-loop/mcp-server/src/tools.ts
var emptySchema = { type: "object", properties: {} };
var MCP_TOOLS = [
  tool("loop_status", "Return current loop status.", emptySchema),
  tool("loop_next_action", "Return the next recommended loop action.", emptySchema),
  tool("loop_run_until_gate", "Start a background run until the next gate.", tokenSchema()),
  tool("loop_resume", "Resume one loop step.", tokenSchema()),
  tool("loop_stop", "Stop the current run.", tokenSchema()),
  tool("loop_step", "Advance one loop step.", tokenSchema()),
  tool("loop_list_gates", "List gates newest-first.", emptySchema),
  tool("loop_explain_gate", "Explain one gate.", stringIdSchema("gateId")),
  tool("loop_approve_gate", "Approve one gate with an operator note.", noteSchema("gateId")),
  tool("loop_reject_gate", "Reject one gate with an operator note.", noteSchema("gateId")),
  tool("loop_list_runs", "List persisted runs.", {
    type: "object",
    properties: { limit: { type: "number" } }
  }),
  tool("loop_agent_timeline", "List normalized agent timeline entries.", {
    type: "object",
    properties: {
      cursor: { type: "string" },
      limit: { type: "number" },
      sources: {
        type: "array",
        items: { type: "string", enum: ["event", "worker_event", "worker", "state", "gate", "artifact", "decision"] }
      },
      runId: { type: "string" },
      workerId: { type: "string" }
    }
  }),
  tool("loop_read_artifact", "Read a persisted artifact by id.", stringIdSchema("artifactId")),
  tool("loop_get_pr_status", "Return stored PR status for current run.", emptySchema),
  tool("loop_get_ci_status", "Return stored CI checks for current run.", emptySchema),
  tool("loop_get_review_comments", "Return stored review comments for current run.", emptySchema),
  tool("loop_spawn_worker", "Spawn or dry-run a delegated worker.", {
    type: "object",
    required: ["type", "token"],
    properties: {
      type: { type: "string", enum: ["planner", "implementation", "review-fix", "ci-fix", "reviewer"] },
      dryRun: { type: "boolean" },
      token: { type: "string" }
    }
  }),
  tool("loop_open_dashboard", "Return dashboard URL or unavailable status.", emptySchema)
];
async function callMcpTool(name, args, repoRoot) {
  const host = getControllerHost(repoRoot);
  const controller = host.getController();
  if (name === "loop_status") return controller.loopStatus();
  if (name === "loop_next_action") return controller.loopNextAction();
  if (name === "loop_run_until_gate") return controller.loopRunUntilGate(optionalString2(args, "token"));
  if (name === "loop_resume") return await controller.loopResume(optionalString2(args, "token"));
  if (name === "loop_stop") return controller.loopStop(optionalString2(args, "token"));
  if (name === "loop_step") return await controller.loopStep(optionalString2(args, "token"));
  if (name === "loop_list_gates") return controller.loopListGates();
  if (name === "loop_explain_gate") return controller.loopExplainGate(requiredString(args, "gateId"));
  if (name === "loop_approve_gate") return controller.loopApproveGate(requiredString(args, "gateId"), gateDecisionArgs(args), optionalString2(args, "token"));
  if (name === "loop_reject_gate") return controller.loopRejectGate(requiredString(args, "gateId"), gateDecisionArgs(args), optionalString2(args, "token"));
  if (name === "loop_list_runs") return controller.loopListRuns(optionalNumber(args, "limit"));
  if (name === "loop_agent_timeline") return controller.loopAgentTimeline({
    ...optionalStringObject(args, "cursor"),
    ...optionalNumberObject(args, "limit"),
    ...optionalStringObject(args, "runId"),
    ...optionalStringObject(args, "workerId"),
    ...optionalSourcesObject(args)
  });
  if (name === "loop_read_artifact") return controller.loopReadArtifact(requiredString(args, "artifactId"));
  if (name === "loop_get_pr_status") return controller.loopGetPrStatus();
  if (name === "loop_get_ci_status") return controller.loopGetCiStatus();
  if (name === "loop_get_review_comments") return controller.loopGetReviewComments();
  if (name === "loop_spawn_worker") return await controller.loopSpawnWorker(requiredWorkerType(args), optionalBoolean(args, "dryRun") ?? true, optionalString2(args, "token"));
  if (name === "loop_open_dashboard") return controller.loopOpenDashboard();
  throw new Error(`Unknown tool: ${name}`);
}
var hosts = /* @__PURE__ */ new Map();
var MAX_HOSTS = 16;
function getControllerHost(repoRoot) {
  const existing = hosts.get(repoRoot);
  if (existing) {
    hosts.delete(repoRoot);
    hosts.set(repoRoot, existing);
    return existing;
  }
  if (hosts.size >= MAX_HOSTS) {
    const oldestKey = hosts.keys().next().value;
    if (oldestKey) {
      hosts.get(oldestKey)?.dispose();
      hosts.delete(oldestKey);
    }
  }
  const host = createControllerHost({ repoRoot });
  hosts.set(repoRoot, host);
  return host;
}
function tool(name, description, inputSchema) {
  return { name, description, inputSchema };
}
function stringIdSchema(name) {
  return {
    type: "object",
    required: [name],
    properties: { [name]: { type: "string" } }
  };
}
function noteSchema(idName) {
  return {
    type: "object",
    required: [idName, "note", "token"],
    properties: {
      [idName]: { type: "string" },
      note: { type: "string" },
      source: { type: "string", enum: ["cli", "api", "ui", "nl"] },
      payload: { type: "object" },
      token: { type: "string" }
    }
  };
}
function tokenSchema() {
  return {
    type: "object",
    required: ["token"],
    properties: { token: { type: "string" } }
  };
}
function requiredString(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
function optionalNumber(args, name) {
  const value = args[name];
  return typeof value === "number" ? value : void 0;
}
function optionalNumberObject(args, name) {
  const value = optionalNumber(args, name);
  return value === void 0 ? {} : { [name]: value };
}
function optionalBoolean(args, name) {
  const value = args[name];
  return typeof value === "boolean" ? value : void 0;
}
function optionalString2(args, name) {
  const value = args[name];
  return typeof value === "string" ? value : void 0;
}
function optionalStringObject(args, name) {
  const value = optionalString2(args, name);
  return value === void 0 ? {} : { [name]: value };
}
function gateDecisionArgs(args) {
  const source = optionalString2(args, "source");
  const payload = args.payload;
  return {
    note: requiredString(args, "note"),
    source: source === "cli" || source === "api" || source === "ui" || source === "nl" ? source : "nl",
    payload: typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {}
  };
}
function optionalSourcesObject(args) {
  const value = args.sources;
  if (!Array.isArray(value)) {
    return {};
  }
  const sources = value.filter((item) => typeof item === "string");
  return sources.length ? { sources } : {};
}
function requiredWorkerType(args) {
  const value = requiredString(args, "type");
  if (["planner", "implementation", "review-fix", "ci-fix", "reviewer"].includes(value)) {
    return value;
  }
  throw new Error(`Unsupported worker type: ${value}`);
}

// plugins/autonomous-pr-loop/mcp-server/src/index.ts
var rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
var initialized = false;
rl.on("line", (line) => {
  void handleLine(line);
});
async function handleLine(line) {
  if (line.trim().length === 0) {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    respond(null, void 0, errorPayload(-32700, "Parse error"));
    return;
  }
  try {
    if (request.method === "initialize") {
      initialized = true;
      respond(request.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "autonomous-pr-loop", version: "0.1.1" }
      });
      return;
    }
    if (request.method === "ping") {
      respond(request.id, {});
      return;
    }
    if (!initialized) {
      respond(request.id, void 0, errorPayload(-32002, "MCP server is not initialized."));
      return;
    }
    if (request.method === "tools/list") {
      respond(request.id, { tools: MCP_TOOLS });
      return;
    }
    if (request.method === "tools/call") {
      const params = isRecord3(request.params) ? request.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = isRecord3(params.arguments) ? params.arguments : {};
      const result = await callMcpTool(name, args, resolveMcpRepoRoot());
      respond(request.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      });
      return;
    }
    if (request.id !== void 0) {
      respond(request.id, void 0, errorPayload(-32601, `Method not found: ${request.method ?? ""}`));
    }
  } catch (error) {
    respond(request.id, void 0, errorPayload(-32e3, error instanceof Error ? error.message : String(error)));
  }
}
function respond(id, result, error) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    ...error ? { error } : { result }
  })}
`);
}
function errorPayload(code, message) {
  return { code, message };
}
function resolveMcpRepoRoot() {
  return resolveRepoRoot(process.env.AGENT_LOOP_REPO_ROOT ?? process.cwd());
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
