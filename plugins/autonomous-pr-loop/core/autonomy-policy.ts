import type {
  AgentLoopCiCheck,
  AgentLoopConfig,
  AgentLoopDecision,
  AgentLoopGate,
  AgentLoopReviewComment,
  AgentLoopRunCheck
} from "./types.js";

export interface AutonomyPosture {
  autonomyMode: AgentLoopConfig["autonomyMode"];
  mergeMode: AgentLoopConfig["mergeMode"];
  notifyMode: AgentLoopConfig["notifyMode"];
  reviewHandling: AgentLoopConfig["reviewHandling"];
  summary: string;
  notifyWhen: string[];
  requiresConfirmation: string[];
  allowConditionalMerge: boolean;
}

export interface MergeReadiness {
  state: "manual" | "disabled" | "ready" | "missing_evidence" | "confirmation_required";
  ready: boolean;
  missingConditions: string[];
  evidence: string[];
  carryoverRecords: string[];
}

export interface MergeReadinessInput {
  config: AgentLoopConfig;
  ci: AgentLoopCiCheck[];
  reviewComments: AgentLoopReviewComment[];
  gates: AgentLoopGate[];
  decisions: AgentLoopDecision[];
  runChecks: AgentLoopRunCheck[];
}

/** Explain the repository's current Human On Loop autonomy posture. */
export function describeAutonomyPosture(config: AgentLoopConfig): AutonomyPosture {
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

/** Evaluate whether policy evidence is sufficient for conditional merge. */
export function evaluateMergeReadiness(input: MergeReadinessInput): MergeReadiness {
  const missing: string[] = [];
  const evidence: string[] = [];
  const carryoverRecords = input.decisions
    .filter((decision) => decision.kind.includes("carryover") || decision.kind.includes("follow_up"))
    .map((decision) => decision.message);

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

  const openActionable = input.reviewComments.filter((comment) =>
    comment.actionable && !comment.isResolved && !comment.isOutdated && comment.status === "open"
  );
  if (openActionable.length > 0) {
    missing.push("no open actionable review comments");
  } else {
    evidence.push("review comments clear");
  }

  if (input.config.requireReviewApproval) {
    const approved = input.decisions.some((decision) =>
      decision.kind.includes("review") && decision.kind.includes("approved")
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

  const gitnexusPassed = input.runChecks.some((check) =>
    check.kind === "gitnexus_detect_changes" && check.status === "passed"
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

  const carryoverChecked = input.runChecks.some((check) =>
    check.kind === "carryover_recorded" && (check.status === "passed" || check.status === "skipped")
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

function ciCheckGreen(check: AgentLoopCiCheck): boolean {
  return check.conclusion?.toLowerCase() === "success" && check.status.toLowerCase() === "completed";
}

function baseReadiness(
  state: MergeReadiness["state"],
  ready: boolean,
  missingConditions: string[],
  evidence: string[],
  carryoverRecords: string[]
): MergeReadiness {
  return { state, ready, missingConditions, evidence, carryoverRecords };
}

function postureSummary(config: AgentLoopConfig): string {
  const autonomy = config.autonomyMode.replaceAll("_", " ");
  const merge = config.mergeMode === "conditional" ? "conditional merge when evidence passes" : `${config.mergeMode} merge`;
  return `Agent runs ${autonomy}; ${merge}; notifications are ${config.notifyMode.replaceAll("_", " ")}.`;
}

function notifyRules(config: AgentLoopConfig): string[] {
  if (config.notifyMode === "blockers_only") {
    return ["blocked", "confirmation_required"];
  }
  if (config.notifyMode === "all_gates") {
    return ["all gates", "CI/review attention", "worker failures", "merge completion"];
  }
  return ["blocked", "confirmation_required", "high-risk policy changes", "external reviewer or CI failures"];
}

function confirmationRules(config: AgentLoopConfig): string[] {
  const rules = ["dangerous policy changes", "protected path changes"];
  if (config.mergeMode !== "conditional") {
    rules.push("manual merge decision");
  }
  if (config.autonomyMode === "supervised") {
    rules.push("run progression beyond one step");
  }
  return rules;
}
