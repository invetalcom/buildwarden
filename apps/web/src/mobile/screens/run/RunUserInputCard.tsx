import { BuildWardenClientProvider, RunUserInputRequestCard } from "@buildwarden/renderer/response-content";
import { useMemo } from "react";
import type { RunDetail, RunUserInputQuestion } from "@buildwarden/shared";
import { readUserInputAnswers, readUserInputQuestions } from "@buildwarden/renderer/logic";
import { useMobileApp } from "../../data/mobile-app-context";

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
const findPendingUserInput = (detail: RunDetail): PendingRequest | null => {
  for (let index = detail.steps.length - 1; index >= 0; index -= 1) {
    const step = detail.steps[index];
    if (step.eventType !== "user-input-requested") continue;
    const metadata = parseMetadata(step.metadataJson);
    if (readUserInputAnswers(metadata) || metadata.requestStatus === "cancelled") continue;
    // Matches the desktop reader: newer steps use `userInputRequestId`, older ones `requestId`.
    const requestId = [metadata.userInputRequestId, metadata.requestId].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const questions = readUserInputQuestions(metadata);
    if (requestId && questions.length > 0) return { requestId, questions };
  }
  return null;
};

/**
 * Answering a blocking question is the single most valuable thing to do from a phone, so it is
 * pinned above the composer rather than living inside the scrolling timeline.
 */
export const RunUserInputCard = ({ detail, onAnswered }: { detail: RunDetail; onAnswered: () => Promise<void> }) => {
  const { client } = useMobileApp();
  const request = useMemo(() => findPendingUserInput(detail), [detail]);
  if (!request) return null;
  const active = ["queued", "preparing", "running"].includes(detail.run.status);
  return <div className="shrink-0 max-h-80 overflow-y-auto border-t border-[var(--ec-border)] p-2">
    <BuildWardenClientProvider client={client}>
      <RunUserInputRequestCard key={request.requestId} runId={detail.run.id} requestId={request.requestId}
        title="The agent needs an answer" content="" timestamp="" questions={request.questions} resolved={false}
        disabled={!active || !client.capabilities.approvalResponses}
        onSubmitAnswers={async (answers) => { await client.respondToRunUserInput(detail.run.id, request.requestId, answers); await onAnswered(); }} />
    </BuildWardenClientProvider>
  </div>;
};
