import { finalSummaryRepeatsTurn, latestTurnAnswerTexts, type RunStepRecord } from "@buildwarden/shared";

/**
 * A run's closing text can reach the timeline up to three times: as the provider's last assistant
 * message, again as a persisted `final-summary` output step, and again as the run's stored
 * `summary` field. The timeline drops repeated summary steps with `dedupeFinalSummarySteps` from
 * `@buildwarden/shared`, the filter the desktop run page uses, and hides the stored summary here
 * when it only repeats the latest turn.
 */

const parseMetadata = (json: string): Record<string, unknown> => {
  try {
    return JSON.parse(json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

const isAssistantOutput = (step: RunStepRecord, metadata: Record<string, unknown>): boolean =>
  step.eventType === "output" && metadata.assistantKind !== "reasoning" && step.title !== "Reasoning";

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

/**
 * True when `run.summary` only repeats what the latest turn already shows — the usual case, since
 * the summary is normally that turn's last message, or a final-summary step saved with the same
 * text. Uses the host's own rule rather than a looser heuristic, so a genuinely different summary
 * still gets shown.
 */
export const summaryDuplicatesTranscript = (summary: string | null | undefined, steps: readonly RunStepRecord[]): boolean => {
  const text = summary?.trim() ?? "";
  return !text || finalSummaryRepeatsTurn(text, latestTurnAnswerTexts(steps, { includeSummaries: true }));
};
