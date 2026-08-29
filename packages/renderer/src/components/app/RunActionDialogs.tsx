import type { KeyboardEvent, KeyboardEventHandler } from "react";
import type { RunPublishOptions, RunRecord } from "@buildwarden/shared";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
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
  branchPublishDialogRun: RunRecord | null;
  branchPublishName: string;
  branchPublishMode: "publish" | "local";
  branchSuggestBusy: boolean;
  onBranchPublishNameChange: (value: string) => void;
  onBranchPublishDialogKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onSuggestBranchName: () => void;
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
    className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--ec-panel)] p-6 backdrop-blur-sm"
    onKeyDown={onKeyDown}
  >
    {children}
  </div>
);

const CommitDialog = (props: RunActionDialogsProps) => {
  const run = props.commitDialogRun;
  if (!run) return null;
  return (
    <DialogOverlay onKeyDown={props.onCommitDialogKeyDown}>
      <Card className="shadow-[var(--ec-popover-shadow)] w-full max-w-xl p-5">
        <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-muted)]">Create commit</p>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          Choose the commit message for this run&apos;s {run.workspaceType === "local" ? "local repository" : "worktree"} changes.
          <span className="mt-1 block text-[11px] text-[var(--ec-faint)]">Ctrl+Enter (Cmd+Enter on Mac) to commit.</span>
        </p>
        <div className="relative mt-4">
          <Textarea className="min-h-32 resize-y pr-11 font-mono text-sm leading-relaxed" value={props.commitMessage} onChange={(event) => props.onCommitMessageChange(event.target.value)} placeholder={`Message (Ctrl+Enter to commit on "${run.branchName}")`} autoFocus rows={6} spellCheck={false} />
          <button type="button" className="absolute right-2 top-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2 text-[var(--ec-muted)] shadow-sm transition hover:border-[var(--ec-accent-ring)] hover:text-[var(--ec-accent-strong)] disabled:cursor-not-allowed disabled:opacity-50" title="Generate commit message with AI" aria-label="Generate commit message with AI" disabled={props.busy || props.commitSuggestBusy} onClick={props.onSuggestCommitMessage}>
            {props.commitSuggestBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
          </button>
        </div>
        <div className="mt-4 flex items-center justify-end gap-3">
          <Button variant="outline" onClick={props.onCloseCommitDialog}>Cancel</Button>
          <Button onClick={props.onSubmitCommitRun} disabled={props.busy || !props.commitMessage.trim()}>Create commit</Button>
        </div>
      </Card>
    </DialogOverlay>
  );
};

const PublishDialog = (props: RunActionDialogsProps) => {
  const run = props.publishDialogRun;
  const options = props.publishOptions;
  if (!run || !options) return null;
  const customSource = props.pullRequestSourceBranchMode === "custom";
  return (
    <DialogOverlay onKeyDown={props.onPublishDialogKeyDown}>
      <Card className="shadow-[var(--ec-popover-shadow)] w-full max-w-xl p-5">
        <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-muted)]">Create merge request / pull request</p>
        <h3 className="mt-2 text-xl font-semibold">{run.prompt}</h3>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-[var(--ec-text)]">Source branch</span>
            <Select value={props.pullRequestSourceBranchMode} onValueChange={(value) => props.onPullRequestSourceBranchModeChange(value === "custom" ? "custom" : "worktree")} onKeyDown={props.onPublishDialogKeyDown} options={[{ value: "worktree", label: `Keep worktree branch (${options.defaultSourceBranch})` }, { value: "custom", label: "Create and use a custom branch" }]} />
          </label>
          {customSource && <label className="block text-sm"><span className="mb-1 block text-[var(--ec-text)]">Custom source branch name</span><Input value={props.pullRequestSourceBranchName} onChange={(event) => props.onPullRequestSourceBranchNameChange(event.target.value)} onKeyDown={props.onPublishDialogKeyDown} placeholder="feature/my-custom-branch" autoFocus /></label>}
          <label className="block text-sm"><span className="mb-1 block text-[var(--ec-text)]">Target branch</span><Select value={props.pullRequestTargetBranch} onValueChange={props.onPullRequestTargetBranchChange} onKeyDown={props.onPublishDialogKeyDown} options={options.targetBranches.map((branch) => ({ value: branch, label: branch }))} /></label>
          <label className="block text-sm"><span className="mb-1 block text-[var(--ec-text)]">Merge request / pull request title</span><Input value={props.pullRequestTitle} onChange={(event) => props.onPullRequestTitleChange(event.target.value)} onKeyDown={props.onPublishDialogKeyDown} placeholder="Merge request / pull request title" autoFocus={!customSource} /></label>
          {options.hasOpenChanges && (
            <label className="block rounded-lg border border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] p-3 text-sm">
              <span className="block text-[var(--ec-text)]">Commit open changes before publishing</span>
              <span className="mt-0.5 block text-xs text-[var(--ec-muted)]">BuildWarden will create this commit only when you create the request.</span>
              <Textarea className="mt-2 min-h-20 resize-y font-mono text-sm" value={props.pullRequestCommitMessage} onChange={(event) => props.onPullRequestCommitMessageChange(event.target.value)} onKeyDown={props.onPublishDialogKeyDown} placeholder="Commit message" rows={3} spellCheck={false} />
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-[var(--ec-text)]">Merge request / pull request description</span>
            <Textarea value={props.pullRequestDescription} onChange={(event) => props.onPullRequestDescriptionChange(event.target.value)} onKeyDown={props.onPublishDialogKeyDown} placeholder="Merge request / pull request description" className="min-h-36" />
          </label>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button type="button" variant="outline" onClick={props.onGeneratePullRequestDraft} disabled={props.busy || props.pullRequestDraftBusy || !props.pullRequestTargetBranch.trim()}>
            {props.pullRequestDraftBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
            Generate PR content
          </Button>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={props.onClosePublishDialog}>Cancel</Button>
            <Button onClick={props.onSubmitPullRequest} disabled={props.busy || !props.pullRequestTitle.trim() || !props.pullRequestTargetBranch.trim() || (customSource && !props.pullRequestSourceBranchName.trim()) || (options.hasOpenChanges && !props.pullRequestCommitMessage.trim())}>Create MR / PR</Button>
          </div>
        </div>
      </Card>
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
      <DialogOverlay onKeyDown={onBranchPublishDialogKeyDown}>
        <Card className="shadow-[var(--ec-popover-shadow)] w-full max-w-md p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-muted)]">
            {branchPublishMode === "local" ? "Create local branch" : "Publish branch"}
          </p>
          {branchPublishMode === "publish" ? (
            <h3 className="mt-2 text-xl font-semibold">{branchPublishDialogRun.prompt}</h3>
          ) : null}
          <label className="mt-4 block text-sm">
            <span className="mb-1 block text-[var(--ec-text)]">Branch name</span>
            <div className="relative">
              <Input
                className={branchPublishMode === "local" ? "pr-11" : undefined}
                value={branchPublishName}
                onChange={(event) => onBranchPublishNameChange(event.target.value)}
                placeholder="feature/my-custom-branch"
                autoFocus
              />
              {branchPublishMode === "local" ? (
                <button
                  type="button"
                  className="absolute right-1 top-1 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2 text-[var(--ec-muted)] shadow-sm transition hover:border-[var(--ec-accent-ring)] hover:text-[var(--ec-accent-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                  title="Generate branch name with AI"
                  aria-label="Generate branch name with AI"
                  disabled={busy || branchSuggestBusy}
                  onClick={onSuggestBranchName}
                >
                  {branchSuggestBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                </button>
              ) : null}
            </div>
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
          <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-muted)]">Continue run</p>
          <h3 className="mt-2 text-xl font-semibold">{continueDialogRun.prompt}</h3>
          <p className="mt-1 text-sm text-[var(--ec-muted)]">
            {continueDialogRun.workspaceVcs === "folder" ? (
              <>Start a new run in a fresh copied workspace from this run&apos;s current folder state.</>
            ) : (
              <>
                Start a new run from branch <span className="font-medium text-[var(--ec-text)]">{continueDialogRun.branchName}</span> in a fresh worktree.
              </>
            )}
          </p>
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-[var(--ec-text)]">Continuation prompt</span>
              <Textarea
                value={continuePrompt}
                onChange={(event) => onContinuePromptChange(event.target.value)}
                placeholder="Continue from the current state and..."
                className="min-h-28"
                autoFocus
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-[var(--ec-text)]">Model</span>
              <Select
                value={continueModelId}
                onValueChange={onContinueModelIdChange}
                options={continueModelOptions.map((option) => ({ value: option.id, label: option.label }))}
              />
            </label>
            <label className="flex items-center gap-3 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2 text-sm text-[var(--ec-text)]">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border border-[var(--ec-border)] bg-[var(--ec-panel)] accent-[var(--ec-accent)]"
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
        <Card className="w-full max-w-lg !bg-[var(--ec-panel)] p-5 shadow-[var(--ec-popover-shadow)]">
          <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-muted)]">Confirm action</p>
          <h3 className="mt-2 text-xl font-semibold text-[var(--ec-text)]">{confirmDialog.title}</h3>
          <p className="mt-3 text-sm leading-relaxed text-[var(--ec-muted)]">{confirmDialog.message}</p>
          {confirmDialog.impactItems ? (
            <div className="mt-3 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-muted)]">Related data</p>
              <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                {confirmDialog.impactItems.map((item) => (
                  <div key={item.label} className="contents">
                    <dt className="text-[var(--ec-muted)]">{item.label}</dt>
                    <dd className="text-right font-medium tabular-nums text-[var(--ec-text)]">{item.count}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
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
