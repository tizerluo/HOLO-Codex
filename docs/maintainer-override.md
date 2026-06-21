# Maintainer Override

Maintainer override is a short-lived local approval for trusted repository maintenance when the normal lifecycle state is behind verified work.

Use it only after the work has been reviewed and verified locally. It is not a general bypass for destructive commands, worker restrictions, hook routing errors, or protected path policy.

## Approve Publish

```bash
pnpm agent-loop maintainer-override approve \
  --scope publish \
  --reason "publish verified PR" \
  --ttl-minutes 5 \
  --json
```

`publish` allows lifecycle-gated `git commit -m ...` and `git push -u ...` while the approval is active. Force push, mirror push, delete refspecs, and other destructive push forms remain blocked.

## Approve Merge

```bash
pnpm agent-loop maintainer-override approve \
  --scope merge \
  --reason "merge verified PR" \
  --ttl-minutes 5 \
  --json
```

`merge` allows lifecycle-gated `gh pr merge` with a normal merge strategy while the approval is active. Admin merge, auto merge, and branch deletion flags remain blocked.

## Audit Trail

Every approval writes both:

- a `maintainer_override_approved` decision on the active run
- a `maintainer_override_approved` event with scope, reason, actor, source, expiry, and TTL

Every allowed lifecycle command is still recorded by the PreToolUse hook. The hook decision uses `maintainer_override:<scope>` when the override is active.

## Guardrails

- TTL must be between 1 and 120 minutes.
- `--reason` is required.
- Worker agents still cannot commit, push, or merge.
- Destructive commands such as `git reset --hard`, `git clean -f`, force push, and repository deletion remain blocked.
- Shell compound commands remain blocked before allowlist matching.
