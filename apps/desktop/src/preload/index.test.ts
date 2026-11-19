import { IPC_CHANNELS, type DesktopApi } from "@buildwarden/shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  exposedApi: null as DesktopApi | null,
  invoke: vi.fn(() => Promise.resolve({ ok: true })),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: DesktopApi) => {
      electronMocks.exposedApi = api;
    },
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

type IpcListener = (event: unknown, payload: unknown) => void;
// Run and chat events are decoded by one listener per channel, registered when the preload loads.
const loadTimeListeners = new Map<string, IpcListener>();
const STREAMED_EVENT_CHANNELS: Record<string, string> = {
  onRunEvent: IPC_CHANNELS.runEvent,
  onChatEvent: IPC_CHANNELS.chatEvent,
};

beforeAll(async () => {
  await import("./index");
  for (const [channel, listener] of electronMocks.on.mock.calls as unknown as Array<[string, IpcListener]>) {
    loadTimeListeners.set(channel, listener);
  }
});

beforeEach(() => {
  electronMocks.invoke.mockClear();
  electronMocks.on.mockClear();
  electronMocks.removeListener.mockClear();
});

describe("preload DesktopApi bridge", () => {
  it("keeps the standalone bootstrap on the Electron IPC transport", async () => {
    const api = electronMocks.exposedApi!;

    await api.getSnapshot();

    expect(electronMocks.invoke).toHaveBeenCalledOnce();
    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC_CHANNELS.getSnapshot);
  });

  it("exposes every API operation and wires it to Electron IPC", async () => {
    const api = electronMocks.exposedApi;
    expect(api).not.toBeNull();

    for (const [name, operation] of Object.entries(api ?? {})) {
      const callable = operation as (...args: unknown[]) => unknown;
      if (name.startsWith("on")) {
        const listener = vi.fn();
        const unsubscribe = callable(listener);
        expect(unsubscribe).toBeTypeOf("function");
        const streamedChannel = STREAMED_EVENT_CHANNELS[name];
        if (streamedChannel) {
          const payload = { runId: "run-1", content: "Hello" };
          loadTimeListeners.get(streamedChannel)?.({}, payload);
          expect(listener).toHaveBeenCalledExactlyOnceWith(payload);
          (unsubscribe as () => void)();
          loadTimeListeners.get(streamedChannel)?.({}, payload);
          expect(listener).toHaveBeenCalledOnce();
          continue;
        }
        const wrapped = electronMocks.on.mock.lastCall?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
        wrapped?.({}, undefined);
        expect(listener).toHaveBeenCalledOnce();
        (unsubscribe as () => void)();
      } else {
        await callable();
      }
    }

    expect(electronMocks.invoke).toHaveBeenCalled();
    expect(electronMocks.on).toHaveBeenCalled();
    expect(electronMocks.removeListener).toHaveBeenCalled();
  });

  it("maps representative methods to their shared IPC channels", async () => {
    const api = electronMocks.exposedApi!;
    await api.getSnapshot();
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.getSnapshot);

    await api.deleteRun("run-1");
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.deleteRun, "run-1");

    await api.suggestRunBranchName("run-2");
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.suggestRunBranchName, "run-2");

    await api.setAppSetting("theme", "dark");
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.setAppSetting, "theme", "dark");

    const activityQuery = { projectId: "project-1", groupBy: "module" as const };
    await api.queryProjectActivity(activityQuery);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.queryProjectActivity, activityQuery);
  });
});
