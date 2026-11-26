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

/** Line breaks and runs of spaces only change how text is laid out, so they compare as one space. */
const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * Whether `text` is `answers` written one after another, possibly cut short. Whitespace inside an
 * answer counts; only the whitespace between two answers may differ, since the run-together text
 * has none there.
 */
const isAnswersInOrder = (text: string, answers: readonly string[]): boolean => {
  let rest = text;
  for (const answer of answers) {
    if (!rest || answer.startsWith(rest)) return true;
    if (!rest.startsWith(answer)) return false;
    rest = rest.slice(answer.length).trimStart();
  }
  return !rest;
};

/**
 * Whether a summary only repeats the turn's answers: the last one, or the last few run together.
 * AI SDK runs used to save the latter, cut at 4,000 characters, so a leading part counts as well.
 * The run-together text may leave out the turn's first answers, which a retried attempt wrote.
 */
export const finalSummaryRepeatsTurn = (summary: string, turnAnswers: readonly string[]): boolean => {
  const text = collapseWhitespace(summary);
  if (!text) return false;
  const answers = turnAnswers.map(collapseWhitespace);
  for (let start = answers.length - 1; start >= 0; start -= 1) {
    if (isAnswersInOrder(text, answers.slice(start))) return true;
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
