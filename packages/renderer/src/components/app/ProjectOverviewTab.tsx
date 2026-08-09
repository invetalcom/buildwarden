import { appendChatAttachmentFiles, type ChatAttachmentPayload, type ModelExecutionProfile, type ProjectKind, type ProviderType, type RunMode, type RunModelConfiguration, type RunRecord, type RunWorkspaceType, type SupportedIdeKind, type UnifiedProviderFamily } from "@buildwarden/shared";
import { Archive, Clock3, FolderOpen, Play, PlayCircle, Search, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
import { ProviderBrandIcon } from "./provider-brand-icons";
import { RunComposer } from "./RunComposer";
import { resolveRunDisplayStatus, RUN_DISPLAY_STATUS_LABELS, runDisplayStatusTone } from "./run-display-status";
import { appendUnreachableSubagentRoots, buildRunHierarchyRows, runHierarchyLabel, type RunHierarchyRow } from "./run-hierarchy";
import { RunHierarchyIndent, RunHierarchyToggle } from "./RunHierarchy";
import { RunListSelectionToolbar } from "./RunListSelectionToolbar";

interface ProjectOverviewTabProps {
  projectId: string;
  projectName: string;
  repoPath: string;
  projectKind: ProjectKind;
  runs: RunRecord[];
  knownPrimaryRuns?: RunRecord[];
  orchestratedRuns: RunRecord[];
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null; executionProfile?: ModelExecutionProfile }>;
  configuredIdeKinds: SupportedIdeKind[];
  availableBranches: string[];
  currentProjectBranch: string;
  runPrompt: string;
  runMode: RunMode;
  runWorkspaceType: RunWorkspaceType;
  runBaseBranch: string;
  runModelId: string;
  runWorktreeModelIds: string[];
  runModelConfigurations?: Record<string, RunModelConfiguration>;
  submitShortcut: string;
  projectRunStats: ProjectRunStats;
  busy: boolean;
  reasoningEffort: string;
  anthropicEffort: string;
  executionMode?: string;
  yoloMode: boolean;
  delegationEnabled: boolean;
  delegationAvailable: boolean;
  onSubmitRun: (payload: { attachments?: ChatAttachmentPayload[] }) => void | Promise<void>;
  onSetRunForLater: (runId: string) => void | Promise<void>;
  onDeleteRuns?: (runs: RunRecord[]) => Promise<boolean>;
  onSelectRun: (runId: string) => void;
  onRunPromptChange: (value: string) => void;
  onRunModeChange: (value: RunMode) => void;
  onRunWorkspaceTypeChange: (value: RunWorkspaceType) => void;
  onRunBaseBranchChange: (value: string) => void;
  onRunModelChange: (modelId: string) => void;
  onRunWorktreeModelIdsChange: (modelIds: string[]) => void;
  onRunModelConfigurationsChange?: (configurations: Record<string, RunModelConfiguration>) => void;
  onReasoningEffortChange: (value: string) => void;
  onAnthropicEffortChange: (value: string) => void;
  onExecutionModeChange?: (value: string) => void;
  onYoloModeChange: (value: boolean) => void;
  onDelegationEnabledChange: (value: boolean) => void;
}

const formatRunMeta = (run: Pick<RunRecord, "branchName" | "workspaceType" | "workspaceVcs" | "createdAt">) => {
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

export const RunHistory = ({ runs, orchestratedRuns, treeRows, matchingRunCount, searchQuery, onSearchChange, onSelectRun, onSetRunForLater, onDeleteRuns, onToggleRun, readOnly }: {
  runs: ProjectOverviewTabProps["runs"];
  orchestratedRuns: ProjectOverviewTabProps["orchestratedRuns"];
  treeRows: RunHierarchyRow[];
  matchingRunCount: number;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onSelectRun: ProjectOverviewTabProps["onSelectRun"];
  onSetRunForLater: ProjectOverviewTabProps["onSetRunForLater"];
  onDeleteRuns?: ProjectOverviewTabProps["onDeleteRuns"];
  onToggleRun: (runId: string) => void;
  readOnly: boolean;
}) => {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());
  const [selectionBusy, setSelectionBusy] = useState(false);
  const hasRunSearch = searchQuery.trim().length > 0;
  const totalRunCount = runs.length + orchestratedRuns.length;
  const runById = useMemo(() => new Map([...runs, ...orchestratedRuns].map((run) => [run.id, run])), [orchestratedRuns, runs]);
  const visibleRunIds = useMemo(() => treeRows.map((row) => row.run.id), [treeRows]);
  const selectedRuns = useMemo(
    () => [...selectedRunIds].flatMap((runId) => {
      const run = runById.get(runId);
      return run ? [run] : [];
    }),
    [runById, selectedRunIds],
  );
  const allVisibleSelected = visibleRunIds.length > 0 && visibleRunIds.every((runId) => selectedRunIds.has(runId));
  const runCountDescription = hasRunSearch
    ? `${String(matchingRunCount)} matching of ${String(totalRunCount)}`
    : orchestratedRuns.length > 0
      ? `${String(runs.length)} primary, ${String(orchestratedRuns.length)} subagent ${orchestratedRuns.length === 1 ? "run" : "runs"}`
      : `${String(runs.length)} visible runs in this project`;
  const cancelSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedRunIds(new Set());
  }, []);
  const toggleRunSelection = useCallback((runId: string) => {
    setSelectedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);
  const toggleAllVisible = useCallback(() => {
    setSelectedRunIds((current) => {
      const next = new Set(current);
      const clearVisible = visibleRunIds.length > 0 && visibleRunIds.every((runId) => next.has(runId));
      for (const runId of visibleRunIds) {
        if (clearVisible) next.delete(runId);
        else next.add(runId);
      }
      return next;
    });
  }, [visibleRunIds]);
  const deleteSelectedRuns = useCallback(async () => {
    if (!onDeleteRuns || selectedRuns.length === 0) return;
    setSelectionBusy(true);
    try {
      if (await onDeleteRuns(selectedRuns)) cancelSelection();
    } finally {
      setSelectionBusy(false);
    }
  }, [cancelSelection, onDeleteRuns, selectedRuns]);
  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="shrink-0 flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Run History</CardTitle>
          <CardDescription>{runCountDescription}.</CardDescription>
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
          {!readOnly && onDeleteRuns ? (
            <RunListSelectionToolbar
              selectionMode={selectionMode}
              selectedCount={selectedRuns.length}
              visibleCount={visibleRunIds.length}
              allVisibleSelected={allVisibleSelected}
              busy={selectionBusy}
              onBegin={() => setSelectionMode(true)}
              onToggleAllVisible={toggleAllVisible}
              onDelete={() => void deleteSelectedRuns()}
              onCancel={cancelSelection}
            />
          ) : null}
          <Clock3 className="size-4 shrink-0 text-[var(--ec-muted)]" />
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-lg p-0">
        {treeRows.length === 0 ? <EmptyRunList hasRunSearch={hasRunSearch} hasRuns={totalRunCount > 0} readOnly={readOnly} /> : (
          <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
            {treeRows.map(({ run, depth, descendantCount, expanded }) => {
              const displayStatus = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
              const selected = selectedRunIds.has(run.id);
              return (
                <RunHierarchyIndent
                  key={run.id}
                  depth={depth}
                  indentPx={18}
                  className={depth > 0 ? "border-t border-[var(--ec-border)] bg-[var(--ec-panel-soft)]" : "border-t border-[var(--ec-border)]"}
                >
                  <div
                    data-run-hierarchy-run={run.id}
                    data-run-selected={selected ? "true" : undefined}
                    className={`flex items-center gap-3 px-4 py-3 transition hover:bg-[var(--ec-hover)] ${selected ? "bg-[var(--ec-accent-soft)]" : ""}`}
                  >
                    {selectionMode ? (
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={selectionBusy}
                        onChange={() => toggleRunSelection(run.id)}
                        aria-label={`Select ${runHierarchyLabel(run)}`}
                        className="size-4 shrink-0 cursor-pointer rounded border border-[var(--ec-border)] accent-[var(--ec-accent)] disabled:cursor-not-allowed"
                      />
                    ) : null}
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      disabled={selectionBusy}
                      onClick={() => selectionMode ? toggleRunSelection(run.id) : onSelectRun(run.id)}
                      type="button"
                    >
                      {/* Sits beside the two-line text block, so the mark never drives the row height. */}
                      <ProviderBrandIcon harnessType={run.harnessType} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-[var(--ec-text)]">{runHierarchyLabel(run)}</span>
                          {depth > 0 ? <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--ec-accent)]">Subagent</span> : null}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-xs text-[var(--ec-muted)]">{formatRunMeta(run)}</span>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      {descendantCount > 0 ? (
                        <RunHierarchyToggle
                          runId={run.id}
                          runLabel={runHierarchyLabel(run)}
                          descendantCount={descendantCount}
                          expanded={expanded}
                          onToggle={onToggleRun}
                        />
                      ) : null}
                      <Badge dot tone={runDisplayStatusTone(displayStatus)}>{RUN_DISPLAY_STATUS_LABELS[displayStatus]}</Badge>
                      <span className="font-mono text-xs text-[var(--ec-muted)]">{(run.inputTokens + run.outputTokens).toLocaleString()}</span>
                      {!selectionMode && !readOnly && run.kind !== "orchestration-task" ? <Button type="button" size="icon" variant="ghost" title="Move to For later" onClick={() => void onSetRunForLater(run.id)}><Archive className="size-3.5" /></Button> : null}
                    </div>
                  </div>
                </RunHierarchyIndent>
              );
            })}
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
  knownPrimaryRuns = runs,
  orchestratedRuns,
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
  runModelConfigurations = {},
  submitShortcut,
  projectRunStats,
  busy,
  reasoningEffort,
  anthropicEffort,
  executionMode = "auto",
  yoloMode,
  delegationEnabled,
  delegationAvailable,
  onSubmitRun,
  onSetRunForLater,
  onDeleteRuns,
  onSelectRun,
  onRunPromptChange,
  onRunModeChange,
  onRunWorkspaceTypeChange,
  onRunBaseBranchChange,
  onRunModelChange,
  onRunWorktreeModelIdsChange,
  onRunModelConfigurationsChange,
  onReasoningEffortChange,
  onAnthropicEffortChange,
  onExecutionModeChange,
  onYoloModeChange,
  onDelegationEnabledChange,
}: ProjectOverviewTabProps) => {
  const buildwarden = useBuildWardenClient();
  const readOnly = !buildwarden.capabilities.runMutations;
  const [runAttachmentFiles, setRunAttachmentFiles] = useState<File[]>([]);
  const [runSearchQuery, setRunSearchQuery] = useState("");
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const runSearchTerms = useMemo(() => parseSearchTerms(runSearchQuery), [runSearchQuery]);
  const hasRunSearch = runSearchTerms.length > 0;
  const hierarchyRoots = useMemo(
    () => appendUnreachableSubagentRoots(runs, orchestratedRuns, knownPrimaryRuns),
    [knownPrimaryRuns, orchestratedRuns, runs],
  );
  const treeRows = useMemo(
    () => buildRunHierarchyRows(hierarchyRoots, orchestratedRuns, {
      expandedRunIds,
      matches: hasRunSearch ? (run) => runMatchesSearch(run, runSearchTerms) : undefined,
    }),
    [expandedRunIds, hasRunSearch, hierarchyRoots, orchestratedRuns, runSearchTerms],
  );
  const matchingRunCount = useMemo(
    () => hasRunSearch
      ? [...runs, ...orchestratedRuns].filter((run) => runMatchesSearch(run, runSearchTerms)).length
      : runs.length + orchestratedRuns.length,
    [hasRunSearch, orchestratedRuns, runSearchTerms, runs],
  );
  const toggleRunHierarchy = useCallback((runId: string) => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);
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
              modelConfigurations={runModelConfigurations}
              onModelConfigurationsChange={onRunModelConfigurationsChange}
              modelOptions={modelOptions.map((option) => ({
                value: option.id,
                label: option.label,
                contextModelId: option.modelId,
                providerType: option.providerType,
                providerFamily: option.providerFamily,
                executionProfile: option.executionProfile,
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
              executionMode={executionMode}
              onExecutionModeChange={onExecutionModeChange}
              yoloMode={yoloMode}
              onYoloModeChange={onYoloModeChange}
              delegationEnabled={delegationEnabled}
              delegationAvailable={delegationAvailable}
              onDelegationEnabledChange={onDelegationEnabledChange}
            />
          </CardContent> : null}
        </Card>
      </section>

      <RunHistory
        key={projectId}
        runs={runs}
        orchestratedRuns={orchestratedRuns}
        treeRows={treeRows}
        matchingRunCount={matchingRunCount}
        searchQuery={runSearchQuery}
        onSearchChange={setRunSearchQuery}
        onSelectRun={onSelectRun}
        onSetRunForLater={onSetRunForLater}
        onDeleteRuns={onDeleteRuns}
        onToggleRun={toggleRunHierarchy}
        readOnly={readOnly}
      />
    </div>
  );
};
