import { appendChatAttachmentFiles, UNCATEGORIZED_RUN_SECTION_ID, type RunOrganizationSnapshot, type ChatAttachmentPayload, type ModelExecutionProfile, type ProjectKind, type ProviderType, type RunMode, type RunModelConfiguration, type RunRecord, type RunWorkspaceType, type SupportedIdeKind, type UnifiedProviderFamily } from "@buildwarden/shared";
import { Clock3, FolderOpen, PlayCircle, Search, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { parseSearchTerms, runMatchesSearch } from "../../lib/run-search";
import { useRunUserInputSearch } from "../../lib/use-run-user-input-search";
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
import { SegmentedControl } from "../ui/segmented-control";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { OpenInIdeControl } from "./open-in-ide-control";
import type { ProjectRunStats } from "./ProjectStatisticsCard";
import { ProjectRunHistoryRow } from "./ProjectRunHistoryRow";
import { RunComposer } from "./RunComposer";
import { appendUnreachableSubagentRoots, buildRunHierarchyRows, type RunHierarchyRow } from "./run-hierarchy";
import { RunListSelectionToolbar } from "./RunListSelectionToolbar";
import { EMPTY_RUN_ORGANIZATION } from "./sidebar-run-sections";
import { buildRunHistoryCategories, runHistoryCategories } from "./run-history-categories";

const HISTORY_VIEW_KEY = "buildwarden:run-history-view";
type HistoryView = "flat" | "categories";
const readHistoryView = (): HistoryView => {
  try { return localStorage.getItem(HISTORY_VIEW_KEY) === "categories" ? "categories" : "flat"; }
  catch { return "flat"; }
};

interface ProjectOverviewTabProps {
  runOrganization?: RunOrganizationSnapshot;
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

export const RunHistory = ({ runs, orchestratedRuns, knownPrimaryRuns = runs, organization = EMPTY_RUN_ORGANIZATION, expandedRunIds, treeRows, matchingRunCount, searchQuery, onSearchChange, onSelectRun, onSetRunForLater, onDeleteRuns, onToggleRun, providerTypeByModelId = new Map(), readOnly }: {
  runs: ProjectOverviewTabProps["runs"];
  orchestratedRuns: ProjectOverviewTabProps["orchestratedRuns"];
  knownPrimaryRuns?: RunRecord[];
  organization?: RunOrganizationSnapshot;
  expandedRunIds?: ReadonlySet<string>;
  treeRows: RunHierarchyRow[];
  matchingRunCount: number;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onSelectRun: ProjectOverviewTabProps["onSelectRun"];
  onSetRunForLater: ProjectOverviewTabProps["onSetRunForLater"];
  onDeleteRuns?: ProjectOverviewTabProps["onDeleteRuns"];
  onToggleRun: (runId: string) => void;
  providerTypeByModelId?: ReadonlyMap<string, ProviderType>;
  readOnly: boolean;
}) => {
  const [view, setView] = useState(readHistoryView);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());
  const [selectionBusy, setSelectionBusy] = useState(false);
  const hasRunSearch = searchQuery.trim().length > 0;
  const metadataByRunId = useMemo(() => new Map(organization.runs.map((record) => [record.runId, record])), [organization]);
  const categoryById = useMemo(() => new Map(runHistoryCategories(organization).map((category) => [category.id, category])), [organization]);
  const categoryGroups = useMemo(() => view === "categories" ? buildRunHistoryCategories({
    runs, orchestratedRuns, knownPrimaryRuns, organization,
    expandedRunIds: expandedRunIds ?? new Set(treeRows.filter((row) => row.expanded).map((row) => row.run.id)),
    searchRows: hasRunSearch ? treeRows : undefined,
  }) : [], [view, runs, orchestratedRuns, knownPrimaryRuns, organization, expandedRunIds, hasRunSearch, treeRows]);
  const totalRunCount = runs.length + orchestratedRuns.length;
  const runById = useMemo(() => new Map([...runs, ...orchestratedRuns].map((run) => [run.id, run])), [orchestratedRuns, runs]);
  const visibleRunIds = useMemo(() => (view === "categories" ? categoryGroups.flatMap((group) => group.rows) : treeRows).map((row) => row.run.id), [view, categoryGroups, treeRows]);
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
  const changeView = (next: HistoryView) => {
    setView(next);
    try { localStorage.setItem(HISTORY_VIEW_KEY, next); } catch { /* Storage may be disabled. */ }
  };
  const renderRow = (row: RunHierarchyRow) => {
    const metadata = metadataByRunId.get(row.run.id);
    const category = categoryById.get(metadata?.sectionId ?? "") ?? categoryById.get(UNCATEGORIZED_RUN_SECTION_ID);
    return <ProjectRunHistoryRow
      key={row.run.id}
      row={row}
      tags={metadata?.tags}
      category={view === "flat" && organization !== EMPTY_RUN_ORGANIZATION ? category : undefined}
      providerType={providerTypeByModelId.get(row.run.modelId)}
      selected={selectedRunIds.has(row.run.id)}
      selectionMode={selectionMode}
      busy={selectionBusy}
      readOnly={readOnly}
      onSelect={onSelectRun}
      onToggleSelection={toggleRunSelection}
      onToggleHierarchy={onToggleRun}
      onSetForLater={onSetRunForLater}
    />;
  };
  return (
    <Card className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl shadow-none">
      <CardHeader className="shrink-0 flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--ec-border)] px-4 py-3">
        <div className="flex items-start gap-2">
          <Clock3 className="mt-0.5 size-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />
          <div>
            <CardTitle>Run History</CardTitle>
            <CardDescription>{runCountDescription}.</CardDescription>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <span className="relative block min-w-40 max-w-72 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--ec-faint)]" />
            <Input value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search past runs" aria-label="Search runs" className="h-8 pr-8 pl-8 text-xs" />
            {searchQuery && (
              <Button type="button" variant="ghost" size="icon" className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2 text-[var(--ec-muted)]" onClick={() => onSearchChange("")} aria-label="Clear run search" title="Clear search">
                <X className="size-3.5" />
              </Button>
            )}
          </span>
          <SegmentedControl<HistoryView>
            label="Run history view"
            options={[{ value: "flat", label: "Flat" }, { value: "categories", label: "Categories" }]}
            value={view}
            onChange={changeView}
            className="shrink-0"
          />
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
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-xl p-0">
        {treeRows.length === 0 ? <EmptyRunList hasRunSearch={hasRunSearch} hasRuns={totalRunCount > 0} readOnly={readOnly} /> : (
          <div className="app-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
            {view === "flat" ? treeRows.map(renderRow) : categoryGroups.map((group) => (
              <section key={group.id} aria-label={`${group.name} runs`} data-run-history-category={group.id}>
                <div className="flex min-w-0 items-center gap-2 px-3 pt-3 pb-1.5 text-xs text-[var(--ec-muted)]">
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
                  <h4 className="min-w-0 truncate font-medium text-[var(--ec-text)]" title={group.name}>{group.name}</h4>
                  <span className="tabular-nums" title={`${group.count} primary ${group.count === 1 ? "run" : "runs"}`}>{group.count}</span>
                  <span aria-hidden className="h-px flex-1 bg-[var(--ec-border)]" />
                </div>
                {group.rows.map(renderRow)}
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export const ProjectOverviewTab = ({
  runOrganization,
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
  const searchableRuns = useMemo(() => [...runs, ...orchestratedRuns], [orchestratedRuns, runs]);
  const userInputMatches = useRunUserInputSearch(runSearchTerms, searchableRuns);
  const hierarchyRoots = useMemo(
    () => appendUnreachableSubagentRoots(runs, orchestratedRuns, knownPrimaryRuns),
    [knownPrimaryRuns, orchestratedRuns, runs],
  );
  const treeRows = useMemo(
    () => buildRunHierarchyRows(hierarchyRoots, orchestratedRuns, {
      expandedRunIds,
      matches: hasRunSearch ? (run) => runMatchesSearch(run, runSearchTerms, userInputMatches) : undefined,
    }),
    [expandedRunIds, hasRunSearch, hierarchyRoots, orchestratedRuns, runSearchTerms, userInputMatches],
  );
  const matchingRunCount = useMemo(
    () => hasRunSearch
      ? searchableRuns.filter((run) => runMatchesSearch(run, runSearchTerms, userInputMatches)).length
      : runs.length + orchestratedRuns.length,
    [hasRunSearch, orchestratedRuns, runSearchTerms, runs, searchableRuns, userInputMatches],
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
  const providerTypeByModelId = useMemo(
    () => new Map(modelOptions.map((option) => [option.id, option.providerType])),
    [modelOptions],
  );

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
      <section className="grid shrink-0 gap-3" aria-label="Start an agent run">
        <CardHeader className="px-1 py-1">
          <div className="flex min-w-0 items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ec-accent)]">Agent Runs</p>
              <CardTitle className="mt-0.5 truncate text-xl">{projectName}</CardTitle>
              <CardDescription className="truncate text-[11px]" title={repoPath}>{repoPath}</CardDescription>
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
        {!readOnly ? (
          <RunComposer
            variant="launch"
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
            placeholder="What would you like to build, fix, or explore?"
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
        ) : null}
      </section>

      <RunHistory
        key={projectId}
        organization={runOrganization}
        knownPrimaryRuns={knownPrimaryRuns}
        expandedRunIds={expandedRunIds}
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
        providerTypeByModelId={providerTypeByModelId}
        readOnly={readOnly}
      />
    </div>
  );
};
