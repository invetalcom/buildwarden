/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BookmarkRecord, ChatBookmarkRecord, DesktopApi } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { BookmarksPage } from "./BookmarksPage";

const run: BookmarkRecord = {
  id: "saved-run", originalRunId: "deleted-run", projectId: null, projectName: "Kanban",
  prompt: "Redesign the cards", status: "completed", branchName: "feat/cards", modelId: null,
  runCreatedAt: "2026-10-20T10:00:00Z", bookmarkedAt: "2026-10-28T10:00:00Z",
  steps: [{ id: "step", bookmarkId: "saved-run", eventType: "output", title: "Summary", content: "Improved contrast", metadataJson: "{}", createdAt: "2026-10-20T10:00:00Z" }],
};
const chat: ChatBookmarkRecord = {
  id: "saved-chat", originalChatId: "deleted-chat", prompt: "Explain signals", status: "cancelled", modelId: null,
  chatCreatedAt: "2026-10-20T10:00:00Z", bookmarkedAt: "2026-10-29T10:00:00Z", steps: [],
};
let root: Root | null = null;
let container: HTMLDivElement;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
});

const renderPage = async (runs = [run], chats = [chat], capabilities = { runMutations: true, chatMutations: true }) => {
  const getBookmarksWithSteps = vi.fn<DesktopApi["getBookmarksWithSteps"]>().mockResolvedValue(runs);
  const getChatBookmarksWithSteps = vi.fn<DesktopApi["getChatBookmarksWithSteps"]>().mockResolvedValue(chats);
  const desktop = createElectronBuildWardenClient({ getBookmarksWithSteps, getChatBookmarksWithSteps } as unknown as DesktopApi);
  const client = { ...desktop, capabilities: { ...desktop.capabilities, ...capabilities } };
  const props = { onSelectBookmark: vi.fn(), onRemoveRunBookmarkById: vi.fn(), onRemoveChatBookmarkById: vi.fn() };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<BuildWardenClientProvider client={client}><BookmarksPage {...props} /></BuildWardenClientProvider>));
  return { ...props, getBookmarksWithSteps, getChatBookmarksWithSteps };
};

const search = async (value: string) => {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search bookmarks"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = async (selector: string) => {
  const button = container.querySelector<HTMLButtonElement>(selector)!;
  expect(button).not.toBeNull();
  await act(async () => button.click());
};

describe("bookmarks landing page", () => {
  it("merges saved runs and chats newest first and searches titles, projects, and activity logs", async () => {
    const { onSelectBookmark } = await renderPage();
    expect([...container.querySelectorAll("[data-bookmark-id]")].map((row) => row.getAttribute("data-bookmark-id"))).toEqual([chat.id, run.id]);
    expect(container.textContent).toContain("1 run, 1 chat");
    for (const query of ["cards", "KANBAN", "contrast"]) {
      await search(query);
      expect(container.querySelectorAll("[data-bookmark-id]")).toHaveLength(1);
      expect(container.querySelector('[data-bookmark-id="saved-run"]')).not.toBeNull();
      expect(container.textContent).toContain("1 matching of 2 bookmarks");
    }
    await click('[title="Open bookmark"]');
    expect(onSelectBookmark).toHaveBeenCalledWith(run);
    await click('[aria-label="Clear bookmark search"]');
    await click('[data-bookmark-id="saved-chat"] [title="Open bookmark"]');
    expect(onSelectBookmark).toHaveBeenCalledWith(chat);
    await search("missing phrase");
    expect(container.textContent).toContain("No matching bookmarks");
    await click('[aria-label="Clear bookmark search"]');
    expect(container.querySelectorAll("[data-bookmark-id]")).toHaveLength(2);
  });

  it("removes each saved item through its own callback and reloads without opening it", async () => {
    const actions = await renderPage();
    actions.getChatBookmarksWithSteps.mockResolvedValue([]);
    await click('[data-bookmark-id="saved-chat"] [title="Remove from bookmarks"]');
    expect(actions.onRemoveChatBookmarkById).toHaveBeenCalledWith(chat.id);
    expect(actions.onRemoveRunBookmarkById).not.toHaveBeenCalled();
    expect(container.querySelector('[data-bookmark-id="saved-chat"]')).toBeNull();
    actions.getBookmarksWithSteps.mockResolvedValue([]);
    await click('[data-bookmark-id="saved-run"] [title="Remove from bookmarks"]');
    expect(actions.onRemoveRunBookmarkById).toHaveBeenCalledWith(run.id);
    expect(actions.onSelectBookmark).not.toHaveBeenCalled();
    expect(actions.getBookmarksWithSteps).toHaveBeenCalledTimes(3);
    expect(actions.getChatBookmarksWithSteps).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("No bookmarks yet");
  });

  it.each([
    { runMutations: false, chatMutations: false },
    { runMutations: true, chatMutations: false },
    { runMutations: false, chatMutations: true },
  ])("respects run and chat removal capabilities independently: %j", async (capabilities) => {
    const savedChat = { ...chat, prompt: "" };
    const { onSelectBookmark } = await renderPage([run], [savedChat], capabilities);
    expect(Boolean(container.querySelector('[data-bookmark-id="saved-run"] [title="Remove from bookmarks"]'))).toBe(capabilities.runMutations);
    expect(Boolean(container.querySelector('[data-bookmark-id="saved-chat"] [title="Remove from bookmarks"]'))).toBe(capabilities.chatMutations);
    expect(container.textContent).toContain("Chat with attachments");
    await click('[data-bookmark-id="saved-chat"] [title="Open bookmark"]');
    expect(onSelectBookmark).toHaveBeenCalledWith(savedChat);
  });
});
