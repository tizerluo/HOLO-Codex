# Contributing

Thanks for helping improve HOLO-Codex.

## Development Setup

```bash
pnpm install
pnpm build:hooks
pnpm test
pnpm lint
```

Use `pnpm agent-loop ...` while working inside this repository. Use the global `agent-loop ...` command only after running the local install workflow described in [Local Release Readiness](./docs/local-release-readiness.md).

## Runtime Compatibility Names

HOLO-Codex is the public product name. The `agent-loop` CLI, `.agent-loop/` runtime directory, `autonomous-pr-loop` plugin id, and `plugins/autonomous-pr-loop/` source path are stable compatibility identifiers. Do not rename them without a migration plan.

## PR Workflow

- Keep each PR scoped to one issue.
- Start from latest `main`.
- Do not commit `.agent-loop/`, SQLite files, tokens, raw hook payloads, raw transcripts, or worker logs.
- Run focused tests for touched areas, then `pnpm lint` and `pnpm test`.
- If GitNexus is configured, inspect impact before risky symbol edits and run detect before committing:

Use the GitNexus repo id configured on your machine:

```bash
npx gitnexus detect-changes --repo <indexed-repo-id> --scope staged
```

## Maintainer Delivery Loop

For repository self-maintenance, use the local delivery workflow:

```bash
pnpm agent-loop delivery bind --issue ISSUE --title "..." --url https://github.com/OWNER/REPO/issues/ISSUE --json
pnpm agent-loop delivery stage --stage plan --status active --summary "Planning work." --json
```

Record meaningful stage evidence for plan, build, verify, PR, review, merge readiness, and cleanup. PR bodies and reviewer comments should include the bound run id when using the delivery loop.

## Review Expectations

- Classify findings as P0/P1/P2/P3.
- Fix real P0/P1/P2 findings before merge unless a P2 is explicitly routed to a linked follow-up issue.
- Keep P3 polish in the same PR when it is small and in scope.
- Reviewer reports from external agents should be posted as PR comments when that workflow is used.

## Public Source Hygiene

Historical private planning docs, local handoff notes, Logseq artifacts, and runtime files should not be included in public release artifacts. The public repository should be usable from active docs, not from private chat history.
