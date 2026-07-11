import type { ProjectLabEventRecord, ProjectLabMode, ProjectLabSettings, ProjectSnapshot, ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { Bot, ChevronDown, ChevronRight, ExternalLink, FileText, Loader2, Rocket, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

type ModelOption = {
  id: string;
  label: string;
  modelId: string;
  providerType: ProviderType;
  providerFamily: UnifiedProviderFamily | null;
};

export type ProjectLabTabProps = {
  project: ProjectSnapshot;
  modelOptions: ModelOption[];
  settings: ProjectLabSettings;
  busy: boolean;
  branchOptions: string[];
  selectedBaseBranch: string;
  onBaseBranchChange: (value: string) => void;
  onSettingsChange: (settings: ProjectLabSettings) => void | Promise<void>;
  onRunProjectLab: (input: { mode: ProjectLabMode; baseBranch: string; implementationModelId: string; reviewModelId: string }) => void | Promise<void>;
  onDeleteThread: (threadId: string) => void | Promise<void>;
  onOpenImplementationRun: (runId: string) => void;
};

const PROJECT_LAB_MODE_OPTIONS: Array<{ mode: ProjectLabMode; label: string; description: string }> = [
  {
    mode: "new-feature",
    label: "New feature",
    description: "Find one useful product capability and implement the smallest reviewable slice.",
  },
  {
    mode: "bugfix",
    label: "Bugfix",
    description: "Find one likely defect or sharp edge and implement a focused fix.",
  },
  {
    mode: "refactoring",
    label: "Refactoring",
    description: "Find one bounded cleanup that improves maintainability without changing behavior.",
  },
  {
    mode: "rfc-only",
    label: "RFC only",
    description: "Find a larger opportunity and write an RFC instead of changing code.",
  },
];

const modeLabel = (mode: ProjectLabMode) => PROJECT_LAB_MODE_OPTIONS.find((option) => option.mode === mode)?.label ?? "Project Lab";

const eventToneClass = (role: ProjectLabEventRecord["role"]) => {
  if (role === "implementation") {
    return "border-[var(--ec-info-ring)] bg-[var(--ec-info-soft)]";
  }
  if (role === "review") {
    return "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)]";
  }
  if (role === "rfc") {
    return "border-violet-500/25 bg-violet-500/5";
  }
  return "border-zinc-800 bg-zinc-950/50";
};

const renderLabText = (text: string, className = ""): ReactNode => (
  <span className={`whitespace-pre-wrap break-words ${className}`}>{text}</span>
);

const implementationStatusLabel = (status: NonNullable<ProjectSnapshot["labThreads"][number]["implementationRun"]>["status"]) => {
  if (status === "completed") {
    return "Implementation completed";
  }
  if (status === "failed") {
    return "Implementation failed";
  }
  if (status === "cancelled") {
    return "Implementation cancelled";
  }
  return "Implementation running";
};

const implementationStatusToneClass = (status: NonNullable<ProjectSnapshot["labThreads"][number]["implementationRun"]>["status"]) => {
  if (status === "completed") {
    return {
      panel: "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)]",
      pill: "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]",
    };
  }
  if (status === "failed") {
    return {
      panel: "border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)]",
      pill: "border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]",
    };
  }
  if (status === "cancelled") {
    return {
      panel: "border-[var(--ec-border)] bg-[var(--ec-muted-soft)]",
      pill: "border-[var(--ec-border)] bg-[var(--ec-muted-soft)] text-[var(--ec-muted)]",
    };
  }
  return {
    panel: "border-[var(--ec-info-ring)] bg-[var(--ec-info-soft)]",
    pill: "border-[var(--ec-info-ring)] bg-[var(--ec-info-soft)] text-[var(--ec-info)]",
  };
};

export const ProjectLabTab = ({
  project,
  modelOptions,
  settings,
  busy,
  branchOptions,
  selectedBaseBranch,
  onBaseBranchChange,
  onSettingsChange,
  onRunProjectLab,
  onDeleteThread,
  onOpenImplementationRun,
}: ProjectLabTabProps) => {
  const [selectedMode, setSelectedMode] = useState<ProjectLabMode>("new-feature");
  const [expandedThreadIds, setExpandedThreadIds] = useState<Record<string, boolean>>({});
  const isFolderProject = project.project.kind === "folder";

  const sortedThreads = useMemo(
    () => [...project.labThreads].sort((left, right) => right.thread.createdAt.localeCompare(left.thread.createdAt)),
    [project.labThreads],
  );
  const selectedModeOption = PROJECT_LAB_MODE_OPTIONS.find((option) => option.mode === selectedMode) ?? PROJECT_LAB_MODE_OPTIONS[0];
  const normalizedBranchOptions = branchOptions.filter(Boolean);
  const fallbackModelId = modelOptions[0]?.id ?? "";
  const implementationModelId = settings.implementationModelId && modelOptions.some((option) => option.id === settings.implementationModelId)
    ? settings.implementationModelId
    : fallbackModelId;
  const reviewModelId = settings.reviewModelId && modelOptions.some((option) => option.id === settings.reviewModelId)
    ? settings.reviewModelId
    : fallbackModelId;
  const canRun = settings.enabled && (isFolderProject || Boolean(selectedBaseBranch)) && Boolean(implementationModelId) && Boolean(reviewModelId);

  return (
    <div className="space-y-4 pb-2">
      <Card className="overflow-hidden p-0">
        <div className="border-b border-zinc-800/80 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Sparkles className="h-4 w-4 text-cyan-400" />
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-zinc-100">Project Lab</h3>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Let AI find one useful change, implement it, then have a second agent review the result.
                </p>
              </div>
            </div>
            <label className="flex h-8 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 text-xs text-zinc-300">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--ec-accent)]"
                checked={settings.enabled}
                onChange={(event) => void onSettingsChange({ ...settings, enabled: event.target.checked })}
              />
              Enabled
            </label>
          </div>
        </div>

        <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="px-4 py-4">
            <div className="grid gap-3 lg:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Mode</span>
                <Select
                  value={selectedMode}
                  onValueChange={(value) => setSelectedMode(value as ProjectLabMode)}
                  options={PROJECT_LAB_MODE_OPTIONS.map((option) => ({
                    value: option.mode,
                    label: option.label,
                    description: option.description,
                  }))}
                />
              </label>
              {!isFolderProject ? (
                <label className="space-y-1.5">
                  <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Base branch</span>
                  <Select
                    value={selectedBaseBranch}
                    onValueChange={onBaseBranchChange}
                    options={normalizedBranchOptions.map((branch) => ({ value: branch, label: branch }))}
                  />
                </label>
              ) : null}
              <label className="space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Implementation model</span>
                <Select
                  value={implementationModelId}
                  onValueChange={(value) => void onSettingsChange({ ...settings, implementationModelId: value || null })}
                  options={[
                    { value: "", label: "No model selected" },
                    ...modelOptions.map((option) => ({ value: option.id, label: option.label })),
                  ]}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Review model</span>
                <Select
                  value={reviewModelId}
                  onValueChange={(value) => void onSettingsChange({ ...settings, reviewModelId: value || null })}
                  options={[
                    { value: "", label: "No model selected" },
                    ...modelOptions.map((option) => ({ value: option.id, label: option.label })),
                  ]}
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 text-xs text-zinc-500">{selectedModeOption.description}</p>
              <Button
                type="button"
                className="h-10"
                disabled={busy || !canRun}
                onClick={() =>
                  void onRunProjectLab({
                    mode: selectedMode,
                    baseBranch: isFolderProject ? "" : selectedBaseBranch,
                    implementationModelId,
                    reviewModelId,
                  })
                }
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}
                Start Project Lab
              </Button>
            </div>
          </div>

          <div className="border-t border-zinc-800/80 bg-zinc-950/35 px-4 py-4 xl:border-l xl:border-t-0">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              Limits
            </div>
            <p className="mt-1 text-xs text-zinc-500">Keep proactive lab work bounded per project.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
              <label className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
                <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Daily cap</span>
                <Input
                  className="mt-1 h-8"
                  type="number"
                  min={1}
                  max={20}
                  value={String(settings.maxThreadsPerDay)}
                  onChange={(event) =>
                    void onSettingsChange({ ...settings, maxThreadsPerDay: Math.min(20, Math.max(1, Number(event.target.value) || 1)) })
                  }
                />
              </label>
              <label className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
                <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Concurrent</span>
                <Input
                  className="mt-1 h-8"
                  type="number"
                  min={1}
                  max={6}
                  value={String(settings.maxConcurrentThreads)}
                  onChange={(event) =>
                    void onSettingsChange({ ...settings, maxConcurrentThreads: Math.min(6, Math.max(1, Number(event.target.value) || 1)) })
                  }
                />
              </label>
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-medium text-zinc-100">Lab Runs</h3>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Each run starts one implementation or RFC agent and records the follow-up review here.
        </p>

        <div className="mt-4 space-y-3">
          {sortedThreads.length > 0 ? (
            sortedThreads.map((detail) => {
              const isExpanded = expandedThreadIds[detail.thread.id] ?? false;
              const implementationRun = detail.implementationRun;
              const implementationStatus = implementationRun ? implementationStatusLabel(implementationRun.status) : null;
              const implementationStatusTone = implementationRun ? implementationStatusToneClass(implementationRun.status) : null;
              return (
                <div key={detail.thread.id} className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
                  <div
                    className="flex cursor-pointer flex-wrap items-start justify-between gap-3"
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      setExpandedThreadIds((current) => ({
                        ...current,
                        [detail.thread.id]: !isExpanded,
                      }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setExpandedThreadIds((current) => ({
                          ...current,
                          [detail.thread.id]: !isExpanded,
                        }));
                      }
                    }}
                  >
                    <div className="min-w-0 flex-1 text-left">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] text-cyan-100">
                          {modeLabel(detail.thread.mode)}
                        </span>
                        <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2.5 py-1 text-[11px] text-zinc-300">
                          {detail.thread.status}
                        </span>
                        {detail.thread.baseBranch ? (
                          <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2.5 py-1 font-mono text-[11px] text-zinc-300">
                            {detail.thread.baseBranch}
                          </span>
                        ) : null}
                        <span className="ml-1 text-zinc-500">
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </span>
                      </div>
                      <h4 className="mt-2 text-sm font-medium text-zinc-100">{detail.thread.title}</h4>
                      <p className="mt-1 text-xs text-zinc-400">{renderLabText(detail.thread.summary)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {implementationRun ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 px-0 text-zinc-500 hover:text-cyan-200"
                          title="Open implementation run"
                          aria-label="Open implementation run"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenImplementationRun(implementationRun.id);
                          }}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-zinc-500 hover:text-rose-200"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onDeleteThread(detail.thread.id);
                        }}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  </div>

                  {isExpanded ? (
                    <div className="mt-3 space-y-2">
                      {implementationStatus ? (
                        <div className={`rounded-lg border px-3 py-2 ${implementationStatusTone?.panel ?? ""}`}>
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                              <span className={`rounded-full border px-2.5 py-1 text-[11px] ${implementationStatusTone?.pill ?? ""}`}>
                                {implementationStatus}
                              </span>
                              {implementationRun ? (
                                <span className="ml-2 font-mono text-xs text-zinc-500">
                                  {implementationRun.workspaceVcs === "folder"
                                    ? implementationRun.workspaceType === "copy"
                                      ? "Folder copy"
                                      : "Project folder"
                                    : implementationRun.branchName}
                                </span>
                              ) : null}
                              {implementationRun?.errorMessage ? (
                                <p className="mt-2 text-xs text-rose-300">{renderLabText(implementationRun.errorMessage)}</p>
                              ) : null}
                            </div>
                            {implementationRun ? (
                              <Button type="button" size="sm" variant="secondary" onClick={() => onOpenImplementationRun(implementationRun.id)}>
                                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                                Open run
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {detail.events.map((event) => (
                        <div key={event.id} className={`rounded-lg border px-3 py-2 text-sm leading-relaxed ${eventToneClass(event.role)}`}>
                          <div className="mb-1 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                            <span className="flex min-w-0 items-center gap-1.5">
                              {event.role === "rfc" ? <FileText className="h-3.5 w-3.5 text-violet-300" /> : null}
                              {event.role === "review" ? <ShieldCheck className="h-3.5 w-3.5 text-[var(--ec-success)]" /> : null}
                              {event.role === "implementation" ? <Rocket className="h-3.5 w-3.5 text-[var(--ec-info)]" /> : null}
                              <span className="truncate">{event.label}</span>
                            </span>
                            <span className="shrink-0 font-normal normal-case tracking-normal text-zinc-600">
                              {new Date(event.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <div className="text-zinc-300">{renderLabText(event.content)}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-10 text-center text-sm text-zinc-500">
              No Project Lab runs yet. Enable the lab, choose implementation and review models, then start one.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
