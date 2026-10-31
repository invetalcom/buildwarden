/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderWithBuildWardenClient as renderToStaticMarkup } from "../../lib/buildwarden-client-test-utils";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BookmarkRecord, BookmarkStepRecord, ChatBookmarkRecord, DesktopApi } from "@buildwarden/shared";
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

const runBookmark: BookmarkRecord = {
  ...common,
  originalRunId: "run-1",
  projectId: "project-1",
  projectName: "BuildWarden",
  branchName: "main",
  runCreatedAt: "2026-07-13T12:00:00.000Z",
};

const chatBookmark: ChatBookmarkRecord = {
  ...common,
  originalChatId: "chat-1",
  chatCreatedAt: "2026-07-13T12:00:00.000Z",
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("bookmark detail boundary controls", () => {
  it("renders controls for a run bookmark", () => {
    const markup = renderToStaticMarkup(<BookmarkDetailPage bookmark={runBookmark} models={[]} onBack={vi.fn()} />);

    expect(markup).toContain('aria-label="Back to bookmarks"');
    expect(markup).toContain("Review the saved response");
    expect(markup).toContain("Project: BuildWarden");
    expect(markup).toContain("Branch: main");
    expect(markup).toContain("Original deleted");
    expect(markup).not.toContain("Open run");

    const linked = renderToStaticMarkup(<BookmarkDetailPage bookmark={runBookmark} models={[]} onBack={vi.fn()} onOpenOriginal={vi.fn()} />);
    expect(linked).toContain("Open run");
    expect(linked).not.toContain("Original deleted");
    expect(markup).toContain('aria-label="Scroll to top"');
    expect(markup).toContain('aria-label="Scroll to bottom"');
  });

  it("renders controls for a chat bookmark", () => {
    const markup = renderToStaticMarkup(<ChatBookmarkDetailPage bookmark={chatBookmark} models={[]} onBack={vi.fn()} />);

    expect(markup).toContain('aria-label="Back to bookmarks"');
    expect(markup).toContain("Review the saved response");
    expect(markup).not.toContain("Project:");
    expect(markup).toContain("Original deleted");
    expect(renderToStaticMarkup(<ChatBookmarkDetailPage bookmark={chatBookmark} models={[]} onBack={vi.fn()} onOpenOriginal={vi.fn()} />)).toContain("Open chat");
    expect(markup).toContain('aria-label="Scroll to top"');
    expect(markup).toContain('aria-label="Scroll to bottom"');
  });
});

describe("bookmark detail open original", () => {
  const clickOpenOriginal = async (page: ReactNode, label: string) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = createElectronBuildWardenClient({} as DesktopApi);
    try {
      await act(() => root.render(<BuildWardenClientProvider client={client}>{page}</BuildWardenClientProvider>));
      const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
      expect(button).toBeDefined();
      await act(() => button!.click());
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  };

  it("invokes onOpenOriginal from the run bookmark header", async () => {
    const onOpenOriginal = vi.fn();
    await clickOpenOriginal(<BookmarkDetailPage bookmark={runBookmark} models={[]} onBack={vi.fn()} onOpenOriginal={onOpenOriginal} />, "Open run");
    expect(onOpenOriginal).toHaveBeenCalledOnce();
  });

  it("invokes onOpenOriginal from the chat bookmark header", async () => {
    const onOpenOriginal = vi.fn();
    await clickOpenOriginal(<ChatBookmarkDetailPage bookmark={chatBookmark} models={[]} onBack={vi.fn()} onOpenOriginal={onOpenOriginal} />, "Open chat");
    expect(onOpenOriginal).toHaveBeenCalledOnce();
  });
});
