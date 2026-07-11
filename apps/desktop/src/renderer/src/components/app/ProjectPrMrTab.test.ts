import { describe, expect, it } from "vitest";
import type { ProjectForgeRequestDetailsResult } from "@buildwarden/shared";
import {
  buildPrMrFileNavItems,
  buildRemoteDiffComments,
  buildReviewThreadCodeLines,
  normalizeRequestDetailTab,
  type DraftDiffComment,
} from "./project-pr-mr-review-helpers";
import type { DiffPreviewFileSummary } from "./git-diff-preview";

const baseDetails = (): ProjectForgeRequestDetailsResult => ({
  provider: "github",
  webBaseUrl: "https://github.com/invetalcom/stockgenius",
  repoLabel: "invetalcom/stockgenius",
  request: {
    provider: "github",
    number: 11,
    title: "WorkOS integration",
    url: "https://github.com/invetalcom/stockgenius/pull/11",
    state: "open",
    draft: false,
    author: "invetalcom",
    sourceBranch: "feature/workos",
    targetBranch: "main",
    createdAt: "2026-05-26T12:00:00Z",
    updatedAt: "2026-05-26T13:00:00Z",
    description: "Adds SSO.",
    authorUser: null,
    labels: [],
    additions: 2,
    deletions: 1,
    changedFiles: 1,
    commentCount: 1,
    reviewCommentCount: 1,
  },
  activity: [],
  commits: [],
  files: [],
  reviewThreads: [],
  warnings: [],
});

describe("ProjectPrMrTab review helpers", () => {
  it("defaults restored tab state to Conversation", () => {
    expect(normalizeRequestDetailTab(undefined)).toBe("conversation");
    expect(normalizeRequestDetailTab("overview")).toBe("conversation");
    expect(normalizeRequestDetailTab("changes")).toBe("files");
  });

  it("maps remote review threads into inline diff comments", () => {
    const details = baseDetails();
    details.reviewThreads = [
      {
        id: "thread-1",
        providerThreadId: "thread-1",
        replyToCommentId: "1",
        provider: "github",
        path: "Backend/src/WorkOSConfig.java",
        oldPath: "Backend/src/WorkOSConfig.java",
        side: "new",
        oldLineNumber: null,
        newLineNumber: 13,
        commitSha: "abcdef",
        diffHunk: "@@ -10,6 +10,6 @@\n context\n+Manual Test",
        resolved: true,
        comments: [
          {
            id: "comment-1",
            providerCommentId: "1",
            body: "Manual Test",
            author: { username: "reviewer", name: null, avatarUrl: null, webUrl: null },
            createdAt: "2026-05-26T14:00:00Z",
            updatedAt: null,
            url: null,
          },
        ],
      },
    ];

    expect(buildRemoteDiffComments(details)).toMatchObject([
      {
        id: "comment-1",
        newPath: "Backend/src/WorkOSConfig.java",
        side: "new",
        newLineNumber: 13,
        lineLabel: "Backend/src/WorkOSConfig.java:13 new",
        author: "reviewer",
        resolved: true,
        remote: true,
      },
    ]);
  });

  it("falls back to diff-comment timeline rows when thread data is absent", () => {
    const details = baseDetails();
    details.activity = [
      {
        id: "activity-1",
        provider: "gitlab",
        kind: "diff-comment",
        title: "commented on the diff",
        body: "Looks suspicious.",
        state: null,
        path: "Frontend/src/auth.ts",
        line: 170,
        url: null,
        createdAt: "2026-05-26T14:00:00Z",
        updatedAt: null,
        author: { username: "reviewer", name: null, avatarUrl: null, webUrl: null },
      },
    ];

    expect(buildRemoteDiffComments(details)).toMatchObject([
      {
        id: "activity-1",
        newPath: "Frontend/src/auth.ts",
        newLineNumber: 170,
        body: "Looks suspicious.",
      },
    ]);
  });

  it("combines provider files, parsed diff files, remote comment badges, and draft badges", () => {
    const details = baseDetails();
    details.files = [
      {
        path: "Backend/src/WorkOSConfig.java",
        oldPath: null,
        status: "modified",
        additions: null,
        deletions: null,
        patchAvailable: true,
        commentCount: 1,
      },
    ];
    details.reviewThreads = [
      {
        id: "thread-1",
        providerThreadId: "thread-1",
        replyToCommentId: null,
        provider: "gitlab",
        path: "Backend/src/WorkOSConfig.java",
        oldPath: "Backend/src/WorkOSConfig.java",
        side: "new",
        oldLineNumber: null,
        newLineNumber: 13,
        commitSha: "head",
        diffHunk: null,
        resolved: false,
        comments: [
          { id: "comment-1", providerCommentId: "1", body: "Manual Test", author: null, createdAt: null, updatedAt: null, url: null },
          { id: "comment-2", providerCommentId: "2", body: "Second", author: null, createdAt: null, updatedAt: null, url: null },
        ],
      },
    ];
    const parsedFiles: DiffPreviewFileSummary[] = [
      {
        key: "parsed-1",
        path: "Backend/src/WorkOSConfig.java",
        oldPath: null,
        type: "modify",
        additions: 4,
        deletions: 2,
      },
    ];
    const drafts: DraftDiffComment[] = [
      {
        id: "draft-1",
        oldPath: "Backend/src/WorkOSConfig.java",
        newPath: "Backend/src/WorkOSConfig.java",
        side: "new",
        oldLineNumber: null,
        newLineNumber: 13,
        changeType: "insert",
        body: "Drafted note",
        displayPath: "Backend/src/WorkOSConfig.java",
        lineLabel: "Backend/src/WorkOSConfig.java:13 new",
      },
    ];

    expect(buildPrMrFileNavItems(details, parsedFiles, drafts)).toMatchObject([
      {
        path: "Backend/src/WorkOSConfig.java",
        additions: 4,
        deletions: 2,
        commentCount: 2,
        draftCount: 1,
      },
    ]);
  });

  it("limits commit-scoped file navigation to files present in the parsed commit diff", () => {
    const details = baseDetails();
    details.files = [
      { path: "src/first.ts", oldPath: null, status: "modified", additions: 4, deletions: 1, patchAvailable: true, commentCount: 0 },
      { path: "src/second.ts", oldPath: null, status: "modified", additions: 2, deletions: 2, patchAvailable: true, commentCount: 1 },
    ];
    const parsedFiles: DiffPreviewFileSummary[] = [
      { key: "parsed-second", path: "src/second.ts", oldPath: null, type: "modify", additions: 1, deletions: 1 },
    ];

    expect(buildPrMrFileNavItems(details, parsedFiles, [], { restrictToParsedDiff: true })).toMatchObject([
      { path: "src/second.ts", additions: 1, deletions: 1 },
    ]);
  });

  it("builds compact code context for a review thread from the loaded diff", () => {
    const details = baseDetails();
    const thread = {
      id: "thread-1",
      providerThreadId: "thread-1",
      replyToCommentId: null,
      provider: "gitlab" as const,
      path: "src/auth.ts",
      oldPath: "src/auth.ts",
      side: "new" as const,
      oldLineNumber: null,
      newLineNumber: 12,
      commitSha: "head",
      diffHunk: null,
      resolved: false,
      comments: [{ id: "comment-1", providerCommentId: "1", body: "Use verified email.", author: null, createdAt: null, updatedAt: null, url: null }],
    };
    details.reviewThreads = [thread];
    const diff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -10,5 +10,5 @@",
      " const account = findAccount(email);",
      " const profile = account.profile;",
      "-linkAccount(account);",
      "+linkVerifiedAccount(account);",
      " return account;",
    ].join("\n");

    const lines = buildReviewThreadCodeLines(thread, diff);

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "add", newLineNumber: 12, content: "linkVerifiedAccount(account);", highlighted: true }),
      ]),
    );
  });

  it("keeps blank hunk context lines while ignoring EOF metadata", () => {
    const thread = {
      id: "thread-blank-line",
      providerThreadId: "thread-blank-line",
      replyToCommentId: null,
      provider: "github" as const,
      path: "src/auth.ts",
      oldPath: "src/auth.ts",
      side: "new" as const,
      oldLineNumber: null,
      newLineNumber: 12,
      commitSha: "head",
      diffHunk: [
        "@@ -10,4 +10,4 @@",
        " const account = findAccount(email);",
        " ",
        "\\ No newline at end of file",
        "+linkVerifiedAccount(account);",
        " return account;",
      ].join("\n"),
      resolved: false,
      comments: [{ id: "comment-1", providerCommentId: "1", body: "Use verified email.", author: null, createdAt: null, updatedAt: null, url: null }],
    };

    const lines = buildReviewThreadCodeLines(thread, "", 5);

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "context", oldLineNumber: 11, newLineNumber: 11, content: "" }),
        expect.objectContaining({ type: "add", newLineNumber: 12, content: "linkVerifiedAccount(account);", highlighted: true }),
      ]),
    );
    expect(lines.some((line) => line.content.startsWith("\\ No newline"))).toBe(false);
  });
});
