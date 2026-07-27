import type { RunStepRecord } from "@buildwarden/shared";

/**
 * Suppression of repeated final-summary text in a run transcript.
 *
 * A run's closing text can reach the timeline up to three times: as the provider's last assistant
 * message, again as a persisted `final-summary` output step, and again as the run's stored
 * `summary` field. The host already skips appending the step when it matches the latest assistant
 * output (`shouldAppendFinalSummary` in `apps/desktop/src/main/app-controller.ts`), but older runs
 * and providers that emit `final-summary` chunks directly still carry the duplicate, so the client
 * filters it too.
 *
 * Ported from `dedupeFinalSummarySteps` in
 * `packages/renderer/src/components/app/RunDetailPage.tsx`, which cannot be imported because it is
 * a private helper inside a desktop component.
 */

const parseMetadata = (json: string): Record<string, unknown> => {
  try {
    return JSON.parse(json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Same normalisation the host uses when it compares a summary against the transcript. */
export const normalizeAssistantOutputText = (value: string): string => value.replace(/\s+/g, " ").trim();

const isAssistantOutput = (step: RunStepRecord, metadata: Record<string, unknown>): boolean =>
  step.eventType === "output" && metadata.assistantKind !== "reasoning" && step.title !== "Reasoning";

/** Drops a `final-summary` output step that just repeats the assistant message before it. */
export const dedupeFinalSummarySteps = (steps: readonly RunStepRecord[]): RunStepRecord[] => {
  const deduped: RunStepRecord[] = [];
  let previousAssistantContent: string | null = null;

  for (const step of steps) {
    const metadata = parseMetadata(step.metadataJson);
    if (isAssistantOutput(step, metadata)) {
      const normalizedContent = normalizeAssistantOutputText(step.content);
      const isDuplicateFinalSummary =
        metadata.assistantKind === "final-summary" &&
        Boolean(previousAssistantContent) &&
        normalizedContent.length > 0 &&
        normalizedContent === previousAssistantContent;
      if (isDuplicateFinalSummary) {
        continue;
      }
      previousAssistantContent = normalizedContent;
    }
    deduped.push(step);
  }

  return deduped;
};

/** The last assistant message, ignoring reasoning steps — a finished run's actual answer. */
export const finalAssistantStep = (steps: readonly RunStepRecord[]): RunStepRecord | null => {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (isAssistantOutput(step, parseMetadata(step.metadataJson)) && step.content.trim()) {
      return step;
    }
  }
  return null;
};

/** Normalised text of the last assistant message, ignoring reasoning steps. */
export const latestAssistantOutputText = (steps: readonly RunStepRecord[]): string =>
  normalizeAssistantOutputText(finalAssistantStep(steps)?.content ?? "");

/**
 * True when `run.summary` only repeats what the transcript already ends with — the usual case,
 * since the summary is normally derived from that final message. Uses the host's own equality rule
 * rather than a looser heuristic, so a genuinely different summary still gets shown.
 */
export const summaryDuplicatesTranscript = (summary: string | null | undefined, steps: readonly RunStepRecord[]): boolean => {
  const normalizedSummary = normalizeAssistantOutputText(summary ?? "");
  if (!normalizedSummary) {
    return true;
  }
  return normalizedSummary === latestAssistantOutputText(steps);
};
