import { appendChatAttachmentFiles, type ChatAttachmentPayload, type ProjectKind, type ProviderType, type RunMode, type RunWorkspaceType, type RunWorkspaceVcs, type SupportedIdeKind, type UnifiedProviderFamily } from "@buildwarden/shared";
import { Archive, Clock3, FolderOpen, Play, PlayCircle, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
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
import { OpenInIdeControl } from "./open-in-ide-control";
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
  configuredIdeKinds: SupportedIdeKind[];
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
  let workspaceLabel = run.branchName;
  if (run.workspaceVcs === "folder") workspaceLabel = run.workspaceType === "copy" ? "Folder copy" : "Project folder";
  return `${workspaceLabel} - ${new Date(run.createdAt).toLocaleString()}`;
};

const EmptyRunList = ({ hasRunSearch, hasRuns, readOnly }: Readonly<{ hasRunSearch: boolean; hasRuns: boolean; readOnly: boolean }>) => (
  <Empty>
    <EmptyHeader>
      {hasRunSearch && hasRuns ? <Search className="size-10 text-[var(--ec-muted)]" /> : <PlayCircle className="size-10 text-[var(--ec-muted)]" />}
      <EmptyTitle>{hasRunSearch && hasRuns ? "No matching runs" : "No visible runs yet"}</EmptyTitle>
      <EmptyDescription>
        {hasRunSearch && hasRuns
          ? "Search checks only user prompts, follow-ups, run goals, and submitted answers."
          : readOnly ? "No runs are available on the BuildWarden host." : "Start one above or move a run back from For later."}
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
);

const RunHistory = ({ runs, visibleRuns, searchQuery, onSearchChange, onSelectRun, onSetRunForLater, readOnly }: {
  runs: ProjectOverviewTabProps["runs"];
  visibleRuns: ProjectOverviewTabProps["runs"];
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onSelectRun: ProjectOverviewTabProps["onSelectRun"];
  onSetRunForLater: ProjectOverviewTabProps["onSetRunForLater"];
  readOnly: boolean;
}) => {
  const hasRunSearch = searchQuery.trim().length > 0;
  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="shrink-0 flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Run History</CardTitle>
          <CardDescription>{hasRunSearch ? `${visibleRuns.length} matching of ${runs.length}` : `${runs.length} visible`} runs in this project.</CardDescription>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
          <span className="relative block min-w-[14rem] max-w-md flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--ec-faint)]" />
            <Input value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search past runs" aria-label="Search runs" className="h-8 pr-8 pl-8 text-xs" />
            {searchQuery && (
              <Button type="button" variant="ghost" size="icon" className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2 text-[var(--ec-muted)]" onClick={() => onSearchChange("")} aria-label="Clear run search" title="Clear search">
                <X className="size-3.5" />
              </Button>
            )}
          </span>
          <Clock3 className="size-4 shrink-0 text-[var(--ec-muted)]" />
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-lg p-0">
        {visibleRuns.length === 0 ? <EmptyRunList hasRunSearch={hasRunSearch} hasRuns={runs.length > 0} readOnly={readOnly} /> : (
          <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
            {visibleRuns.map((run) => (
              <div key={run.id} className="flex items-center gap-3 border-t border-[var(--ec-border)] px-4 py-3 transition hover:bg-[var(--ec-hover)]">
                <button className="min-w-0 flex-1 text-left" onClick={() => onSelectRun(run.id)} type="button">
                  <p className="truncate text-sm font-semibold text-[var(--ec-text)]">{run.prompt}</p>
                  <p className="mt-0.5 truncate font-mono text-xs text-[var(--ec-muted)]">{formatRunMeta(run)}</p>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge dot tone={run.status}>{run.status}</Badge>
                  <span className="font-mono text-xs text-[var(--ec-muted)]">{(run.inputTokens + run.outputTokens).toLocaleString()}</span>
                  {!readOnly ? <Button type="button" size="icon" variant="ghost" title="Move to For later" onClick={() => void onSetRunForLater(run.id)}><Archive className="size-3.5" /></Button> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export const ProjectOverviewTab = ({
  projectId,
  projectName,
  repoPath,
  projectKind,
  runs,
  modelOptions,
  configuredIdeKinds,
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
  const buildwarden = useBuildWardenClient();
  const readOnly = !buildwarden.capabilities.mutations;
  const [runAttachmentFiles, setRunAttachmentFiles] = useState<File[]>([]);
  const [runSearchQuery, setRunSearchQuery] = useState("");
  const runSearchTerms = useMemo(() => parseSearchTerms(runSearchQuery), [runSearchQuery]);
  const visibleRuns = useMemo(() => runs.filter((run) => runMatchesSearch(run, runSearchTerms)), [runs, runSearchTerms]);
  const isFolderProject = projectKind === "folder";
  const workspaceTypeOptions: RunWorkspaceType[] = isFolderProject ? ["copy", "local"] : ["worktree", "local"];
  let branchOptions: string[] = [];
  if (!isFolderProject) branchOptions = (runWorkspaceType === "local" ? [currentProjectBranch] : availableBranches).filter(Boolean);
  let selectedBranch: string | undefined;
  if (!isFolderProject) selectedBranch = runWorkspaceType === "local" ? currentProjectBranch : runBaseBranch;
  const canUseMultiModel = runWorkspaceType === "worktree" || runWorkspaceType === "copy";

  const openProjectInFileManager = async () => {
    const result = await buildwarden.openPathInFileManager(repoPath);
    if (!result.ok && result.error) {
      window.alert(`Could not open folder: ${result.error}`);
    }
  };

  const openProjectInIde = async (ideKind: SupportedIdeKind) => {
    try {
      await buildwarden.openFolderInIde(repoPath, ideKind);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not open the project in the IDE.");
    }
  };

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
                <div className="flex items-center gap-2">
                  {buildwarden.capabilities.ideIntegration ? <OpenInIdeControl compact configuredIdeKinds={configuredIdeKinds} onOpen={(ideKind) => void openProjectInIde(ideKind)} /> : null}
                  {buildwarden.capabilities.fileManager ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-8 shrink-0 border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-2 text-xs text-[var(--ec-accent)] hover:bg-[var(--ec-hover)]"
                      title="Open project folder in file explorer"
                      aria-label="Open project folder in file explorer"
                      onClick={() => void openProjectInFileManager()}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0" />
                      <span className="sr-only">Open in file explorer</span>
                    </Button>
                  ) : null}
                  <Badge dot tone={projectRunStats.active > 0 ? "running" : "neutral"}>
                    {projectRunStats.active > 0 ? `${projectRunStats.active} active` : "idle"}
                  </Badge>
                </div>
              </CardAction>
            </div>
          </CardHeader>
          {!readOnly ? <CardContent className="px-3 pb-3">
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
              selectedBranch={selectedBranch}
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
          </CardContent> : null}
        </Card>
      </section>

      <RunHistory runs={runs} visibleRuns={visibleRuns} searchQuery={runSearchQuery} onSearchChange={setRunSearchQuery} onSelectRun={onSelectRun} onSetRunForLater={onSetRunForLater} readOnly={readOnly} />
    </div>
  );
};
