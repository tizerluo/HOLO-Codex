# Generic Loop Example: Repo Hygiene Audit

This example shows how to use `generic-loop` for a repository hygiene audit. It is a usage sample, not a new workflow engine. The loop produces an auditable Markdown report, pauses at human gates, and leaves evidence in artifacts, timeline, and the Dashboard.

Use this when you want a repeatable non-PR workflow such as checking docs, config, install notes, test entrypoints, and maintainer workflow consistency.

Do not use this for code PR delivery, automatic cleanup, arbitrary DAG orchestration, production operations, or any workflow that should bypass human approval.

## Clean Repo Setup

Start from a clean target repository:

```bash
git status --short
pnpm agent-loop init
pnpm agent-loop status --json
```

Then edit `.agent-loop/config.json` in the target repository:

```json
{
  "repoId": "owner/repo",
  "baseBranch": "main",
  "plansDir": "docs/plans",
  "loopShape": "generic-loop",
  "workflowProfile": "repo_hygiene_loop",
  "roleProfile": "default_pr_roles",
  "requiredChecks": []
}
```

Do not add `protectedPaths` unless you intend to replace the defaults. The default protected paths keep `.git/`, `.agent-loop/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`, env files, and secret-like paths out of worker changes.

`repo_hygiene_loop` writes only report-style artifacts under the built-in allowed roots, currently `docs` and `reports`. Keep `.agent-loop/` out of commits; it is runtime state.

## Goal

Use a concrete goal, for example:

```text
Audit this repository for local install, docs, test command, handoff, and dashboard example drift. Produce a Markdown repo hygiene audit report with findings, severity, evidence, and recommended action. Do not edit source code or perform cleanup.
```

The important part is the boundary: this loop can inspect the repo and write a report, but cleanup should remain explicit and scoped.

## Command Flow

Run until the first human gate:

```bash
pnpm agent-loop run --until=gate --json
pnpm agent-loop observe --json
```

For a fresh generic-loop run, expect a goal confirmation gate:

```json
{
  "kind": "generic_goal_needs_confirmation",
  "state": "DEFINE_GOAL",
  "allowedNextStates": ["COLLECT_CONTEXT", "PLAN_WORK", "STOPPED"]
}
```

This snippet shows the key fields. The full gate details also include profile metadata, `expectedDeliverable`, `defaultNextState`, and the required approval payload.

Approve it after confirming the goal and boundary:

```bash
pnpm agent-loop approve-gate <gate-id> \
  --next-state COLLECT_CONTEXT \
  --note "Goal and report-only boundary confirmed."
pnpm agent-loop resume --json
```

The loop should collect context, write a plan artifact, execute the audit report, self-review it, and then stop again at `generic_human_gate` before delivery:

```bash
pnpm agent-loop observe --json
pnpm agent-loop timeline --limit 20 --json
pnpm agent-loop workers --events --json
```

If the report is acceptable:

```bash
pnpm agent-loop approve-gate <gate-id> \
  --next-state DELIVER \
  --note "Repo hygiene report approved for delivery."
pnpm agent-loop resume --json
```

If the report needs changes:

```bash
pnpm agent-loop approve-gate <gate-id> \
  --next-state EXECUTE_STEP \
  --note "Add missing install and dashboard evidence before delivery."
pnpm agent-loop resume --json
```

## Expected Artifacts

The run should register at least these artifact records. The Dashboard Artifact Viewer and JSON audit export include artifact paths. `timeline --source artifact` shows artifact entries by name, kind, hash, and artifact id.

| Kind | Typical name | Purpose |
| --- | --- | --- |
| `generic-context` | `context.md` | Captures collected context and profile metadata. |
| `generic-plan` | `plan.md` | Captures the plan, expected deliverable, required evidence, and review checklist. |
| `generic-deliverable` | `deliverable.md` | Captures the final approved handoff for the repo hygiene report. |
| worker result | worker-generated Markdown or JSON artifact | Contains the detailed audit report and worker evidence. |

The report should contain severity, evidence, and recommended action. It should not include raw secrets, private prompt text, or unrelated cleanup patches.

## Timeline And Audit Validation

Validate the audit path with:

```bash
mkdir -p reports
pnpm agent-loop timeline --source gate --limit 20 --json
pnpm agent-loop timeline --source artifact --limit 20 --json
pnpm agent-loop audit-export --run <run-id> --format markdown --output reports/repo-hygiene-audit.md
pnpm agent-loop audit-export --run <run-id> --format json --output reports/repo-hygiene-audit.json
```

Expected evidence:

- A `generic_goal_needs_confirmation` gate before work starts.
- A `generic_plan_ready` decision after planning.
- Worker timeline entries for execute and self-review steps.
- Artifact timeline entries for context, plan, and deliverable records.
- Artifact paths in the Dashboard Artifact Viewer or `reports/repo-hygiene-audit.json`.
- A `generic_human_gate` before delivery.
- A `generic_loop_completed` event when the run reaches `COMPLETE`.

## Dashboard Checks

Open the Dashboard:

```bash
pnpm agent-loop dashboard
```

In Mission Control and related views, confirm:

- The profile shows `loopShape=generic-loop` and `workflowProfile=repo_hygiene_loop`.
- Deliverable readiness replaces PR merge readiness.
- Gate Center shows the active generic gate and allowed next states.
- Artifacts include context, plan, and deliverable records.
- Timeline contains state, decision, gate, worker, and artifact entries for the run.
- Worker Runs shows planner, implementation, and reviewer roles, but the supervisor still owns Git and lifecycle actions.

## Recovery Notes

If a worker fails, inspect before recovering:

```bash
pnpm agent-loop observe --json
pnpm agent-loop workers --events --json
pnpm agent-loop recover --json
pnpm agent-loop resume --json
```

If the worker requests a broader scope, the run should open `generic_scope_change_requested`. Approve only if the broader scope still belongs to this audit. Otherwise send it back to `PLAN_WORK` or stop the run.

Generic-loop completion returns the run to a non-running status with `COMPLETE` as the terminal state. To run another audit, start a new run instead of resuming a completed one.
