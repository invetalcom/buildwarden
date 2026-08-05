import { useCallback, useEffect, useMemo, useState } from "react";
import {
  APP_SETTING_KEYS,
  type IntegratedSkillMetadata,
  type ProjectRunDefaults,
  type ProjectSnapshot,
  type RunMode,
  type RunWorkspaceType,
} from "@buildwarden/shared";
import { Trash2 } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { runModelOptions } from "../../data/selectors";
import { useAction } from "../../data/use-action";
import { useAppSettings } from "../../data/use-app-settings";
import { errorMessage } from "../../lib/format";
import {
  readProjectActiveSkills,
  readProjectRunDefaults,
  writeProjectActiveSkills,
  writeProjectRunDefaults,
} from "../../lib/project-settings";
import { CheckRow, SelectRow, SettingGroup, ToggleRow } from "../../components/SettingControls";
import { ConfirmSheet } from "../../components/Sheet";
import { Button, CenteredSpinner, InlineError, ListRow } from "../../components/primitives";

/**
 * Per-project settings — the mobile counterpart of the desktop `ProjectSettingsPage`.
 *
 * Everything here is stored in two app-wide settings keys keyed by project id
 * (`projectRunDefaults`, `projectActiveSkills`) plus the project's own base branch, so each control
 * merges into the existing map rather than replacing it.
 */

const RUN_MODES: ReadonlyArray<{ value: RunMode; label: string }> = [
  { value: "code", label: "Code — edit files and run tools" },
  { value: "plan", label: "Plan — think first, then wait" },
  { value: "ask", label: "Ask — answer without changes" },
];

const GIT_WORKSPACES: ReadonlyArray<{ value: RunWorkspaceType; label: string }> = [
  { value: "worktree", label: "Worktree — isolated branch per run" },
  { value: "local", label: "Local — use the current checkout" },
];

const FOLDER_WORKSPACES: ReadonlyArray<{ value: RunWorkspaceType; label: string }> = [
  { value: "copy", label: "Copy — isolated copy of the folder" },
  { value: "local", label: "Local — work in place" },
];

const EFFORTS = ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
const effortOptions = EFFORTS.map((value) => ({ value, label: value }));
const executionModeOptions = ["auto", "standard", "fast", "flex", "priority"].map((value) => ({ value, label: value }));

export const ProjectSettingsPanel = ({ project }: { project: ProjectSnapshot }) => {
  const { client, snapshot, snapshotStore, router } = useMobileApp();
  const settings = useAppSettings();
  const action = useAction();
  const projectId = project.project.id;

  const [branches, setBranches] = useState<string[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [skills, setSkills] = useState<IntegratedSkillMetadata[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const defaults = useMemo(() => readProjectRunDefaults(snapshot.settings, projectId), [snapshot.settings, projectId]);
  const activeSkillIds = useMemo(() => readProjectActiveSkills(snapshot.settings, projectId), [snapshot.settings, projectId]);
  const models = useMemo(() => runModelOptions(snapshot), [snapshot]);
  const isGit = project.project.kind === "git";
  const workspaceOptions = isGit ? GIT_WORKSPACES : FOLDER_WORKSPACES;

  useEffect(() => {
    let cancelled = false;
    void client
      .getProjectBranches(projectId)
      .then((next) => {
        if (!cancelled) setBranches(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setBranchError(errorMessage(caught, "Could not load branches."));
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId]);

  useEffect(() => {
    let cancelled = false;
    void client
      .listIntegratedSkills()
      .then((next) => {
        if (!cancelled) setSkills(next);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const saveDefaults = useCallback(
    (patch: Partial<ProjectRunDefaults>) => {
      const next = { ...defaults, ...patch };
      void settings.write(APP_SETTING_KEYS.projectRunDefaults, writeProjectRunDefaults(snapshot.settings, projectId, next));
    },
    [defaults, projectId, settings, snapshot.settings],
  );

  const toggleSkill = (skillId: string) => {
    const next = activeSkillIds.includes(skillId)
      ? activeSkillIds.filter((entry) => entry !== skillId)
      : [...activeSkillIds, skillId];
    void settings.write(APP_SETTING_KEYS.projectActiveSkills, writeProjectActiveSkills(snapshot.settings, projectId, next));
  };

  const toggleWorktreeModel = (modelId: string) => {
    const next = defaults.worktreeModelIds.includes(modelId)
      ? defaults.worktreeModelIds.filter((entry) => entry !== modelId)
      : [...defaults.worktreeModelIds, modelId];
    saveDefaults({ worktreeModelIds: next });
  };

  const canEdit = settings.canWrite;
  const disabled = !canEdit || settings.saving;

  return (
    <div className="m-scroll m-screen-enter flex-1">
      {settings.error ? <InlineError message={settings.error} /> : null}
      {action.error ? <InlineError message={action.error} /> : null}
      {!canEdit ? (
        <p className="px-4 pt-3 text-[11px] leading-4 text-[var(--ec-warning)]">
          This browser session was paired without the admin scope, so project settings are read-only.
        </p>
      ) : null}

      <SettingGroup title="Repository">
        {isGit ? (
          branchError ? (
            <InlineError message={branchError} />
          ) : (
            <SelectRow
              title="Base branch"
              description="Starting point for new worktrees and the default merge target."
              value={project.project.baseBranch}
              disabled={disabled || branches.length === 0}
              options={(branches.length > 0 ? branches : [project.project.baseBranch]).map((branch) => ({
                value: branch,
                label: branch,
              }))}
              onChange={(branch) => {
                void action
                  .run(() => client.updateProjectBaseBranch(projectId, branch), "Could not change the base branch.")
                  .then(() => snapshotStore.refresh());
              }}
            />
          )
        ) : (
          <ListRow title="Kind" subtitle="Plain folder — no Git branch settings" />
        )}
        <ListRow title="Repository path" subtitle={project.project.repoPath} />
      </SettingGroup>

      <SettingGroup title="Run defaults" hint="Applied to new runs started in this project.">
        <SelectRow
          title="Mode"
          value={defaults.mode}
          options={RUN_MODES}
          disabled={disabled}
          onChange={(mode) => saveDefaults({ mode })}
        />
        <SelectRow
          title="Workspace"
          value={workspaceOptions.some((option) => option.value === defaults.workspaceType) ? defaults.workspaceType : workspaceOptions[0].value}
          options={workspaceOptions}
          disabled={disabled}
          onChange={(workspaceType) => saveDefaults({ workspaceType })}
        />
        <SelectRow
          title="Default model"
          description="Used for runs in the local checkout, and as the fallback everywhere."
          value={defaults.modelId}
          options={[{ value: "", label: "Last used model" }, ...models.map((model) => ({ value: model.modelId, label: model.label }))]}
          disabled={disabled || models.length === 0}
          onChange={(modelId) => saveDefaults({ modelId })}
        />
        <SelectRow
          title="Reasoning effort"
          description="OpenAI-family models."
          value={defaults.reasoningEffort}
          options={effortOptions}
          disabled={disabled}
          onChange={(reasoningEffort) => saveDefaults({ reasoningEffort })}
        />
        <SelectRow
          title="Anthropic effort"
          description="Claude-family models."
          value={defaults.anthropicEffort}
          options={effortOptions}
          disabled={disabled}
          onChange={(anthropicEffort) => saveDefaults({ anthropicEffort })}
        />
        <SelectRow
          title="Speed / service"
          description="Applied only when the selected model advertises the option."
          value={defaults.executionMode}
          options={executionModeOptions}
          disabled={disabled}
          onChange={(executionMode) => saveDefaults({ executionMode })}
        />
        <ToggleRow
          title="Full access"
          description="New runs skip per-command approval prompts."
          checked={defaults.yoloMode}
          disabled={disabled}
          onChange={(yoloMode) => saveDefaults({ yoloMode })}
        />
      </SettingGroup>

      <SettingGroup
        title="Isolated-workspace models"
        hint="Models offered for worktree and copy runs. Leave all unchecked to use the default model."
      >
        {models.length === 0 ? (
          <p className="px-4 py-3 text-[11px] text-[var(--ec-faint)]">No models configured.</p>
        ) : (
          models.map((model) => (
            <CheckRow
              key={model.modelId}
              title={model.label}
              description={model.providerLabel}
              checked={defaults.worktreeModelIds.includes(model.modelId)}
              disabled={disabled}
              onToggle={() => toggleWorktreeModel(model.modelId)}
            />
          ))
        )}
      </SettingGroup>

      <SettingGroup title="Project skills" hint="Extra guidance loaded into every run in this project.">
        {skills === null ? (
          <CenteredSpinner label="Loading skills" />
        ) : skills.length === 0 ? (
          <p className="px-4 py-3 text-[11px] text-[var(--ec-faint)]">No integrated skills available.</p>
        ) : (
          skills.map((skill) => (
            <CheckRow
              key={skill.id}
              title={skill.title}
              description={skill.description}
              checked={activeSkillIds.includes(skill.id)}
              disabled={disabled}
              onToggle={() => toggleSkill(skill.id)}
            />
          ))
        )}
      </SettingGroup>

      <SettingGroup title="Danger zone">
        <div className="px-4 py-3">
          <p className="mb-2 text-[11px] leading-4 text-[var(--ec-muted)]">
            Removes the project and every BuildWarden worktree it created. Your repository is not touched.
          </p>
          <Button
            tone="danger"
            block
            disabled={!client.capabilities.projectCreation}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="size-4" />
            Delete project
          </Button>
        </div>
      </SettingGroup>

      <div className="h-6" />

      <ConfirmSheet
        open={confirmDelete}
        title="Delete project"
        message={`Remove “${project.project.name}” and its BuildWarden worktrees? Runs and chats for this project are deleted too. The repository itself stays on disk.`}
        confirmLabel="Delete"
        danger
        busy={action.busy}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          void action.ok(() => client.deleteProject(projectId), "Could not delete the project.").then(async (deleted) => {
            if (!deleted) return;
            setConfirmDelete(false);
            await snapshotStore.refresh();
            router.selectTab("more");
          });
        }}
      />
    </div>
  );
};
