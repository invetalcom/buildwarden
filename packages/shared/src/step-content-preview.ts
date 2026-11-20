/**
 * Tool output can reach megabytes (a full build log, a large file read). Clients render it in a
 * scrolled box, so history and live events carry a head-and-tail preview of such steps instead,
 * and clients fetch the full text with `getStepContent` when the user asks for it. The database
 * and every main-process consumer (context handoff, resume, rewind) keep reading full content.
 */

/** Step types whose content is tool output rather than conversation text. */
const PREVIEWED_STEP_EVENT_TYPES: ReadonlySet<string> = new Set(["tool-result", "tool-progress"]);

/**
 * Content up to this many UTF-16 code units is sent whole. Previews show a few hundred lines in a
 * box that displays about forty; in one sample database this previewed 4% of tool steps and halved
 * their text.
 */
export const STEP_CONTENT_PREVIEW_THRESHOLD = 16 * 1024;
const PREVIEW_HEAD_CHARS = 10 * 1024;
const PREVIEW_TAIL_CHARS = 4 * 1024;
/** Cut at a line break when one is this close to the boundary, so lines are not split. */
const LINE_SNAP_CHARS = 1024;

export const stepContentOmissionMarker = (omittedChars: number): string =>
  `\n\n… ${omittedChars.toLocaleString("en-US")} characters of output omitted …\n\n`;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

const headEnd = (content: string): number => {
  const lineBreak = content.lastIndexOf("\n", PREVIEW_HEAD_CHARS);
  if (lineBreak >= PREVIEW_HEAD_CHARS - LINE_SNAP_CHARS) return lineBreak + 1;
  // Do not separate a surrogate pair.
  return isHighSurrogate(content.charCodeAt(PREVIEW_HEAD_CHARS - 1)) ? PREVIEW_HEAD_CHARS - 1 : PREVIEW_HEAD_CHARS;
};

const tailStart = (content: string): number => {
  const boundary = content.length - PREVIEW_TAIL_CHARS;
  const lineBreak = content.indexOf("\n", boundary);
  if (lineBreak !== -1 && lineBreak < boundary + LINE_SNAP_CHARS) return lineBreak + 1;
  return isHighSurrogate(content.charCodeAt(boundary - 1)) ? boundary - 1 : boundary;
};

type PreviewableStep = { eventType: string; content: string; contentOmittedChars?: number };

/** Returns the step unchanged, or a copy whose content is a head-and-tail preview. */
export const previewLargeStepContent = <T extends PreviewableStep>(step: T): T & { contentOmittedChars?: number } => {
  if (step.contentOmittedChars !== undefined) return step;
  if (!PREVIEWED_STEP_EVENT_TYPES.has(step.eventType) || step.content.length <= STEP_CONTENT_PREVIEW_THRESHOLD) return step;
  const head = headEnd(step.content);
  const tail = tailStart(step.content);
  const omittedChars = tail - head;
  return {
    ...step,
    content: step.content.slice(0, head) + stepContentOmissionMarker(omittedChars) + step.content.slice(tail),
    contentOmittedChars: omittedChars,
  };
};

export const previewLargeStepContents = <T extends PreviewableStep>(steps: readonly T[]): Array<T & { contentOmittedChars?: number }> =>
  steps.map(previewLargeStepContent);
