import {
  DEFAULT_LOCALE,
  normalizeLocaleSetting,
  processLocaleCandidates,
  resolveEffectiveLocale,
  type EffectiveLocale,
  type LocaleSetting
} from "./locale.js";

type CliTextKey =
  | "approvedGate"
  | "baseBranch"
  | "config"
  | "currentBranch"
  | "dashboardHelp"
  | "dashboardStarted"
  | "doctor"
  | "gate"
  | "hooks"
  | "hooksInstalled"
  | "initDone"
  | "initDryRun"
  | "kind"
  | "note"
  | "plansDir"
  | "recovered"
  | "repoId"
  | "runId"
  | "state"
  | "status"
  | "storage"
  | "url";

const CLI_TEXT: Record<EffectiveLocale, Record<CliTextKey, string>> = {
  "en-US": {
    approvedGate: "gate approved",
    baseBranch: "baseBranch",
    config: "config",
    currentBranch: "currentBranch",
    dashboardHelp: "Starts the local HOLO-Codex dashboard.",
    dashboardStarted: "dashboard started",
    doctor: "doctor",
    gate: "gate",
    hooks: "hooks",
    hooksInstalled: "hooks installed",
    initDone: "init: .agent-loop initialized",
    initDryRun: "init dry-run: no files written",
    kind: "kind",
    note: "note",
    plansDir: "plansDir",
    recovered: "recovered",
    repoId: "repoId",
    runId: "runId",
    state: "state",
    status: "status",
    storage: "storage",
    url: "url"
  },
  "zh-CN": {
    approvedGate: "gate 已批准",
    baseBranch: "基础分支",
    config: "配置",
    currentBranch: "当前分支",
    dashboardHelp: "启动本地 HOLO-Codex dashboard。",
    dashboardStarted: "dashboard 已启动",
    doctor: "诊断",
    gate: "gate",
    hooks: "hooks",
    hooksInstalled: "hooks 已安装",
    initDone: "init: .agent-loop 已初始化",
    initDryRun: "init dry-run: 未写入文件",
    kind: "类型",
    note: "备注",
    plansDir: "计划目录",
    recovered: "已恢复",
    repoId: "repoId",
    runId: "runId",
    state: "状态",
    status: "状态",
    storage: "存储",
    url: "url"
  }
};

/** Resolve CLI locale from an optional override and repository config setting. */
export function resolveCliLocale(
  override: LocaleSetting | undefined,
  configLocale: LocaleSetting | undefined
): EffectiveLocale {
  return resolveEffectiveLocale(override ?? configLocale ?? DEFAULT_LOCALE, processLocaleCandidates());
}

/** Parse and validate a `--locale` option from raw CLI args. */
export function parseLocaleOverride(args: string[]): LocaleSetting | undefined {
  const value = optionValue(args, "--locale");
  if (value === undefined) {
    return undefined;
  }
  return normalizeLocaleSetting(value);
}

/** Remove locale option tokens before command-specific parsing. */
export function stripLocaleArgs(args: string[]): string[] {
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--locale") {
      index += 1;
      continue;
    }
    next.push(args[index]!);
  }
  return next;
}

/** Return display text for CLI human output. */
export function cliText(locale: EffectiveLocale, key: CliTextKey): string {
  return CLI_TEXT[locale][key];
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
