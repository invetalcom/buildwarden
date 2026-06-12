import { appendChatAttachmentFiles, type ChatAttachmentPayload, type ProviderType, type RunMode, type RunWorkspaceType, type UnifiedProviderFamily } from "@buildwarden/shared";
import { Archive, Clock3, Play, PlayCircle } from "lucide-react";
import { useState } from "react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
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
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import type { ProjectRunStats } from "./ProjectStatisticsCard";
import { RunComposer } from "./RunComposer";

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
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      <section className="grid gap-3">
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
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Run History</CardTitle>
            <CardDescription>{runs.length} visible runs in this project.</CardDescription>
          </div>
          <Clock3 className="size-4 text-[var(--ec-muted)]" />
        </CardHeader>
        <CardContent className="p-0">
          {runs.length > 0 ? (
            <div className="app-scrollbar max-h-[520px] overflow-y-auto">
              {runs.map((run) => (
                <div key={run.id} className="flex items-center gap-3 border-t border-[var(--ec-border)] px-4 py-3 transition hover:bg-[var(--ec-hover)]">
                  <button className="min-w-0 flex-1 text-left" onClick={() => onSelectRun(run.id)} type="button">
                    <p className="truncate text-sm font-semibold text-[var(--ec-text)]">{run.prompt}</p>
                    <p className="mt-0.5 truncate font-mono text-xs text-[var(--ec-muted)]">{formatRunMeta(run.branchName, run.createdAt)}</p>
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
