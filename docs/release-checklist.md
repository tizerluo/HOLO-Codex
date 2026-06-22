# HOLO-Codex npm Release Checklist

Use this checklist for npm releases such as `v0.1.1`. Replace `VERSION` with the package version being released.

The public source release remains available at `https://github.com/tizerluo/HOLO-Codex`. The npm package is `holo-codex` and installs the stable `agent-loop` CLI. Compatibility identifiers remain unchanged: `agent-loop`, `.agent-loop/`, `autonomous-pr-loop`, and `plugins/autonomous-pr-loop/`.

## Pre-Publish Validation

Run from the release checkout:

```bash
pnpm install --frozen-lockfile
pnpm build:hooks
pnpm lint
pnpm exec vitest run --no-file-parallelism --maxWorkers=1
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
pack_json="$(npm pack --ignore-scripts --json)"
tgz="$(node -e 'const fs = require("fs"); const pack = JSON.parse(fs.readFileSync(0, "utf8")); console.log(pack[0].filename)' <<< "$pack_json")"
tar -xOf "$tgz" package/plugins/autonomous-pr-loop/hooks/hooks.json
tar -xOf "$tgz" package/plugins/autonomous-pr-loop/hooks/hooks.json | node -e 'const fs = require("fs"); const hooks = JSON.parse(fs.readFileSync(0, "utf8")); const legacy = Object.keys(hooks).filter((key) => key !== "hooks"); if (!hooks.hooks || typeof hooks.hooks !== "object" || legacy.length) { console.error(JSON.stringify({ legacy }, null, 2)); process.exit(1); }'
tmp="$(mktemp -d)"
export CODEX_HOME="$tmp/codex-home"
mkdir -p "$tmp/target-repo"
git -C "$tmp/target-repo" init -b main
git -C "$tmp/target-repo" remote add origin https://github.com/example/holo-codex-smoke.git
npm install --prefix "$tmp/install" "./$tgz"
"$tmp/install/node_modules/.bin/agent-loop" --help
"$tmp/install/node_modules/.bin/agent-loop" --repo "$tmp/target-repo" init --json
"$tmp/install/node_modules/.bin/agent-loop" install-hooks --repo "$tmp/target-repo" --json
"$tmp/install/node_modules/.bin/agent-loop" --repo "$tmp/target-repo" local doctor --json
```

The extracted `hooks.json` must have a top-level `hooks` object and must not have legacy top-level hook event keys such as `PreToolUse`. Do not publish if this smoke fails.

## Publish

### GitHub Actions CD

For `v0.1.2` and later, prefer the manual Release workflow:

1. Configure npm Trusted Publishing for package `holo-codex`:
   - Provider: GitHub Actions
   - Repository: `tizerluo/HOLO-Codex`
   - Workflow file: `release.yml`
   - Allowed action: `npm publish`
   - Environment: leave blank unless the workflow is later changed to use one.
2. Run the `Release` workflow from `main` with:
   - `version`: the exact `package.json` version
   - `tag`: blank to use `v<version>`, or an explicit tag
   - `dry_run`: `true` first
3. Inspect the dry-run artifact and logs.
4. Re-run with `dry_run: false` to publish with npm provenance and create the GitHub Release.

The workflow uses GitHub OIDC (`id-token: write`) instead of a long-lived npm token. It runs on Node 24 and installs npm `^11.5.1` in both validation and publish jobs, satisfying the npm Trusted Publishing floor of Node 22.14.0+ and npm 11.5.1+.
Dry runs may use an already-published version to test the workflow shape; real releases fail if the npm version or Git tag already exists.
Dry runs validate inputs, run the stable Vitest suite, pack the tarball, verify hook schema, smoke the packed tarball, and upload the release candidate. The workflow checks existing npm versions through retried registry HTTP status codes instead of parsing npm CLI error text. The publish job re-verifies the downloaded tarball integrity against `holo-pack.json` before `npm publish`.
Dry runs do not execute `npm publish`, so the first `dry_run: false` run is the first real Trusted Publishing/OIDC validation.
After a real publish, the workflow creates the Git tag and GitHub Release before the registry install smoke. That keeps the release recoverable even if npm registry propagation makes the smoke temporarily fail.
The manual fallback below is intentionally separate from Trusted Publishing. It may not create provenance unless npm supports it in the local environment and the maintainer explicitly chooses that path.

### Manual fallback

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
VERSION=0.1.2
git tag "v$VERSION"
git push origin "v$VERSION"
gh release create "v$VERSION" \
  --repo tizerluo/HOLO-Codex \
  --title "HOLO-Codex v$VERSION" \
  --notes-file /path/to/release-notes.md
```

Release notes must state:

- HOLO-Codex is an observable workflow loop control plane for long-running Codex work; PR delivery is the first bundled workflow.
- npm install path: `npm install --global holo-codex`.
- Source install path: `git clone https://github.com/tizerluo/HOLO-Codex.git`.
- Rollback uses `agent-loop local rollback --snapshot <snapshot>`.
- npm uninstall removes the package, but shared HOLO-Codex router entries in `~/.codex/hooks.json` must be removed manually only after all target repo bindings are gone.
- Runtime state, tokens, raw hook payloads, raw transcripts, and dashboard tokens must not be committed or shared.
