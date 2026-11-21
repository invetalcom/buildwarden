import { describe, expect, it } from "vitest";
import {
  DEFAULT_PR_WATCH_OPTIONS,
  PR_WATCH_REPLY_MARKER,
  buildPrWatchPrompt,
  formatPrWatchReply,
  parseProjectPrWatchInstructionsSetting,
  parsePrWatchReport,
  prWatchChecksKey,
  prWatchCommentKey,
  prWatchConflictKey,
  scanPrWatchTriggers,
  type ProjectForgeActivityItem,
  type ProjectForgeReviewThread,
  type RunForgeCheck,
  type RunForgeRequestSummary,
} from "@buildwarden/shared";
import { tailCheckLog } from "./pr-review/pr-review-utils";

const HEAD = "a".repeat(40);

const prWatchSummary = (overrides: Partial<RunForgeRequestSummary> = {}): RunForgeRequestSummary => ({
  provider: "github",
  number: 12,
  title: "Redesign cards",
  url: "https://github.com/acme/app/pull/12",
  state: "open",
  readiness: "blocked",
  draft: false,
  mergeability: "mergeable",
  reviewDecision: "none",
  author: "dev",
  sourceBranch: "feat/cards",
  sourceRepository: "acme/app",
  targetBranch: "main",
  headSha: HEAD,
  checks: { completed: 2, total: 2, successful: 1, failed: 1, running: 0 },
  unresolvedThreadCount: 0,
  supportedActions: ["refresh", "open"],
  supportedMergeMethods: ["merge"],
  updatedAt: null,
  lastSyncedAt: "2026-11-21T10:00:00.000Z",
  stale: false,
  syncError: null,
  ...overrides,
});

const prWatchCheck = (name: string, status: RunForgeCheck["status"]): RunForgeCheck => ({
  id: name, name, status, url: `https://github.com/acme/app/actions/runs/1/job/${name.length}`, description: null, startedAt: null, completedAt: null, durationMs: null,
});

const prWatchThread = (id: string, comments: Array<{ id: string; body: string; author?: string }>, resolved: boolean | null = false): ProjectForgeReviewThread => ({
  id, providerThreadId: id, replyToCommentId: `${id}-root`, provider: "github", path: "src/card.ts", oldPath: null, side: "new",
  oldLineNumber: null, newLineNumber: 7, commitSha: null, diffHunk: null, resolved,
  comments: comments.map((comment) => ({
    id: comment.id, providerCommentId: comment.id, body: comment.body, author: { username: comment.author ?? "reviewer", name: null, avatarUrl: null, webUrl: null },
    createdAt: null, updatedAt: null, url: null,
  })),
});

const prWatchComment = (id: string, body: string, kind: ProjectForgeActivityItem["kind"] = "comment"): ProjectForgeActivityItem => ({
  id, provider: "github", kind, title: "comment", body, state: null, path: null, line: null, url: null, createdAt: null, updatedAt: null,
  author: { username: "copilot[bot]", name: null, avatarUrl: null, webUrl: null },
});

const scan = (input: Partial<Parameters<typeof scanPrWatchTriggers>[0]>) => scanPrWatchTriggers({
  options: DEFAULT_PR_WATCH_OPTIONS,
  summary: prWatchSummary(),
  checks: [],
  reviewThreads: [],
  activity: [],
  handled: new Set(),
  ...input,
});

describe("scanPrWatchTriggers", () => {
  it("wakes for failed checks only once every check of the commit finished", () => {
    expect(scan({ checks: [prWatchCheck("lint", "failure"), prWatchCheck("test", "running")] }).triggers).toEqual([]);
    const settled = scan({ checks: [prWatchCheck("lint", "failure"), prWatchCheck("test", "success")] });
    expect(settled.triggers).toEqual(["checks"]);
    expect(settled.failedChecks.map((check) => check.name)).toEqual(["lint"]);
    expect(settled.handledKeys).toContain(prWatchChecksKey(HEAD));
  });

  it("does not wake twice for the same commit's failures or conflicts", () => {
    const handled = new Set([prWatchChecksKey(HEAD), prWatchConflictKey(HEAD)]);
    expect(scan({
      summary: prWatchSummary({ mergeability: "conflicting" }),
      checks: [prWatchCheck("lint", "failure")],
      handled,
    }).triggers).toEqual([]);
    expect(scan({ summary: prWatchSummary({ mergeability: "conflicting" }) }).triggers).toEqual(["conflicts"]);
  });

  it("collects new comments from unresolved threads and the conversation, skipping its own replies", () => {
    const result = scan({
      reviewThreads: [
        prWatchThread("t1", [{ id: "c1", body: "Null here?" }, { id: "c2", body: `Fixed.\n\n${PR_WATCH_REPLY_MARKER}`, author: "dev" }]),
        prWatchThread("t2", [{ id: "c3", body: "Old point" }], true),
      ],
      activity: [
        prWatchComment("a1", "Please also rename the prop."),
        prWatchComment("a2", "", "review"),
        prWatchComment("a3", "Diff comment", "diff-comment"),
        prWatchComment("a4", `Thanks!\n${PR_WATCH_REPLY_MARKER}`),
      ],
    });
    expect(result.triggers).toEqual(["feedback"]);
    expect(result.feedback.map((source) => source.ref)).toEqual(["T1", "C1"]);
    expect(result.feedback[0]!.item).toMatchObject({ kind: "thread", threadId: "t1", replyToCommentId: "t1-root", commentIds: ["c1"], path: "src/card.ts", line: 7 });
    // The watch's own reply stays out of the comments the agent is asked to judge.
    expect(result.feedback[0]!.comments.map((comment) => comment.body)).toEqual(["Null here?"]);
    expect(result.feedback[1]!.item).toMatchObject({ kind: "conversation", commentIds: ["a1"], author: "copilot[bot]" });
    expect(result.handledKeys).toEqual([prWatchCommentKey("c1"), prWatchCommentKey("a1")]);
  });

  it("brings a thread back when the reviewer answers, with earlier comments as context", () => {
    const result = scan({
      reviewThreads: [prWatchThread("t1", [{ id: "c1", body: "Null here?" }, { id: "c3", body: "Still null in the other branch." }])],
      handled: new Set([prWatchCommentKey("c1")]),
    });
    expect(result.feedback).toHaveLength(1);
    expect(result.feedback[0]!.item.commentIds).toEqual(["c3"]);
    expect(result.feedback[0]!.comments.map((comment) => comment.isNew)).toEqual([false, true]);
  });

  it("honors disabled triggers", () => {
    expect(scan({
      options: { checks: false, feedback: false, conflicts: false },
      summary: prWatchSummary({ mergeability: "conflicting" }),
      checks: [prWatchCheck("lint", "failure")],
      activity: [prWatchComment("a1", "Rename this")],
    }).triggers).toEqual([]);
  });
});

describe("buildPrWatchPrompt", () => {
  it("asks for a fenced report only when there are comments, and appends project instructions", () => {
    const feedback = scan({ activity: [prWatchComment("a1", "Rename this")] }).feedback;
    const prompt = buildPrWatchPrompt({
      provider: "github", number: 12, title: "Redesign cards", sourceBranch: "feat/cards", targetBranch: "main", headSha: HEAD,
      failedChecks: [{ name: "lint", url: null, log: "error: unused import" }], conflicts: false, feedback, instructions: "Run pnpm lint.",
    });
    expect(prompt).toContain("```pr-watch-report");
    expect(prompt).toContain("error: unused import");
    expect(prompt).toContain("### C1 · conversation");
    expect(prompt).toContain("Do not push");
    expect(prompt.endsWith("## Project instructions\nRun pnpm lint.")).toBe(true);
    const checksOnly = buildPrWatchPrompt({
      provider: "gitlab", number: 3, title: "Fix", sourceBranch: "fix", targetBranch: "main", headSha: null,
      failedChecks: [{ name: "test", url: null, log: null }], conflicts: true, feedback: [], instructions: "",
    });
    expect(checksOnly).toContain("MR #3");
    expect(checksOnly).toContain("## Merge conflicts");
    expect(checksOnly).not.toContain("pr-watch-report");
  });
});

describe("parsePrWatchReport", () => {
  it("reads the last report block and drops entries it cannot trust", () => {
    const text = [
      "Done.",
      "```pr-watch-report",
      JSON.stringify([
        { item: "t1", verdict: "Valid", commits: ["abc1234", "not-a-sha"], reply: "Added a null check." },
        { item: "C1", verdict: "needs_user", reply: "" },
        { item: "T9", verdict: "valid", reply: "Unknown item" },
        { item: "T2", verdict: "maybe", reply: "Bad verdict" },
      ]),
      "```",
    ].join("\n");
    expect(parsePrWatchReport(text, ["T1", "T2", "C1"])).toEqual([
      { item: "T1", verdict: "valid", commits: ["abc1234"], reply: "Added a null check." },
      { item: "C1", verdict: "needs-user", commits: [], reply: "" },
    ]);
  });

  it("returns null without a readable block", () => {
    expect(parsePrWatchReport("No report here", ["T1"])).toBeNull();
    expect(parsePrWatchReport("```pr-watch-report\n{oops\n```", ["T1"])).toBeNull();
  });
});

describe("formatPrWatchReply", () => {
  it("adds the fixing commits and the marker, and quotes conversation comments", () => {
    const thread = formatPrWatchReply({ verdict: "valid", reply: "Added a null check." }, { kind: "thread", excerpt: "Null?", author: "rev" }, ["b".repeat(40)]);
    expect(thread).toBe(`Added a null check.\n\nFixed in ${"b".repeat(12)}.\n\n${PR_WATCH_REPLY_MARKER}`);
    const conversation = formatPrWatchReply({ verdict: "incorrect", reply: "The prop is already renamed in card.ts." }, { kind: "conversation", excerpt: "Rename the prop", author: "rev" }, []);
    expect(conversation?.startsWith("> Rename the prop\n> — @rev\n\nThe prop is already renamed")).toBe(true);
    expect(formatPrWatchReply({ verdict: "needs-user", reply: "Ask the user" }, { kind: "thread", excerpt: "", author: null }, [])).toBeNull();
    expect(formatPrWatchReply({ verdict: "intentional", reply: "" }, { kind: "thread", excerpt: "", author: null }, [])).toBeNull();
  });
});

describe("watch helpers", () => {
  it("tails CI logs without colors, timestamps, or GitLab section markers", () => {
    const log = [
      "2026-11-21T10:00:00.1234567Z \u001b[36;1mnpm test\u001b[0m",
      "section_start:1700000000:step_script\r\u001b[0KRunning tests",
      "FAIL src/card.test.ts",
      "",
    ].join("\n");
    expect(tailCheckLog(log)).toBe("npm test\nRunning tests\nFAIL src/card.test.ts");
    expect(tailCheckLog(Array.from({ length: 10 }, (_, index) => `line ${String(index)}`).join("\n"), 3)).toBe("line 7\nline 8\nline 9");
    expect(tailCheckLog("\n\n")).toBeNull();
  });

  it("reads per-project instructions and ignores malformed settings", () => {
    expect(parseProjectPrWatchInstructionsSetting('{"p1":"Run lint","p2":"  ","p3":4}')).toEqual({ p1: "Run lint" });
    expect(parseProjectPrWatchInstructionsSetting("[1]")).toEqual({});
    expect(parseProjectPrWatchInstructionsSetting("{")).toEqual({});
  });
});
