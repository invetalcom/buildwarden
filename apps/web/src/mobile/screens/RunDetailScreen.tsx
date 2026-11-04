import { describeFollowUpQueueNotice, FollowUpQueuePanel, useComposerDraft, RunVerificationPanel, RunEmbeddedBrowser, RunBrowserPreviewTile, BrowserElementAttachmentPreview, browserElementPayloadsForProvider, validateBrowserElementCaptureAddition } from "@buildwarden/renderer";
import { useEffect, useMemo, useState } from "react";
import {
  councilHasCurrentResults,
  validateChatAttachmentPayloads,
  type ChatAttachmentPayload,
  type ChatDetail,
  type FollowUpDelivery,
  type FollowUpQueueAction,
  type FollowUpQueueResult,
  type RunBrowserElementCapture,
} from "@buildwarden/shared";
import { deriveLatestRunPlanProgress, findProjectRun, hasCouncilSurface, isVisibleChatStep, isRunContinuable, useCouncilRounds } from "@buildwarden/renderer/logic";
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
import { useChatDetail } from "../data/use-chat-detail";
import { useRunDetail } from "../data/use-run-detail";
import { useFollowUpDelivery } from "../data/use-follow-up-delivery";
import { modelLabel } from "../data/selectors";
import { compactNumber, errorMessage, runTitle } from "../lib/format";
import type { RunSegment } from "../nav/mobile-router";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { AppBar } from "../components/AppBar";
import { Composer } from "../components/Composer";
import { MobileChatStep } from "../components/ChatTranscriptStep";
import { ChatWorkingIndicator } from "@buildwarden/renderer/response-content";
import { parseStepMetadata } from "../lib/chat-steps";
import { DiffViewer } from "../components/DiffViewer";
import { ActionSheet, ConfirmSheet } from "../components/Sheet";
import { RunStatusPill } from "../components/StatusPill";
import { CenteredSpinner, EmptyState, IconButton, InlineError, SegmentedTabs, type SegmentOption } from "../components/primitives";
import { CommitSheet, LocalBranchSheet, PublishBranchSheet, PullRequestSheet } from "./run/RunGitSheets";
import { RunAgentsPanel } from "./run/RunAgentsPanel";
import { RunFilesPanel } from "./run/RunFilesPanel";
import { RunNotesPanel } from "./run/RunNotesPanel";
import { RunUserInputCard } from "./run/RunUserInputCard";
import { RunValidationBar, RunValidationPanel } from "./run/RunValidationPanel";
import { RunForgePanel } from "./run/RunForgePanel";
import { mobileForgeColor } from "../lib/forge";

type PendingConfirm = "delete" | "undo" | "cancel" | null;
const EMPTY_BROWSER_SESSION = { draftUrl: "about:blank", currentUrl: "about:blank", history: ["about:blank"], historyIndex: 0, reloadKey: 0 };

export const RunDetailScreen = ({ runId, segment }: { runId: string; segment: RunSegment }) => {
  const { client, snapshot, snapshotStore, router } = useMobileApp();
  const store = useRunDetail(client, runId);
  const council = useCouncilRounds(client, runId, undefined);
  const action = useAction();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const [gitSheet, setGitSheet] = useState<"commit" | "local-branch" | "branch" | "pr" | null>(null);
  const [runChat, setRunChat] = useState<ChatDetail | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [browserSession, setBrowserSession] = useState({ runId, session: EMPTY_BROWSER_SESSION });

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
  const councilAvailable = client.capabilities.runMutations && detail?.councilAvailable === true;
  const councilVisible = detail
    ? hasCouncilSurface({ run: detail.run, councilRounds: council.rounds, councilAvailable: detail.councilAvailable }, client.capabilities.runMutations)
    : false;
  const councilFindings = council.latest && councilHasCurrentResults(council.latest) ? council.latest.groups.length : 0;

  const segments = useMemo<SegmentOption<RunSegment>[]>(() => {
    const options: SegmentOption<RunSegment>[] = [
      { value: "activity", label: "Activity" },
      { value: "diff", label: "Diff" },
      { value: "files", label: "Files" },
    ];
    if (client.capabilities.browserControl && segment === "browser") options.splice(1, 0, { value: "browser", label: "Browser" });
    if (councilVisible) options.push({ value: "validation", label: "Validation", ...(councilFindings ? { badge: councilFindings } : {}) });
    if (hasOrchestration && client.capabilities.orchestrationRead) options.push({ value: "agents", label: "Agents" });
    if (detail?.run.forgeRequest) options.push({ value: "pull-request", label: detail.run.forgeRequest.provider === "github" ? "PR" : "MR" });
    options.push({ value: "notes", label: "Notes", ...(detail?.notes.length ? { badge: detail.notes.length } : {}) });
    if (client.capabilities.chatMutations) options.push({ value: "chat", label: "Chat" });
    return options;
  }, [client.capabilities.browserControl, client.capabilities.chatMutations, client.capabilities.orchestrationRead, councilFindings, councilVisible, detail?.notes.length, detail?.run.forgeRequest, hasOrchestration, segment]);

  // A segment can disappear (agents/chat depend on capabilities); fall back rather than blank out.
  const activeSegment = segments.some((option) => option.value === segment) ? segment : "activity";
  // Browser selections edit the run draft too; unrelated segments must not own it.
  const draft = useComposerDraft("run", runId, { active: client.capabilities.runMutations && (activeSegment === "activity" || activeSegment === "browser") });
  const { captures, setCaptures: setBrowserCaptures } = draft;
  const matchingRunChat = runChat?.chat.runId === runId ? runChat : null;
  const chatDraft = useComposerDraft("run-chat", runId, { active: activeSegment === "chat" });
  const runChatStore = useChatDetail(client, activeSegment === "chat" ? matchingRunChat?.chat.id ?? null : null);

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
        if (!cancelled) {
          setRunChat(next);
          setChatError(null);
        }
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

  const matchingLiveRunChat = runChatStore.detail?.chat.runId === runId ? runChatStore.detail : null;
  const visibleRunChat = matchingLiveRunChat ?? matchingRunChat;
  const runChatActive = visibleRunChat ? ["queued", "preparing", "running"].includes(visibleRunChat.chat.status) : false;
  const providerTypeFor = (providerAccountId: string | undefined) =>
    snapshot.providerAccounts.find((account) => account.id === providerAccountId)?.providerType;
  const runQueue = detail?.queuedFollowUps ?? [];
  const runChatQueue = visibleRunChat?.queuedFollowUps ?? [];
  const runDelivery = useFollowUpDelivery({ active, queueLength: runQueue.length, providerType: providerTypeFor(detail?.run.providerAccountId) });
  const runChatDelivery = useFollowUpDelivery({
    active: runChatActive,
    queueLength: runChatQueue.length,
    providerType: providerTypeFor(visibleRunChat?.chat.providerAccountId),
  });
  useEffect(() => setQueueNotice(null), [activeSegment]);

  const followUp = async (prompt: string, attachments: ChatAttachmentPayload[], requested?: FollowUpDelivery) => {
    const provider = snapshot.providerAccounts.find((account) => account.id === detail?.run.providerAccountId)?.providerType;
    const combined = [...attachments, ...browserElementPayloadsForProvider(captures, provider)];
    validateChatAttachmentPayloads(combined);
    const options = combined.length ? { attachments: combined } : undefined;
    if (runDelivery.queues) {
      setQueueNotice(describeFollowUpQueueNotice(await client.queueRunFollowUp(runId, prompt, options, requested ?? runDelivery.primary)));
    } else {
      await client.followUpRun(runId, prompt, options);
    }
    if (captures.length) await client.runBrowserAction({ runId, action: "clear-annotations" })
      .then(() => client.runBrowserAction({ runId, action: "release-control" })).catch(() => undefined);
    await action.run(refreshAll, "The follow-up was sent, but the run could not be refreshed.");
  };

  const removeAnnotation = (capture: RunBrowserElementCapture) => {
    void client.runBrowserAction({ runId, action: "remove-annotation", captureId: capture.id }).catch(() => undefined);
  };
  const removeCapture = (capture: RunBrowserElementCapture) => {
    if (action.busy || draft.loading || draft.readOnly || draft.submitting) return;
    setBrowserCaptures((current) => current.filter((item) => item.id !== capture.id));
    removeAnnotation(capture);
  };

  const sendRunChat = async (prompt: string, attachments: ChatAttachmentPayload[], requested?: FollowUpDelivery) => {
    const model = detail?.run.modelId;
    if (!model) throw new Error("The run model is unavailable.");
    const options = attachments.length ? { attachments } : undefined;
    if (visibleRunChat && runChatDelivery.queues) {
      setQueueNotice(describeFollowUpQueueNotice(
        await client.queueChatFollowUp(visibleRunChat.chat.id, prompt, options, requested ?? runChatDelivery.primary),
      ));
    } else if (matchingRunChat) await client.followUpChat(matchingRunChat.chat.id, prompt, options);
    else await client.createRunChat(runId, { modelId: model, prompt, ...(attachments.length ? { attachments } : {}) });
    // Reloading the transcript is a read, but it runs from a send handler: without this it would
    // reject out of the handler as an unhandled rejection instead of reaching the user.
    const next = await action.run(() => client.getRunChat(runId), "Could not reload the run chat.");
    if (next !== undefined) setRunChat(next);
  };

  const updateQueue = async (update: () => Promise<FollowUpQueueResult>, reload: () => Promise<unknown>) => {
    try {
      setQueueNotice(describeFollowUpQueueNotice(await update()));
    } catch (caught) {
      setQueueNotice(errorMessage(caught, "Could not update the queue."));
      throw caught;
    }
    await action.run(reload, "The queue changed, but the view could not be refreshed.");
  };
  const updateRunQueue = (queueAction: FollowUpQueueAction) =>
    updateQueue(() => client.updateRunFollowUpQueue(runId, queueAction), refreshAll);
  const updateRunChatQueue = (queueAction: FollowUpQueueAction) => {
    const chatId = visibleRunChat?.chat.id;
    if (!chatId) return Promise.resolve();
    return updateQueue(() => client.updateChatFollowUpQueue(chatId, queueAction), runChatStore.reload);
  };
  const composerQueue = activeSegment === "chat" ? runChatQueue : runQueue;

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

      {activeSegment === "browser" ? <RunEmbeddedBrowser key={runId} runId={runId} session={browserSession.runId === runId ? browserSession.session : EMPTY_BROWSER_SESSION}
        onSessionChange={(session) => setBrowserSession({ runId, session })} className="min-h-0" nextAnnotationNumber={captures.reduce((max, capture) => Math.max(max, capture.annotationNumber), 0) + 1}
        onElementSelected={(capture) => {
          if (draft.loading || draft.readOnly || draft.submitting) { setNotice(draft.readOnly ? "This draft is read-only. Open it in the window that owns it before selecting an element." : draft.submitting ? "Wait for the current submission to finish." : "Wait for draft attachments to finish restoring."); removeAnnotation(capture); return; }
          if (captures.some((item) => item.id === capture.id)) return;
          const error = validateBrowserElementCaptureAddition([], captures, capture);
          if (error) { setNotice(error); removeAnnotation(capture); return; }
          setBrowserCaptures((current) => [...current.filter((item) => item.runId === runId), capture]);
        }} /> : null}
      {activeSegment === "browser" && captures.length > 0 ? <div className="flex shrink-0 items-center gap-2 border-t border-[var(--ec-border)] px-3 py-2">
        <span className="text-xs text-[var(--ec-muted)]">{captures.length} element{captures.length === 1 ? "" : "s"} selected</span>
        <button type="button" className="m-tap ml-auto text-xs text-[var(--ec-accent)]" onClick={() => router.replace({ name: "run", runId, segment: "activity" })}>Use in follow-up</button>
      </div> : null}

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

      {activeSegment === "validation" ? <RunValidationPanel run={detail.run} council={council} available={councilAvailable} /> : null}

      {activeSegment === "agents" ? <RunAgentsPanel coordinatorRunId={runId} /> : null}

      {activeSegment === "notes" ? <RunNotesPanel detail={detail} onChanged={store.reload} /> : null}

      {activeSegment === "diff" && <RunVerificationPanel key={runId} client={client} run={detail.run} displayedRevision={store.diffRevision} />}
      {activeSegment === "pull-request" && detail.run.forgeRequest ? (
        <RunForgePanel key={detail.run.id} run={detail.run} initialSummary={detail.run.forgeRequest} onChanged={refreshAll} />
      ) : null}

      {activeSegment === "chat" ? (
        <div className="m-scroll flex-1 py-2">
          {chatError ? <InlineError message={chatError} /> : null}
          {runChatStore.error ? <InlineError message={runChatStore.error} onRetry={() => void runChatStore.reload()} /> : null}
          {visibleRunChat ? (
            visibleRunChat.steps
              .filter((step) => isVisibleChatStep(step, parseStepMetadata(step.metadataJson)))
              .map((step) => <MobileChatStep key={step.id} step={step} active={["queued", "preparing", "running"].includes(visibleRunChat.chat.status)} />)
          ) : (
            <EmptyState title="No run chat yet" message="Ask a question about this run's output and diff." />
          )}
          {visibleRunChat && ["queued", "preparing", "running"].includes(visibleRunChat.chat.status) ? <ChatWorkingIndicator /> : null}
        </div>
      ) : null}

      {activeSegment === "activity" ? <RunUserInputCard detail={detail} onAnswered={refreshAll} /> : null}

      {activeSegment === "activity" ? <RunBrowserPreviewTile key={runId} runId={runId} active={detail.run.status === "running"}
        onOpen={() => router.replace({ name: "run", runId, segment: "browser" })} /> : null}

      {activeSegment === "activity" && councilVisible && !active ? (
        <RunValidationBar run={detail.run} council={council} available={councilAvailable} onOpen={() => router.replace({ name: "run", runId, segment: "validation" })} />
      ) : null}

      {(activeSegment === "activity" || activeSegment === "chat") && (composerQueue.length > 0 || queueNotice) ? (
        <div className="shrink-0 px-2 pt-1">
          <FollowUpQueuePanel
            touch
            queue={composerQueue}
            active={activeSegment === "chat" ? runChatActive : active}
            steeringAvailable={activeSegment === "chat" ? runChatDelivery.steeringAvailable : runDelivery.steeringAvailable}
            readOnly={activeSegment === "chat" ? !client.capabilities.chatMutations : !client.capabilities.runMutations}
            busy={action.busy}
            notice={queueNotice}
            onDismissNotice={() => setQueueNotice(null)}
            onAction={activeSegment === "chat" ? updateRunChatQueue : updateRunQueue}
          />
        </div>
      ) : null}

      {activeSegment === "activity" || activeSegment === "chat" ? (
        <Composer
          key={`${runId}:${activeSegment}`}
          draft={activeSegment === "chat" ? chatDraft : draft}
          hasExternalAttachments={activeSegment === "activity" && captures.length > 0}
          accessory={activeSegment === "activity" ? captures.map((capture) => <BrowserElementAttachmentPreview key={capture.id} capture={capture} disabled={action.busy || draft.loading || draft.readOnly || draft.submitting} onRemove={() => removeCapture(capture)} />) : undefined}
          placeholder={activeSegment === "chat" ? (runChatActive ? "Queue a question" : "Ask about this run") : active ? "Queue a follow-up" : "Send a follow-up"}
          activeDelivery={activeSegment === "chat" ? runChatDelivery.activeDelivery : runDelivery.activeDelivery}
          busy={action.busy}
          disabled={activeSegment === "chat" ? !client.capabilities.chatMutations : !client.capabilities.runMutations}
          disabledReason="This session is read-only."
          onSubmit={activeSegment === "chat" ? sendRunChat : followUp}
          onCancel={activeSegment === "activity"
            ? active ? () => setConfirm("cancel") : undefined
            : runChatActive && visibleRunChat
              ? () => void action.run(() => client.cancelChat(visibleRunChat.chat.id), "Could not stop the chat.")
              : undefined}
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
            label: "Check PR/MR status",
            icon: <GitPullRequest className="size-4" />,
            disabled: !client.capabilities.prReview || detail.run.workspaceVcs !== "git",
            onSelect: () => void action.run(() => client.refreshRunForgeRequest(runId)).then(refreshAll),
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
