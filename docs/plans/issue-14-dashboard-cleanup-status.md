# Issue #14 Dashboard Cleanup Status Consistency

## Summary

Fix the Task Console cleanup view so the workflow stage rail, inspector substages, and main cleanup checklist derive cleanup completion from the same evidence model.

## Branch

- `codex/issue-14-cleanup-status`
- Base: GitHub `main` at `40cd7c51d361b346e9b5b3fc727708729341061a`
- Bound run: `cfc220ce-9cf6-490b-b30a-334c8a8a7aa3`

## Scope

- Keep the storage schema, CLI evidence payload, and React `CheckTable` shape unchanged.
- Update workflow board derivation so cleanup substages use per-substage evidence instead of inheriting the aggregate cleanup stage status.
- Include every cleanup substage in `cleanupChecks`, including `next_issue_selected`.
- Preserve trusted fallbacks:
  - `pr_merged` may pass from a merged PR link.
  - `worktree_clean` may pass from `run.worktreeClean === true`.

## Impact

GitNexus impact before editing:

- `deriveWorkflowBoard`: HIGH, affects dashboard server, MCP controller, and workflow-board API behavior.
- `cleanupRows`: HIGH, affects the same dashboard/API path through `deriveWorkflowBoard`.
- `buildStage`: LOW, internal workflow stage construction.

## Implementation Order

1. Add shared cleanup substage row/state derivation in `workflow-board.ts`.
2. Make cleanup `buildStage` substages use that shared derivation.
3. Make `cleanupRows` return the same substage set and status source.
4. Add focused API/render tests for aggregate-only evidence and full substage evidence.
5. Run lint, tests, GitNexus detect, and Browser validation.

## Test Plan

- Focused tests:
  - `plugins/autonomous-pr-loop/tests/dashboard-api.test.ts`
  - `plugins/autonomous-pr-loop/tests/dashboard-render.test.tsx`
- Full verification:
  - `pnpm lint`
  - `pnpm test`
  - GitNexus detect changes
- Browser validation:
  - Check every primary dashboard navigation view.
  - Verify no console errors or bad tokens.
  - Confirm Cleanup sidebar, inspector, and checklist statuses are consistent.
  - Retry desktop, tablet, and mobile viewport checks; mark tablet/mobile incomplete if Browser viewport override does not apply.

## Review Expectations

This is a non-trivial dashboard/API/UI fix. After PR creation, request external code review and UI review, publish each report to the PR, and fix or route every real P0/P1/P2 finding.
