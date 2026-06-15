import type { ComponentProps, KeyboardEvent, KeyboardEventHandler } from "react";
import type { RunPublishOptions, RunRecord } from "@buildwarden/shared";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";

type RunModelOption = {
  id: string;
  label: string;
};

type PublishDialogKeyDownEvent = KeyboardEvent<
  HTMLInputElement | HTMLButtonElement | HTMLDivElement | HTMLSelectElement | HTMLTextAreaElement
>;

type ConfirmDialogState = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ComponentProps<typeof Button>["variant"];
};

interface RunActionDialogsProps {
  busy: boolean;
  commitDialogRun: RunRecord | null;
  commitMessage: string;
  commitSuggestBusy: boolean;
  onCommitMessageChange: (value: string) => void;
  onCommitDialogKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onSuggestCommitMessage: () => void;
  onSubmitCommitRun: () => void;
  onCloseCommitDialog: () => void;
  publishDialogRun: RunRecord | null;
  publishOptions: RunPublishOptions | null;
  pullRequestSourceBranchMode: "worktree" | "custom";
  pullRequestSourceBranchName: string;
  pullRequestTargetBranch: string;
  pullRequestTitle: string;
  pullRequestDescription: string;
  pullRequestDescriptionBusy: boolean;
  onPullRequestSourceBranchModeChange: (value: "worktree" | "custom") => void;
  onPullRequestSourceBranchNameChange: (value: string) => void;
  onPullRequestTargetBranchChange: (value: string) => void;
  onPullRequestTitleChange: (value: string) => void;
  onPullRequestDescriptionChange: (value: string) => void;
  onPublishDialogKeyDown: (event: PublishDialogKeyDownEvent) => void;
  onGeneratePullRequestDescription: () => void;
  onSubmitPullRequest: () => void;
  onClosePublishDialog: () => void;
  branchPublishDialogRun: RunRecord | null;
  branchPublishName: string;
  branchPublishMode: "publish" | "local";
  onBranchPublishNameChange: (value: string) => void;
  onBranchPublishDialogKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPublishBranch: () => void;
  onCloseBranchPublishDialog: () => void;
  continueDialogRun: RunRecord | null;
  continuePrompt: string;
  continueModelId: string;
  continueIncludeWorkspaceChanges: boolean;
  continueModelOptions: RunModelOption[];
  onContinuePromptChange: (value: string) => void;
  onContinueModelIdChange: (value: string) => void;
  onContinueIncludeWorkspaceChangesChange: (value: boolean) => void;
  onSubmitContinueRun: () => void;
  onCloseContinueRunDialog: () => void;
  confirmDialog: ConfirmDialogState | null;
  onResolveConfirmation: (confirmed: boolean) => void;
}

const DialogOverlay = ({
  children,
  onKeyDown,
}: {
  children: React.ReactNode;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) => (
  <div
    className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/70 p-6 backdrop-blur-sm"
    onKeyDown={onKeyDown}
  >
    {children}
  </div>
);

export const RunActionDialogs = ({
  busy,
  commitDialogRun,
  commitMessage,
  commitSuggestBusy,
  onCommitMessageChange,
  onCommitDialogKeyDown,
  onSuggestCommitMessage,
  onSubmitCommitRun,
  onCloseCommitDialog,
  publishDialogRun,
  publishOptions,
  pullRequestSourceBranchMode,
  pullRequestSourceBranchName,
  pullRequestTargetBranch,
  pullRequestTitle,
  pullRequestDescription,
  pullRequestDescriptionBusy,
  onPullRequestSourceBranchModeChange,
  onPullRequestSourceBranchNameChange,
  onPullRequestTargetBranchChange,
  onPullRequestTitleChange,
  onPullRequestDescriptionChange,
  onPublishDialogKeyDown,
  onGeneratePullRequestDescription,
  onSubmitPullRequest,
  onClosePublishDialog,
  branchPublishDialogRun,
  branchPublishName,
  branchPublishMode,
  onBranchPublishNameChange,
  onBranchPublishDialogKeyDown,
  onPublishBranch,
  onCloseBranchPublishDialog,
  continueDialogRun,
  continuePrompt,
  continueModelId,
  continueIncludeWorkspaceChanges,
  continueModelOptions,
  onContinuePromptChange,
  onContinueModelIdChange,
  onContinueIncludeWorkspaceChangesChange,
  onSubmitContinueRun,
  onCloseContinueRunDialog,
  confirmDialog,
  onResolveConfirmation,
}: RunActionDialogsProps) => (
  <>
    {commitDialogRun ? (
      <DialogOverlay onKeyDown={onCommitDialogKeyDown}>
        <Card className="shadow-[var(--ec-popover-shadow)] w-full max-w-xl p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Create commit</p>
          <h3 className="mt-2 text-xl font-semibold">{commitDialogRun.prompt}</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Choose the commit message for this run&apos;s {commitDialogRun.workspaceType === "local" ? "local repository" : "worktree"} changes.
            <span className="mt-1 block text-[11px] text-zinc-600">Ctrl+Enter (Cmd+Enter on Mac) to commit.</span>
          </p>
          <div className="relative mt-4">
            <Textarea
              className="min-h-32 resize-y pr-11 font-mono text-sm leading-relaxed"
              value={commitMessage}
              onChange={(event) => onCommitMessageChange(event.target.value)}
              placeholder={`Message (Ctrl+Enter to commit on "${commitDialogRun.branchName}")`}
              autoFocus
              rows={6}
              spellCheck={false}
            />
            <button
              type="button"
              className="absolute right-2 top-2 rounded-md border border-zinc-700 bg-zinc-900/95 p-2 text-zinc-400 shadow-sm transition hover:border-cyan-500/40 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              title="Generate commit message with AI"
              aria-label="Generate commit message with AI"
              disabled={busy || commitSuggestBusy}
              onClick={onSuggestCommitMessage}
            >
              {commitSuggestBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
            </button>
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            <Button variant="outline" onClick={onCloseCommitDialog}>
              Cancel
            </Button>
            <Button onClick={onSubmitCommitRun} disabled={busy || !commitMessage.trim()}>
              Create commit
            </Button>
          </div>
        </Card>
      </DialogOverlay>
    ) : null}

    {publishDialogRun && publishOptions ? (
      <DialogOverlay onKeyDown={(event) => onPublishDialogKeyDown(event)}>
        <Card className="shadow-[var(--ec-popover-shadow)] w-full max-w-xl p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Create merge request / pull request</p>
          <h3 className="mt-2 text-xl font-semibold">{publishDialogRun.prompt}</h3>
          <p className="mt-1 text-sm text-zinc-500">Choose the source branch, target branch, and review the generated title before publishing.</p>
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-300">Source branch</span>
              <Select
                value={pullRequestSourceBranchMode}
                onValueChange={(value) => onPullRequestSourceBranchModeChange(value === "custom" ? "custom" : "worktree")}
                onKeyDown={(event) => onPublishDialogKeyDown(event)}
                options={[
                  { value: "worktree", label: `Keep worktree branch (${publishOptions.defaultSourceBranch})` },
                  { value: "custom", label: "Create and use a custom branch" },
                ]}
              />
            </label>
            {pullRequestSourceBranchMode === "custom" ? (
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-300">Custom source branch name</span>
                <Input
                  value={pullRequestSourceBranchName}
                  onChange={(event) => onPullRequestSourceBranchNameChange(event.target.value)}
                  onKeyDown={(event) => onPublishDialogKeyDown(event)}
                  placeholder="feature/my-custom-branch"
                  autoFocus
                />
              </label>
            ) : null}
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-300">Target branch</span>
              <Select
                value={pullRequestTargetBranch}
                onValueChange={onPullRequestTargetBranchChange}
                onKeyDown={(event) => onPublishDialogKeyDown(event)}
                options={publishOptions.targetBranches.map((branch) => ({ value: branch, label: branch }))}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-300">Merge request / pull request title</span>
              <Input
                value={pullRequestTitle}
                onChange={(event) => onPullRequestTitleChange(event.target.value)}
                onKeyDown={(event) => onPublishDialogKeyDown(event)}
                placeholder="Merge request / pull request title"
                autoFocus={pullRequestSourceBranchMode !== "custom"}
              />
            </label>
            <label className="block text-sm">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="block text-zinc-300">Merge request / pull request description</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={onGeneratePullRequestDescription}
                  disabled={busy || pullRequestDescriptionBusy || !pullRequestTitle.trim() || !pullRequestTargetBranch.trim()}
                >
                  {pullRequestDescriptionBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  Generate
                </Button>
              </div>
              <Textarea
                value={pullRequestDescription}
                onChange={(event) => onPullRequestDescriptionChange(event.target.value)}
                onKeyDown={(event) => onPublishDialogKeyDown(event)}
                placeholder="Merge request / pull request description"
                className="min-h-36"
              />
            </label>
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            <Button variant="outline" onClick={onClosePublishDialog}>
              Cancel
            </Button>
            <Button
              onClick={onSubmitPullRequest}
              disabled={
                busy ||
                !pullRequestTitle.trim() ||
                !pullRequestTargetBranch.trim() ||
                (pullRequestSourceBranchMode === "custom" && !pullRequestSourceBranchName.trim())
              }
            >
              Create MR / PR
            </Button>
          </div>
        </Card>
      </DialogOverlay>
    ) : null}

    {branchPublishDialogRun ? (
      <DialogOverlay onKeyDown={onBranchPublishDialogKeyDown}>
        <Card className="shadow-[var(--ec-popover-shadow)] w-full max-w-md p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">
            {branchPublishMode === "local" ? "Create local branch" : "Publish branch"}
          </p>
          <h3 className="mt-2 text-xl font-semibold">{branchPublishDialogRun.prompt}</h3>
          <label className="mt-4 block text-sm">
            <span className="mb-1 block text-zinc-300">Branch name</span>
            <Input
              value={branchPublishName}
              onChange={(event) => onBranchPublishNameChange(event.target.value)}
              placeholder="feature/my-custom-branch"
              autoFocus
            />
          </label>
          <div className="mt-4 flex items-center justify-end gap-3">
            <Button variant="outline" onClick={onCloseBranchPublishDialog}>
              Cancel
            </Button>
            <Button
              onClick={onPublishBranch}
              disabled={
                busy ||
                !branchPublishName.trim() ||
                (branchPublishMode === "local" &&
                  branchPublishDialogRun.workspaceType !== "worktree" &&
                  branchPublishName.trim() === branchPublishDialogRun.branchName)
              }
            >
              {branchPublishMode === "local" ? "Create local branch" : "Publish branch"}
            </Button>
          </div>
        </Card>
      </DialogOverlay>
    ) : null}

    {continueDialogRun ? (
      <DialogOverlay
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCloseContinueRunDialog();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmitContinueRun();
          }
        }}
      >
        <Card className="shadow-[var(--ec-popover-shadow)] w-full max-w-xl p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Continue run</p>
          <h3 className="mt-2 text-xl font-semibold">{continueDialogRun.prompt}</h3>
          <p className="mt-1 text-sm text-zinc-500">
            {continueDialogRun.workspaceVcs === "folder" ? (
              <>Start a new run in a fresh copied workspace from this run&apos;s current folder state.</>
            ) : (
              <>
                Start a new run from branch <span className="font-medium text-zinc-300">{continueDialogRun.branchName}</span> in a fresh worktree.
              </>
            )}
          </p>
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-300">Continuation prompt</span>
              <Textarea
                value={continuePrompt}
                onChange={(event) => onContinuePromptChange(event.target.value)}
                placeholder="Continue from the current state and..."
                className="min-h-28"
                autoFocus
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-300">Model</span>
              <Select
                value={continueModelId}
                onValueChange={onContinueModelIdChange}
                options={continueModelOptions.map((option) => ({ value: option.id, label: option.label }))}
              />
            </label>
            <label className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border border-zinc-700 bg-zinc-950 accent-[var(--ec-accent)]"
                checked={continueIncludeWorkspaceChanges}
                onChange={(event) => onContinueIncludeWorkspaceChangesChange(event.target.checked)}
              />
              <span>Include the source run&apos;s current workspace changes</span>
            </label>
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            <Button variant="outline" onClick={onCloseContinueRunDialog}>
              Cancel
            </Button>
            <Button onClick={onSubmitContinueRun} disabled={busy || !continuePrompt.trim() || !continueModelId}>
              Start continuation
            </Button>
          </div>
        </Card>
      </DialogOverlay>
    ) : null}

    {confirmDialog ? (
      <DialogOverlay
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onResolveConfirmation(false);
          }
        }}
      >
        <Card className="shadow-[var(--ec-popover-shadow)] w-full max-w-lg p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Confirm action</p>
          <h3 className="mt-2 text-xl font-semibold text-zinc-100">{confirmDialog.title}</h3>
          <p className="mt-3 text-sm leading-relaxed text-zinc-400">{confirmDialog.message}</p>
          <div className="mt-5 flex items-center justify-end gap-3">
            <Button variant="outline" onClick={() => onResolveConfirmation(false)} autoFocus>
              {confirmDialog.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={confirmDialog.confirmVariant ?? "default"}
              onClick={() => onResolveConfirmation(true)}
            >
              {confirmDialog.confirmLabel}
            </Button>
          </div>
        </Card>
      </DialogOverlay>
    ) : null}
  </>
);
