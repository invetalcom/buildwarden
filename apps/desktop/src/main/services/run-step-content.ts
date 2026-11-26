import {
  type AttachmentBlobResolver,
  type ChatAttachmentPayload,
  dedupeChatAttachmentPayloads,
  extractAttachmentPayloadsFromMetadata,
  previewLargeStepContent,
  type RunDetail,
  type RunEvent,
  type RunRecord,
} from "@buildwarden/shared";
import type { PrWatchTurnResult } from "../pr-watch-service";

export const mergeProjectTaskRunAttachments = (
  taskAttachments: ChatAttachmentPayload[],
  runAttachments: ChatAttachmentPayload[] | undefined,
): ChatAttachmentPayload[] | undefined => {
  if (taskAttachments.length === 0) return runAttachments;
  if (!runAttachments?.length) return taskAttachments;
  return dedupeChatAttachmentPayloads(taskAttachments, runAttachments);
};

export const normalizeAssistantOutputText = (value: string) => value.replace(/\s+/g, " ").trim();

export const normalizeRunGoalText = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
};

/** Automations run unattended with full access, so the agent must not wait for answers. */
export const AUTOMATION_RUN_NOTE = [
  "<automation_run>",
  "A scheduled BuildWarden automation started this run. Nobody is watching it live, so do not ask questions or wait for approval.",
  "If something blocks the task, do what you safely can and explain in your final answer what is missing and what you did instead.",
  "</automation_run>",
].join("\n");

/** Puts the run goal in front of a turn's text, fenced so it cannot be mistaken for the request. */
export const buildPromptWithRunGoal = (
  prompt: string,
  goalText: string | null | undefined,
  promptLabel = "User request:",
): string => {
  const goal = normalizeRunGoalText(goalText);
  if (!goal) {
    return prompt;
  }
  return [
    `<run_goal>\nThe user's goal for the whole run. Work toward it in every turn.\n${goal}\n</run_goal>`,
    "",
    promptLabel,
    prompt.trim() || "(no additional request text)",
  ].join("\n");
};

const CANONICAL_RUN_CHUNK_TYPES = new Set<string>([
  "tool-call",
  "tool-result",
  "approval-requested",
  "approval-resolved",
  "user-input-requested",
  "plan-updated",
  "plan-progress",
  "diff-updated",
  "tool-progress",
  "request",
  "plan",
]);

const isCanonicalRunChunkType = (value: string): value is RunEvent["type"] => CANONICAL_RUN_CHUNK_TYPES.has(value);

/** Maps a provider chunk type onto the persisted run step event type. */
export const runChunkEventType = (chunkType: string): RunEvent["type"] | "output" | "error" | "status" => {
  if (chunkType === "message") {
    return "output";
  }
  if (isCanonicalRunChunkType(chunkType)) {
    return chunkType;
  }
  return chunkType === "error" ? "error" : "status";
};

const isDuplicateFinalSummaryStep = (
  step: {
    eventType: string;
    title: string;
    content: string;
    metadataJson: string;
  },
  previousAssistantContent: string | null,
) => {
  if (step.eventType !== "output") {
    return false;
  }
  const metadata = parseMetadataRecord(step.metadataJson);
  if (metadata.assistantKind !== "final-summary") {
    return false;
  }
  const normalizedContent = normalizeAssistantOutputText(typeof metadata.responseSourceText === "string" ? metadata.responseSourceText : step.content);
  return Boolean(previousAssistantContent) && normalizedContent.length > 0 && normalizedContent === previousAssistantContent;
};

export const parseMetadataRecord = (metadataJson: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(metadataJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * Live events carry the attachments as persisted on their step: stored files travel as
 * references that clients load when they render them, not as inline data.
 */
export const withStoredAttachmentMetadata = <T extends { metadata?: Record<string, unknown>; step?: { metadataJson: string } }>(event: T): T => {
  if (!event.step || !Array.isArray(event.metadata?.attachments) || !event.step.metadataJson.includes("\"blobId\"")) return event;
  const stored = parseMetadataRecord(event.step.metadataJson).attachments;
  return Array.isArray(stored) ? { ...event, metadata: { ...event.metadata, attachments: stored } } : event;
};

/** Live events carry the same head-and-tail preview of large tool output as history does. */
export const withStepContentPreview = <T extends { type: string; content: string; step?: { eventType: string; content: string; contentOmittedChars?: number } }>(event: T): T => {
  const content = previewLargeStepContent({ eventType: event.type, content: event.content }).content;
  const step = event.step ? previewLargeStepContent(event.step) : undefined;
  if (content === event.content && step === event.step) return event;
  return { ...event, content, ...(step ? { step } : {}) };
};

const COUNCIL_REQUEST_CHAR_LIMIT = 8_000;

/** The latest thing the agent said to the user, as plain source text. */
export const latestRunAnswerText = (steps: ReadonlyArray<{ eventType: string; content: string; metadataJson: string }>): string => {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.eventType !== "output") continue;
    const metadata = parseMetadataRecord(step.metadataJson);
    if (metadata.assistantKind === "reasoning" || metadata.assistantKind === "image" || metadata.assistantKind === "visual") continue;
    const source = typeof metadata.responseSourceText === "string" ? metadata.responseSourceText : step.content;
    if (source.trim()) return source.trim();
  }
  return "";
};

/**
 * The result of the turn a PR watch wake started. The wake ID on its prompt step marks the turn, and
 * only steps after the last such step answer it; an earlier turn's answer is never this wake's report.
 */
export const readPrWatchTurnResult = (
  run: Pick<RunRecord, "status" | "errorMessage" | "finishedAt">,
  steps: ReadonlyArray<{ eventType: string; content: string; metadataJson: string; createdAt: string }>,
  wakeId: string,
): PrWatchTurnResult => {
  let promptIndex = -1;
  for (let index = steps.length - 1; index >= 0 && promptIndex < 0; index -= 1) {
    const step = steps[index]!;
    if (step.eventType !== "log") continue;
    const wake = parseMetadataRecord(step.metadataJson).prWatchWake;
    if (wake && typeof wake === "object" && (wake as { wakeId?: unknown }).wakeId === wakeId) promptIndex = index;
  }
  if (promptIndex < 0) return { status: "not-started", answer: "", errorMessage: null };
  // Another turn started after the wake's prompt, such as a follow-up sent right after a restart:
  // whatever finished last is that turn, not the wake's. Steering joins the running turn, so it does not count.
  const laterTurn = steps.slice(promptIndex + 1).some((step) => {
    if (step.eventType !== "log") return false;
    const commandType = parseMetadataRecord(step.metadataJson).commandType;
    return commandType === "initial" || commandType === "follow-up";
  });
  if (laterTurn) return { status: "not-started", answer: "", errorMessage: null };
  // A restart after the wake's prompt leaves no proof that the wake's turn was ever accepted: a
  // recovery may resume the previous turn's checkpoint, which writes only a status step. A run that
  // was already terminal at startup gets no interruption step, so recovery markers count on their
  // own. Even a recovery of the wake's own turn is not trusted, so the wake's events stay retryable.
  const interrupted = steps.slice(promptIndex + 1).some((step) => {
    if (step.eventType !== "status") return false;
    const metadata = parseMetadataRecord(step.metadataJson);
    return metadata.sessionInterrupted === true || metadata.resumedFromCheckpoint === true || metadata.recoveredInterruptedSession === true;
  });
  if (interrupted) return { status: "interrupted", answer: "", errorMessage: null };
  // The prompt step is saved before the run leaves its previous terminal state. A terminal state
  // only belongs to this turn if the run finished after the prompt; otherwise the turn never ran.
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  if (terminal && !(run.finishedAt && Date.parse(run.finishedAt) > Date.parse(steps[promptIndex]!.createdAt))) {
    return { status: "not-started", answer: "", errorMessage: null };
  }
  return { status: run.status, answer: latestRunAnswerText(steps.slice(promptIndex + 1)), errorMessage: run.errorMessage };
};

/** What the user asked for across the whole run, so reviewers do not mistake follow-ups for scope creep. */
export const runUserRequests = (
  run: Pick<RunRecord, "prompt">,
  steps: ReadonlyArray<{ content: string; metadataJson: string }>,
): string[] => {
  const requests = steps.flatMap((step) => {
    const metadata = parseMetadataRecord(step.metadataJson);
    const isRequest = metadata.source === "user" && (metadata.commandType === "initial" || metadata.commandType === "follow-up" || metadata.commandType === "steer");
    return isRequest && step.content.trim() ? [step.content.trim().slice(0, COUNCIL_REQUEST_CHAR_LIMIT)] : [];
  });
  return requests.length ? requests : [run.prompt.slice(0, COUNCIL_REQUEST_CHAR_LIMIT)];
};

/**
 * A turn BuildWarden started itself, such as answering PR feedback, applying review findings or
 * passing on orchestration messages. Its text was written by BuildWarden or other people, not typed
 * by the user. A run's first turn is never one: it holds the run's task, even when a coordinator or
 * the council wrote it.
 */
export const isInternalTurnMetadata = (metadata: Record<string, unknown>): boolean =>
  metadata.commandType !== "initial" &&
  (metadata.source !== "user" || metadata.orchestrationResume === true || Boolean(metadata.prWatchWake) || Boolean(metadata.councilApply));

const RUN_REQUEST_LIST_BUDGET = 6_000;
const RUN_REQUEST_LIMIT = 3_000;

/**
 * What the user typed across the run, as one numbered list for prompts that describe what the run
 * was for. Turns BuildWarden started itself are only counted. A long list keeps the first request
 * and the newest ones that fit.
 */
export const formatRunUserRequests = (
  run: Pick<RunRecord, "prompt">,
  steps: ReadonlyArray<{ eventType: string; content: string; metadataJson: string }>,
  budget = RUN_REQUEST_LIST_BUDGET,
): string => {
  let internalTurns = 0;
  const requests = steps.flatMap((step) => {
    const metadata = parseMetadataRecord(step.metadataJson);
    const isRequest = isTurnStartMetadata(metadata) || metadata.commandType === "steer";
    if (step.eventType !== "log" || !isRequest || !step.content.trim()) return [];
    if (isInternalTurnMetadata(metadata)) {
      if (metadata.commandType !== "steer") internalTurns += 1;
      return [];
    }
    return [step.content.trim()];
  });
  if (requests.length === 0 && run.prompt.trim()) requests.push(run.prompt.trim());
  // Each entry, number included, fits half the budget, so the first and the newest request always fit.
  const limit = Math.min(RUN_REQUEST_LIMIT, Math.floor(budget / 2) - 2);
  const entries = requests.map((request, index) => {
    const prefix = requests.length === 1 ? "" : `${String(index + 1)}. `;
    const room = limit - prefix.length;
    return prefix + (request.length <= room ? request : `${request.slice(0, room - 6).trimEnd()} [...]`);
  });
  const newest: string[] = [];
  let remaining = budget - (entries[0]?.length ?? 0);
  for (let index = entries.length - 1; index > 0 && entries[index]!.length <= remaining; index -= 1) {
    newest.unshift(entries[index]!);
    remaining -= entries[index]!.length;
  }
  const omitted = Math.max(0, entries.length - 1 - newest.length);
  return [
    entries[0] ?? "",
    omitted > 0 ? `(${String(omitted)} more request${omitted === 1 ? "" : "s"} left out)` : "",
    ...newest,
    internalTurns > 0
      ? `(BuildWarden also started ${String(internalTurns)} turn${internalTurns === 1 ? "" : "s"} itself, such as answering PR feedback or applying review findings.)`
      : "",
  ].filter(Boolean).join("\n\n");
};

/**
 * The latest turn's text, with any messages the user steered into it; null without one. `internal`
 * marks a turn BuildWarden started itself, whose saved text may only be a short label.
 */
export const latestTurnRequest = (
  steps: ReadonlyArray<{ eventType: string; content: string; metadataJson: string }>,
): { text: string; internal: boolean } | null => {
  const steers: string[] = [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.eventType !== "log") continue;
    const metadata = parseMetadataRecord(step.metadataJson);
    if (metadata.source === "user" && metadata.commandType === "steer" && step.content.trim()) steers.unshift(step.content.trim());
    if (isTurnStartMetadata(metadata)) {
      const text = [step.content.trim(), ...steers].filter(Boolean).join("\n\n");
      return text ? { text, internal: isInternalTurnMetadata(metadata) } : null;
    }
  }
  return null;
};

type PersistedRunMessageStep = Pick<RunDetail["steps"][number], "eventType" | "title" | "content" | "metadataJson">;

export const extractInitialRunAttachmentsFromSteps = (
  steps: ReadonlyArray<PersistedRunMessageStep>,
  resolveBlob?: AttachmentBlobResolver,
): ChatAttachmentPayload[] => {
  for (const step of steps) {
    if (step.eventType !== "log") continue;
    const metadata = parseMetadataRecord(step.metadataJson);
    if (metadata.source === "user" && metadata.commandType === "initial") {
      return extractAttachmentPayloadsFromMetadata(metadata, resolveBlob);
    }
  }
  return [];
};

/** Whether a user step starts a turn; steered messages join the running one. */
export const isTurnStartMetadata = (metadata: Record<string, unknown>): boolean =>
  metadata.commandType === "initial" || metadata.commandType === "follow-up";

export const buildPriorRunMessagesFromSteps = (
  steps: ReadonlyArray<PersistedRunMessageStep>,
  resolveBlob?: AttachmentBlobResolver,
): Array<Record<string, unknown>> => {
  const messages: Array<Record<string, unknown>> = [];
  let previousAssistantContent: string | null = null;
  for (const step of steps) {
    const metadata = parseMetadataRecord(step.metadataJson);
    // Subagent output belongs to the subagent's own conversation, not the main agent's.
    if (typeof metadata.subagentId === "string" && metadata.subagentId) {
      continue;
    }

    if (step.eventType === "log" && isTurnStartMetadata(metadata)) {
      // Two turns may end with the same answer; only a repeat within one turn is a duplicate.
      previousAssistantContent = null;
    }
    if (step.eventType === "log" && metadata.source === "user") {
      const attachments = extractAttachmentPayloadsFromMetadata(metadata, resolveBlob);
      messages.push({
        role: "user",
        content: step.content,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      continue;
    }

    if (step.eventType === "output") {
      if (metadata.assistantKind === "reasoning" || metadata.assistantKind === "image" || step.title === "Reasoning") {
        continue;
      }
      if (isDuplicateFinalSummaryStep(step, previousAssistantContent)) {
        continue;
      }
      messages.push({ role: "assistant", content: typeof metadata.responseSourceText === "string" ? metadata.responseSourceText : step.content });
      previousAssistantContent = normalizeAssistantOutputText(typeof metadata.responseSourceText === "string" ? metadata.responseSourceText : step.content);
    }
  }
  if (messages.length > 0 && messages[messages.length - 1]?.role === "user") {
    messages.pop();
  }
  return messages;
};

export const firstNonEmptyLine = (output: string): string | null => {
  for (const line of output.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
};
