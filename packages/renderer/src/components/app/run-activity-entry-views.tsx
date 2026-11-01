import type { ReactNode } from "react";
import {
  extractAttachmentNamesFromMetadata,
  getResponseSourceText,
  extractAttachmentPayloadsFromMetadata,
  readModelHandoffMetadata,
  type RunEventType,
  type RunMode,
  type RunUserInputAnswers,
} from "@buildwarden/shared";
import { Check, ChevronDown, ChevronRight, Copy, MessageSquareText, RotateCcw, ShieldCheck, Terminal, X } from "lucide-react";
import { ActivityMarkdownOrGitDiff } from "./activity-message-body";
import { AgentLogRow, AgentPanel } from "./agent-worklog";
import { ModelHandoffDivider } from "./ModelHandoffDivider";
import { RunPlanSteps } from "./RunPlanSteps";
import { RunUserInputRequestCard } from "./RunUserInputRequestCard";
import { StoredChatAttachments } from "./StoredChatAttachments";
import { getStoredAttachmentMessageContent } from "./stored-chat-attachment-utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";
import {
  describeActivityDetail,
  isRunCancellationStep,
  isRunCompletionStatus,
  readUserInputAnswers,
  readUserInputQuestions,
  resolveRunStatusStepPresentation,
  runModeBadgeClassName,
  shouldAutoCollapseReasoning,
  type ActivityEntry,
  type RunActivityRun,
  type RunActivityStep,
} from "./run-activity-model";
import { APPROVAL_DECISION_LABELS, firstMetadataString } from "./run-activity-tool-model";
export type ActivityRenderContext = {
  run: RunActivityRun;
  runDurationLabel: string | null;
  rowTime: (time: string | null | undefined) => string | null | undefined;
  readOnly: boolean;
  restorablePromptStepId: string | null;
  onUndoRunToLastPrompt?: (run: RunActivityRun) => void;
  activeCopiedStepId: string | null;
  copyStepContent: (text: string, stepId: string) => Promise<void>;
  busy: boolean;
  isRunActive: boolean;
  compactContent: boolean;
  onOpenWorkspaceFile?: (path: string) => void;
  onPreparePlanContinuation?: (plan: string) => void;
  onSubmitUserInputAnswers?: (run: RunActivityRun, requestId: string, answers: RunUserInputAnswers) => Promise<void> | void;
  activeReasoningStepIds: Record<string, boolean>;
  toggleReasoningStep: (stepId: string) => void;
  /** Entries holding a turn's final answer; other assistant messages render as narration. */
  finalAnswerEntries: ReadonlySet<ActivityEntry>;
};

const CopyIcon = ({ copied }: Readonly<{ copied: boolean }>) =>
  copied ? <Check className="h-3.5 w-3.5 text-[var(--ec-success)]" /> : <Copy className="h-3.5 w-3.5" />;

const hoverActionClassName =
  "h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]";

// A user prompt opens a turn: a tinted band with an accent edge, the only
// filled surface in the timeline, so prompts are recognisable at a glance.
const PromptMessage = ({
  step,
  metadata,
  context,
}: Readonly<{ step: RunActivityStep; metadata: Record<string, unknown>; context: ActivityRenderContext }>) => {
  const { run, readOnly, restorablePromptStepId, onUndoRunToLastPrompt, activeCopiedStepId, copyStepContent, busy, isRunActive, compactContent, onOpenWorkspaceFile } = context;
  const mode = (metadata.mode as RunMode) ?? run.mode;
  const att = extractAttachmentNamesFromMetadata(metadata);
  const attachments = extractAttachmentPayloadsFromMetadata(metadata);
  const promptContent = getStoredAttachmentMessageContent(step.content, att);
  const canUndoPrompt = !readOnly && step.id === restorablePromptStepId && Boolean(onUndoRunToLastPrompt);
  return (
    <div className="agent-prompt">
      <div className="agent-prompt-body">
        {promptContent ? <ActivityMarkdownOrGitDiff content={promptContent} compact={compactContent} onOpenWorkspaceFile={onOpenWorkspaceFile} /> : null}
        <StoredChatAttachments attachments={attachments} fallbackNames={att} compact={compactContent} />
      </div>
      <div className="agent-prompt-meta">
        <div className="agent-prompt-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={hoverActionClassName}
            onClick={() => void copyStepContent(step.content, step.id)}
            title={activeCopiedStepId === step.id ? "Copied" : "Copy prompt"}
            aria-label="Copy prompt"
          >
            <CopyIcon copied={activeCopiedStepId === step.id} />
          </Button>
          {canUndoPrompt ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={hoverActionClassName}
              title="Undo changes since this prompt"
              aria-label="Undo changes since this prompt"
              onClick={() => onUndoRunToLastPrompt?.(run)}
              disabled={busy || isRunActive}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        {metadata.commandType === "follow-up" ? <span className="agent-prompt-kind">follow-up</span> : null}
        <span className={cn("agent-prompt-mode", runModeBadgeClassName(mode))}>{mode}</span>
        <span className="agent-density-meta tabular-nums">{new Date(step.createdAt).toLocaleTimeString()}</span>
      </div>
    </div>
  );
};

const AnswerCopyButton = ({ text, copyId, context }: Readonly<{ text: string; copyId: string; context: ActivityRenderContext }>) => (
  <Button
    type="button"
    variant="ghost"
    size="sm"
    className={cn("agent-answer-copy absolute bottom-0 right-0 z-10", hoverActionClassName)}
    onClick={() => void context.copyStepContent(text, copyId)}
    title={context.activeCopiedStepId === copyId ? "Copied" : "Copy response"}
    aria-label="Copy response"
  >
    <CopyIcon copied={context.activeCopiedStepId === copyId} />
  </Button>
);

const answerRowClassName = (final: boolean) => (final ? "agent-log-row--final" : "agent-log-row--narration");

const StatusLine = ({
  title,
  content,
  time,
}: Readonly<{ title: string; content?: string; time?: string | null }>) => (
  <div className="agent-status-line">
    <span className="min-w-0 flex-1 truncate" title={content || undefined}>
      <span className="agent-status-line-title">{title}</span>
      {content ? <span> · {content.replace(/\s*\n\s*/g, " · ")}</span> : null}
    </span>
    {time ? <span className="agent-density-meta shrink-0 tabular-nums">{time}</span> : null}
  </div>
);

const TOKEN_LINE_PATTERN = /^(input|output)\s+tokens:/i;
const BOILERPLATE_END_LINE_PATTERN = /^(run completed successfully|run cancelled( by user)?|cancellation requested)\.?$/i;

// Completion or cancellation closes a turn with a hairline divider carrying the duration.
const TurnEndDivider = ({
  title,
  content,
  durationLabel,
  cancelled = false,
}: Readonly<{ title: string; content: string; durationLabel: string | null; cancelled?: boolean }>) => {
  const detailLines = content
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((line) => line && !TOKEN_LINE_PATTERN.test(line) && !BOILERPLATE_END_LINE_PATTERN.test(line));
  const Icon = cancelled ? X : Check;
  return (
    <div className={cn("agent-turn-end", cancelled && "agent-turn-end--cancelled")} role="separator" aria-label={title}>
      <span className="agent-turn-end-label">
        <Icon className={cn("h-3 w-3 shrink-0", cancelled ? "text-[color:var(--ec-danger)]" : "text-[color:var(--ec-success)]")} aria-hidden />
        <span className="agent-turn-end-title">{title}</span>
        {detailLines.length > 0 ? <span className="truncate">{detailLines.join(" ")}</span> : null}
        {durationLabel ? <span className="agent-turn-end-fact">{durationLabel}</span> : null}
      </span>
    </div>
  );
};

export const SingleGroupActivityEntry = ({
  entry,
  context,
}: Readonly<{ entry: Extract<ActivityEntry, { kind: "single-group" }>; context: ActivityRenderContext }>) => {
  const { run, rowTime, compactContent, onOpenWorkspaceFile } = context;
  const first = entry.items[0]!;
  const last = entry.items[entry.items.length - 1]!;
  const t0 = new Date(first.step.createdAt).toLocaleTimeString();
  const t1 = new Date(last.step.createdAt).toLocaleTimeString();
  const timeRange = entry.items.length > 1 && t0 !== t1 ? `${t0}-${t1}` : t0;
  const groupKey = `sg-${first.step.id}-${entry.groupKey}-${entry.items.length}`;

  if (entry.groupKey === "status") {
    return (
      <AgentLogRow key={groupKey} tone="status" label="Status" time={rowTime(timeRange)}>
        <div className="agent-status-list">
          {entry.items.map(({ step }) => {
            const presentation = resolveRunStatusStepPresentation(step, run.orchestrationStatus);
            return (
              <StatusLine key={step.id} title={presentation.title} content={presentation.content} time={new Date(step.createdAt).toLocaleTimeString()} />
            );
          })}
        </div>
      </AgentLogRow>
    );
  }

  if (entry.groupKey === "user") {
    return (
      <AgentLogRow key={groupKey} tone="prompt" label="Prompt" time={rowTime(timeRange)}>
        <div className="space-y-1.5">
          {entry.items.map(({ step, metadata }) => (
            <PromptMessage key={step.id} step={step} metadata={metadata} context={context} />
          ))}
        </div>
      </AgentLogRow>
    );
  }

  const combinedAnswerText = entry.items.map(({ step, metadata }) => getResponseSourceText(step, metadata)).join("\n\n");
  const final = context.finalAnswerEntries.has(entry);

  return (
    <AgentLogRow key={groupKey} tone="answer" label={final ? "Answer" : "Update"} time={rowTime(timeRange)} className={answerRowClassName(final)}>
      <div className="agent-panel agent-panel--answer relative space-y-1.5">
        <AnswerCopyButton text={combinedAnswerText} copyId={groupKey} context={context} />
        {entry.items.map(({ step, metadata }) => {
          const detail = describeActivityDetail(metadata);
          const itemMode = (metadata.mode as RunMode) ?? run.mode;
          const shouldShowPlanSteps = itemMode === "plan" && metadata.assistantKind !== "reasoning";
          return (
            <div key={step.id}>
              {detail && detail !== step.title ? (
                <p className="agent-density-detail mb-1 truncate text-[10px] text-[var(--ec-muted)]">{String(detail)}</p>
              ) : null}
              {shouldShowPlanSteps ? <RunPlanSteps content={step.content} /> : null}
              <ActivityMarkdownOrGitDiff content={step.content} compact={compactContent} className="agent-response-text" onOpenWorkspaceFile={onOpenWorkspaceFile} />
            </div>
          );
        })}
      </div>
    </AgentLogRow>
  );
}

const renderUserActivityEntry = (entry: Extract<ActivityEntry, { kind: "single" }>, context: ActivityRenderContext): ReactNode => (
  <AgentLogRow key={entry.step.id} tone="prompt" label="Prompt" time={context.rowTime(new Date(entry.step.createdAt).toLocaleTimeString())}>
    <PromptMessage step={entry.step} metadata={entry.metadata} context={context} />
  </AgentLogRow>
);

type UserInputRequest = {
  requestId: string;
  questions: ReturnType<typeof readUserInputQuestions>;
};

const readUserInputRequest = (
  entry: Extract<ActivityEntry, { kind: "single" }>,
  context: ActivityRenderContext,
  requestKind: string,
): UserInputRequest | null => {
  if (context.readOnly || requestKind !== "user-input") return null;
  const requestId = firstMetadataString(entry.metadata.userInputRequestId, entry.metadata.requestId);
  const questions = readUserInputQuestions(entry.metadata);
  return requestId && questions.length > 0 ? { requestId, questions } : null;
};

const UserInputRequestActivityEntry = ({
  entry,
  context,
  request,
  resolved,
}: Readonly<{
  entry: Extract<ActivityEntry, { kind: "single" }>;
  context: ActivityRenderContext;
  request: UserInputRequest;
  resolved: boolean;
}>) => (
  <RunUserInputRequestCard
    runId={context.run.id}
    requestId={request.requestId}
    title={entry.step.title}
    content={entry.step.content}
    timestamp={new Date(entry.step.createdAt).toLocaleTimeString()}
    questions={request.questions}
    answers={readUserInputAnswers(entry.metadata)}
    resolved={resolved}
    disabled={context.busy || !context.isRunActive}
    onSubmitAnswers={context.onSubmitUserInputAnswers ? (answers) => context.onSubmitUserInputAnswers?.(context.run, request.requestId, answers) : undefined}
  />
);

const GenericRequestActivityEntry = ({
  entry,
  context,
  requestKind,
  resolved,
}: Readonly<{
  entry: Extract<ActivityEntry, { kind: "single" }>;
  context: ActivityRenderContext;
  requestKind: string;
  resolved: boolean;
}>) => {
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  const approvalDecision =
    typeof entry.metadata.shellApprovalDecision === "string" ? entry.metadata.shellApprovalDecision : null;
  const approvalMessage =
    typeof entry.metadata.approvalResolutionMessage === "string" ? entry.metadata.approvalResolutionMessage : null;
  const isShellApproval = requestKind === "approval" && typeof entry.metadata.approvalRequestId === "string";
  const decisionLabel = approvalDecision ? APPROVAL_DECISION_LABELS[approvalDecision] ?? null : null;
  const requestIconClass = resolved
    ? "h-3.5 w-3.5 shrink-0 text-[color:var(--ec-faint)]"
    : "h-3.5 w-3.5 shrink-0 text-[color:var(--ec-info)]";
  return (
    <AgentPanel key={entry.step.id} tone="request" className="px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {isShellApproval ? <Terminal className={requestIconClass} /> : <MessageSquareText className={requestIconClass} />}
          <p className="truncate text-[11px] font-medium text-[color:var(--ec-text)]">{entry.step.title}</p>
          <Badge tone="queued" className="px-1.5 py-0 text-[10px] bg-[color:var(--ec-info-soft)] text-[color:var(--ec-info)] ring-[color:var(--ec-info-ring)]">
            {requestKind}
          </Badge>
          {decisionLabel ? (
            <Badge tone={approvalDecision === "deny" ? "failed" : "completed"} className="px-1.5 py-0 text-[10px]">
              {decisionLabel}
            </Badge>
          ) : null}
        </div>
        <span className="agent-density-meta shrink-0 text-[10px] text-[color:var(--ec-faint)]">{timestamp}</span>
      </div>
      {isShellApproval ? (
        <>
          <pre className="agent-pre app-scrollbar mt-1.5 max-h-28 overflow-auto text-[11px] leading-relaxed">
            {entry.step.content}
          </pre>
          {!resolved ? (
            <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-[color:var(--ec-muted)]">
              <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--ec-info)]" />
              <span>{approvalMessage ?? "Waiting for a shell approval decision."}</span>
            </div>
          ) : null}
        </>
      ) : (
        <ActivityMarkdownOrGitDiff content={entry.step.content} compact={context.compactContent} className="mt-1.5 text-[color:var(--ec-text)]" onOpenWorkspaceFile={context.onOpenWorkspaceFile} />
      )}
    </AgentPanel>
  );
};

const renderRequestActivityEntry = (entry: Extract<ActivityEntry, { kind: "single" }>, context: ActivityRenderContext): ReactNode => {
  const fallbackRequestKind = entry.step.eventType.startsWith("approval") ? "approval" : "user-input";
  const requestKind = firstMetadataString(entry.metadata.requestKind) ?? fallbackRequestKind;
  const resolved = entry.step.eventType === "approval-resolved" || entry.metadata.requestStatus === "resolved";
  const userInputRequest = readUserInputRequest(entry, context, requestKind);
  return (
    <AgentLogRow tone="request" label="Request" time={context.rowTime(new Date(entry.step.createdAt).toLocaleTimeString())}>
      {userInputRequest
        ? <UserInputRequestActivityEntry entry={entry} context={context} request={userInputRequest} resolved={resolved} />
        : <GenericRequestActivityEntry entry={entry} context={context} requestKind={requestKind} resolved={resolved} />}
    </AgentLogRow>
  );
}

type SingleEntryProps = Readonly<{
  entry: Extract<ActivityEntry, { kind: "single" }>;
  context: ActivityRenderContext;
}>;

const PlanActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const canContinue = !context.readOnly && Boolean(context.onPreparePlanContinuation);
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  return (
    <AgentLogRow tone="plan" label="Plan" time={context.rowTime(timestamp)}>
      <AgentPanel tone="plan" className="px-2.5 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[color:var(--ec-success)]" />
            <p className="truncate text-[11px] font-medium text-[color:var(--ec-text)]">{entry.step.title}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {canContinue ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 rounded-md px-2 text-[10px] text-[color:var(--ec-success)] hover:bg-[color:var(--ec-success-soft)] hover:text-[color:var(--ec-success)]"
                disabled={context.busy || context.isRunActive}
                onClick={() => context.onPreparePlanContinuation?.(entry.step.content)}
              >
                Continue in code mode
              </Button>
            ) : null}
            <span className="agent-density-meta shrink-0 text-[10px] text-[color:var(--ec-faint)]">{timestamp}</span>
          </div>
        </div>
        <RunPlanSteps content={entry.step.content} />
        <ActivityMarkdownOrGitDiff content={entry.step.content} compact={context.compactContent} className="mt-1.5 text-[color:var(--ec-text)]" onOpenWorkspaceFile={context.onOpenWorkspaceFile} />
      </AgentPanel>
    </AgentLogRow>
  );
};

const DiffActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  return (
    <AgentLogRow tone="diff" label="Diff" time={context.rowTime(timestamp)}>
      <div className="agent-status-line">
        <span className="agent-status-line-title truncate">{entry.step.title}</span>
      </div>
      {entry.step.content.trim() ? (
        <ActivityMarkdownOrGitDiff content={entry.step.content} compact={context.compactContent} className="mt-1 text-[color:var(--ec-text)]" onOpenWorkspaceFile={context.onOpenWorkspaceFile} />
      ) : null}
    </AgentLogRow>
  );
};

const StatusActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  const presentation = resolveRunStatusStepPresentation(entry.step, context.run.orchestrationStatus);
  const modelHandoff = readModelHandoffMetadata(entry.metadata);
  if (modelHandoff) {
    return (
      <AgentLogRow tone="status" label="Model" time={context.rowTime(timestamp)} className="agent-log-row--turn-end">
        <ModelHandoffDivider handoff={modelHandoff} time={timestamp} />
      </AgentLogRow>
    );
  }
  if (isRunCompletionStatus(entry.step) || isRunCancellationStep(entry.step)) {
    return <TurnEndActivityEntry entry={entry} context={context} title={presentation.title} content={presentation.content} />;
  }
  return (
    <AgentLogRow tone="status" label="Status" time={context.rowTime(timestamp)}>
      <StatusLine title={presentation.title} content={presentation.content} time={timestamp} />
    </AgentLogRow>
  );
};

const TurnEndActivityEntry = ({
  entry,
  context,
  title,
  content,
}: SingleEntryProps & Readonly<{ title: string; content: string }>) => {
  const cancelled = isRunCancellationStep(entry.step);
  return (
    <AgentLogRow
      tone="status"
      label={cancelled ? "Stopped" : "Done"}
      time={context.rowTime(new Date(entry.step.createdAt).toLocaleTimeString())}
      className="agent-log-row--turn-end"
    >
      <TurnEndDivider title={title} content={content} durationLabel={context.runDurationLabel} cancelled={cancelled} />
    </AgentLogRow>
  );
};

const ErrorActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  if (isRunCancellationStep(entry.step)) {
    return <TurnEndActivityEntry entry={entry} context={context} title={entry.step.title} content={entry.step.content} />;
  }
  return (
    <AgentLogRow tone="error" label="Error" time={context.rowTime(timestamp)}>
      <AgentPanel tone="error" className="px-2.5 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-medium text-[color:var(--ec-danger)]">{entry.step.title}</p>
          <span className="agent-density-meta text-[10px] text-[color:var(--ec-faint)]">{timestamp}</span>
        </div>
        <pre className="agent-pre app-scrollbar mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px]">
          {entry.step.content}
        </pre>
      </AgentPanel>
    </AgentLogRow>
  );
};

const ReasoningActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const reasoningAutoCollapsed = shouldAutoCollapseReasoning(entry.step.content);
  const reasoningExpanded = Boolean(context.activeReasoningStepIds[entry.step.id]);
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  const detail = describeActivityDetail(entry.metadata);
  return (
    <AgentLogRow tone="reasoning" label="Reason" time={context.rowTime(timestamp)}>
      <div className="agent-panel agent-panel--reasoning">
        {reasoningAutoCollapsed ? (
          <button
            type="button"
            className="absolute right-1 top-0 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[color:var(--ec-muted)] transition-colors hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
            onClick={() => context.toggleReasoningStep(entry.step.id)}
            title={reasoningExpanded ? "Collapse reasoning" : "Expand reasoning"}
          >
            {reasoningExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : null}
        {detail && detail !== entry.step.title ? (
          <p className="agent-density-detail mb-1 truncate text-[10px] text-[var(--ec-muted)]">{String(detail)}</p>
        ) : null}
        {reasoningAutoCollapsed && !reasoningExpanded ? (
          <p className="agent-reasoning-text">Long reasoning digest collapsed. Expand it when you want the full note.</p>
        ) : (
          <ActivityMarkdownOrGitDiff content={entry.step.content} compact className="agent-reasoning-text" onOpenWorkspaceFile={context.onOpenWorkspaceFile} />
        )}
      </div>
    </AgentLogRow>
  );
};

const AnswerActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const mode = (entry.metadata.mode as RunMode) ?? context.run.mode;
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  const detail = describeActivityDetail(entry.metadata);
  const final = context.finalAnswerEntries.has(entry);
  return (
    <AgentLogRow tone="answer" label={final ? "Answer" : "Update"} time={context.rowTime(timestamp)} className={answerRowClassName(final)}>
      <div className="agent-panel agent-panel--answer relative space-y-1.5">
        <AnswerCopyButton text={getResponseSourceText(entry.step, entry.metadata)} copyId={entry.step.id} context={context} />
        {detail && detail !== entry.step.title ? (
          <p className="agent-density-detail mb-1 truncate text-[10px] text-[var(--ec-muted)]">{String(detail)}</p>
        ) : null}
        {mode === "plan" ? <RunPlanSteps content={entry.step.content} /> : null}
        <ActivityMarkdownOrGitDiff content={entry.step.content} compact={context.compactContent} className="agent-response-text" onOpenWorkspaceFile={context.onOpenWorkspaceFile} />
      </div>
    </AgentLogRow>
  );
};

const AssistantActivityEntry = (props: SingleEntryProps) =>
  props.entry.metadata.assistantKind === "reasoning"
    ? <ReasoningActivityEntry {...props} />
    : <AnswerActivityEntry {...props} />;

const FallbackActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  const detail = describeActivityDetail(entry.metadata);
  return (
    <AgentLogRow tone="note" label="Note" time={context.rowTime(timestamp)}>
      <StatusLine title={entry.step.title} content={detail ? String(detail) : undefined} time={timestamp} />
      {entry.step.content.trim() ? (
        <ActivityMarkdownOrGitDiff content={entry.step.content} compact={context.compactContent} className="mt-1 text-[var(--ec-text)]" onOpenWorkspaceFile={context.onOpenWorkspaceFile} />
      ) : null}
    </AgentLogRow>
  );
};

const REQUEST_EVENT_TYPES = new Set<RunEventType>([
  "request",
  "user-input-requested",
  "approval-requested",
  "approval-resolved",
]);

export const SingleActivityEntryView = ({
  entry,
  context,
}: Readonly<{ entry: Extract<ActivityEntry, { kind: "single" }>; context: ActivityRenderContext }>) => {
  if (entry.metadata.source === "user") return <>{renderUserActivityEntry(entry, context)}</>;
  if (REQUEST_EVENT_TYPES.has(entry.step.eventType)) return <>{renderRequestActivityEntry(entry, context)}</>;

  switch (entry.step.eventType) {
    case "plan-progress": return null;
    case "plan":
    case "plan-updated": return <PlanActivityEntry entry={entry} context={context} />;
    case "diff-updated": return <DiffActivityEntry entry={entry} context={context} />;
    case "status": return <StatusActivityEntry entry={entry} context={context} />;
    case "error": return <ErrorActivityEntry entry={entry} context={context} />;
    default: {
      const isAssistant = entry.step.eventType === "output" || entry.step.eventType === "log";
      return isAssistant
        ? <AssistantActivityEntry entry={entry} context={context} />
        : <FallbackActivityEntry entry={entry} context={context} />;
    }
  }
};
