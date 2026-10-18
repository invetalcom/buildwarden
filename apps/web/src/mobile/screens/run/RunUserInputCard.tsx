import { BuildWardenClientProvider, RunUserInputRequestCard } from "@buildwarden/renderer/response-content";
import { useMemo } from "react";
import type { RunDetail } from "@buildwarden/shared";
import { findPendingUserInput } from "../../lib/pending-run-input";
import { useMobileApp } from "../../data/mobile-app-context";

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
