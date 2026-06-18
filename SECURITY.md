# Security Policy

HOLO-Codex is a local-first Codex plugin. It stores runtime state on the user's machine and does not run a hosted service.

## Report A Vulnerability

Please report security issues privately to the repository owner before opening a public issue. Include the affected version or commit, a minimal reproduction, and the expected impact.

Do not include secrets, dashboard tokens, raw hook payloads, raw transcripts, private prompts, or full worker logs in public reports.

## Sensitive Local Data

Never commit or publish:

- `.agent-loop/`
- SQLite state files, WAL/SHM files, or local databases
- dashboard session tokens
- MCP tokens or API keys
- raw hook payloads
- raw transcript paths or transcript contents
- raw worker JSONL logs
- private prompts or private PR review output

Use the operating system keychain or your configured secret manager for credentials.

## Hook And Dashboard Boundaries

Codex hooks cover Codex tool-loop events only. They do not intercept commands run manually in an external terminal.

Dashboard mutations require the local session token and loopback/origin guards. The dashboard URL should not contain the token; the fallback token printed by `agent-loop dashboard` is for local recovery only.

## Public Release Checklist

Before publishing a public source snapshot or package:

- Run tests and lint.
- Run a secret/local-state scan.
- Verify `npm pack --dry-run --json` or the chosen release artifact.
- Confirm no `.agent-loop` runtime files, dashboard tokens, raw logs, or private handoff documents are included.
