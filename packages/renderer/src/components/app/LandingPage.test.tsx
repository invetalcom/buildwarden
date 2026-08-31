import type { AppSnapshot } from "@buildwarden/shared";
import { describe, expect, it, vi } from "vitest";
import { renderWithBuildWardenClient as renderToStaticMarkup } from "../../lib/buildwarden-client-test-utils";
import { LandingPage } from "./LandingPage";

const snapshot = {
  projects: [{
    project: {
      id: "project-1",
      name: "BuildWarden",
      repoPath: "C:/repo",
      baseBranch: "main",
      kind: "git",
      cumulativeInputTokens: 80,
      cumulativeOutputTokens: 20,
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-31T10:00:00.000Z",
      lastOpenedAt: "2026-08-31T10:00:00.000Z",
    },
    runs: [],
    forLaterRuns: [],
    orchestratedRuns: [],
    activeRuns: [],
    recentRuns: [],
    tasks: [],
    automations: [],
    insights: [],
    labThreads: [],
    loops: [],
  }],
  providerAccounts: [],
  models: [],
  selectedProjectId: null,
  selectedRunId: null,
  selectedChatId: null,
  settings: {},
  bookmarks: [],
  chatBookmarks: [],
  chats: [],
  tokenUsage: {
    standaloneChats: { inputTokens: 15, outputTokens: 10 },
    today: { inputTokens: 40, outputTokens: 15 },
  },
} satisfies AppSnapshot;

describe("LandingPage token usage", () => {
  it("includes standalone chats in lifetime usage and ledger usage in today's activity", () => {
    const markup = renderToStaticMarkup(
      <LandingPage
        snapshot={snapshot}
        sessionJoke="Ready"
        onSelectProject={vi.fn()}
        onSelectRun={vi.fn()}
        onOpenChats={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(markup).toContain("125");
    expect(markup).toContain("55 tokens");
  });
});
