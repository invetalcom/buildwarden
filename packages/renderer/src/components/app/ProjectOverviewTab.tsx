import { appendChatAttachmentFiles, type RunOrganizationSnapshot, type ChatAttachmentPayload, type ModelExecutionProfile, type ProjectKind, type ProviderType, type RunMode, type RunModelConfiguration, type RunRecord, type RunWorkspaceType, type SupportedIdeKind, type UnifiedProviderFamily } from "@buildwarden/shared";
import { FolderOpen } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { parseSearchTerms, runMatchesSearch } from "../../lib/run-search";
import { useRunUserInputSearch } from "../../lib/use-run-user-input-search";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { OpenInIdeControl } from "./open-in-ide-control";
import type { ProjectRunStats } from "./ProjectStatisticsCard";
import { RunHistory } from "./RunHistory";
import { RunComposer } from "./RunComposer";
import { appendUnreachableSubagentRoots, buildRunHierarchyRows } from "./run-hierarchy";

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
