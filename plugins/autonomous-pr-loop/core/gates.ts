import type { AgentLoopGateKind } from "./types.js";

/** Canonical gate constants shared by CLI, policy, storage tests, and future control surfaces. */
export const GATES: Record<AgentLoopGateKind, AgentLoopGateKind> = {
  needs_repo_init: "needs_repo_init",
  unsupported_remote: "unsupported_remote",
  needs_secret_or_login: "needs_secret_or_login",
  policy_violation: "policy_violation",
  ambiguous_next_pr: "ambiguous_next_pr",
  dirty_unowned_worktree: "dirty_unowned_worktree",
  required_tool_unavailable: "required_tool_unavailable",
  ci_required_checks_missing: "ci_required_checks_missing",
  ci_pending_timeout: "ci_pending_timeout",
  merge_requires_confirmation: "merge_requires_confirmation",
  github_transient_failure: "github_transient_failure",
  gitnexus_check_failed: "gitnexus_check_failed",
  github_resource_not_found: "github_resource_not_found",
  worker_failed: "worker_failed",
  worker_output_invalid: "worker_output_invalid",
  review_out_of_scope: "review_out_of_scope",
  worker_timeout: "worker_timeout",
  worker_already_running: "worker_already_running",
  generic_goal_needs_confirmation: "generic_goal_needs_confirmation",
  generic_human_gate: "generic_human_gate",
  generic_scope_change_requested: "generic_scope_change_requested"
};
