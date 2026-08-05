import { useEffect, useMemo, useRef, useState } from "react";
import { APP_SETTING_KEYS, type ProjectKind, type RunMode, type RunWorkspaceType } from "@buildwarden/shared";
import { buildRunReasoningInput } from "@buildwarden/renderer/logic";
import { ChevronDown, Sparkles } from "lucide-react";
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
  const [modelId, setModelId] = useState(defaults.modelId);
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
    setModelId(defaults.modelId);
    setReasoningEffort(defaults.reasoningEffort);
    setAnthropicEffort(defaults.anthropicEffort);
    setExecutionMode(defaults.executionMode);
  }, [defaults, selectedProjectId, snapshotStore.loaded]);

  // Models arrive with the first snapshot, which can land after this screen mounts.
  useEffect(() => {
    if (!modelId && models.length > 0) setModelId(defaults.modelId || models[0].modelId);
  }, [defaults.modelId, modelId, models]);

  const model = models.find((option) => option.modelId === modelId) ?? null;
  const reasoningControl = model?.executionProfile.controls.find((control) => control.id === "reasoningEffort" || control.id === "thinkingLevel");
  const secondaryControl = model?.executionProfile.controls.find((control) => control.id !== "reasoningEffort" && control.id !== "thinkingLevel");
  const selectedEffort = model?.providerType === "claude-code" || (model?.providerType === "ai-sdk" && model.providerFamily === "anthropic")
    ? anthropicEffort
    : reasoningEffort;
  const workspaces = WORKSPACES[projectKind];

  const start = async () => {
    if (!model || !project || !prompt.trim()) return;
    const run = await action.run(
      () =>
        client.createRun({
          projectId: project.project.id,
          providerAccountId: model.providerAccountId,
          modelId: model.modelId,
          harnessType: model.harnessType,
          mode,
          workspaceType,
          yoloMode,
          delegationEnabled: delegation,
          baseBranch: project.project.baseBranch,
          prompt: prompt.trim(),
          ...buildRunReasoningInput(
            model.providerType,
            model.providerFamily,
            reasoningEffort,
            anthropicEffort,
            model.executionProfile,
            executionMode,
          ),
        }),
      "The run did not start.",
    );
    if (!run) return;
    await client.setAppSetting(APP_SETTING_KEYS.lastUsedRunModelId, model.modelId).catch(() => undefined);
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

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Model</span>
            <select
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              className="m-tap w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-[var(--ec-text)]"
            >
              {models.map((option) => (
                <option key={option.modelId} value={option.modelId}>
                  {option.label} · {option.providerLabel}
                </option>
              ))}
            </select>
          </label>
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
            {reasoningControl ? (
              <label className="flex flex-col gap-1.5 px-4 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">{reasoningControl.label}</span>
                <select
                  value={reasoningControl.options.some((option) => option.value === selectedEffort) ? selectedEffort : "auto"}
                  onChange={(event) => {
                    if (model?.providerType === "claude-code" || (model?.providerType === "ai-sdk" && model.providerFamily === "anthropic")) {
                      setAnthropicEffort(event.target.value);
                    } else {
                      setReasoningEffort(event.target.value);
                    }
                  }}
                  className="m-tap w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-[var(--ec-text)]"
                >
                  {reasoningControl.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            ) : null}
            {secondaryControl && secondaryControl.options.length > 1 ? (
              <label className="flex flex-col gap-1.5 px-4 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">{secondaryControl.label}</span>
                <select
                  value={secondaryControl.options.some((option) => option.value === executionMode) ? executionMode : "auto"}
                  onChange={(event) => setExecutionMode(event.target.value)}
                  className="m-tap w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-[var(--ec-text)]"
                >
                  {secondaryControl.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            ) : null}
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
        <Button block className="h-12" busy={action.busy} disabled={!prompt.trim() || !model} onClick={() => void start()}>
          <Sparkles className="size-4" />
          Start run
        </Button>
      </div>
    </>
  );
};
