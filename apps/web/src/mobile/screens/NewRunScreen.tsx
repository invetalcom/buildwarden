import { useEffect, useMemo, useRef, useState } from "react";
import { APP_SETTING_KEYS, type ProjectKind, type RunMode, type RunModelConfiguration, type RunWorkspaceType } from "@buildwarden/shared";
import { buildRunReasoningInput, resolveRunModelConfiguration } from "@buildwarden/renderer/logic";
import { Bot, ChevronDown, Plus, Sparkles, X } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { defaultProjectId, defaultRunModel, runModelOptions } from "../data/selectors";
import { useAction } from "../data/use-action";
import { resolveNewRunDefaults } from "../lib/new-run-defaults";
import { AppBar } from "../components/AppBar";
import { Button, EmptyState, InlineError, Textarea, Toggle } from "../components/primitives";
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

/**
 * Full-screen run composer. The desktop packs project, model, mode, workspace, effort and toggles
 * into one dense row; on a phone the prompt gets the whole first screen and everything else lives
 * under a collapsed "Options" section, which is what a user changes least often.
 */
export const NewRunScreen = ({ projectId }: { projectId?: string }) => {
  const { client, snapshot, snapshotStore, router } = useMobileApp();
  const action = useAction();

  const models = useMemo(() => runModelOptions(snapshot), [snapshot]);
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? defaultProjectId(snapshot) ?? "");
  const project = snapshot.projects.find((entry) => entry.project.id === selectedProjectId) ?? null;
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

  const [prompt, setPrompt] = useState("");
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
    const validIds = modelIds.filter((id) => models.some((option) => option.modelId === id));
    if (validIds.length !== modelIds.length || validIds.length === 0) {
      const fallbackIds = defaults.modelIds.length > 0 ? defaults.modelIds : models[0] ? [models[0].modelId] : [];
      setModelIds(validIds.length > 0 ? validIds : fallbackIds);
    }
  }, [defaults.modelIds, modelIds, models]);

  useEffect(() => {
    if (workspaceType !== "local" || modelIds.length <= 1) return;
    const firstModelId = modelIds[0];
    setModelIds([firstModelId]);
    if (activeModelId && activeModelId !== firstModelId) setActiveModelId(null);
  }, [activeModelId, modelIds, workspaceType]);

  const selectedModelId = activeModelId && modelIds.includes(activeModelId) ? activeModelId : modelIds[0] ?? "";
  const model = models.find((option) => option.modelId === selectedModelId) ?? null;
  const reasoningControl = model?.executionProfile.controls.find((control) => control.id === "reasoningEffort" || control.id === "thinkingLevel");
  const secondaryControl = model?.executionProfile.controls.find((control) => control.id !== "reasoningEffort" && control.id !== "thinkingLevel");
  const selectedEffort = model?.providerType === "claude-code" || (model?.providerType === "ai-sdk" && model.providerFamily === "anthropic")
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
    const nextReasoningControl = nextModel.executionProfile.controls.find((control) => control.id === "reasoningEffort" || control.id === "thinkingLevel");
    const nextSecondaryControl = nextModel.executionProfile.controls.find((control) => control.id !== "reasoningEffort" && control.id !== "thinkingLevel");
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
    setModelIds((current) => current.filter((id) => id !== modelIdToRemove));
    setModelConfigurations((current) => {
      const next = { ...current };
      delete next[modelIdToRemove];
      return next;
    });
    if (activeModelId === modelIdToRemove) setActiveModelId(null);
  };
  const addModel = (nextModelId: string) => {
    if (modelIds.includes(nextModelId)) return;
    setModelIds((current) => [...current, nextModelId]);
    setModelConfigurations((current) => ({ ...current, [nextModelId]: { effort: "auto", executionMode: "auto" } }));
    setActiveModelId(nextModelId);
    setAddModelsOpen(false);
  };
  const unselectedModels = models.filter((entry) => !modelIds.includes(entry.modelId));

  const start = async () => {
    if (!project || !prompt.trim()) return;
    const selectedModels = (workspaceType === "local" ? modelIds.slice(0, 1) : modelIds)
      .flatMap((id) => {
        const entry = models.find((option) => option.modelId === id);
        return entry ? [entry] : [];
      });
    if (selectedModels.length === 0) return;
    const runs = await action.run(
      async () => {
        const created = [];
        for (const selectedModel of selectedModels) {
          const configuration = resolveRunModelConfiguration(
            selectedModel.modelId,
            modelConfigurations,
            reasoningEffort,
            anthropicEffort,
            executionMode,
            selectedModel.providerType === "claude-code" || (selectedModel.providerType === "ai-sdk" && selectedModel.providerFamily === "anthropic"),
          );
          created.push(await client.createRun({
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
            ...buildRunReasoningInput(
              selectedModel.providerType,
              selectedModel.providerFamily,
              configuration.effort,
              configuration.effort,
              selectedModel.executionProfile,
              configuration.executionMode,
            ),
          }));
        }
        return created;
      },
      "The run did not start.",
    );
    const run = runs?.at(-1);
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

  return (
    <>
      <AppBar title="New run" onBack={router.back} />

      <div className="m-scroll m-screen-enter flex-1">
        {action.error ? <InlineError message={action.error} /> : null}

        <div className="px-4 pt-3">
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
              onChange={(event) => setSelectedProjectId(event.target.value)}
              className="m-tap w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-[var(--ec-text)]"
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
            <div className="flex min-w-0 items-center gap-1.5">
              <div
                data-model-chip-rail="true"
                className="flex min-w-0 flex-1 snap-x items-center gap-1.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {modelIds.flatMap((id) => {
                  const entry = models.find((option) => option.modelId === id);
                  if (!entry) return [];
                  const configuration = resolveRunModelConfiguration(
                    id,
                    modelConfigurations,
                    reasoningEffort,
                    anthropicEffort,
                    executionMode,
                    entry.providerType === "claude-code" || (entry.providerType === "ai-sdk" && entry.providerFamily === "anthropic"),
                  );
                  const effortControl = entry.executionProfile.controls.find((control) => control.id === "reasoningEffort" || control.id === "thinkingLevel");
                  const effortLabel = effortControl?.options.find((option) => option.value === configuration.effort)?.label;
                  const isActive = activeModelId === id;
                  const isCompact = modelIds.length > 1;
                  return [
                    <span
                      key={id}
                      className={cn(
                        "inline-flex h-9 max-w-full shrink-0 snap-start items-center overflow-hidden rounded-full border bg-[var(--ec-input)] transition",
                        isActive ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)]" : "border-[var(--ec-border)]",
                      )}
                    >
                      <button
                        type="button"
                        aria-label={`Configure ${entry.label}`}
                        title={[entry.label, configuration.effort !== "auto" ? effortLabel : null].filter(Boolean).join(" · ")}
                        onClick={() => {
                          setActiveModelId(isActive ? null : id);
                          setAddModelsOpen(false);
                        }}
                        className={cn(
                          "flex min-w-0 items-center gap-1.5 text-[12px] font-medium",
                          isCompact ? "max-w-36 px-2" : "max-w-52 px-3",
                        )}
                      >
                        <Bot className="size-3.5 shrink-0 text-[var(--ec-muted)]" />
                        <span className="truncate">{entry.label}</span>
                        {!isCompact && configuration.effort !== "auto" && effortLabel ? (
                          <span className="shrink-0 text-[11px] font-normal text-[var(--ec-muted)]">{effortLabel}</span>
                        ) : null}
                        <ChevronDown className={cn("size-3.5 shrink-0 text-[var(--ec-faint)] transition", isActive && "rotate-180")} />
                      </button>
                      {workspaceType !== "local" && modelIds.length > 1 ? (
                        <button
                          type="button"
                          aria-label={`Remove ${entry.label}`}
                          onClick={() => removeModel(id)}
                          className="flex h-full items-center border-l border-[var(--ec-border)] px-2 text-[var(--ec-faint)] hover:text-[var(--ec-text)]"
                        >
                          <X className="size-3.5" />
                        </button>
                      ) : null}
                    </span>,
                  ];
                })}
              </div>
              {workspaceType !== "local" ? (
                <button
                  type="button"
                  aria-label="Add model"
                  disabled={unselectedModels.length === 0}
                  onClick={() => {
                    setAddModelsOpen((current) => !current);
                    setActiveModelId(null);
                  }}
                  className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--ec-border-strong)] text-[var(--ec-muted)] transition hover:border-[var(--ec-accent-ring)] hover:text-[var(--ec-text)] disabled:opacity-40"
                >
                  <Plus className={cn("size-4 transition", addModelsOpen && "rotate-45")} />
                </button>
              ) : null}
            </div>

            {addModelsOpen && unselectedModels.length > 0 ? (
              <div className="flex max-h-48 flex-col overflow-y-auto rounded-lg border border-[var(--ec-border)] bg-[var(--ec-input)] p-1 shadow-lg">
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
              <div className="grid gap-1 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-input)] p-1.5 shadow-lg">
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
