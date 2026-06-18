import { AgentLoopError } from "./errors.js";
import { resolveLoopShape, sandboxForShapeState } from "./loop-shapes.js";
import { workerSandbox } from "./worker-prompts.js";
import type { AgentLoopConfig, AgentLoopProfileSummary, LoopShapeId, RoleProfileId, WorkerType, WorkflowProfileId, WorkflowStageSummary } from "./types.js";
import type { AgentLoopState } from "./state-types.js";

export interface RoleAlias {
  id: string;
  label: string;
  aliasFor: WorkerType;
  description: string;
  systemPrompt: string;
  scope: "read-only" | "workspace-write";
}

export interface RoleProfile {
  id: RoleProfileId;
  label: string;
  description: string;
  aliases: Record<string, RoleAlias>;
}

export interface WorkflowProfile {
  id: WorkflowProfileId;
  label: string;
  description: string;
  loopShape: LoopShapeId;
  shapeConfig: { roleOverrides: Partial<Record<AgentLoopState, string>> };
  configOverrides: Partial<Pick<
    AgentLoopConfig,
    "requireReviewApproval" | "maxCiReruns" | "protectedPaths" | "lintCommand" | "workerTimeoutMs" | "commandTimeoutMs" | "autonomyMode"
  >>;
  validationPosture: string;
  likelyGates: string[];
  handoffTemplate: string;
  autonomyBoundary: string;
  expectedDeliverable?: string;
  allowedWriteRoots?: string[];
  requiredEvidence?: string[];
  reviewChecklist?: string[];
  maxExecutionReviewCycles?: number;
}

export const WORKFLOW_PROFILE_IDS = [
  "default_pr_loop",
  "docs_only_loop",
  "review_fix_loop",
  "release_ready_loop",
  "research_report_loop",
  "document_preparation_loop",
  "repo_hygiene_loop",
  "weekly_review_loop",
  "data_extraction_loop"
] as const;

export const ROLE_PROFILE_IDS = ["default_pr_roles"] as const;

export const DEFAULT_LOOP_SHAPE_ID = "pr-loop";
export const DEFAULT_WORKFLOW_PROFILE_ID: WorkflowProfileId = "default_pr_loop";
export const DEFAULT_ROLE_PROFILE_ID: RoleProfileId = "default_pr_roles";

const DEFAULT_ROLE_PROFILE: RoleProfile = {
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

const WORKFLOW_PROFILES: Record<WorkflowProfileId, WorkflowProfile> = {
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

/** Resolve and validate the configured workflow and role profile. */
export function resolveProfile(config: AgentLoopConfig, currentState?: AgentLoopState): AgentLoopProfileSummary {
  const shape = resolveLoopShape(config.loopShape);
  const workflow = workflowProfile(config.workflowProfile);
  const roleProfile = roleProfileById(config.roleProfile);
  if (workflow.loopShape !== shape.id) {
    throw new AgentLoopError("invalid_config", "Workflow profile loopShape does not match config loopShape.");
  }
  validateRoleProfile(roleProfile);
  validateWorkflowProfile(workflow, roleProfile);
  const roleMapping = shape.states
    .map((state) => roleMappingForState(state, workflow, roleProfile))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  const currentRole = currentState ? roleMappingForState(currentState, workflow, roleProfile) : undefined;
  return {
    loopShape: shape.id,
    workflowProfile: workflow.id,
    workflowLabel: workflow.label,
    workflowDescription: workflow.description,
    roleProfile: roleProfile.id,
    lifecycleKind: shape.lifecycleKind,
    ...(workflow.expectedDeliverable ? { expectedDeliverable: workflow.expectedDeliverable } : {}),
    ...(workflow.allowedWriteRoots ? { allowedWriteRoots: workflow.allowedWriteRoots } : {}),
    ...(currentRole ? { currentRole } : {}),
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

/** Return an effective config with profile presets applied conservatively. */
export function applyProfileConfig(config: AgentLoopConfig): AgentLoopConfig {
  const workflow = workflowProfile(config.workflowProfile);
  validateWorkflowProfile(workflow, roleProfileById(config.roleProfile));
  const override = workflow.configOverrides;
  return {
    ...config,
    ...(override.lintCommand && !config.lintCommand ? { lintCommand: override.lintCommand } : {}),
    requireReviewApproval: config.requireReviewApproval || override.requireReviewApproval === true,
    maxCiReruns: minNumber(config.maxCiReruns, override.maxCiReruns),
    workerTimeoutMs: minNumber(config.workerTimeoutMs, override.workerTimeoutMs),
    commandTimeoutMs: minNumber(config.commandTimeoutMs, override.commandTimeoutMs),
    autonomyMode: tighterAutonomy(config.autonomyMode, override.autonomyMode),
    protectedPaths: [...new Set([...config.protectedPaths, ...(override.protectedPaths ?? [])])]
  };
}

/** Return dry-run stage summaries from the registered PR loop shape. */
export function workflowStages(config: AgentLoopConfig): WorkflowStageSummary[] {
  const workflow = workflowProfile(config.workflowProfile);
  const roleProfile = roleProfileById(config.roleProfile);
  const shape = resolveLoopShape(workflow.loopShape);
  return shape.states
    .filter((state) => !shape.terminalStates.includes(state))
    .map((state) => {
      const role = roleMappingForState(state, workflow, roleProfile);
      return {
        state,
        ...(role ? { roleAlias: role.alias, workerType: role.workerType } : {}),
        ...(role ? { sandbox: role.sandbox } : {}),
        gateExpected: workflow.likelyGates.length > 0 && gateExpectedForState(workflow.loopShape, state),
        ...(workflow.expectedDeliverable && ["HUMAN_GATE", "DELIVER"].includes(state) ? { deliverable: workflow.expectedDeliverable } : {})
      };
    });
}

export function workflowProfileIds(): WorkflowProfileId[] {
  return [...WORKFLOW_PROFILE_IDS];
}

export function roleProfileIds(): RoleProfileId[] {
  return [...ROLE_PROFILE_IDS];
}

function workflowProfile(id: WorkflowProfileId): WorkflowProfile {
  const profile = WORKFLOW_PROFILES[id];
  if (!profile) {
    throw new AgentLoopError("invalid_config", "Config workflowProfile is invalid.");
  }
  return profile;
}

function roleProfileById(id: RoleProfileId): RoleProfile {
  if (id !== DEFAULT_ROLE_PROFILE.id) {
    throw new AgentLoopError("invalid_config", "Config roleProfile is invalid.");
  }
  return DEFAULT_ROLE_PROFILE;
}

function validateRoleProfile(profile: RoleProfile): void {
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

function validateWorkflowProfile(workflow: WorkflowProfile, profile: RoleProfile): void {
  const shape = resolveLoopShape(workflow.loopShape);
  for (const [state, roleAlias] of Object.entries(workflow.shapeConfig.roleOverrides)) {
    if (!shape.states.includes(state as AgentLoopState)) {
      throw new AgentLoopError("invalid_config", "Workflow profile references an unknown state.", { details: { state } });
    }
    if (roleAlias === "release-manager") {
      throw new AgentLoopError("invalid_config", "release-manager is display-only and cannot be used as an executable role.");
    }
    const role = profile.aliases[roleAlias ?? ""];
    const defaultRole = shape.defaultRoleForState(state as AgentLoopState);
    if (!role || role.aliasFor !== defaultRole) {
      throw new AgentLoopError("invalid_config", "Workflow role override cannot change the state's worker sandbox.", {
        details: { state, roleAlias, aliasFor: role?.aliasFor, defaultRole }
      });
    }
  }
}

function roleMappingForState(state: AgentLoopState, workflow: WorkflowProfile, profile: RoleProfile): AgentLoopProfileSummary["roleMapping"][number] | undefined {
  const shape = resolveLoopShape(workflow.loopShape);
  const workerType = shape.defaultRoleForState(state);
  if (!workerType) return undefined;
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

export function workflowProfileDefinition(id: WorkflowProfileId): WorkflowProfile {
  return workflowProfile(id);
}

function defaultAliasFor(workerType: WorkerType): string {
  const aliases: Record<WorkerType, string> = {
    planner: "planner",
    implementation: "implementer",
    reviewer: "reviewer",
    "review-fix": "review-fix",
    "ci-fix": "ci-fix"
  };
  return aliases[workerType];
}

function minNumber(current: number, override: number | undefined): number {
  return override === undefined ? current : Math.min(current, override);
}

function tighterAutonomy(current: AgentLoopConfig["autonomyMode"], override: AgentLoopConfig["autonomyMode"] | undefined): AgentLoopConfig["autonomyMode"] {
  if (!override) return current;
  const rank: Record<AgentLoopConfig["autonomyMode"], number> = {
    supervised: 0,
    autonomous_until_gate: 1,
    autonomous_until_terminal: 2
  };
  return rank[override] < rank[current] ? override : current;
}

function gateExpectedForState(loopShape: LoopShapeId, state: AgentLoopState): boolean {
  if (loopShape === "pr-loop") {
    return ["SELECT_NEXT_PR", "WAIT_REVIEW_OR_CI", "READY_TO_MERGE"].includes(state);
  }
  return ["DEFINE_GOAL", "EXECUTE_STEP", "HUMAN_GATE"].includes(state);
}
