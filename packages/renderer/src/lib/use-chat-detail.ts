import { useLatestRef } from "./use-latest-ref";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatDetail, ChatEvent } from "@buildwarden/shared";
import type { BuildWardenClient } from "./buildwarden-client-core";
import { applyLiveChatEventToDetail, mergeOrderedRecords } from "./live-state";
import { useStableCallback } from "./use-stable-callback";

const RECENT_CHAT_LIMIT = 6;
const REFRESH_DELAY_MS = 300;

interface CachedChat {
  detail: ChatDetail;
  expanded: boolean;
}

interface DetailRequest {
  promise: Promise<void>;
  steps: Map<string, NonNullable<ChatEvent["step"]>>;
  chat?: ChatEvent["chat"];
}

interface ChatFailure {
  chatId: string;
  message: string;
  source: "detail" | "history";
}

const createChatCache = () => {
  const entries = new Map<string, CachedChat>();
  const listeners = new Set<() => void>();
  return {
    entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    notify() {
      for (const listener of listeners) listener();
    },
  };
};

/** One owner for chat history, live updates, and the bounded recent-chat cache. */
export const useChatDetail = (
  client: BuildWardenClient,
  chatId: string | null,
  onEvent: (event: ChatEvent) => void,
) => {
  const [cache] = useState(createChatCache);
  const requests = useRef(new Map<string, DetailRequest>());
  const historyRequests = useRef(new Map<string, Promise<void>>());
  const refreshTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const selectedId = useLatestRef(chatId);
  const mounted = useRef(true);
  const detail = useSyncExternalStore(
    cache.subscribe,
    () => chatId ? cache.entries.get(chatId)?.detail ?? null : null,
    () => null,
  );
  const [failure, setFailure] = useState<ChatFailure | null>(null);
  const notifyEvent = useStableCallback(onEvent);

  const publish = useCallback((id: string, entry: CachedChat) => {
    cache.entries.delete(id);
    cache.entries.set(id, entry);
    while (cache.entries.size > RECENT_CHAT_LIMIT) {
      const oldest = [...cache.entries.keys()].find((key) => key !== selectedId.current);
      if (!oldest) break;
      cache.entries.delete(oldest);
    }
    if (mounted.current && selectedId.current === id) cache.notify();
  }, [cache, selectedId]);

  const clearRefresh = useCallback((id: string) => {
    clearTimeout(refreshTimers.current.get(id));
    refreshTimers.current.delete(id);
  }, []);

  const load = useCallback((id: string): Promise<void> => {
    const existing = requests.current.get(id);
    if (existing) return existing.promise;
    clearRefresh(id);
    const request: DetailRequest = { promise: Promise.resolve(), steps: new Map() };
    requests.current.set(id, request);
    request.promise = (async () => {
      try {
        const next = await client.getChatDetail(id);
        if (!mounted.current || requests.current.get(id) !== request) return;
        const previous = cache.entries.get(id);
        const expanded = previous?.expanded ?? false;
        // Events received after this request began win over its possibly older snapshot.
        const steps = mergeOrderedRecords([...request.steps.values()], expanded && previous
          ? mergeOrderedRecords(next.steps, previous.detail.steps)
          : next.steps);
        publish(id, {
          expanded,
          detail: { ...next, chat: request.chat ?? next.chat, steps,
            historyPage: expanded ? previous?.detail.historyPage : next.historyPage },
        });
        setFailure((current) => current?.chatId === id ? null : current);
      } catch (error) {
        if (mounted.current && selectedId.current === id && requests.current.get(id) === request) {
          setFailure({ chatId: id, source: "detail", message: error instanceof Error ? error.message : "Could not load this chat." });
        }
      } finally {
        if (requests.current.get(id) === request) requests.current.delete(id);
      }
    })();
    return request.promise;
  }, [cache.entries, clearRefresh, client, publish, selectedId]);

  const refresh = useCallback(async (id: string) => {
    clearRefresh(id);
    const pending = requests.current.get(id);
    if (pending) await pending.promise;
    if (mounted.current && (selectedId.current === id || cache.entries.has(id))) await load(id);
  }, [cache.entries, clearRefresh, load, selectedId]);

  const seed = useCallback((detail: ChatDetail) => {
    // Settings restoration must not replace a cached chat updated while hidden.
    if (!cache.entries.has(detail.chat.id)) publish(detail.chat.id, { detail, expanded: Boolean(detail.historyPage) });
  }, [cache, publish]);

  const forget = useCallback((ids: readonly string[]) => {
    for (const id of ids) {
      clearRefresh(id);
      cache.entries.delete(id);
      requests.current.delete(id);
      historyRequests.current.delete(id);
    }
    if (mounted.current) cache.notify();
  }, [cache, clearRefresh]);

  const loadEarlier = useCallback((id: string): Promise<void> => {
    const pending = historyRequests.current.get(id);
    if (pending) return pending;
    const page = cache.entries.get(id)?.detail.historyPage;
    if (!page?.hasMore || !page.beforeCursor) return Promise.resolve();
    const cursor = { beforeCursor: page.beforeCursor, snapshotRevision: page.snapshotRevision };
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await client.getEarlierChatHistory(id, cursor);
        if (!mounted.current || historyRequests.current.get(id) !== promise) return;
        const current = cache.entries.get(id);
        if (!current || current.detail.historyPage?.beforeCursor !== cursor.beforeCursor ||
          current.detail.historyPage.snapshotRevision !== cursor.snapshotRevision) return;
        if (result.stale) {
          // A changed prefix needs a fresh page, not a merge of obsolete history.
          cache.entries.set(id, { ...current, expanded: false });
          await refresh(id);
          return;
        }
        publish(id, { expanded: true, detail: { ...current.detail,
          steps: mergeOrderedRecords(current.detail.steps, result.steps), historyPage: result.page } });
        setFailure((currentFailure) =>
          currentFailure?.chatId === id && currentFailure.source === "history" ? null : currentFailure);
      } catch (error) {
        if (mounted.current && selectedId.current === id && historyRequests.current.get(id) === promise) {
          setFailure({ chatId: id, source: "history", message: error instanceof Error ? error.message : "Could not load earlier turns." });
        }
      } finally {
        if (historyRequests.current.get(id) === promise) historyRequests.current.delete(id);
      }
    });
    historyRequests.current.set(id, promise);
    return promise;
  }, [cache.entries, client, publish, refresh, selectedId]);

  useEffect(() => {
    mounted.current = true;
    const timers = refreshTimers.current;
    const pendingDetails = requests.current;
    const pendingHistory = historyRequests.current;
    const unsubscribe = client.onChatEvent((event) => {
      notifyEvent(event);
      const request = requests.current.get(event.chatId);
      if (request) {
        if (event.step) request.steps.set(event.step.id, event.step);
        if (event.chat) request.chat = event.chat;
      }
      const current = cache.entries.get(event.chatId);
      if (current && (event.step || event.chat)) {
        publish(event.chatId, { ...current, detail: applyLiveChatEventToDetail(current.detail, event) });
      }
      // Legacy/status events may describe persisted steps without carrying them.
      // Hidden cached chats revalidate when opened; don't fetch their histories.
      if (!event.step && selectedId.current === event.chatId && !refreshTimers.current.has(event.chatId)) {
        refreshTimers.current.set(event.chatId, setTimeout(() => {
          refreshTimers.current.delete(event.chatId);
          if (selectedId.current === event.chatId) void refresh(event.chatId);
        }, REFRESH_DELAY_MS));
      }
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pendingDetails.clear();
      pendingHistory.clear();
    };
  }, [cache, client, notifyEvent, publish, refresh, selectedId]);

  useEffect(() => {
    if (chatId) void load(chatId);
  }, [chatId, load]);

  return {
    detail,
    error: failure && failure.chatId === chatId ? failure.message : null,
    refresh,
    seed,
    forget,
    loadEarlier,
  };
};
