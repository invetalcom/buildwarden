import { appendChatAttachmentFiles, type ChatAttachmentPayload, type ProjectKind, type ProviderType, type RunMode, type RunWorkspaceType, type RunWorkspaceVcs, type UnifiedProviderFamily } from "@buildwarden/shared";
import { Archive, Clock3, Play, PlayCircle, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { parseSearchTerms, runMatchesSearch } from "../../lib/run-search";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import type { ProjectRunStats } from "./ProjectStatisticsCard";
import { RunComposer } from "./RunComposer";

interface ProjectOverviewTabProps {
  projectId: string;
  projectName: string;
  repoPath: string;
  projectKind: ProjectKind;
  runs: Array<{
    id: string;
    prompt: string;
    goalText?: string | null;
    userInputSearchText?: string;
    branchName: string;
    workspaceType: RunWorkspaceType;
    workspaceVcs: RunWorkspaceVcs;
    createdAt: string;
    status: "queued" | "preparing" | "running" | "completed" | "failed" | "cancelled";
    inputTokens: number;
    outputTokens: number;
  }>;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  availableBranches: string[];
  currentProjectBranch: string;
  runPrompt: string;
  runMode: RunMode;
  runWorkspaceType: RunWorkspaceType;
  runBaseBranch: string;
  runModelId: string;
  runWorktreeModelIds: string[];
  submitShortcut: string;
  projectRunStats: ProjectRunStats;
  busy: boolean;
  reasoningEffort: string;
  anthropicEffort: string;
  yoloMode: boolean;
  onSubmitRun: (payload: { attachments?: ChatAttachmentPayload[] }) => void | Promise<void>;
  onSetRunForLater: (runId: string) => void | Promise<void>;
  onSelectRun: (runId: string) => void;
  onRunPromptChange: (value: string) => void;
  onRunModeChange: (value: RunMode) => void;
  onRunWorkspaceTypeChange: (value: RunWorkspaceType) => void;
  onRunBaseBranchChange: (value: string) => void;
  onRunModelChange: (modelId: string) => void;
  onRunWorktreeModelIdsChange: (modelIds: string[]) => void;
  onReasoningEffortChange: (value: string) => void;
  onAnthropicEffortChange: (value: string) => void;
  onYoloModeChange: (value: boolean) => void;
}

const formatRunMeta = (run: { branchName: string; workspaceType: RunWorkspaceType; workspaceVcs: RunWorkspaceVcs; createdAt: string }) => {
  const workspaceLabel =
    run.workspaceVcs === "folder"
      ? run.workspaceType === "copy"
        ? "Folder copy"
        : "Project folder"
      : run.branchName;
  return `${workspaceLabel} - ${new Date(run.createdAt).toLocaleString()}`;
};

export const ProjectOverviewTab = ({
  projectId,
  projectName,
  repoPath,
  projectKind,
  runs,
  modelOptions,
  availableBranches,
  currentProjectBranch,
  runPrompt,
  runMode,
  runWorkspaceType,
  runBaseBranch,
  runModelId,
  runWorktreeModelIds,
  submitShortcut,
  projectRunStats,
  busy,
  reasoningEffort,
  anthropicEffort,
  yoloMode,
  onSubmitRun,
  onSetRunForLater,
  onSelectRun,
  onRunPromptChange,
  onRunModeChange,
  onRunWorkspaceTypeChange,
  onRunBaseBranchChange,
  onRunModelChange,
  onRunWorktreeModelIdsChange,
  onReasoningEffortChange,
  onAnthropicEffortChange,
  onYoloModeChange,
}: ProjectOverviewTabProps) => {
  const formatTokens = (value: number) => value.toLocaleString();
  const [runAttachmentFiles, setRunAttachmentFiles] = useState<File[]>([]);
  const [runSearchQuery, setRunSearchQuery] = useState("");
  const runSearchTerms = useMemo(() => parseSearchTerms(runSearchQuery), [runSearchQuery]);
  const visibleRuns = useMemo(() => runs.filter((run) => runMatchesSearch(run, runSearchTerms)), [runs, runSearchTerms]);
  const hasRunSearch = runSearchTerms.length > 0;
  const isFolderProject = projectKind === "folder";
  const workspaceTypeOptions: RunWorkspaceType[] = isFolderProject ? ["copy", "local"] : ["worktree", "local"];
  const branchOptions = isFolderProject
    ? []
    : (runWorkspaceType === "local" ? [currentProjectBranch] : availableBranches).filter(Boolean);
  const canUseMultiModel = runWorkspaceType === "worktree" || runWorkspaceType === "copy";

  const handleStartRun = async () => {
    let attachments: ChatAttachmentPayload[] | undefined;
    try {
      attachments = runAttachmentFiles.length > 0 ? await readFilesAsChatPayloads(runAttachmentFiles) : undefined;
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not read attachments.");
      return;
    }
    await onSubmitRun({ attachments });
    setRunAttachmentFiles([]);
  };

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-3">
      <section className="grid shrink-0 gap-3">
        <Card>
          <CardHeader className="p-4">
            <div className="flex min-w-0 items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[var(--ec-accent)]">Agent Runs</p>
                <CardTitle className="mt-1 truncate text-2xl">{projectName}</CardTitle>
                <CardDescription className="truncate font-mono">{repoPath}</CardDescription>
              </div>
              <CardAction>
                <Badge dot tone={projectRunStats.active > 0 ? "running" : "neutral"}>
                  {projectRunStats.active > 0 ? `${projectRunStats.active} active` : "idle"}
                </Badge>
              </CardAction>
            </div>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <RunComposer
              projectId={projectId}
              attachments={<ChatAttachmentPicker variant="footer" files={runAttachmentFiles} onChange={setRunAttachmentFiles} disabled={busy} />}
              prompt={runPrompt}
              onPromptChange={onRunPromptChange}
              selectedMode={runMode}
              onModeChange={onRunModeChange}
              selectedWorkspaceType={runWorkspaceType}
              onWorkspaceTypeChange={onRunWorkspaceTypeChange}
              selectedModelId={runModelId}
              onModelChange={onRunModelChange}
              modelSelectionMode={canUseMultiModel ? "multi" : "single"}
              selectedModelIds={runWorktreeModelIds}
              onModelIdsChange={onRunWorktreeModelIdsChange}
              modelOptions={modelOptions.map((option) => ({
                value: option.id,
                label: option.label,
                contextModelId: option.modelId,
                providerType: option.providerType,
                providerFamily: option.providerFamily,
              }))}
              workspaceTypeOptions={workspaceTypeOptions}
              selectedBranch={isFolderProject ? undefined : runWorkspaceType === "local" ? currentProjectBranch : runBaseBranch}
              branchOptions={branchOptions.map((branch) => ({
                  value: branch,
                  label: runWorkspaceType === "local" ? `${branch} (current)` : branch,
                }))}
              onBranchChange={onRunBaseBranchChange}
              branchDisabled={runWorkspaceType === "local"}
              workspaceLabels={isFolderProject ? { copy: "Copy", local: "Folder" } : undefined}
              busy={busy}
              onSubmit={() => void handleStartRun()}
              submitLabel="Start run"
              submitIcon={<Play data-icon="inline-end" />}
              placeholder={`Describe what the agent should do in ${projectName}. Attach files when context matters.`}
              autoFocus
              dropdownSide="bottom"
              submitShortcut={submitShortcut}
              onAddAttachmentFiles={(incoming) => setRunAttachmentFiles((prev) => appendChatAttachmentFiles(prev, incoming))}
              submitDisabled={
                busy ||
                !projectId ||
                (canUseMultiModel ? runWorktreeModelIds.length === 0 : !runModelId) ||
                (!isFolderProject && !(runWorkspaceType === "local" ? currentProjectBranch : runBaseBranch)) ||
                (!runPrompt.trim() && runAttachmentFiles.length === 0)
              }
              sticky={false}
              showContextBadge={false}
              reasoningEffort={reasoningEffort}
              anthropicEffort={anthropicEffort}
              onReasoningEffortChange={onReasoningEffortChange}
              onAnthropicEffortChange={onAnthropicEffortChange}
              yoloMode={yoloMode}
              onYoloModeChange={onYoloModeChange}
            />
          </CardContent>
        </Card>
      </section>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="shrink-0 flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Run History</CardTitle>
            <CardDescription>
              {hasRunSearch ? `${visibleRuns.length} matching of ${runs.length}` : `${runs.length} visible`} runs in this project.
            </CardDescription>
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
            <span className="relative block min-w-[14rem] max-w-md flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--ec-faint)]" />
              <Input
                value={runSearchQuery}
                onChange={(event) => setRunSearchQuery(event.target.value)}
                placeholder="Search past runs"
                aria-label="Search runs"
                className="h-8 pr-8 pl-8 text-xs"
              />
              {runSearchQuery ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2 text-[var(--ec-muted)]"
                  onClick={() => setRunSearchQuery("")}
                  aria-label="Clear run search"
                  title="Clear search"
                >
                  <X className="size-3.5" />
                </Button>
              ) : null}
            </span>
            <Clock3 className="size-4 shrink-0 text-[var(--ec-muted)]" />
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-lg p-0">
          {visibleRuns.length > 0 ? (
            <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
              {visibleRuns.map((run) => (
                <div key={run.id} className="flex items-center gap-3 border-t border-[var(--ec-border)] px-4 py-3 transition hover:bg-[var(--ec-hover)]">
                  <button className="min-w-0 flex-1 text-left" onClick={() => onSelectRun(run.id)} type="button">
                    <p className="truncate text-sm font-semibold text-[var(--ec-text)]">{run.prompt}</p>
                    <p className="mt-0.5 truncate font-mono text-xs text-[var(--ec-muted)]">{formatRunMeta(run)}</p>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge dot tone={run.status}>{run.status}</Badge>
                    <span className="font-mono text-xs text-[var(--ec-muted)]">{formatTokens(run.inputTokens + run.outputTokens)}</span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      title="Move to For later"
                      onClick={() => void onSetRunForLater(run.id)}
                    >
                      <Archive className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : hasRunSearch && runs.length > 0 ? (
            <Empty>
              <EmptyHeader>
                <Search className="size-10 text-[var(--ec-muted)]" />
                <EmptyTitle>No matching runs</EmptyTitle>
                <EmptyDescription>Search checks only user prompts, follow-ups, run goals, and submitted answers.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Empty>
              <EmptyHeader>
                <PlayCircle className="size-10 text-[var(--ec-muted)]" />
                <EmptyTitle>No visible runs yet</EmptyTitle>
                <EmptyDescription>Start one above or move a run back from For later.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
