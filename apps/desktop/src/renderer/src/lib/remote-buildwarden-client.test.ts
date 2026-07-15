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
    expect(client.capabilities).toMatchObject({ platform: "web", mutations: false, settings: false, liveEvents: false });
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
});
