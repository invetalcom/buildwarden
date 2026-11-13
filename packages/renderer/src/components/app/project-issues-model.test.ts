import type { ChatSummary, ProjectForgeIssueSummary, ProjectForgeIssueWorkLink, ProjectTaskSummary, RunListItem } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ISSUE_FILTERS,
  describeIssueAccess,
  formatIssueAge,
  isIssueUnread,
  issueFiltersEqual,
  issueLabelStyle,
  searchIssues,
  summarizeIssueWork,
} from "./project-issues-model";

const issue = (number: number, extra: Partial<ProjectForgeIssueSummary> = {}): ProjectForgeIssueSummary => ({
  provider: "github",
  number,
  title: `Issue ${String(number)}`,
  url: `https://github.com/acme/widgets/issues/${String(number)}`,
  state: "open",
  stateReason: null,
  author: "octocat",
  authorUser: null,
  labels: [],
  assignees: [],
  milestone: null,
  commentCount: 0,
  bodyPreview: "",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-02T10:00:00Z",
  closedAt: null,
  locked: false,
  confidential: false,
  weight: null,
  issueType: null,
  epic: null,
  taskProgress: null,
  reactions: [],
  ...extra,
});

describe("searchIssues", () => {
  const issues = [
    issue(183, { title: "Default test runs must be headless", labels: [{ name: "severity: low", color: null, description: null }] }),
    issue(141, { title: "Connection HUD omits battery levels", author: "lexrus" }),
  ];

  it("matches numbers, titles, labels, and authors, requiring every term", () => {
    expect(searchIssues(issues, "#183").map((entry) => entry.number)).toEqual([183]);
    expect(searchIssues(issues, "hud battery").map((entry) => entry.number)).toEqual([141]);
    expect(searchIssues(issues, "severity").map((entry) => entry.number)).toEqual([183]);
    expect(searchIssues(issues, "lexrus headless")).toEqual([]);
    expect(searchIssues(issues, "  ")).toHaveLength(2);
  });
});

describe("read markers", () => {
  it("flags an issue only when it changed after it was last opened", () => {
    const entry = issue(7, { updatedAt: "2026-11-05T10:00:00Z" });
    expect(isIssueUnread(entry, {})).toBe(false);
    expect(isIssueUnread(entry, { "7": "2026-11-05T10:00:00Z" })).toBe(false);
    expect(isIssueUnread(entry, { "7": "2026-11-04T10:00:00Z" })).toBe(true);
  });
});

describe("summarizeIssueWork", () => {
  const link = (kind: ProjectForgeIssueWorkLink["kind"], id: string, issueNumber: number, createdAt: string): ProjectForgeIssueWorkLink => ({
    kind,
    issueNumber,
    issueUrl: "",
    issueTitle: "",
    createdAt,
    ...(kind === "run" ? { runId: id } : kind === "chat" ? { chatId: id } : { taskId: id }),
  });
  const runs = [{ id: "run-1", status: "completed" }, { id: "run-2", status: "running" }] as RunListItem[];
  const chats = [{ id: "chat-1" }] as ChatSummary[];
  const tasks = [{ id: "task-1" }] as ProjectTaskSummary[];

  it("groups an issue's links by kind, newest first, and notices active runs", () => {
    const links = [
      link("run", "run-1", 7, "2026-11-01T00:00:00Z"),
      link("run", "run-2", 7, "2026-11-02T00:00:00Z"),
      link("chat", "chat-1", 7, "2026-11-03T00:00:00Z"),
      link("task", "task-gone", 7, "2026-11-03T00:00:00Z"),
      link("run", "run-1", 8, "2026-11-03T00:00:00Z"),
    ];
    const work = summarizeIssueWork(7, links, { runs, chats, tasks });
    expect(work.runs.map(({ run }) => run?.id)).toEqual(["run-2", "run-1"]);
    expect(work.chats.map(({ chat }) => chat?.id)).toEqual(["chat-1"]);
    expect(work.tasks.map(({ task }) => task)).toEqual([null]);
    expect(work.activeRun).toBe(true);
    expect(summarizeIssueWork(8, links, { runs, chats, tasks }).activeRun).toBe(false);
  });
});

describe("presentation helpers", () => {
  it("describes read-only access and warns when the request budget runs low", () => {
    expect(describeIssueAccess({ mode: "token", canWrite: true, canTriage: true, viewer: "me", rateLimit: null })).toBeNull();
    expect(describeIssueAccess({ mode: "token", canWrite: true, canTriage: false, viewer: "me", rateLimit: null })?.label).toBe("Comment only");
    const anonymous = describeIssueAccess({ mode: "anonymous", canWrite: false, canTriage: false, viewer: null, rateLimit: { limit: 60, remaining: 8, resetAt: null } });
    expect(anonymous).toMatchObject({ label: "Read-only · 8/60 requests left", tone: "warning" });
  });

  it("only tints labels with a valid host color", () => {
    expect(issueLabelStyle("d73a4a")?.color).toContain("var(--ec-text)");
    expect(issueLabelStyle("red")).toBeUndefined();
    expect(issueLabelStyle(null)).toBeUndefined();
  });

  it("formats ages compactly", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    expect(formatIssueAge("2026-11-11T11:47:00Z", now)).toBe("13m");
    expect(formatIssueAge("2026-11-03T12:00:00Z", now)).toBe("8d");
    expect(formatIssueAge(null, now)).toBe("");
  });

  it("compares filters regardless of label order", () => {
    expect(issueFiltersEqual({ ...DEFAULT_ISSUE_FILTERS, labels: ["a", "b"] }, { ...DEFAULT_ISSUE_FILTERS, labels: ["b", "a"] })).toBe(true);
    expect(issueFiltersEqual(DEFAULT_ISSUE_FILTERS, { ...DEFAULT_ISSUE_FILTERS, assignee: "@me" })).toBe(false);
  });
});
