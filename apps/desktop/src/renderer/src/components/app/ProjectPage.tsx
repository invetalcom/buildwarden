import type {
  IntegratedSkillDefinition,
  ProjectInsightKind,
  ProjectLabMode,
  ProjectLabSettings,
  ProjectSnapshot,
  ProviderType,
  RunMode,
  RunWorkspaceType,
  UnifiedProviderFamily,
} from "@easycode/shared";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { ProjectForLaterTab } from "./ProjectForLaterTab";
import { ProjectHistoryTab } from "./ProjectHistoryTab";
import { ProjectInsightsTab } from "./ProjectInsightsTab";
import { ProjectLabTab } from "./ProjectLabTab";
import { ProjectOverviewTab } from "./ProjectOverviewTab";
import { ProjectPrMrTab } from "./ProjectPrMrTab";
import { ProjectTasksTab } from "./ProjectTasksTab";

const ProjectGraphsTab = lazy(() => import("./ProjectGraphsTab").then((module) => ({ default: module.ProjectGraphsTab })));

interface ProjectRunStats {
  total: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

type ProjectPageTab = "overview" | "lab" | "tasks" | "reviews" | "graphs" | "insights" | "history" | "for-later";

interface ProjectPageProps {
  project: ProjectSnapshot;
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
  onSubmitRun: (payload: { attachments?: import("@easycode/shared").ChatAttachmentPayload[] }) => void | Promise<void>;
  onCreateTask: (input: { title: string; prompt: string }) => void | Promise<void>;
  onDeleteTask: (taskId: string) => void | Promise<void>;
  onStartTask: (prompt: string, modelId: string) => void | Promise<void>;
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
  availableIntegratedSkills: IntegratedSkillDefinition[];
  activeIntegratedSkillIds: string[];
  onActiveIntegratedSkillIdsChange: (skillIds: string[]) => void | Promise<void>;
  labSettings: ProjectLabSettings;
  onLabSettingsChange: (settings: ProjectLabSettings) => void | Promise<void>;
  onRunProjectLab: (input: { mode: ProjectLabMode; baseBranch: string }) => void | Promise<void>;
  onStartProjectLabImplementation: (threadId: string) => void | Promise<void>;
  onDeleteProjectLabThread: (threadId: string) => void | Promise<void>;
  onOpenProjectLabImplementation: (runId: string) => void;
}

const tabButtonClassName = (active: boolean) =>
  active
    ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-100"
    : "border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900/40 hover:text-zinc-200";

export const ProjectPage = ({
  project,
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
  onSubmitRun,
  onCreateTask,
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
  onStartProjectLabImplementation,
  onDeleteProjectLabThread,
  onOpenProjectLabImplementation,
}: ProjectPageProps) => {
  const [activeTab, setActiveTab] = useState<ProjectPageTab>("overview");
  const defaultTaskModelId = useMemo(
    () => (modelOptions.some((option) => option.id === runModelId) ? runModelId : (modelOptions[0]?.id ?? "")),
    [modelOptions, runModelId],
  );

  useEffect(() => {
    setActiveTab("overview");
  }, [project.project.id]);

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${tabButtonClassName(activeTab === "overview")}`}
          onClick={() => setActiveTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${tabButtonClassName(activeTab === "lab")}`}
          onClick={() => setActiveTab("lab")}
        >
          Project Lab
          <span className="ml-2 text-[10px] text-zinc-500">{project.labThreads.length}</span>
        </button>
        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${tabButtonClassName(activeTab === "tasks")}`}
          onClick={() => setActiveTab("tasks")}
        >
          Tasks
          <span className="ml-2 text-[10px] text-zinc-500">{project.tasks.length}</span>
        </button>
        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${tabButtonClassName(activeTab === "reviews")}`}
          onClick={() => setActiveTab("reviews")}
        >
          PR / MR
        </button>
        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${tabButtonClassName(activeTab === "graphs")}`}
          onClick={() => setActiveTab("graphs")}
        >
          Graphs
        </button>
        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${tabButtonClassName(activeTab === "insights")}`}
          onClick={() => setActiveTab("insights")}
        >
          Insights
        </button>
        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${tabButtonClassName(activeTab === "history")}`}
          onClick={() => setActiveTab("history")}
        >
          History
        </button>
        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${tabButtonClassName(activeTab === "for-later")}`}
          onClick={() => setActiveTab("for-later")}
        >
          For later
          <span className="ml-2 text-[10px] text-zinc-500">{project.forLaterRuns.length}</span>
        </button>
      </div>

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          activeTab === "reviews" ? "overflow-hidden" : "overflow-y-auto",
        )}
      >
      {activeTab === "overview" ? (
        <ProjectOverviewTab
          projectId={project.project.id}
          projectName={project.project.name}
          repoPath={project.project.repoPath}
          runs={project.runs}
          modelOptions={modelOptions}
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
          availableIntegratedSkills={availableIntegratedSkills}
          activeIntegratedSkillIds={activeIntegratedSkillIds}
          onActiveIntegratedSkillIdsChange={onActiveIntegratedSkillIdsChange}
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
          onDeleteTask={onDeleteTask}
          onStartTask={onStartTask}
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
          onStartImplementation={onStartProjectLabImplementation}
          onDeleteThread={onDeleteProjectLabThread}
          onOpenImplementationRun={onOpenProjectLabImplementation}
        />
      ) : null}

      {activeTab === "reviews" ? (
        <ProjectPrMrTab projectId={project.project.id} modelOptions={modelOptions} defaultModelId={defaultTaskModelId} />
      ) : null}

      {activeTab === "graphs" ? (
        <Suspense fallback={<div className="px-3 py-2 text-xs text-zinc-500">Loading graphs...</div>}>
          <ProjectGraphsTab project={project} onGenerateInsight={onGenerateInsight} />
        </Suspense>
      ) : null}

      {activeTab === "insights" ? (
        <ProjectInsightsTab
          project={project}
          modelOptions={modelOptions}
          defaultModelId={defaultTaskModelId}
          onGenerateInsight={onGenerateInsight}
        />
      ) : null}

      {activeTab === "history" ? (
        <ProjectHistoryTab
          project={project}
          modelOptions={modelOptions}
          defaultModelId={defaultTaskModelId}
          onGenerateInsight={onGenerateInsight}
          onSelectRun={onSelectRun}
        />
      ) : null}

      {activeTab === "for-later" ? (
        <ProjectForLaterTab runs={project.forLaterRuns} onSelectRun={onSelectRun} onRestoreRunFromForLater={onRestoreRunFromForLater} />
      ) : null}
      </div>
    </div>
  );
};
