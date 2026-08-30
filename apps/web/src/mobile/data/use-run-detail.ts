import { useCallback, useEffect, useRef, useState } from "react";
import type { RunDetail, RunEvent, RunWorktreeDiffResult } from "@buildwarden/shared";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { applyLiveRunEventToDetail, mergeOrderedRecords } from "@buildwarden/renderer/logic";
import { errorMessage } from "../lib/format";

const RELOAD_DEBOUNCE_MS = 400;

export interface RunDetailStore {
  detail: RunDetail | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  historyLoading: boolean;
  loadEarlierHistory: () => Promise<void>;
  /** Worktree diff text; empty until {@link loadDiff} has been called at least once. */
  diff: string;
  diffLoading: boolean;
  diffError: string | null;
  diffUnavailable: boolean;
  loadDiff: () => Promise<void>;
}

/**
 * Loads one run and keeps it live.
 *
 * The worktree diff is fetched separately and only on demand: `getRunWorktreeDiff` is the slow
 * call on large repos, and on a phone it is behind a tab the user may never open.
 */
export const useRunDetail = (client: BuildWardenClient, runId: string | null): RunDetailStore => {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const detailRef = useRef<RunDetail | null>(null);
  detailRef.current = detail;
  const [loading, setLoading] = useState(Boolean(runId));
  const [error, setError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffUnavailable, setDiffUnavailable] = useState(false);
  const diffRequested = useRef(false);
  const timerRef = useRef<number | null>(null);
  // Both fetches are keyed by a runId that changes under them as the user navigates. On a phone
  // link the previous run's response can easily land after the new one's, so every write is gated
  // on still being the newest request.
  const loadRequestRef = useRef(0);
  const activeLoadRequestRef = useRef<number | null>(null);
  const liveEventRevisionRef = useRef(0);
  const recentLiveEventsRef = useRef<Array<{ revision: number; event: RunEvent }>>([]);
  const diffRequestRef = useRef(0);
  const forgeProbeRunIdRef = useRef<string | null>(null);

  const load = useCallback(async (silent: boolean) => {
    const requestId = ++loadRequestRef.current;
    activeLoadRequestRef.current = requestId;
    const revisionAtStart = liveEventRevisionRef.current;
    if (!runId) {
      recentLiveEventsRef.current = [];
      activeLoadRequestRef.current = null;
      setDetail(null);
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const next = await client.getRunDetail(runId);
      if (loadRequestRef.current !== requestId) return;
      const revisionAtCompletion = liveEventRevisionRef.current;
      const merged = recentLiveEventsRef.current
        .filter(({ revision, event }) => revision > revisionAtStart && event.runId === runId)
        .reduce((current, { event }) => applyLiveRunEventToDetail(current, event), next);
      recentLiveEventsRef.current = recentLiveEventsRef.current.filter(({ revision }) => revision > revisionAtCompletion);
      setDetail((current) => {
        const currentPage = current?.historyPage;
        const historyWasExpanded = silent && current?.run.id === merged.run.id && Boolean(currentPage &&
          (currentPage.beforeCursor !== merged.historyPage?.beforeCursor || currentPage.hasMore === false));
        return historyWasExpanded
          ? { ...merged, steps: mergeOrderedRecords(merged.steps, current!.steps), historyPage: currentPage }
          : merged;
      });
      setError(null);
    } catch (caught) {
      if (loadRequestRef.current !== requestId) return;
      setError(errorMessage(caught, "Could not load this run."));
    } finally {
      if (activeLoadRequestRef.current === requestId) activeLoadRequestRef.current = null;
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }, [client, runId]);

  const reload = useCallback(() => load(false), [load]);

  const loadEarlierHistory = useCallback(async () => {
    if (!runId || historyLoading) return;
    const page = detailRef.current?.historyPage;
    if (!page?.hasMore || !page.beforeCursor) return;
    const request = { beforeCursor: page.beforeCursor, snapshotRevision: page.snapshotRevision };
    setHistoryLoading(true);
    try {
      const result = await client.getEarlierRunHistory(runId, request);
      if (result.stale) {
        await load(false);
        return;
      }
      setDetail((current) => current?.historyPage?.beforeCursor === request?.beforeCursor
        ? { ...current, steps: mergeOrderedRecords(result.steps, current.steps), historyPage: result.page }
        : current);
    } finally {
      setHistoryLoading(false);
    }
  }, [client, historyLoading, load, runId]);

  useEffect(() => {
    let active = true;
    diffRequested.current = false;
    setDiff("");
    setDiffError(null);
    setDiffUnavailable(false);
    void load(false);
    if (runId && forgeProbeRunIdRef.current !== runId) {
      forgeProbeRunIdRef.current = runId;
      void client.refreshRunForgeRequest(runId)
        .then(() => active ? load(true) : undefined)
        .catch(() => undefined);
    }
    return () => { active = false; };
  }, [client, load, runId]);

  const loadDiff = useCallback(async () => {
    if (!runId) return;
    const requestId = ++diffRequestRef.current;
    diffRequested.current = true;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const result: RunWorktreeDiffResult = await client.getRunWorktreeDiff(runId);
      if (diffRequestRef.current !== requestId) return;
      setDiff(result.diff ?? "");
      setDiffUnavailable(result.worktreeUnavailable === true);
    } catch (caught) {
      if (diffRequestRef.current !== requestId) return;
      setDiffError(errorMessage(caught, "Could not load the diff."));
    } finally {
      if (diffRequestRef.current === requestId) setDiffLoading(false);
    }
  }, [client, runId]);

  useEffect(() => {
    if (!runId) return;
    const unsubscribe = client.onRunEvent((event) => {
      if (event.runId !== runId) return;
      const revision = ++liveEventRevisionRef.current;
      if (activeLoadRequestRef.current !== null) recentLiveEventsRef.current.push({ revision, event });
      if (event.step || event.run) {
        setDetail((current) => current ? applyLiveRunEventToDetail(current, event) : current);
      }
      if (event.step && event.type !== "diff-updated") return;
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void load(true);
        // Only keep the diff warm once the user has actually opened it.
        if (diffRequested.current) void loadDiff();
      }, RELOAD_DEBOUNCE_MS);
    });
    const unsubscribeForge = client.onRunForgeRequestChanged((event) => {
      if (event.runId !== runId) return;
      void load(true);
    });
    return () => {
      unsubscribe();
      unsubscribeForge();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [client, load, loadDiff, runId]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void load(true);
      if (runId) {
        void client.refreshRunForgeRequest(runId).catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [client, load, runId]);

  return {
    detail,
    loading,
    error,
    reload,
    historyLoading,
    loadEarlierHistory,
    diff,
    diffLoading,
    diffError,
    diffUnavailable,
    loadDiff,
  };
};
