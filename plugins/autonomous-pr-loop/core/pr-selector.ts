import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { AgentLoopError } from "./errors.js";
import { listPullRequests, type GitHubPullRequest } from "./github.js";
import { parsePlanNavigator, type PlanNavigatorModel, type PlanPrItem } from "./plan-parser.js";
import { defaultIssueBranch, type DeliveryWorkItem } from "./delivery-work-item.js";
import type { AgentLoopConfig } from "./types.js";

export type PrSelection =
  | {
      mode: "current_pr";
      ambiguous: false;
      plan: PlanNavigatorModel;
      item: PlanPrItem;
      pr: GitHubPullRequest;
      branchName: string;
      evidence: string[];
    }
  | {
      mode: "next_spec";
      ambiguous: false;
      plan: PlanNavigatorModel;
      item: PlanPrItem;
      branchName: string;
      evidence: string[];
    }
  | {
      mode: "ambiguous";
      ambiguous: true;
      plan: PlanNavigatorModel;
      reason: string;
      candidates: Array<Record<string, unknown>>;
      evidence: string[];
    };

/** Resolve the current or next PR using specs, legacy plans, and GitHub state. */
export function resolvePrSelection(
  repoRoot: string,
  config: AgentLoopConfig,
  options: { pullRequests?: GitHubPullRequest[]; githubRequired?: boolean; workItem?: DeliveryWorkItem } = {}
): PrSelection {
  const plan = parsePlanNavigator(repoRoot, config.plansDir);
  const pullRequests = options.pullRequests ?? safeListPullRequests(repoRoot, config, options.githubRequired ?? false);
  const openPullRequests = pullRequests.filter((pr) => pr.state.toUpperCase() === "OPEN");
  if (options.workItem) {
    return explicitWorkItemSelection(config, plan, openPullRequests, options.workItem);
  }
  if (openPullRequests.length > 1) {
    return ambiguous(plan, "Multiple open pull requests exist.", openPullRequests.map(prCandidate));
  }
  if (openPullRequests.length === 1) {
    const pr = openPullRequests[0] as GitHubPullRequest;
    const item = itemForPullRequest(plan, pr);
    if (!item) {
      return ambiguous(plan, "Open pull request could not be mapped to a PR spec.", [prCandidate(pr)]);
    }
    return {
      mode: "current_pr",
      ambiguous: false,
      plan,
      item,
      pr,
      branchName: pr.headRefName,
      evidence: [`Mapped open PR #${pr.number} (${pr.headRefName}) to ${item.id}.`]
    };
  }
  const nextItem = nextUncompletedItem(plan, pullRequests);
  if (nextItem && !plan.ambiguous) {
    return {
      mode: "next_spec",
      ambiguous: false,
      plan,
      item: nextItem,
      branchName: branchNameForItem(config, nextItem),
      evidence: [
        ...plan.evidence,
        ...mergedEvidence(pullRequests),
        `Selected ${nextItem.id} as the next unresolved spec.`
      ]
    };
  }
  const legacy = legacyNextPr(repoRoot, config);
  if (legacy) {
    return legacy;
  }
  return ambiguous(plan, "Could not uniquely identify the next PR.", plan.candidates.map(itemCandidate));
}

function explicitWorkItemSelection(
  config: AgentLoopConfig,
  plan: PlanNavigatorModel,
  openPullRequests: GitHubPullRequest[],
  workItem: DeliveryWorkItem
): PrSelection {
  const item = itemForWorkItem(workItem);
  const branchName = workItem.branch ?? defaultIssueBranch(workItem.issue, workItem.title, config.branchPrefix);
  const pr = openPullRequests.find((candidate) => candidate.headRefName === branchName);
  if (pr) {
    return {
      mode: "current_pr",
      ambiguous: false,
      plan,
      item,
      pr,
      branchName,
      evidence: [`Bound issue #${workItem.issue} matched open PR #${pr.number} (${branchName}).`]
    };
  }
  const referencedPrs = openPullRequests.filter((candidate) => pullRequestReferencesIssue(candidate, workItem.issue));
  if (referencedPrs.length === 1) {
    const referencedPr = referencedPrs[0]!;
    return {
      mode: "current_pr",
      ambiguous: false,
      plan,
      item,
      pr: referencedPr,
      branchName: referencedPr.headRefName,
      evidence: [`Bound issue #${workItem.issue} matched open PR #${referencedPr.number} by issue reference.`]
    };
  }
  if (referencedPrs.length > 1) {
    return ambiguous(plan, `Multiple open pull requests reference bound issue #${workItem.issue}.`, referencedPrs.map(prCandidate));
  }
  return {
    mode: "next_spec",
    ambiguous: false,
    plan,
    item,
    branchName,
    evidence: [`Bound issue #${workItem.issue} selected as the explicit delivery work item.`]
  };
}

function pullRequestReferencesIssue(pr: GitHubPullRequest, issue: number): boolean {
  const text = `${pr.title ?? ""} ${pr.body ?? ""}`;
  const issuePattern = new RegExp(`(^|[^0-9])#${issue}([^0-9]|$)`);
  const issueSlugPattern = new RegExp(`(^|[^a-z0-9])issue-${issue}([^a-z0-9]|$)`, "i");
  return issuePattern.test(text) || issueSlugPattern.test(pr.headRefName);
}

function itemForWorkItem(workItem: DeliveryWorkItem): PlanPrItem {
  return {
    id: `#${workItem.issue}`,
    title: workItem.title,
    status: "next",
    file: workItem.url,
    dependsOn: [],
    issueRefs: [`#${workItem.issue}`],
    whySelected: "Selected from explicit delivery work item binding."
  };
}

export function branchNameForItem(config: AgentLoopConfig, item: PlanPrItem): string {
  const fileSlug = basename(item.file, ".md");
  const slug = fileSlug.match(/^pr-[a-z0-9]+-/i) ? fileSlug : item.id.toLowerCase().replace(/\s+/g, "-");
  return `${config.branchPrefix}${slugify(slug)}`;
}

function safeListPullRequests(repoRoot: string, config: AgentLoopConfig, required: boolean): GitHubPullRequest[] {
  try {
    return listPullRequests({ repoRoot, config });
  } catch (error) {
    if (error instanceof AgentLoopError) {
      if (required) {
        throw error;
      }
      return [];
    }
    throw error;
  }
}

function itemForPullRequest(plan: PlanNavigatorModel, pr: GitHubPullRequest): PlanPrItem | undefined {
  const id = prIdFromBranch(pr.headRefName);
  if (!id) {
    return undefined;
  }
  return [...plan.completed, ...plan.candidates].find((item) => item.id === id);
}

function nextUncompletedItem(plan: PlanNavigatorModel, pullRequests: GitHubPullRequest[]): PlanPrItem | undefined {
  if (plan.ambiguous) {
    return undefined;
  }
  const completed = new Set([
    ...plan.completed.map((item) => item.id),
    ...pullRequests.flatMap((pr) => mergedPrId(pr) ?? [])
  ]);
  return [...plan.completed, ...plan.candidates].find((item) => !completed.has(item.id));
}

function mergedPrId(pr: GitHubPullRequest): string | undefined {
  if (pr.state.toUpperCase() !== "MERGED" && !pr.mergedAt) {
    return undefined;
  }
  return prIdFromBranch(pr.headRefName);
}

function mergedEvidence(pullRequests: GitHubPullRequest[]): string[] {
  return pullRequests.flatMap((pr) => {
    const id = mergedPrId(pr);
    return id ? [`Observed merged PR #${pr.number} (${pr.headRefName}) as ${id}.`] : [];
  });
}

function prIdFromBranch(branch: string): string | undefined {
  const id = /(?:^|\/)pr-([a-z]+[0-9]*)-/i.exec(branch)?.[1]?.toUpperCase();
  return id ? `PR ${id}` : undefined;
}

function legacyNextPr(repoRoot: string, config: AgentLoopConfig): PrSelection | undefined {
  const path = join(repoRoot, config.plansDir);
  if (!existsSync(path)) {
    return undefined;
  }
  const files = readdirSync(path).filter((name) => /^next-pr.*\.md$/i.test(name));
  if (files.length !== 1) {
    return undefined;
  }
  const file = join(path, files[0] as string);
  const id = /next-pr-([a-z0-9]+)/i.exec(files[0] as string)?.[1]?.toUpperCase() ?? "NEXT";
  const item: PlanPrItem = {
    id: `PR ${id}`,
    title: `PR ${id}`,
    status: "next",
    file,
    dependsOn: [],
    issueRefs: [],
    whySelected: "Selected from legacy next-pr plan file."
  };
  return {
    mode: "next_spec",
    ambiguous: false,
    plan: {
      convention: "Legacy PR docs use next-pr*.md files in the configured plans directory.",
      currentMilestone: item.id,
      selectedNext: item,
      completed: [],
      candidates: [item],
      ambiguous: false,
      evidence: [`Selected ${files[0]} from ${config.plansDir}.`]
    },
    item,
    branchName: `${config.branchPrefix}${slugify(basename(files[0] as string, ".md"))}`,
    evidence: [`Selected ${files[0]} from ${config.plansDir}.`]
  };
}

function ambiguous(
  plan: PlanNavigatorModel,
  reason: string,
  candidates: Array<Record<string, unknown>>
): PrSelection {
  return {
    mode: "ambiguous",
    ambiguous: true,
    plan,
    reason,
    candidates,
    evidence: [...plan.evidence, reason]
  };
}

function prCandidate(pr: GitHubPullRequest): Record<string, unknown> {
  return {
    number: pr.number,
    headRefName: pr.headRefName,
    state: pr.state,
    url: pr.url
  };
}

function itemCandidate(item: PlanPrItem): Record<string, unknown> {
  return {
    id: item.id,
    status: item.status,
    file: item.file
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "next-pr";
}
