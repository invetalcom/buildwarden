import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSnapshot } from "@buildwarden/shared";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { EMPTY_SNAPSHOT } from "@buildwarden/renderer/logic";
import { errorMessage } from "../lib/format";

const REFRESH_DEBOUNCE_MS = 250;
const POLL_INTERVAL_MS = 3000;

export interface SnapshotStore {
  snapshot: AppSnapshot;
  loaded: boolean;
  error: string | null;
  /** True while a background refresh is in flight; the UI keeps showing the previous snapshot. */
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * Owns the app snapshot for the mobile UI.
 *
 * Mobile-specific behaviour beyond the desktop equivalent: phones suspend WebSockets when the app
 * is backgrounded and never deliver the events that were missed, so the snapshot is re-fetched on
 * every `visibilitychange` back to visible and on `online`. Without that the UI silently shows a
 * stale run list after the phone has been in a pocket.
 */
export const useSnapshot = (client: BuildWardenClient): SnapshotStore => {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const disposed = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await client.refreshSnapshot();
      if (disposed.current) return;
      setSnapshot(next);
      setLoaded(true);
      setError(null);
    } catch (caught) {
      if (!disposed.current) setError(errorMessage(caught, "Could not reach the BuildWarden host."));
    } finally {
      if (!disposed.current) setRefreshing(false);
    }
  }, [client]);

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const initial = await client.getSnapshot();
        if (!cancelled) {
          setSnapshot(initial);
          setLoaded(true);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(errorMessage(caught, "Could not reach the BuildWarden host."));
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    const unsubscribers = [
      client.onRunEvent(scheduleRefresh),
      client.onChatEvent(scheduleRefresh),
      client.onOrchestrationChanged(scheduleRefresh),
      client.onProjectLoopChanged(scheduleRefresh),
      client.onProjectTaskChanged(scheduleRefresh),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [client, scheduleRefresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (client.capabilities.liveEvents) return;
    const intervalId = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [client.capabilities.liveEvents, refresh]);

  return { snapshot, loaded, error, refreshing, refresh };
};
