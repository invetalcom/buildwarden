/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatDetail, ChatEvent, ChatHistoryPage, ChatStepRecord, DesktopApi } from "@buildwarden/shared";
import { createElectronBuildWardenClient } from "./buildwarden-client-core";
import { useChatDetail } from "./use-chat-detail";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const step = (id: string, content = id): ChatStepRecord => ({
  id, chatId: "a", eventType: "output", title: "Agent output", content, metadataJson: "{}", createdAt: `2026-01-01T00:00:${id === "old" ? "00" : "01"}Z`,
});
const detail = (id: string, steps = [step("text")]): ChatDetail => ({
  chat: { id, status: "running", modelId: "model", runId: null } as ChatDetail["chat"],
  steps: steps.map((entry) => ({ ...entry, chatId: id })),
  historyPage: { beforeCursor: "cursor", hasMore: true, snapshotRevision: "revision" },
});
const event = (chatId: string, content: string): ChatEvent => ({
  runId: chatId, chatId, type: "output", title: "Agent output", content, createdAt: "2026-01-01",
  step: { ...step("text", content), chatId },
});

let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const harness = () => {
  const listeners = new Set<(event: ChatEvent) => void>();
  const onChatEvent = vi.fn((listener: (event: ChatEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  const getChatDetail = vi.fn<(id: string) => Promise<ChatDetail>>().mockImplementation(async (id) => detail(id));
  const getEarlierChatHistory = vi.fn<DesktopApi["getEarlierChatHistory"]>();
  const onEvent = vi.fn();
  const client = createElectronBuildWardenClient({ getChatDetail, getEarlierChatHistory, onChatEvent } as unknown as DesktopApi);
  let latest!: ReturnType<typeof useChatDetail>;
  const Probe = ({ id }: { id: string | null }) => {
    latest = useChatDetail(client, id, onEvent);
    return <div>{latest.detail?.steps.map((item) => item.content).join("|") ?? "Loading"}</div>;
  };
  return {
    getChatDetail, getEarlierChatHistory, onEvent, onChatEvent, listeners,
    current: () => latest,
    select: (id: string | null) => act(() => root.render(<Probe id={id} />)),
    emit: (value: ChatEvent) => act(() => { for (const listener of listeners) listener(value); }),
  };
};

describe("chat detail ownership", () => {
  it("loads once, subscribes once, and applies step events without another fetch", async () => {
    const h = harness();
    await h.select("a");
    expect(h.getChatDetail).toHaveBeenCalledTimes(1);
    expect(h.onChatEvent).toHaveBeenCalledTimes(1);
    await h.emit(event("a", "streamed"));
    expect(h.current().detail?.steps[0].content).toBe("streamed");
    expect(h.getChatDetail).toHaveBeenCalledTimes(1);
    expect(h.onEvent).toHaveBeenCalledOnce();
  });

  it("selects uncached chats immediately and never lets a late fetch replace the selected chat", async () => {
    const h = harness();
    const a = deferred<ChatDetail>();
    const b = deferred<ChatDetail>();
    h.getChatDetail.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await h.select("a");
    await h.select("b");
    expect(h.current().detail).toBeNull();
    await act(() => b.resolve(detail("b")));
    await act(() => a.resolve(detail("a")));
    expect(h.current().detail?.chat.id).toBe("b");
    expect(h.onChatEvent).toHaveBeenCalledTimes(1);
  });

  it("shows cached content immediately on revisit and retains live events across revalidation", async () => {
    const h = harness();
    await h.select("a");
    await h.select("b");
    await h.emit(event("a", "background update"));
    const reload = deferred<ChatDetail>();
    h.getChatDetail.mockReturnValueOnce(reload.promise);
    await h.select("a");
    expect(h.current().detail?.steps[0].content).toBe("background update");
    await h.emit({ ...event("a", "newer than fetch"), chat: { ...detail("a").chat, status: "completed" } });
    await act(() => reload.resolve(detail("a")));
    expect(h.current().detail?.steps[0].content).toBe("newer than fetch");
    expect(h.current().detail?.chat.status).toBe("completed");
  });

  it("replays events received before the initial detail arrives", async () => {
    const h = harness();
    const pending = deferred<ChatDetail>();
    h.getChatDetail.mockReturnValueOnce(pending.promise);
    await h.select("a");
    await h.emit(event("a", "first"));
    await h.emit(event("a", "latest"));
    await act(() => pending.resolve(detail("a")));
    expect(h.current().detail?.steps.map((entry) => entry.content)).toEqual(["latest"]);
  });

  it("bounds the recent cache to six chats", async () => {
    const h = harness();
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) await h.select(id);
    h.getChatDetail.mockReturnValueOnce(deferred<ChatDetail>().promise);
    await h.select("b");
    expect(h.current().detail?.chat.id).toBe("b");
    h.getChatDetail.mockReturnValueOnce(deferred<ChatDetail>().promise);
    await h.select("a");
    expect(h.current().detail).toBeNull();
  });

  it("keeps expanded history across refreshes and deduplicates earlier-page requests", async () => {
    const h = harness();
    await h.select("a");
    const older = deferred<ChatHistoryPage>();
    h.getEarlierChatHistory.mockReturnValueOnce(older.promise);
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(() => { first = h.current().loadEarlier("a"); second = h.current().loadEarlier("a"); });
    expect(first).toBe(second);
    expect(h.getEarlierChatHistory).toHaveBeenCalledOnce();
    await h.emit(event("a", "live"));
    await act(async () => {
      older.resolve({ steps: [step("old"), step("text", "obsolete")], page: { beforeCursor: null, hasMore: false, snapshotRevision: "complete" }, stale: false });
      await first;
    });
    expect(h.current().detail?.steps.map((entry) => entry.content)).toEqual(["old", "live"]);
    await act(() => h.current().refresh("a"));
    expect(h.current().detail?.steps.map((entry) => entry.id)).toEqual(["old", "text"]);
    expect(h.current().detail?.historyPage?.hasMore).toBe(false);
    await h.select(null);
    await h.select("a");
    expect(h.current().detail?.steps[0].id).toBe("old");
  });

  it("clears an earlier-history error after a successful retry without a full refresh", async () => {
    const h = harness();
    await h.select("a");
    h.getEarlierChatHistory.mockRejectedValueOnce(new Error("Temporary network failure"));
    await act(() => h.current().loadEarlier("a"));
    expect(h.current().error).toBe("Temporary network failure");

    h.getEarlierChatHistory.mockResolvedValueOnce({
      steps: [step("old")], page: { beforeCursor: null, hasMore: false, snapshotRevision: "complete" }, stale: false,
    });
    await act(() => h.current().loadEarlier("a"));
    expect(h.current().error).toBeNull();
    expect(h.current().detail?.steps.map((entry) => entry.id)).toEqual(["old", "text"]);
    expect(h.getChatDetail).toHaveBeenCalledOnce();
    expect(h.getEarlierChatHistory).toHaveBeenCalledTimes(2);
  });

  it("preserves a failed detail refresh when overlapping history succeeds until a full refresh recovers", async () => {
    const h = harness();
    await h.select("a");
    const older = deferred<ChatHistoryPage>();
    h.getEarlierChatHistory.mockReturnValueOnce(older.promise);
    let pending!: Promise<void>;
    await act(() => { pending = h.current().loadEarlier("a"); });

    h.getChatDetail.mockRejectedValueOnce(new Error("Chat refresh failed"));
    await act(() => h.current().refresh("a"));
    expect(h.current().error).toBe("Chat refresh failed");
    await act(async () => {
      older.resolve({ steps: [step("old")], page: { beforeCursor: null, hasMore: false, snapshotRevision: "complete" }, stale: false });
      await pending;
    });
    expect(h.current().detail?.steps.map((entry) => entry.id)).toEqual(["old", "text"]);
    expect(h.current().error).toBe("Chat refresh failed");

    await act(() => h.current().refresh("a"));
    expect(h.current().error).toBeNull();
  });

  it("preserves another chat's error when a pending history page succeeds after navigation", async () => {
    const h = harness();
    await h.select("a");
    const older = deferred<ChatHistoryPage>();
    h.getEarlierChatHistory.mockReturnValueOnce(older.promise);
    let pending!: Promise<void>;
    await act(() => { pending = h.current().loadEarlier("a"); });

    h.getChatDetail.mockRejectedValueOnce(new Error("Chat B is unavailable"));
    await h.select("b");
    expect(h.current().error).toBe("Chat B is unavailable");
    await act(async () => {
      older.resolve({ steps: [step("old")], page: { beforeCursor: null, hasMore: false, snapshotRevision: "complete" }, stale: false });
      await pending;
    });
    expect(h.current().error).toBe("Chat B is unavailable");
    expect(h.current().detail).toBeNull();
  });

  it("resets obsolete expanded history when an earlier-page cursor is stale", async () => {
    const h = harness();
    await h.select("a");
    h.getEarlierChatHistory.mockResolvedValueOnce({ steps: [step("old")], page: { beforeCursor: "older", hasMore: true, snapshotRevision: "older-revision" }, stale: false });
    await act(() => h.current().loadEarlier("a"));
    h.getEarlierChatHistory.mockResolvedValueOnce({ steps: [], page: detail("a").historyPage!, stale: true });
    await act(() => h.current().loadEarlier("a"));
    expect(h.current().detail?.steps.map((entry) => entry.id)).toEqual(["text"]);
  });

  it("coalesces status refreshes and waits for an older snapshot before refreshing", async () => {
    const h = harness();
    const pending = deferred<ChatDetail>();
    h.getChatDetail.mockReturnValueOnce(pending.promise);
    await h.select("a");
    for (let i = 0; i < 3; i++) await h.emit({ ...event("a", "finished"), step: undefined, type: "status" });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(h.getChatDetail).toHaveBeenCalledOnce();
    await act(() => pending.resolve(detail("a")));
    expect(h.getChatDetail).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect deleted history when pending requests finish", async () => {
    const h = harness();
    const pending = deferred<ChatDetail>();
    h.getChatDetail.mockReturnValueOnce(pending.promise);
    await h.select("a");
    await act(() => h.current().forget(["a"]));
    await h.select(null);
    await act(() => pending.resolve(detail("a")));
    h.getChatDetail.mockReturnValueOnce(deferred<ChatDetail>().promise);
    await h.select("a");
    expect(h.current().detail).toBeNull();
  });

  it("does not fetch hidden cached histories for status events or abandoned refresh timers", async () => {
    const h = harness();
    await h.select("a");
    const status = { ...event("a", "finished"), step: undefined, type: "status" as const, chat: { ...detail("a").chat, status: "completed" as const } };
    await h.emit(status);
    await h.select("b");
    await act(() => vi.advanceTimersByTimeAsync(300));
    await h.emit(status);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(h.getChatDetail).toHaveBeenCalledTimes(2);
    h.getChatDetail.mockReturnValueOnce(deferred<ChatDetail>().promise);
    await h.select("a");
    expect(h.current().detail?.chat.status).toBe("completed");
  });

  it("restores a cached chat from settings without overwriting background updates", async () => {
    const h = harness();
    await h.select("a");
    const saved = h.current().detail!;
    await h.select(null);
    await h.emit(event("a", "while in settings"));
    await act(() => h.current().seed(saved));
    h.getChatDetail.mockReturnValueOnce(deferred<ChatDetail>().promise);
    await h.select("a");
    expect(h.current().detail?.steps[0].content).toBe("while in settings");
  });

  it("reports initial errors and recovers on retry without a second subscription", async () => {
    const h = harness();
    h.getChatDetail.mockRejectedValueOnce(new Error("Offline"));
    await h.select("a");
    expect(h.current().error).toBe("Offline");
    await act(() => h.current().refresh("a"));
    expect(h.current().detail?.chat.id).toBe("a");
    expect(h.current().error).toBeNull();
    expect(h.onChatEvent).toHaveBeenCalledOnce();
  });
});
