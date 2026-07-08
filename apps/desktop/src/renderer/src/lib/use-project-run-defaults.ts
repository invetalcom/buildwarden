import {
  APP_SETTING_KEYS,
  buildDefaultProjectRunDefaults,
  parseProjectRunDefaultsSetting,
  type ProjectRunDefaults,
  type ProjectRunDefaultsByProjectId,
  type RunMode,
  type RunWorkspaceType,
} from "@buildwarden/shared";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { reportRendererError } from "./report-renderer-error";

interface UseProjectRunDefaultsInput {
  /** Preload bridge; only `setAppSetting` is needed. Undefined outside Electron. */
  buildwarden: { setAppSetting(key: string, value: string): Promise<void> } | undefined;
  snapshotLoaded: boolean;
  /** Raw persisted value of {@link APP_SETTING_KEYS.projectRunDefaults}. */
  projectRunDefaultsSetting: string | undefined;
  models: ReadonlyArray<{ id: string }>;
  /** Last used run model id (global fallback when a project has no stored default). */
  preferredRunModelId: string;
  selectedProjectId: string;
  setRunMode: (value: RunMode) => void;
  setRunWorkspaceType: (value: RunWorkspaceType) => void;
  setRunBaseBranch: (value: string) => void;
  setRunReasoningEffort: (value: string) => void;
  setRunAnthropicEffort: (value: string) => void;
  setRunYoloMode: (value: boolean) => void;
  setRunModelId: (value: string) => void;
  setRunWorktreeModelIds: (value: string[]) => void;
  /** Existing model-change handler (also persists the global last-used model id). */
  onRunModelChange: (modelId: string) => void;
  /** Existing worktree model-set handler (also persists the global last-used model id). */
  onRunWorktreeModelIdsChange: (ids: string[]) => void;
  onError: (message: string) => void;
}

/**
 * Persists the project settings "Run defaults" (mode, workspace, base branch, models, efforts,
 * Full Access) per project id and restores them whenever the selected project changes,
 * including on app start.
 */
export const useProjectRunDefaults = ({
  buildwarden,
  snapshotLoaded,
  projectRunDefaultsSetting,
  models,
  preferredRunModelId,
  selectedProjectId,
  setRunMode,
  setRunWorkspaceType,
  setRunBaseBranch,
  setRunReasoningEffort,
  setRunAnthropicEffort,
  setRunYoloMode,
  setRunModelId,
  setRunWorktreeModelIds,
  onRunModelChange,
  onRunWorktreeModelIdsChange,
  onError,
}: UseProjectRunDefaultsInput) => {
  const projectRunDefaultsByProjectId = useMemo<ProjectRunDefaultsByProjectId>(
    () => parseProjectRunDefaultsSetting(projectRunDefaultsSetting),
    [projectRunDefaultsSetting],
  );
  const projectRunDefaultsRef = useRef<ProjectRunDefaultsByProjectId>({});
  useEffect(() => {
    projectRunDefaultsRef.current = projectRunDefaultsByProjectId;
  }, [projectRunDefaultsByProjectId]);

  const persistProjectRunDefaults = useCallback(
    (partial: Partial<ProjectRunDefaults>) => {
      if (!buildwarden || !selectedProjectId) {
        return;
      }
      const current = projectRunDefaultsRef.current[selectedProjectId] ?? buildDefaultProjectRunDefaults();
      const next = { ...projectRunDefaultsRef.current, [selectedProjectId]: { ...current, ...partial } };
      projectRunDefaultsRef.current = next;
      void buildwarden.setAppSetting(APP_SETTING_KEYS.projectRunDefaults, JSON.stringify(next)).catch((caught) => {
        reportRendererError("renderer.project-run-defaults.persist", caught, { projectId: selectedProjectId });
        onError(caught instanceof Error ? caught.message : "Could not save project run defaults.");
      });
    },
    [buildwarden, onError, selectedProjectId],
  );

  // Restore persisted run defaults whenever the selected project changes (including initial app start).
  const hydratedRunDefaultsProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshotLoaded || !selectedProjectId) {
      return;
    }
    if (hydratedRunDefaultsProjectIdRef.current === selectedProjectId) {
      return;
    }
    hydratedRunDefaultsProjectIdRef.current = selectedProjectId;
    const stored = projectRunDefaultsByProjectId[selectedProjectId];
    const defaults = stored ?? buildDefaultProjectRunDefaults();
    setRunMode(defaults.mode);
    setRunWorkspaceType(defaults.workspaceType);
    setRunReasoningEffort(defaults.reasoningEffort);
    setRunAnthropicEffort(defaults.anthropicEffort);
    setRunYoloMode(defaults.yoloMode);
    setRunBaseBranch(defaults.baseBranch);
    // Always reset model selections so a project without stored defaults does not inherit the
    // previous project's models. Without a stored value, fall back to the last used model like
    // loadSnapshot does (setting "" would leave local-mode runs without a model until the next
    // snapshot refresh, because the reconciliation effect never writes runModelId back).
    const validModelIds = new Set(models.map((model) => model.id));
    const resolvedModelId =
      stored?.modelId && validModelIds.has(stored.modelId)
        ? stored.modelId
        : preferredRunModelId && validModelIds.has(preferredRunModelId)
          ? preferredRunModelId
          : models[0]?.id ?? "";
    setRunModelId(resolvedModelId);
    const storedWorktreeModelIds = (stored?.worktreeModelIds ?? []).filter((id) => validModelIds.has(id));
    setRunWorktreeModelIds(storedWorktreeModelIds.length > 0 ? storedWorktreeModelIds : resolvedModelId ? [resolvedModelId] : []);
  }, [
    models,
    preferredRunModelId,
    projectRunDefaultsByProjectId,
    selectedProjectId,
    setRunAnthropicEffort,
    setRunBaseBranch,
    setRunMode,
    setRunModelId,
    setRunReasoningEffort,
    setRunWorkspaceType,
    setRunWorktreeModelIds,
    setRunYoloMode,
    snapshotLoaded,
  ]);

  const changeRunMode = useCallback(
    (value: RunMode) => {
      setRunMode(value);
      persistProjectRunDefaults({ mode: value });
    },
    [persistProjectRunDefaults, setRunMode],
  );

  const changeRunWorkspaceType = useCallback(
    (value: RunWorkspaceType) => {
      setRunWorkspaceType(value);
      persistProjectRunDefaults({ workspaceType: value });
    },
    [persistProjectRunDefaults, setRunWorkspaceType],
  );

  const changeRunBaseBranch = useCallback(
    (value: string) => {
      setRunBaseBranch(value);
      persistProjectRunDefaults({ baseBranch: value });
    },
    [persistProjectRunDefaults, setRunBaseBranch],
  );

  const changeRunReasoningEffort = useCallback(
    (value: string) => {
      setRunReasoningEffort(value);
      persistProjectRunDefaults({ reasoningEffort: value });
    },
    [persistProjectRunDefaults, setRunReasoningEffort],
  );

  const changeRunAnthropicEffort = useCallback(
    (value: string) => {
      setRunAnthropicEffort(value);
      persistProjectRunDefaults({ anthropicEffort: value });
    },
    [persistProjectRunDefaults, setRunAnthropicEffort],
  );

  const changeRunYoloMode = useCallback(
    (value: boolean) => {
      setRunYoloMode(value);
      persistProjectRunDefaults({ yoloMode: value });
    },
    [persistProjectRunDefaults, setRunYoloMode],
  );

  const changeRunModel = useCallback(
    (modelId: string) => {
      onRunModelChange(modelId);
      persistProjectRunDefaults({ modelId });
    },
    [onRunModelChange, persistProjectRunDefaults],
  );

  const changeRunWorktreeModelIds = useCallback(
    (ids: string[]) => {
      onRunWorktreeModelIdsChange(ids);
      persistProjectRunDefaults({ worktreeModelIds: ids, modelId: ids[0] ?? "" });
    },
    [onRunWorktreeModelIdsChange, persistProjectRunDefaults],
  );

  return {
    changeRunMode,
    changeRunWorkspaceType,
    changeRunBaseBranch,
    changeRunReasoningEffort,
    changeRunAnthropicEffort,
    changeRunYoloMode,
    changeRunModel,
    changeRunWorktreeModelIds,
  };
};
