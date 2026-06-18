# Agent-loop-first Delivery Audit Checklist

这份清单用于审计一次以 `agent-loop` 为优先入口的真实交付。目标不是证明 dashboard 好看，而是判断从 issue 选择到 PR 合并的关键行为是否可恢复、可审计、可暂停。

记录原则：

- 只记录摘要、ID、状态、时间、命令名和证据位置。
- 不记录 dashboard token、secret-like 内容、完整 worker raw log、私有 prompt 全文。
- 高风险写操作必须先写明原因，再记录结果。
- 每项结论使用 `PASS`、`PARTIAL`、`GAP`。

## 0. Preflight

| 项目 | 检查动作 | 预期证据 | 记录位置 | 判定标准 |
| --- | --- | --- | --- | --- |
| Git 基线 | `git status --short --branch`、`git switch main`、`git pull --ff-only origin main` | branch、HEAD、worktree clean 状态 | pilot report 的 Preflight | `PASS`：main 最新且干净；`PARTIAL`：可解释的本地运行态变化；`GAP`：旧分支或脏文件原因不明 |
| Loop 状态 | `pnpm agent-loop status --json`、`pnpm agent-loop observe --json` | current run id、status、state、branch、updatedAt | pilot report 的 Preflight | `PASS`：无 active run 或 active run 属于当前 work item；`PARTIAL`：旧 run 已记录并隔离；`GAP`：旧 active gate 未处理就开工 |
| 事件基线 | `pnpm agent-loop timeline --limit 20 --json`、`pnpm agent-loop workers --events --json` | 最近 state/event/worker/artifact 摘要 | pilot report 的 Preflight | `PASS`：能解释当前状态；`PARTIAL`：能看见事件但缺 work item 语义；`GAP`：关键状态只能靠聊天判断 |
| Issue 基线 | `gh issue view <audit>`、`gh issue view <payload>`、`gh issue list` | audit issue、payload issue、open queue | pilot report 的 Issue Selection | `PASS`：选择来源可追溯；`GAP`：dashboard 或 CLI 无法表达当前 work item |

## 1. Issue Selection

| 项目 | 检查动作 | 预期证据 | 记录位置 | 判定标准 |
| --- | --- | --- | --- | --- |
| Tracker/payload 区分 | 确认 audit tracker 和 pilot payload 是两个 issue | tracker 用于流程审计，payload 用于小改动 | Issue Selection | `PASS`：两者职责清楚；`GAP`：一个 issue 同时承担范围和审计导致混乱 |
| 优先级来源 | 检查 open issues、handoff、用户指定内容 | 用户指定优先，其次 GitHub issues 和 handoff | Issue Selection | `PASS`：选择理由有 issue/handoff 证据；`PARTIAL`：由 commander 解释但 dashboard 不显示；`GAP`：选择过程不可复现 |
| 范围控制 | 判断 payload 是否低风险 | 预期文件、non-goals、是否不碰 runtime | Issue Selection | `PASS`：改动足够小；`GAP`：pilot 样本本身扩大架构风险 |

## 2. Agent-loop-first Execution

| 项目 | 检查动作 | 预期证据 | 记录位置 | 判定标准 |
| --- | --- | --- | --- | --- |
| Dry run | `pnpm agent-loop run --dry-run --json` | run id、state、dry-run artifact、timeline event | Execution Audit | `PASS`：dry-run 不改变真实执行状态且可解释；`PARTIAL`：有 artifact 但 state/transition 表达不一致；`GAP`：无 artifact 或不可复现 |
| Run until gate | `pnpm agent-loop run --until=gate --json` | state progression、gate 或 worker 创建 | Execution Audit | `PASS`：能推进到明确 gate 或 worker；`PARTIAL`：打开 gate 但不能绑定 work item；`GAP`：无清晰失败证据 |
| Step/resume | 有 existing run 时执行 `step` 或 `resume` | state change、worker attempt、gate decision consumed | Execution Audit | `PASS`：resume/step 行为和 gate 语义一致；`PARTIAL`：CLI 可见但 dashboard 指导不足；`GAP`：需要聊天外判断 |
| Worker | `pnpm agent-loop workers --events --json` | worker type/status/thread id/artifacts | Worker Evidence | `PASS`：worker lifecycle 完整；`PARTIAL`：只有失败摘要；`GAP`：worker 行为不进入 state |
| Artifact | Dashboard Artifact Viewer 或 artifact ids | dry-run plan、worker prompt/jsonl、audit export | Artifact Evidence | `PASS`：artifact 可列出、可只读打开；`PARTIAL`：只能 CLI 看 ID；`GAP`：关键 evidence 不持久化 |
| Gate | `observe`、timeline、Gate Center、Recovery Center | active gate kind/message/details/status | Gate Evidence | `PASS`：active/historical 清楚且可操作；`PARTIAL`：可见但缺决策上下文；`GAP`：gate 只能从 raw log 判断 |

## 3. Dashboard 13-page Audit

| 页面 | 检查动作 | 预期证据 | 记录位置 | 判定标准 |
| --- | --- | --- | --- | --- |
| Mission Control | 检查 current run、next action、autonomy、merge readiness、summary | 能判断当前 run 是否可继续 | Dashboard Audit | `PASS`：页面能指导下一步；`PARTIAL`：状态可见但 work item 不明；`GAP`：核心状态缺失 |
| Plan Navigator | 检查下一项、计划、handoff 线索 | 能解释选择了哪个 issue 或为什么不明确 | Dashboard Audit | `PASS`：work item 可见；`PARTIAL`：只显示 plans；`GAP`：不能表示用户指定 issue |
| Policy Config | 只检查渲染、diff preview、保存按钮状态，不保存 | 配置可读，save 是明确写操作 | Dashboard Audit | `PASS`：只读检查安全；`GAP`：无法区分 preview/save 风险 |
| Dry-run Preview | 检查 planned commands、workflow stages、possible gates、missing conditions | dry-run artifact 和 UI 一致 | Dashboard Audit | `PASS`：能预判下一步；`PARTIAL`：能显示但不绑定当前 issue；`GAP`：空白或误导 |
| Notifications | 检查关注项、mark read 按钮状态 | 无通知时禁用，通知有来源 | Dashboard Audit | `PASS`：状态清楚；`PARTIAL`：通知有但不指向动作；`GAP`：噪音或遗漏 blocker |
| Observability Console | 使用 timeline/worker/gate/artifact 筛选 | 筛选结果能对应 CLI | Dashboard Audit | `PASS`：和 CLI 互相印证；`PARTIAL`：能筛但缺 work item；`GAP`：筛选不可用 |
| Gate Center | 检查 active/historical、raw/original message、intervention panel | active gate 驱动操作，historical 不误导 | Dashboard Audit | `PASS`：gate 可审计；`PARTIAL`：状态清楚但处理入口有限；`GAP`：active/historical 混淆 |
| PR Inbox | PR 前为空或显示无 PR；PR 后看 PR/CI/review | 能判断 PR/CI/review 是否 ready | PR Audit | `PASS`：PR 状态足以决策；`PARTIAL`：需 GitHub 补证据；`GAP`：dashboard 不知道 PR |
| Worker Runs | 检查 lifecycle、events、artifact ids、raw message 折叠 | worker 状态和 artifacts 可追踪 | Worker Evidence | `PASS`：完整；`PARTIAL`：失败可见但修复建议缺失；`GAP`：worker 不出现 |
| Scope Guard | 检查 GitNexus/scope evidence | scope guard 证据和 PR diff 对应 | Scope Audit | `PASS`：能支持 merge readiness；`PARTIAL`：只显示摘要；`GAP`：scope 只能手动判断 |
| Event Ledger | 检查 append-only state/event/decision | stop/recover/gate 等关键决策存在 | Event Evidence | `PASS`：关键行为都有 event；`PARTIAL`：command 可见但 commander 手工行为缺失；`GAP`：行为不进 ledger |
| Artifact Viewer | 打开只读 artifact 列表和代表项 | artifact 可读且不泄露 token | Artifact Evidence | `PASS`：可读、安全；`PARTIAL`：可列不可解释；`GAP`：关键 artifact 缺失 |
| Recovery Center | 检查 historical/stale/handled gate、re-evaluate 可见性 | 历史 gate 不自动消失，写操作明确 | Gate Evidence | `PASS`：恢复链路清楚；`PARTIAL`：可见但需 CLI 决策；`GAP`：无法判断是否应恢复 |

## 4. Button Risk Classification

| 等级 | 包含按钮/动作 | 检查动作 | 记录要求 | 判定标准 |
| --- | --- | --- | --- | --- |
| 只读 | refresh、filter、expand/collapse、artifact read、theme/language toggle | 可以点击代表项 | 记录页面、时间、结果 | `PASS`：不改变 repo/loop 状态；`GAP`：只读动作造成状态变化 |
| 低风险写操作 | mark notification read、historical gate re-evaluate | 仅在有明确样本时点击 | 记录前后 state/event | `PASS`：append-only 或局部状态变化可审计；`GAP`：写操作无 event |
| 高风险写操作 | run、step、resume、recover、stop、approve/reject、save config | 只在 pilot 需要时执行 | 记录原因、命令、结果、run id | `PASS`：动作有 state/event；`PARTIAL`：动作成功但退出码/状态表达不一致；`GAP`：动作绕过审计 |

## 5. Commander Intervention

每次 commander 直接介入使用这个格式：

```text
Time:
Trigger:
Commander action:
Dashboard evidence:
CLI evidence:
Captured by agent-loop: yes/no/partial
Gap owner: none/#45/#46
```

判定：

- `PASS`：介入动作进入 agent-loop event 或 artifact，并能从 dashboard 找到。
- `PARTIAL`：CLI 或 PR comment 有证据，但 dashboard 不完整。
- `GAP`：只能从聊天或本地终端历史知道。

## 6. PR, Review, CI

| 项目 | 检查动作 | 预期证据 | 记录位置 | 判定标准 |
| --- | --- | --- | --- | --- |
| PR body | 检查是否引用 payload issue、audit tracker、run id、dashboard evidence | `Closes #payload`、`Updates #audit`、run id、manual intervention | PR Audit | `PASS`：读 PR 能复盘；`GAP`：只靠聊天 |
| Internal tester/reviewer | 每个 agent report 发 PR issue comment | agent/model、PASS/BLOCK、findings by severity | PR comments | `PASS`：report 可查；`PARTIAL`：owner 代发；`GAP`：无 PR comment |
| External review | UI/runtime 改动时做 AGY/Gemini 或 Claude ACP；docs-only 可记录不需要 | reviewer rationale 或 report comment | PR comments | `PASS`：需要时存在；`PARTIAL`：跳过理由清楚；`GAP`：需要却没做 |
| CI/local checks | `pnpm lint`，runtime 改动再跑 tests；GitNexus detect | check output summary、CI status | PR body/comment | `PASS`：无 blocker；`GAP`：失败被当 follow-up |
| Merge readiness | PR Inbox、GitHub checks、review comments | ready/not ready 原因 | PR Audit | `PASS`：dashboard+GitHub 可判断；`PARTIAL`：主要靠 GitHub；`GAP`：无法判断 |

## 7. Security And Token

| 项目 | 检查动作 | 预期证据 | 记录位置 | 判定标准 |
| --- | --- | --- | --- | --- |
| URL token | 看 dashboard URL | URL 不含 token | Security Audit | `PASS`：无 token；`GAP`：token 出现在 URL |
| Auto-login | 打开 loopback dashboard | 自动进入 dashboard | Security Audit | `PASS`：无需粘贴 token；`PARTIAL`：fallback login 可用；`GAP`：必须手动找 token |
| Cache control | 只读检查 index response header | `cache-control: no-store` | Security Audit | `PASS`：存在；`GAP`：HTML token 可能缓存 |
| Mutation guard | 引用或执行安全的缺 token/bad Origin 测试 | 401/403 仍生效 | Security Audit | `PASS`：guard 不回退；`PARTIAL`：引用近期验证；`GAP`：无证据 |
| Report hygiene | 检查 docs、PR body、comments、screenshots | 不含 token/raw secret/full worker log | Security Audit | `PASS`：只写摘要；`GAP`：泄露敏感内容 |

## 8. Output Matrix

每次 pilot report 必须包含：

| Capability | Status | Evidence | Gap Owner |
| --- | --- | --- | --- |
| Work item selection visible | PASS/PARTIAL/GAP | issue/handoff/dashboard evidence | none/#45/#46 |
| Run lifecycle visible | PASS/PARTIAL/GAP | status/observe/timeline | none/#45 |
| Worker lifecycle visible | PASS/PARTIAL/GAP | Worker Runs/artifacts | none/#45 |
| Gate/recovery auditable | PASS/PARTIAL/GAP | Gate Center/Recovery/Event Ledger | none/#45 |
| Dashboard page coverage | PASS/PARTIAL/GAP | 13-page checklist | none |
| Commander manual actions visible | PASS/PARTIAL/GAP | PR comments/events | #45 |
| External review visible | PASS/PARTIAL/GAP | PR comments/dashboard artifacts | #45 |
| PR/CI/merge readiness visible | PASS/PARTIAL/GAP | PR Inbox/CI/GitHub | #45/#46 |
| Skill/state-machine integration | PASS/PARTIAL/GAP | ability to drive payload through agent-loop | #46 |
| Token/security posture | PASS/PARTIAL/GAP | URL/header/report checks | none |

结论必须回答：

- 今天哪些能力可以信任。
- 哪些能力部分可用。
- 哪些缺口阻碍完整运营采用。
- #45 是否应该作为下一项。
- #46 是否应该等 #45 完成后再做。
