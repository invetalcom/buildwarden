import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatDetail } from "@buildwarden/shared";
import type { BuildWardenClient } from "@buildwarden/renderer";
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

  const load = useCallback(async (silent: boolean) => {
    if (!chatId) {
      setDetail(null);
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      setDetail(await client.getChatDetail(chatId));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load this chat."));
    } finally {
      setLoading(false);
    }
  }, [client, chatId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!chatId) return;
    const unsubscribe = client.onChatEvent((event) => {
      if (event.chatId !== chatId || timerRef.current !== null) return;
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
