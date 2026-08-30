import { useEffect, useMemo, useState } from "react";
import type { ChatDetail } from "@buildwarden/shared";
import { deriveLatestRunPlanProgress, findProjectRun, isRunContinuable } from "@buildwarden/renderer/logic";
import {
  Bookmark,
  BookmarkCheck,
  Clock,
  GitCommit,
  GitBranch,
  GitPullRequest,
  MoreHorizontal,
  RotateCcw,
  Trash2,
  Undo2,
  UploadCloud,
} from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { useAction } from "../data/use-action";
import { useRunDetail } from "../data/use-run-detail";
import { modelLabel } from "../data/selectors";
import { compactNumber, errorMessage, runTitle } from "../lib/format";
import type { RunSegment } from "../nav/mobile-router";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { AppBar } from "../components/AppBar";
import { Composer } from "../components/Composer";
import { DiffViewer } from "../components/DiffViewer";
import { RichText } from "../components/RichText";
import { ActionSheet, ConfirmSheet } from "../components/Sheet";
import { RunStatusPill } from "../components/StatusPill";
import { CenteredSpinner, EmptyState, IconButton, InlineError, SegmentedTabs, type SegmentOption } from "../components/primitives";
import { CommitSheet, LocalBranchSheet, PublishBranchSheet, PullRequestSheet } from "./run/RunGitSheets";
import { RunAgentsPanel } from "./run/RunAgentsPanel";
import { RunFilesPanel } from "./run/RunFilesPanel";
import { RunNotesPanel } from "./run/RunNotesPanel";
import { RunUserInputCard } from "./run/RunUserInputCard";
import { RunForgePanel } from "./run/RunForgePanel";
import { mobileForgeColor } from "../lib/forge";

type PendingConfirm = "delete" | "undo" | "cancel" | null;

export const RunDetailScreen = ({ runId, segment }: { runId: string; segment: RunSegment }) => {
  const { client, snapshot, snapshotStore, router } = useMobileApp();
  const store = useRunDetail(client, runId);
  const action = useAction();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const [gitSheet, setGitSheet] = useState<"commit" | "local-branch" | "branch" | "pr" | null>(null);
  const [runChat, setRunChat] = useState<ChatDetail | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const detail = store.detail;
  const entry = useMemo(() => findProjectRun(snapshot.projects, runId), [runId, snapshot.projects]);
  const bookmarked = snapshot.bookmarks.some((bookmark) => bookmark.originalRunId === runId);
  const active = detail ? ["queued", "preparing", "running"].includes(detail.run.status) : false;
  const planProgress = useMemo(() => {
    const progress = detail ? deriveLatestRunPlanProgress(detail.steps, detail.run.mode) : null;
    if (!progress || progress.steps.length === 0) return null;
    return { done: progress.steps.filter((step) => step.status === "completed").length, total: progress.steps.length };
  }, [detail]);
  const hasOrchestration = Boolean(detail?.run.delegationEnabled) || detail?.run.kind === "orchestration-task";

  const segments = useMemo<SegmentOption<RunSegment>[]>(() => {
    const options: SegmentOption<RunSegment>[] = [
      { value: "activity", label: "Activity" },
      { value: "diff", label: "Diff" },
      { value: "files", label: "Files" },
    ];
    if (hasOrchestration && client.capabilities.orchestrationRead) options.push({ value: "agents", label: "Agents" });
    if (detail?.run.forgeRequest) options.push({ value: "pull-request", label: detail.run.forgeRequest.provider === "github" ? "PR" : "MR" });
    options.push({ value: "notes", label: "Notes", ...(detail?.notes.length ? { badge: detail.notes.length } : {}) });
    if (client.capabilities.chatMutations) options.push({ value: "chat", label: "Chat" });
    return options;
  }, [client.capabilities.chatMutations, client.capabilities.orchestrationRead, detail?.notes.length, detail?.run.forgeRequest, hasOrchestration]);

  // A segment can disappear (agents/chat depend on capabilities); fall back rather than blank out.
  const activeSegment = segments.some((option) => option.value === segment) ? segment : "activity";

  useEffect(() => {
    if (activeSegment === "diff" || activeSegment === "files") void store.loadDiff();
    // `loadDiff` is stable per run; re-running on every render would refetch the diff constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSegment, runId]);

  useEffect(() => {
    if (activeSegment !== "chat") return;
    let cancelled = false;
    void client
      .getRunChat(runId)
      .then((next) => {
        if (!cancelled) setRunChat(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setChatError(errorMessage(caught, "Could not load the run chat."));
      });
    return () => {
      cancelled = true;
    };
  }, [activeSegment, client, runId]);

  const refreshAll = async () => {
    await store.reload();
    await snapshotStore.refresh();
  };

  const followUp = async (prompt: string) => {
    await action.run(() => client.followUpRun(runId, prompt), "The follow-up did not send.");
    await refreshAll();
  };

  const sendRunChat = async (prompt: string) => {
    const model = detail?.run.modelId;
    if (!model) return;
    const sent = runChat
      ? await action.ok(() => client.followUpChat(runChat.chat.id, prompt), "The message did not send.")
      : await action.ok(() => client.createRunChat(runId, { modelId: model, prompt }), "Could not start the run chat.");
    if (!sent) return;
    // Reloading the transcript is a read, but it runs from a send handler: without this it would
    // reject out of the handler as an unhandled rejection instead of reaching the user.
    const next = await action.run(() => client.getRunChat(runId), "Could not reload the run chat.");
    if (next !== undefined) setRunChat(next);
  };

  if (store.loading && !detail) {
    return (
      <>
        <AppBar title="Run" onBack={router.back} />
        <CenteredSpinner label="Loading run" />
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <AppBar title="Run" onBack={router.back} />
        {store.error ? <InlineError message={store.error} onRetry={() => void store.reload()} /> : null}
        <EmptyState title="Run unavailable" message="It may have been deleted on the host." />
      </>
    );
  }

  return (
    <>
      <AppBar
        title={runTitle(detail.run)}
        subtitle={`${entry?.project.project.name ?? ""} · ${detail.run.branchName || "no branch"}`}
        onBack={router.back}
        actions={
          <IconButton label="Run actions" onClick={() => setMenuOpen(true)}>
            <MoreHorizontal className="size-5" />
          </IconButton>
        }
      />

      <div className="m-scroll-x flex shrink-0 items-center gap-2 border-b border-[var(--ec-border)] px-4 py-1.5 text-[11px] text-[var(--ec-muted)]">
        <RunStatusPill run={detail.run} />
        <span>{modelLabel(snapshot, detail.run.modelId)}</span>
        <span>{detail.run.mode}</span>
        <span>{compactNumber(detail.run.inputTokens + detail.run.outputTokens)} tok</span>
        {planProgress ? (
          <span className="text-[var(--ec-accent)]">
            {planProgress.done}/{planProgress.total} steps
          </span>
        ) : null}
        {detail.run.forgeRequest ? (
          <button
            type="button"
            className="m-tap inline-flex items-center gap-1.5 rounded-full border border-[var(--ec-border)] px-2.5 text-[11px]"
            onClick={() => router.replace({ name: "run", runId, segment: "pull-request" })}
            style={{ color: mobileForgeColor[detail.run.forgeRequest.readiness] }}
          >
            <GitPullRequest className="size-3.5" />
            {detail.run.forgeRequest.provider === "github" ? "PR" : "MR"} #{detail.run.forgeRequest.number}
            <span className="text-[var(--ec-muted)]">· {detail.run.forgeRequest.checks.completed}/{detail.run.forgeRequest.checks.total}</span>
          </button>
        ) : null}
      </div>

      <SegmentedTabs
        options={segments}
        value={activeSegment}
        onChange={(next) => router.replace({ name: "run", runId, segment: next })}
      />

      {notice ? (
        <button
          type="button"
          onClick={() => setNotice(null)}
          className="m-wrap-anywhere shrink-0 border-b border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] px-4 py-2 text-left text-xs text-[var(--ec-success)]"
        >
          {notice}
        </button>
      ) : null}
      {action.error ? <InlineError message={action.error} /> : null}
      {store.error ? <InlineError message={store.error} onRetry={() => void store.reload()} /> : null}

      {activeSegment === "activity" ? (
        <ActivityTimeline
          detail={detail}
          historyLoading={store.historyLoading}
          onLoadEarlierHistory={store.loadEarlierHistory}
        />
      ) : null}

      {activeSegment === "diff" ? (
        store.diffLoading && !store.diff ? (
          <CenteredSpinner label="Loading diff" />
        ) : store.diffError ? (
          <InlineError message={store.diffError} onRetry={() => void store.loadDiff()} />
        ) : store.diffUnavailable ? (
          <EmptyState title="Workspace unavailable" message="The run worktree no longer exists, so there is nothing to diff." />
        ) : (
          <DiffViewer diff={store.diff} />
        )
      ) : null}

      {activeSegment === "files" ? (
        <RunFilesPanel runId={runId} diff={store.diff} />
      ) : null}

      {activeSegment === "agents" ? <RunAgentsPanel coordinatorRunId={runId} /> : null}

      {activeSegment === "notes" ? <RunNotesPanel detail={detail} onChanged={store.reload} /> : null}

      {activeSegment === "pull-request" && detail.run.forgeRequest ? (
        <RunForgePanel key={detail.run.id} run={detail.run} initialSummary={detail.run.forgeRequest} onChanged={refreshAll} />
      ) : null}

      {activeSegment === "chat" ? (
        <div className="m-scroll flex-1 py-2">
          {chatError ? <InlineError message={chatError} /> : null}
          {runChat ? (
            runChat.steps.map((step) => (
              <div key={step.id} className="px-4 py-1.5">
                <RichText>{step.content || step.title}</RichText>
              </div>
            ))
          ) : (
            <EmptyState title="No run chat yet" message="Ask a question about this run's output and diff." />
          )}
        </div>
      ) : null}

      {activeSegment === "activity" ? <RunUserInputCard detail={detail} onAnswered={refreshAll} /> : null}

      {activeSegment === "activity" || activeSegment === "chat" ? (
        <Composer
          placeholder={activeSegment === "chat" ? "Ask about this run" : active ? "Queue a follow-up" : "Send a follow-up"}
          busy={action.busy}
          disabled={activeSegment === "chat" ? !client.capabilities.chatMutations : !client.capabilities.runMutations}
          disabledReason="This session is read-only."
          onSubmit={activeSegment === "chat" ? sendRunChat : followUp}
          onCancel={activeSegment === "activity" && active ? () => setConfirm("cancel") : undefined}
        />
      ) : null}

      <ActionSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title="Run actions"
        actions={[
          {
            label: bookmarked ? "Remove bookmark" : "Bookmark run",
            icon: bookmarked ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />,
            disabled: !client.capabilities.bookmarkMutations,
            onSelect: () => void action.run(() => (bookmarked ? client.removeBookmark(runId) : client.addBookmark(runId))).then(refreshAll),
          },
          {
            label: detail.run.listVisibility === "for-later" ? "Move back to runs" : "Save for later",
            icon: <Clock className="size-4" />,
            disabled: !client.capabilities.runListVisibilityMutations,
            onSelect: () =>
              void action
                .run(() => client.setRunListVisibility(runId, detail.run.listVisibility === "for-later" ? "default" : "for-later"))
                .then(refreshAll),
          },
          {
            label: "Commit changes",
            icon: <GitCommit className="size-4" />,
            disabled: !client.capabilities.gitMutations,
            onSelect: () => setGitSheet("commit"),
          },
          {
            label: "Create local branch",
            icon: <GitBranch className="size-4" />,
            disabled: !client.capabilities.gitMutations,
            onSelect: () => setGitSheet("local-branch"),
          },
          {
            label: "Publish branch",
            icon: <UploadCloud className="size-4" />,
            disabled: !client.capabilities.gitMutations,
            onSelect: () => setGitSheet("branch"),
          },
          {
            label: "Create pull request",
            icon: <GitPullRequest className="size-4" />,
            disabled: !client.capabilities.gitMutations,
            onSelect: () => setGitSheet("pr"),
          },
          {
            label: "Resume from checkpoint",
            icon: <RotateCcw className="size-4" />,
            hint: detail.latestCheckpoint ? undefined : "No checkpoint stored",
            disabled: !client.capabilities.runMutations || !detail.latestCheckpoint,
            onSelect: () => void action.run(() => client.resumeRunFromCheckpoint(runId)).then(refreshAll),
          },
          {
            label: "Undo to last prompt",
            icon: <Undo2 className="size-4" />,
            disabled: !client.capabilities.runMutations || !isRunContinuable(detail.run),
            onSelect: () => setConfirm("undo"),
          },
          {
            label: "Delete run",
            icon: <Trash2 className="size-4" />,
            danger: true,
            disabled: !client.capabilities.runMutations,
            onSelect: () => setConfirm("delete"),
          },
        ]}
      />

      <ConfirmSheet
        open={confirm === "cancel"}
        title="Cancel run"
        message="The agent stops after the current step. Work already written to the worktree is kept."
        confirmLabel="Cancel run"
        danger
        busy={action.busy}
        onClose={() => setConfirm(null)}
        onConfirm={() => void action.run(() => client.cancelRun(runId)).then(refreshAll).finally(() => setConfirm(null))}
      />

      <ConfirmSheet
        open={confirm === "undo"}
        title="Undo to last prompt"
        message="Rewinds the run to just before your last prompt. Steps after it are discarded."
        confirmLabel="Undo"
        danger
        busy={action.busy}
        onClose={() => setConfirm(null)}
        onConfirm={() => void action.run(() => client.undoRunToLastPrompt(runId)).then(refreshAll).finally(() => setConfirm(null))}
      />

      <ConfirmSheet
        open={confirm === "delete"}
        title="Delete run"
        message="Removes the run, its history and its BuildWarden worktree. Your repository is not touched."
        confirmLabel="Delete"
        danger
        busy={action.busy}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          void action
            .ok(() => client.deleteRun(runId), "Could not delete the run.")
            .then(async (deleted) => {
              if (!deleted) return;
              setConfirm(null);
              await snapshotStore.refresh();
              router.back();
            });
        }}
      />

      <CommitSheet runId={runId} open={gitSheet === "commit"} onClose={() => setGitSheet(null)} onDone={refreshAll} />

      <LocalBranchSheet
        runId={runId}
        defaultName={detail.run.branchName}
        open={gitSheet === "local-branch"}
        onClose={() => setGitSheet(null)}
        onDone={async (branchName) => {
          setNotice(`Created local branch ${branchName}.`);
          await refreshAll();
        }}
      />

      <PublishBranchSheet
        runId={runId}
        defaultName={detail.run.branchName}
        open={gitSheet === "branch"}
        onClose={() => setGitSheet(null)}
        onDone={async (branch) => {
          setNotice(`Pushed ${branch} to origin.`);
          await refreshAll();
        }}
      />

      <PullRequestSheet
        runId={runId}
        open={gitSheet === "pr"}
        onClose={() => setGitSheet(null)}
        onDone={async (url) => {
          setNotice(`Pull request created: ${url}`);
          await refreshAll();
        }}
      />
    </>
  );
};
