import type { ProjectActivityInsightData, ProjectActivityQueryResult, ProjectSnapshot } from "@buildwarden/shared";
import { renderWithBuildWardenClient } from "../../lib/buildwarden-client-test-utils";
import { describe, expect, it, vi } from "vitest";
import { ProjectActivityTab } from "./ProjectActivityTab";
import { ProjectActivityQueryResults } from "./ProjectActivityExplorer";

const activity: ProjectActivityInsightData = {
  summaryStats: {
    totalCommits: 42,
    contributorCount: 3,
    linesAdded: 1_200,
    linesDeleted: 400,
    filesChanged: 96,
    activeDays: 18,
    activeWeeks: 6,
    averageCommitsPerWeek: 7,
    mergeCommits: 4,
    busFactor50: 1,
    firstCommitAt: "2026-01-01T10:00:00.000Z",
    latestCommitAt: "2026-02-12T10:00:00.000Z",
    longestDailyStreak: 5,
  },
  contributors: [{
    name: "Alice Example",
    email: "alice@example.com",
    commits: 24,
    commitShare: 57.1,
    linesAdded: 800,
    linesDeleted: 200,
    linesChanged: 1_000,
    filesChanged: 54,
    activeDays: 12,
    firstCommitAt: "2026-01-01T10:00:00.000Z",
    latestCommitAt: "2026-02-12T10:00:00.000Z",
  }],
  weekdays: [
    { weekday: 1, label: "Mon", commits: 5, commitShare: 11.9 },
    { weekday: 2, label: "Tue", commits: 7, commitShare: 16.7 },
    { weekday: 3, label: "Wed", commits: 12, commitShare: 28.6 },
    { weekday: 4, label: "Thu", commits: 8, commitShare: 19 },
    { weekday: 5, label: "Fri", commits: 6, commitShare: 14.3 },
    { weekday: 6, label: "Sat", commits: 2, commitShare: 4.8 },
    { weekday: 0, label: "Sun", commits: 2, commitShare: 4.8 },
  ],
  modules: [{
    path: "packages/renderer",
    commits: 30,
    commitShare: 71.4,
    fileTouches: 64,
    uniqueFiles: 22,
    linesAdded: 900,
    linesDeleted: 300,
    linesChanged: 1_200,
    contributorCount: 3,
  }],
  monthlyActivity: [
    { month: "2026-01", commits: 22, linesChanged: 700, contributorCount: 2, netLines: 420 },
    { month: "2026-02", commits: 20, linesChanged: 900, contributorCount: 3, netLines: 380 },
  ],
  recentCommits: [{
    sha: "abcdef123456",
    title: "Add activity insights",
    author: "Alice Example",
    date: "2026-02-12T10:00:00.000Z",
    filesChanged: 4,
    linesChanged: 180,
  }],
  hotspots: {
    formula: "Normalized frequency × churn × recency",
    files: [{ path: "packages/renderer/src/App.tsx", score: 92, commits: 18, linesChanged: 840, lastChangedAt: "2026-02-12T10:00:00.000Z", contributorCount: 3 }],
    modules: [{ path: "packages/renderer", score: 100, commits: 30, linesChanged: 1_200, lastChangedAt: "2026-02-12T10:00:00.000Z", contributorCount: 3 }],
  },
  moduleOwnership: [{
    path: "packages/renderer",
    primaryOwnerName: "Alice Example",
    primaryOwnerEmail: "alice@example.com",
    ownershipShare: 82,
    busFactor50: 1,
    contributorCount: 3,
    commits: 30,
    risk: "silo",
  }],
  momentum: [{
    days: 30,
    current: { commits: 20, contributors: 3, linesChanged: 900 },
    previous: { commits: 12, contributors: 2, linesChanged: 500 },
    changePercent: { commits: 66.7, contributors: 50, linesChanged: 80 },
  }, {
    days: 90,
    current: { commits: 42, contributors: 3, linesChanged: 1_600 },
    previous: { commits: 0, contributors: 0, linesChanged: 0 },
    changePercent: { commits: null, contributors: null, linesChanged: null },
  }],
  commitSize: {
    medianLinesChanged: 28,
    p90LinesChanged: 240,
    megaCommitThreshold: 500,
    megaCommitCount: 2,
    megaCommitShare: 4.8,
    largestCommits: [{ sha: "large123456", title: "Large renderer migration", author: "Alice Example", date: "2026-02-01T10:00:00.000Z", filesChanged: 20, linesChanged: 980 }],
  },
  codeGrowth: { netLines: 800, filesCreated: 22, filesDeleted: 5 },
  fileAge: {
    trackedFileCount: 120,
    medianAgeDays: 180,
    medianDaysSinceChange: 24,
    staleThresholdDays: 365,
    oldestUntouchedFiles: [{ path: "packages/legacy/index.ts", firstSeenAt: "2020-01-01T00:00:00.000Z", lastChangedAt: "2022-01-01T00:00:00.000Z", ageDays: 2_200, daysSinceChange: 1_500 }],
    staleModules: [{ path: "packages/legacy", lastChangedAt: "2022-01-01T00:00:00.000Z", daysSinceChange: 1_500, trackedFiles: 8, commits: 12 }],
  },
  releaseCadence: {
    totalReleases: 2,
    averageDaysBetweenReleases: 28,
    medianDaysBetweenReleases: 28,
    averageCommitsPerRelease: 21,
    latestReleaseAt: "2026-02-10T00:00:00.000Z",
    sizeTrend: "growing",
    releases: [
      { name: "v1.0.0", date: "2026-01-10T00:00:00.000Z", daysSincePrevious: null, commitsSincePrevious: 22, linesChanged: 700, filesChanged: 40 },
      { name: "v1.1.0", date: "2026-02-10T00:00:00.000Z", daysSincePrevious: 31, commitsSincePrevious: 20, linesChanged: 900, filesChanged: 56 },
    ],
  },
};

const project = {
  project: {
    id: "project-1",
    name: "BuildWarden",
    repoPath: "C:/repo",
    baseBranch: "main",
    kind: "git",
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-12T00:00:00.000Z",
    lastOpenedAt: "2026-02-12T00:00:00.000Z",
  },
  runs: [],
  forLaterRuns: [],
  activeRuns: [],
  recentRuns: [],
  tasks: [],
  insights: [{
    id: "insight-1",
    projectId: "project-1",
    kind: "activity",
    title: "Activity",
    summary: "Analyzed 42 commits by 3 contributors across 1 module.",
    dataJson: JSON.stringify(activity),
    modelId: null,
    generatedAt: "2026-02-12T10:00:00.000Z",
    updatedAt: "2026-02-12T10:00:00.000Z",
  }],
  loops: [],
  labThreads: [],
} as unknown as ProjectSnapshot;

const queryResult: ProjectActivityQueryResult = {
  appliedFilters: { modulePath: "packages/renderer" },
  groupBy: "contributor",
  summary: {
    commits: 12,
    contributors: 2,
    linesAdded: 400,
    linesDeleted: 100,
    linesChanged: 500,
    netLines: 300,
    filesChanged: 30,
    filesCreated: 4,
    filesDeleted: 1,
    activeDays: 8,
    medianCommitSize: 32,
    megaCommits: 1,
    firstCommitAt: "2026-01-01T10:00:00.000Z",
    latestCommitAt: "2026-02-12T10:00:00.000Z",
  },
  groups: [{ key: "alice@example.com", label: "Alice Example", commits: 8, contributors: 1, linesChanged: 340, filesChanged: 20, drilldown: { contributorKey: "alice@example.com" } }],
  totalGroups: 1,
  groupResultLimit: 500,
  contributors: [{ key: "alice@example.com", name: "Alice Example", email: "alice@example.com", commits: 8, linesChanged: 340, filesChanged: 20 }],
  modules: [{ path: "packages/renderer", commits: 12, contributors: 2, linesChanged: 500, filesChanged: 30 }],
  weekdays: [
    { weekday: 1, label: "Mon", commits: 2 }, { weekday: 2, label: "Tue", commits: 2 },
    { weekday: 3, label: "Wed", commits: 3 }, { weekday: 4, label: "Thu", commits: 2 },
    { weekday: 5, label: "Fri", commits: 3 }, { weekday: 6, label: "Sat", commits: 0 },
    { weekday: 0, label: "Sun", commits: 0 },
  ],
  activity,
  commits: [{ sha: "abcdef123", title: "Scoped commit", author: "Alice Example", date: "2026-02-12T10:00:00.000Z", filesChanged: 3, linesChanged: 120 }],
  commitResultLimit: 100,
};

describe("ProjectActivityTab", () => {
  it("renders activity, risk, growth, ownership, file-age, and release sections", () => {
    const markup = renderWithBuildWardenClient(
      <ProjectActivityTab project={project} onGenerateInsight={vi.fn()} />,
    );

    expect(markup).toContain("Top contributors");
    expect(markup).toContain(">Filter</p>");
    expect(markup).toContain("All contributors");
    expect(markup).toContain("Group: month");
    expect(markup).toContain("Alice Example");
    expect(markup).not.toContain("Commit rhythm");
    expect(markup).toContain("Momentum");
    expect(markup).toContain("Code growth");
    expect(markup).toContain("Change hotspots");
    expect(markup).toContain("Ownership risk");
    expect(markup).not.toContain(">silo</span>");
    expect(markup).toContain("Commit size");
    expect(markup).toContain("File age");
    expect(markup).toContain("Release cadence");
    expect(markup).toContain("packages/renderer");
    expect(markup).toContain("Add activity insights");
    expect(markup).toContain('aria-label="Refresh Activity"');
    expect(markup).not.toContain(">Activity</h3>");
    expect(markup).not.toContain("All reachable refs");
    expect(markup.indexOf(">Commits</p>")).toBeLessThan(markup.indexOf(">Filter</p>"));
    expect(markup.indexOf("Top contributors")).toBeLessThan(markup.indexOf("Momentum"));
  });

  it("renders scoped metrics, grouped drill-downs, rankings, and commits", () => {
    const markup = renderWithBuildWardenClient(
      <ProjectActivityQueryResults
        result={queryResult}
        scopeActive
        onDrilldown={vi.fn()}
        onWeekday={vi.fn()}
        onContributor={vi.fn()}
        onModule={vi.fn()}
      />,
    );

    expect(markup).toContain("Breakdown");
    expect(markup).toContain("Grouped by contributor");
    expect(markup).toContain("Contributors in scope");
    expect(markup).toContain("Modules in scope");
    expect(markup).toContain("Momentum");
    expect(markup).toContain("Change hotspots");
    expect(markup).toContain("Commit size");
    expect(markup).toContain("Commits in scope");
    expect(markup).toContain("Scoped commit");
  });

  it("prompts users to refresh a legacy saved Activity report", () => {
    const legacyActivity = { ...activity, hotspots: undefined };
    const legacyProject = {
      ...project,
      insights: [{ ...project.insights[0]!, dataJson: JSON.stringify(legacyActivity) }],
    } as unknown as ProjectSnapshot;
    const markup = renderWithBuildWardenClient(
      <ProjectActivityTab project={legacyProject} onGenerateInsight={vi.fn()} />,
    );

    expect(markup).toContain("Refresh this saved report");
  });

  it("shows a repository-specific empty state", () => {
    const markup = renderWithBuildWardenClient(
      <ProjectActivityTab project={{ ...project, insights: [] }} onGenerateInsight={vi.fn()} />,
    );

    expect(markup).toContain("See who changes what");
    expect(markup).toContain("Analyze history");
  });
});
