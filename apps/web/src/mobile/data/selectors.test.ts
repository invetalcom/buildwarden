import { describe, expect, it } from "vitest";
import type { ProjectSnapshot, RunRecord } from "@buildwarden/shared";
import { filterRuns, flattenRuns, matchesRunFilter, needsAttention } from "./selectors";

const run = (overrides: Partial<RunRecord> & Pick<RunRecord, "id">): RunRecord => ({
  projectId: "p1",
  providerAccountId: "acc",
  modelId: "model",
  harnessType: "ai-sdk",
  mode: "code",
  workspaceType: "worktree",
  workspaceVcs: "git",
  prompt: "Do the thing",
  goalText: null,
  status: "completed",
  branchName: "bw/thing",
  worktreePath: "/tmp/wt",
  summary: null,
  errorMessage: null,
  lastProviderResponseId: null,
  inputTokens: 0,
  outputTokens: 0,
  listVisibility: "default",
  kind: "standard",
  labThreadId: null,
  parentRunId: null,
  rootRunId: null,
  lineageTitle: null,
  projectTaskId: null,
  delegationEnabled: false,
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

const project = (id: string, runs: RunRecord[], forLaterRuns: RunRecord[] = []): ProjectSnapshot => ({
  project: {
    id,
    name: `Project ${id}`,
    repoPath: `/repos/${id}`,
    baseBranch: "main",
    kind: "git",
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    lastOpenedAt: null,
  },
  runs,
  forLaterRuns,
  orchestratedRuns: [],
  activeRuns: [],
  recentRuns: [],
  tasks: [],
  insights: [],
  labThreads: [],
  loops: [],
});

describe("flattenRuns", () => {
  it("deduplicates runs that appear in several snapshot buckets", () => {
    const shared = run({ id: "r1" });
    const snapshotProject: ProjectSnapshot = {
      ...project("p1", [shared]),
      activeRuns: [shared],
      recentRuns: [shared],
    };
    expect(flattenRuns([snapshotProject]).map((item) => item.run.id)).toEqual(["r1"]);
  });

  it("sorts newest interaction first across projects", () => {
    const older = run({ id: "old", updatedAt: "2026-07-01T09:00:00.000Z", createdAt: "2026-07-01T09:00:00.000Z" });
    const newer = run({ id: "new", createdAt: "2026-07-02T09:00:00.000Z", lastUserInputAt: "2026-07-03T09:00:00.000Z" });
    const items = flattenRuns([project("a", [older]), project("b", [newer])]);
    expect(items.map((item) => item.run.id)).toEqual(["new", "old"]);
  });
});

describe("needsAttention", () => {
  it("flags pending user input and orchestration escalations", () => {
    expect(needsAttention(run({ id: "r", pendingUserInputRequest: true }))).toBe(true);
    expect(needsAttention(run({ id: "r", pendingUserInputRequest: 2 }))).toBe(true);
    expect(needsAttention(run({ id: "r", orchestrationStatus: "attention" }))).toBe(true);
    expect(needsAttention(run({ id: "r" }))).toBe(false);
  });
});

describe("matchesRunFilter", () => {
  const running = run({ id: "running", status: "running" });
  const done = run({ id: "done", status: "completed" });
  const later = run({ id: "later", listVisibility: "for-later" });
  const waiting = run({ id: "waiting", status: "running", pendingUserInputRequest: true });

  it("keeps for-later runs out of every other filter", () => {
    expect(matchesRunFilter(later, "for-later")).toBe(true);
    for (const filter of ["all", "active", "done", "attention"] as const) {
      expect(matchesRunFilter(later, filter)).toBe(false);
    }
  });

  it("separates active, finished and attention-needing runs", () => {
    expect(matchesRunFilter(running, "active")).toBe(true);
    expect(matchesRunFilter(running, "done")).toBe(false);
    expect(matchesRunFilter(done, "done")).toBe(true);
    expect(matchesRunFilter(waiting, "attention")).toBe(true);
    expect(matchesRunFilter(running, "attention")).toBe(false);
  });
});

describe("filterRuns", () => {
  const items = flattenRuns([
    project("p1", [
      run({ id: "a", prompt: "Fix the login redirect", branchName: "bw/login" }),
      run({ id: "b", prompt: "Update the changelog", branchName: "bw/docs" }),
    ]),
  ]);

  it("matches on the prompt", () => {
    expect(filterRuns(items, "all", "login").map((item) => item.run.id)).toEqual(["a"]);
  });

  it("also matches on branch name and project name", () => {
    expect(filterRuns(items, "all", "bw/docs").map((item) => item.run.id)).toEqual(["b"]);
    expect(filterRuns(items, "all", "project p1")).toHaveLength(2);
  });

  it("returns everything for an empty query", () => {
    expect(filterRuns(items, "all", "   ")).toHaveLength(2);
  });
});
