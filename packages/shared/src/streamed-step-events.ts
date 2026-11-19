/**
 * Compact transport for run and chat events that carry a step.
 *
 * Replace-mode streams publish the whole text so far on every update, and each
 * event repeats that text as `content` and `step.content`. The encoder sends the
 * event text once, and for a stream it already sent, only the changed suffix.
 * The decoder rebuilds the original event. Both sides must see the same ordered
 * sequence of events on one channel; the decoder keeps more entries than the
 * encoder, so mirrored LRU updates keep every encoder entry available to it.
 */

/** Text of a streamed step: `previous.slice(0, start) + text`, where `previous.length === baseLength`. */
export interface StreamedStepContentDelta {
  baseLength: number;
  start: number;
  text: string;
}

export interface StreamedStepEventEncoding {
  /** The event `content` equals `step.content` and was omitted. */
  contentFromStep?: true;
  /** `step.content` was omitted and is rebuilt from this delta. */
  delta?: StreamedStepContentDelta;
}

type StepBearingEvent = {
  content: string;
  metadata?: Record<string, unknown>;
  step?: { id: string; content: string };
};

export type EncodedStepEvent<E extends StepBearingEvent> = E & { streamEncoding?: StreamedStepEventEncoding };

export const STREAMED_STEP_ENCODER_CACHE_LIMIT = 64;
export const STREAMED_STEP_DECODER_CACHE_LIMIT = 256;

const isStream = (event: StepBearingEvent): boolean => event.metadata?.replace === true;

const remember = (cache: Map<string, string>, limit: number, stepId: string, content: string): void => {
  cache.delete(stepId);
  cache.set(stepId, content);
  if (cache.size > limit) cache.delete(cache.keys().next().value as string);
};

const commonPrefixLength = (left: string, right: string): number => {
  // Streams usually append; the native comparison avoids a per-character loop.
  if (right.startsWith(left)) return left.length;
  const max = Math.min(left.length, right.length);
  let index = 0;
  // UTF-16 code units: splitting a surrogate pair is lossless, as the decoder concatenates them again.
  while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index++;
  return index;
};

export class StreamedStepEventEncoder {
  private readonly contents = new Map<string, string>();

  constructor(private readonly limit = STREAMED_STEP_ENCODER_CACHE_LIMIT) {}

  encode<E extends StepBearingEvent>(event: E): EncodedStepEvent<E> {
    const step = event.step;
    if (!step) return event;
    const encoding: StreamedStepEventEncoding = {};
    let wireStep = step;
    if (isStream(event)) {
      const previous = this.contents.get(step.id);
      if (previous !== undefined) {
        const start = commonPrefixLength(previous, step.content);
        const delta = { baseLength: previous.length, start, text: step.content.slice(start) };
        // Small replacements are not worth the bookkeeping of a delta.
        if (delta.text.length < step.content.length) {
          encoding.delta = delta;
          wireStep = { ...step, content: "" };
        }
      }
      remember(this.contents, this.limit, step.id, step.content);
    } else {
      this.contents.delete(step.id);
    }
    const contentFromStep = event.content === step.content && event.content.length > 0;
    if (contentFromStep) encoding.contentFromStep = true;
    if (!encoding.delta && !contentFromStep) return event;
    return { ...event, content: contentFromStep ? "" : event.content, step: wireStep as E["step"], streamEncoding: encoding };
  }

  /** Sends the next update of this step in full. */
  forget(stepId: string): void {
    this.contents.delete(stepId);
  }

  reset(): void {
    this.contents.clear();
  }
}

export type StreamedStepDecodeResult<E> =
  | { ok: true; event: E }
  /** The delta does not apply to the decoder's text; resolve the step's current content. */
  | { ok: false; stepId: string };

export class StreamedStepEventDecoder {
  private readonly contents = new Map<string, string>();

  constructor(private readonly limit = STREAMED_STEP_DECODER_CACHE_LIMIT) {}

  decode<E extends StepBearingEvent>(wire: EncodedStepEvent<E>): StreamedStepDecodeResult<E> {
    const { streamEncoding, ...rest } = wire;
    const event = rest as unknown as E;
    const step = event.step;
    if (!step) return { ok: true, event };
    let content = step.content;
    const delta = streamEncoding?.delta;
    if (delta) {
      const previous = this.contents.get(step.id);
      if (previous === undefined || previous.length !== delta.baseLength) return { ok: false, stepId: step.id };
      content = previous.slice(0, delta.start) + delta.text;
    }
    return { ok: true, event: this.accept(event, content, streamEncoding) };
  }

  /** Completes an event that failed to decode with the step's current content. */
  recover<E extends StepBearingEvent>(wire: EncodedStepEvent<E>, content: string): E {
    const { streamEncoding, ...rest } = wire;
    return this.accept(rest as unknown as E, content, streamEncoding);
  }

  private accept<E extends StepBearingEvent>(event: E, content: string, encoding: StreamedStepEventEncoding | undefined): E {
    const step = event.step!;
    if (isStream(event)) remember(this.contents, this.limit, step.id, content);
    else this.contents.delete(step.id);
    if (!encoding) return event;
    return {
      ...event,
      content: encoding.contentFromStep ? content : event.content,
      step: { ...step, content },
    };
  }
}
