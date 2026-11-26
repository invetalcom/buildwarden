/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BookmarkListEntry, BookmarkRecord, ChatBookmarkRecord, DesktopApi } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { bookmarkMatchesSearch } from "../../lib/bookmark-search";
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

/** What the host lists for a saved item: everything but its steps. */
const entryOf = (bookmark: BookmarkRecord | ChatBookmarkRecord): BookmarkListEntry => {
  const entry: Partial<BookmarkRecord | ChatBookmarkRecord> = { ...bookmark };
  delete entry.steps;
  return entry as BookmarkListEntry;
};

const renderPage = async (runs = [run], chats = [chat], capabilities = { runMutations: true, chatMutations: true }, api: Partial<DesktopApi> = {}) => {
  const saved = [...chats, ...runs];
  // The page lists saved items without their steps, asks the host which ones match a search, and loads one item's steps to open it.
  const listBookmarkEntries = vi.fn<DesktopApi["listBookmarkEntries"]>().mockResolvedValue(saved.map(entryOf));
  const searchBookmarks = vi.fn<DesktopApi["searchBookmarks"]>(async (query) => saved.filter((bookmark) => bookmarkMatchesSearch(bookmark, query)).map((bookmark) => bookmark.id));
  const getBookmarkWithSteps = vi.fn<DesktopApi["getBookmarkWithSteps"]>(async (bookmarkId) => saved.find((bookmark) => bookmark.id === bookmarkId) ?? null);
  const desktop = createElectronBuildWardenClient({ listBookmarkEntries, searchBookmarks, getBookmarkWithSteps, ...api } as unknown as DesktopApi);
  const client = { ...desktop, capabilities: { ...desktop.capabilities, ...capabilities } };
  const props = {
    onSelectBookmark: vi.fn(),
    onRemoveRunBookmarkById: vi.fn<(bookmarkId: string) => Promise<void>>().mockResolvedValue(undefined),
    onRemoveChatBookmarkById: vi.fn<(bookmarkId: string) => Promise<void>>().mockResolvedValue(undefined),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<BuildWardenClientProvider client={client}><BookmarksPage {...props} /></BuildWardenClientProvider>));
  return { ...props, listBookmarkEntries, searchBookmarks, getBookmarkWithSteps };
};

/** The host is asked shortly after typing stops. */
const waitForHostSearch = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });

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
    const { onSelectBookmark, listBookmarkEntries, getBookmarkWithSteps } = await renderPage();
    expect(JSON.stringify(await listBookmarkEntries.mock.results[0]!.value)).not.toContain("Improved contrast");
    expect([...container.querySelectorAll("[data-bookmark-id]")].map((row) => row.getAttribute("data-bookmark-id"))).toEqual([chat.id, run.id]);
    expect(container.textContent).toContain("1 run, 1 chat");
    for (const query of ["cards", "KANBAN", "contrast"]) {
      await search(query);
      await waitForHostSearch();
      expect(container.querySelectorAll("[data-bookmark-id]")).toHaveLength(1);
      expect(container.querySelector('[data-bookmark-id="saved-run"]')).not.toBeNull();
      expect(container.textContent).toContain("1 matching of 2 bookmarks");
    }
    expect(getBookmarkWithSteps).not.toHaveBeenCalled();
    await click('[title="Open bookmark"]');
    expect(getBookmarkWithSteps).toHaveBeenCalledExactlyOnceWith(run.id);
    expect(onSelectBookmark).toHaveBeenCalledWith(run);
    await click('[aria-label="Clear bookmark search"]');
    await click('[data-bookmark-id="saved-chat"] [title="Open bookmark"]');
    expect(onSelectBookmark).toHaveBeenCalledWith(chat);
    await search("missing phrase");
    await waitForHostSearch();
    expect(container.textContent).toContain("No matching bookmarks");
    await click('[aria-label="Clear bookmark search"]');
    expect(container.querySelectorAll("[data-bookmark-id]")).toHaveLength(2);
  });

  it("searches again when a reload lists another item in place of one", async () => {
    let settingsChanged!: () => void;
    const actions = await renderPage([run], [chat], undefined, { onAppSettingsChanged: (listener) => { settingsChanged = listener; return () => undefined; } });
    await search("contrast");
    await waitForHostSearch();
    expect(actions.searchBookmarks).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-bookmark-id="saved-run"]')).not.toBeNull();

    // The same number of items, but one of them is new and matches only through its steps.
    const replacement = { ...run, id: "saved-run-2", originalRunId: "another-run", prompt: "Other work" };
    actions.listBookmarkEntries.mockResolvedValue([entryOf(chat), entryOf(replacement)]);
    actions.searchBookmarks.mockResolvedValue([replacement.id]);
    await act(async () => settingsChanged());
    await waitForHostSearch();
    expect(actions.searchBookmarks).toHaveBeenCalledTimes(2);
    expect([...container.querySelectorAll("[data-bookmark-id]")].map((row) => row.getAttribute("data-bookmark-id"))).toEqual([replacement.id]);
  });

  it("says when the activity logs could not be searched and searches them again on request", async () => {
    const actions = await renderPage();
    actions.searchBookmarks.mockRejectedValueOnce(new Error("offline"));
    await search("contrast");
    await waitForHostSearch();
    // Only the steps contain the text, so nothing matches yet; the note tells this from a real "no match".
    expect(container.querySelectorAll("[data-bookmark-id]")).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not search the activity logs");

    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    await waitForHostSearch();
    expect(actions.searchBookmarks).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-bookmark-id="saved-run"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("removes each saved item through its own callback and reloads without opening it", async () => {
    const actions = await renderPage();
    actions.listBookmarkEntries.mockResolvedValue([entryOf(run)]);
    await click('[data-bookmark-id="saved-chat"] [title="Remove from bookmarks"]');
    expect(actions.onRemoveChatBookmarkById).toHaveBeenCalledWith(chat.id);
    expect(actions.onRemoveRunBookmarkById).not.toHaveBeenCalled();
    expect(container.querySelector('[data-bookmark-id="saved-chat"]')).toBeNull();
    actions.listBookmarkEntries.mockResolvedValue([]);
    await click('[data-bookmark-id="saved-run"] [title="Remove from bookmarks"]');
    expect(actions.onRemoveRunBookmarkById).toHaveBeenCalledWith(run.id);
    expect(actions.onSelectBookmark).not.toHaveBeenCalled();
    expect(actions.listBookmarkEntries).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("No bookmarks yet");
  });

  it.each([
    { id: "saved-run", callback: "onRemoveRunBookmarkById", left: chat },
    { id: "saved-chat", callback: "onRemoveChatBookmarkById", left: run },
  ] as const)("waits for $id removal before refreshing saved items", async ({ id, callback, left }) => {
    const actions = await renderPage();
    let finishRemoval!: () => void;
    actions[callback].mockReturnValueOnce(new Promise<void>((resolve) => { finishRemoval = resolve; }));
    await click(`[data-bookmark-id="${id}"] [title="Remove from bookmarks"]`);
    expect(actions[callback]).toHaveBeenCalledWith(id);
    expect(actions.listBookmarkEntries).toHaveBeenCalledTimes(1);
    expect(container.querySelector(`[data-bookmark-id="${id}"]`)).not.toBeNull();

    actions.listBookmarkEntries.mockResolvedValue([entryOf(left)]);
    await act(async () => finishRemoval());
    expect(actions.listBookmarkEntries).toHaveBeenCalledTimes(2);
    expect(container.querySelector(`[data-bookmark-id="${id}"]`)).toBeNull();
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
