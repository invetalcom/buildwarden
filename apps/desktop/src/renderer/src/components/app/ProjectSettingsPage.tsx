import {
  MAX_PROJECT_FORGE_PR_MONITOR_INTERVAL_MINUTES,
  parseProjectForgePrMonitorIntervalMinutes,
  type IntegratedSkillMetadata,
  type ProjectForgeAuthStatus,
  type ProjectSnapshot,
  type ProviderType,
  type RunMode,
  type RunWorkspaceType,
  type UnifiedProviderFamily,
} from "@buildwarden/shared";
import {
  BrainCircuit,
  Check,
  FolderGit2,
  GitBranch,
  KeyRound,
  PlayCircle,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  WalletCards,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import type { ProjectRunStats } from "./ProjectStatisticsCard";
import { ProjectSkillSelector } from "./project-skill-selector";

interface ProjectSettingsPageProps {
  project: ProjectSnapshot;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  availableBranches: string[];
  currentProjectBranch: string;
  runMode: RunMode;
  runWorkspaceType: RunWorkspaceType;
  runBaseBranch: string;
  runModelId: string;
  runWorktreeModelIds: string[];
  projectRunStats: ProjectRunStats;
  reasoningEffort: string;
  anthropicEffort: string;
  yoloMode: boolean;
  busy: boolean;
  availableIntegratedSkills: IntegratedSkillMetadata[];
  activeIntegratedSkillIds: string[];
  onRunModeChange: (value: RunMode) => void;
  onRunWorkspaceTypeChange: (value: RunWorkspaceType) => void;
  onRunBaseBranchChange: (value: string) => void;
  onRunModelChange: (modelId: string) => void;
  onRunWorktreeModelIdsChange: (modelIds: string[]) => void;
  onReasoningEffortChange: (value: string) => void;
  onAnthropicEffortChange: (value: string) => void;
  onYoloModeChange: (value: boolean) => void;
  onActiveIntegratedSkillIdsChange: (skillIds: string[]) => void | Promise<void>;
  onDeleteProject: () => void | Promise<void>;
}

const runModes: Array<{ id: RunMode; label: string; description: string }> = [
  { id: "code", label: "Code", description: "Edit files and run tools." },
  { id: "plan", label: "Plan", description: "Think first, then wait." },
  { id: "ask", label: "Ask", description: "Answer without changes." },
];

const workspaceModes: Array<{ id: RunWorkspaceType; label: string; description: string }> = [
  { id: "worktree", label: "Worktree", description: "Isolated branch per run." },
  { id: "local", label: "Local", description: "Use the current checkout." },
];

const folderWorkspaceModes: Array<{ id: RunWorkspaceType; label: string; description: string }> = [
  { id: "copy", label: "Copy", description: "Copy files to an isolated workspace." },
  { id: "local", label: "Folder", description: "Edit the project folder directly." },
];

const effortOptions = ["low", "medium", "high", "xhigh"];

const SummaryTile = ({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail?: string }) => (
  <div className="min-w-0 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2.5">
    <div className="flex items-center gap-2 text-xs text-[var(--ec-muted)]">
      {icon}
      <span className="truncate">{label}</span>
    </div>
    <p className="mt-1 truncate text-sm font-semibold text-[var(--ec-text)]">{value}</p>
    {detail ? <p className="mt-0.5 truncate text-[11px] text-[var(--ec-faint)]">{detail}</p> : null}
  </div>
);

const ChoiceButton = ({
  selected,
  disabled,
  label,
  description,
  onClick,
}: {
  selected: boolean;
  disabled: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    className={cn(
      "group min-w-0 rounded-md border p-3 text-left transition",
      selected
        ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] shadow-[inset_0_0_0_1px_var(--ec-accent-ring)]"
        : "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)]",
    )}
    onClick={onClick}
    disabled={disabled}
  >
    <span className="flex items-center justify-between gap-2">
      <span className="truncate text-sm font-semibold text-[var(--ec-text)]">{label}</span>
      {selected ? <Check className="size-3.5 shrink-0 text-[var(--ec-accent)]" /> : null}
    </span>
    <span className="mt-1 block truncate text-xs text-[var(--ec-muted)]">{description}</span>
  </button>
);

const EffortRow = ({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) => (
  <div className="rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-2.5">
    <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--ec-muted)]">
      <BrainCircuit className="size-3.5 shrink-0 text-[var(--ec-accent)]" />
      <span className="truncate">{label}</span>
      <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--ec-faint)]">{value}</span>
    </div>
    <div className="mt-2 grid grid-cols-4 gap-1">
      {effortOptions.map((effort) => (
        <Button
          key={effort}
          type="button"
          size="xs"
          variant={value === effort ? "default" : "secondary"}
          onClick={() => onChange(effort)}
          disabled={disabled}
        >
          {effort}
        </Button>
      ))}
    </div>
  </div>
);

type SettingsSectionProps = {
  title: string;
  children: ReactNode;
};

type SettingsRowProps = {
  title: string;
  description: ReactNode;
  children: ReactNode;
  align?: "center" | "start";
};

const SettingsSection = ({ title, children }: SettingsSectionProps) => (
  <section className="space-y-2">
    <h3 className="px-1 text-sm font-semibold text-[var(--ec-text)]">{title}</h3>
    <Card className="overflow-hidden p-0 shadow-none">{children}</Card>
  </section>
);

const SettingsRow = ({ title, description, children, align = "center" }: SettingsRowProps) => (
  <div
    className={`grid gap-3 border-b border-[var(--ec-border)] px-4 py-3 last:border-b-0 md:grid-cols-[minmax(14rem,0.85fr)_minmax(18rem,1.35fr)] ${
      align === "start" ? "md:items-start" : "md:items-center"
    }`}
  >
    <div className="min-w-0">
      <p className="text-sm font-medium text-[var(--ec-text)]">{title}</p>
      <div className="mt-1 text-xs leading-5 text-[var(--ec-muted)]">{description}</div>
    </div>
    <div className={`min-w-0 w-full md:justify-self-end ${align === "start" ? "md:self-start" : "md:self-center"}`}>{children}</div>
  </div>
);

const rowControlClass = "w-full md:max-w-[58rem]";

export const ProjectSettingsPage = ({
  project,
  modelOptions,
  availableBranches,
  currentProjectBranch,
  runMode,
  runWorkspaceType,
  runBaseBranch,
  runModelId,
  runWorktreeModelIds,
  projectRunStats,
  reasoningEffort,
  anthropicEffort,
  yoloMode,
  busy,
  availableIntegratedSkills,
  activeIntegratedSkillIds,
  onRunModeChange,
  onRunWorkspaceTypeChange,
  onRunBaseBranchChange,
  onRunModelChange,
  onRunWorktreeModelIdsChange,
  onReasoningEffortChange,
  onAnthropicEffortChange,
  onYoloModeChange,
  onActiveIntegratedSkillIdsChange,
  onDeleteProject,
}: ProjectSettingsPageProps) => {
  const isFolderProject = project.project.kind === "folder";
  const workspaceModeChoices = isFolderProject ? folderWorkspaceModes : workspaceModes;
  const selectedModelIds =
    runWorkspaceType === "worktree" || runWorkspaceType === "copy"
      ? runWorktreeModelIds
      : runModelId
        ? [runModelId]
        : [];
  const activeSkillCount = activeIntegratedSkillIds.length;
  const branchChoices = isFolderProject ? [] : (runWorkspaceType === "local" ? [currentProjectBranch] : availableBranches).filter(Boolean);
  const formatTokens = (value: number) => value.toLocaleString();
  const outcomeSummary = `${projectRunStats.completed} done / ${projectRunStats.failed} failed / ${projectRunStats.cancelled} stopped`;
  const totalRunsLabel =
    projectRunStats.active > 0
      ? `${projectRunStats.total.toLocaleString()} (${projectRunStats.active.toLocaleString()} active)`
      : projectRunStats.total.toLocaleString();
  const [forgeStatus, setForgeStatus] = useState<ProjectForgeAuthStatus | null>(null);
  const [forgeToken, setForgeToken] = useState("");
  const [forgeBusy, setForgeBusy] = useState(false);
  const [forgeError, setForgeError] = useState<string | null>(null);
  const [forgeMessage, setForgeMessage] = useState<string | null>(null);
  const [forgeMonitorEnabled, setForgeMonitorEnabled] = useState(false);
  const [forgeMonitorIntervalMinutes, setForgeMonitorIntervalMinutes] = useState("0");
  const [forgeMonitorBusy, setForgeMonitorBusy] = useState(false);
  const [forgeMonitorError, setForgeMonitorError] = useState<string | null>(null);
  const [forgeMonitorMessage, setForgeMonitorMessage] = useState<string | null>(null);
  const forgeMonitorAutosaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (forgeMonitorAutosaveTimerRef.current !== null) {
      window.clearTimeout(forgeMonitorAutosaveTimerRef.current);
      forgeMonitorAutosaveTimerRef.current = null;
    }
    setForgeStatus(null);
    setForgeToken("");
    setForgeError(null);
    setForgeMessage(null);
    setForgeMonitorEnabled(false);
    setForgeMonitorIntervalMinutes("0");
    setForgeMonitorError(null);
    setForgeMonitorMessage(null);
    if (project.project.kind === "folder") {
      setForgeBusy(false);
      setForgeMonitorBusy(false);
      return () => {
        cancelled = true;
      };
    }
    setForgeBusy(true);
    setForgeMonitorBusy(true);
    void Promise.all([
      window.buildwarden.getProjectForgeAuthStatus(project.project.id),
      window.buildwarden.getProjectForgePrMonitorSettings(project.project.id),
    ])
      .then(([status, monitorSettings]) => {
        if (!cancelled) {
          const intervalMinutes = parseProjectForgePrMonitorIntervalMinutes(monitorSettings.intervalMinutes);
          setForgeStatus(status);
          setForgeMonitorEnabled(intervalMinutes > 0);
          setForgeMonitorIntervalMinutes(String(intervalMinutes));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setForgeError(error instanceof Error ? error.message : "Could not detect the Git hosting remote.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setForgeBusy(false);
          setForgeMonitorBusy(false);
        }
      });

    return () => {
      cancelled = true;
      if (forgeMonitorAutosaveTimerRef.current !== null) {
        window.clearTimeout(forgeMonitorAutosaveTimerRef.current);
        forgeMonitorAutosaveTimerRef.current = null;
      }
    };
  }, [project.project.id, project.project.kind]);

  const saveForgeToken = async () => {
    setForgeError(null);
    setForgeMessage(null);
    setForgeMonitorError(null);
    setForgeMonitorMessage(null);
    try {
      setForgeBusy(true);
      const status = await window.buildwarden.saveProjectForgeAuthToken(project.project.id, forgeToken);
      setForgeStatus(status);
      setForgeToken("");
      setForgeMessage("Token saved.");
    } catch (error) {
      setForgeError(error instanceof Error ? error.message : "Could not save the token.");
    } finally {
      setForgeBusy(false);
    }
  };

  const removeForgeToken = async () => {
    setForgeError(null);
    setForgeMessage(null);
    setForgeMonitorError(null);
    setForgeMonitorMessage(null);
    try {
      setForgeBusy(true);
      const status = await window.buildwarden.deleteProjectForgeAuthToken(project.project.id);
      setForgeStatus(status);
      setForgeToken("");
      setForgeMonitorEnabled(false);
      setForgeMonitorIntervalMinutes("0");
      setForgeMessage("Token removed.");
    } catch (error) {
      setForgeError(error instanceof Error ? error.message : "Could not remove the token.");
    } finally {
      setForgeBusy(false);
    }
  };

  const persistForgeMonitorInterval = async (nextInterval: number, successMessage: string) => {
    setForgeMonitorError(null);
    setForgeMonitorMessage(null);
    try {
      setForgeMonitorBusy(true);
      const settings = await window.buildwarden.saveProjectForgePrMonitorSettings(project.project.id, {
        intervalMinutes: nextInterval,
      });
      setForgeMonitorEnabled(settings.intervalMinutes > 0);
      setForgeMonitorIntervalMinutes(String(settings.intervalMinutes));
      setForgeMonitorMessage(successMessage);
    } catch (error) {
      setForgeMonitorError(error instanceof Error ? error.message : "Could not save background check settings.");
    } finally {
      setForgeMonitorBusy(false);
    }
  };

  const updateForgeMonitorEnabled = (enabled: boolean) => {
    if (forgeMonitorAutosaveTimerRef.current !== null) {
      window.clearTimeout(forgeMonitorAutosaveTimerRef.current);
      forgeMonitorAutosaveTimerRef.current = null;
    }
    setForgeMonitorEnabled(enabled);
    setForgeMonitorError(null);
    setForgeMonitorMessage(null);
    const nextInterval = enabled ? Math.max(1, parseProjectForgePrMonitorIntervalMinutes(forgeMonitorIntervalMinutes) || 15) : 0;
    setForgeMonitorIntervalMinutes(String(nextInterval));
    void persistForgeMonitorInterval(nextInterval, enabled ? "Background checks enabled." : "Background checks disabled.");
  };

  const updateForgeMonitorIntervalMinutes = (value: string) => {
    setForgeMonitorIntervalMinutes(value);
    setForgeMonitorMessage(null);
    setForgeMonitorError(null);
    if (!forgeMonitorEnabled) {
      return;
    }
    if (forgeMonitorAutosaveTimerRef.current !== null) {
      window.clearTimeout(forgeMonitorAutosaveTimerRef.current);
    }
    forgeMonitorAutosaveTimerRef.current = window.setTimeout(() => {
      forgeMonitorAutosaveTimerRef.current = null;
      const nextInterval = parseProjectForgePrMonitorIntervalMinutes(value);
      if (nextInterval <= 0) {
        setForgeMonitorError("Enter at least 1 minute, or turn off background checks.");
        return;
      }
      void persistForgeMonitorInterval(nextInterval, "Background check interval saved.");
    }, 600);
  };

  const toggleWorktreeModel = (modelId: string) => {
    const next = new Set(runWorktreeModelIds);
    if (next.has(modelId)) {
      if (next.size <= 1) return;
      next.delete(modelId);
    } else {
      next.add(modelId);
    }
    onRunWorktreeModelIdsChange(modelOptions.map((option) => option.id).filter((id) => next.has(id)));
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      <Card className="shrink-0 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="min-w-0 flex-1 truncate text-xl font-semibold text-[var(--ec-text)]">{project.project.name}</h2>
          <div className="flex min-w-0 flex-[1.4] items-center justify-end gap-2">
            <button
              type="button"
              className="flex h-8 min-w-0 max-w-[48rem] flex-1 items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 text-left text-xs text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
              onClick={async () => {
                const r = await window.buildwarden.openPathInFileManager(project.project.repoPath);
                if (!r.ok && r.error) {
                  window.alert(`Could not open folder: ${r.error}`);
                }
              }}
              title={project.project.repoPath}
            >
              <FolderGit2 className="size-3.5 shrink-0 text-[var(--ec-accent)]" />
              <span className="truncate font-mono">{project.project.repoPath}</span>
            </button>
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-2 text-[var(--ec-danger)] hover:text-[var(--ec-danger-strong)]"
              onClick={() => void onDeleteProject()}
              title="Delete project"
              aria-label="Delete project"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      </Card>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="border-b border-[var(--ec-border)] p-4">
          <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <CardTitle className="text-xl">Project profile</CardTitle>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Badge dot tone={project.activeRuns.length > 0 ? "running" : "neutral"}>
                {project.activeRuns.length > 0 ? `${project.activeRuns.length} active` : "idle"}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-5">
          {isFolderProject ? (
            <>
              <SummaryTile
                icon={<FolderGit2 className="size-3.5 text-[var(--ec-accent)]" />}
                label="Project type"
                value="Folder"
                detail="Git history unavailable"
              />
              <SummaryTile
                icon={<GitBranch className="size-3.5 text-[var(--ec-accent)]" />}
                label="Workspace modes"
                value="Copy / Folder"
                detail="No branch checkout required"
              />
            </>
          ) : (
            <>
              <SummaryTile
                icon={<GitBranch className="size-3.5 text-[var(--ec-accent)]" />}
                label="Current branch"
                value={currentProjectBranch || "unknown"}
                detail={`Default: ${project.project.defaultBranch || "unknown"}`}
              />
              <SummaryTile
                icon={<GitBranch className="size-3.5 text-[var(--ec-accent)]" />}
                label="Known branches"
                value={`${availableBranches.length}`}
                detail="Available local and remote branches"
              />
            </>
          )}
          <SummaryTile
            icon={<Sparkles className="size-3.5 text-[var(--ec-accent)]" />}
            label="Project skills"
            value={`${activeSkillCount} enabled`}
            detail={availableIntegratedSkills.length > 0 ? `${availableIntegratedSkills.length} available` : "No enabled skills"}
          />
          <SummaryTile
            icon={<PlayCircle className="size-3.5 text-[var(--ec-accent)]" />}
            label="Total runs"
            value={totalRunsLabel}
            detail={outcomeSummary}
          />
          <SummaryTile
            icon={<WalletCards className="size-3.5 text-[var(--ec-accent)]" />}
            label="Tokens"
            value={formatTokens(projectRunStats.totalTokens)}
            detail={`${formatTokens(projectRunStats.inputTokens)} in / ${formatTokens(projectRunStats.outputTokens)} out`}
          />
        </CardContent>
      </Card>

      <div className="space-y-5">
        <SettingsSection title="Run defaults">
          <SettingsRow title="Mode" description="Default behavior used when starting new agent runs from this project.">
            <div className={`${rowControlClass} grid gap-2 md:grid-cols-3`}>
              {runModes.map((mode) => (
                <ChoiceButton
                  key={mode.id}
                  selected={runMode === mode.id}
                  disabled={busy}
                  label={mode.label}
                  description={mode.description}
                  onClick={() => onRunModeChange(mode.id)}
                />
              ))}
            </div>
          </SettingsRow>

          <SettingsRow
            title="Workspace"
            description={isFolderProject ? "Choose whether new runs use an isolated folder copy or edit the project folder directly." : "Choose whether new runs use isolated worktrees or the current project checkout."}
          >
            <div className={`${rowControlClass} grid gap-2 sm:grid-cols-2`}>
              {workspaceModeChoices.map((mode) => (
                <ChoiceButton
                  key={mode.id}
                  selected={runWorkspaceType === mode.id}
                  disabled={busy}
                  label={mode.label}
                  description={mode.description}
                  onClick={() => onRunWorkspaceTypeChange(mode.id)}
                />
              ))}
            </div>
          </SettingsRow>

          {!isFolderProject ? (
            <SettingsRow
              title="Base branch"
              description={runWorkspaceType === "local" ? "Local runs use the current checkout branch." : "Worktree runs branch from this selected base."}
              align="start"
            >
              <div className={`${rowControlClass} min-w-0 overflow-hidden rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)]`}>
                <div className="flex items-center justify-between gap-3 border-b border-[var(--ec-border)] px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-[var(--ec-text)]">
                    <GitBranch className="size-3.5 shrink-0 text-[var(--ec-accent)]" />
                    <span className="truncate">Base branch</span>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--ec-faint)]">{branchChoices.length}</span>
                </div>
                <div className="app-scrollbar max-h-56 overflow-y-auto p-1.5">
                  {branchChoices.map((branch) => {
                    const selected = (runWorkspaceType === "local" ? currentProjectBranch : runBaseBranch) === branch;
                    return (
                      <button
                        key={branch}
                        type="button"
                        className={cn(
                          "flex h-8 w-full items-center gap-2 rounded px-2 text-left font-mono text-xs transition",
                          selected
                            ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]"
                            : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
                        )}
                        disabled={busy || runWorkspaceType === "local"}
                        onClick={() => onRunBaseBranchChange(branch)}
                      >
                        <GitBranch className="size-3.5 shrink-0" />
                        <span className="truncate">{branch}</span>
                        {selected ? <span className="ml-auto size-1.5 shrink-0 rounded-full bg-[var(--ec-accent)]" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </SettingsRow>
          ) : null}

          <SettingsRow
            title="Model set"
            description={runWorkspaceType === "worktree" || runWorkspaceType === "copy" ? "Select one or more models for isolated workspace runs." : "Select the default model for direct workspace runs."}
            align="start"
          >
            <div className={`${rowControlClass} min-w-0 overflow-hidden rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)]`}>
              <div className="flex items-center justify-between gap-3 border-b border-[var(--ec-border)] px-3 py-2">
                <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-[var(--ec-text)]">
                  <SlidersHorizontal className="size-3.5 shrink-0 text-[var(--ec-accent)]" />
                  <span className="truncate">Model set</span>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-[var(--ec-faint)]">{selectedModelIds.length}</span>
              </div>
              <div className="app-scrollbar max-h-56 overflow-y-auto p-1.5">
                {modelOptions.map((model) => {
                  const selected = selectedModelIds.includes(model.id);
                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={cn(
                        "flex h-8 w-full items-center justify-between gap-2 rounded px-2 text-left text-xs transition",
                        selected
                          ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]"
                          : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
                      )}
                      disabled={busy}
                      onClick={() => {
                        if (runWorkspaceType === "worktree" || runWorkspaceType === "copy") {
                          toggleWorktreeModel(model.id);
                        } else {
                          onRunModelChange(model.id);
                        }
                      }}
                    >
                      <span className="truncate">{model.label}</span>
                      {selected ? <span className="size-1.5 shrink-0 rounded-full bg-[var(--ec-accent)]" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </SettingsRow>

          <SettingsRow title="Reasoning effort" description="Effort used when the selected provider supports reasoning controls." align="start">
            <div className={`${rowControlClass} grid gap-2 md:grid-cols-2`}>
              <EffortRow label="OpenAI / Codex" value={reasoningEffort} onChange={onReasoningEffortChange} disabled={busy} />
              <EffortRow label="Claude" value={anthropicEffort} onChange={onAnthropicEffortChange} disabled={busy} />
            </div>
          </SettingsRow>

          <SettingsRow title="Full Access" description="Skip per-tool approvals for new runs in this project.">
            <div className={`${rowControlClass} space-y-2`}>
              <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--ec-text)]">{yoloMode ? "Full access enabled" : "Approvals required"}</p>
                  <p className="mt-1 text-xs text-[var(--ec-muted)]">
                    {yoloMode ? "Trusted shell and tool actions can run without prompting." : "Untrusted shell and tool actions ask first."}
                  </p>
                </div>
                <Switch checked={yoloMode} onCheckedChange={onYoloModeChange} disabled={busy} />
              </div>
              <div className="flex items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3 text-xs text-[var(--ec-muted)]">
                <ShieldOff className="size-3.5 shrink-0 text-[var(--ec-danger)]" />
                <span className="min-w-0">Full Access applies to future runs and should only be used for trusted project folders.</span>
              </div>
            </div>
          </SettingsRow>
        </SettingsSection>

        {!isFolderProject ? <SettingsSection title="Git hosting">
          <SettingsRow
            title="Access token"
            description="Token used to fetch and review PRs/MRs for this project. Secrets are stored outside the app database."
            align="start"
          >
            <div className={`${rowControlClass} space-y-2`}>
              <div className="flex items-start justify-between gap-3 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--ec-muted)]">
                    <KeyRound className="size-3.5 shrink-0 text-[var(--ec-accent)]" />
                    <span className="shrink-0">{forgeStatus?.provider === "gitlab" ? "GitLab" : forgeStatus?.provider === "github" ? "GitHub" : "Detecting"}</span>
                    <span className="min-w-0 truncate font-mono text-[var(--ec-text)]">{forgeStatus?.repoLabel ?? project.project.name}</span>
                  </div>
                  {forgeStatus?.webBaseUrl ? (
                    <p className="mt-1 truncate font-mono text-[11px] text-[var(--ec-faint)]">{forgeStatus.webBaseUrl}</p>
                  ) : null}
                </div>
                <Badge tone={forgeStatus?.hasToken ? "completed" : "neutral"}>
                  {forgeStatus?.hasToken ? "token saved" : "no token"}
                </Badge>
              </div>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-[var(--ec-muted)]">Access token</span>
                <Input
                  type="password"
                  value={forgeToken}
                  onChange={(event) => setForgeToken(event.target.value)}
                  placeholder={
                    forgeStatus?.hasToken
                      ? "................"
                      : forgeStatus?.provider === "gitlab"
                        ? "GitLab personal or project access token"
                        : "GitHub personal access token"
                  }
                  className="h-8 font-mono text-xs"
                  disabled={busy || forgeBusy}
                />
              </label>

              <div className="flex flex-wrap items-center justify-start gap-2 md:justify-end">
                <Button type="button" size="sm" className="h-8 px-2.5" onClick={() => void saveForgeToken()} disabled={busy || forgeBusy || !forgeToken.trim()}>
                  Save token
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-8 px-2.5"
                  onClick={() => void removeForgeToken()}
                  disabled={busy || forgeBusy || !forgeStatus?.hasToken}
                >
                  Remove
                </Button>
              </div>

              {forgeError ? <p className="text-xs text-[var(--ec-danger)] md:text-right">{forgeError}</p> : null}
              {forgeMessage ? <p className="text-xs text-[var(--ec-success)] md:text-right">{forgeMessage}</p> : null}
            </div>
          </SettingsRow>

          {forgeStatus?.hasToken ? (
            <SettingsRow
              title="Background PR/MR checks"
              description="Poll open requests and notify only requests first seen after monitoring starts."
              align="start"
            >
              <div className={`${rowControlClass} space-y-3`}>
                <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--ec-text)]">Enable background checks</p>
                    <p className="mt-1 text-xs text-[var(--ec-muted)]">Turn off to stop polling while keeping this access token saved.</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {forgeMonitorEnabled ? (
                      <label className="flex min-w-0 items-center gap-2">
                        <span className="text-xs font-medium text-[var(--ec-muted)]">Check every</span>
                        <Input
                          type="number"
                          min={1}
                          max={MAX_PROJECT_FORGE_PR_MONITOR_INTERVAL_MINUTES}
                          step={1}
                          value={forgeMonitorIntervalMinutes}
                          onChange={(event) => updateForgeMonitorIntervalMinutes(event.target.value)}
                          className="h-8 w-28 font-mono text-xs"
                          disabled={busy || forgeBusy || forgeMonitorBusy}
                        />
                        <span className="text-xs text-[var(--ec-muted)]">minutes</span>
                      </label>
                    ) : null}
                    <Switch checked={forgeMonitorEnabled} onCheckedChange={updateForgeMonitorEnabled} disabled={busy || forgeBusy || forgeMonitorBusy} />
                  </div>
                </div>

                {forgeMonitorError ? <p className="text-xs text-[var(--ec-danger)] md:text-right">{forgeMonitorError}</p> : null}
                {forgeMonitorMessage ? <p className="text-xs text-[var(--ec-success)] md:text-right">{forgeMonitorMessage}</p> : null}
              </div>
            </SettingsRow>
          ) : null}
        </SettingsSection> : null}

        <SettingsSection title="Project skills">
          <SettingsRow title="Enabled skills" description="Skills selected here are prepended to new agent runs for this project." align="start">
            <div className={`${rowControlClass} space-y-3`}>
              <div className="flex justify-start md:justify-end">
                <Badge tone="neutral">{activeSkillCount} selected</Badge>
              </div>
              <div className="flex justify-start md:justify-end">
                <ProjectSkillSelector
                  skills={availableIntegratedSkills}
                  selectedSkillIds={activeIntegratedSkillIds}
                  disabled={busy}
                  onChange={onActiveIntegratedSkillIdsChange}
                />
              </div>
            </div>
          </SettingsRow>
        </SettingsSection>
      </div>
    </div>
  );
};
