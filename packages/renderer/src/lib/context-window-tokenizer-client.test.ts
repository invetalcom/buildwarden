import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextWindowTokenRequest, ContextWindowTokenWorkerMessage } from "./context-window-tokenizer-protocol";

type Listener = (event: { data: ContextWindowTokenWorkerMessage }) => void;
type ErrorListener = () => void;

class FakeWorker {
  static instances: FakeWorker[] = [];
  static respondImmediately = true;
  private errorListener: ErrorListener | null = null;
  private messageListener: Listener | null = null;
  private request: ContextWindowTokenRequest | null = null;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === "message") {
      this.messageListener = listener as unknown as Listener;
    } else if (type === "error") {
      this.errorListener = listener as unknown as ErrorListener;
    }
  }

  postMessage(message: ContextWindowTokenRequest) {
    this.request = message;
    if (FakeWorker.respondImmediately) {
      this.respond();
    }
  }

  respond() {
    if (!this.request) return;
    this.messageListener?.({
      data: {
        type: "result",
        requestId: this.request.requestId,
        promptTokens: 7,
        historyTokens: 11,
      },
    });
  }

  emitError() {
    this.errorListener?.();
  }

  terminate() {
    this.terminated = true;
  }
}

const installDeferredBrowser = () => {
  const frameCallbacks: FrameRequestCallback[] = [];
  const idleCallbacks: IdleRequestCallback[] = [];
  const fakeWindow = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    },
    requestIdleCallback: (callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    },
    addEventListener: vi.fn(),
  };
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("Worker", FakeWorker);

  const finishInitialization = () => {
    frameCallbacks.shift()?.(0);
    frameCallbacks.shift()?.(16);
    idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 10 });
  };

  return { finishInitialization };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeWorker.instances = [];
  FakeWorker.respondImmediately = true;
});

describe("context window tokenizer client", () => {
  it("does not construct its shared worker until after two animation frames and an idle turn", async () => {
    const { finishInitialization } = installDeferredBrowser();

    const { requestExactContextWindowTokenCounts } = await import("./context-window-tokenizer-client");
    const countsPromise = requestExactContextWindowTokenCounts("prompt", "history");
    await Promise.resolve();
    expect(FakeWorker.instances).toHaveLength(0);

    finishInitialization();

    await expect(countsPromise).resolves.toEqual({ prompt: 7, history: 11 });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("resolves pending work on worker errors and reinitializes for the next request", async () => {
    FakeWorker.respondImmediately = false;
    const { finishInitialization } = installDeferredBrowser();
    const { requestExactContextWindowTokenCounts } = await import("./context-window-tokenizer-client");

    const failedCounts = requestExactContextWindowTokenCounts("prompt", "history");
    await Promise.resolve();
    finishInitialization();
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));

    const failedWorker = FakeWorker.instances[0]!;
    failedWorker.emitError();
    await expect(failedCounts).resolves.toBeNull();
    expect(failedWorker.terminated).toBe(true);

    const recoveredCounts = requestExactContextWindowTokenCounts("next prompt", "next history");
    await Promise.resolve();
    finishInitialization();
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));

    FakeWorker.instances[1]!.respond();
    await expect(recoveredCounts).resolves.toEqual({ prompt: 7, history: 11 });
  });
});
