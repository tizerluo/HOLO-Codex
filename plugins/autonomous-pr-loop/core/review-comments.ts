import type { AgentLoopReviewComment } from "./types.js";
import { isRecord } from "./config.js";

export type ReviewCommentInput = Omit<
  AgentLoopReviewComment,
  "id" | "runId" | "prNumber" | "observedAt"
>;

/** Parse GraphQL reviewThreads into normalized actionable review comments. */
export function parseReviewThreads(payload: unknown): ReviewCommentInput[] {
  const threads = findNodes(payload, "reviewThreads");
  return threads.flatMap(parseThread);
}

/** Return only comments that PR C should route to review-fix handling. */
export function actionableReviewComments(comments: ReviewCommentInput[]): ReviewCommentInput[] {
  return comments.filter((comment) => comment.actionable && comment.status === "open");
}

function parseThread(thread: unknown): ReviewCommentInput[] {
  if (!isRecord(thread)) {
    return [];
  }
  const isResolved = Boolean(thread.isResolved);
  const isOutdated = Boolean(thread.isOutdated);
  return findNodes(thread, "comments").map((comment) => normalizeComment(comment, isResolved, isOutdated));
}

function normalizeComment(comment: unknown, isResolved: boolean, isOutdated: boolean): ReviewCommentInput {
  const row = isRecord(comment) ? comment : {};
  const actionable = !isResolved && !isOutdated && stringValue(row.body).trim().length > 0;
  const line = numberValue(row.line);
  const normalized: ReviewCommentInput = {
    commentId: stringValue(row.id),
    url: stringValue(row.url),
    author: authorLogin(row.author),
    body: stringValue(row.body),
    path: stringValue(row.path),
    diffHunk: stringValue(row.diffHunk),
    isResolved,
    isOutdated,
    actionable,
    status: actionable ? "open" : isOutdated ? "stale" : "handled"
  };
  if (line !== undefined) {
    normalized.line = line;
  }
  return normalized;
}

function findNodes(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) {
    return [];
  }
  const direct = value[key];
  if (isRecord(direct) && Array.isArray(direct.nodes)) {
    return direct.nodes;
  }
  const repository = value.repository;
  const pullRequest = isRecord(repository) ? repository.pullRequest : undefined;
  if (isRecord(pullRequest)) {
    return findNodes(pullRequest, key);
  }
  return [];
}

function authorLogin(value: unknown): string {
  return isRecord(value) ? stringValue(value.login) : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
