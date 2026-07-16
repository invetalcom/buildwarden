import type { ReactNode } from "react";
import {
  extractAttachmentNamesFromMetadata,
  extractAttachmentPayloadsFromMetadata,
  formatRunPlanProgressContent,
  normalizeRunPlanProgressPayload,
  type RunEventType,
  type RunMode,
  type RunUserInputAnswers,
} from "@buildwarden/shared";
import { Check, ChevronDown, ChevronRight, Copy, ListTodo, MessageSquareText, RotateCcw, ShieldCheck, Terminal } from "lucide-react";
import { ActivityMarkdownOrGitDiff } from "./activity-message-body";
import { AgentChip, AgentLogRow, AgentPanel } from "./agent-worklog";
import { RunPlanSteps } from "./RunPlanSteps";
import { RunUserInputRequestCard } from "./RunUserInputRequestCard";
import { StoredChatAttachments } from "./StoredChatAttachments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  describeActivityDetail,
  isRunCompletionStatus,
  readUserInputAnswers,
  readUserInputQuestions,
  runModeBadgeClassName,
  shouldAutoCollapseReasoning,
  type ActivityEntry,
  type RunActivityRun,
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
};


export const SingleGroupActivityEntry = ({
  entry,
  context,
}: Readonly<{ entry: Extract<ActivityEntry, { kind: "single-group" }>; context: ActivityRenderContext }>) => {
  const { run, runDurationLabel, rowTime, readOnly, restorablePromptStepId, onUndoRunToLastPrompt, activeCopiedStepId, copyStepContent, busy, isRunActive, compactContent, onOpenWorkspaceFile } = context;
  const first = entry.items[0]!;
  const last = entry.items[entry.items.length - 1]!;
  const t0 = new Date(first.step.createdAt).toLocaleTimeString();
  const t1 = new Date(last.step.createdAt).toLocaleTimeString();
  const timeRange = entry.items.length > 1 && t0 !== t1 ? `${t0}-${t1}` : t0;
  const groupKey = `sg-${first.step.id}-${entry.groupKey}-${entry.items.length}`;

  if (entry.groupKey === "status") {
    return (
      <AgentLogRow key={groupKey} tone="status" label="Status" time={rowTime(timeRange)}>
        <AgentPanel tone="status" className="px-2.5 py-1.5">
          <ul className="space-y-0.5">
            {entry.items.map(({ step }) => (
              <li
                key={step.id}
                className="flex items-start justify-between gap-2 border-t border-zinc-800/30 pt-0.5 first:border-t-0 first:pt-0"
              >
                <span className="min-w-0 flex-1 text-[10px] leading-snug text-zinc-400">
                  <span className="text-zinc-500">{step.title}</span>
                  {step.content ? <span className="text-zinc-500"> - {step.content}</span> : null}
                  {isRunCompletionStatus(step) && runDurationLabel ? (
                    <span className="text-[color:var(--ec-muted)]"> - Duration {runDurationLabel}</span>
                  ) : null}
                </span>
                <span className="agent-density-meta shrink-0 text-[10px] text-zinc-600 tabular-nums">
                  {new Date(step.createdAt).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        </AgentPanel>
      </AgentLogRow>
    );
  }

  if (entry.groupKey === "user") {
    return (
      <AgentLogRow key={groupKey} tone="prompt" label="Prompt" time={rowTime(timeRange)}>
        <div className="space-y-1">
          {entry.items.map(({ step, metadata }) => {
            const mode = (metadata.mode as RunMode) ?? run.mode;
            const att = extractAttachmentNamesFromMetadata(metadata);
            const attachments = extractAttachmentPayloadsFromMetadata(metadata);
            const canUndoPrompt = !readOnly && step.id === restorablePromptStepId && Boolean(onUndoRunToLastPrompt);
            return (
              <div key={step.id} className="agent-panel agent-panel--prompt px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <Badge tone="queued" className="agent-chip--prompt px-1.5 py-0 text-[10px]">
                      {metadata.commandType === "follow-up" ? "follow-up" : "you"}
                    </Badge>
                    <Badge tone="queued" className={`agent-density-meta px-1.5 py-0 text-[10px] ${runModeBadgeClassName(mode)}`}>
                      {mode}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:text-[color:var(--ec-text)]"
                      onClick={() => void copyStepContent(step.content, step.id)}
                      title={activeCopiedStepId === step.id ? "Copied" : "Copy prompt"}
                      aria-label="Copy prompt"
                    >
                      {activeCopiedStepId === step.id ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    {canUndoPrompt ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
                        title="Undo changes since this prompt"
                        aria-label="Undo changes since this prompt"
                        onClick={() => onUndoRunToLastPrompt?.(run)}
                        disabled={busy || isRunActive}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    <span className="agent-density-meta text-[10px] text-zinc-500">{new Date(step.createdAt).toLocaleTimeString()}</span>
                  </div>
                </div>
                <StoredChatAttachments attachments={attachments} fallbackNames={att} compact={compactContent} />
                <ActivityMarkdownOrGitDiff content={step.content} compact={compactContent} className="mt-1" onOpenWorkspaceFile={onOpenWorkspaceFile} />
              </div>
            );
          })}
        </div>
      </AgentLogRow>
    );
  }

  const combinedAnswerText = entry.items.map(({ step }) => step.content).join("\n\n");

  return (
    <AgentLogRow key={groupKey} tone="answer" label="Answer" time={rowTime(timeRange)}>
      <div className="agent-panel agent-panel--answer relative space-y-1.5 px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute right-1 top-1 z-10 h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
          onClick={() => void copyStepContent(combinedAnswerText, groupKey)}
          title={activeCopiedStepId === groupKey ? "Copied" : "Copy response"}
          aria-label="Copy response"
        >
          {activeCopiedStepId === groupKey ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
        {entry.items.map(({ step, metadata }, i) => {
          const detail = describeActivityDetail(metadata);
          const itemMode = (metadata.mode as RunMode) ?? run.mode;
          const shouldShowPlanSteps = itemMode === "plan" && metadata.assistantKind !== "reasoning";
          return (
            <div key={step.id} className={i === 0 ? "pr-8" : undefined}>
              {i > 0 ? <div className="mb-1.5 pt-1.5" /> : null}
              {detail && detail !== step.title ? (
                <p className="agent-density-detail mb-1 truncate text-[10px] text-zinc-500">{String(detail)}</p>
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

const renderUserActivityEntry = (entry: Extract<ActivityEntry, { kind: "single" }>, context: ActivityRenderContext): ReactNode => {
  const { run, rowTime, readOnly, restorablePromptStepId, onUndoRunToLastPrompt, activeCopiedStepId, copyStepContent, busy, isRunActive, compactContent, onOpenWorkspaceFile } = context;
  const mode = (entry.metadata.mode as RunMode) ?? run.mode;
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  const att = extractAttachmentNamesFromMetadata(entry.metadata);
  const attachments = extractAttachmentPayloadsFromMetadata(entry.metadata);
  const canUndoPrompt = !readOnly && entry.step.id === restorablePromptStepId && Boolean(onUndoRunToLastPrompt);
  return (
    <AgentLogRow key={entry.step.id} tone="prompt" label="Prompt" time={rowTime(timestamp)}>
      <div className="agent-panel agent-panel--prompt px-2.5 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <Badge tone="queued" className="agent-chip--prompt px-1.5 py-0 text-[10px]">
              {entry.metadata.commandType === "follow-up" ? "follow-up" : "you"}
            </Badge>
            <Badge tone="queued" className={`agent-density-meta px-1.5 py-0 text-[10px] ${runModeBadgeClassName(mode)}`}>
              {mode}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:text-[color:var(--ec-text)]"
              onClick={() => void copyStepContent(entry.step.content, entry.step.id)}
              title={activeCopiedStepId === entry.step.id ? "Copied" : "Copy prompt"}
              aria-label="Copy prompt"
            >
              {activeCopiedStepId === entry.step.id ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
            {canUndoPrompt ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
                title="Undo changes since this prompt"
                aria-label="Undo changes since this prompt"
                onClick={() => onUndoRunToLastPrompt?.(run)}
                disabled={busy || isRunActive}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <span className="agent-density-meta text-[10px] text-zinc-500">{timestamp}</span>
          </div>
        </div>
        <StoredChatAttachments attachments={attachments} fallbackNames={att} compact={compactContent} />
        <ActivityMarkdownOrGitDiff content={entry.step.content} compact={compactContent} className="mt-1 text-zinc-200" onOpenWorkspaceFile={onOpenWorkspaceFile} />
      </div>
    </AgentLogRow>
  );
}

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
  return userInputRequest
    ? <UserInputRequestActivityEntry entry={entry} context={context} request={userInputRequest} resolved={resolved} />
    : <GenericRequestActivityEntry entry={entry} context={context} requestKind={requestKind} resolved={resolved} />;
}

type SingleEntryProps = Readonly<{
  entry: Extract<ActivityEntry, { kind: "single" }>;
  context: ActivityRenderContext;
}>;

const PlanProgressActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const progress = normalizeRunPlanProgressPayload(entry.metadata.planProgress);
  const completed = progress?.steps.filter((step) => step.status === "completed").length ?? 0;
  const total = progress?.steps.length ?? null;
  const planContent = progress ? formatRunPlanProgressContent(progress) : entry.step.content;
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  return (
    <AgentLogRow tone="plan" label="Plan" time={context.rowTime(timestamp)}>
      <AgentPanel tone="plan" className="px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <ListTodo className="h-3.5 w-3.5 shrink-0 text-[var(--ec-info)]" />
            <p className="truncate text-[11px] font-medium text-[color:var(--ec-text)]">{entry.step.title}</p>
          </div>
          {total !== null ? (
            <AgentChip className="shrink-0">
              {completed}/{total}
            </AgentChip>
          ) : null}
        </div>
        <RunPlanSteps content={planContent} />
      </AgentPanel>
    </AgentLogRow>
  );
};

const PlanActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const canContinue = !context.readOnly && Boolean(context.onPreparePlanContinuation);
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  return (
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
  );
};

const DiffActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  return (
    <AgentLogRow tone="diff" label="Diff" time={context.rowTime(timestamp)}>
      <AgentPanel tone="diff" className="px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[11px] font-medium text-[color:var(--ec-text)]">{entry.step.title}</p>
        </div>
        {entry.step.content.trim() ? (
          <ActivityMarkdownOrGitDiff content={entry.step.content} compact={context.compactContent} className="mt-1.5 text-[color:var(--ec-text)]" onOpenWorkspaceFile={context.onOpenWorkspaceFile} />
        ) : null}
      </AgentPanel>
    </AgentLogRow>
  );
};

const StatusActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  const statusDurationLabel = isRunCompletionStatus(entry.step) ? context.runDurationLabel : null;
  return (
    <AgentLogRow tone="status" label="Status" time={context.rowTime(timestamp)}>
      <AgentPanel tone="status" className="px-2.5 py-1.5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11px] font-medium leading-snug text-[color:var(--ec-text)]">{entry.step.title}</p>
          {statusDurationLabel ? <AgentChip className="shrink-0">Duration {statusDurationLabel}</AgentChip> : null}
        </div>
        {entry.step.content ? (
          <p className="mt-0.5 break-words text-[11px] leading-snug text-[color:var(--ec-muted)]">{entry.step.content}</p>
        ) : null}
      </AgentPanel>
    </AgentLogRow>
  );
};

const ErrorActivityEntry = ({ entry }: SingleEntryProps) => {
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  return (
    <AgentPanel tone="error" className="px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-[color:var(--ec-danger)]">{entry.step.title}</p>
        <span className="agent-density-meta text-[10px] text-[color:var(--ec-faint)]">{timestamp}</span>
      </div>
      <pre className="agent-pre app-scrollbar mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px]">
        {entry.step.content}
      </pre>
    </AgentPanel>
  );
};

const ReasoningActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const reasoningAutoCollapsed = shouldAutoCollapseReasoning(entry.step.content);
  const reasoningExpanded = Boolean(context.activeReasoningStepIds[entry.step.id]);
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  const detail = describeActivityDetail(entry.metadata);
  return (
    <AgentLogRow tone="reasoning" label="Reason" time={context.rowTime(timestamp)}>
      <div className="agent-panel agent-panel--reasoning px-2 py-1.5">
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
          <p className="agent-density-detail mb-1 truncate text-[10px] text-zinc-500">{String(detail)}</p>
        ) : null}
        {reasoningAutoCollapsed && !reasoningExpanded ? (
          <p className="text-[11px] leading-relaxed text-[color:var(--ec-muted)]">
            Long reasoning digest collapsed. Expand it when you want the full note.
          </p>
        ) : (
          <ActivityMarkdownOrGitDiff content={entry.step.content} compact={context.compactContent} className="agent-response-text" onOpenWorkspaceFile={context.onOpenWorkspaceFile} />
        )}
      </div>
    </AgentLogRow>
  );
};

const AnswerActivityEntry = ({ entry, context }: SingleEntryProps) => {
  const mode = (entry.metadata.mode as RunMode) ?? context.run.mode;
  const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();
  const detail = describeActivityDetail(entry.metadata);
  return (
    <AgentLogRow tone="answer" label="Answer" time={context.rowTime(timestamp)}>
      <div className="agent-panel agent-panel--answer relative space-y-1.5 px-2 py-1.5">
        <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute right-1 top-1 z-10 h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
            onClick={() => void context.copyStepContent(entry.step.content, entry.step.id)}
            title={context.activeCopiedStepId === entry.step.id ? "Copied" : "Copy response"}
            aria-label="Copy response"
          >
          {context.activeCopiedStepId === entry.step.id ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        {detail && detail !== entry.step.title ? (
          <p className="agent-density-detail mb-1 truncate text-[10px] text-zinc-500">{String(detail)}</p>
        ) : null}
        <div className="pr-8">
          {mode === "plan" ? <RunPlanSteps content={entry.step.content} /> : null}
          <ActivityMarkdownOrGitDiff content={entry.step.content} compact={context.compactContent} className="agent-response-text" onOpenWorkspaceFile={context.onOpenWorkspaceFile} />
        </div>
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
  <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5">
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-zinc-200">{entry.step.title}</p>
        {detail ? <p className="mt-0.5 truncate text-[10px] text-zinc-400">{String(detail)}</p> : null}
      </div>
      <span className="agent-density-meta shrink-0 text-[10px] text-zinc-500">{timestamp}</span>
    </div>
    <div className="mt-1">
      <ActivityMarkdownOrGitDiff content={entry.step.content} compact={context.compactContent} className="text-zinc-300" onOpenWorkspaceFile={context.onOpenWorkspaceFile} />
    </div>
  </div>
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
    case "plan-progress": return <PlanProgressActivityEntry entry={entry} context={context} />;
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

// Everything a timeline row needs to render, bundled so rows can be memoized:
// while the bundle is referentially stable (i.e. during scrolling), rows skip
// re-rendering their markdown/diff content entirely.
