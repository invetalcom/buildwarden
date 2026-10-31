import { renderWithBuildWardenClient as renderToStaticMarkup } from "../../lib/buildwarden-client-test-utils";
import { describe, expect, it, vi } from "vitest";
import type { BookmarkRecord, BookmarkStepRecord, ChatBookmarkRecord } from "@buildwarden/shared";
import { BookmarkDetailPage } from "./BookmarkDetailPage";
import { ChatBookmarkDetailPage } from "./ChatBookmarkDetailPage";

const step: BookmarkStepRecord = {
  id: "step-1",
  bookmarkId: "bookmark-1",
  eventType: "output",
  title: "Answer",
  content: "Saved response",
  metadataJson: "{}",
  createdAt: "2026-07-13T12:00:00.000Z",
};

const common = {
  id: "bookmark-1",
  prompt: "Review the saved response",
  status: "completed" as const,
  modelId: null,
  bookmarkedAt: "2026-07-13T12:05:00.000Z",
  steps: [step],
};

describe("bookmark detail boundary controls", () => {
  it("renders controls for a run bookmark", () => {
    const bookmark: BookmarkRecord = {
      ...common,
      originalRunId: "run-1",
      projectId: "project-1",
      projectName: "BuildWarden",
      branchName: "main",
      runCreatedAt: "2026-07-13T12:00:00.000Z",
    };

    const markup = renderToStaticMarkup(<BookmarkDetailPage bookmark={bookmark} models={[]} onBack={vi.fn()} />);

    expect(markup).toContain('aria-label="Back to bookmarks"');
    expect(markup).toContain("Review the saved response");
    expect(markup).toContain("Project: BuildWarden");
    expect(markup).toContain("Branch: main");
    expect(markup).toContain("Original deleted");
    expect(markup).not.toContain("Open run");

    const linked = renderToStaticMarkup(<BookmarkDetailPage bookmark={bookmark} models={[]} onBack={vi.fn()} onOpenOriginal={vi.fn()} />);
    expect(linked).toContain("Open run");
    expect(linked).not.toContain("Original deleted");
    expect(markup).toContain('aria-label="Scroll to top"');
    expect(markup).toContain('aria-label="Scroll to bottom"');
  });

  it("renders controls for a chat bookmark", () => {
    const bookmark: ChatBookmarkRecord = {
      ...common,
      originalChatId: "chat-1",
      chatCreatedAt: "2026-07-13T12:00:00.000Z",
    };

    const markup = renderToStaticMarkup(<ChatBookmarkDetailPage bookmark={bookmark} models={[]} onBack={vi.fn()} />);

    expect(markup).toContain('aria-label="Back to bookmarks"');
    expect(markup).toContain("Review the saved response");
    expect(markup).not.toContain("Project:");
    expect(markup).toContain("Original deleted");
    expect(renderToStaticMarkup(<ChatBookmarkDetailPage bookmark={bookmark} models={[]} onBack={vi.fn()} onOpenOriginal={vi.fn()} />)).toContain("Open chat");
    expect(markup).toContain('aria-label="Scroll to top"');
    expect(markup).toContain('aria-label="Scroll to bottom"');
  });
});
