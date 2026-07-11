import {
  APP_SETTING_KEYS,
  parseRunWorkspaceLayoutsSetting,
  type AppSnapshot,
  type DesktopApi,
  type RunWorkspaceLayoutPreference,
  type RunWorkspaceLayoutPreferencesByRunId,
} from "@buildwarden/shared";
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { reportRendererError } from "../../lib/report-renderer-error";
import { cloneDefaultRunWorkspaceLayoutPreference } from "./app-model";

interface UseRunWorkspaceLayoutsInput {
  buildwarden: DesktopApi | undefined;
  selectedRunId: string | null | undefined;
  settings: AppSnapshot["settings"];
  setError: Dispatch<SetStateAction<string | null>>;
}

export const useRunWorkspaceLayouts = ({ buildwarden, selectedRunId, settings, setError }: UseRunWorkspaceLayoutsInput) => {
  const [runWorkspaceShowActivity, setRunWorkspaceShowActivity] = useState(true);
  const [runWorkspaceShowDiff, setRunWorkspaceShowDiff] = useState(false);
  const [runWorkspaceShowTerminal, setRunWorkspaceShowTerminal] = useState(false);
  const [runWorkspaceShowBrowser, setRunWorkspaceShowBrowser] = useState(false);
  const [runWorkspaceShowNotes, setRunWorkspaceShowNotes] = useState(false);
  const [runWorkspaceShowChat, setRunWorkspaceShowChat] = useState(false);
  const [runWorkspaceSecondaryPosition, setRunWorkspaceSecondaryPosition] = useState<"right" | "bottom">("right");
  const [runWorkspaceLayoutsByRunId, setRunWorkspaceLayoutsByRunId] = useState<RunWorkspaceLayoutPreferencesByRunId>({});

  useEffect(() => {
    setRunWorkspaceLayoutsByRunId(parseRunWorkspaceLayoutsSetting(settings[APP_SETTING_KEYS.runWorkspaceLayouts]));
  }, [settings]);

  const selectedLayout = useMemo<RunWorkspaceLayoutPreference>(() => {
    if (!selectedRunId || typeof selectedRunId !== "string") {
      return cloneDefaultRunWorkspaceLayoutPreference();
    }
    return runWorkspaceLayoutsByRunId[selectedRunId] ?? cloneDefaultRunWorkspaceLayoutPreference();
  }, [runWorkspaceLayoutsByRunId, selectedRunId]);

  useEffect(() => {
    setRunWorkspaceShowActivity(selectedLayout.visiblePanels.activity);
    setRunWorkspaceShowDiff(selectedLayout.visiblePanels.diff);
    setRunWorkspaceShowTerminal(selectedLayout.visiblePanels.terminal);
    setRunWorkspaceShowBrowser(selectedLayout.visiblePanels.browser);
    setRunWorkspaceShowNotes(selectedLayout.visiblePanels.notes);
    setRunWorkspaceShowChat(selectedLayout.visiblePanels.chat);
    setRunWorkspaceSecondaryPosition(selectedLayout.secondaryPanelPosition);
  }, [selectedLayout]);

  const persistLayouts = useCallback(
    async (next: RunWorkspaceLayoutPreferencesByRunId) => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.setAppSetting(APP_SETTING_KEYS.runWorkspaceLayouts, JSON.stringify(next));
    },
    [buildwarden],
  );

  const updateRunWorkspaceLayout = useCallback(
    (runId: string, updater: (current: RunWorkspaceLayoutPreference) => RunWorkspaceLayoutPreference) => {
      setRunWorkspaceLayoutsByRunId((current) => {
        const next = { ...current, [runId]: updater(current[runId] ?? cloneDefaultRunWorkspaceLayoutPreference()) };
        void persistLayouts(next).catch((caught) => {
          reportRendererError("renderer.run-layout.persist", caught, { runId });
          setError(caught instanceof Error ? caught.message : "Could not save run layout.");
        });
        return next;
      });
    },
    [persistLayouts, setError],
  );

  const removeRunWorkspaceLayout = useCallback(
    (runId: string) => {
      setRunWorkspaceLayoutsByRunId((current) => {
        if (!(runId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[runId];
        void persistLayouts(next).catch((caught) => {
          reportRendererError("renderer.run-layout.remove", caught, { runId });
          setError(caught instanceof Error ? caught.message : "Could not remove run layout.");
        });
        return next;
      });
    },
    [persistLayouts, setError],
  );

  const removeRunWorkspaceLayoutsForRuns = useCallback(
    (runIds: string[]) => {
      setRunWorkspaceLayoutsByRunId((current) => {
        const next = { ...current };
        const changed = runIds.reduce((didChange, runId) => {
          if (!(runId in next)) {
            return didChange;
          }
          delete next[runId];
          return true;
        }, false);
        if (changed) {
          void persistLayouts(next).catch((caught) => {
            setError(caught instanceof Error ? caught.message : "Could not remove deleted project layouts.");
          });
        }
        return changed ? next : current;
      });
    },
    [persistLayouts, setError],
  );

  return {
    removeRunWorkspaceLayout,
    removeRunWorkspaceLayoutsForRuns,
    runWorkspaceLayoutsByRunId,
    selectedRunWorkspaceLayout: selectedLayout,
    runWorkspaceSecondaryPosition,
    runWorkspaceShowActivity,
    runWorkspaceShowBrowser,
    runWorkspaceShowChat,
    runWorkspaceShowDiff,
    runWorkspaceShowNotes,
    runWorkspaceShowTerminal,
    setRunWorkspaceSecondaryPosition,
    setRunWorkspaceShowActivity,
    setRunWorkspaceShowBrowser,
    setRunWorkspaceShowChat,
    setRunWorkspaceShowDiff,
    setRunWorkspaceShowNotes,
    setRunWorkspaceShowTerminal,
    updateRunWorkspaceLayout,
  };
};
