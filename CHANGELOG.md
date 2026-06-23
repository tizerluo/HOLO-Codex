# Changelog

## 0.1.3

- Added `agent-loop release doctor` for reusable read-only release preflight checks.
- Added automated dashboard smoke checks for release readiness.
- Promoted reviewer evidence to first-class dashboard data.
- Improved stale hook diagnostics and structured argv handling.
- Relaxed hook policy for normal PR delivery, review, release preflight, and cleanup commands while preserving dangerous-action gates.
- Documented and validated the npm token fallback release path.

## 0.1.2

- Added the manual GitHub Actions Release workflow for npm Trusted Publishing, dry-run tarball validation, and registry install smoke.
- Added audited maintainer override support for lifecycle gates so verified release and merge operations can proceed with recorded evidence.
- Relaxed the hook allowlist for maintainer-owned commands after verified evidence is present.
- Hardened Codex hook and MCP startup compatibility for current Codex configurations.
- Fixed dashboard Cleanup status consistency so sidebar substages and the main cleanup checklist use the same cleanup evidence.
- Added the `next_issue_selected` cleanup checklist item to keep cleanup progress complete and visible.
- Validated the release path with the existing GitHub Actions Release workflow, tarball checks, and dashboard smoke requirements.
- Kept #16, #17, #18, and #19 as follow-up improvements outside this release-prep PR.

## 0.1.1

- Fixed the bundled Codex plugin hooks schema for newer Codex config parsers.
- Kept stable runtime identifiers unchanged: `agent-loop`, `.agent-loop/`, and `autonomous-pr-loop`.

## 0.1.0

- Initial public npm release of HOLO-Codex.
