import type { HarnessRunChunk } from "@buildwarden/shared";

const replaceableStream = (chunk: HarnessRunChunk): string | undefined => {
  const metadata = chunk.metadata;
  if (chunk.type !== "message" || metadata?.replace !== true || typeof metadata.streamId !== "string") return;
  // These updates carry lifecycle state as well as text and must reach the host.
  if (metadata.usageTotals || metadata.providerSessionRuntime || metadata.checkpoint) return;
  return metadata.streamId;
};

/** Keep image expansion and redundant streaming updates out of the host event loop.
 * Only adjacent replacements of the same response can be discarded. One delivery
 * stays in flight until the host has persisted and published it; a slow disk or
 * remote subscriber therefore cannot build an unbounded queue of embedded images.
 */
export const createResponseChunkStream = (
  embedImages: (value: string) => string,
  send: (chunk: HarnessRunChunk, deliveryId: number) => void,
) => {
  const pending: HarnessRunChunk[] = [];
  const waiters: Array<() => void> = [];
  let inFlight: number | undefined;
  let sequence = 0;
  let nextResponseAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pump = () => {
    if (inFlight !== undefined || timer !== undefined) return;
    const chunk = pending[0];
    if (!chunk) {
      for (const resolve of waiters.splice(0)) resolve();
      return;
    }
    const delay = replaceableStream(chunk) ? nextResponseAt - Date.now() : 0;
    if (delay > 0) {
      timer = setTimeout(() => { timer = undefined; pump(); }, delay);
      return;
    }
    pending.shift();
    const value = chunk.type === "message" ? embedImages(chunk.value) : chunk.value;
    const outgoing = value === chunk.value ? chunk : {
      ...chunk, value, metadata: { ...chunk.metadata, responseSourceText: chunk.value },
    };
    // Text remains fluid at 10 updates/s. Large image responses get more breathing
    // room (up to 1s), including providers that return inline data URLs themselves.
    if (replaceableStream(chunk)) nextResponseAt = Date.now() + Math.min(1000, Math.max(100, value.length / 16384));
    inFlight = ++sequence;
    send(outgoing, inFlight);
  };

  return {
    post(chunk: HarnessRunChunk) {
      const previous = pending.at(-1);
      const stream = replaceableStream(chunk);
      if (previous && stream && replaceableStream(previous) === stream) pending[pending.length - 1] = chunk;
      else pending.push(chunk);
      pump();
    },
    acknowledge(deliveryId: number) {
      if (inFlight !== deliveryId) return;
      inFlight = undefined;
      pump();
    },
    // Call before completion, errors and interactive requests so they cannot
    // overtake the final pending response or lose it when the worker terminates.
    drain(): Promise<void> {
      if (!pending.length && inFlight === undefined) return Promise.resolve();
      return new Promise((resolve) => { waiters.push(resolve); pump(); });
    },
  };
};
