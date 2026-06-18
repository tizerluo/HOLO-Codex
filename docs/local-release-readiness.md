# HOLO-Codex Local Release Readiness Checklist

This checklist prepares HOLO-Codex for day-to-day use through a local path global install. It does not publish the package to npm and does not define a future package-manager story.

## Fresh Machine Setup

Run these steps from the plugin repository:

```bash
git clone https://github.com/OWNER/HOLO-Codex.git
cd HOLO-Codex
pnpm install
pnpm build:hooks
pnpm agent-loop local install --repo /path/to/target-repo
agent-loop --help
```

`agent-loop local install` snapshots `~/.codex/hooks.json` and `~/.codex/agent-loop/hook-bindings.json`, installs the global CLI, installs or migrates router hooks, binds the target repo, checks for accidental manifest churn, and prints the rollback command. If pnpm reports that the configured global bin directory is not in `PATH`, add that directory to `PATH` before installing or run `pnpm setup` for your shell.

Enable the local Codex plugin separately from the global CLI install:

```bash
codex plugin marketplace add /path/to/HOLO-Codex
```

Then enable `autonomous-pr-loop` in Codex from the local marketplace entry.

Configure the MCP token in the Codex MCP server environment. Mutating MCP tools must receive the same token in their `token` input:

```bash
export AGENT_LOOP_MCP_TOKEN="change-me"
```

When configuring the MCP server manually, keep the MCP cwd at the plugin directory and bind the intended target repository with `AGENT_LOOP_REPO_ROOT`:

```bash
codex mcp add autonomous-pr-loop \
  --cwd /path/to/HOLO-Codex/plugins/autonomous-pr-loop \
  --env AGENT_LOOP_MCP_TOKEN="$AGENT_LOOP_MCP_TOKEN" \
  --env AGENT_LOOP_REPO_ROOT=/path/to/target-repo \
  -- pnpm exec tsx ./mcp-server/src/index.ts
```

Initialize one target repository:

```bash
agent-loop --repo /path/to/target-repo init
agent-loop --repo /path/to/target-repo doctor
agent-loop --repo /path/to/target-repo status
agent-loop install-hooks --repo /path/to/target-repo
agent-loop --repo /path/to/target-repo doctor
```

Runtime state is written to the target repository's `.agent-loop/` directory. Do not commit `.agent-loop/`, SQLite files, tokens, or dashboard session output.

## Upgrade Or Reinstall

Use this sequence when the plugin repository changes:

```bash
cd /path/to/HOLO-Codex
git pull --ff-only
pnpm install
pnpm build:hooks
pnpm agent-loop local install --repo /path/to/target-repo
agent-loop --repo /path/to/target-repo doctor
agent-loop --repo /path/to/target-repo status
```

Re-run `install-hooks` after updates because router hook commands include the current plugin install path and compiled hook runner paths. The target binding remains in `~/.codex/agent-loop/hook-bindings.json` and is refreshed by the same command.

If `doctor` reports stale or missing compiled hooks, run:

```bash
pnpm build:hooks
agent-loop install-hooks --repo /path/to/target-repo
```

## Uninstall Global CLI

Remove only the global shell command:

```bash
agent-loop local rollback --snapshot /path/to/snapshot
```

If rollback encounters malformed current hook state, it preserves the bad file as `hooks.json.broken-<timestamp>` or `hook-bindings.json.broken-<timestamp>` before restoring the snapshot. Keep these files only long enough for manual inspection.

Inspect and safely prune old install snapshots:

```bash
agent-loop local snapshots
agent-loop local snapshots prune --keep 10
agent-loop local snapshots prune --keep 10 --apply
```

`local snapshots prune` is a dry-run unless `--apply` is present. It skips malformed snapshots and reports warnings instead of deleting them.

Manual fallback: if pnpm reports the package name differently or rollback cannot remove the global command, inspect global packages and remove the matching `agent-loop` provider:

```bash
pnpm list --global --depth 0
pnpm remove --global codex-auto-pr-loop-plugin
```

Remove a target binding when that repository should no longer participate in the Codex hook loop:

```bash
agent-loop hooks unbind --repo /path/to/target-repo
```

The router entries live in `~/.codex/hooks.json`; target bindings live in `~/.codex/agent-loop/hook-bindings.json`. Remove router entries only when no target repository should use agent-loop hooks.

Remove the local plugin marketplace entry through Codex plugin management if you no longer want Codex to see the plugin. Do not delete `.agent-loop/` from a target repo unless you intentionally want to discard its local loop state.

## Global CLI Resource Smoke

From any directory outside the target repository, verify that global CLI commands bind the target repo while loading plugin resources from the plugin repository:

```bash
agent-loop --repo /path/to/target-repo status --json
agent-loop --repo /path/to/target-repo observe --json
agent-loop --repo /path/to/target-repo dashboard
agent-loop install-hooks --repo /path/to/target-repo
agent-loop local doctor --repo /path/to/target-repo
```

Expected results:

- `status --json` reports the target repository's `.agent-loop/state.sqlite`.
- `observe --json` reports the target dashboard URL and current run/gate state.
- `dashboard` serves the plugin dashboard UI, prints the loopback URL on stdout, and prints the session token on stderr.
- `install-hooks` writes one router hook command per Codex hook event, removes legacy per-repo agent-loop hook entries, and records the target repo binding in `~/.codex/agent-loop/hook-bindings.json`.
- `local doctor` reports the first `agent-loop` on `PATH`, whether it points to the expected package root, router hook dist drift, legacy entries, binding counts, stale/temp bindings, registry lock state, and self-link manifest pollution.
- MCP server cwd remains the plugin MCP directory; `AGENT_LOOP_REPO_ROOT` binds mutating tools to the target repo.
- Schemas remain package resources under `plugins/autonomous-pr-loop/schemas/`.

## Operator Smoke Tests

Before using the loop on real work, run:

```bash
agent-loop --repo /path/to/target-repo doctor
agent-loop --repo /path/to/target-repo status --json
agent-loop --repo /path/to/target-repo observe --json
agent-loop --repo /path/to/target-repo timeline --limit 20
agent-loop --repo /path/to/target-repo workers --events
```

Dashboard smoke:

```bash
agent-loop --repo /path/to/target-repo dashboard
```

Open the printed loopback URL and confirm Mission Control loads the target repository without manual token entry. The stderr token is a fallback local session secret for static UI or recovery only; do not paste or store it in docs, logs, PR bodies, commits, issue comments, artifacts, or screenshots.

MCP smoke:

- `loop_status` returns the same target repo state as `agent-loop --repo /path/to/target-repo status --json`.
- Mutating tools without a token return `needs_secret_or_login`.
- Mutating tools with the configured token bind the repository named by `AGENT_LOOP_REPO_ROOT`.

## Out Of Scope

- npm publishing.
- automatic upgrade or uninstall scripts.
- shell completion.
- hosted service, daemon, or GitHub webhooks.
- multi-version local marketplace management.
