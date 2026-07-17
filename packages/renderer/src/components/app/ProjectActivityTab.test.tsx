import type { ProjectActivityInsightData, ProjectSnapshot } from "@buildwarden/shared";
import { renderWithBuildWardenClient } from "../../lib/buildwarden-client-test-utils";
import { describe, expect, it, vi } from "vitest";
import { ProjectActivityTab } from "./ProjectActivityTab";

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
    { month: "2026-01", commits: 22, linesChanged: 700, contributorCount: 2 },
    { month: "2026-02", commits: 20, linesChanged: 900, contributorCount: 3 },
  ],
  recentCommits: [{
    sha: "abcdef123456",
    title: "Add activity insights",
    author: "Alice Example",
    date: "2026-02-12T10:00:00.000Z",
    filesChanged: 4,
    linesChanged: 180,
  }],
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

describe("ProjectActivityTab", () => {
  it("renders contributor, rhythm, module, and recent history sections", () => {
    const markup = renderWithBuildWardenClient(
      <ProjectActivityTab project={project} onGenerateInsight={vi.fn()} />,
    );

    expect(markup).toContain("Top contributors");
    expect(markup).toContain("Alice Example");
    expect(markup).toContain("Commit rhythm");
    expect(markup).toContain("Most changed modules");
    expect(markup).toContain("packages/renderer");
    expect(markup).toContain("Add activity insights");
    expect(markup).toContain("Refresh");
  });

  it("shows a repository-specific empty state", () => {
    const markup = renderWithBuildWardenClient(
      <ProjectActivityTab project={{ ...project, insights: [] }} onGenerateInsight={vi.fn()} />,
    );

    expect(markup).toContain("See who changes what");
    expect(markup).toContain("Analyze history");
  });
});

