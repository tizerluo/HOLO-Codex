import { AgentLoopError } from "./errors.js";
import { resolveLoopShape, sandboxForShapeState } from "./loop-shapes.js";
import { workflowProfileDefinition } from "./profiles.js";
import type { AgentLoopConfig, WorkerType } from "./types.js";
import type { AgentLoopState } from "./state-types.js";

export interface WorkerPolicy {
  sandbox: "read-only" | "workspace-write";
  allowedPaths?: string[];
  protectedPaths: string[];
  commandPolicy: {
    lifecycleOwnedBySupervisor: boolean;
    allowedWriteRoots: string[];
    genericReadOnlyState: boolean;
  };
}

/** Resolve the single worker policy used by prompts, command execution, hooks, and scope guard. */
export function resolveWorkerPolicy(input: {
  config: AgentLoopConfig;
  state: AgentLoopState;
  workerType: WorkerType;
}): WorkerPolicy {
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
    ...(allowedPaths ? { allowedPaths } : {}),
    protectedPaths: input.config.protectedPaths,
    commandPolicy: {
      lifecycleOwnedBySupervisor: true,
      allowedWriteRoots: allowedPaths ?? [],
      genericReadOnlyState: shape.id === "generic-loop" && sandbox === "read-only"
    }
  };
}

function allowedPathsFor(
  config: AgentLoopConfig,
  state: AgentLoopState,
  workerType: WorkerType,
  sandbox: "read-only" | "workspace-write"
): string[] | undefined {
  if (config.loopShape === "pr-loop") {
    if (workerType === "planner") {
      return [config.plansDir];
    }
    if (workerType === "reviewer") {
      return [];
    }
    return undefined;
  }
  if (sandbox === "read-only") {
    return [];
  }
  if (state === "EXECUTE_STEP" || state === "DELIVER") {
    return workflowProfileDefinition(config.workflowProfile).allowedWriteRoots ?? [];
  }
  return [];
}
