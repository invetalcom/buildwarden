import { appendChatAttachmentFiles, type ChatAttachmentPayload, type IntegratedSkillDefinition, type ProviderType, type RunMode, type RunWorkspaceType, type UnifiedProviderFamily } from "@easycode/shared";
import { Activity, Archive, FolderGit2, Play, PlayCircle, Sparkles, WalletCards } from "lucide-react";
import { useState } from "react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { ProjectSkillSelector } from "./project-skill-selector";
import { RunComposer } from "./RunComposer";

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

interface ProjectOverviewTabProps {
  projectId: string;
  projectName: string;
  repoPath: string;
  runs: Array<{
    id: string;
    prompt: string;
    branchName: string;
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
  availableIntegratedSkills: IntegratedSkillDefinition[];
  activeIntegratedSkillIds: string[];
  onActiveIntegratedSkillIdsChange: (skillIds: string[]) => void | Promise<void>;
}

const formatRunMeta = (branchName: string, createdAt: string) => `${branchName} - ${new Date(createdAt).toLocaleString()}`;

export const ProjectOverviewTab = ({
  projectId,
  projectName,
  repoPath,
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
  availableIntegratedSkills,
  activeIntegratedSkillIds,
  onActiveIntegratedSkillIdsChange,
}: ProjectOverviewTabProps) => {
  const formatTokens = (value: number) => value.toLocaleString();
  const [runAttachmentFiles, setRunAttachmentFiles] = useState<File[]>([]);

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
    <div className="space-y-3.5 pb-1">
      <RunComposer
        attachments={<ChatAttachmentPicker variant="footer" files={runAttachmentFiles} onChange={setRunAttachmentFiles} disabled={busy} />}
        prompt={runPrompt}
        onPromptChange={onRunPromptChange}
        selectedMode={runMode}
        onModeChange={onRunModeChange}
        selectedWorkspaceType={runWorkspaceType}
        onWorkspaceTypeChange={onRunWorkspaceTypeChange}
        selectedModelId={runModelId}
        onModelChange={onRunModelChange}
        modelSelectionMode={runWorkspaceType === "worktree" ? "multi" : "single"}
        selectedModelIds={runWorktreeModelIds}
        onModelIdsChange={onRunWorktreeModelIdsChange}
        modelOptions={modelOptions.map((option) => ({
          value: option.id,
          label: option.label,
          contextModelId: option.modelId,
          providerType: option.providerType,
          providerFamily: option.providerFamily,
        }))}
        selectedBranch={runWorkspaceType === "local" ? currentProjectBranch : runBaseBranch}
        branchOptions={(runWorkspaceType === "local" ? [currentProjectBranch] : availableBranches)
          .filter(Boolean)
          .map((branch) => ({
            value: branch,
            label: runWorkspaceType === "local" ? `${branch} (current)` : branch,
          }))}
        onBranchChange={onRunBaseBranchChange}
        branchDisabled={runWorkspaceType === "local"}
        busy={busy}
        onSubmit={() => void handleStartRun()}
        submitLabel="Start agent run"
        submitIcon={<Play className="ml-2 h-4 w-4" />}
        placeholder={`Describe what EasyCode should do in ${projectName}. (Optional if you attach files.)`}
        autoFocus
        dropdownSide="bottom"
        submitShortcut={submitShortcut}
        onAddAttachmentFiles={(incoming) => setRunAttachmentFiles((prev) => appendChatAttachmentFiles(prev, incoming))}
        submitDisabled={
          busy ||
          !projectId ||
          (runWorkspaceType === "worktree" ? runWorktreeModelIds.length === 0 : !runModelId) ||
          !(runWorkspaceType === "local" ? currentProjectBranch : runBaseBranch) ||
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

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-zinc-400">
          <PlayCircle className="h-3.5 w-3.5 shrink-0 text-cyan-400/80" />
          <span>{projectRunStats.total} runs</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-zinc-400">
          <WalletCards className="h-3.5 w-3.5 shrink-0 text-cyan-400/80" />
          <span>{formatTokens(projectRunStats.totalTokens)} tokens</span>
        </div>
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-2.5 py-1.5 text-left text-xs text-zinc-400 transition hover:border-zinc-700 hover:bg-zinc-900/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500/60"
          title={`${repoPath} - open in file manager`}
          onClick={async () => {
            const r = await window.easycode.openPathInFileManager(repoPath);
            if (!r.ok && r.error) {
              window.alert(`Could not open folder: ${r.error}`);
            }
          }}
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-cyan-400/80" />
          <span className="min-w-0 truncate">{repoPath}</span>
        </button>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-cyan-400" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200">Skills</h3>
            <p className="text-xs text-zinc-500">
              Choose the integrated skills that should apply to new agent runs in this project. Selected skills are prepended to agent runs for this project.
            </p>
          </div>
        </div>
        <ProjectSkillSelector
          skills={availableIntegratedSkills}
          selectedSkillIds={activeIntegratedSkillIds}
          disabled={busy}
          onChange={onActiveIntegratedSkillIdsChange}
        />
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-medium text-zinc-200">Past runs</h3>
        </div>
        <div className="app-scrollbar max-h-[360px] overflow-y-auto rounded-lg border border-zinc-800/80 bg-zinc-950/40">
          {runs.length > 0 ? (
            <div className="divide-y divide-zinc-800/80">
              {runs.map((run) => (
                <div key={run.id} className="flex items-center gap-3 px-4 py-3 transition hover:bg-zinc-900/60">
                  <button className="min-w-0 flex-1 text-left" onClick={() => onSelectRun(run.id)} type="button">
                    <p className="truncate text-sm font-medium text-zinc-200">{run.prompt}</p>
                    <p className="mt-0.5 truncate text-xs text-zinc-500">{formatRunMeta(run.branchName, run.createdAt)}</p>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={run.status}>{run.status}</Badge>
                    <span className="text-xs text-zinc-500">{formatTokens(run.inputTokens + run.outputTokens)}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 text-zinc-500 hover:text-zinc-200"
                      title="Move to For later"
                      onClick={() => void onSetRunForLater(run.id)}
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-zinc-500">
              No visible runs yet. Start one above or move a run back from For later.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
