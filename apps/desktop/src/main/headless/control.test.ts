import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_SETTING_KEYS,
  type NetworkProxySettingsInput,
  type RemoteAccessSession,
  type RemoteAccessStatus,
} from "@buildwarden/shared";
import { createHostControlClient } from "./control-client";
import { createHostControlHandlers, type HostControlDependencies } from "./control-handlers";
import { controlSocketPath, HostNotRunningError, MAX_CONTROL_MESSAGE_BYTES } from "./control-protocol";
import { HostControlServer } from "./control-server";

const tailscale: RemoteAccessStatus["tailscale"] = {
  desired: false, state: "available", cliPath: null, backendState: null, dnsName: null, endpoint: null,
  managed: false, verified: false, message: "Local access only.", enableCommand: null,
};

const session = (id: string, overrides: Partial<RemoteAccessSession> = {}): RemoteAccessSession => ({
  id, label: id, scopes: ["state:read"], createdAt: "2026-01-01T00:00:00Z", expiresAt: "2999-01-01T00:00:00Z",
  lastUsedAt: "2026-01-01T00:00:00Z", revokedAt: null, clientOrigin: null, ...overrides,
});

const createDependencies = () => {
  const settings: Record<string, string> = {};
  const saveNetworkProxySettings = vi.fn(async ({ enabled, protocol, host, port, username }: NetworkProxySettingsInput) =>
    ({ enabled, protocol, host, port, username, hasPassword: false }));
  const deps = {
    info: { version: "1.0.0", pid: 1, startedAt: "2026-01-01T00:00:00Z", dataDir: "/data", logDir: "/logs", secretStorage: "test" },
    db: {
      getSettings: () => settings,
      setSetting: (key: string, value: string) => { settings[key] = value; },
      listRemoteAccessSessions: () => [
        session("active"),
        session("revoked", { revokedAt: "2026-01-02T00:00:00Z" }),
        session("expired", { expiresAt: "2020-01-01T00:00:00Z" }),
      ],
    },
    controller: {
      getNetworkProxySettings: async () =>
        ({ enabled: true, protocol: "http" as const, host: "proxy", port: "1", username: "me", hasPassword: true }),
      saveNetworkProxySettings,
      getActiveSessionCounts: () => ({ runs: 2, chats: 1 }),
    },
    remote: {
      getStatus: async () => ({ enabled: true, loopbackUrl: "http://127.0.0.1:47831", tailscale }),
      applyExposure: vi.fn(async () => undefined),
      createPairing: vi.fn(async () => ({ id: "g", code: "CODE", scopes: [], expiresAt: "", createdAt: "" })),
      revokeSession: async () => true,
    },
    backup: { exportTo: vi.fn(async () => undefined), restoreFrom: vi.fn(async () => ({ createdAt: "2026-01-01T00:00:00Z" })) },
    onStop: vi.fn(), onRestart: vi.fn(),
    setup: { db: { listProjects: () => [] } } as unknown as HostControlDependencies["setup"],
  } satisfies HostControlDependencies;
  return { deps, settings, handlers: createHostControlHandlers(deps) };
};

describe("host control handlers", () => {
  it("counts only devices that can still connect", async () => {
    const { handlers } = createDependencies();
    expect(await handlers.status(undefined)).toMatchObject({ pairedDevices: 1, activeRuns: 2, activeChats: 1 });
    expect((await handlers.listSessions(undefined)).map(({ id }) => id)).toEqual(["active"]);
  });

  it("drops the saved password when another proxy is set without one, and keeps it when toggling", async () => {
    const { deps, handlers } = createDependencies();
    await handlers.proxySet({ protocol: "http", host: "other", port: "2", username: "" });
    expect(deps.controller.saveNetworkProxySettings).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, clearSavedPassword: true }));
    await handlers.proxyEnable({ enabled: false });
    const toggled = deps.controller.saveNetworkProxySettings.mock.lastCall![0];
    expect(toggled).toMatchObject({ enabled: false, host: "proxy", username: "me" });
    expect(toggled.clearSavedPassword).toBeUndefined();
  });

  it("stores the exposure before applying it and rejects unknown ones", async () => {
    const { deps, settings, handlers } = createDependencies();
    await handlers.remoteExpose({ exposure: "tailnet" });
    expect(settings[APP_SETTING_KEYS.remoteAccessExposure]).toBe("tailnet");
    expect(deps.remote.applyExposure).toHaveBeenCalledOnce();
    await expect(handlers.remoteExpose({ exposure: "everything" as never })).rejects.toThrow("Choose");
  });

  it("edits trusted origins and only accepts exact ones", async () => {
    const { handlers } = createDependencies();
    expect(await handlers.remoteOrigins({ add: "https://app.example/" })).toEqual(["https://app.example"]);
    await expect(handlers.remoteOrigins({ add: "https://*.example" })).rejects.toThrow("exact HTTPS origin");
    await expect(handlers.remoteOrigins({ remove: "https://other.example" })).rejects.toThrow("not in the list");
    expect(await handlers.remoteOrigins({ remove: "https://app.example" })).toEqual([]);
  });

  it("rejects unknown scopes", async () => {
    const { deps, handlers } = createDependencies();
    await expect(handlers.pair({ scopes: ["root" as never] })).rejects.toThrow("Scopes must come from");
    await expect(handlers.pair({ scopes: [] })).rejects.toThrow("Scopes must come from");
    expect(deps.remote.createPairing).not.toHaveBeenCalled();
  });
});

describe("host control socket", () => {
  let dataDir: string;
  let server: HostControlServer | null = null;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "bw-ctl-")); });
  afterEach(async () => {
    await server?.stop();
    server = null;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const start = async () => {
    const socketPath = controlSocketPath(dataDir);
    const { deps, handlers } = createDependencies();
    server = new HostControlServer({ socketPath, handlers, onError: (error) => { throw error; } });
    await server.start();
    return { socketPath, deps, request: createHostControlClient(socketPath) };
  };

  it("answers requests and reports handler errors", async () => {
    const { request } = await start();
    expect(await request("status")).toMatchObject({ version: "1.0.0" });
    expect(await request("stop")).toBeNull();
    await expect(request("pair", { scopes: ["root" as never] })).rejects.toThrow("Scopes must come from");
    await expect(request("toString" as never)).rejects.toThrow("does not know this command");
  });

  it("reports a host that is not running", async () => {
    await expect(createHostControlClient(controlSocketPath(dataDir))("status")).rejects.toThrow(HostNotRunningError);
  });

  it("survives malformed and abandoned connections", async () => {
    const { socketPath, request } = await start();
    const reply = await new Promise<string>((done) => {
      const socket = createConnection(socketPath, () => socket.write("not json\n"));
      socket.on("data", (data) => done(String(data)));
    });
    expect(JSON.parse(reply)).toMatchObject({ ok: false });
    await new Promise<void>((done) => {
      const socket = createConnection(socketPath, () => socket.end("{\"method\":", () => done()));
    });
    expect(await request("listProjects")).toEqual([]);
  });

  it.each([[0, true], [1, false]])("accepts a message up to the size limit (%d bytes over: %s)", async (extra, accepted) => {
    const { socketPath } = await start();
    const request = JSON.stringify({ method: "listProjects" });
    const reply = await new Promise<string>((done) => {
      let text = "";
      const socket = createConnection(socketPath, () => socket.write(request.padEnd(MAX_CONTROL_MESSAGE_BYTES + extra) + "\n"));
      socket.on("data", (data) => { text += String(data); });
      socket.on("error", () => undefined);
      socket.on("close", () => done(text));
    });
    expect(reply).toBe(accepted ? '{"ok":true,"result":[]}\n' : "");
  });

  it.skipIf(process.platform === "win32")("replaces a stale socket and stays private to the user", async () => {
    const first = await start();
    expect(statSync(dirname(first.socketPath)).mode & 0o777).toBe(0o700);
    await server?.stop();
    writeFileSync(first.socketPath, "");
    expect(await (await start()).request("listProjects")).toEqual([]);
  });
});
