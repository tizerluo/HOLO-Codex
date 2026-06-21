#!/usr/bin/env tsx

// plugins/autonomous-pr-loop/hooks/pre-tool-use.ts
import { readFileSync as readFileSync3 } from "node:fs";

// plugins/autonomous-pr-loop/core/hook-policy.ts
import { createHash as createHash2 } from "node:crypto";

// plugins/autonomous-pr-loop/core/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
function workerSandbox(type) {
  return type === "reviewer" ? "read-only" : "workspace-write";
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
function configPath(repoRoot2) {
  return join(repoRoot2, CONFIG_DIR, CONFIG_FILE);
}
function statePath(repoRoot2) {
  return join(repoRoot2, CONFIG_DIR, "state.sqlite");
}
function withConfigDefaults(input2) {
  const mergeMode = input2.mergeMode ?? (input2.allowAutoMerge ? "conditional" : "manual");
  return {
    repoId: input2.repoId,
    locale: input2.locale ?? DEFAULT_LOCALE,
    loopShape: input2.loopShape ?? DEFAULT_LOOP_SHAPE_ID,
    workflowProfile: input2.workflowProfile ?? DEFAULT_WORKFLOW_PROFILE_ID,
    roleProfile: input2.roleProfile ?? DEFAULT_ROLE_PROFILE_ID,
    baseBranch: input2.baseBranch ?? "main",
    branchPrefix: input2.branchPrefix ?? "codex/",
    plansDir: input2.plansDir ?? "docs/plans",
    ...input2.lintCommand ? { lintCommand: input2.lintCommand } : {},
    ...input2.testCommand ? { testCommand: input2.testCommand } : {},
    ...input2.gitnexusRepo ? { gitnexusRepo: input2.gitnexusRepo } : {},
    gitnexusRequired: input2.gitnexusRequired ?? true,
    requiredChecks: input2.requiredChecks ?? [],
    requireReviewApproval: input2.requireReviewApproval ?? true,
    autonomyMode: input2.autonomyMode ?? "autonomous_until_gate",
    mergeMode,
    notifyMode: input2.notifyMode ?? "important_only",
    reviewHandling: input2.reviewHandling ?? "fix_scoped_and_carry_forward",
    ...input2.carryoverTarget ? { carryoverTarget: input2.carryoverTarget } : {},
    allowAutoMerge: mergeMode === "conditional",
    maxReviewFixRounds: input2.maxReviewFixRounds ?? 3,
    maxTestFixRounds: input2.maxTestFixRounds ?? 2,
    maxCiReruns: input2.maxCiReruns ?? 1,
    commandTimeoutMs: input2.commandTimeoutMs ?? 6e5,
    commandOutputLimitBytes: input2.commandOutputLimitBytes ?? 65536,
    githubRetryMaxAttempts: input2.githubRetryMaxAttempts ?? 3,
    githubRetryBaseDelayMs: input2.githubRetryBaseDelayMs ?? 1e3,
    reviewCiPollIntervalMs: input2.reviewCiPollIntervalMs ?? 3e4,
    reviewCiMaxWaitMs: input2.reviewCiMaxWaitMs ?? 18e5,
    workerBackend: input2.workerBackend ?? "codex-exec",
    workerTimeoutMs: input2.workerTimeoutMs ?? 18e5,
    workerMaxRetries: input2.workerMaxRetries ?? 1,
    workerEphemeral: input2.workerEphemeral ?? false,
    protectedPaths: input2.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
    ...input2.dashboard ? { dashboard: input2.dashboard } : {}
  };
}
function loadConfig(repoRoot2) {
  const path = configPath(repoRoot2);
  if (!existsSync(path)) {
    throw new AgentLoopError(
      "needs_repo_init",
      "Missing .agent-loop/config.json. Run `pnpm agent-loop init`.",
      { details: { path }, exitCode: 2 }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
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

// plugins/autonomous-pr-loop/core/hook-events.ts
var CODEX_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "PreCompact",
  "PostCompact",
  "PermissionRequest"
];
var OBSERVE_ONLY_HOOK_EVENTS = CODEX_HOOK_EVENTS.filter((event) => event !== "PreToolUse");
function hookEventKind(event) {
  return `hook_${event.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}`;
}

// plugins/autonomous-pr-loop/core/hook-router.ts
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync as existsSync2, mkdirSync, openSync, readFileSync as readFileSync2, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join as join2, resolve } from "node:path";
function hookRegistryPath(codexHome = codexHomePath()) {
  return join2(codexHome, "agent-loop", "hook-bindings.json");
}
function hookRegistryLockPath(codexHome = codexHomePath()) {
  return `${hookRegistryPath(codexHome)}.lock`;
}
function codexHomePath() {
  return process.env.CODEX_HOME ?? join2(homedir(), ".codex");
}
function resolveHookRoute(payload, options = {}) {
  const context = hookContextFromPayload(payload, options.legacyRepoRoot);
  let registry;
  try {
    registry = readRegistry(options.codexHome ?? codexHomePath());
  } catch (error) {
    return { status: "route_error", context, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const active = registry.bindings.filter((binding) => binding.status === "active");
    const worktreeMatches = active.filter((binding) => bindingMatchesContext(binding, context));
    const contextSessionHash = context.sessionId ? sha256(context.sessionId) : void 0;
    const sessionMatches = context.sessionId ? worktreeMatches.filter((binding) => binding.sessionIdHash === contextSessionHash) : [];
    const candidates = sessionMatches.length > 0 ? sessionMatches : worktreeMatches.filter((binding) => binding.sessionIdHash === void 0);
    if (candidates.length === 1) {
      const binding = touchBinding(candidates[0], context, options.codexHome);
      if (contextSessionHash && binding.sessionIdHash !== void 0 && binding.sessionIdHash !== contextSessionHash) {
        return { status: "no_match", context, reason: "Hook binding was claimed by another Codex session.", worktreeBinding: true };
      }
      return { status: "matched", binding, context, legacy: false };
    }
    if (candidates.length > 1) {
      return { status: "ambiguous", context, bindings: candidates, reason: "Multiple hook bindings match this Codex session context." };
    }
    if (worktreeMatches.length > 0) {
      return { status: "no_match", context, reason: "Active hook bindings exist for this worktree, but none match this Codex session.", worktreeBinding: true };
    }
    const legacy = legacyRoute(options.legacyRepoRoot, context);
    if (legacy) {
      return { status: "matched", binding: legacy, context, legacy: true };
    }
    return { status: "no_match", context, reason: "No active agent-loop hook binding matches this Codex session context." };
  } catch (error) {
    return { status: "route_error", context, reason: error instanceof Error ? error.message : String(error) };
  }
}
function hookContextFromPayload(payload, fallbackCwd = process.cwd()) {
  const record = isRecord(payload) ? payload : {};
  return resolveHookContext({
    cwd: stringValue(record.cwd) ?? fallbackCwd,
    sessionId: stringValue(record.session_id) ?? stringValue(record.sessionId),
    turnId: stringValue(record.turn_id) ?? stringValue(record.turnId),
    transcriptPath: stringValue(record.transcript_path) ?? stringValue(record.transcriptPath)
  });
}
function resolveHookContext(input2) {
  const cwd = canonicalPath(input2.cwd);
  const worktreeRoot = gitOutput(["rev-parse", "--show-toplevel"], cwd);
  const commonDir = gitOutput(["rev-parse", "--git-common-dir"], cwd);
  const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const commonPath = commonDir ? canonicalPath(isAbsolute(commonDir) ? commonDir : join2(cwd, commonDir)) : void 0;
  return {
    cwd,
    worktreeRoot: worktreeRoot ? canonicalPath(worktreeRoot) : cwd,
    ...commonPath ? { gitCommonDir: commonPath } : {},
    ...branch && branch !== "HEAD" ? { branch } : {},
    ...input2.sessionId ? { sessionId: input2.sessionId } : {},
    ...input2.turnId ? { turnId: input2.turnId } : {},
    ...input2.transcriptPath ? { transcriptPathSha256: sha256(input2.transcriptPath) } : {}
  };
}
function readRegistry(codexHome) {
  const path = hookRegistryPath(codexHome);
  if (!existsSync2(path)) {
    return { version: 1, bindings: [] };
  }
  const parsed = JSON.parse(readFileSync2(path, "utf8"));
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
function writeRegistry(registry, codexHome) {
  const path = hookRegistryPath(codexHome);
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}
`, { mode: 384 });
  renameSync(tmp, path);
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
    ...typeof value.sessionIdHash === "string" ? { sessionIdHash: value.sessionIdHash } : typeof value.sessionId === "string" ? { sessionIdHash: sha256(value.sessionId) } : {},
    ...typeof value.transcriptPathSha256 === "string" ? { transcriptPathSha256: value.transcriptPathSha256 } : {},
    status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...typeof value.lastSeenAt === "string" ? { lastSeenAt: value.lastSeenAt } : {}
  };
}
function touchBinding(binding, context, codexHome = codexHomePath()) {
  return withRegistryLock(codexHome, () => {
    const registry = readRegistry(codexHome);
    const current = registry.bindings.find((item) => item.id === binding.id) ?? binding;
    const contextSessionHash = context.sessionId ? sha256(context.sessionId) : void 0;
    if (current.sessionIdHash !== void 0 && contextSessionHash !== void 0 && current.sessionIdHash !== contextSessionHash) {
      return current;
    }
    const nowMs = Date.now();
    const shouldClaimSession = current.sessionIdHash === void 0 && contextSessionHash !== void 0;
    const shouldClaimTranscript = current.transcriptPathSha256 === void 0 && context.transcriptPathSha256 !== void 0;
    const lastSeenAtMs = current.lastSeenAt ? Date.parse(current.lastSeenAt) : 0;
    const shouldRefreshLastSeen = !Number.isFinite(lastSeenAtMs) || nowMs - lastSeenAtMs > TOUCH_REFRESH_MS;
    if (!shouldClaimSession && !shouldClaimTranscript && !shouldRefreshLastSeen) {
      return current;
    }
    const now2 = new Date(nowMs).toISOString();
    const updated = {
      ...current,
      ...shouldClaimSession ? { sessionIdHash: contextSessionHash } : {},
      ...shouldClaimTranscript ? { transcriptPathSha256: context.transcriptPathSha256 } : {},
      lastSeenAt: now2,
      updatedAt: now2
    };
    registry.bindings = registry.bindings.map((item) => item.id === current.id ? updated : item);
    writeRegistry(registry, codexHome);
    return updated;
  });
}
function legacyRoute(legacyRepoRoot, context) {
  if (!legacyRepoRoot) return void 0;
  const legacyContext = resolveHookContext({ cwd: legacyRepoRoot });
  if (legacyContext.worktreeRoot !== context.worktreeRoot) {
    return void 0;
  }
  const now2 = (/* @__PURE__ */ new Date()).toISOString();
  return {
    id: `legacy:${sha256(legacyContext.worktreeRoot).slice(0, 16)}`,
    repoRoot: canonicalPath(legacyRepoRoot),
    worktreeRoot: legacyContext.worktreeRoot,
    ...legacyContext.gitCommonDir ? { gitCommonDir: legacyContext.gitCommonDir } : {},
    ...legacyContext.branch ? { branch: legacyContext.branch } : {},
    status: "active",
    createdAt: now2,
    updatedAt: now2
  };
}
function bindingMatchesContext(binding, context) {
  if (binding.worktreeRoot === context.worktreeRoot) {
    return true;
  }
  return binding.gitCommonDir !== void 0 && context.gitCommonDir !== void 0 && binding.gitCommonDir === context.gitCommonDir && context.cwd.startsWith(`${binding.worktreeRoot}/`);
}
function canonicalPath(path) {
  const resolved = resolve(path);
  return existsSync2(resolved) ? realpathSync(resolved) : resolved;
}
function gitOutput(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || void 0;
  } catch {
    return void 0;
  }
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function withRegistryLock(codexHome, fn) {
  const path = hookRegistryPath(codexHome);
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const lockPath = hookRegistryLockPath(codexHome);
  let fd;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx", 384);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() })}
`);
      break;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        if (recoverStaleLock(lockPath)) {
          continue;
        }
        sleepSync(20);
        continue;
      }
      throw error;
    }
  }
  if (fd === void 0) {
    throw new Error(`Timed out waiting for hook registry lock: ${lockPath}`);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}
var LOCK_STALE_MS = 3e4;
var TOUCH_REFRESH_MS = 1e4;
function recoverStaleLock(lockPath) {
  const report = inspectLockPath(lockPath);
  if (!report.stale) {
    return false;
  }
  rmSync(lockPath, { force: true });
  return true;
}
function inspectLockPath(path) {
  if (!existsSync2(path)) {
    return { path, exists: false, stale: false };
  }
  const metadata = readLockMetadata(path);
  const stat = statSync(path);
  const ageMs = Date.now() - (metadata.createdAtMs ?? stat.mtimeMs);
  const alive = metadata.pid ? processAlive(metadata.pid) : void 0;
  return {
    path,
    exists: true,
    stale: ageMs > LOCK_STALE_MS && alive !== true,
    ageMs,
    ...metadata.pid ? { pid: metadata.pid } : {},
    ...alive === void 0 ? {} : { processAlive: alive }
  };
}
function readLockMetadata(path) {
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    if (!isRecord(parsed)) return {};
    const pid = typeof parsed.pid === "number" ? parsed.pid : void 0;
    const createdAtMs = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : void 0;
    return {
      ...pid && Number.isInteger(pid) && pid > 0 ? { pid } : {},
      ...createdAtMs && Number.isFinite(createdAtMs) ? { createdAtMs } : {}
    };
  } catch {
    return {};
  }
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
    }
  }
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}

// plugins/autonomous-pr-loop/core/policy.ts
function matchesProtectedPath(pattern, path) {
  const normalizedPattern = normalizePath(pattern);
  const normalizedPath = normalizePath(path);
  if (!normalizedPattern.includes("/")) {
    const basename2 = normalizedPath.split("/").at(-1) ?? normalizedPath;
    return globToRegExp(normalizedPattern).test(basename2);
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

// plugins/autonomous-pr-loop/core/redaction.ts
function redactSecrets(value) {
  return value.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/\b[A-Za-z0-9._%+-]+:[^@\s]+@/g, "[redacted]@").replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]").replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]").replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]").replace(/((?:token|api_key|authorization|password|secret)\s*[:=]\s*)(["'])(?:(?!\2).)*\2/gi, "$1$2[redacted]$2").replace(/((?:token|api_key|authorization|password|secret)\s*[:=]\s*)[^\n\r,;}]+/gi, "$1[redacted]");
}
function isSecretKey(key) {
  return /token|api_key|authorization|password|secret/i.test(key);
}

// plugins/autonomous-pr-loop/core/storage.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
    } else if (!existsSync3(path)) {
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
  decideGate(gateId, decision2, note) {
    if (note.trim().length === 0) {
      throw new AgentLoopError("invalid_config", "Gate decision note is required.");
    }
    const decidedAt = now();
    this.transaction(() => {
      const result = this.db.prepare(
        `update gates
           set status = ?, decision_note = ?, decided_at = ?, resolved_at = coalesce(resolved_at, ?)
           where id = ? and status = 'open'`
      ).run(decision2, note, decidedAt, decidedAt, gateId);
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
    const ok = !missingTable && missingTriggers.length === 0 && missingSourceRows.length === 0;
    return {
      ok,
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
  appendDecision(decision2) {
    const stored = { id: randomUUID2(), ...decision2, createdAt: now() };
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
  const unique = [...new Set(sources)];
  if (unique.some((source) => !isTimelineSource(source))) {
    throw new AgentLoopError("invalid_config", "Unsupported timeline source.", { details: { sources } });
  }
  return unique;
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

// plugins/autonomous-pr-loop/core/hook-policy.ts
var REQUIRED_PUBLISH_EVIDENCE_SUBSTAGES = ["lint", "full_tests", "gitnexus_detect"];
function commandFromHookPayload(payload) {
  if (!isRecord(payload)) {
    return void 0;
  }
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : payload;
  const file = stringValue2(toolInput.file ?? toolInput.cmd ?? toolInput.executable);
  const args = Array.isArray(toolInput.args) ? toolInput.args.filter((arg) => typeof arg === "string") : void 0;
  if (file && args) {
    return { file: basename(file), args, raw: [file, ...args].join(" ") };
  }
  const command = stringValue2(toolInput.command ?? toolInput.cmd ?? toolInput.input);
  if (!command) {
    return void 0;
  }
  return tokenizeCommand(command);
}
function evaluateHookPolicy(input2) {
  const normalized = normalizeCommand(input2.command);
  const shellControl = shellControlPolicy(normalized);
  if (shellControl) {
    return deny(renderCommand(normalized), shellControl, "policy_violation", "Run one allowlisted command at a time without shell control operators.");
  }
  const command = unwrapCommand(normalized);
  const blockedCommand = renderCommand(command);
  const destructive = destructivePolicy(command);
  if (destructive) {
    return deny(blockedCommand, destructive, "policy_violation", "Stop using the destructive command and continue through agent-loop.");
  }
  const worker = input2.isWorker === true || process.env.AGENT_LOOP_WORKER_POLICY === "1" || command.raw?.includes("AGENT_LOOP_WORKER_POLICY=1") === true;
  const workerPolicy = workerLifecyclePolicy(command);
  if (worker && workerPolicy) {
    return deny(blockedCommand, workerPolicy, "policy_violation", "Let the supervisor own commit, push, PR, and merge actions.");
  }
  const protectedPath = protectedPathPolicy(command, input2.protectedPaths ?? []);
  if (protectedPath) {
    return deny(blockedCommand, protectedPath, "policy_violation", "Remove protected path changes from the command.");
  }
  const gate = gatedLifecyclePolicy(command, input2.storage, input2.runId);
  if (gate) {
    return deny(blockedCommand, gate.policy, gate.gate, gate.nextAction);
  }
  const override = activeMaintainerOverride(input2.storage, lifecycleOverrideScope(command), input2.runId);
  if (override && matchesHookAllowlist(command)) {
    return {
      allow: true,
      matchedPolicy: `maintainer_override:${override.scope}`,
      blockedCommand,
      nextAction: "Continue.",
      reason: `Maintainer override ${override.decisionId} allows ${blockedCommand} until ${override.expiresAt}.`,
      auditDetails: {
        overrideDecisionId: override.decisionId,
        overrideScope: override.scope,
        overrideExpiresAt: override.expiresAt
      }
    };
  }
  if (!matchesHookAllowlist(command)) {
    return deny(blockedCommand, "command_not_in_hook_allowlist", "policy_violation", "Use agent-loop MCP/CLI control surfaces or an allowlisted read/check command.");
  }
  return {
    allow: true,
    matchedPolicy: "allow",
    blockedCommand,
    nextAction: "Continue.",
    reason: "No hook policy matched."
  };
}
function evaluatePreToolUseHook(payload, repoRoot2) {
  const command = commandFromHookPayload(payload);
  if (!command) {
    return {
      allow: true,
      matchedPolicy: "allow_unparsed",
      blockedCommand: "",
      nextAction: "Continue.",
      reason: "Hook payload did not contain a command."
    };
  }
  const route = resolveHookRoute(payload, { legacyRepoRoot: repoRoot2 });
  if (route.status === "no_match") {
    return route.worktreeBinding ? routeSessionMismatchDecision(command, route.reason) : {
      allow: true,
      matchedPolicy: "hook_routing_no_match",
      blockedCommand: renderCommand(command),
      nextAction: "Continue.",
      reason: route.reason
    };
  }
  if (route.status === "ambiguous") {
    return {
      allow: false,
      matchedPolicy: "hook_routing_ambiguous",
      gate: "policy_violation",
      blockedCommand: renderCommand(command),
      nextAction: "Run `agent-loop hooks doctor` and bind this Codex session to exactly one agent-loop target.",
      reason: route.reason
    };
  }
  if (route.status === "route_error") {
    return routeErrorDecision(command, route.reason);
  }
  let storage;
  try {
    const config = loadConfig(route.binding.repoRoot).config;
    storage = new SqliteAgentLoopStorage(statePath(route.binding.repoRoot));
    const decision2 = evaluateHookPolicy({
      repoRoot: route.binding.repoRoot,
      command,
      storage,
      ...route.binding.runId ? { runId: route.binding.runId } : {},
      protectedPaths: config.protectedPaths
    });
    recordHookDecision(storage, decision2, route.binding.runId);
    return decision2;
  } catch (error) {
    const failSafe = evaluateHookPolicy({ repoRoot: route.binding.repoRoot, command });
    if (!failSafe.allow) {
      return {
        ...failSafe,
        matchedPolicy: `fail_safe:${failSafe.matchedPolicy}`,
        reason: `Storage unavailable; denied dangerous command. ${error instanceof Error ? error.message : String(error)}`
      };
    }
    return failSafe;
  } finally {
    storage?.close();
  }
}
function toCodexHookResponse(decision2) {
  if (decision2.allow) {
    return { continue: true };
  }
  return {
    decision: "block",
    reason: decision2.reason,
    systemMessage: formatHookMessage(decision2)
  };
}
function recordHookDecision(storage, decision2, runId) {
  const run = runId ? storage.listRuns(200).find((item) => item.id === runId) : storage.getCurrentRun();
  const command = decision2.blockedCommand;
  storage.appendEvent({
    ...run ? { runId: run.id } : {},
    kind: hookEventKind("PreToolUse"),
    message: decision2.reason,
    payload: {
      allow: decision2.allow,
      matchedPolicy: decision2.matchedPolicy,
      ...decision2.gate ? { gate: decision2.gate } : {},
      ...decision2.auditDetails ? { auditDetails: decision2.auditDetails } : {},
      nextAction: decision2.nextAction,
      commandLength: command.length,
      commandSha256: createHash2("sha256").update(command).digest("hex"),
      commandPreview: redactSecrets(command.slice(0, 500))
    }
  });
}
function routeErrorDecision(command, reason) {
  const baseCommand = normalizeCommand(command);
  const shellControl = shellControlPolicy(baseCommand);
  const normalized = shellControl ? baseCommand : unwrapCommand(baseCommand);
  const blockedCommand = renderCommand(normalized);
  const destructive = shellControl ?? destructivePolicy(normalized);
  if (destructive || lifecycleCommand(normalized)) {
    return deny(
      blockedCommand,
      `hook_routing_error${destructive ? `:${destructive}` : ""}`,
      "policy_violation",
      "Fix agent-loop hook routing with `agent-loop hooks doctor` before running lifecycle or destructive commands."
    );
  }
  return {
    allow: true,
    matchedPolicy: "hook_routing_error_noop",
    blockedCommand,
    nextAction: "Continue.",
    reason: `Hook routing unavailable; no-op for non-lifecycle command. ${reason}`
  };
}
function routeSessionMismatchDecision(command, reason) {
  const baseCommand = normalizeCommand(command);
  const shellControl = shellControlPolicy(baseCommand);
  const normalized = shellControl ? baseCommand : unwrapCommand(baseCommand);
  const blockedCommand = renderCommand(normalized);
  const destructive = shellControl ?? destructivePolicy(normalized);
  if (destructive || lifecycleCommand(normalized)) {
    return deny(
      blockedCommand,
      `hook_routing_session_mismatch${destructive ? `:${destructive}` : ""}`,
      "policy_violation",
      "Bind this Codex session explicitly with `agent-loop hooks bind --session ...` before running lifecycle or destructive commands."
    );
  }
  return {
    allow: true,
    matchedPolicy: "hook_routing_no_match",
    blockedCommand,
    nextAction: "Continue.",
    reason
  };
}
function lifecycleCommand(command) {
  const args = stripGitGlobalOptions(command.args);
  return command.file === "git" && ["commit", "push", "merge"].includes(args[0] ?? "") || command.file === "gh" && command.args[0] === "pr" && ["create", "ready", "merge"].includes(command.args[1] ?? "");
}
function gatedLifecyclePolicy(command, storage, runId) {
  const args = stripGitGlobalOptions(command.args);
  const lifecycleCommand2 = command.file === "git" && args[0] === "commit" || command.file === "git" && args[0] === "push" || command.file === "gh" && command.args[0] === "pr" && command.args[1] === "merge";
  if (!lifecycleCommand2) {
    return void 0;
  }
  if (!storage) {
    return {
      policy: "storage_required_for_lifecycle",
      gate: "policy_violation",
      nextAction: "Run `pnpm agent-loop status` after restoring .agent-loop/state.sqlite."
    };
  }
  const current = storage.getCurrentStatus();
  const run = runId ? storage.getRun(runId) : current.run;
  const state = run?.currentState;
  const override = activeMaintainerOverride(storage, lifecycleOverrideScope(command), runId);
  if (command.file === "git" && (args[0] === "commit" || args[0] === "push") && state !== "COMMIT_PUSH_PR" && !override) {
    return {
      policy: "commit_push_state_gate",
      gate: current.gate?.kind ?? "policy_violation",
      nextAction: "Resume agent-loop until COMMIT_PUSH_PR owns publishing."
    };
  }
  if (command.file === "git" && (args[0] === "commit" || args[0] === "push") && !publishPrerequisitesSatisfied(storage, runId)) {
    return {
      policy: "commit_push_prerequisite_gate",
      gate: "policy_violation",
      nextAction: "Run SELF_CHECK and GitNexus detect_changes through agent-loop before publishing."
    };
  }
  if (command.file === "gh" && command.args[0] === "pr" && command.args[1] === "merge" && state !== "MERGE" && !override) {
    return {
      policy: "merge_state_gate",
      gate: current.gate?.kind ?? "merge_requires_confirmation",
      nextAction: "Wait for READY_TO_MERGE/MERGE and explicit approval."
    };
  }
  return void 0;
}
function lifecycleOverrideScope(command) {
  const args = stripGitGlobalOptions(command.args);
  if (command.file === "git" && (args[0] === "commit" || args[0] === "push")) {
    return "publish";
  }
  if (command.file === "gh" && command.args[0] === "pr" && command.args[1] === "merge") {
    return "merge";
  }
  return void 0;
}
function activeMaintainerOverride(storage, scope, runId) {
  if (!storage || !scope) {
    return void 0;
  }
  const run = runId ? storage.getRun(runId) : storage.getCurrentRun();
  if (!run) {
    return void 0;
  }
  return storage.listDecisions(run.id).map((decision2) => {
    const details = objectDetails(decision2.details);
    const overrideScope = stringValue2(details?.scope);
    const expiresAt = stringValue2(details?.expiresAt);
    if (decision2.kind !== "maintainer_override_approved" || !overrideScope || !expiresAt) {
      return void 0;
    }
    if (overrideScope !== scope) {
      return void 0;
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return void 0;
    }
    return { decisionId: decision2.id, scope, expiresAt };
  }).find((override) => override !== void 0);
}
function destructivePolicy(command) {
  const args = stripGitGlobalOptions(command.args);
  if (command.file === "git" && args[0] === "reset" && args.includes("--hard")) {
    return "destructive_git_reset_hard";
  }
  if (command.file === "git" && args[0] === "clean" && args.some((arg) => /^-.*f/.test(arg))) {
    return "destructive_git_clean";
  }
  if (command.file === "git" && args[0] === "push" && args.some(
    (arg) => ["-f", "-d", "--force", "--force-with-lease", "--mirror", "--delete"].includes(arg) || arg.startsWith("+") || /^:[^:]+/.test(arg)
  )) {
    return "destructive_git_force_push";
  }
  if (command.file === "gh" && command.args[0] === "repo" && command.args[1] === "delete") {
    return "destructive_gh_repo_delete";
  }
  return void 0;
}
function workerLifecyclePolicy(command) {
  const args = stripGitGlobalOptions(command.args);
  if (command.file === "git" && ["commit", "push", "merge"].includes(args[0] ?? "")) {
    return "worker_git_lifecycle_forbidden";
  }
  if (command.file === "gh" && command.args[0] === "pr" && ["create", "ready", "merge"].includes(command.args[1] ?? "")) {
    return "worker_gh_lifecycle_forbidden";
  }
  return void 0;
}
function protectedPathPolicy(command, protectedPaths) {
  const args = stripGitGlobalOptions(command.args);
  if (command.file !== "git" || args[0] !== "add") {
    return void 0;
  }
  const separator = args.indexOf("--");
  const paths = separator >= 0 ? args.slice(separator + 1) : args.slice(1);
  const hit = paths.find((path) => protectedPaths.some((pattern) => matchesProtectedPath(pattern, path)));
  return hit ? `protected_path:${hit}` : void 0;
}
function matchesHookAllowlist(command) {
  const args = stripGitGlobalOptions(command.args);
  if (command.file === "rg" && matchesRipgrepAllowlist(command.args) || isApplyPatchCommand(command)) {
    return true;
  }
  if (command.file === "git") {
    return args[0] === "status" || args[0] === "branch" && args[1] === "--show-current" || args[0] === "rev-parse" || args[0] === "diff" || ["log", "show"].includes(args[0] ?? "") || args[0] === "grep" && matchesGitGrepAllowlist(args.slice(1)) || args[0] === "switch" && args.length === 2 && typeof args[1] === "string" && !args[1].startsWith("-") || args[0] === "add" && args[1] === "--" || args[0] === "commit" && args[1] === "-m" || args[0] === "push" && matchesGitPushAllowlist(args.slice(1));
  }
  if (command.file === "gh") {
    return command.args[0] === "auth" && command.args[1] === "status" || command.args[0] === "pr" && ["list", "view", "checks"].includes(command.args[1] ?? "") || command.args[0] === "pr" && command.args[1] === "merge" && matchesGhPrMergeAllowlist(command.args.slice(2)) || command.args[0] === "api" && command.args[1] === "graphql";
  }
  if (command.file === "pnpm") {
    return command.args[0] === "test" || command.args[0] === "lint" || command.args[0] === "build:hooks" || command.args[0] === "build:mcp" || command.args[0] === "agent-loop" && matchesAgentLoopAllowlist(command.args.slice(1));
  }
  if (command.file === "npx") {
    return command.args[0] === "gitnexus" && ["--version", "status", "analyze", "detect_changes", "impact"].includes(command.args[1] ?? "");
  }
  if (command.file === "codex") {
    return command.args[0] === "--version";
  }
  return false;
}
function matchesRipgrepAllowlist(args) {
  return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
}
function matchesGitGrepAllowlist(args) {
  return !args.some(
    (arg) => arg === "-O" || arg.startsWith("-O") || arg === "--open-files-in-pager" || arg.startsWith("--open-files-in-pager=")
  );
}
function matchesGitPushAllowlist(args) {
  return args.length >= 3 && args[0] === "-u" && args.every((arg) => !["-f", "-d", "--force", "--force-with-lease", "--mirror", "--delete"].includes(arg) && !arg.startsWith("+") && !/^:[^:]+/.test(arg));
}
function matchesGhPrMergeAllowlist(args) {
  const allowedFlags = /* @__PURE__ */ new Set(["--merge", "--squash", "--rebase", "--body", "--subject"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (["--admin", "--auto", "--delete-branch", "-d"].includes(arg)) {
      return false;
    }
    if (arg.startsWith("--") && !allowedFlags.has(arg)) {
      return false;
    }
    if ((arg === "--body" || arg === "--subject") && args[index + 1]) {
      index += 1;
    }
  }
  return args.some((arg) => ["--merge", "--squash", "--rebase"].includes(arg));
}
function isApplyPatchCommand(command) {
  return command.file === "apply_patch" || command.raw?.startsWith("*** Begin Patch") === true;
}
function matchesAgentLoopAllowlist(args) {
  if (["status", "doctor", "logs", "observe", "timeline", "workers", "stop"].includes(args[0] ?? "")) {
    return true;
  }
  if (args[0] === "local") {
    return args[1] === "doctor";
  }
  if (args[0] === "hooks") {
    return ["doctor", "list"].includes(args[1] ?? "");
  }
  if (args[0] === "delivery") {
    return ["bind", "stage"].includes(args[1] ?? "");
  }
  if (args[0] === "evidence") {
    return args[1] === "append";
  }
  if (args[0] === "maintainer-override") {
    return args[1] === "approve";
  }
  return false;
}
function shellControlPolicy(command) {
  if (isApplyPatchCommand(command)) {
    return void 0;
  }
  if (command.raw && hasShellControlOperator(command.raw)) {
    return "shell_control_operator_forbidden";
  }
  if (command.file === "env") {
    const index = command.args.findIndex((arg) => !arg.includes("="));
    if (index >= 0) {
      return shellControlPolicy({ file: basename(command.args[index] ?? ""), args: command.args.slice(index + 1) });
    }
  }
  if ((command.file === "sh" || command.file === "bash") && command.args[0] === "-c" && command.args[1] && hasShellControlOperator(command.args[1])) {
    return "shell_control_operator_forbidden";
  }
  return void 0;
}
function deny(blockedCommand, matchedPolicy, gate, nextAction) {
  return {
    allow: false,
    matchedPolicy,
    gate,
    blockedCommand,
    nextAction,
    reason: `${matchedPolicy} blocked ${blockedCommand}`
  };
}
function formatHookMessage(decision2) {
  return [
    `blocked command: ${decision2.blockedCommand}`,
    `matched policy: ${decision2.matchedPolicy}`,
    decision2.gate ? `gate: ${decision2.gate}` : void 0,
    `next action: ${decision2.nextAction}`
  ].filter(Boolean).join("\n");
}
function normalizeCommand(command) {
  return { ...command, file: basename(command.file) };
}
function unwrapCommand(command) {
  if (command.file === "env") {
    const index = command.args.findIndex((arg) => !arg.includes("="));
    if (index >= 0) {
      return unwrapCommand({ file: command.args[index] ?? "", args: command.args.slice(index + 1), raw: renderCommand(command) });
    }
  }
  if ((command.file === "sh" || command.file === "bash") && command.args[0] === "-c" && command.args[1]) {
    return unwrapCommand(tokenizeCommand(command.args[1]));
  }
  return command;
}
function renderCommand(command) {
  return command.raw ?? [command.file, ...command.args].join(" ");
}
function tokenizeCommand(command) {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
  const [file = "", ...args] = parts;
  return { file: basename(file), args, raw: command };
}
function hasShellControlOperator(value) {
  return /&&|\|\||[;|<>\n\r]/.test(value);
}
function stripGitGlobalOptions(args) {
  const result = [...args];
  while (result.length > 0) {
    const first = result[0];
    if (first === "-C" || first === "--git-dir" || first === "--work-tree" || first === "-c") {
      result.splice(0, 2);
      continue;
    }
    if (first === "--no-pager" || first === "--paginate") {
      result.shift();
      continue;
    }
    if (first?.startsWith("--git-dir=") || first?.startsWith("--work-tree=") || first?.startsWith("-c")) {
      result.shift();
      continue;
    }
    break;
  }
  return result;
}
function publishPrerequisitesSatisfied(storage, runId) {
  const run = runId ? storage.getRun(runId) : storage.getCurrentRun();
  if (!run) {
    return false;
  }
  if (storage.hasRunCheck(run.id, "self_check") && storage.hasRunCheck(run.id, "gitnexus_detect_changes")) {
    return true;
  }
  return publishWorkflowEvidenceSatisfied(storage, run.id);
}
function publishWorkflowEvidenceSatisfied(storage, runId) {
  const completed = /* @__PURE__ */ new Set();
  for (const event of storage.listEvents(200)) {
    const payload = objectDetails(event.payload);
    if (event.runId !== runId || event.kind !== "workflow_stage_evidence" || stringValue2(payload?.stageId) !== "verify" || stringValue2(payload?.status) !== "done") {
      continue;
    }
    const substageId = stringValue2(payload?.substageId);
    if (substageId) {
      completed.add(substageId);
    }
  }
  return REQUIRED_PUBLISH_EVIDENCE_SUBSTAGES.every((substageId) => completed.has(substageId));
}
function basename(value) {
  return value.replaceAll("\\", "/").split("/").at(-1) ?? value;
}
function stringValue2(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function objectDetails(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}

// plugins/autonomous-pr-loop/hooks/pre-tool-use.ts
var repoRoot = process.env.AGENT_LOOP_REPO_ROOT;
var input = readStdinJson();
var decision = safeEvaluate(input, repoRoot);
process.stdout.write(`${JSON.stringify(toCodexHookResponse(decision))}
`);
function safeEvaluate(input2, repoRoot2) {
  try {
    return evaluatePreToolUseHook(input2, repoRoot2);
  } catch (error) {
    return {
      allow: false,
      matchedPolicy: "hook_runner_error",
      gate: "policy_violation",
      blockedCommand: "<hook runner error>",
      nextAction: "Run `agent-loop hooks doctor` and fix hook routing before retrying.",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
function readStdinJson() {
  const text = readFileSync3(0, "utf8");
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    const decision2 = {
      allow: false,
      matchedPolicy: "malformed_hook_payload",
      gate: "policy_violation",
      blockedCommand: "<unparseable hook payload>",
      nextAction: "Retry the tool call with a valid PreToolUse payload.",
      reason: "PreToolUse payload was not valid JSON."
    };
    process.stdout.write(`${JSON.stringify(toCodexHookResponse(decision2))}
`);
    process.exit(0);
  }
}
