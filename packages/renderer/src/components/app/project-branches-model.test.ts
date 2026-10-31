import type { ProjectGitBranchInfo, ProjectGitBranchOverview } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import {
  branchCompareUrl,
  branchRefName,
  countBranchFilters,
  divergenceBarPercent,
  formatBranchAge,
  selectMergedCleanupCandidates,
  selectVisibleBranches,
} from "./project-branches-model";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const branch = (name: string, overrides: Partial<ProjectGitBranchInfo> = {}): ProjectGitBranchInfo => ({
  name,
  isCurrent: false,
  isBase: false,
  hasLocal: true,
  hasRemote: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  commitSha: "abc1234",
  updatedAt: daysAgo(1),
  subject: `Work on ${name}`,
  authorName: "Ada",
  mergedIntoBase: false,
  linkedRunCount: 0,
  worktreePath: null,
  ...overrides,
});

const overview = (provider: ProjectGitBranchOverview["provider"]): ProjectGitBranchOverview => ({
  repoPath: "C:/repo",
  baseBranch: "main",
  currentBranch: "main",
  provider,
  webBaseUrl: provider === "gitlab" ? "https://gitlab.com/acme/app" : "https://github.com/acme/app",
  branches: [],
});

describe("project branch model", () => {
  const branches = [
    branch("zeta", { updatedAt: daysAgo(0.75) }),
    branch("main", { isBase: true, updatedAt: daysAgo(400) }),
    branch("feature", { isCurrent: true, updatedAt: daysAgo(5) }),
    branch("alpha", { updatedAt: daysAgo(0.5), mergedIntoBase: true }),
    branch("old", { updatedAt: daysAgo(120) }),
    branch("remote-only", { hasLocal: false, hasRemote: true }),
    branch("run-branch", { linkedRunCount: 2, mergedIntoBase: true }),
    branch("in-worktree", { worktreePath: "C:/worktrees/x", mergedIntoBase: true }),
  ];

  it("pins current and base branches, then sorts by recency or name", () => {
    expect(selectVisibleBranches(branches, { filter: "all", query: "", sort: "recent", now: NOW }).map((entry) => entry.name).slice(0, 4)).toEqual([
      "feature",
      "main",
      "alpha",
      "zeta",
    ]);
    expect(selectVisibleBranches(branches, { filter: "all", query: "", sort: "name", now: NOW }).map((entry) => entry.name).slice(2, 4)).toEqual([
      "alpha",
      "in-worktree",
    ]);
  });

  it("filters by category and multi-term search across name, subject, and author", () => {
    const counts = countBranchFilters(branches, NOW);
    expect(counts).toMatchObject({ all: 8, local: 7, remote: 1, runs: 1, merged: 3, stale: 1 });
    expect(selectVisibleBranches(branches, { filter: "stale", query: "", sort: "recent", now: NOW }).map((entry) => entry.name)).toEqual(["old"]);
    expect(selectVisibleBranches(branches, { filter: "all", query: "work ZETA", sort: "recent", now: NOW }).map((entry) => entry.name)).toEqual(["zeta"]);
  });

  it("offers only safe merged branches for cleanup", () => {
    expect(selectMergedCleanupCandidates(branches).map((entry) => entry.name)).toEqual(["alpha"]);
  });

  it("builds refs and forge compare links", () => {
    expect(branchRefName(branch("remote-only", { hasLocal: false }), "upstream")).toBe("upstream/remote-only");
    expect(branchRefName(branch("local"), "origin")).toBe("local");
    expect(branchCompareUrl(overview("github"), "feat/x")).toBe("https://github.com/acme/app/compare/main...feat%2Fx?expand=1");
    expect(branchCompareUrl(overview("gitlab"), "feat/x")).toBe(
      "https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx&merge_request%5Btarget_branch%5D=main",
    );
    expect(branchCompareUrl({ ...overview("github"), provider: "unknown" }, "x")).toBeNull();
  });

  it("formats ages and divergence bars compactly", () => {
    expect(formatBranchAge(daysAgo(0.01), NOW)).toBe("14m ago");
    expect(formatBranchAge(daysAgo(45), NOW)).toBe("1mo ago");
    expect(formatBranchAge(daysAgo(800), NOW)).toBe("2y ago");
    expect(formatBranchAge(null, NOW)).toBe("");
    expect(divergenceBarPercent(0, 10)).toBe(0);
    expect(divergenceBarPercent(10, 10)).toBe(100);
    expect(divergenceBarPercent(1, 1000)).toBeGreaterThanOrEqual(8);
  });
});
