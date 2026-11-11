import {
  ACP_DEFAULT_MODEL_ID,
  type OrchestrationEventRecord,
  type OrchestrationTaskMessageRecord,
  type OrchestrationTaskRecord,
  type OrchestrationTaskResultRecord,
  type RunUserInputQuestion,
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
const MAX_QUESTION_OPTIONS = 12;
const MAX_PENDING_QUESTION_REQUESTS = 3;
const MAX_QUESTIONS_PER_REQUEST = 5;
/** Option text once the answer is over budget: enough to pick one, not to read every description. */
const COMPACT_OPTION_CHARS = 80;
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

/** Model ids without a router prefix (`openai/`) or a context tag (`[1m]`), so equivalent ids compare equal. */
const comparableModelId = (model: string): string => model.trim().toLowerCase().replace(/^[^/]+\//, "").replace(/\[[^\]]*\]$/, "");

/**
 * A suffix that names a snapshot of the same model: a date (`-20261001`, `-2026-10-01`, `@20261001`),
 * an older four-digit snapshot (`-0613`), or `latest`. A short number is not one: `claude-opus-5-5`
 * is a different model from `claude-opus-5`.
 */
const SNAPSHOT_SUFFIX = /^[-@](?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4}|latest)$/;

/** Whether one id is the other plus a snapshot suffix. */
const sameModel = (requested: string, executed: string): boolean => {
  const [a, b] = [comparableModelId(requested), comparableModelId(executed)];
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) && SNAPSHOT_SUFFIX.test(longer.slice(shorter.length));
};

/**
 * Which model produced a result. Providers often report a dated id for the model they were asked
 * for, so a note appears only when the served model is a different one.
 */
export const describeResultModels = (result: Pick<OrchestrationTaskResultRecord, "requestedModel" | "executedModel">): Record<string, string> => {
  const requested = result.requestedModel ? truncateForCoordinator(result.requestedModel, MAX_METADATA_STRING_CHARS) : undefined;
  const executed = result.executedModel ? truncateForCoordinator(result.executedModel, MAX_METADATA_STRING_CHARS) : undefined;
  // A model left to the agent's choice (ACP's `default`) was never a request for a specific one.
  const differs = requested && executed && requested !== ACP_DEFAULT_MODEL_ID && !sameModel(requested, executed);
  return {
    ...(requested ? { requestedModel: requested } : {}),
    ...(executed ? { executedModel: executed } : {}),
    ...(differs ? { modelNote: `The provider served ${executed}, not the requested ${requested}.` } : {}),
  };
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
  questions.slice(0, MAX_PENDING_QUESTION_REQUESTS)
    .map((entry) => ({ ...entry, questions: entry.questions.slice(0, MAX_QUESTIONS_PER_REQUEST).map(boundQuestion) }));

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
      title: truncateForCoordinator(task.title, MAX_METADATA_STRING_CHARS),
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
      ...describeResultModels(result),
      summary: result.summary ? truncateForCoordinator(result.summary, RESULT_LIST_SUMMARY_CHARS) : null,
    })),
    nextResultsOffset: resultsOffset + RESULT_LIST_PAGE < results.length ? resultsOffset + RESULT_LIST_PAGE : null,
    ...(selectedResult ? {
      publishedResult: {
        id: selectedResult.id, version: selectedResult.version, status: selectedResult.status,
        ...describeResultModels(selectedResult),
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
  return fitTaskReadToBudget(response, input.maxResponseChars ?? ORCHESTRATION_TASK_READ_MAX_RESPONSE_CHARS, messagesOffset, {
    offset: summaryOffset, total: (selectedResult ? selectedResult.summary : task.summary)?.length ?? 0,
    published: Boolean(selectedResult),
  });
};

/** Drops the least important detail first until the answer fits; marks that it did. */
const fitTaskReadToBudget = (response: Record<string, unknown>, budget: number, messagesOffset: number,
  summaryPage: { offset: number; total: number; published: boolean },
): { response: Record<string, unknown>; size: number } => {
  const originalMessages = response.messages as ReturnType<typeof compactMessage>[];
  const totalMessages = response.totalMessages as number;
  const nextOffset = (count: number) => messagesOffset + count < totalMessages ? messagesOffset + count : null;
  const updateSummaryCursor = (target: Record<string, unknown>) => {
    const end = summaryPage.offset + (typeof target.summary === "string" ? target.summary.length : 0);
    if (end < summaryPage.total) target.nextSummaryOffset = end;
    else if (summaryPage.published) target.nextSummaryOffset = null;
    else delete target.nextSummaryOffset;
  };
  const measure = () => {
    response.nextMessagesOffset = nextOffset((response.messages as unknown[]).length);
    updateSummaryCursor((summaryPage.published ? response.publishedResult : response.task) as Record<string, unknown>);
    return JSON.stringify(response).length;
  };
  let size = measure();
  if (size <= budget) return { response, size };
  response.responseTruncated = "Some detail was left out to keep this answer small. Page with summaryOffset, messagesOffset, or resultId, or request fewer recentSteps.";
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
      if (typeof task.summary === "string") task.summary = task.summary.slice(0, 4_000);
    },
    // Questions go last: the coordinator needs them to answer, so only their detail is cut.
    () => {
      response.pendingQuestions = (response.pendingQuestions as PendingChildQuestion[]).slice(0, 1).map((entry) => ({
        ...entry,
        questions: entry.questions.map((question) => ({
          ...question,
          question: truncateForCoordinator(question.question, 300),
          options: question.options.map((option) => ({ label: truncateForCoordinator(option.label, COMPACT_OPTION_CHARS) })),
        })),
      }));
    },
    () => { if (response.pendingWork) response.pendingWork = { completionState: (response.pendingWork as { completionState?: unknown }).completionState }; },
    () => {
      response.activity = [];
      // Keep one message so repeated reads always advance without skipping unread entries.
      response.messages = originalMessages.slice(0, 1);
      response.results = [];
      if (childRun) response.childRun = { id: childRun.id, status: childRun.status };
      const task = response.task as Record<string, unknown>;
      for (const key of ["summary", "prompt", "errorMessage", "attentionReason"]) {
        if (typeof task[key] === "string") task[key] = key === "summary" ? task[key].slice(0, 1_000) : truncateForCoordinator(task[key], 1_000);
      }
    },
  ];
  for (const reduce of reducers) {
    reduce();
    size = measure();
    if (size <= budget) break;
  }
  if (measure() > budget) {
    // Preserve message progress even when the rest of the detail cannot fit.
    const task = response.task as Record<string, unknown>;
    const summary = (summaryPage.published ? response.publishedResult : task) as Record<string, unknown>;
    const minimalSummary: Record<string, unknown> = {
      summary: typeof summary.summary === "string" ? summary.summary.slice(0, 128) : null,
    };
    updateSummaryCursor(minimalSummary);
    const minimal = {
      task: { id: task.id, title: truncateForCoordinator(String(task.title ?? ""), MAX_METADATA_STRING_CHARS), status: task.status,
        ...(!summaryPage.published ? minimalSummary : {}),
      },
      ...(summaryPage.published ? { publishedResult: { id: summary.id, ...minimalSummary } } : {}),
      ...(originalMessages.length > 0 ? {
        messages: originalMessages.slice(0, 1), totalMessages, nextMessagesOffset: nextOffset(1),
      } : {}),
      responseTruncated: "This task's details are too large to return at once. Read its published result with resultId, or page with summaryOffset and messagesOffset.",
    };
    const minimalSize = JSON.stringify(minimal).length;
    if (minimalSize > budget) throw new Error("Task read budget is too small to return task detail. Increase maxResponseChars.");
    return { response: minimal, size: minimalSize };
  }
  return { response, size: measure() };
};
