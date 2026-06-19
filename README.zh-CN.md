# HOLO-Codex

[English README](./README.md)

![HOLO-Codex README hero](./assets/brand/holo-codex-readme-hero.png)

HOLO-Codex 是 **Human On Loop Codex** 的缩写，它把长流程 Codex workflow 变成可观察、可恢复、可人工接管的 loop。人设定目标和边界、观察进展，并只在真实 gate 需要关注时回到环上。

Supervisor 负责持久化 workflow 状态、evidence、gates、worker 编排、Codex hooks、MCP control plane 和本地 dashboard。Worker 只做受控任务并返回结构化输出。

## 提供能力

- `plugins/autonomous-pr-loop/` 下的 Codex 插件。
- `agent-loop` CLI：管理本地 loop 状态、hooks、dashboard、workflow evidence 和可回滚本地安装。
- `.agent-loop/` 下的本地 SQLite 状态。
- 本地 dashboard：Mission Control、workflow board、Observability Console、Gate、Review/CI、Worker、Artifact、Notifications、Recovery、Policy Config、主题模式。
- stdio MCP control plane。
- 用于 policy 检查和 observability 的 Codex hooks。
- TypeScript + Vitest 测试套件。
- `zh-CN`、`en-US`、`system` 双语显示支持。
- workflow profile、role profile、`generic-loop`，以及第一个内置 workflow：`pr-loop`。

这不是托管服务，不提供 GitHub webhook daemon 或云端 worker。

## 兼容名称

HOLO-Codex 是公开产品名。一些稳定运行时标识会继续保留旧名称，以避免破坏已有安装和本地状态：

- CLI 命令：`agent-loop`
- 运行态目录：`.agent-loop/`
- Plugin id 和 MCP server id：`autonomous-pr-loop`
- 源码目录：`plugins/autonomous-pr-loop/`
- npm package 名：`holo-codex`
- 本地 marketplace 条目名：`codex-auto-pr-loop`

这些是兼容标识，不是第二个产品名。

## 第一个工作流：PR 交付

PR 交付是 HOLO-Codex 随附的第一个完整 workflow，也是 loop 模型最强的样板，但不是产品边界。

典型流程：

```text
sync main
bind work item
plan
build
verify
open PR
run review / CI
fix findings
check merge readiness
merge
cleanup
```

Dashboard 和 MCP tools 读取持久化 loop 状态，不依赖聊天历史。

同一套 control plane 也可以承载其他长流程 Codex workflow，例如 release 准备、仓库卫生审计、安全审查、文档发布、迁移、评测和客户 issue 分诊。

## 安装

公开源码入口：

```text
https://github.com/tizerluo/HOLO-Codex
```

依赖：

- Node.js `>=22.5`
- `git`
- GitHub CLI `gh`
- Codex CLI / plugin support
- 从源码安装或使用 snapshot/rollback local install 时需要 `pnpm`
- 可选但推荐：GitNexus，使用 `npx gitnexus`

从 npm 安装：

```bash
npm install --global holo-codex
# 将 /path/to/repo 替换成你要让 HOLO-Codex 监督的目标仓库。
agent-loop --repo /path/to/repo init
agent-loop install-hooks --repo /path/to/repo
agent-loop --repo /path/to/repo doctor
```

npm package 会安装 `agent-loop` CLI。`agent-loop install-hooks` 会安装或刷新 hook router 和目标仓库绑定，不会重新安装全局 CLI。移除 npm 安装时，先运行 `agent-loop hooks unbind --repo /path/to/repo`；确认没有任何目标仓库还在使用 HOLO-Codex router 后，再从 `~/.codex/hooks.json` 手动移除 HOLO-Codex router entries，最后运行 `npm uninstall --global holo-codex`。

开发 HOLO-Codex 或需要直接检查源码 checkout 时，从源码安装：

```bash
git clone https://github.com/tizerluo/HOLO-Codex.git
cd HOLO-Codex
pnpm install
pnpm build:hooks
# 将 /path/to/repo 替换成你要让 HOLO-Codex 监督的目标仓库。
pnpm agent-loop local install --repo /path/to/repo
agent-loop --repo /path/to/repo status
```

`pnpm agent-loop ...` 是源码 checkout 内的命令。`agent-loop ...` 是 npm 或本地源码安装后从任意目录日常使用的全局命令。用 `agent-loop local snapshots prune --keep 10` 预览旧 snapshot 清理；确认要删除时再加 `--apply`。

完整的本地安装、升级、重装、卸载和 smoke test 清单见：[Local Release Readiness](./docs/local-release-readiness.md)。

把 HOLO-Codex 加入本地 Codex plugin marketplace。npm 安装时：

```bash
codex plugin marketplace add "$(npm root -g)/holo-codex"
```

源码安装时：

```bash
codex plugin marketplace add /path/to/HOLO-Codex
```

然后在 Codex 中启用 `autonomous-pr-loop` 插件。Codex plugin 启用和全局 CLI 安装是两件事。

## 初始化状态

在目标仓库根目录执行：

```bash
agent-loop --repo /path/to/repo init
agent-loop --repo /path/to/repo doctor
agent-loop --repo /path/to/repo status
```

安装 Codex hooks：

```bash
agent-loop install-hooks --repo /path/to/repo
```

这会向 `~/.codex/hooks.json` 安装一组稳定 hook router，保留已有用户 hooks，并在 `~/.codex/agent-loop/hook-bindings.json` 记录目标仓库绑定。

多仓库注意：多个仓库可以共用同一个 `CODEX_HOME`；hook event 会先按 Codex cwd/worktree/session context 路由，再写入仓库状态或执行 policy。独立 `CODEX_HOME` 仍适合高隔离 sandbox 测试。

运行态文件写入 `.agent-loop/`，不要提交。

## Dashboard

```bash
agent-loop --repo /path/to/repo dashboard
```

命令会在 stdout 打印 loopback URL，并在 stderr 单独打印 fallback session token：

```text
dashboard 已启动
url: http://127.0.0.1:<port>/
targetRepoRoot: /path/to/repo
```

Dashboard mutation 必须带本地 session token，并统一走 controller。UI 不直接写 SQLite。本地 loopback dashboard 会用同源 session bootstrap 自动解锁。stderr token 只作为静态 UI 或恢复场景的 fallback；不要把它复制到 docs、日志、PR body、commit、artifact 或截图里。

Dashboard 能看到的交付工作来自持久化的 `agent-loop` 动作和 workflow evidence。直接在终端改文件或 commander 决策不会自动出现在 dashboard，除非它们被记录成 agent-loop event、artifact 或 PR comment。当前自维护流程见：[自举维护流程](./docs/self-bootstrap.md)。端到端审计模板见：[Agent-loop-first Delivery Audit Checklist](./docs/checklists/agent-loop-first-delivery-audit.md)。

## 常用 CLI

```bash
agent-loop --repo /path/to/repo status
agent-loop --repo /path/to/repo init --dry-run
agent-loop --repo /path/to/repo doctor
agent-loop --repo /path/to/repo run --dry-run
agent-loop --repo /path/to/repo run --until=gate
agent-loop --repo /path/to/repo step
agent-loop --repo /path/to/repo resume
agent-loop --repo /path/to/repo stop
agent-loop --repo /path/to/repo timeline --limit 20
agent-loop --repo /path/to/repo workers --events
agent-loop --repo /path/to/repo observe
agent-loop --repo /path/to/repo audit-export --run RUN_ID --format markdown
agent-loop --repo /path/to/repo recover
agent-loop --repo /path/to/repo approve-gate <gate-id> --note "reason"
agent-loop --repo /path/to/repo dashboard
```

人类可读 CLI 输出支持 `--locale zh-CN|en-US|system`。JSON 输出保持结构化和稳定。

## Workflow Profiles 和主题

默认 workflow 仍是 `pr-loop`，使用 `default_pr_loop` 和 `default_pr_roles`。Policy Config 也可以选择 `generic-loop`，并使用内置的调研报告、文档准备、仓库卫生审计、周报、数据抽取 workflow profiles。具体非 PR 工作流可参考：[generic-loop 仓库卫生审计示例](./docs/examples/generic-loop-repo-hygiene.md)。

Dashboard 主题是浏览器本地显示偏好，支持 `light`、`dark`、`system`，不会写入 repo config 或 SQLite。

## 安全边界

- Worker 可以改文件，但不能 commit、push、create PR、mark PR ready 或 merge。
- Supervisor 负责 Git 和 GitHub 生命周期。
- 破坏性 Git/GitHub 命令由 command policy 和 hooks 阻止。
- Merge readiness 由 config、review/CI evidence、open review comments、scope guard 和 policy decisions 共同决定。
- 不要把密钥写入代码、文档、日志、artifacts、commit 或 PR body。
- Hooks 只覆盖 Codex tool loop，不拦截外部 Terminal 手动命令。

## 开发

```bash
pnpm test
pnpm lint
```

更多文档：

- [安装](./docs/install.md)
- [Local Release Readiness](./docs/local-release-readiness.md)
- [Source Release Checklist](./docs/release-checklist.md)
- [自举维护流程](./docs/self-bootstrap.md)
- [Agent-loop-first Delivery Audit Checklist](./docs/checklists/agent-loop-first-delivery-audit.md)
- [generic-loop 仓库卫生审计示例](./docs/examples/generic-loop-repo-hygiene.md)
- [信任与安全](./docs/trust-and-safety.md)
- [贡献指南](./CONTRIBUTING.md)
- [安全政策](./SECURITY.md)
