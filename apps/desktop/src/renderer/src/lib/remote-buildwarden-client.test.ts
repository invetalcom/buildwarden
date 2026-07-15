import { APP_SETTING_KEYS, REMOTE_ACCESS_PROTOCOL_VERSION, type AppSnapshot, type RemoteRpcResponse } from "@buildwarden/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemoteBuildWardenClient, RemoteSessionExpiredError } from "./remote-buildwarden-client";

const snapshot = {
  projects: [],
  providerAccounts: [],
  models: [],
  runs: [],
  chats: [],
  bookmarks: [],
  chatBookmarks: [],
  settings: {},
  selectedProjectId: null,
  selectedRunId: null,
} as unknown as AppSnapshot;

const storage = new Map<string, string>();

const rpcResponse = (result: unknown, requestId = "request-id"): Response => new Response(JSON.stringify({
  protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
  requestId,
  ok: true,
  result,
} satisfies RemoteRpcResponse), { status: 200, headers: { "Content-Type": "application/json" } });

describe("remote BuildWarden client", () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("window", {
      location: { origin: "http://127.0.0.1:47831" },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      open: vi.fn(() => ({})),
    });
    vi.stubGlobal("crypto", { randomUUID: () => "request-id" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches allowlisted reads through the versioned RPC envelope", async () => {
    const fetcher = vi.fn(async () => rpcResponse(snapshot));
    const client = createRemoteBuildWardenClient({ fetch: fetcher as typeof fetch });

    await expect(client.getSnapshot()).resolves.toMatchObject({ projects: [], selectedRunId: null });
    expect(client.capabilities).toMatchObject({ platform: "web", mutations: false, settings: false, liveEvents: true });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/rpc", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        requestId: "request-id",
        method: "getSnapshot",
        args: [],
      }),
    }));
  });

  it("keeps navigation and UI preferences local without mutating the host", async () => {
    const fetcher = vi.fn(async () => rpcResponse(snapshot));
    const client = createRemoteBuildWardenClient({ fetch: fetcher as typeof fetch });

    await client.selectProject("project-1");
    await client.activateRun("run-1");
    await client.setAppSetting(APP_SETTING_KEYS.darkMode, "true");
    const loaded = await client.refreshSnapshot();

    expect(loaded.selectedProjectId).toBe("project-1");
    expect(loaded.selectedRunId).toBe("run-1");
    expect(loaded.settings[APP_SETTING_KEYS.darkMode]).toBe("true");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects unsupported mutations and reports revoked sessions", async () => {
    const expired = vi.fn();
    const client = createRemoteBuildWardenClient({
      fetch: vi.fn(async () => new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })) as typeof fetch,
      onSessionExpired: expired,
    });

    await expect(client.createChat({ prompt: "no", modelId: "model", providerAccountId: "provider" })).rejects.toThrow("read-only remote client");
    await expect(client.getSnapshot()).rejects.toBeInstanceOf(RemoteSessionExpiredError);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("derives mutation capabilities from scopes and retries commands with the same persisted key", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(rpcResponse(undefined));
    const client = createRemoteBuildWardenClient({
      fetch: fetcher as typeof fetch,
      scopes: ["state:read", "run:operate"],
    });

    expect(client.capabilities).toMatchObject({
      mutations: true,
      runMutations: true,
      chatMutations: false,
      gitMutations: false,
      embeddedTerminal: false,
    });
    await expect(client.cancelRun("run-1")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstBody = (fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    const retryBody = (fetcher.mock.calls[1]?.[1] as RequestInit | undefined)?.body;
    expect(retryBody).toBe(firstBody);
    expect(JSON.parse(String(firstBody))).toMatchObject({
      method: "cancelRun",
      args: ["run-1"],
      idempotencyKey: "request-id",
    });
    await expect(client.createChat({ prompt: "no", modelId: "model", providerAccountId: "provider" }))
      .rejects.toThrow("not available for this remote session");
  });

  it("publishes validated live events from the authenticated WebSocket", () => {
    type SocketListener = (event: { data?: string; code?: number }) => void;
    const handlers = new Map<string, SocketListener[]>();
    const sent: string[] = [];
    const socket = {
      readyState: 0,
      addEventListener: (type: string, listener: SocketListener) => {
        handlers.set(type, [...(handlers.get(type) ?? []), listener]);
      },
      send: (message: string) => sent.push(message),
      close: vi.fn(),
    };
    const emit = (type: string, event: { data?: string; code?: number } = {}) =>
      handlers.get(type)?.forEach((handler) => handler(event));
    const client = createRemoteBuildWardenClient({
      fetch: vi.fn(async () => rpcResponse(snapshot)) as typeof fetch,
      webSocketFactory: (url) => {
        expect(url).toBe(`ws://127.0.0.1:47831/api/v1/events?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`);
        return socket as unknown as WebSocket;
      },
    });
    const onRunEvent = vi.fn();
    const unsubscribe = client.onRunEvent(onRunEvent);

    socket.readyState = 1;
    emit("open");
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ type: "subscribe", events: ["run"] });

    emit("message", { data: JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "event",
      sequence: 1,
      event: "run",
      payload: { runId: "run-1", type: "status", title: "Run completed", content: "Done", createdAt: new Date().toISOString() },
    }) });
    emit("message", { data: JSON.stringify({ protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION, type: "event", sequence: 2, event: "run", payload: {} }) });

    expect(onRunEvent).toHaveBeenCalledOnce();
    unsubscribe();
    expect(socket.close).toHaveBeenCalledWith(1000, "No active subscriptions");
  });

  it("subscribes to validated terminal events only for terminal-enabled sessions", () => {
    type SocketListener = (event: { data?: string; code?: number }) => void;
    const handlers = new Map<string, SocketListener[]>();
    const sent: string[] = [];
    const socket = {
      readyState: 0,
      addEventListener: (type: string, listener: SocketListener) => {
        handlers.set(type, [...(handlers.get(type) ?? []), listener]);
      },
      send: (message: string) => sent.push(message),
      close: vi.fn(),
    };
    const emit = (type: string, event: { data?: string; code?: number } = {}) =>
      handlers.get(type)?.forEach((handler) => handler(event));
    const client = createRemoteBuildWardenClient({
      fetch: vi.fn(async () => rpcResponse(snapshot)) as typeof fetch,
      scopes: ["state:read", "terminal:operate"],
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const onTerminalData = vi.fn();
    const unsubscribe = client.onRunTerminalData(onTerminalData);

    socket.readyState = 1;
    emit("open");
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ events: ["terminal-data"] });
    emit("message", { data: JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "event",
      sequence: 1,
      event: "terminal-data",
      payload: { sessionId: "buildwarden-run-terminal:run-1", data: "ready\r\n" },
    }) });
    emit("message", { data: JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "event",
      sequence: 2,
      event: "terminal-data",
      payload: { sessionId: 12, data: "invalid" },
    }) });

    expect(client.capabilities.embeddedTerminal).toBe(true);
    expect(onTerminalData).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
