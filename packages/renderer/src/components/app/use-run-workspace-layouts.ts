import {
  type DesktopApi,
  type RunWorkspaceLayoutPreference,
  type RunWorkspaceLayoutPreferencesByRunId,
} from "@buildwarden/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { reportRendererError } from "../../lib/report-renderer-error";
import { cloneDefaultRunWorkspaceLayoutPreference } from "./app-model";

type LayoutUpdater = (current: RunWorkspaceLayoutPreference) => RunWorkspaceLayoutPreference;

interface UseRunWorkspaceLayoutsInput {
  buildwarden: DesktopApi | undefined;
  selectedRunId: string | null | undefined;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * Layouts load once per client and save one run at a time, so they stay out of the
 * app snapshot and a panel change no longer rewrites every run's layout.
 */
export const useRunWorkspaceLayouts = ({ buildwarden, selectedRunId, setError }: UseRunWorkspaceLayoutsInput) => {
  const [runWorkspaceShowActivity, setRunWorkspaceShowActivity] = useState(true);
  const [runWorkspaceShowAgents, setRunWorkspaceShowAgents] = useState(false);
  const [runWorkspaceShowValidation, setRunWorkspaceShowValidation] = useState(false);
  const [runWorkspaceShowDiff, setRunWorkspaceShowDiff] = useState(false);
  const [runWorkspaceShowTerminal, setRunWorkspaceShowTerminal] = useState(false);
  const [runWorkspaceShowBrowser, setRunWorkspaceShowBrowser] = useState(false);
  const [runWorkspaceShowProcesses, setRunWorkspaceShowProcesses] = useState(false);
  const [runWorkspaceShowNotes, setRunWorkspaceShowNotes] = useState(false);
  const [runWorkspaceShowChat, setRunWorkspaceShowChat] = useState(false);
  const [runWorkspaceShowPullRequest, setRunWorkspaceShowPullRequest] = useState(false);
  const [runWorkspaceSecondaryPosition, setRunWorkspaceSecondaryPosition] = useState<"right" | "bottom">("right");
  const [runWorkspaceLayoutsByRunId, setRunWorkspaceLayoutsByRunId] = useState<RunWorkspaceLayoutPreferencesByRunId>({});
  const runWorkspaceLayoutsByRunIdRef = useRef<RunWorkspaceLayoutPreferencesByRunId>({});
  const layoutsLoadedRef = useRef(false);
  // Edits made before the saved layouts arrive, replayed onto them once loaded so
  // an early panel toggle (for example from a deep link) cannot save defaults over them.
  const pendingLayoutUpdatersRef = useRef(new Map<string, LayoutUpdater[]>());
  // Runs deleted before the saved layouts arrive; their layouts must not come back with the list.
  const removedWhileLoadingRef = useRef(new Set<string>());

  const persistLayout = useCallback((runId: string, layout: RunWorkspaceLayoutPreference) => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }
    void buildwarden.setRunWorkspaceLayout(runId, layout).catch((caught: unknown) => {
      reportRendererError("renderer.run-layout.persist", caught, { runId });
      setError(caught instanceof Error ? caught.message : "Could not save run layout.");
    });
  }, [buildwarden, setError]);
  // Loading depends only on the client; a new error callback must not reload and reset layouts.
  const persistLayoutRef = useRef(persistLayout);
  useEffect(() => {
    persistLayoutRef.current = persistLayout;
  }, [persistLayout]);

  useEffect(() => {
    runWorkspaceLayoutsByRunIdRef.current = {};
    setRunWorkspaceLayoutsByRunId({});
    pendingLayoutUpdatersRef.current = new Map();
    removedWhileLoadingRef.current = new Set();
    layoutsLoadedRef.current = !buildwarden;
    if (!buildwarden) return;
    let cancelled = false;
    const applyLoaded = (stored: RunWorkspaceLayoutPreferencesByRunId) => {
      if (cancelled) return;
      const pending = pendingLayoutUpdatersRef.current;
      const removed = removedWhileLoadingRef.current;
      pendingLayoutUpdatersRef.current = new Map();
      removedWhileLoadingRef.current = new Set();
      layoutsLoadedRef.current = true;
      const next = { ...stored };
      for (const runId of removed) delete next[runId];
      for (const [runId, updaters] of pending) {
        const layout = updaters.reduce((current, updater) => updater(current), stored[runId] ?? cloneDefaultRunWorkspaceLayoutPreference());
        next[runId] = layout;
        persistLayoutRef.current(runId, layout);
      }
      runWorkspaceLayoutsByRunIdRef.current = next;
      setRunWorkspaceLayoutsByRunId(next);
    };
    buildwarden.listRunWorkspaceLayouts().then(applyLoaded, (caught: unknown) => {
      if (cancelled) return;
      reportRendererError("renderer.run-layout.load", caught);
      // Keep and save what was edited; without the saved layouts, defaults are the base.
      applyLoaded({});
    });
    return () => {
      cancelled = true;
    };
  }, [buildwarden]);

  const selectedLayout = useMemo<RunWorkspaceLayoutPreference>(() => {
    if (!selectedRunId || typeof selectedRunId !== "string") {
      return cloneDefaultRunWorkspaceLayoutPreference();
    }
    return runWorkspaceLayoutsByRunId[selectedRunId] ?? cloneDefaultRunWorkspaceLayoutPreference();
  }, [runWorkspaceLayoutsByRunId, selectedRunId]);

  useEffect(() => {
    setRunWorkspaceShowActivity(selectedLayout.visiblePanels.activity);
    setRunWorkspaceShowAgents(selectedLayout.visiblePanels.agents);
    setRunWorkspaceShowValidation(selectedLayout.visiblePanels.validation);
    setRunWorkspaceShowDiff(selectedLayout.visiblePanels.diff);
    setRunWorkspaceShowTerminal(selectedLayout.visiblePanels.terminal);
    setRunWorkspaceShowBrowser(selectedLayout.visiblePanels.browser);
    setRunWorkspaceShowProcesses(selectedLayout.visiblePanels.processes);
    setRunWorkspaceShowNotes(selectedLayout.visiblePanels.notes);
    setRunWorkspaceShowChat(selectedLayout.visiblePanels.chat);
    setRunWorkspaceShowPullRequest(selectedLayout.visiblePanels["pull-request"]);
    setRunWorkspaceSecondaryPosition(selectedLayout.secondaryPanelPosition);
  }, [selectedLayout]);

  const updateRunWorkspaceLayout = useCallback(
    (runId: string, updater: LayoutUpdater) => {
      const current = runWorkspaceLayoutsByRunIdRef.current;
      const layout = updater(current[runId] ?? cloneDefaultRunWorkspaceLayoutPreference());
      const next = { ...current, [runId]: layout };
      runWorkspaceLayoutsByRunIdRef.current = next;
      setRunWorkspaceLayoutsByRunId(next);
      if (!layoutsLoadedRef.current) {
        const pending = pendingLayoutUpdatersRef.current;
        pending.set(runId, [...(pending.get(runId) ?? []), updater]);
        return;
      }
      persistLayout(runId, layout);
    },
    [persistLayout],
  );

  /** Forgets deleted runs. The desktop database drops their rows with the run; remote browsers store their own. */
  const removeRunWorkspaceLayoutsForRuns = useCallback(
    (runIds: string[]) => {
      const current = runWorkspaceLayoutsByRunIdRef.current;
      let removed = runIds.filter((runId) => runId in current);
      if (!layoutsLoadedRef.current) {
        // Saved layouts are not known yet, so any of these runs may still have one stored.
        for (const runId of runIds) {
          removedWhileLoadingRef.current.add(runId);
          pendingLayoutUpdatersRef.current.delete(runId);
        }
        removed = [...new Set(runIds)];
      }
      if (removed.length === 0) {
        return;
      }
      const next: RunWorkspaceLayoutPreferencesByRunId = { ...current };
      for (const runId of removed) delete next[runId];
      runWorkspaceLayoutsByRunIdRef.current = next;
      setRunWorkspaceLayoutsByRunId(next);
      if (!buildwarden) return;
      void Promise.all(removed.map((runId) => buildwarden.setRunWorkspaceLayout(runId, null))).catch((caught: unknown) => {
        reportRendererError("renderer.run-layout.remove-many", caught, { runIds: removed });
      });
    },
    [buildwarden],
  );

  return {
    removeRunWorkspaceLayoutsForRuns,
    runWorkspaceLayoutsByRunId,
    selectedRunWorkspaceLayout: selectedLayout,
    runWorkspaceSecondaryPosition,
    runWorkspaceShowActivity,
    runWorkspaceShowAgents,
    runWorkspaceShowValidation,
    runWorkspaceShowBrowser,
    runWorkspaceShowChat,
    runWorkspaceShowDiff,
    runWorkspaceShowNotes,
    runWorkspaceShowProcesses,
    runWorkspaceShowTerminal,
    runWorkspaceShowPullRequest,
    setRunWorkspaceSecondaryPosition,
    setRunWorkspaceShowActivity,
    setRunWorkspaceShowAgents,
    setRunWorkspaceShowValidation,
    setRunWorkspaceShowBrowser,
    setRunWorkspaceShowChat,
    setRunWorkspaceShowDiff,
    setRunWorkspaceShowNotes,
    setRunWorkspaceShowProcesses,
    setRunWorkspaceShowTerminal,
    setRunWorkspaceShowPullRequest,
    updateRunWorkspaceLayout,
  };
};
