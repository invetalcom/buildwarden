import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatDetail, ChatEvent } from "@buildwarden/shared";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { applyLiveChatEventToDetail } from "@buildwarden/renderer/logic";
import { errorMessage } from "../lib/format";

const RELOAD_DEBOUNCE_MS = 300;

export interface ChatDetailStore {
  detail: ChatDetail | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export const useChatDetail = (client: BuildWardenClient, chatId: string | null): ChatDetailStore => {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(chatId));
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeLoadRequestRef = useRef<number | null>(null);
  const liveEventRevisionRef = useRef(0);
  const recentLiveEventsRef = useRef<Array<{ revision: number; event: ChatEvent }>>([]);
  // The chatId changes under an in-flight fetch as the user navigates; only the newest request may
  // write state, or a slow response for the previous chat overwrites this one.
  const requestRef = useRef(0);

  const load = useCallback(async (silent: boolean) => {
    const requestId = ++requestRef.current;
    activeLoadRequestRef.current = requestId;
    const revisionAtStart = liveEventRevisionRef.current;
    if (!chatId) {
      recentLiveEventsRef.current = [];
      activeLoadRequestRef.current = null;
      setDetail(null);
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const next = await client.getChatDetail(chatId);
      if (requestRef.current !== requestId) return;
      const revisionAtCompletion = liveEventRevisionRef.current;
      const merged = recentLiveEventsRef.current
        .filter(({ revision, event }) => revision > revisionAtStart && event.chatId === chatId)
        .reduce((current, { event }) => applyLiveChatEventToDetail(current, event), next);
      recentLiveEventsRef.current = recentLiveEventsRef.current.filter(({ revision }) => revision > revisionAtCompletion);
      setDetail(merged);
      setError(null);
    } catch (caught) {
      if (requestRef.current !== requestId) return;
      setError(errorMessage(caught, "Could not load this chat."));
    } finally {
      if (activeLoadRequestRef.current === requestId) activeLoadRequestRef.current = null;
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [client, chatId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!chatId) return;
    const unsubscribe = client.onChatEvent((event) => {
      if (event.chatId !== chatId) return;
      const revision = ++liveEventRevisionRef.current;
      if (activeLoadRequestRef.current !== null) recentLiveEventsRef.current.push({ revision, event });
      if (event.step || event.chat) {
        setDetail((current) => current ? applyLiveChatEventToDetail(current, event) : current);
      }
      if (event.step) return;
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void load(true);
      }, RELOAD_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [chatId, client, load]);

  return { detail, loading, error, reload: () => load(false) };
};
