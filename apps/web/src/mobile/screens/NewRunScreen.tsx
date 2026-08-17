import { useEffect, useMemo, useRef, useState } from "react";
import { APP_SETTING_KEYS, type ModelExecutionControl, type ProjectKind, type RunMode, type RunModelConfiguration, type RunWorkspaceType } from "@buildwarden/shared";
import { buildRunReasoningInput, resolveRunModelConfiguration } from "@buildwarden/renderer/logic";
import { Bot, ChevronDown, Plus, Sparkles, X } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { defaultProjectId, defaultRunModel, runModelOptions, type RunModelOption } from "../data/selectors";
import { useAction } from "../data/use-action";
import { createNewRunsIndependently } from "../lib/new-run-creation";
import { reconcileNewRunModelIds, resolveNewRunDefaults } from "../lib/new-run-defaults";
import { AppBar } from "../components/AppBar";
import { Button, EmptyState, InlineError, Textarea, Toggle } from "../components/primitives";
import { MobileStoredAttachments } from "../components/TaskAttachments";
import { cn } from "../lib/cn";

const MODES: { value: RunMode; label: string; hint: string }[] = [
  { value: "code", label: "Code", hint: "Edit files and run commands" },
  { value: "plan", label: "Plan", hint: "Propose a plan first" },
  { value: "ask", label: "Ask", hint: "Answer without editing" },
];

// Which of these a project can use depends on its kind, exactly as on the desktop: a folder project
// has no branches to make a worktree from, and a git project copies via a worktree instead.
const WORKSPACES: Record<ProjectKind, { value: RunWorkspaceType; label: string; hint: string }[]> = {
  git: [
    { value: "worktree", label: "Worktree", hint: "Isolated branch, safest" },
    { value: "local", label: "Local repo", hint: "Works in your checkout" },
  ],
  folder: [
    { value: "copy", label: "Copy", hint: "Throwaway copy of the folder" },
    { value: "local", label: "Folder", hint: "Works in place" },
  ],
};

const OptionGroup = <Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: Value; label: string; hint: string }[];
  value: Value;
  onChange: (next: Value) => void;
}) => (
  <div className="px-4 py-2">
    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">{label}</p>
    <div className="flex flex-col gap-1.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "m-tap flex items-center gap-3 rounded-md border px-3 text-left transition",
            option.value === value
              ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)]"
              : "border-[var(--ec-border)]",
          )}
        >
          <span className="flex flex-1 flex-col">
            <span className="text-[13px] font-medium">{option.label}</span>
            <span className="text-[11px] text-[var(--ec-muted)]">{option.hint}</span>
          </span>
          <span
            className={cn(
              "size-4 shrink-0 rounded-full border-2",
              option.value === value ? "border-[var(--ec-accent)] bg-[var(--ec-accent)]" : "border-[var(--ec-border-strong)]",
            )}
          />
        </button>
      ))}
    </div>
  </div>
);

const isReasoningControl = (control: Pick<ModelExecutionControl, "id">): boolean =>
  control.id === "reasoningEffort" || control.id === "thinkingLevel";

const isAnthropicModel = (model: Pick<RunModelOption, "providerType" | "providerFamily"> | null | undefined): boolean =>
  model?.providerType === "claude-code" || (model?.providerType === "ai-sdk" && model.providerFamily === "anthropic");

const mobileControlSummaryLabel = (control: ModelExecutionControl, value: string): string => {
  const label = control.options.find((option) => option.value === value)?.label ?? "Provider default";
  if (value !== "auto") return label;
  const noun = isReasoningControl(control) ? "effort" : control.label.toLocaleLowerCase();
  return `Default ${noun}`;
};

/**
 * Full-screen run composer. The desktop packs project, model, mode, workspace, effort and toggles
 * into one dense row; on a phone the prompt gets the whole first screen and everything else lives
 * under a collapsed "Options" section, which is what a user changes least often.
 */
export const NewRunScreen = ({ projectId, taskId }: { projectId?: string; taskId?: string }) => {
  const { client, snapshot, snapshotStore, router } = useMobileApp();
  const action = useAction();

  const models = useMemo(() => runModelOptions(snapshot), [snapshot]);
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? defaultProjectId(snapshot) ?? "");
  const project = snapshot.projects.find((entry) => entry.project.id === selectedProjectId) ?? null;
  const task = project?.tasks.find((entry) => entry.id === taskId) ?? null;
  const projectKind: ProjectKind = project?.project.kind ?? "git";

  const defaults = useMemo(
    () =>
      resolveNewRunDefaults({
        settings: snapshot.settings,
        projectId: selectedProjectId,
        projectKind,
        modelIds: models.map((option) => option.modelId),
        fallbackModelId: defaultRunModel(snapshot)?.modelId ?? "",
      }),
    [models, projectKind, selectedProjectId, snapshot],
  );

  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [modelIds, setModelIds] = useState(defaults.modelIds);
  const [modelConfigurations, setModelConfigurations] = useState<Record<string, RunModelConfiguration>>(defaults.modelConfigurations);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [addModelsOpen, setAddModelsOpen] = useState(false);
  const [mode, setMode] = useState<RunMode>(defaults.mode);
  const [workspaceType, setWorkspaceType] = useState<RunWorkspaceType>(defaults.workspaceType);
  const [yoloMode, setYoloMode] = useState(defaults.yoloMode);
  const [reasoningEffort, setReasoningEffort] = useState(defaults.reasoningEffort);
  const [anthropicEffort, setAnthropicEffort] = useState(defaults.anthropicEffort);
  const [executionMode, setExecutionMode] = useState(defaults.executionMode);
  const [delegation, setDelegation] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const hydratedTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!task || hydratedTaskIdRef.current === task.id) return;
    hydratedTaskIdRef.current = task.id;
    setPrompt(task.prompt);
  }, [task]);

  // The screen can mount before the first snapshot arrives (a reload straight onto this route), so
  // there may be no project to read defaults from yet. Adopt the host's project once it shows up;
  // the hydration effect below then applies that project's defaults.
  useEffect(() => {
    if (selectedProjectId) return;
    const next = defaultProjectId(snapshot);
    if (next) setSelectedProjectId(next);
  }, [selectedProjectId, snapshot]);

  // Re-apply the project's defaults when the project selector changes, but only once per project,
  // so a choice the user has already made here is not overwritten by a snapshot refresh. This is
  // what `useProjectRunDefaults` does on the desktop.
  //
  // Seeded with null rather than the initial project: a projectId from the route arrives before the
  // first snapshot, so its stored defaults are not readable yet and hydration still has to happen
  // once the settings land.
  const hydratedProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedProjectId || !snapshotStore.loaded || hydratedProjectIdRef.current === selectedProjectId) return;
    hydratedProjectIdRef.current = selectedProjectId;
    setMode(defaults.mode);
    setWorkspaceType(defaults.workspaceType);
    setYoloMode(defaults.yoloMode);
    setModelIds(defaults.modelIds);
    setModelConfigurations(defaults.modelConfigurations);
    setActiveModelId(null);
    setReasoningEffort(defaults.reasoningEffort);
    setAnthropicEffort(defaults.anthropicEffort);
    setExecutionMode(defaults.executionMode);
  }, [defaults, selectedProjectId, snapshotStore.loaded]);

  // Models arrive with the first snapshot, which can land after this screen mounts.
  useEffect(() => {
    const configuredIds = models.map((option) => option.modelId);
    const fallbackIds = defaults.modelIds.length > 0 ? defaults.modelIds : models[0] ? [models[0].modelId] : [];
    const nextIds = reconcileNewRunModelIds(modelIds, configuredIds, fallbackIds);
    if (nextIds !== modelIds) setModelIds([...nextIds]);
  }, [defaults.modelIds, modelIds, models]);

  useEffect(() => {
    if (workspaceType !== "local" || modelIds.length <= 1) return;
    const firstModelId = modelIds[0];
    setModelIds([firstModelId]);
    if (activeModelId && activeModelId !== firstModelId) setActiveModelId(null);
  }, [activeModelId, modelIds, workspaceType]);

  const selectedModelId = activeModelId && modelIds.includes(activeModelId) ? activeModelId : modelIds[0] ?? "";
  const model = models.find((option) => option.modelId === selectedModelId) ?? null;
  const reasoningControl = model?.executionProfile.controls.find(isReasoningControl);
  const secondaryControl = model?.executionProfile.controls.find((control) => !isReasoningControl(control));
  const selectedEffort = isAnthropicModel(model)
    ? modelConfigurations[selectedModelId]?.effort ?? anthropicEffort
    : modelConfigurations[selectedModelId]?.effort ?? reasoningEffort;
  const selectedExecutionMode = modelConfigurations[selectedModelId]?.executionMode ?? executionMode;
  const workspaces = WORKSPACES[projectKind];
  const changeModelConfiguration = (next: RunModelConfiguration) => {
    if (!selectedModelId) return;
    setModelConfigurations((current) => ({ ...current, [selectedModelId]: next }));
  };
  const replaceSelectedModel = (nextModelId: string) => {
    if (!selectedModelId || nextModelId === selectedModelId) return;
    const nextModel = models.find((entry) => entry.modelId === nextModelId);
    if (!nextModel) return;
    const nextReasoningControl = nextModel.executionProfile.controls.find(isReasoningControl);
    const nextSecondaryControl = nextModel.executionProfile.controls.find((control) => !isReasoningControl(control));
    const nextConfiguration = {
      effort: nextReasoningControl?.options.some((option) => option.value === selectedEffort) ? selectedEffort : "auto",
      executionMode: nextSecondaryControl?.options.some((option) => option.value === selectedExecutionMode) ? selectedExecutionMode : "auto",
    };
    setModelIds((current) => current.map((id) => id === selectedModelId ? nextModelId : id));
    setModelConfigurations((current) => {
      const next = { ...current };
      delete next[selectedModelId];
      next[nextModelId] = nextConfiguration;
      return next;
    });
    setActiveModelId(nextModelId);
  };
  const removeModel = (modelIdToRemove: string) => {
    if (modelIds.length <= 1) return;
    const remainingModelIds = modelIds.filter((id) => id !== modelIdToRemove);
    setModelIds(remainingModelIds);
    setModelConfigurations((current) => {
      const next = { ...current };
      delete next[modelIdToRemove];
      return next;
    });
    if (activeModelId === modelIdToRemove) setActiveModelId(remainingModelIds[0] ?? null);
  };
  const addModel = (nextModelId: string) => {
    if (modelIds.includes(nextModelId)) return;
    setModelIds((current) => [...current, nextModelId]);
    setActiveModelId(nextModelId);
    setAddModelsOpen(false);
  };
  const unselectedModels = models.filter((entry) => !modelIds.includes(entry.modelId));
  const selectedModelsWithConfiguration = modelIds.flatMap((id) => {
    const entry = models.find((option) => option.modelId === id);
    if (!entry) return [];
    const configuration = resolveRunModelConfiguration(
      id,
      modelConfigurations,
      reasoningEffort,
      anthropicEffort,
      executionMode,
      isAnthropicModel(entry),
    );
    const effortControl = entry.executionProfile.controls.find(isReasoningControl);
    const secondaryEntry = entry.executionProfile.controls.find((control) => !isReasoningControl(control));
    const summary = [
      effortControl ? mobileControlSummaryLabel(effortControl, configuration.effort) : null,
      secondaryEntry ? mobileControlSummaryLabel(secondaryEntry, configuration.executionMode) : null,
    ].filter((value): value is string => Boolean(value));
    return [{ entry, configuration, effortControl, secondaryControl: secondaryEntry, summary }];
  });
  const groupSummaryForControl = (kind: "effort" | "secondary"): string | null => {
    const values = selectedModelsWithConfiguration.flatMap((selected) => {
      const control = kind === "effort" ? selected.effortControl : selected.secondaryControl;
      if (!control) return [];
      const value = kind === "effort" ? selected.configuration.effort : selected.configuration.executionMode;
      return [{ control, label: mobileControlSummaryLabel(control, value) }];
    });
    if (values.length === 0) return null;
    const labels = [...new Set(values.map((value) => value.label))];
    if (labels.length === 1) return labels[0]!;
    if (kind === "effort") return "Mixed effort";
    const controlLabels = [...new Set(values.map((value) => value.control.label.toLocaleLowerCase()))];
    return `Mixed ${controlLabels.length === 1 ? controlLabels[0] : "speed"}`;
  };
  const modelGroupSummary = [groupSummaryForControl("effort"), groupSummaryForControl("secondary")]
    .filter((value): value is string => Boolean(value));

  const start = async () => {
    if (!project || !prompt.trim()) return;
    const selectedModels = (workspaceType === "local" ? modelIds.slice(0, 1) : modelIds)
      .flatMap((id) => {
        const entry = models.find((option) => option.modelId === id);
        return entry ? [entry] : [];
      });
    if (selectedModels.length === 0) return;
    const result = await action.run(
      () => createNewRunsIndependently(
        selectedModels,
        async (selectedModel) => {
          const configuration = resolveRunModelConfiguration(
            selectedModel.modelId,
            modelConfigurations,
            reasoningEffort,
            anthropicEffort,
            executionMode,
            isAnthropicModel(selectedModel),
          );
          return client.createRun({
            projectId: project.project.id,
            providerAccountId: selectedModel.providerAccountId,
            modelId: selectedModel.modelId,
            harnessType: selectedModel.harnessType,
            mode,
            workspaceType,
            yoloMode,
            delegationEnabled: delegation,
            baseBranch: project.project.baseBranch,
            prompt: prompt.trim(),
            ...(task ? { projectTaskId: task.id } : {}),
            ...buildRunReasoningInput(
              selectedModel.providerType,
              selectedModel.providerFamily,
              configuration.effort,
              configuration.effort,
              selectedModel.executionProfile,
              configuration.executionMode,
            ),
          });
        },
      ),
      "The run did not start.",
    );
    if (!result) return;
    if (result.failures.length > 0) {
      const failedModels = result.failures.map(({ model: failedModel }) => failedModel.label).join(", ");
      window.alert(`Could not start runs for: ${failedModels}.`);
    }
    const run = result.runs.at(-1);
    if (!run) return;
    await client.setAppSetting(APP_SETTING_KEYS.lastUsedRunModelId, run.modelId).catch(() => undefined);
    await snapshotStore.refresh();
    router.replace({ name: "run", runId: run.id, segment: "activity" });
  };

  if (models.length === 0 || snapshot.projects.length === 0) {
    return (
      <>
        <AppBar title="New run" onBack={router.back} />
        <EmptyState
          title={models.length === 0 ? "No models configured" : "No projects"}
          message="Configure a provider, model and project in the desktop app first."
        />
      </>
    );
  }

  if (taskId && snapshotStore.loaded && !task) {
    return <><AppBar title="Start task" onBack={router.back} /><EmptyState title="Task unavailable" message="It may have been removed on the host." /></>;
  }

  return (
    <>
      <AppBar title={task ? "Start task" : "New run"} subtitle={task?.title} onBack={router.back} />

      <div className="m-scroll m-screen-enter flex-1">
        {action.error ? <InlineError message={action.error} /> : null}

        <div className="px-4 pt-3">
          {task?.attachments.length ? <div className="mb-3"><p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Task attachments</p><MobileStoredAttachments attachments={task.attachments} /></div> : null}
          <Textarea
            autoFocus
            rows={7}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What should the agent do?"
            className="text-[15px] leading-6"
          />
        </div>

        <div className="flex flex-col gap-2 px-4 py-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Project</span>
            <select
              value={selectedProjectId}
              disabled={Boolean(task)}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              className="m-tap w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-[var(--ec-text)] disabled:opacity-60"
            >
              {snapshot.projects.map((entry) => (
                <option key={entry.project.id} value={entry.project.id}>
                  {entry.project.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Models</span>
            <button
              type="button"
              aria-label={modelIds.length === 1 && selectedModelsWithConfiguration[0]
                ? `Configure ${selectedModelsWithConfiguration[0].entry.label}`
                : `Configure ${modelIds.length} models`}
              onClick={() => {
                if (activeModelId || addModelsOpen) {
                  setActiveModelId(null);
                  setAddModelsOpen(false);
                } else {
                  setActiveModelId(modelIds[0] ?? null);
                }
              }}
              className="m-tap flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-left transition hover:border-[var(--ec-accent-ring)]"
            >
              <Bot className="size-3.5 shrink-0 text-[var(--ec-muted)]" />
              <span className="min-w-0 shrink truncate text-[12px] font-medium">
                {modelIds.length === 1 ? selectedModelsWithConfiguration[0]?.entry.label : `${modelIds.length} models`}
              </span>
              {modelGroupSummary.map((value) => (
                <span key={value} className="max-w-28 shrink truncate text-[11px] text-[var(--ec-muted)]">{value}</span>
              ))}
              <ChevronDown className={cn("ml-auto size-3.5 shrink-0 text-[var(--ec-faint)] transition", (activeModelId || addModelsOpen) && "rotate-180")} />
            </button>

            {activeModelId || addModelsOpen ? (
              <div className="overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-input)] shadow-lg">
                <div className="border-b border-[var(--ec-border)] p-1.5">
                  <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Selected models</p>
                  {selectedModelsWithConfiguration.map((selected) => {
                    const isActive = activeModelId === selected.entry.modelId && !addModelsOpen;
                    return (
                      <div key={selected.entry.modelId} className={cn("flex items-center rounded-md", isActive && "bg-[var(--ec-accent-soft)]")}>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveModelId(selected.entry.modelId);
                            setAddModelsOpen(false);
                          }}
                          className="min-w-0 flex-1 px-2.5 py-2 text-left"
                        >
                          <span className="block truncate text-[12px] font-medium">{selected.entry.label}</span>
                          {selected.summary.length > 0 ? (
                            <span className="block truncate text-[11px] text-[var(--ec-muted)]">{selected.summary.join(" · ")}</span>
                          ) : null}
                        </button>
                        {workspaceType !== "local" && modelIds.length > 1 ? (
                          <button
                            type="button"
                            aria-label={`Remove ${selected.entry.label}`}
                            onClick={() => removeModel(selected.entry.modelId)}
                            className="flex size-9 shrink-0 items-center justify-center text-[var(--ec-faint)] hover:text-[var(--ec-text)]"
                          >
                            <X className="size-3.5" />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                  {workspaceType !== "local" ? (
                    <button
                      type="button"
                      aria-label="Add model"
                      disabled={unselectedModels.length === 0}
                      onClick={() => {
                        setAddModelsOpen(true);
                        setActiveModelId(null);
                      }}
                      className={cn(
                        "flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12px] text-[var(--ec-muted)] disabled:opacity-40",
                        addModelsOpen && "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]",
                      )}
                    >
                      <Plus className="size-3.5" />
                      Add model
                    </button>
                  ) : null}
                </div>

                {addModelsOpen && unselectedModels.length > 0 ? (
                  <div className="flex max-h-48 flex-col overflow-y-auto p-1.5">
                    {unselectedModels.map((entry) => (
                      <button
                        key={entry.modelId}
                        type="button"
                        onClick={() => addModel(entry.modelId)}
                        className="flex min-h-10 items-center gap-2 rounded-md px-2.5 text-left hover:bg-[var(--ec-hover)]"
                      >
                        <Bot className="size-3.5 shrink-0 text-[var(--ec-muted)]" />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{entry.label}</span>
                        <span className="shrink-0 text-[11px] text-[var(--ec-faint)]">{entry.providerLabel}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {activeModelId && model ? (
                  <div className="grid gap-1 p-1.5">
                <label className="grid min-h-10 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 hover:bg-[var(--ec-hover)]">
                  <span className="text-[12px] font-medium">Model</span>
                  <select
                    aria-label={`Model for ${model.label}`}
                    value={selectedModelId}
                    onChange={(event) => replaceSelectedModel(event.target.value)}
                    className="min-w-0 bg-transparent text-right text-[12px] text-[var(--ec-muted)] outline-none"
                  >
                    {models.map((option) => (
                      <option key={option.modelId} value={option.modelId} disabled={option.modelId !== selectedModelId && modelIds.includes(option.modelId)}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {reasoningControl ? (
                  <label className="grid min-h-10 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 hover:bg-[var(--ec-hover)]">
                    <span className="text-[12px] font-medium">{reasoningControl.label}</span>
                    <select
                      aria-label={`${reasoningControl.label} for ${model.label}`}
                      value={reasoningControl.options.some((option) => option.value === selectedEffort) ? selectedEffort : "auto"}
                      onChange={(event) => changeModelConfiguration({ effort: event.target.value, executionMode: selectedExecutionMode })}
                      className="min-w-0 bg-transparent text-right text-[12px] text-[var(--ec-muted)] outline-none"
                    >
                      {reasoningControl.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                ) : null}
                {secondaryControl ? (
                  <label className="grid min-h-10 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 hover:bg-[var(--ec-hover)]">
                    <span className="text-[12px] font-medium">{secondaryControl.label}</span>
                    <select
                      aria-label={`${secondaryControl.label} for ${model.label}`}
                      value={secondaryControl.options.some((option) => option.value === selectedExecutionMode) ? selectedExecutionMode : "auto"}
                      onChange={(event) => changeModelConfiguration({ effort: selectedEffort, executionMode: event.target.value })}
                      className="min-w-0 bg-transparent text-right text-[12px] text-[var(--ec-muted)] outline-none"
                    >
                      {secondaryControl.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setOptionsOpen((current) => !current)}
          className="m-tap flex w-full items-center gap-2 border-y border-[var(--ec-border)] px-4 text-left"
        >
          <span className="flex-1 text-[13px] font-medium">Options</span>
          <span className="text-[11px] text-[var(--ec-muted)]">
            {MODES.find((entry) => entry.value === mode)?.label} · {workspaces.find((entry) => entry.value === workspaceType)?.label}
          </span>
          <ChevronDown className={cn("size-4 text-[var(--ec-faint)] transition", optionsOpen && "rotate-180")} />
        </button>

        {optionsOpen ? (
          <>
            <OptionGroup label="Mode" options={MODES} value={mode} onChange={setMode} />
            <OptionGroup label="Workspace" options={workspaces} value={workspaceType} onChange={setWorkspaceType} />
            <div className="flex flex-col gap-1 px-4 py-2">
              <div className="m-tap flex items-center gap-3">
                <span className="flex flex-1 flex-col">
                  <span className="text-[13px] font-medium">Full access</span>
                  <span className="text-[11px] text-[var(--ec-muted)]">Skip shell approval prompts for this run</span>
                </span>
                <Toggle checked={yoloMode} onChange={setYoloMode} label="Full access" />
              </div>
              <div className="m-tap flex items-center gap-3">
                <span className="flex flex-1 flex-col">
                  <span className="text-[13px] font-medium">Allow delegation</span>
                  <span className="text-[11px] text-[var(--ec-muted)]">Let this run orchestrate child agents</span>
                </span>
                <Toggle checked={delegation} onChange={setDelegation} label="Allow delegation" />
              </div>
            </div>
          </>
        ) : null}

        <div className="h-4" />
      </div>

      <div className="m-safe-bottom shrink-0 border-t border-[var(--ec-border)] bg-[var(--ec-sidebar)] px-4 py-3">
        <Button block className="h-12" busy={action.busy} disabled={!prompt.trim() || modelIds.length === 0} onClick={() => void start()}>
          <Sparkles className="size-4" />
          Start run
        </Button>
      </div>
    </>
  );
};
