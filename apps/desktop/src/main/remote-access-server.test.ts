import { request } from "node:http";
import {
  RemoteAccessServer,
  RemoteOperationRegistry,
  validateNoRemoteArgs,
  type RemoteHostEventSource,
} from "@buildwarden/remote-server";
import {
  REMOTE_ACCESS_HEALTH_PATH,
  REMOTE_ACCESS_INFO_PATH,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  REMOTE_ACCESS_WEBSOCKET_PATH,
  type AppSnapshot,
  type RemoteStreamEvent,
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
    registry.register("getSnapshot", getSnapshot, validateNoRemoteArgs);

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
    }, validateNoRemoteArgs);

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
    operations.register("getSnapshot", async () => emptySnapshot, validateNoRemoteArgs);
    let publishEvent: (event: RemoteStreamEvent) => void = () => undefined;
    const events: RemoteHostEventSource = {
      subscribe(listener) {
        publishEvent = listener;
        return () => {
          publishEvent = () => undefined;
        };
      },
    };
    const server = new RemoteAccessServer({ appVersion: "0.5.5-test", operations, events, port: 0 });
    startedServers.push(server);
    return { server, info: await server.start(), publishEvent: (event: RemoteStreamEvent) => publishEvent(event) };
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

  it("negotiates protocol versions and advertises host capabilities", async () => {
    const { info } = await startServer();

    const response = await fetch(`${info.baseUrl}${REMOTE_ACCESS_INFO_PATH}`, {
      headers: { "X-BuildWarden-Protocol-Version": String(REMOTE_ACCESS_PROTOCOL_VERSION) },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      apiVersion: "v1",
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      minProtocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      maxProtocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      capabilities: ["rpc", "events:run", "events:chat", "events:warning", "events:loop", "events:task"],
      endpoints: { health: REMOTE_ACCESS_HEALTH_PATH, info: REMOTE_ACCESS_INFO_PATH, events: REMOTE_ACCESS_WEBSOCKET_PATH },
    });

    const incompatible = await fetch(`${info.baseUrl}${REMOTE_ACCESS_INFO_PATH}`, {
      headers: { "X-BuildWarden-Protocol-Version": "999" },
    });
    expect(incompatible.status).toBe(426);
  });

  it("validates operation arguments before invoking host methods", async () => {
    const { info } = await startServer();

    const response = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        requestId: "invalid-args",
        method: "getSnapshot",
        args: ["unexpected"],
      }),
    });

    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "invalid-request" } });
  });

  it("streams validated host events over a version-negotiated WebSocket", async () => {
    const { info, publishEvent } = await startServer();
    const socket = new WebSocket(
      `${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`,
    );
    const hello = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
    });
    await expect(hello).resolves.toMatchObject({ type: "hello", protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION });

    const subscribed = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "subscribe",
      requestId: "subscribe-1",
      events: ["task"],
    }));
    await expect(subscribed).resolves.toMatchObject({ type: "subscribed", requestId: "subscribe-1", events: ["task"] });

    const streamed = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    publishEvent({ event: "task", payload: { projectId: "project-1", taskId: "task-1", status: "in_progress" } });
    await expect(streamed).resolves.toMatchObject({
      type: "event",
      event: "task",
      payload: { projectId: "project-1", taskId: "task-1", status: "in_progress" },
    });

    const rejected = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "subscribe",
      requestId: "invalid-subscription",
      events: ["unknown-event"],
    }));
    await expect(rejected).resolves.toMatchObject({
      type: "error",
      requestId: "invalid-subscription",
      code: "invalid-message",
    });
    socket.close();
  });

  it("rejects WebSocket upgrades without a supported protocol version", async () => {
    const { info } = await startServer();
    const socket = new WebSocket(`${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}?protocolVersion=999`);

    const outcome = await new Promise<"opened" | "rejected">((resolve) => {
      socket.addEventListener("open", () => resolve("opened"), { once: true });
      socket.addEventListener("error", () => resolve("rejected"), { once: true });
    });

    expect(outcome).toBe("rejected");
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
