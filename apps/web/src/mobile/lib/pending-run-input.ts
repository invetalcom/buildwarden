import type { RunDetail, RunUserInputQuestion } from "@buildwarden/shared";
import { readUserInputAnswers, readUserInputQuestions } from "@buildwarden/renderer/logic";

const parseMetadata = (value: string): Record<string, unknown> => {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

interface PendingRequest {
  requestId: string;
  questions: RunUserInputQuestion[];
}

/** The newest unanswered `user-input-requested` step, if any. */
export const findPendingUserInput = (detail: RunDetail): PendingRequest | null => {
  for (let index = detail.steps.length - 1; index >= 0; index -= 1) {
    const step = detail.steps[index];
    const metadata = parseMetadata(step.metadataJson);
    // Never offer a question owned by a previous user turn/worker.
    if (metadata.source === "user") return null;
    if (step.eventType !== "user-input-requested") continue;
    if (readUserInputAnswers(metadata)) return null;
    if (metadata.requestStatus === "cancelled") continue;
    // Matches the desktop reader: newer steps use `userInputRequestId`, older ones `requestId`.
    const requestId = [metadata.userInputRequestId, metadata.requestId].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const questions = readUserInputQuestions(metadata);
    if (requestId && questions.length > 0) return { requestId, questions };
  }
  return null;
};

