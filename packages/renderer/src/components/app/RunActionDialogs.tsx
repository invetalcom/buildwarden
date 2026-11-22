import { sessionTitle } from "@buildwarden/shared";
import type { KeyboardEvent, KeyboardEventHandler } from "react";
import type { RunPublishOptions, RunListItem } from "@buildwarden/shared";
import { GitBranch, GitCommitHorizontal, GitFork, GitPullRequest, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "../ui/button";
import { DialogField, DialogOverlay, DialogSurface } from "../ui/dialog-surface";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import type { ConfirmDialogState } from "./app-model";

type RunModelOption = {
  id: string;
  label: string;
};

type PublishDialogKeyDownEvent = KeyboardEvent<
  HTMLInputElement | HTMLButtonElement | HTMLDivElement | HTMLSelectElement | HTMLTextAreaElement
>;

interface RunActionDialogsProps {
  busy: boolean;
  commitDialogRun: RunListItem | null;
  commitMessage: string;
  commitSuggestBusy: boolean;
  onCommitMessageChange: (value: string) => void;
  onCommitDialogKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onSuggestCommitMessage: () => void;
  onSubmitCommitRun: () => void;
  onCloseCommitDialog: () => void;
  publishDialogRun: RunListItem | null;
  publishOptions: RunPublishOptions | null;
  pullRequestSourceBranchMode: "worktree" | "custom";
  pullRequestSourceBranchName: string;
  pullRequestTargetBranch: string;
  pullRequestTitle: string;
  pullRequestCommitMessage: string;
  pullRequestDescription: string;
  pullRequestDraftBusy: boolean;
  onPullRequestSourceBranchModeChange: (value: "worktree" | "custom") => void;
  onPullRequestSourceBranchNameChange: (value: string) => void;
  onPullRequestTargetBranchChange: (value: string) => void;
  onPullRequestTitleChange: (value: string) => void;
  onPullRequestCommitMessageChange: (value: string) => void;
  onPullRequestDescriptionChange: (value: string) => void;
  onPublishDialogKeyDown: (event: PublishDialogKeyDownEvent) => void;
  onGeneratePullRequestDraft: () => void;
  onSubmitPullRequest: () => void;
  onClosePublishDialog: () => void;
  branchPublishDialogRun: RunListItem | null;
  branchPublishName: string;
  branchPublishMode: "publish" | "local";
  branchSuggestBusy: boolean;
  onBranchPublishNameChange: (value: string) => void;
  onBranchPublishDialogKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onSuggestBranchName: () => void;
  onPublishBranch: () => void;
  onCloseBranchPublishDialog: () => void;
  continueDialogRun: RunListItem | null;
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

const CommitDialog = (props: RunActionDialogsProps) => {
  const run = props.commitDialogRun;
  if (!run) return null;
  return (
    <DialogOverlay position="absolute" onKeyDown={props.onCommitDialogKeyDown}>
      <DialogSurface
        icon={<GitCommitHorizontal className="size-4" />}
        title="Create commit"
        description={<>Commit this run&apos;s {run.workspaceType === "local" ? "local repository" : "worktree"} changes on <span className="font-mono text-[var(--ec-text)]">{run.branchName}</span>.</>}
        onClose={props.onCloseCommitDialog}
        footerStart={<span className="text-[11px] text-[var(--ec-faint)]">Ctrl+Enter (Cmd+Enter on Mac) to commit.</span>}
        footer={<>
          <Button variant="secondary" size="sm" onClick={props.onCloseCommitDialog}>Cancel</Button>
          <Button size="sm" onClick={props.onSubmitCommitRun} disabled={props.busy || !props.commitMessage.trim()}>Create commit</Button>
        </>}
      >
        <div className="relative">
          <Textarea className="min-h-32 resize-y pr-10 font-mono text-[13px] leading-relaxed" value={props.commitMessage} onChange={(event) => props.onCommitMessageChange(event.target.value)} placeholder={`Message (Ctrl+Enter to commit on "${run.branchName}")`} autoFocus rows={6} spellCheck={false} />
          <button type="button" className="absolute right-1.5 top-1.5 rounded-md p-1.5 text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-accent)] disabled:cursor-not-allowed disabled:opacity-50" title="Generate commit message with AI" aria-label="Generate commit message with AI" disabled={props.busy || props.commitSuggestBusy} onClick={props.onSuggestCommitMessage}>
            {props.commitSuggestBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      </DialogSurface>
    </DialogOverlay>
  );
};

const PublishDialog = (props: RunActionDialogsProps) => {
  const run = props.publishDialogRun;
  const options = props.publishOptions;
  if (!run || !options) return null;
  const customSource = props.pullRequestSourceBranchMode === "custom";
  return (
    <DialogOverlay position="absolute" onKeyDown={props.onPublishDialogKeyDown}>
      <DialogSurface
        icon={<GitPullRequest className="size-4" />}
        tone="accent"
        title="Create merge request / pull request"
        description={<span data-run-title>{sessionTitle(run)}{!run.title && !run.titleGenerationEnabled && (run.promptIsPreview ?? run.textIsPreview) ? "\u2026" : ""}</span>}
        onClose={props.onClosePublishDialog}
        footerStart={
          <Button type="button" variant="ghost" size="sm" onClick={props.onGeneratePullRequestDraft} disabled={props.busy || props.pullRequestDraftBusy || !props.pullRequestTargetBranch.trim()}>
            {props.pullRequestDraftBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Generate PR content
          </Button>
        }
        footer={<>
          <Button variant="secondary" size="sm" onClick={props.onClosePublishDialog}>Cancel</Button>
          <Button size="sm" onClick={props.onSubmitPullRequest} disabled={props.busy || !props.pullRequestTitle.trim() || !props.pullRequestTargetBranch.trim() || (customSource && !props.pullRequestSourceBranchName.trim()) || (options.hasOpenChanges && !props.pullRequestCommitMessage.trim())}>Create MR / PR</Button>
        </>}
      >
        <div className="space-y-3">
          <DialogField label="Source branch">
            <Select value={props.pullRequestSourceBranchMode} onValueChange={(value) => props.onPullRequestSourceBranchModeChange(value === "custom" ? "custom" : "worktree")} onKeyDown={props.onPublishDialogKeyDown} options={[{ value: "worktree", label: `Keep worktree branch (${options.defaultSourceBranch})` }, { value: "custom", label: "Create and use a custom branch" }]} />
          </DialogField>
          {customSource && <DialogField label="Custom source branch name"><Input value={props.pullRequestSourceBranchName} onChange={(event) => props.onPullRequestSourceBranchNameChange(event.target.value)} onKeyDown={props.onPublishDialogKeyDown} placeholder="feature/my-custom-branch" autoFocus /></DialogField>}
          <DialogField label="Target branch"><Select value={props.pullRequestTargetBranch} onValueChange={props.onPullRequestTargetBranchChange} onKeyDown={props.onPublishDialogKeyDown} options={options.targetBranches.map((branch) => ({ value: branch, label: branch }))} /></DialogField>
          <DialogField label="Merge request / pull request title"><Input value={props.pullRequestTitle} onChange={(event) => props.onPullRequestTitleChange(event.target.value)} onKeyDown={props.onPublishDialogKeyDown} placeholder="Merge request / pull request title" autoFocus={!customSource} /></DialogField>
          {options.hasOpenChanges && (
            <label className="app-inset block p-3 text-xs">
              <span className="block font-medium text-[var(--ec-warning)]">Commit open changes before publishing</span>
              <span className="mt-0.5 block text-[var(--ec-muted)]">BuildWarden will create this commit only when you create the request.</span>
              <Textarea className="mt-2 min-h-20 resize-y font-mono text-[13px]" value={props.pullRequestCommitMessage} onChange={(event) => props.onPullRequestCommitMessageChange(event.target.value)} onKeyDown={props.onPublishDialogKeyDown} placeholder="Commit message" rows={3} spellCheck={false} />
            </label>
          )}
          <DialogField label="Merge request / pull request description">
            <Textarea value={props.pullRequestDescription} onChange={(event) => props.onPullRequestDescriptionChange(event.target.value)} onKeyDown={props.onPublishDialogKeyDown} placeholder="Merge request / pull request description" className="min-h-36" />
          </DialogField>
        </div>
      </DialogSurface>
    </DialogOverlay>
  );
};

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
  pullRequestCommitMessage,
  pullRequestDescription,
  pullRequestDraftBusy,
  onPullRequestSourceBranchModeChange,
  onPullRequestSourceBranchNameChange,
  onPullRequestTargetBranchChange,
  onPullRequestTitleChange,
  onPullRequestCommitMessageChange,
  onPullRequestDescriptionChange,
  onPublishDialogKeyDown,
  onGeneratePullRequestDraft,
  onSubmitPullRequest,
  onClosePublishDialog,
  branchPublishDialogRun,
  branchPublishName,
  branchPublishMode,
  branchSuggestBusy,
  onBranchPublishNameChange,
  onBranchPublishDialogKeyDown,
  onSuggestBranchName,
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
    <CommitDialog {...{ busy, commitDialogRun, commitMessage, commitSuggestBusy, onCommitMessageChange, onCommitDialogKeyDown, onSuggestCommitMessage, onSubmitCommitRun, onCloseCommitDialog, publishDialogRun, publishOptions, pullRequestSourceBranchMode, pullRequestSourceBranchName, pullRequestTargetBranch, pullRequestTitle, pullRequestCommitMessage, pullRequestDescription, pullRequestDraftBusy, onPullRequestSourceBranchModeChange, onPullRequestSourceBranchNameChange, onPullRequestTargetBranchChange, onPullRequestTitleChange, onPullRequestCommitMessageChange, onPullRequestDescriptionChange, onPublishDialogKeyDown, onGeneratePullRequestDraft, onSubmitPullRequest, onClosePublishDialog, branchPublishDialogRun, branchPublishName, branchPublishMode, branchSuggestBusy, onBranchPublishNameChange, onBranchPublishDialogKeyDown, onSuggestBranchName, onPublishBranch, onCloseBranchPublishDialog, continueDialogRun, continuePrompt, continueModelId, continueIncludeWorkspaceChanges, continueModelOptions, onContinuePromptChange, onContinueModelIdChange, onContinueIncludeWorkspaceChangesChange, onSubmitContinueRun, onCloseContinueRunDialog, confirmDialog, onResolveConfirmation }} />
    <PublishDialog {...{ busy, commitDialogRun, commitMessage, commitSuggestBusy, onCommitMessageChange, onCommitDialogKeyDown, onSuggestCommitMessage, onSubmitCommitRun, onCloseCommitDialog, publishDialogRun, publishOptions, pullRequestSourceBranchMode, pullRequestSourceBranchName, pullRequestTargetBranch, pullRequestTitle, pullRequestCommitMessage, pullRequestDescription, pullRequestDraftBusy, onPullRequestSourceBranchModeChange, onPullRequestSourceBranchNameChange, onPullRequestTargetBranchChange, onPullRequestTitleChange, onPullRequestCommitMessageChange, onPullRequestDescriptionChange, onPublishDialogKeyDown, onGeneratePullRequestDraft, onSubmitPullRequest, onClosePublishDialog, branchPublishDialogRun, branchPublishName, branchPublishMode, branchSuggestBusy, onBranchPublishNameChange, onBranchPublishDialogKeyDown, onSuggestBranchName, onPublishBranch, onCloseBranchPublishDialog, continueDialogRun, continuePrompt, continueModelId, continueIncludeWorkspaceChanges, continueModelOptions, onContinuePromptChange, onContinueModelIdChange, onContinueIncludeWorkspaceChangesChange, onSubmitContinueRun, onCloseContinueRunDialog, confirmDialog, onResolveConfirmation }} />

    {branchPublishDialogRun ? (
      <DialogOverlay position="absolute" onKeyDown={onBranchPublishDialogKeyDown}>
        <DialogSurface
          className="max-w-md"
          icon={<GitBranch className="size-4" />}
          title={branchPublishMode === "local" ? "Create local branch" : "Publish branch"}
          description={branchPublishMode === "publish" ? <span data-run-title>{sessionTitle(branchPublishDialogRun)}{!branchPublishDialogRun.title && !branchPublishDialogRun.titleGenerationEnabled && (branchPublishDialogRun.promptIsPreview ?? branchPublishDialogRun.textIsPreview) ? "\u2026" : ""}</span> : undefined}
          onClose={onCloseBranchPublishDialog}
          footer={<>
            <Button variant="secondary" size="sm" onClick={onCloseBranchPublishDialog}>
              Cancel
            </Button>
            <Button
              size="sm"
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
          </>}
        >
          <DialogField label="Branch name">
            <div className="relative">
              <Input
                className={branchPublishMode === "local" ? "pr-10" : undefined}
                value={branchPublishName}
                onChange={(event) => onBranchPublishNameChange(event.target.value)}
                placeholder="feature/my-custom-branch"
                autoFocus
              />
              {branchPublishMode === "local" ? (
                <button
                  type="button"
                  className="absolute right-0.5 top-0.5 rounded-md p-1.5 text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  title="Generate branch name with AI"
                  aria-label="Generate branch name with AI"
                  disabled={busy || branchSuggestBusy}
                  onClick={onSuggestBranchName}
                >
                  {branchSuggestBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                </button>
              ) : null}
            </div>
          </DialogField>
        </DialogSurface>
      </DialogOverlay>
    ) : null}

    {continueDialogRun ? (
      <DialogOverlay
        position="absolute"
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
        <DialogSurface
          icon={<GitFork className="size-4" />}
          title="Fork (fresh context)"
          description={<>
            <span data-run-title className="block truncate text-[var(--ec-text)]">{sessionTitle(continueDialogRun)}{!continueDialogRun.title && !continueDialogRun.titleGenerationEnabled && (continueDialogRun.promptIsPreview ?? continueDialogRun.textIsPreview) ? "\u2026" : ""}</span>
            {continueDialogRun.workspaceVcs === "folder" ? (
              <>Start a new run in a fresh copied workspace from this run&apos;s current folder state.</>
            ) : (
              <>
                Start a new run from branch <span className="font-medium text-[var(--ec-text)]">{continueDialogRun.branchName}</span> in a fresh worktree.
              </>
            )}
          </>}
          onClose={onCloseContinueRunDialog}
          footer={<>
            <Button variant="secondary" size="sm" onClick={onCloseContinueRunDialog}>
              Cancel
            </Button>
            <Button size="sm" onClick={onSubmitContinueRun} disabled={busy || !continuePrompt.trim() || !continueModelId}>
              Start fork
            </Button>
          </>}
        >
          <div className="space-y-3">
            <DialogField label="Fork prompt">
              <Textarea
                value={continuePrompt}
                onChange={(event) => onContinuePromptChange(event.target.value)}
                placeholder="Continue from the current state and..."
                className="min-h-28"
                autoFocus
              />
            </DialogField>
            <DialogField label="Model">
              <Select
                value={continueModelId}
                onValueChange={onContinueModelIdChange}
                options={continueModelOptions.map((option) => ({ value: option.id, label: option.label }))}
              />
            </DialogField>
            <label className="app-inset flex items-center gap-3 px-3 py-2 text-[13px] text-[var(--ec-text)]">
              <input
                type="checkbox"
                className="h-4 w-4 rounded accent-[var(--ec-accent)]"
                checked={continueIncludeWorkspaceChanges}
                onChange={(event) => onContinueIncludeWorkspaceChangesChange(event.target.checked)}
              />
              <span>Include the source run&apos;s current workspace changes</span>
            </label>
          </div>
        </DialogSurface>
      </DialogOverlay>
    ) : null}

    {confirmDialog ? (
      <DialogOverlay
        position="absolute"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onResolveConfirmation(false);
          }
        }}
      >
        <DialogSurface
          className="max-w-lg"
          icon={<TriangleAlert className="size-4" />}
          tone={confirmDialog.confirmVariant === "danger" ? "danger" : "warning"}
          title={confirmDialog.title}
          description={confirmDialog.message}
          footer={<>
            <Button variant="secondary" size="sm" onClick={() => onResolveConfirmation(false)} autoFocus>
              {confirmDialog.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              size="sm"
              variant={confirmDialog.confirmVariant ?? "default"}
              onClick={() => onResolveConfirmation(true)}
            >
              {confirmDialog.confirmLabel}
            </Button>
          </>}
        >
          {confirmDialog.impactItems ? (
            <div className="app-inset px-3 py-2.5">
              <p className="text-[11px] font-medium text-[var(--ec-muted)]">Related data</p>
              <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
                {confirmDialog.impactItems.map((item) => (
                  <div key={item.label} className="contents">
                    <dt className="text-[var(--ec-muted)]">{item.label}</dt>
                    <dd className="text-right font-medium tabular-nums text-[var(--ec-text)]">{item.count}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </DialogSurface>
      </DialogOverlay>
    ) : null}
  </>
);
