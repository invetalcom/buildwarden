import { describe, expect, it } from "vitest";
import type { ProjectRecord } from "@buildwarden/shared";
import { projectSidebarContext } from "./sidebar-project-context";
import { recentRunOrderTimestamp } from "./sidebar-run-ordering";

const gitProject = {
  id: "project-1",
  name: "Project",
  repoPath: "C:/repo",
  kind: "git",
  baseBranch: "project-base",
} as ProjectRecord;

describe("Sidebar project context", () => {
  it("shows the checked-out branch instead of the configured project base branch", () => {
    expect(projectSidebarContext(gitProject, "current-branch", "attached")).toBe("current-branch");
  });

  it("does not present the base branch as checked out for a detached repository", () => {
    expect(projectSidebarContext(gitProject, "", "detached")).toBe("Detached HEAD");
  });

  it("keeps the last confirmed branch visible while it refreshes", () => {
    expect(projectSidebarContext(gitProject, "current-branch", "loading")).toBe("current-branch");
  });

  it("does not show a loading message before the first branch lookup completes", () => {
    expect(projectSidebarContext(gitProject, "", "loading")).toBe("Git repository");
  });
});

describe("Sidebar recent run ordering", () => {
  it("uses the latest user input timestamp instead of run activity updates", () => {
    const olderPromptButNewerActivity = {
      createdAt: "2026-05-31T10:00:00.000Z",
      updatedAt: "2026-05-31T10:30:00.000Z",
      lastUserInputAt: "2026-05-31T10:00:00.000Z",
    };
    const newerPromptButOlderActivity = {
      createdAt: "2026-05-31T10:05:00.000Z",
      updatedAt: "2026-05-31T10:06:00.000Z",
      lastUserInputAt: "2026-05-31T10:05:00.000Z",
    };

    const sorted = [olderPromptButNewerActivity, newerPromptButOlderActivity].sort(
      (left, right) => recentRunOrderTimestamp(right) - recentRunOrderTimestamp(left),
    );

    expect(sorted[0]).toBe(newerPromptButOlderActivity);
  });
});
