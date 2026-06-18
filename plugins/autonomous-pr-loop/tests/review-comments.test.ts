import { describe, expect, it } from "vitest";
import { actionableReviewComments, parseReviewThreads } from "../core/review-comments.js";

describe("review comments", () => {
  it("parses actionable unresolved review threads", () => {
    const comments = parseReviewThreads({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{
              isResolved: false,
              isOutdated: false,
              comments: {
                nodes: [{
                  id: "c1",
                  url: "https://github.test/comment",
                  author: { login: "reviewer" },
                  body: "Please fix",
                  path: "src/file.ts",
                  line: 10,
                  diffHunk: "@@"
                }]
              }
            }]
          }
        }
      }
    });

    expect(comments[0]).toMatchObject({
      commentId: "c1",
      author: "reviewer",
      actionable: true,
      status: "open"
    });
    expect(actionableReviewComments(comments)).toHaveLength(1);
  });

  it("does not route resolved or outdated comments to fix", () => {
    const comments = parseReviewThreads({
      reviewThreads: {
        nodes: [
          {
            isResolved: true,
            isOutdated: false,
            comments: { nodes: [{ id: "resolved", body: "done" }] }
          },
          {
            isResolved: false,
            isOutdated: true,
            comments: { nodes: [{ id: "stale", body: "old" }] }
          }
        ]
      }
    });

    expect(actionableReviewComments(comments)).toEqual([]);
    expect(comments.map((comment) => comment.status)).toEqual(["handled", "stale"]);
  });
});
