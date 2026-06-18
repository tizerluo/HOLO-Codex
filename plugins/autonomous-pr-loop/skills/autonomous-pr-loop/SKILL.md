# HOLO-Codex

Use this skill when the user asks Codex to enter or continue the HOLO-Codex Human On Loop delivery workflow.

## Required startup

1. Read the current repository `AGENTS.md` before doing any work.
2. Read `.agent-loop/config.json` before inferring repository state.
3. Prefer the plugin MCP control plane when available. If MCP is unavailable, run `pnpm agent-loop status`.
4. Read state from the configured storage. Do not use chat history as the source of truth.

## Gate behavior

- If status is `BLOCKED`, report the blocker and stop unless the user explicitly gives the next action.
- If config is missing, report `needs_repo_init` and ask the user to run `pnpm agent-loop init` or provide config.
- Do not bypass policy gates with direct shell commands.

## Worker boundary

- Supervisor may create branches, run checks, commit, push, and create PRs when the state machine allows it.
- Worker agents must not commit, push, create PRs, merge, or modify protected runtime state.
- Worker agents return implementation output for supervisor review.

## Current boundary

This plugin version provides the shell, config, storage, policy gates, PR lifecycle supervision, worker orchestration, Codex hooks, MCP control plane, and a local dashboard. It does not provide GitHub webhooks, a hosted service, or a permanent daemon.
