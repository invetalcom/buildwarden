import { request } from "node:http";
import { RemoteAccessServer, RemoteOperationRegistry } from "@buildwarden/remote-server";
import {
  REMOTE_ACCESS_HEALTH_PATH,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  type AppSnapshot,
} from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const emptySnapshot = {
  projects: [],
  providerAccounts: [],
  models: [],
  runs: [],
  chats: [],
  bookmarks: [],
  chatBookmarks: [],
  settings: {},
} as unknown as AppSnapshot;

const startedServers: RemoteAccessServer[] = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => server.stop()));
});

describe("remote operation registry", () => {
  it("dispatches registered DesktopApi operations through the versioned envelope", async () => {
    const registry = new RemoteOperationRegistry();
    const getSnapshot = vi.fn(async () => emptySnapshot);
    registry.register("getSnapshot", getSnapshot);

    const response = await registry.dispatch({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "request-1",
      method: "getSnapshot",
      args: [],
    });

    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(response).toEqual({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "request-1",
      ok: true,
      result: emptySnapshot,
    });
  });

  it("rejects incompatible, unavailable, and failed operations without exposing internals", async () => {
    const onOperationError = vi.fn();
    const registry = new RemoteOperationRegistry(onOperationError);
    registry.register("refreshSnapshot", async () => {
      throw new Error("sensitive internal detail");
    });

    await expect(registry.dispatch({
      protocolVersion: 999,
      requestId: "old-client",
      method: "getSnapshot",
      args: [],
    })).resolves.toMatchObject({ ok: false, error: { code: "protocol-mismatch" } });
    await expect(registry.dispatch({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "missing",
      method: "getSnapshot",
      args: [],
    })).resolves.toMatchObject({ ok: false, error: { code: "method-not-found" } });

    const failed = await registry.dispatch({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "failed",
      method: "refreshSnapshot",
      args: [],
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "operation-failed", message: "The operation failed." } });
    expect(JSON.stringify(failed)).not.toContain("sensitive internal detail");
    expect(onOperationError).toHaveBeenCalledOnce();
  });
});

describe("remote access loopback server", () => {
  const startServer = async () => {
    const operations = new RemoteOperationRegistry();
    operations.register("getSnapshot", async () => emptySnapshot);
    const server = new RemoteAccessServer({ appVersion: "0.5.5-test", operations, port: 0 });
    startedServers.push(server);
    return { server, info: await server.start() };
  };

  it("serves health and registered RPC operations on an ephemeral loopback port", async () => {
    const { info } = await startServer();
    expect(info.host).toBe("127.0.0.1");

    const healthResponse = await fetch(`${info.baseUrl}${REMOTE_ACCESS_HEALTH_PATH}`);
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers.get("access-control-allow-origin")).toBeNull();
    await expect(healthResponse.json()).resolves.toMatchObject({
      status: "ok",
      app: "buildwarden",
      appVersion: "0.5.5-test",
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      scope: "loopback",
      authentication: "not-configured",
    });

    const rpcResponse = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        requestId: "snapshot",
        method: "getSnapshot",
        args: [],
      }),
    });
    expect(rpcResponse.status).toBe(200);
    await expect(rpcResponse.json()).resolves.toMatchObject({ ok: true, requestId: "snapshot", result: emptySnapshot });
  });

  it("rejects non-loopback Host headers to guard against DNS rebinding", async () => {
    const { info } = await startServer();

    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({
        hostname: info.host,
        port: info.port,
        path: REMOTE_ACCESS_HEALTH_PATH,
        headers: { Host: "attacker.example" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      req.on("error", reject);
      req.end();
    });

    expect(statusCode).toBe(421);
  });

  it("rejects browser origins until authentication and web access are implemented", async () => {
    const { info } = await startServer();

    const response = await fetch(`${info.baseUrl}${REMOTE_ACCESS_HEALTH_PATH}`, {
      headers: { Origin: "https://attacker.example" },
    });

    expect(response.status).toBe(403);
  });
});
