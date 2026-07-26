import { useCallback, useEffect, useRef, useState } from "react";
import type { RunDetail, RunWorktreeDiffResult } from "@buildwarden/shared";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { errorMessage } from "../lib/format";

const RELOAD_DEBOUNCE_MS = 400;

export interface RunDetailStore {
  detail: RunDetail | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
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
  const [loading, setLoading] = useState(Boolean(runId));
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffUnavailable, setDiffUnavailable] = useState(false);
  const diffRequested = useRef(false);
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async (silent: boolean) => {
    if (!runId) {
      setDetail(null);
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const next = await client.getRunDetail(runId);
      setDetail(next);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load this run."));
    } finally {
      setLoading(false);
    }
  }, [client, runId]);

  const reload = useCallback(() => load(false), [load]);

  useEffect(() => {
    diffRequested.current = false;
    setDiff("");
    setDiffError(null);
    setDiffUnavailable(false);
    void load(false);
  }, [load]);

  const loadDiff = useCallback(async () => {
    if (!runId) return;
    diffRequested.current = true;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const result: RunWorktreeDiffResult = await client.getRunWorktreeDiff(runId);
      setDiff(result.diff ?? "");
      setDiffUnavailable(result.worktreeUnavailable === true);
    } catch (caught) {
      setDiffError(errorMessage(caught, "Could not load the diff."));
    } finally {
      setDiffLoading(false);
    }
  }, [client, runId]);

  useEffect(() => {
    if (!runId) return;
    const unsubscribe = client.onRunEvent((event) => {
      if (event.runId !== runId) return;
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void load(true);
        // Only keep the diff warm once the user has actually opened it.
        if (diffRequested.current) void loadDiff();
      }, RELOAD_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [client, load, loadDiff, runId]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  return { detail, loading, error, reload, diff, diffLoading, diffError, diffUnavailable, loadDiff };
};
