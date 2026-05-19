import type { ProjectLabMode, ProjectLabSettings, ProjectSnapshot, ProviderType, UnifiedProviderFamily } from "@easycode/shared";
import { Bot, ChevronDown, ChevronRight, ExternalLink, Lightbulb, Loader2, Play, Settings2, Sparkles, Trash2, Users } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";

type ModelOption = {
  id: string;
  label: string;
  modelId: string;
  providerType: ProviderType;
  providerFamily: UnifiedProviderFamily | null;
};

type ProjectLabTabProps = {
  project: ProjectSnapshot;
  modelOptions: ModelOption[];
  settings: ProjectLabSettings;
  busy: boolean;
  branchOptions: string[];
  selectedBaseBranch: string;
  onBaseBranchChange: (value: string) => void;
  onSettingsChange: (settings: ProjectLabSettings) => void | Promise<void>;
  onRunProjectLab: (input: { mode: ProjectLabMode; baseBranch: string }) => void | Promise<void>;
  onStartImplementation: (threadId: string) => void | Promise<void>;
  onDeleteThread: (threadId: string) => void | Promise<void>;
  onOpenImplementationRun: (runId: string) => void;
};

const COLOR_STYLES: Record<string, string> = {
  slate: "border-slate-700/80 bg-slate-950/70 text-slate-100",
  cyan: "border-cyan-700/40 bg-cyan-950/30 text-cyan-50",
  rose: "border-rose-700/40 bg-rose-950/30 text-rose-50",
  amber: "border-amber-700/40 bg-amber-950/30 text-amber-50",
  emerald: "border-emerald-700/40 bg-emerald-950/30 text-emerald-50",
  violet: "border-violet-700/40 bg-violet-950/30 text-violet-50",
  zinc: "border-zinc-800 bg-zinc-950/60 text-zinc-200",
};

const PROJECT_LAB_MODE_OPTIONS: Array<{ mode: ProjectLabMode; label: string; description: string }> = [
  {
    mode: "new-feature",
    label: "New feature",
    description: "Find a user-facing capability or workflow slice worth building.",
  },
  {
    mode: "bugfix",
    label: "Bugfix",
    description: "Hunt for a likely defect, sharp edge, or reliability issue.",
  },
  {
    mode: "refactoring",
    label: "Refactoring",
    description: "Find a bounded simplification with a clear safety net.",
  },
  {
    mode: "rfc-only",
    label: "RFC only",
    description: "Draft a larger proposal without starting implementation.",
  },
];

const modeLabel = (mode: ProjectSnapshot["labThreads"][number]["thread"]["mode"]) => {
  if (mode === "new-feature") {
    return "New feature";
  }
  if (mode === "bugfix") {
    return "Bugfix";
  }
  if (mode === "refactoring") {
    return "Refactoring";
  }
  return "RFC only";
};

const markdownFileLinkPattern = /\[([^\]\n]{1,220})\]\(([^)\n]{1,260})\)/g;
const windowsPathPattern = /[A-Za-z]:[\\/][^\s)\]]+/g;
const relativeRepoPathPattern = /\b(?:apps|packages)\/[^\s)\]]+/g;

type FormattedTextPart =
  | {
      type: "text";
      value: string;
    }
  | {
      type: "file";
      label: string;
      path: string;
    };

const compactPathLabel = (path: string, fallbackLabel?: string) => {
  const normalized = path.replaceAll("\\", "/");
  const cleanFallback = fallbackLabel?.replaceAll("\\", "/").replace(/^\[|\]$/g, "").trim();
  if (cleanFallback && cleanFallback.length <= 80 && !/^[A-Za-z]:\//.test(cleanFallback)) {
    return cleanFallback;
  }

  const knownRoot = normalized.match(/(?:^|\/)((?:apps|packages)\/.+)$/);
  if (knownRoot) {
    return knownRoot[1];
  }

  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || normalized;
};

const isLikelyFilePath = (value: string) => {
  const normalized = value.replaceAll("\\", "/").trim();
  return /^[A-Za-z]:\//.test(normalized) || /^(?:apps|packages)\//.test(normalized);
};

const splitPathParts = (text: string): FormattedTextPart[] => {
  const parts: FormattedTextPart[] = [];
  let cursor = 0;
  const matches = [
    ...Array.from(text.matchAll(windowsPathPattern), (match) => ({ index: match.index ?? 0, value: match[0] })),
    ...Array.from(text.matchAll(relativeRepoPathPattern), (match) => ({ index: match.index ?? 0, value: match[0] })),
  ].sort((left, right) => left.index - right.index);

  for (const match of matches) {
    const index = match.index;
    const rawPath = match.value;
    if (index < cursor) {
      continue;
    }
    const trimmedPath = rawPath.replace(/[.,;:]+$/u, "");
    const trailing = rawPath.slice(trimmedPath.length);

    if (index > cursor) {
      parts.push({ type: "text", value: text.slice(cursor, index) });
    }

    parts.push({ type: "file", label: compactPathLabel(trimmedPath), path: trimmedPath });
    if (trailing) {
      parts.push({ type: "text", value: trailing });
    }
    cursor = index + rawPath.length;
  }

  if (cursor < text.length) {
    parts.push({ type: "text", value: text.slice(cursor) });
  }

  return parts;
};

const formatLabTextParts = (text: string): FormattedTextPart[] => {
  const parts: FormattedTextPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(markdownFileLinkPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push(...splitPathParts(text.slice(cursor, index)));
    }

    const label = match[1].trim();
    const path = match[2].trim();
    if (isLikelyFilePath(path)) {
      parts.push({ type: "file", label: compactPathLabel(path, label), path });
    } else {
      parts.push({ type: "text", value: match[0] });
    }
    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    parts.push(...splitPathParts(text.slice(cursor)));
  }

  return parts;
};

const renderLabText = (text: string, className = ""): ReactNode => {
  const parts = formatLabTextParts(text);
  return (
    <span className={`whitespace-pre-wrap break-words ${className}`}>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return <span key={`${index}-text`}>{part.value}</span>;
        }

        return (
          <button
            key={`${index}-${part.path}`}
            type="button"
            title={part.path}
            className="mx-0.5 inline-flex max-w-full align-baseline text-cyan-200 underline decoration-cyan-400/50 underline-offset-2 hover:text-cyan-100"
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              void window.easycode.openPathInFileManager(part.path);
            }}
          >
            {part.label}
          </button>
        );
      })}
    </span>
  );
};

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
  return "Implementation in progress";
};

const threadImplementationStatusLabel = (status: ProjectSnapshot["labThreads"][number]["thread"]["status"]) => {
  if (status === "implemented") {
    return "Implementation completed";
  }
  if (status === "failed") {
    return "Implementation failed";
  }
  if (status === "running-implementation") {
    return "Implementation in progress";
  }
  return null;
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
  onStartImplementation,
  onDeleteThread,
  onOpenImplementationRun,
}: ProjectLabTabProps) => {
  const [selectedMode, setSelectedMode] = useState<ProjectLabMode>("new-feature");
  const [personasOpen, setPersonasOpen] = useState(false);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Record<string, boolean>>({});
  const sortedThreads = useMemo(() => [...project.labThreads].sort((left, right) => right.thread.createdAt.localeCompare(left.thread.createdAt)), [project.labThreads]);
  const selectedModeOption = PROJECT_LAB_MODE_OPTIONS.find((option) => option.mode === selectedMode) ?? PROJECT_LAB_MODE_OPTIONS[0];
  const enabledPersonaCount = settings.personas.filter((persona) => persona.enabled).length;
  const configuredPersonaCount = settings.personas.filter((persona) => persona.enabled && persona.modelId).length;
  const discussionPersonaCount = settings.personas.filter(
    (persona) => persona.enabled && persona.modelId && persona.personaId !== "moderator" && persona.personaId !== "implementer",
  ).length;
  const moderatorReady = settings.personas.some((persona) => persona.personaId === "moderator" && persona.enabled && persona.modelId);
  const normalizedBranchOptions = branchOptions.filter(Boolean);

  return (
    <div className="space-y-4 pb-2">
      <Card className="overflow-hidden p-0">
        <div className="border-b border-zinc-800/80 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Sparkles className="h-4 w-4 text-cyan-400" />
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-zinc-100">Project Lab</h3>
                <p className="mt-0.5 text-xs text-zinc-500">Persona council for targeted proposals and implementation experiments.</p>
              </div>
            </div>
            <label className="flex h-8 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 text-xs text-zinc-300">
              <input
                type="checkbox"
                className="h-4 w-4 accent-cyan-400"
                checked={settings.enabled}
                onChange={(event) => void onSettingsChange({ ...settings, enabled: event.target.checked })}
              />
              Enabled
            </label>
          </div>
        </div>

        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="px-4 py-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[220px] flex-1 space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Lab mode</span>
                <select
                  value={selectedMode}
                  onChange={(event) => setSelectedMode(event.target.value as ProjectLabMode)}
                  className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition-colors hover:border-zinc-700 focus:border-cyan-500/60"
                >
                  {PROJECT_LAB_MODE_OPTIONS.map((option) => (
                    <option key={option.mode} value={option.mode}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-[220px] flex-1 space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Base branch</span>
                <select
                  value={selectedBaseBranch}
                  onChange={(event) => onBaseBranchChange(event.target.value)}
                  className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition-colors hover:border-zinc-700 focus:border-cyan-500/60"
                >
                  {normalizedBranchOptions.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                className="h-10"
                disabled={busy || !settings.enabled || !selectedBaseBranch}
                onClick={() => void onRunProjectLab({ mode: selectedMode, baseBranch: selectedBaseBranch })}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lightbulb className="mr-2 h-4 w-4" />}
                Run Lab
              </Button>
            </div>
            <p className="mt-2 text-xs text-zinc-500">{selectedModeOption.description}</p>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
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

          <div className="border-t border-zinc-800/80 bg-zinc-950/35 px-4 py-4 lg:border-l lg:border-t-0">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                  <Users className="h-4 w-4 text-cyan-400" />
                  Personas
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  {configuredPersonaCount}/{enabledPersonaCount} enabled roles have models. {moderatorReady ? "Moderator ready." : "Moderator missing."}{" "}
                  {discussionPersonaCount > 0 ? "" : "Add one discussion role."}
                </p>
              </div>
              <Button type="button" size="sm" variant="secondary" className="h-8 shrink-0 px-2" onClick={() => setPersonasOpen((current) => !current)}>
                <Settings2 className="mr-1.5 h-3.5 w-3.5" />
                {personasOpen ? "Hide" : "Configure"}
              </Button>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {settings.personas.map((persona) => (
                <span
                  key={persona.personaId}
                  className={`rounded-full border px-2 py-0.5 text-[10px] ${COLOR_STYLES[persona.enabled ? persona.colorToken : "zinc"] ?? COLOR_STYLES.zinc} ${
                    persona.enabled && persona.modelId ? "" : "opacity-55"
                  }`}
                  title={persona.modelId ? "Model configured" : "No model selected"}
                >
                  {persona.label}
                </span>
              ))}
            </div>

            <label className="mt-3 flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
              <input
                className="mt-0.5 h-4 w-4 accent-cyan-400"
                type="checkbox"
                checked={settings.autoImplementation}
                onChange={(event) => void onSettingsChange({ ...settings, autoImplementation: event.target.checked })}
              />
              <span className="min-w-0 text-xs text-zinc-400">
                <span className="block font-medium text-zinc-200">Auto implementation</span>
                Start a linked implementation run when the council agrees.
              </span>
            </label>
          </div>
        </div>

        {personasOpen ? (
          <div className="border-t border-zinc-800/80 bg-zinc-950/20 px-4 py-4">
            <div className="grid gap-2 xl:grid-cols-2">
              {settings.personas.map((persona) => (
                <div key={persona.personaId} className="grid gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2 sm:grid-cols-[150px_minmax(0,1fr)]">
                  <div className="flex items-center justify-between gap-2">
                    <div className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${COLOR_STYLES[persona.colorToken] ?? COLOR_STYLES.zinc}`}>
                      {persona.label}
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-cyan-400"
                        checked={persona.enabled}
                        onChange={(event) =>
                          void onSettingsChange({
                            ...settings,
                            personas: settings.personas.map((entry) =>
                              entry.personaId === persona.personaId ? { ...entry, enabled: event.target.checked } : entry,
                            ),
                          })
                        }
                      />
                      On
                    </label>
                  </div>
                  <select
                    value={persona.modelId ?? ""}
                    onChange={(event) =>
                      void onSettingsChange({
                        ...settings,
                        personas: settings.personas.map((entry) =>
                          entry.personaId === persona.personaId ? { ...entry, modelId: event.target.value || null } : entry,
                        ),
                      })
                    }
                    className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-100"
                  >
                    <option value="">No model selected</option>
                    {modelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-medium text-zinc-100">Lab Threads</h3>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Suggestions, RFCs, and linked implementation experiments stay here instead of mixing into the normal run list.
        </p>

        <div className="mt-4 space-y-4">
          {sortedThreads.length > 0 ? (
            sortedThreads.map((detail) => {
              const isExpanded = expandedThreadIds[detail.thread.id] ?? false;
              const implementationRun = detail.implementationRun;
              const implementationStatus = implementationRun
                ? implementationStatusLabel(implementationRun.status)
                : threadImplementationStatusLabel(detail.thread.status);
              const canStartImplementation =
                Boolean(detail.thread.implementationPrompt?.trim()) &&
                !implementationRun &&
                !detail.thread.implementationRunId &&
                (detail.thread.status === "agreed" || detail.thread.status === "failed");
              const showHeaderOutcome = !isExpanded && !implementationStatus;
              return (
                <div key={detail.thread.id} className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-4">
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
                      <h4 className="mt-2 text-base font-medium text-zinc-100">{detail.thread.title}</h4>
                      <p className="mt-1 text-sm text-zinc-400">{renderLabText(detail.thread.summary)}</p>
                      {showHeaderOutcome && detail.thread.outcome ? (
                        <p className="mt-2 line-clamp-2 text-xs text-zinc-500">{renderLabText(detail.thread.outcome)}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {implementationRun ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 px-0 text-zinc-500 hover:text-cyan-200"
                          title="Go to implementation"
                          aria-label="Go to implementation"
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
                    <div className="mt-4 space-y-3">
                      {detail.messages.map((message) => (
                        <div
                          key={message.id}
                          className={`max-w-[88%] rounded-2xl border px-4 py-3 text-sm leading-relaxed ${COLOR_STYLES[message.bubbleColor] ?? COLOR_STYLES.zinc} ${
                            message.role === "moderator" ? "ml-auto" : ""
                          }`}
                        >
                          <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-zinc-300/80">{message.personaLabel}</div>
                          <div>{renderLabText(message.content)}</div>
                        </div>
                      ))}

                      {implementationStatus ? (
                        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] text-cyan-100">
                                  {implementationStatus}
                                </span>
                                {implementationRun ? <span className="truncate text-xs text-zinc-500">{implementationRun.branchName}</span> : null}
                              </div>
                              {!implementationRun && detail.thread.implementationRunId ? (
                                <p className="mt-2 text-xs text-zinc-500">The linked implementation run is no longer available in the snapshot.</p>
                              ) : null}
                              {implementationRun?.errorMessage ? (
                                <p className="mt-1 text-xs text-rose-300">{renderLabText(implementationRun.errorMessage)}</p>
                              ) : null}
                            </div>
                            {implementationRun ? (
                              <Button type="button" size="sm" variant="secondary" onClick={() => onOpenImplementationRun(implementationRun.id)}>
                                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                                Open implementation
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {canStartImplementation ? (
                        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                              <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] text-cyan-100">
                                Ready to implement
                              </span>
                              <p className="mt-2 text-xs text-zinc-500">The council prepared an implementation plan, but auto implementation is disabled.</p>
                            </div>
                            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void onStartImplementation(detail.thread.id)}>
                              {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-2 h-3.5 w-3.5" />}
                              Start implementation
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-10 text-center text-sm text-zinc-500">
              No Project Lab threads yet. Enable the lab and ask it to explore the repo.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
