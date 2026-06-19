# HOLO-Codex Source Release Checklist

Use this checklist for source/local-install releases such as `v0.1.0-source`.

This release path publishes a GitHub source snapshot and local Codex marketplace workflow. It does not publish npm.

## Release Scope

- Public source repository: `https://github.com/tizerluo/HOLO-Codex`
- Supported install path: clone source, install dependencies, run `agent-loop local install`.
- Supported plugin path: add the source checkout to the local Codex plugin marketplace.
- Stable compatibility identifiers remain unchanged: `agent-loop`, `.agent-loop/`, `autonomous-pr-loop`, and `plugins/autonomous-pr-loop/`.

## Pre-Release Validation

Run from the source checkout:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
npm pack --dry-run --json
```

Review the pack output for accidental private material. For source releases, tests and development files may remain in the dry-run package; npm package narrowing is tracked separately.

Run a secret and local-state scan:

```bash
rg -n "(ghp_|gho_|github_pat_|sk-[A-Za-z0-9]|dashboard token|AGENT_LOOP_MCP_TOKEN)" .
find . -path './.git' -prune -o -path './node_modules' -prune -o -name '.agent-loop' -print
```

Expected result: no real tokens, no committed `.agent-loop/`, no raw hook payloads, no raw transcripts, no private handoff, and no historical `docs/plans/`, `docs/specs/`, or `docs/research/` material.

## Source Install Smoke

Use a fresh clone:

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

Dashboard smoke:

```bash
agent-loop --repo /path/to/sandbox-repo dashboard
```

Open the printed loopback URL and confirm Mission Control loads without a token in the URL. Do not copy the fallback token into release notes, screenshots, logs, or PR comments.

## Rollback Smoke

Use a fake or disposable `CODEX_HOME` unless a real rollback is explicitly intended:

```bash
export CODEX_HOME=/tmp/holo-codex-release-codex-home
pnpm agent-loop local install --repo /path/to/sandbox-repo
agent-loop local snapshots
agent-loop local rollback --snapshot /path/to/snapshot
agent-loop local doctor --repo /path/to/sandbox-repo
```

Expected result: hooks and binding registry restore from the snapshot, non-agent-loop hooks remain untouched, and malformed current hook files are preserved with a `.broken-<timestamp>` suffix when present.

## Public Release

After the private development PR is merged and the public repository is synchronized:

```bash
git tag v0.1.0-source
git push origin v0.1.0-source
gh release create v0.1.0-source \
  --repo tizerluo/HOLO-Codex \
  --title "HOLO-Codex v0.1.0-source" \
  --notes-file /path/to/release-notes.md
```

Release notes must state:

- This is a source/local-install release.
- HOLO-Codex is an observable workflow loop control plane for long-running Codex work; PR delivery is the first bundled workflow.
- npm is not published yet.
- Recommended install starts from `git clone https://github.com/tizerluo/HOLO-Codex.git`.
- Rollback uses `agent-loop local rollback --snapshot <snapshot>`.
- Runtime state, tokens, raw hook payloads, raw transcripts, and dashboard tokens must not be committed or shared.
