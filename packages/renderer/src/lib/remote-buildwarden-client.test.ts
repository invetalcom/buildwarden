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
    expect(client.capabilities).toMatchObject({
      platform: "web",
      mutations: false,
      bookmarkMutations: false,
      runListVisibilityMutations: false,
      settings: false,
      liveEvents: true,
    });
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

  it("allows read-only remote sessions to query filtered project activity", async () => {
    const queryResult = { summary: { commits: 0 }, groups: [], contributors: [], modules: [], weekdays: [], commits: [] };
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string };
      return rpcResponse(queryResult, request.requestId);
    });
    const client = createRemoteBuildWardenClient({ fetch: fetcher as typeof fetch });

    await expect(client.queryProjectActivity({ projectId: "project-1", groupBy: "month" })).resolves.toMatchObject({ summary: { commits: 0 } });
    expect(JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      method: "queryProjectActivity",
      args: [{ projectId: "project-1", groupBy: "month" }],
    });
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

  it("omits trailing undefined optional arguments from RPC requests", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string };
      return rpcResponse({ path: null, parentPath: null, entries: [] }, request.requestId);
    });
    const client = createRemoteBuildWardenClient({ fetch: fetcher as typeof fetch });

    await expect(client.listHostDirectories(undefined)).resolves.toEqual({ path: null, parentPath: null, entries: [] });
    expect(JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      method: "listHostDirectories",
      args: [],
    });
  });

  it("rejects host setting writes when the session lacks settings capability", async () => {
    const fetcher = vi.fn(async () => rpcResponse(undefined));
    const client = createRemoteBuildWardenClient({ fetch: fetcher as typeof fetch });

    await expect(client.setAppSetting(APP_SETTING_KEYS.darkMode, "true")).resolves.toBeUndefined();
    await expect(client.setAppSetting(APP_SETTING_KEYS.shellAllowlistExtra, "[]"))
      .rejects.toThrow('"setAppSetting" is not available for this remote session.');
    expect(fetcher).not.toHaveBeenCalled();
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

  it("enables scoped project workflows and host settings for control sessions", async () => {
    const hostSnapshot = {
      ...snapshot,
      settings: { [APP_SETTING_KEYS.shellAllowlistExtra]: "[]" },
    } as AppSnapshot;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; requestId: string };
      return rpcResponse(request.method === "getSnapshot" ? hostSnapshot : undefined, request.requestId);
    });
    const client = createRemoteBuildWardenClient({
      fetch: fetcher as typeof fetch,
      scopes: ["state:read", "run:operate", "chat:operate", "git:write", "admin"],
    });

    expect(client.capabilities).toMatchObject({
      settings: true,
      bookmarkMutations: true,
      runListVisibilityMutations: true,
      taskMutations: true,
      insightMutations: true,
      projectLabMutations: true,
      projectLoopMutations: true,
      prReview: true,
      projectSettingsMutations: true,
    });
    await expect(client.getSnapshot()).resolves.toMatchObject({
      settings: { [APP_SETTING_KEYS.shellAllowlistExtra]: "[]" },
    });
    await client.setAppSetting(APP_SETTING_KEYS.shellAllowlistExtra, JSON.stringify(["git status"]));
    await client.setRunListVisibility("run-1", "for-later");
    await client.addBookmark("run-1");
    await client.addChatBookmark("chat-1");
    await client.generateProjectInsight({ projectId: "project-1", kind: "architecture-graph" });

    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).method)).toEqual([
      "getSnapshot",
      "setAppSetting",
      "setRunListVisibility",
      "addBookmark",
      "addChatBookmark",
      "generateProjectInsight",
    ]);
  });

  it("uses an origin-bound bearer for hosted HTTP and authenticates WebSockets before subscribing", async () => {
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
    const fetcher = vi.fn(async () => rpcResponse(snapshot));
    const client = createRemoteBuildWardenClient({
      baseUrl: "https://host.tailnet.ts.net",
      sessionToken: "hosted-session-token",
      fetch: fetcher as typeof fetch,
      webSocketFactory: (url) => {
        expect(url).toBe(`wss://host.tailnet.ts.net/api/v1/events?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`);
        return socket as unknown as WebSocket;
      },
    });

    await client.getSnapshot();
    expect(fetcher).toHaveBeenCalledWith("https://host.tailnet.ts.net/api/v1/rpc", expect.objectContaining({
      credentials: "omit",
      headers: expect.objectContaining({ Authorization: "Bearer hosted-session-token" }),
    }));

    const unsubscribe = client.onRunEvent(vi.fn());
    socket.readyState = 1;
    emit("open");
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ type: "authenticate", token: "hosted-session-token" });
    expect(sent).toHaveLength(1);
    emit("message", { data: JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "authenticated",
      requestId: "request-id",
      session: {
        id: "session-1",
        label: "Hosted browser",
        scopes: ["state:read"],
        createdAt: "2026-07-16T00:00:00.000Z",
        expiresAt: "2026-10-14T00:00:00.000Z",
        lastUsedAt: "2026-07-16T00:00:00.000Z",
        revokedAt: null,
        clientOrigin: "https://buildwarden.example.com",
      },
    }) });
    expect(JSON.parse(sent[1] ?? "{}")).toMatchObject({ type: "subscribe", events: ["run"] });
    unsubscribe();
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
    expect(client.capabilities.mutations).toBe(true);
    expect(onTerminalData).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("subscribes to bounded browser runs and sends browser input only for scoped sessions", async () => {
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
      scopes: ["state:read", "browser:operate"],
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const onBrowserEvent = vi.fn();
    const unsubscribe = client.onRunBrowserEvent(onBrowserEvent, ["run-1"]);

    expect(client.capabilities.browserControl).toBe(true);
    expect(client.capabilities.mutations).toBe(true);
    socket.readyState = 1;
    emit("open");
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({
      type: "subscribe",
      events: ["browser"],
      browserRunIds: ["run-1"],
    });

    emit("message", { data: JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "event",
      sequence: 1,
      event: "browser",
      payload: {
        type: "state",
        runId: "run-2",
        state: {
          runId: "run-2",
          currentUrl: "https://example.com/ignored",
          title: "Ignored",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          inspecting: false,
          viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        },
      },
    }) });
    emit("message", { data: JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "event",
      sequence: 2,
      event: "browser",
      payload: {
        type: "state",
        runId: "run-1",
        state: {
          runId: "run-1",
          currentUrl: "https://example.com/selected",
          title: "Selected",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          inspecting: false,
          viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        },
      },
    }) });
    expect(onBrowserEvent).toHaveBeenCalledOnce();
    expect(onBrowserEvent).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));

    await client.sendRunBrowserInput({
      runId: "run-1",
      input: { type: "wheel", x: 20, y: 30, deltaX: 0, deltaY: 120 },
    });
    expect(JSON.parse(sent.at(-1) ?? "{}")).toMatchObject({
      type: "browser-input",
      runId: "run-1",
      input: { type: "wheel", x: 20, y: 30, deltaX: 0, deltaY: 120 },
    });
    await client.ensureRunBrowser({ runId: "run-1", initialUrl: "about:blank", viewport: { width: 800, height: 600 } });
    const additionalUnsubscribes = Array.from({ length: 7 }, (_, index) =>
      client.onRunBrowserEvent(vi.fn(), [`run-${String(index + 2)}`]));
    expect(() => client.onRunBrowserEvent(vi.fn(), ["run-9"]))
      .toThrow("at most eight runs");
    expect(JSON.parse(sent.at(-1) ?? "{}").browserRunIds).toHaveLength(8);
    additionalUnsubscribes.forEach((dispose) => dispose());
    unsubscribe();

    const readOnlyFetch = vi.fn(async () => rpcResponse(snapshot)) as typeof fetch;
    const readOnlyClient = createRemoteBuildWardenClient({
      fetch: readOnlyFetch,
      scopes: ["state:read"],
    });
    expect(readOnlyClient.capabilities.browserControl).toBe(false);
    await expect(readOnlyClient.sendRunBrowserInput({
      runId: "run-1",
      input: { type: "text", text: "blocked" },
    })).rejects.toThrow("Re-pair the device");
    await expect(readOnlyClient.ensureRunBrowser({
      runId: "run-1",
      initialUrl: "about:blank",
      viewport: { width: 800, height: 600 },
    })).rejects.toThrow("Re-pair the device");
    expect(readOnlyFetch).not.toHaveBeenCalled();
  });
});
