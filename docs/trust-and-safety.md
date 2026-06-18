# Trust And Safety

English: Safety boundaries keep workers scoped, supervisor actions auditable, and secrets out of durable artifacts.

中文：安全边界确保 worker 只做受控实现，supervisor 操作可审计，密钥不会进入持久化 artifacts。

See also: [README](../README.md) / [中文 README](../README.zh-CN.md).

## Worker Boundary

Delegated workers may edit workspace files and return structured results. They must not commit, push, create PRs, mark PRs ready, or merge. The supervisor owns Git and GitHub lifecycle actions.

Worker prompts, command policy, Codex sandboxing, and PR E hooks all reinforce this boundary.

## Hooks Coverage

Hooks cover the Codex tool loop only. `PreToolUse` blocks destructive Git/GitHub commands and lifecycle actions when state gates are not satisfied.

Hooks do not intercept commands a user runs in an external Terminal.

## MCP Mutations

Mutating MCP tools require `AGENT_LOOP_MCP_TOKEN`. Calls without the matching token return `needs_secret_or_login` and do not update loop state.

## Merge Safety

`mergeMode` is the canonical merge policy. Legacy `allowAutoMerge` is accepted only as compatibility input. Merge still requires review, CI, open-comment, scope, and policy gates to pass.

## Generic Loop Safety

`generic-loop` uses the same supervisor, storage, gate, artifact, and audit boundaries as `pr-loop`. Planning and review states run read-only. Write-capable generic states require profile-scoped write roots and still pass through scope guard and hook policy.

## Dashboard Tokens

`agent-loop dashboard` prints the loopback URL on stdout and the session token on stderr. The dashboard login stores the token in browser localStorage and sends it as `x-agent-loop-token`. Mutation endpoints still require the token and loopback/origin guard. CLI `observe --json`, audit export, and normal dashboard URLs do not include the token.

## Secrets And Logs

Do not write secrets to code, docs, reports, logs, artifacts, commits, or PR bodies. Store local credentials in the operating system keychain or the user's configured secret manager.

Command output may be stored as `.agent-loop/` artifacts. Review output before sharing it outside the local machine.

## Runtime State

`.agent-loop/`, SQLite state files, WAL/SHM files, raw worker JSONL, and hook logs are runtime data and must not be committed.
