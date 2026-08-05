import type { ProjectKind, RunMode, RunModelConfiguration, RunWorkspaceType } from "@buildwarden/shared";
import { readProjectRunDefaults } from "./project-settings";

/**
 * What the new-run composer starts out with for a project.
 *
 * The desktop composer restores the project's stored run defaults whenever the selected project
 * changes (`useProjectRunDefaults`), so mode, workspace, efforts and Full Access all come from
 * project settings rather than from fixed values. The mobile composer had hardcoded
 * code/worktree/off, which quietly ignored those settings.
 *
 * Delegation is deliberately absent: the desktop keeps it out of the per-project defaults too, so
 * it starts off for every run.
 */

/** Workspace types a project kind can actually use — the desktop's rule in ProjectOverviewTab. */
export const NEW_RUN_WORKSPACE_TYPES: Record<ProjectKind, readonly RunWorkspaceType[]> = {
  git: ["worktree", "local"],
  folder: ["copy", "local"],
};

export interface NewRunDefaults {
  mode: RunMode;
  workspaceType: RunWorkspaceType;
  modelId: string;
  modelIds: string[];
  modelConfigurations: Record<string, RunModelConfiguration>;
  reasoningEffort: string;
  anthropicEffort: string;
  executionMode: string;
  yoloMode: boolean;
}

export const resolveNewRunDefaults = ({
  settings,
  projectId,
  projectKind,
  modelIds,
  fallbackModelId,
}: {
  settings: Record<string, string>;
  projectId: string;
  projectKind: ProjectKind;
  /** Model ids currently configured and enabled. */
  modelIds: readonly string[];
  /** Last used model, or the first configured one — used when the project has no stored model. */
  fallbackModelId: string;
}): NewRunDefaults => {
  const stored = readProjectRunDefaults(settings, projectId);
  const workspaceTypes = NEW_RUN_WORKSPACE_TYPES[projectKind];
  const workspaceType = workspaceTypes.includes(stored.workspaceType) ? stored.workspaceType : workspaceTypes[0];
  const modelId = stored.modelId && modelIds.includes(stored.modelId) ? stored.modelId : fallbackModelId;
  const storedModelIds = stored.worktreeModelIds.filter((id) => modelIds.includes(id));
  const selectedModelIds = workspaceType === "local"
    ? modelId ? [modelId] : []
    : storedModelIds.length > 0 ? storedModelIds : modelId ? [modelId] : [];
  const modelConfigurations = Object.fromEntries(
    Object.entries(stored.modelConfigurations).filter(([id]) => modelIds.includes(id)),
  );

  return {
    mode: stored.mode,
    // A stored workspace can outlive the project kind that allowed it (or predate this rule), and
    // an option the composer does not offer would leave the group with nothing selected.
    workspaceType,
    // Same precedence as the desktop: the project's stored model wins over the last used one, but
    // only while it is still configured.
    modelId,
    modelIds: selectedModelIds,
    modelConfigurations,
    reasoningEffort: stored.reasoningEffort,
    anthropicEffort: stored.anthropicEffort,
    executionMode: stored.executionMode,
    yoloMode: stored.yoloMode,
  };
};
