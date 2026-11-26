/**
 * A turn's closing summary can repeat what the agent already said. The host skips saving a summary
 * that only repeats the turn, and clients hide such steps that older runs saved anyway.
 */

type RunStepLike = { eventType: string; title: string; content: string; metadataJson: string };

const parseMetadata = (metadataJson: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(metadataJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const isTurnStart = (step: RunStepLike, metadata: Record<string, unknown>): boolean =>
  step.eventType === "log" && (metadata.commandType === "initial" || metadata.commandType === "follow-up");

/** An answer the agent wrote to the user: not reasoning, images, visual replies or a subagent's text. */
const isAnswerStep = (step: RunStepLike, metadata: Record<string, unknown>): boolean =>
  step.eventType === "output" &&
  step.title !== "Reasoning" &&
  metadata.assistantKind !== "reasoning" &&
  metadata.assistantKind !== "image" &&
  metadata.assistantKind !== "visual" &&
  !(typeof metadata.subagentId === "string" && metadata.subagentId);

const sourceText = (step: RunStepLike, metadata: Record<string, unknown>): string =>
  typeof metadata.responseSourceText === "string" ? metadata.responseSourceText : step.content;

const withoutWhitespace = (value: string): string => value.replace(/\s+/g, "");

/**
 * Whether a summary only repeats the turn's answers: the last one, or the last few run together.
 * AI SDK runs used to save the latter, cut at 4,000 characters, so a leading part counts as well.
 * The run-together text may leave out the turn's first answers, which a retried attempt wrote.
 */
export const finalSummaryRepeatsTurn = (summary: string, turnAnswers: readonly string[]): boolean => {
  const text = withoutWhitespace(summary);
  if (!text || turnAnswers.length === 0) return false;
  if (text === withoutWhitespace(turnAnswers[turnAnswers.length - 1]!)) return true;
  let tail = "";
  for (let index = turnAnswers.length - 1; index >= 0; index -= 1) {
    tail = withoutWhitespace(turnAnswers[index]!) + tail;
    if (tail.startsWith(text)) return true;
  }
  return false;
};

/**
 * The agent's answers in the latest turn, oldest first. Final summaries are left out unless
 * `includeSummaries` is set, for checking text against everything the turn already shows.
 */
export const latestTurnAnswerTexts = (steps: readonly RunStepLike[], options: { includeSummaries?: boolean } = {}): string[] => {
  const answers: string[] = [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    const metadata = parseMetadata(step.metadataJson);
    if (isTurnStart(step, metadata)) break;
    if (isAnswerStep(step, metadata) && (options.includeSummaries || metadata.assistantKind !== "final-summary")) answers.unshift(sourceText(step, metadata));
  }
  return answers;
};

/** Drops the final-summary steps that only repeat what the agent said earlier in the same turn. */
export const dedupeFinalSummarySteps = <T extends RunStepLike>(steps: readonly T[]): T[] => {
  const kept: T[] = [];
  let turnAnswers: string[] = [];
  for (const step of steps) {
    const metadata = parseMetadata(step.metadataJson);
    if (isTurnStart(step, metadata)) turnAnswers = [];
    if (isAnswerStep(step, metadata)) {
      const text = sourceText(step, metadata);
      if (metadata.assistantKind !== "final-summary") turnAnswers.push(text);
      else if (finalSummaryRepeatsTurn(text, turnAnswers)) continue;
    }
    kept.push(step);
  }
  return kept;
};
