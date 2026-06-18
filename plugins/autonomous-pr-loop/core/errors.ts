import type { AgentLoopGateKind } from "./types.js";

export type AgentLoopErrorCode =
  | AgentLoopGateKind
  | "invalid_config"
  | "not_git_repo"
  | "config_exists"
  | "storage_schema_mismatch"
  | "version_conflict"
  | "storage_error"
  | "artifact_integrity_error"
  | "command_rejected"
  | "command_timeout"
  | "unknown_command";

/** Structured error used by CLI and core APIs to preserve stable machine-readable codes. */
export class AgentLoopError extends Error {
  readonly code: AgentLoopErrorCode;
  readonly details?: unknown;
  readonly exitCode: 0 | 1 | 2;

  constructor(
    code: AgentLoopErrorCode,
    message: string,
    options: { details?: unknown; exitCode?: 0 | 1 | 2 } = {}
  ) {
    super(message);
    this.name = "AgentLoopError";
    this.code = code;
    this.details = options.details;
    this.exitCode = options.exitCode ?? (isGateCode(code) ? 2 : 1);
  }
}

/** Return true when an error code represents a gate rather than an unexpected failure. */
export function isGateCode(code: AgentLoopErrorCode): code is AgentLoopGateKind {
  return (
    code === "needs_repo_init" ||
    code === "unsupported_remote" ||
    code === "needs_secret_or_login" ||
    code === "policy_violation" ||
    code === "ambiguous_next_pr" ||
    code === "dirty_unowned_worktree" ||
    code === "required_tool_unavailable" ||
    code === "ci_required_checks_missing" ||
    code === "ci_pending_timeout" ||
    code === "merge_requires_confirmation" ||
    code === "github_transient_failure" ||
    code === "gitnexus_check_failed" ||
    code === "github_resource_not_found" ||
    code === "worker_failed" ||
    code === "worker_output_invalid" ||
    code === "review_out_of_scope" ||
    code === "worker_timeout" ||
    code === "worker_already_running" ||
    code === "generic_goal_needs_confirmation" ||
    code === "generic_human_gate" ||
    code === "generic_scope_change_requested"
  );
}

/** Convert unknown thrown values into stable JSON-safe CLI error payloads. */
export function toErrorPayload(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof AgentLoopError) {
    const payload: { code: string; message: string; details?: unknown } = {
      code: error.code,
      message: error.message
    };
    if (error.details !== undefined) {
      payload.details = error.details;
    }
    return payload;
  }
  if (error instanceof Error) {
    return { code: "error", message: error.message };
  }
  return { code: "error", message: String(error) };
}
