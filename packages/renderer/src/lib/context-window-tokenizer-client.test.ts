import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextWindowTokenRequest, ContextWindowTokenWorkerMessage } from "./context-window-tokenizer-protocol";

type Listener = (event: { data: ContextWindowTokenWorkerMessage }) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];
  private messageListener: Listener | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === "message") {
      this.messageListener = listener as unknown as Listener;
    }
  }

  postMessage(message: ContextWindowTokenRequest) {
    this.messageListener?.({
      data: {
        type: "result",
        requestId: message.requestId,
        promptTokens: 7,
        historyTokens: 11,
      },
    });
  }

  terminate() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeWorker.instances = [];
});

describe("context window tokenizer client", () => {
  it("does not construct its shared worker until after two animation frames and an idle turn", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const idleCallback: { current: IdleRequestCallback | null } = { current: null };
    const fakeWindow = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      requestIdleCallback: (callback: IdleRequestCallback) => {
        idleCallback.current = callback;
        return 1;
      },
      addEventListener: vi.fn(),
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("Worker", FakeWorker);

    const { requestExactContextWindowTokenCounts } = await import("./context-window-tokenizer-client");
    const countsPromise = requestExactContextWindowTokenCounts("prompt", "history");
    await Promise.resolve();
    expect(FakeWorker.instances).toHaveLength(0);

    frameCallbacks.shift()?.(0);
    expect(FakeWorker.instances).toHaveLength(0);
    frameCallbacks.shift()?.(16);
    expect(FakeWorker.instances).toHaveLength(0);
    idleCallback.current?.({ didTimeout: false, timeRemaining: () => 10 });

    await expect(countsPromise).resolves.toEqual({ prompt: 7, history: 11 });
    expect(FakeWorker.instances).toHaveLength(1);
  });
});
