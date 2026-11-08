import type {
  OrchestrationEventRecord,
  OrchestrationTaskMessageRecord,
  OrchestrationTaskRecord,
  OrchestrationTaskResultRecord,
  RunUserInputQuestion,
} from "@buildwarden/shared";
import { truncateForCoordinator, type PendingChildQuestion } from "./orchestration-tools";

/** The whole `buildwarden_tasks_read` answer stays under this many characters of JSON. */
export const ORCHESTRATION_TASK_READ_MAX_RESPONSE_CHARS = 120_000;
export const ORCHESTRATION_TASK_READ_MAX_EVENTS = 20;
export const ORCHESTRATION_TASK_READ_MESSAGES_PAGE = 10;
const MAX_EVENT_CONTENT_CHARS = 1_000;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_REASON_CHARS = 2_000;
const MAX_METADATA_STRING_CHARS = 200;
const MAX_METADATA_ENTRIES = 12;
const MAX_QUESTION_CHARS = 1_000;
const MAX_QUESTION_OPTIONS = 20;
const MAX_QUESTION_OPTION_CHARS = 300;
const RESULT_LIST_PAGE = 5;
const RESULT_LIST_SUMMARY_CHARS = 500;

/** Metadata keys whose values duplicate text the read returns elsewhere, or that may be large. */
const OMITTED_METADATA_KEYS = new Set(["summary", "errorMessage", "content", "prompt", "diff"]);

type MetadataValue = string | number | boolean | null | Array<string | number | boolean>;

/** Keeps short scalar metadata; drops nested objects and anything that repeats a result's text. */
export const compactEventMetadata = (metadata: Record<string, unknown>): Record<string, MetadataValue> => {
  const compact: Record<string, MetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(compact).length >= MAX_METADATA_ENTRIES) break;
    if (OMITTED_METADATA_KEYS.has(key)) continue;
    if (typeof value === "string") compact[key] = truncateForCoordinator(value, MAX_METADATA_STRING_CHARS);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) compact[key] = value;
    else if (Array.isArray(value) && value.length <= 10
      && value.every((entry) => typeof entry === "number" || typeof entry === "boolean" || (typeof entry === "string" && entry.length <= MAX_METADATA_STRING_CHARS))) {
      compact[key] = value as Array<string | number | boolean>;
    }
  }
  return compact;
};

/** An activity entry: what happened, never a copy of a published result. */
export const compactOrchestrationEvent = (event: OrchestrationEventRecord) => {
  const isResult = event.type === "result-published";
  const metadata = compactEventMetadata(event.metadata);
  return {
    sequence: event.sequence,
    type: event.type,
    title: truncateForCoordinator(event.title, MAX_METADATA_STRING_CHARS),
    createdAt: event.createdAt,
    // A published result is read by id, so its activity entry only points at it.
    content: isResult ? "Result published; read it with resultId." : truncateForCoordinator(event.content, MAX_EVENT_CONTENT_CHARS),
    ...(isResult ? { resultId: event.id } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
};

const boundQuestion = (question: RunUserInputQuestion): RunUserInputQuestion => ({
  ...question,
  ...(typeof question.question === "string" ? { question: truncateForCoordinator(question.question, MAX_QUESTION_CHARS) } : {}),
  ...(typeof question.header === "string" ? { header: truncateForCoordinator(question.header, MAX_METADATA_STRING_CHARS) } : {}),
  ...(Array.isArray(question.options)
    ? {
      options: question.options.slice(0, MAX_QUESTION_OPTIONS).map((option) => ({
        ...option,
        label: truncateForCoordinator(option.label, MAX_QUESTION_OPTION_CHARS),
        ...(typeof option.description === "string" ? { description: truncateForCoordinator(option.description, MAX_QUESTION_OPTION_CHARS) } : {}),
      })),
    }
    : {}),
});

export const boundPendingQuestions = (questions: PendingChildQuestion[]): PendingChildQuestion[] =>
  questions.slice(0, 5).map((entry) => ({ ...entry, questions: entry.questions.slice(0, 10).map(boundQuestion) }));

const compactMessage = (message: OrchestrationTaskMessageRecord) => ({
  id: message.id,
  source: message.source,
  status: message.status,
  createdAt: message.createdAt,
  deliveredAt: message.deliveredAt,
  content: truncateForCoordinator(message.content, MAX_MESSAGE_CHARS),
});

const pageNumber = (value: unknown): number => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0);

export interface TaskReadInput {
  task: OrchestrationTaskRecord;
  args: Record<string, unknown>;
  /** Published results, newest first. */
  results: OrchestrationTaskResultRecord[];
  pendingQuestions: PendingChildQuestion[];
  events: OrchestrationEventRecord[];
  messages: { messages: OrchestrationTaskMessageRecord[]; total: number };
  childRun: (Record<string, unknown> & { recentSteps?: unknown[]; diff?: string }) | null;
  /** Progress a child's own subagents or background work reported, if any. */
  pendingWork?: Record<string, unknown> | null;
  maxSummaryChars: number;
  maxPromptChars: number;
  maxResponseChars?: number;
}

/**
 * Builds the coordinator's view of one task from explicit, bounded fields. Spreading records
 * would pass along whatever they hold (a published result's full text sits in event
 * metadata), so every field here is chosen and capped, and the whole answer has a budget.
 */
export const buildOrchestrationTaskRead = (input: TaskReadInput): { response: Record<string, unknown>; size: number } => {
  const { task, args, results } = input;
  const summaryOffset = pageNumber(args.summaryOffset);
  const summaryEnd = summaryOffset + input.maxSummaryChars;
  const resultsOffset = pageNumber(args.resultsOffset);
  const messagesOffset = pageNumber(args.messagesOffset);
  const selectedResult = typeof args.resultId === "string" ? results.find((result) => result.id === args.resultId) : undefined;
  const response: Record<string, unknown> = {
    task: {
      id: task.id,
      clientTaskId: task.clientTaskId,
      title: task.title,
      roleId: task.roleId,
      modelId: task.modelId,
      intent: task.intent,
      permissionMode: task.permissionMode ?? "inherit",
      status: task.status,
      adoptionStatus: task.adoptionStatus,
      childRunId: task.childRunId,
      retryOfTaskId: task.retryOfTaskId,
      deferredUntil: task.deferredUntil,
      inputTokens: task.inputTokens,
      outputTokens: task.outputTokens,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      prompt: truncateForCoordinator(task.prompt, input.maxPromptChars),
      errorMessage: task.errorMessage ? truncateForCoordinator(task.errorMessage, MAX_REASON_CHARS) : null,
      attentionReason: task.attentionReason ? truncateForCoordinator(task.attentionReason, MAX_REASON_CHARS) : null,
      // With a selected result, its text is the one to page through; the live summary stays a preview.
      summary: task.summary?.slice(selectedResult ? 0 : summaryOffset, selectedResult ? 1_000 : summaryEnd) ?? null,
      ...(!selectedResult && task.summary && task.summary.length > summaryEnd ? { nextSummaryOffset: summaryEnd } : {}),
    },
    pendingQuestions: boundPendingQuestions(input.pendingQuestions),
    results: results.slice(resultsOffset, resultsOffset + RESULT_LIST_PAGE).map((result) => ({
      id: result.id, version: result.version, status: result.status, createdAt: result.createdAt,
      summary: result.summary ? truncateForCoordinator(result.summary, RESULT_LIST_SUMMARY_CHARS) : null,
    })),
    nextResultsOffset: resultsOffset + RESULT_LIST_PAGE < results.length ? resultsOffset + RESULT_LIST_PAGE : null,
    ...(selectedResult ? {
      publishedResult: {
        id: selectedResult.id, version: selectedResult.version, status: selectedResult.status,
        summary: selectedResult.summary?.slice(summaryOffset, summaryEnd) ?? null,
        errorMessage: selectedResult.errorMessage ? truncateForCoordinator(selectedResult.errorMessage, MAX_REASON_CHARS) : null,
        nextSummaryOffset: selectedResult.summary && selectedResult.summary.length > summaryEnd ? summaryEnd : null,
      },
    } : {}),
    needsUserApproval: task.status === "waiting-input" && input.pendingQuestions.length === 0,
    ...(input.pendingWork ? { pendingWork: input.pendingWork } : {}),
    activity: input.events.slice(-ORCHESTRATION_TASK_READ_MAX_EVENTS).map(compactOrchestrationEvent),
    messages: input.messages.messages.map(compactMessage),
    totalMessages: input.messages.total,
    nextMessagesOffset: messagesOffset + input.messages.messages.length < input.messages.total
      ? messagesOffset + input.messages.messages.length
      : null,
    childRun: input.childRun,
  };
  return fitTaskReadToBudget(response, input.maxResponseChars ?? ORCHESTRATION_TASK_READ_MAX_RESPONSE_CHARS);
};

/** Drops the least important detail first until the answer fits; marks that it did. */
const fitTaskReadToBudget = (response: Record<string, unknown>, budget: number): { response: Record<string, unknown>; size: number } => {
  const measure = () => JSON.stringify(response).length;
  let size = measure();
  if (size <= budget) return { response, size };
  const childRun = response.childRun as (Record<string, unknown> & { recentSteps?: unknown[]; diff?: string }) | null;
  const reducers: Array<() => void> = [
    () => {
      if (childRun?.diff) childRun.diff = truncateForCoordinator(childRun.diff, Math.max(2_000, childRun.diff.length - (size - budget) - 200));
    },
    () => { if (childRun?.recentSteps && childRun.recentSteps.length > 3) childRun.recentSteps = childRun.recentSteps.slice(-3); },
    () => { response.activity = (response.activity as unknown[]).slice(-5); },
    () => { response.messages = (response.messages as unknown[]).slice(0, 3); },
    () => { if (childRun) delete childRun.diff; },
    () => { if (childRun) childRun.recentSteps = []; },
    () => {
      const task = response.task as Record<string, unknown>;
      if (typeof task.summary === "string") task.summary = truncateForCoordinator(task.summary, 4_000);
    },
  ];
  for (const reduce of reducers) {
    reduce();
    size = measure();
    if (size <= budget) break;
  }
  response.responseTruncated = "Some detail was left out to keep this answer small. Page with summaryOffset, messagesOffset, or resultId, or request fewer recentSteps.";
  return { response, size: measure() };
};
