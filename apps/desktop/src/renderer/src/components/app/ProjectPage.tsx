import type {
  IntegratedSkillMetadata,
  ProjectInsightKind,
  ProjectLabMode,
  ProjectLabSettings,
  ProjectLoopAvailability,
  ProjectSnapshot,
  ProjectTaskStatus,
  ProviderType,
  RunMode,
  RunWorkspaceType,
  SupportedIdeKind,
  UnifiedProviderFamily,
} from "@buildwarden/shared";
import { Suspense, lazy, useMemo } from "react";
import { cn } from "../../lib/cn";
import { ProjectForLaterTab } from "./ProjectForLaterTab";
import { ProjectAiInsightsHistoryPage } from "./ProjectAiInsightsHistoryPage";
import { ProjectLabTab } from "./ProjectLabTab";
import { ProjectLoopsTab } from "./ProjectLoopsTab";
import { ProjectOverviewTab } from "./ProjectOverviewTab";
import { ProjectBranchesPage } from "./ProjectBranchesPage";
import { ProjectPrMrTab } from "./ProjectPrMrTab";
import { ProjectSettingsPage } from "./ProjectSettingsPage";
import { ProjectTasksTab } from "./ProjectTasksTab";
import type { ProjectPageTab } from "./project-page-tabs";
import type { ProjectRunStats } from "./ProjectStatisticsCard";

const ProjectGraphsTab = lazy(() => import("./ProjectGraphsTab").then((module) => ({ default: module.ProjectGraphsTab })));

interface ProjectPageProps {
  project: ProjectSnapshot;
  activeTab: ProjectPageTab;
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
  onSubmitRun: (payload: { attachments?: import("@buildwarden/shared").ChatAttachmentPayload[] }) => void | Promise<void>;
  onCreateTask: (input: { title: string; prompt: string }) => void | Promise<void>;
  onUpdateTask: (taskId: string, input: { title?: string; prompt?: string; status?: ProjectTaskStatus }) => void | Promise<void>;
  onDeleteTask: (taskId: string) => void | Promise<void>;
  onStartTask: (taskId: string, prompt: string, modelId: string) => void | Promise<void>;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
  onSetRunForLater: (runId: string) => void | Promise<void>;
  onRestoreRunFromForLater: (runId: string) => void | Promise<void>;
  reasoningEffort: string;
  anthropicEffort: string;
  yoloMode: boolean;
  onReasoningEffortChange: (value: string) => void;
  onAnthropicEffortChange: (value: string) => void;
  onYoloModeChange: (value: boolean) => void;
  onSelectRun: (runId: string) => void;
  onRunPromptChange: (value: string) => void;
  onRunModeChange: (value: RunMode) => void;
  onRunWorkspaceTypeChange: (value: RunWorkspaceType) => void;
  onRunBaseBranchChange: (value: string) => void;
  onRunModelChange: (modelId: string) => void;
  onRunWorktreeModelIdsChange: (modelIds: string[]) => void;
  availableIntegratedSkills: IntegratedSkillMetadata[];
  activeIntegratedSkillIds: string[];
  onActiveIntegratedSkillIdsChange: (skillIds: string[]) => void | Promise<void>;
  labSettings: ProjectLabSettings;
  onLabSettingsChange: (settings: ProjectLabSettings) => void | Promise<void>;
  onRunProjectLab: (input: { mode: ProjectLabMode; baseBranch: string; implementationModelId: string; reviewModelId: string }) => void | Promise<void>;
  onDeleteProjectLabThread: (threadId: string) => void | Promise<void>;
  onOpenProjectLabImplementation: (runId: string) => void;
  loopAvailability: ProjectLoopAvailability | null;
  onOpenLoopRun: (runId: string) => void;
  onLoopsChanged: () => void | Promise<void>;
  onBranchesChanged: () => void | Promise<void>;
  onDeleteProject: () => void | Promise<void>;
  onOpenProjectSettings: () => void | Promise<void>;
  reviewRequestTarget?: { url: string; requestId: number } | null;
}

interface ProjectInsightsTabsProps {
  activeTab: ProjectPageTab;
  project: ProjectSnapshot;
  modelOptions: ProjectPageProps["modelOptions"];
  defaultModelId: string;
  onGenerateInsight: ProjectPageProps["onGenerateInsight"];
  onSelectRun: ProjectPageProps["onSelectRun"];
  onRestoreRunFromForLater: ProjectPageProps["onRestoreRunFromForLater"];
}

const ProjectInsightsTabs = ({ activeTab, project, modelOptions, defaultModelId, onGenerateInsight, onSelectRun, onRestoreRunFromForLater }: ProjectInsightsTabsProps) => (
  <>
    {activeTab === "graphs" && (
      <Suspense fallback={<div className="px-3 py-2 text-xs text-zinc-500">Loading graphs...</div>}>
        <ProjectGraphsTab project={project} onGenerateInsight={onGenerateInsight} />
      </Suspense>
    )}
    {activeTab === "ai-insights-history" && (
      <ProjectAiInsightsHistoryPage project={project} modelOptions={modelOptions} defaultModelId={defaultModelId} onGenerateInsight={onGenerateInsight} onSelectRun={onSelectRun} />
    )}
    {activeTab === "for-later" && (
      <ProjectForLaterTab runs={project.forLaterRuns} onSelectRun={onSelectRun} onRestoreRunFromForLater={onRestoreRunFromForLater} />
    )}
  </>
);

const pickDefaultModelId = (modelOptions: ProjectPageProps["modelOptions"], runModelId: string): string =>
  modelOptions.some((option) => option.id === runModelId) ? runModelId : (modelOptions[0]?.id ?? "");

export const ProjectPage = ({
  project,
  activeTab,
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
  onSubmitRun,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onStartTask,
  onGenerateInsight,
  onSetRunForLater,
  onRestoreRunFromForLater,
  reasoningEffort,
  anthropicEffort,
  yoloMode,
  onReasoningEffortChange,
  onAnthropicEffortChange,
  onYoloModeChange,
  onSelectRun,
  onRunPromptChange,
  onRunModeChange,
  onRunWorkspaceTypeChange,
  onRunBaseBranchChange,
  onRunModelChange,
  onRunWorktreeModelIdsChange,
  availableIntegratedSkills,
  activeIntegratedSkillIds,
  onActiveIntegratedSkillIdsChange,
  labSettings,
  onLabSettingsChange,
  onRunProjectLab,
  onDeleteProjectLabThread,
  onOpenProjectLabImplementation,
  loopAvailability,
  onOpenLoopRun,
  onLoopsChanged,
  onBranchesChanged, onDeleteProject,
  onOpenProjectSettings,
  reviewRequestTarget = null,
}: ProjectPageProps) => {
  const defaultTaskModelId = useMemo(() => pickDefaultModelId(modelOptions, runModelId), [modelOptions, runModelId]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          // Overview, Reviews, and Loops manage their own internal scrolling (Overview scrolls its run history, Loops pins its explainer footer).
          activeTab === "overview" || activeTab === "tasks" || activeTab === "reviews" || activeTab === "loops" ? "overflow-hidden" : "overflow-y-auto",
        )}
      >
      {activeTab === "overview" ? (
        <ProjectOverviewTab
          projectId={project.project.id}
          projectName={project.project.name}
          repoPath={project.project.repoPath}
          projectKind={project.project.kind}
          runs={project.runs}
          modelOptions={modelOptions}
          configuredIdeKinds={configuredIdeKinds}
          availableBranches={availableBranches}
          currentProjectBranch={currentProjectBranch}
          runPrompt={runPrompt}
          runMode={runMode}
          runWorkspaceType={runWorkspaceType}
          runBaseBranch={runBaseBranch}
          runModelId={runModelId}
          runWorktreeModelIds={runWorktreeModelIds}
          submitShortcut={submitShortcut}
          projectRunStats={projectRunStats}
          busy={busy}
          reasoningEffort={reasoningEffort}
          anthropicEffort={anthropicEffort}
          yoloMode={yoloMode}
          onSubmitRun={onSubmitRun}
          onSetRunForLater={onSetRunForLater}
          onSelectRun={onSelectRun}
          onRunPromptChange={onRunPromptChange}
          onRunModeChange={onRunModeChange}
          onRunWorkspaceTypeChange={onRunWorkspaceTypeChange}
          onRunBaseBranchChange={onRunBaseBranchChange}
          onRunModelChange={onRunModelChange}
          onRunWorktreeModelIdsChange={onRunWorktreeModelIdsChange}
          onReasoningEffortChange={onReasoningEffortChange}
          onAnthropicEffortChange={onAnthropicEffortChange}
          onYoloModeChange={onYoloModeChange}
        />
      ) : null}

      {activeTab === "tasks" ? (
        <ProjectTasksTab
          projectId={project.project.id}
          tasks={project.tasks}
          modelOptions={modelOptions}
          defaultTaskModelId={defaultTaskModelId}
          busy={busy}
          onCreateTask={onCreateTask}
          onUpdateTask={onUpdateTask}
          onDeleteTask={onDeleteTask}
          onStartTask={onStartTask}
        />
      ) : null}

      {activeTab === "branches" && project.project.kind === "git" ? (
        <ProjectBranchesPage
          projectId={project.project.id}
          repoPath={project.project.repoPath}
          defaultBranch={project.project.defaultBranch}
          currentBranch={currentProjectBranch}
          branches={availableBranches}
          busy={busy}
          onBranchesChanged={onBranchesChanged}
        />
      ) : null}

      {activeTab === "lab" ? (
        <ProjectLabTab
          project={project}
          modelOptions={modelOptions}
          settings={labSettings}
          busy={busy}
          branchOptions={availableBranches}
          selectedBaseBranch={runBaseBranch}
          onBaseBranchChange={onRunBaseBranchChange}
          onSettingsChange={onLabSettingsChange}
          onRunProjectLab={onRunProjectLab}
          onDeleteThread={onDeleteProjectLabThread}
          onOpenImplementationRun={onOpenProjectLabImplementation}
        />
      ) : null}

      {activeTab === "loops" && project.project.kind === "git" ? (
        <ProjectLoopsTab
          project={project}
          modelOptions={modelOptions}
          branchOptions={availableBranches}
          busy={busy}
          availability={loopAvailability}
          onOpenRun={onOpenLoopRun}
          onLoopsChanged={onLoopsChanged}
        />
      ) : null}

      {activeTab === "reviews" && project.project.kind === "git" ? (
        <ProjectPrMrTab
          projectId={project.project.id}
          modelOptions={modelOptions}
          defaultModelId={defaultTaskModelId}
          initialRequest={reviewRequestTarget}
          onOpenProjectSettings={onOpenProjectSettings}
        />
      ) : null}

      <ProjectInsightsTabs
        activeTab={activeTab}
        project={project}
        modelOptions={modelOptions}
        defaultModelId={defaultTaskModelId}
        onGenerateInsight={onGenerateInsight}
        onSelectRun={onSelectRun}
        onRestoreRunFromForLater={onRestoreRunFromForLater}
      />

      {activeTab === "settings" ? (
        <ProjectSettingsPage
          project={project}
          modelOptions={modelOptions}
          availableBranches={availableBranches}
          currentProjectBranch={currentProjectBranch}
          runMode={runMode}
          runWorkspaceType={runWorkspaceType}
          runBaseBranch={runBaseBranch}
          runModelId={runModelId}
          runWorktreeModelIds={runWorktreeModelIds}
          projectRunStats={projectRunStats}
          reasoningEffort={reasoningEffort}
          anthropicEffort={anthropicEffort}
          yoloMode={yoloMode}
          busy={busy}
          availableIntegratedSkills={availableIntegratedSkills}
          activeIntegratedSkillIds={activeIntegratedSkillIds}
          onRunModeChange={onRunModeChange}
          onRunWorkspaceTypeChange={onRunWorkspaceTypeChange}
          onRunBaseBranchChange={onRunBaseBranchChange}
          onRunModelChange={onRunModelChange}
          onRunWorktreeModelIdsChange={onRunWorktreeModelIdsChange}
          onReasoningEffortChange={onReasoningEffortChange}
          onAnthropicEffortChange={onAnthropicEffortChange}
          onYoloModeChange={onYoloModeChange}
          onActiveIntegratedSkillIdsChange={onActiveIntegratedSkillIdsChange}
          onDeleteProject={onDeleteProject}
        />
      ) : null}
      </div>
    </div>
  );
};
