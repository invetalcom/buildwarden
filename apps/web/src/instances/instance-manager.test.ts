/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot, RemoteAccessSession } from "@buildwarden/shared";
import type { BuildWardenClient, RemoteBuildWardenClientOptions } from "@buildwarden/renderer";
import type { InstanceConnection } from "../hosted-connection-store";
import { InstanceManager } from "./instance-manager";

vi.mock("@buildwarden/renderer", () => ({
  createRemoteBuildWardenClient: vi.fn(),
  RemoteSessionExpiredError: class RemoteSessionExpiredError extends Error {},
}));

const session = (id: string): RemoteAccessSession => ({ id, label: "Browser", scopes: ["state:read"], createdAt: "2026-01-01", expiresAt: "2027-01-01", lastUsedAt: "2026-01-01", revokedAt: null, clientOrigin: "https://web.example" });
const connection = (id: string): InstanceConnection => ({ id, name: "Work", hostOrigin: `https://${id}.ts.net`, token: `${id}-token`, session: session(id) });
const snapshot = (): AppSnapshot => ({ projects: [], chats: [], bookmarks: [], chatBookmarks: [], models: [], providerAccounts: [], settings: {}, selectedProjectId: null, selectedRunId: null, selectedChatId: null });
const stubClient = () => {
  const unsubscribe = vi.fn();
  return {
    refreshSnapshot: vi.fn(async () => snapshot()), getAttentionInbox: vi.fn(async () => []),
    getBookmarksWithSteps: vi.fn(async () => []), getChatBookmarksWithSteps: vi.fn(async () => []),
    onRunEvent: vi.fn(() => unsubscribe), onChatEvent: vi.fn(() => unsubscribe), onProjectTaskChanged: vi.fn(() => unsubscribe),
    onProjectLoopChanged: vi.fn(() => unsubscribe), onOrchestrationChanged: vi.fn(() => unsubscribe), onRunForgeRequestChanged: vi.fn(() => unsubscribe),
  };
};
const managers: InstanceManager[] = [];
afterEach(() => { managers.forEach((manager) => manager.stop()); managers.length = 0; });
const setup = (connections = [connection("a"), connection("b")]) => {
  const a = stubClient(); const b = stubClient();
  const options = new Map<string, RemoteBuildWardenClientOptions>();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ session: session("verified"), token: "new-token" })));
  const save = vi.fn<(connection: InstanceConnection) => Promise<void>>().mockResolvedValue(undefined);
  const remove = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
  const createClient = vi.fn((config: RemoteBuildWardenClientOptions = {}) => {
    options.set(config.baseUrl ?? "cookie", config);
    return (config.baseUrl?.includes("b.ts.net") ? b : a) as unknown as BuildWardenClient;
  });
  const manager = new InstanceManager({ read: async () => connections, save, remove, fetch: fetcher, createClient });
  managers.push(manager);
  return { manager, a, b, fetcher, save, remove, options, createClient };
};

describe("instance isolation", () => {
  it("loads healthy hosts independently and retains an offline host's last snapshot", async () => {
    const { manager, a, b } = setup();
    await manager.start(); await Promise.all([manager.refresh("a"), manager.refresh("b")]);
    const previous = manager.getSnapshot().instances[0].snapshot;
    a.refreshSnapshot.mockRejectedValueOnce(new Error("offline"));
    await Promise.all([manager.refresh("a"), manager.refresh("b")]);
    expect(manager.getSnapshot().instances.map((entry) => entry.status)).toEqual(["offline", "online"]);
    expect(manager.getSnapshot().instances[0].snapshot).toBe(previous);
    expect(b.refreshSnapshot).toHaveBeenCalledTimes(2);
    await manager.refresh("a");
    expect(manager.getSnapshot().instances[0].status).toBe("online");
  });
  it("does not wait for a hanging host before publishing the healthy host", async () => {
    const { manager, a } = setup();
    let finish!: (value: AppSnapshot) => void;
    a.refreshSnapshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await manager.start(); await manager.refresh("b");
    expect(manager.getSnapshot().instances[1].status).toBe("online");
    expect(manager.getSnapshot().instances[0].snapshot).toBeNull();
    finish(snapshot()); await manager.refresh("a");
  });
  it("routes credentials and expiry only to the owning instance", async () => {
    const { manager, options, fetcher } = setup();
    await manager.start(); await Promise.all([manager.refresh("a"), manager.refresh("b")]);
    expect(options.get("https://a.ts.net")?.sessionToken).toBe("a-token");
    expect(options.get("https://b.ts.net")?.sessionToken).toBe("b-token");
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Authorization: "Bearer a-token" });
    options.get("https://a.ts.net")?.onSessionExpired?.();
    expect(manager.getSnapshot().instances.map((entry) => entry.status)).toEqual(["pairing-required", "online"]);
    expect(manager.getSnapshot().instances[0].client).toBeNull();
  });
  it("adds hosts without revoking existing sessions and re-pairs an endpoint without changing its ID", async () => {
    const { manager, fetcher, save } = setup();
    await manager.start(); await Promise.all([manager.refresh("a"), manager.refresh("b")]);
    await manager.pair("https://c.ts.net/", "bw-code", "Server");
    expect(manager.getSnapshot().instances).toHaveLength(3);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await manager.pair("https://a.ts.net", "BW-code", "Renamed");
    expect(manager.getSnapshot().instances).toHaveLength(3);
    expect(manager.getSnapshot().instances.find((entry) => entry.connection.id === "a")?.connection.name).toBe("Renamed");
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a", token: "new-token" }));
  });
  it("persists custom names without changing identity or clients", async () => {
    const { manager, save } = setup();
    await manager.start(); await manager.refresh("a");
    const client = manager.getSnapshot().instances[0].client;
    await manager.rename("a", "  Laptop  ");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "a", name: "Laptop" }));
    expect(manager.getSnapshot().instances[0].client).toBe(client);
    await expect(manager.rename("a", "  ")).rejects.toThrow("Enter an instance name");
  });
  it("discards late snapshots after removal and only revokes the removed session", async () => {
    const { manager, a, fetcher, remove } = setup();
    await manager.start(); await Promise.all([manager.refresh("a"), manager.refresh("b")]);
    let finish!: (value: AppSnapshot) => void;
    a.refreshSnapshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = manager.refresh("a");
    await manager.remove("a");
    finish(snapshot()); await pending;
    expect(manager.getSnapshot().instances.map((entry) => entry.connection.id)).toEqual(["b"]);
    expect(remove).toHaveBeenCalledWith("a");
    const deletes = fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0][0])).toContain("a.ts.net");
  });
  it("keeps the registry when optional inbox reads fail", async () => {
    const { manager, a } = setup();
    a.getAttentionInbox.mockRejectedValueOnce(new Error("old host"));
    await manager.start(); await manager.refresh("a");
    expect(manager.getSnapshot().instances[0]).toMatchObject({ status: "online", attentionError: expect.stringContaining("old host") });
  });
  it("does not invalidate a saved session for a transient HTTP failure", async () => {
    const { manager, fetcher, remove } = setup();
    fetcher.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    await manager.start(); await manager.refresh("a");
    expect(manager.getSnapshot().instances[0].status).toBe("offline");
    expect(remove).not.toHaveBeenCalled();
    await manager.refresh("a");
    expect(manager.getSnapshot().instances[0].status).toBe("online");
  });
  it("ignores responses from a stopped lifecycle, including a StrictMode restart", async () => {
    const { manager, a } = setup();
    let finish!: (value: AppSnapshot) => void;
    a.refreshSnapshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await manager.start(); await manager.refresh("b");
    const old = manager.refresh("a");
    manager.stop(); await manager.start(); await manager.refresh("a");
    const fresh = manager.getSnapshot().instances[0].snapshot;
    finish({ ...snapshot(), selectedProjectId: "stale" }); await old;
    expect(manager.getSnapshot().instances[0].snapshot).toBe(fresh);
  });
  it("restores an embedded cookie session without copying cookies into bearer credentials", async () => {
    const client = stubClient();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ session: session("cookie") })));
    const save = vi.fn<(connection: InstanceConnection) => Promise<void>>().mockResolvedValue(undefined);
    const createClient = vi.fn(() => client as unknown as BuildWardenClient);
    const manager = new InstanceManager({ cookieOrigin: "http://localhost:3000", read: async () => [], save, fetch: fetcher, createClient });
    managers.push(manager);
    await manager.start();
    await vi.waitFor(() => expect(manager.getSnapshot().instances[0]?.status).toBe("online"));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cookieSession: true, token: "", hostOrigin: "http://localhost:3000" }));
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: undefined, sessionToken: undefined }));
    expect(fetcher.mock.calls.every(([, init]) => init?.credentials === "same-origin")).toBe(true);
  });
  it("marks only a 401 host as requiring pairing and does not automatically retry it", async () => {
    const { manager, fetcher } = setup();
    fetcher.mockResolvedValueOnce(new Response("Expired", { status: 401 }));
    await manager.start(); await Promise.all([manager.refresh("a"), manager.refresh("b")]);
    expect(manager.getSnapshot().instances.map((entry) => entry.status)).toEqual(["pairing-required", "online"]);
    const count = fetcher.mock.calls.length;
    await manager.refresh("a");
    expect(fetcher.mock.calls).toHaveLength(count);
  });
  it("discards late responses from a session replaced by re-pairing", async () => {
    const { manager, a, options } = setup();
    await manager.start(); await Promise.all([manager.refresh("a"), manager.refresh("b")]);
    const oldExpiry = options.get("https://a.ts.net")?.onSessionExpired;
    let finish!: (value: AppSnapshot) => void;
    a.refreshSnapshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = manager.refresh("a");
    await manager.pair("https://a.ts.net", "BW-code", "Laptop");
    const fresh = manager.getSnapshot().instances.find((entry) => entry.connection.id === "a")?.snapshot;
    finish({ ...snapshot(), selectedProjectId: "stale" }); await pending;
    oldExpiry?.();
    expect(manager.getSnapshot().instances.find((entry) => entry.connection.id === "a")).toMatchObject({ snapshot: fresh, status: "online" });
  });
});
