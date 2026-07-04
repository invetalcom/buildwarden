import { describe, expect, it } from "vitest";
import type { ProjectForgeActivityItem, ProjectForgeReviewThread } from "@buildwarden/shared";
import {
  LOOP_COMMENT_MARKER,
  extractLoopActionableFeedback,
  normalizeForgeRequestState,
  parseLoopAiUiVerdict,
  parseLoopPlan,
  parseLoopPrReviewResult,
  parseLoopUiManifest,
  parseProcessedCommentIds,
  serializeProcessedCommentIds,
} from "./loop-helpers";

const makeThread = (overrides: Partial<ProjectForgeReviewThread>): ProjectForgeReviewThread => ({
  id: "thread-1",
  providerThreadId: "provider-thread-1",
  replyToCommentId: null,
  provider: "github",
  path: "src/app.ts",
  oldPath: null,
  side: "new",
  oldLineNumber: null,
  newLineNumber: 12,
  commitSha: null,
  diffHunk: null,
  resolved: false,
  comments: [],
  ...overrides,
});

const makeComment = (id: string, body: string): ProjectForgeReviewThread["comments"][number] => ({
  id,
  providerCommentId: id,
  body,
  author: { username: "reviewer", name: null, avatarUrl: null, webUrl: null },
  createdAt: null,
  updatedAt: null,
  url: null,
});

const makeActivityComment = (id: string, body: string): ProjectForgeActivityItem => ({
  id,
  provider: "github",
  kind: "comment",
  title: "Comment",
  body,
  state: null,
  path: null,
  line: null,
  url: null,
  createdAt: null,
  updatedAt: null,
  author: { username: "reviewer", name: null, avatarUrl: null, webUrl: null },
});

describe("parseLoopPlan", () => {
  it("parses a strict JSON plan", () => {
    const plan = parseLoopPlan(
      '{"summary":"Two PRs.","iterations":[{"title":"Add API","objective":"Implement the API."},{"title":"Add UI","objective":"Implement the UI."}]}',
    );
    expect(plan?.summary).toBe("Two PRs.");
    expect(plan?.iterations).toHaveLength(2);
    expect(plan?.iterations[0]).toMatchObject({ title: "Add API" });
  });

  it("parses fenced JSON with commentary and alternative keys", () => {
    const plan = parseLoopPlan(
      ['Here is the plan:', "```json", '{"summary":"One PR.","prs":[{"name":"Do it","description":"All in one."}]}', "```"].join("\n"),
    );
    expect(plan?.iterations).toEqual([{ title: "Do it", objective: "All in one." }]);
  });

  it("returns null for unusable output", () => {
    expect(parseLoopPlan("I could not decide on a plan.")).toBeNull();
    expect(parseLoopPlan('{"summary":"empty","iterations":[]}')).toBeNull();
  });
});

describe("parseLoopUiManifest", () => {
  it("parses the documented manifest shape", () => {
    const pages = parseLoopUiManifest('{"pages":[{"name":"Dashboard","file":"dashboard.png","description":"New chart"}]}');
    expect(pages).toEqual([{ name: "Dashboard", file: "dashboard.png", description: "New chart" }]);
  });

  it("accepts an empty pages array and drops incomplete entries", () => {
    expect(parseLoopUiManifest('{"pages":[]}')).toEqual([]);
    expect(parseLoopUiManifest('{"pages":[{"name":"No file"}]}')).toEqual([]);
  });

  it("returns null for non-manifest JSON", () => {
    expect(parseLoopUiManifest('{"foo":1}')).toBeNull();
  });
});

describe("parseLoopAiUiVerdict", () => {
  it("parses approvals and change requests", () => {
    expect(parseLoopAiUiVerdict('{"verdict":"approve","feedback":""}')).toEqual({ verdict: "approve", feedback: "" });
    expect(parseLoopAiUiVerdict('{"verdict":"request-changes","feedback":"Fix the spacing."}')).toEqual({
      verdict: "request-changes",
      feedback: "Fix the spacing.",
    });
  });

  it("falls back to null when the verdict is missing", () => {
    expect(parseLoopAiUiVerdict('{"feedback":"looks odd"}')).toBeNull();
    expect(parseLoopAiUiVerdict("not json")).toBeNull();
  });

  it("does not treat negated approvals as approvals", () => {
    expect(parseLoopAiUiVerdict('{"verdict":"not approved","feedback":"broken layout"}')).toBeNull();
    expect(parseLoopAiUiVerdict('{"verdict":"disapproved","feedback":"broken layout"}')).toBeNull();
    expect(parseLoopAiUiVerdict('{"verdict":"rejected","feedback":"broken layout"}')).toEqual({
      verdict: "request-changes",
      feedback: "broken layout",
    });
  });
});

describe("parseLoopPrReviewResult", () => {
  it("parses findings with severities and line numbers", () => {
    const result = parseLoopPrReviewResult(
      '{"summary":"Two issues.","findings":[{"path":"a.ts","line":10,"severity":"high","comment":"Fix A."},{"path":"b.ts","line":null,"severity":"weird","comment":"Fix B."}]}',
    );
    expect(result?.summary).toBe("Two issues.");
    expect(result?.findings).toEqual([
      { path: "a.ts", line: 10, severity: "high", comment: "Fix A." },
      { path: "b.ts", line: null, severity: "medium", comment: "Fix B." },
    ]);
  });

  it("accepts a clean review with no findings", () => {
    const result = parseLoopPrReviewResult('{"summary":"Looks good.","findings":[]}');
    expect(result).toEqual({ summary: "Looks good.", findings: [] });
  });

  it("returns null for unusable output", () => {
    expect(parseLoopPrReviewResult("no json here")).toBeNull();
    expect(parseLoopPrReviewResult('{"findings":[{"path":"a.ts"}]}')).toBeNull();
  });
});

describe("normalizeForgeRequestState", () => {
  it("maps provider states onto open/merged/closed", () => {
    expect(normalizeForgeRequestState("merged")).toBe("merged");
    expect(normalizeForgeRequestState("open")).toBe("open");
    expect(normalizeForgeRequestState("opened")).toBe("open");
    expect(normalizeForgeRequestState("locked")).toBe("open");
    expect(normalizeForgeRequestState("closed")).toBe("closed");
  });
});

describe("extractLoopActionableFeedback", () => {
  it("collects unresolved threads with new comments and general comments", () => {
    const threads = [
      makeThread({ id: "t1", comments: [makeComment("c1", "Please rename this.")] }),
      makeThread({ id: "t2", resolved: true, comments: [makeComment("c2", "Old feedback.")] }),
    ];
    const activity = [makeActivityComment("a1", "Can you add a test?")];
    const feedback = extractLoopActionableFeedback(threads, activity, new Set());
    expect(feedback.threads).toHaveLength(1);
    expect(feedback.threads[0]?.newComments.map((comment) => comment.id)).toEqual(["c1"]);
    expect(feedback.generalComments.map((item) => item.id)).toEqual(["a1"]);
    expect(feedback.seenCommentIds).toEqual(expect.arrayContaining(["c1", "c2", "a1"]));
  });

  it("ignores already processed comments and the loop's own replies", () => {
    const threads = [
      makeThread({
        id: "t1",
        comments: [makeComment("c1", "Please rename this."), makeComment("c2", `Addressed. ${LOOP_COMMENT_MARKER}`)],
      }),
    ];
    const activity = [makeActivityComment("a1", `Done. ${LOOP_COMMENT_MARKER}`)];
    const feedback = extractLoopActionableFeedback(threads, activity, new Set(["c1"]));
    expect(feedback.threads).toHaveLength(0);
    expect(feedback.generalComments).toHaveLength(0);
  });

  it("treats non-comment activity as not actionable", () => {
    const activity: ProjectForgeActivityItem[] = [{ ...makeActivityComment("a1", "merged"), kind: "state" }];
    const feedback = extractLoopActionableFeedback([], activity, new Set());
    expect(feedback.generalComments).toHaveLength(0);
  });
});

describe("processed comment id round-trip", () => {
  it("serializes and parses ids", () => {
    const ids = new Set(["a", "b"]);
    expect(parseProcessedCommentIds(serializeProcessedCommentIds(ids))).toEqual(ids);
  });

  it("tolerates malformed JSON", () => {
    expect(parseProcessedCommentIds("not json").size).toBe(0);
    expect(parseProcessedCommentIds("").size).toBe(0);
  });
});
