import { IPC_CHANNELS, StreamedStepEventDecoder, type EncodedStepEvent, type RunEvent } from "@buildwarden/shared";

type StepEvent = Pick<RunEvent, "content" | "metadata"> & { step?: { id: string; content: string } };

interface StreamedStepIpc {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  sendSync(channel: string, ...args: unknown[]): unknown;
}

/**
 * Decodes one compact run or chat event channel. A single listener sees every
 * message from preload start, so the decoder stays in step with the main
 * process encoder even while no renderer listener is subscribed.
 */
export const createStreamedStepEventChannel = <E extends StepEvent>(
  ipc: StreamedStepIpc,
  channel: string,
  kind: "run" | "chat",
) => {
  const decoder = new StreamedStepEventDecoder();
  const listeners = new Set<(event: E) => void>();
  ipc.on(channel, (_event, payload) => {
    const wire = payload as EncodedStepEvent<E>;
    const decoded = decoder.decode(wire);
    let event: E;
    if (decoded.ok) {
      event = decoded.event;
    } else {
      // Not expected: the main process resets its encoder when this document
      // changes. Recover with the persisted text instead of showing a fragment.
      const content = ipc.sendSync(IPC_CHANNELS.resolveStreamedStepContent, kind, decoded.stepId);
      event = decoder.recover(wire, typeof content === "string" ? content : "");
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        // Like separate IPC listeners, one failing subscriber must not starve the others.
        setTimeout(() => {
          throw error;
        });
      }
    }
  });
  return (listener: (event: E) => void): (() => void) => {
    // A wrapper per subscription keeps duplicate subscriptions independent.
    const entry = (event: E) => listener(event);
    listeners.add(entry);
    return () => listeners.delete(entry);
  };
};
