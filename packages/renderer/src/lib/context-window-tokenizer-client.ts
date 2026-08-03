import type { ContextWindowTextTokenCounts } from "./context-window-estimate";
import type {
  ContextWindowTokenRequest,
  ContextWindowTokenWorkerMessage,
} from "./context-window-tokenizer-protocol";

let worker: Worker | null = null;
let workerInitialization: Promise<Worker | null> | null = null;
let nextRequestId = 0;
let pageHideListenerRegistered = false;
const pending = new Map<number, (counts: ContextWindowTextTokenCounts | null) => void>();

const resolvePending = (counts: ContextWindowTextTokenCounts | null) => {
  for (const resolve of pending.values()) {
    resolve(counts);
  }
  pending.clear();
};

const disposeWorker = () => {
  worker?.terminate();
  worker = null;
  workerInitialization = null;
  resolvePending(null);
};

const afterFirstPaintAndIdle = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(() => resolve(), { timeout: 1_000 });
        } else {
          setTimeout(resolve, 0);
        }
      });
    });
  });

const initializeWorker = async (): Promise<Worker | null> => {
  await afterFirstPaintAndIdle();
  try {
    const instance = new Worker(new URL("../workers/context-window-tokenizer.worker.ts", import.meta.url), { type: "module" });
    instance.addEventListener("message", (event: MessageEvent<ContextWindowTokenWorkerMessage>) => {
      const resolve = pending.get(event.data.requestId);
      if (!resolve) {
        return;
      }
      pending.delete(event.data.requestId);
      resolve(
        event.data.type === "result"
          ? { prompt: event.data.promptTokens, history: event.data.historyTokens }
          : null,
      );
    });
    instance.addEventListener("error", disposeWorker);
    worker = instance;

    if (!pageHideListenerRegistered && typeof window !== "undefined") {
      pageHideListenerRegistered = true;
      window.addEventListener("pagehide", disposeWorker, { once: true });
    }
    return instance;
  } catch {
    workerInitialization = null;
    return null;
  }
};

const getWorker = (): Promise<Worker | null> => {
  if (worker) {
    return Promise.resolve(worker);
  }
  workerInitialization ??= initializeWorker();
  return workerInitialization;
};

export const requestExactContextWindowTokenCounts = async (
  prompt: string,
  history: string,
): Promise<ContextWindowTextTokenCounts | null> => {
  const instance = await getWorker();
  if (!instance) {
    return null;
  }

  return new Promise((resolve) => {
    const requestId = ++nextRequestId;
    pending.set(requestId, resolve);
    const message: ContextWindowTokenRequest = { type: "count", requestId, prompt, history };
    instance.postMessage(message);
  });
};
