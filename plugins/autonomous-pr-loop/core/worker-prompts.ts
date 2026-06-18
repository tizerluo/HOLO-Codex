import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentLoopConfig, AgentLoopProfileSummary, AgentLoopRun, WorkerType } from "./types.js";
import type { AgentLoopState } from "./state-types.js";
import type { WorkerPolicy } from "./worker-policy.js";

export interface WorkerPromptInput {
  repoRoot: string;
  run: AgentLoopRun;
  state: AgentLoopState;
  type: WorkerType;
  config: AgentLoopConfig;
  profile?: AgentLoopProfileSummary;
  policy?: WorkerPolicy;
  context?: unknown;
}

/** Build the controlled prompt passed to a Codex worker. */
export function buildWorkerPrompt(input: WorkerPromptInput): string {
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
    ...(genericLoop ? [] : [
      `- baseBranch: ${input.config.baseBranch}`,
      `- plansDir: ${input.config.plansDir}`
    ]),
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
    ...(genericLoop ? [
      "- Do not treat this as PR automation unless the workflow explicitly asks for PR-related documentation.",
      "- Do not create, update, ready, merge, or close pull requests.",
      "- Do not run release, deploy, publishing, notification, payment, or production-control side effects."
    ] : [
      "- Do not commit.",
      "- Do not push.",
      "- Do not create, update, ready, merge, or close pull requests."
    ]),
    "- Do not run git reset, git clean, git rebase, force push, or history rewriting commands.",
    "- Do not request danger-full-access or bypass sandbox approvals.",
    "",
    "## GitNexus Requirements",
    input.config.gitnexusRequired
      ? "- GitNexus impact and detect changes are required. Set gitnexus.impactRun and gitnexus.detectChangesRun truthfully."
      : "- GitNexus is best-effort. Record notes if unavailable.",
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

/** Return the sandbox required for a worker type. */
export function workerSandbox(type: WorkerType): "read-only" | "workspace-write" {
  return type === "reviewer" ? "read-only" : "workspace-write";
}

function allowedScope(input: WorkerPromptInput): string[] {
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

function requiredCommandsFor(type: WorkerType, config: AgentLoopConfig): string[] {
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

function summarizeAgents(repoRoot: string): string {
  const path = join(repoRoot, "AGENTS.md");
  if (!existsSync(path)) {
    return "No AGENTS.md found.";
  }
  const content = readFileSync(path, "utf8").trim();
  if (content.length <= 4_000) {
    return content;
  }
  return `${content.slice(0, 4_000)}\n[truncated]`;
}

function profileLines(input: WorkerPromptInput): string[] {
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
    ...(profile.expectedDeliverable ? [`- Expected deliverable: ${profile.expectedDeliverable}`] : []),
    ...(profile.allowedWriteRoots ? [`- Allowed write roots: ${profile.allowedWriteRoots.join(", ")}`] : []),
    `- Likely gates: ${profile.likelyGates.join(", ") || "none"}`,
    "- Role instruction:",
    `  ${roleInstruction(input)}`
  ];
}

function roleInstruction(input: WorkerPromptInput): string {
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
