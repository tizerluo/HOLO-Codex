# HOLO-Codex Install

English: Install the local-first plugin, configure MCP/hook integration, then initialize `.agent-loop/` state.

中文：先安装本地优先插件，配置 MCP/hooks，再初始化 `.agent-loop/` 状态。

See also: [README](../README.md) / [中文 README](../README.zh-CN.md) / [Local Release Readiness](./local-release-readiness.md).

## Install Dependencies

```bash
pnpm install
pnpm build:hooks
```

Development CLI options:

```bash
# From this repository
pnpm agent-loop status

# Safe local install with snapshot/rollback
pnpm agent-loop local install --repo /path/to/repo
agent-loop --repo /path/to/repo status
```

The package remains private in this phase. `agent-loop local install` performs the local path global installation, snapshots Codex hook state, checks for accidental manifest churn, installs the hook router, and prints a rollback command. npm publishing is a future packaging decision. If pnpm reports that the global bin directory is not in `PATH`, add that directory to `PATH` before installing or use a shell profile managed by `pnpm setup`.

For the full fresh-machine checklist, including MCP env, hooks, dashboard login, and smoke tests, use [Local Release Readiness](./local-release-readiness.md).

## Enable The Plugin

Add this repository as a local Codex plugin marketplace:

```bash
codex plugin marketplace add /path/to/HOLO-Codex
```

Then enable `autonomous-pr-loop` in Codex config using the local marketplace entry.

Plugin enablement and global CLI installation are separate. The marketplace entry enables Codex plugin/MCP/skill integration; the global install only exposes the `agent-loop` shell command.

## Configure MCP

The plugin ships `plugins/autonomous-pr-loop/.mcp.json` with a stdio MCP server named `autonomous-pr-loop`.
Mutating MCP tools require a shared token. Set it in the Codex MCP server environment and pass the same value as `token` when calling mutating tools:

```bash
export AGENT_LOOP_MCP_TOKEN="change-me"
```

Manual fallback:

```bash
codex mcp add autonomous-pr-loop \
  --cwd /path/to/HOLO-Codex/plugins/autonomous-pr-loop \
  -- pnpm exec tsx ./mcp-server/src/index.ts
```

When using the global CLI from another repository, keep `AGENT_LOOP_REPO_ROOT=/path/to/repo` in the MCP server environment so mutating tools bind the intended target repository.

## Initialize Local State

Current development packaging exposes both the repository-local command and the global command. Run either from the target repository, or pass `--repo <path>` to bind a target workspace:

```bash
pnpm agent-loop init
pnpm agent-loop doctor
pnpm agent-loop status
pnpm agent-loop --repo /path/to/repo status
pnpm agent-loop --repo /path/to/repo dashboard
agent-loop --repo /path/to/repo status
agent-loop --repo /path/to/repo dashboard
```

`--repo` is parsed as a global flag before command dispatch; do not use the literal `--repo` as the value of another command option.

`doctor` reports whether hooks are installed and whether config/storage/tool checks pass.

Runtime state is stored in the target repository's `.agent-loop/` and must not be committed.

## Configure Hooks

Plugin hook auto-loading is not assumed. For a fresh target repository, initialize local state first, then install the hook router and target binding:

```bash
agent-loop --repo /path/to/repo init
agent-loop install-hooks --repo /path/to/repo
```

This installs one stable HOLO-Codex hook router into `~/.codex/hooks.json`, preserves existing user hooks, and records the target repository binding under `~/.codex/agent-loop/hook-bindings.json`.

Multi-repo note: multiple target repositories can share the same `CODEX_HOME`; hook events are routed by Codex cwd/worktree/session context before any repo state is written or policy is applied. Use a separate `CODEX_HOME` only when you want a fully isolated sandbox.

When starting real PR delivery work in that repository, bind after init/hooks:

```bash
agent-loop --repo /path/to/repo delivery bind --issue ISSUE --title "..." --url https://github.com/OWNER/REPO/issues/ISSUE
```

## Upgrade, Reinstall, Or Uninstall

Upgrade or reinstall the global CLI from the plugin repository:

```bash
git pull --ff-only
pnpm install
pnpm build:hooks
pnpm agent-loop local install --repo /path/to/repo
agent-loop --repo /path/to/repo doctor
```

Rollback a local install with the snapshot path printed by install:

```bash
agent-loop local rollback --snapshot /path/to/snapshot
```

Rollback preserves malformed current hook files as `hooks.json.broken-<timestamp>` or `hook-bindings.json.broken-<timestamp>` before restoring the snapshot, so operators can inspect the broken file after recovery.

Inspect and prune old local-install snapshots:

```bash
agent-loop local snapshots
agent-loop local snapshots prune --keep 10
agent-loop local snapshots prune --keep 10 --apply
```

`prune` is dry-run by default. It deletes only valid old `local-install-*` snapshots when `--apply` is present; malformed snapshots are skipped with warnings.

Manual fallback: remove the global CLI package with `pnpm remove --global codex-auto-pr-loop-plugin`. If the package name changes, inspect global packages with `pnpm list --global --depth 0` and remove the matching `agent-loop` provider. Hook router entries live in `~/.codex/hooks.json`; target bindings live in `~/.codex/agent-loop/hook-bindings.json` and can be removed with `agent-loop hooks unbind --repo /path/to/repo`.

Detailed upgrade, reinstall, uninstall, and global CLI resource checks are in [Local Release Readiness](./local-release-readiness.md).

## Dashboard And Local Observability

Start the dashboard from this repository or through the global command:

```bash
pnpm agent-loop --repo /path/to/repo dashboard
agent-loop --repo /path/to/repo dashboard
```

The command prints a loopback URL on stdout and a fallback session token on stderr. Open the URL to load the local dashboard; loopback sessions unlock themselves through a same-origin bootstrap, and the browser sends the session token through the `x-agent-loop-token` header for dashboard mutations. The manual token login screen remains as a fallback for static UI, old links, or recovery.

Useful local observability commands:

```bash
agent-loop --repo /path/to/repo timeline --limit 20
agent-loop --repo /path/to/repo workers --events
agent-loop --repo /path/to/repo observe
agent-loop --repo /path/to/repo audit-export --run RUN_ID --format markdown
```

Theme and locale are browser-local display preferences. They do not change `.agent-loop/config.json` or SQLite state.
