# HOLO-Codex Self-Bootstrapping Workflow

这份 runbook 说明 HOLO-Codex 如何使用自己的 `agent-loop` 交付流程维护自己。

默认下一项工作来源是 **GitHub issues**。历史 plans/specs/research 不属于公开源码树；只有 issue 明确要求新增公开设计文档时，才新增新的公开文档。

## 启动一次自举维护

先从干净且最新的 `main` 开始：

```bash
git status --short --branch
git switch main
git pull --ff-only origin main
pnpm agent-loop status --json
pnpm agent-loop observe --json
gh issue list --repo OWNER/HOLO-Codex --state open --limit 30
```

如果目标是审计一次 dashboard-first 或 agent-loop-first 交付，使用 [Agent-loop-first Delivery Audit Checklist](./checklists/agent-loop-first-delivery-audit.md) 记录检查动作、证据位置和 PASS/PARTIAL/GAP 结论。

如果 status 是 `BLOCKED`，不要直接开新实现分支。先通过 `status`、`observe`、`timeline`、`workers` 检查 gate：

```bash
pnpm agent-loop timeline --limit 20 --json
pnpm agent-loop workers --events --json
```

如果 active terminal worker gate 已经过时，可以显式 recovery，再决定是否 resume：

```bash
pnpm agent-loop recover --json
pnpm agent-loop resume
```

如果 gate 仍然有效，应该 stop run，或带 note approve gate。不要只在聊天里绕过 active gate；每个决定都必须留下 CLI、dashboard、event 或 PR 记录。

## 选择下一项工作

选择顺序：

1. 用户明确指定的 issue 优先。
2. 否则从 open GitHub issues 中，结合当前 handoff 优先级选择。
3. manual goal 只用于很小的人工 override；如果目标不小，先创建或选择 GitHub issue。
4. 公开源码树不依赖历史 `docs/specs` 或 `docs/plans` 队列；需要设计背景时，以当前 issue 和公开 docs 为准。

开工前读取 issue body、当前 handoff 和相关文档。保持一个 issue 一个 PR。相关且安全的小发现应尽量在当前 PR 修掉，不要制造不必要的 follow-up issue。

真实 `$pr-delivery-loop` 工作应先绑定 dashboard-visible run：

```bash
pnpm agent-loop init
pnpm agent-loop install-hooks --repo "$PWD" --json
pnpm agent-loop delivery bind \
  --issue 46 \
  --title "Connect pr-delivery-loop to workflow evidence" \
  --url https://github.com/OWNER/HOLO-Codex/issues/46 \
  --json
```

Fresh repo 必须先 `init`，否则 `delivery bind` 没有 `.agent-loop/config.json` 和本地 SQLite 状态可写。已有 `.agent-loop/` 的仓库可以跳过重复初始化。

后续手工 commander 动作、review report、CI/merge readiness 和 cleanup 应记录到同一个 run。阶段开始和完成优先使用 `pnpm agent-loop delivery stage ...`，让 Mission Control 在文件编辑前就能显示当前阶段：

```bash
pnpm agent-loop delivery stage \
  --run RUN_ID \
  --stage build \
  --substage implementation_active \
  --status active \
  --summary "Implementation started after plan approval." \
  --json
```

普通证据、review report、CI/merge readiness 和 cleanup 仍可用 `pnpm agent-loop evidence append ...`。PR body、PR owner comment、tester/reviewer/Claude/AGY report comment 都应包含 run id，方便 GitHub 和 dashboard 互相对照。

Review/tester report 不只写自由文本 summary。派发、启动、完成、跳过或失败都应写结构化 review evidence：

```bash
pnpm agent-loop evidence append \
  --run RUN_ID \
  --stage review \
  --substage claude_acp_review \
  --reviewer claude_acp \
  --requirement required \
  --progress complete \
  --result pass \
  --severity none \
  --comment-url "https://github.com/OWNER/REPO/pull/PR#issuecomment-ID" \
  --summary "Claude ACP review completed with PASS." \
  --json
```

`complete` review evidence 必须链接 PR issue comment；`block` 或 `p2_or_higher` 会让 merge readiness 保持阻塞，直到同 PR 修复或按规则路由。

## 交付一个 PR

每个 issue 使用这条 loop：

```text
read issue and handoff
-> run GitNexus impact for code symbols to be edited
-> write or update the development plan
-> create branch from main
-> implement
-> run focused tests
-> run independent tester/reviewer when useful or requested
-> fix all real P0/P1/P2 findings
-> run pnpm lint, pnpm test, and GitNexus detect
-> commit, push, open PR
-> wait for CI/review
-> fix any CI/review blocker in the same PR
-> merge
-> switch main, pull, rebuild GitNexus index
```

合并后的固定收尾：

```bash
git switch main
git pull --ff-only origin main
npx gitnexus analyze
git status --short --branch
```

## Review 和 follow-up 纪律

- P0/P1 必须在当前 PR 修。
- P2 如果相关且安全，应在当前 PR 修。
- 只有当问题真实、超出当前 issue、且不能安全地在当前 PR 完成时，才创建 follow-up issue。
- P3 polish 如果很小，通常直接在当前 PR 修；否则只记录，不制造 issue 噪音。
- CI failure 永远不是当前 PR 的非阻塞 follow-up。

## CLI 安全注意

Mutating commands 包括 `recover`、`approve-gate`、`resume`、`stop`、`run`、`step`、`install-hooks`、`hooks install-router`、`hooks bind`、`hooks unbind`。`--help` 必须只打印 usage，不能修改 `.agent-loop` 状态或 hook registry。

Dashboard URL 只绑定 loopback。token 是本地 session secret，不能写入 commit、PR body、docs、logs、artifacts 或截图。

## 修改本 runbook 时的验证

```bash
pnpm test plugins/autonomous-pr-loop/tests/cli-run.test.ts
pnpm lint
pnpm test
pnpm agent-loop status --json
pnpm agent-loop observe --json
```

只有 PR 改 dashboard UI 或 live dashboard 行为时，才需要 Browser 验收。
