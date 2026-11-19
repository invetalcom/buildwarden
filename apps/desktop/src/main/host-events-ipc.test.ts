import type { BrowserWindow } from "electron";
import { IPC_CHANNELS, STREAMED_STEP_ENCODER_CACHE_LIMIT, type ChatEvent, type RunEvent } from "@buildwarden/shared";
import { describe, expect, it, vi } from "vitest";
import { createStreamedStepEventChannel } from "../preload/streamed-step-events";
import { HostEventBus } from "./host-events";
import { registerHostEventIpc } from "./host-events-ipc";

type Listener = (...args: never[]) => void;

/** One main process window and its preload, connected like Electron IPC (structured clone, in order). */
type ResolveStepContent = (kind: "run" | "chat", stepId: string) => string | null;

const createHarness = (resolveStepContent = vi.fn<ResolveStepContent>(() => null)) => {
  const events = new HostEventBus();
  const mainListeners = new Map<string, Listener>();
  const ipcMain = {
    on: (channel: string, listener: Listener) => { mainListeners.set(channel, listener); return ipcMain; },
    removeListener: (channel: string) => { mainListeners.delete(channel); return ipcMain; },
  };
  const webContentsListeners = new Map<string, Listener[]>();
  const wire: Array<{ channel: string; payload: unknown }> = [];
  let preload = new Map<string, Listener>();
  const webContents = {
    isDestroyed: () => false,
    on: (name: string, listener: Listener) => {
      webContentsListeners.set(name, [...(webContentsListeners.get(name) ?? []), listener]);
      return webContents;
    },
    send: (channel: string, payload: unknown) => {
      wire.push({ channel, payload });
      preload.get(channel)?.({} as never, structuredClone(payload) as never);
    },
  };
  registerHostEventIpc(events, () => ({ webContents }) as unknown as BrowserWindow, {
    ipcMain: ipcMain as never,
    resolveStepContent,
  });

  const loadPreload = () => {
    preload = new Map();
    const ipcRenderer = {
      on: (channel: string, listener: Listener) => { preload.set(channel, listener); },
      sendSync: (channel: string, ...args: unknown[]) => {
        const event = { returnValue: undefined as unknown };
        mainListeners.get(channel)?.(event as never, ...(args as never[]));
        return event.returnValue;
      },
    };
    const received = { run: [] as RunEvent[], chat: [] as ChatEvent[] };
    createStreamedStepEventChannel<RunEvent>(ipcRenderer, IPC_CHANNELS.runEvent, "run")((event) => received.run.push(event));
    createStreamedStepEventChannel<ChatEvent>(ipcRenderer, IPC_CHANNELS.chatEvent, "chat")((event) => received.chat.push(event));
    return received;
  };
  const navigate = () => {
    for (const listener of webContentsListeners.get("did-start-navigation") ?? []) {
      listener({ isMainFrame: true, isSameDocument: false } as never);
    }
    return loadPreload();
  };
  return { events, wire, loadPreload, navigate, resolveStepContent };
};

const runEvent = (stepId: string, content: string, metadata: Record<string, unknown> = { streamId: stepId, replace: true }): RunEvent => ({
  runId: "run-1",
  type: "output",
  title: "Agent output",
  content,
  metadata,
  createdAt: "2026-11-19T10:00:00.000Z",
  step: { id: stepId, runId: "run-1", eventType: "output", title: "Agent output", content, metadataJson: JSON.stringify(metadata), createdAt: "2026-11-19T10:00:00.000Z" },
});

const words = (count: number) => Array.from({ length: count }, (_, index) => `word${String(index)} `).join("");

describe("compact run and chat event IPC", () => {
  it("streams only new text and rebuilds every event exactly", () => {
    const harness = createHarness();
    const received = harness.loadPreload();
    const published = [100, 200, 300, 400].map((count) => runEvent("step-1", words(count)));
    for (const event of published) harness.events.publish("run", event);

    expect(received.run).toEqual(published);
    const sizes = harness.wire.map(({ payload }) => JSON.stringify(payload).length);
    const fullSize = JSON.stringify(published[3]).length;
    // The first update sends the text once instead of twice; later ones send about 100 words.
    expect(sizes[0]).toBeLessThan(fullSize * 0.6);
    expect(sizes[3]).toBeLessThan(fullSize * 0.25);
    expect(harness.resolveStepContent).not.toHaveBeenCalled();
  });

  it("rebuilds rewritten text, ordinary steps and events without steps", () => {
    const harness = createHarness();
    const received = harness.loadPreload();
    const published: RunEvent[] = [
      runEvent("step-1", `${words(200)}draft ending`),
      runEvent("step-1", `${words(200)}final ending, rewritten`),
      runEvent("step-2", "Tool finished", { toolName: "run_shell" }),
      { ...runEvent("step-3", "Step text"), content: "Different event text" },
      { runId: "run-1", type: "status", title: "Running", content: "Running", createdAt: "2026-11-19T10:00:00.000Z" },
    ];
    for (const event of published) harness.events.publish("run", event);
    expect(received.run).toEqual(published);
    expect(harness.wire[3].payload).toMatchObject({ content: "Different event text", step: { content: "Step text" } });
  });

  it("decodes run and chat channels independently", () => {
    const harness = createHarness();
    const received = harness.loadPreload();
    const chat = (content: string): ChatEvent => {
      const { runId, ...event } = runEvent("shared-id", content);
      return { ...event, runId, chatId: "chat-1", step: { ...event.step!, chatId: "chat-1" } } as unknown as ChatEvent;
    };
    harness.events.publish("run", runEvent("shared-id", words(50)));
    harness.events.publish("chat", chat(words(10)));
    harness.events.publish("run", runEvent("shared-id", words(60)));
    harness.events.publish("chat", chat(words(20)));
    expect(received.run.map((event) => event.step?.content)).toEqual([words(50), words(60)]);
    expect(received.chat.map((event) => event.step?.content)).toEqual([words(10), words(20)]);
  });

  it("starts over with whole text after the renderer reloads", () => {
    const harness = createHarness();
    harness.loadPreload();
    harness.events.publish("run", runEvent("step-1", words(100)));
    const received = harness.navigate();
    const next = runEvent("step-1", words(120));
    harness.events.publish("run", next);
    expect(received.run).toEqual([next]);
    expect(harness.resolveStepContent).not.toHaveBeenCalled();
  });

  it("recovers persisted text when a delta cannot apply, then resumes whole updates", () => {
    const harness = createHarness(vi.fn(() => words(120)));
    harness.loadPreload();
    harness.events.publish("run", runEvent("step-1", words(100)));
    // A new document that the main process did not see navigating.
    const received = harness.loadPreload();
    harness.events.publish("run", runEvent("step-1", words(120)));
    harness.events.publish("run", runEvent("step-1", words(140)));
    harness.events.publish("run", runEvent("step-1", words(160)));
    expect(harness.resolveStepContent).toHaveBeenCalledExactlyOnceWith("run", "step-1");
    expect(received.run.map((event) => [event.content, event.step?.content])).toEqual([
      [words(120), words(120)],
      [words(140), words(140)],
      [words(160), words(160)],
    ]);
    expect(JSON.stringify(harness.wire[3].payload).length).toBeLessThan(JSON.stringify(harness.wire[2].payload).length);
  });

  it("keeps more interleaved streams in step than the encoder caches", () => {
    const harness = createHarness();
    const received = harness.loadPreload();
    const streams = STREAMED_STEP_ENCODER_CACHE_LIMIT + 20;
    const published: RunEvent[] = [];
    for (let round = 1; round <= 3; round++) {
      for (let stream = 0; stream < streams; stream++) {
        const event = runEvent(`step-${String(stream)}`, words(round * 10 + stream));
        published.push(event);
        harness.events.publish("run", event);
      }
    }
    expect(received.run).toEqual(published);
    expect(harness.resolveStepContent).not.toHaveBeenCalled();
  });
});
