# HOLO-Codex npm Release Checklist

Use this checklist for npm releases such as `v0.1.0`.

The public source release remains available at `https://github.com/tizerluo/HOLO-Codex`. The npm package is `holo-codex` and installs the stable `agent-loop` CLI. Compatibility identifiers remain unchanged: `agent-loop`, `.agent-loop/`, `autonomous-pr-loop`, and `plugins/autonomous-pr-loop/`.

## Pre-Publish Validation

Run from the release checkout:

```bash
pnpm install --frozen-lockfile
pnpm build:hooks
pnpm lint
pnpm test
npm pack --ignore-scripts --dry-run --json
npm view holo-codex name version dist-tags --json || true
```

Before the first publish, `npm view holo-codex ...` should return `E404`. For later releases, confirm the registry version is lower than the version in `package.json`.

Review the pack output for accidental private material. The package must include the CLI, hooks dist, dashboard UI source, schemas, plugin metadata, MCP server, skills, public docs, and brand assets. It must not include tests, private planning/spec/research docs, `.agent-loop/`, raw logs, raw hook payloads, raw transcripts, or local backups.

Run a secret and local-state scan:

```bash
rg -n "(ghp_|gho_|github_pat_|sk-[A-Za-z0-9]|dashboard token|AGENT_LOOP_MCP_TOKEN)" .
find . -path './.git' -prune -o -path './node_modules' -prune -o -name '.agent-loop' -print
```

Expected result: no real tokens, no committed `.agent-loop/`, no raw hook payloads, no raw transcripts, no private handoff, and no historical `docs/plans/`, `docs/specs/`, or `docs/research/` material.

## Tarball Smoke

```bash
npm pack --ignore-scripts --json
tmp="$(mktemp -d)"
export CODEX_HOME="$tmp/codex-home"
mkdir -p "$tmp/target-repo"
git -C "$tmp/target-repo" init -b main
git -C "$tmp/target-repo" remote add origin https://github.com/example/holo-codex-smoke.git
npm install --prefix "$tmp/install" ./holo-codex-*.tgz
"$tmp/install/node_modules/.bin/agent-loop" --help
"$tmp/install/node_modules/.bin/agent-loop" --repo "$tmp/target-repo" init --json
"$tmp/install/node_modules/.bin/agent-loop" install-hooks --repo "$tmp/target-repo" --json
"$tmp/install/node_modules/.bin/agent-loop" --repo "$tmp/target-repo" local doctor --json
```

Do not publish if this smoke fails.

## Publish

Confirm npm authentication without printing tokens:

```bash
npm whoami
npm ping --json
```

Publish:

```bash
npm publish --access public
```

If npm requires 2FA, complete the interactive prompt locally. Do not paste npm tokens or one-time codes into docs, PR bodies, issue comments, commits, artifacts, or screenshots.

## Post-Publish Smoke

Install from the registry in a fresh temporary prefix:

```bash
tmp="$(mktemp -d)"
export CODEX_HOME="$tmp/codex-home"
mkdir -p "$tmp/target-repo"
git -C "$tmp/target-repo" init -b main
git -C "$tmp/target-repo" remote add origin https://github.com/example/holo-codex-smoke.git
npm install --prefix "$tmp/install" holo-codex
"$tmp/install/node_modules/.bin/agent-loop" --help
"$tmp/install/node_modules/.bin/agent-loop" local doctor --help
"$tmp/install/node_modules/.bin/agent-loop" --repo "$tmp/target-repo" init --json
"$tmp/install/node_modules/.bin/agent-loop" install-hooks --repo "$tmp/target-repo" --json
test -f "$tmp/install/node_modules/holo-codex/plugins/autonomous-pr-loop/.codex-plugin/plugin.json"
```

Optional dashboard smoke:

```bash
"$tmp/install/node_modules/.bin/agent-loop" --repo "$tmp/target-repo" dashboard
```

Open the printed loopback URL and confirm Mission Control loads without a token in the URL. Do not copy the fallback token into release notes, screenshots, logs, or PR comments.

## Source Install Smoke

Keep the source path working as a fallback and development path:

```bash
git clone https://github.com/tizerluo/HOLO-Codex.git /tmp/holo-codex-release-smoke
cd /tmp/holo-codex-release-smoke
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build:hooks
pnpm agent-loop local install --repo /path/to/sandbox-repo
agent-loop local doctor --repo /path/to/sandbox-repo
agent-loop --repo /path/to/sandbox-repo doctor
```

## Rollback Smoke

Use a fake or disposable `CODEX_HOME` unless a real rollback is explicitly intended:

```bash
export CODEX_HOME=/tmp/holo-codex-release-codex-home
agent-loop local install --repo /path/to/sandbox-repo
agent-loop local snapshots
agent-loop local rollback --snapshot /path/to/snapshot
agent-loop local doctor --repo /path/to/sandbox-repo
```

Expected result: hooks and binding registry restore from the snapshot, non-agent-loop hooks remain untouched, and malformed current hook files are preserved with a `.broken-<timestamp>` suffix when present.

## GitHub Release

After publish and post-publish smoke pass:

```bash
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 \
  --repo tizerluo/HOLO-Codex \
  --title "HOLO-Codex v0.1.0" \
  --notes-file /path/to/release-notes.md
```

Release notes must state:

- HOLO-Codex is an observable workflow loop control plane for long-running Codex work; PR delivery is the first bundled workflow.
- npm install path: `npm install --global holo-codex`.
- Source install path: `git clone https://github.com/tizerluo/HOLO-Codex.git`.
- Rollback uses `agent-loop local rollback --snapshot <snapshot>`.
- npm uninstall removes the package, but shared HOLO-Codex router entries in `~/.codex/hooks.json` must be removed manually only after all target repo bindings are gone.
- Runtime state, tokens, raw hook payloads, raw transcripts, and dashboard tokens must not be committed or shared.
