import { describe, expect, it } from "vitest";
import type { RunForgeRequestDetailsResult } from "@buildwarden/shared";
import { buildRunForgeAgentPrompt, runForgeReadinessLabel } from "./run-forge-ui";
import { forgeRequestActionAvailability } from "./forge-request-actions";

const details = {
  summary: {
    provider: "github",
    number: 142,
    title: "Improve checks",
    url: "https://github.com/acme/repo/pull/142",
    state: "open",
    readiness: "blocked",
    draft: false,
    mergeability: "conflicting",
    reviewDecision: "changes-requested",
    author: "author",
    sourceBranch: "feat/checks",
    targetBranch: "main",
    headSha: "abc",
    checks: { completed: 2, total: 2, successful: 1, failed: 1, running: 0 },
    unresolvedThreadCount: 1,
    supportedActions: ["refresh", "open", "close"],
    supportedMergeMethods: ["squash"],
    updatedAt: null,
    lastSyncedAt: "2026-08-08T00:00:00Z",
    stale: false,
    syncError: null,
  },
  request: { provider: "github", number: 142, title: "Improve checks", url: "https://github.com/acme/repo/pull/142", state: "open", draft: false, author: "author", sourceBranch: "feat/checks", targetBranch: "main", createdAt: null, updatedAt: null, description: "", authorUser: null, labels: [], additions: 1, deletions: 1, changedFiles: 1, commentCount: 1, reviewCommentCount: 1 },
  activity: [],
  commits: [],
  files: [],
  reviewThreads: [{ id: "thread", providerThreadId: "thread", replyToCommentId: "1", provider: "github", path: "src/app.ts", oldPath: null, side: "new", oldLineNumber: null, newLineNumber: 17, commitSha: "abc", diffHunk: null, resolved: false, comments: [{ id: "comment", providerCommentId: "1", body: "Handle the empty state", author: { username: "reviewer", name: null, avatarUrl: null, webUrl: null }, createdAt: null, updatedAt: null, url: null }] }],
  checks: [{ id: "check", name: "unit tests", status: "failure", url: "https://ci.test/1", description: null, startedAt: null, completedAt: null, durationMs: null }],
  warnings: [],
} satisfies RunForgeRequestDetailsResult;

describe("run forge UI model", () => {
  it("builds editable prompts with exact feedback and check context", () => {
    expect(buildRunForgeAgentPrompt("feedback", details)).toContain("src/app.ts:17");
    expect(buildRunForgeAgentPrompt("feedback", details)).toContain("reviewer: Handle the empty state");
    expect(buildRunForgeAgentPrompt("checks", details)).toContain("unit tests: https://ci.test/1");
    expect(buildRunForgeAgentPrompt("conflicts", details)).toContain("feat/checks\nBase branch: main");
  });

  it("keeps terminal and unavailable states distinct", () => {
    expect(runForgeReadinessLabel.merged).toBe("Merged");
    expect(runForgeReadinessLabel.unavailable).toBe("Unavailable");
  });

  it("shares the same safe action visibility between run and project request surfaces", () => {
    expect(forgeRequestActionAvailability(details.summary, true)).toMatchObject({
      canToggleDraft: false,
      canMerge: false,
      canClose: true,
      canReopen: false,
    });
    expect(forgeRequestActionAvailability({
      ...details.summary,
      readiness: "ready",
      supportedActions: ["mark-draft", "merge", "close"],
    }, true)).toMatchObject({ canToggleDraft: true, canMerge: true, canClose: true });
    expect(forgeRequestActionAvailability({
      ...details.summary,
      state: "closed",
      readiness: "closed",
      supportedActions: ["reopen"],
    }, true)).toMatchObject({ canMerge: false, canClose: false, canReopen: true });
  });
});
