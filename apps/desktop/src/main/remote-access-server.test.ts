import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import WebSocket from "ws";
import {
  RemoteAccessServer,
  RemoteAuthService,
  RemoteOperationRegistry,
  validateNoRemoteArgs,
  type RemoteHostEventSource,
} from "@buildwarden/remote-server";
import {
  REMOTE_ACCESS_HEALTH_PATH,
  REMOTE_ACCESS_INFO_PATH,
  REMOTE_ACCESS_PAIRING_PATH,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  REMOTE_ACCESS_SESSION_PATH,
  REMOTE_ACCESS_WEBSOCKET_PATH,
  type AppSnapshot,
  type RemoteAccessPairingInput,
  type RemoteApiMethod,
  type RemoteStreamEvent,
} from "@buildwarden/shared";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

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
const databases: Array<{ db: BuildWardenDatabase; directory: string }> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => server.stop()));
  await Promise.all(databases.splice(0).map(async ({ db, directory }) => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createDatabase = async (): Promise<BuildWardenDatabase> => {
  const directory = await mkdtemp(join(tmpdir(), "buildwarden-remote-auth-"));
  const db = new BuildWardenDatabase(join(directory, "test.sqlite"));
  await db.init();
  databases.push({ db, directory });
  return db;
};

const reopenDatabase = async (db: BuildWardenDatabase): Promise<BuildWardenDatabase> => {
  const tracked = databases.find((entry) => entry.db === db);
  await db.close();
  const reopened = new BuildWardenDatabase(db.getFilePath());
  await reopened.init();
  if (tracked) {
    tracked.db = reopened;
  }
  return reopened;
};

const rpcBody = (requestId = "snapshot") => JSON.stringify({
  protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
  requestId,
  method: "getSnapshot",
  args: [],
});

describe("remote operation registry", () => {
  it("limits the typed transport contract to explicitly supported operations", () => {
    expectTypeOf<RemoteApiMethod>().toEqualTypeOf<
      | "getSnapshot"
      | "refreshSnapshot"
      | "getProjectBranches"
      | "getProjectCurrentBranch"
      | "getRunDetail"
      | "getRunWorktreeDiff"
      | "getRunWorkspaceFile"
      | "getProjectLoopUiReviewImage"
      | "getChatDetail"
      | "listChatsWithSteps"
      | "getBookmarksWithSteps"
      | "getChatBookmarksWithSteps"
    >();
  });

  it("dispatches registered DesktopApi operations through the versioned scoped envelope", async () => {
    const registry = new RemoteOperationRegistry();
    const getSnapshot = vi.fn(async () => emptySnapshot);
    registry.register("getSnapshot", getSnapshot, validateNoRemoteArgs);

    const response = await registry.dispatch({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "request-1",
      method: "getSnapshot",
      args: [],
    }, ["state:read"]);

    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(response).toEqual({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "request-1",
      ok: true,
      result: emptySnapshot,
    });
  });

  it("rejects incompatible, unavailable, under-scoped, and failed operations without exposing internals", async () => {
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
    }, ["state:read"])).resolves.toMatchObject({ ok: false, error: { code: "protocol-mismatch" } });
    await expect(registry.dispatch({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "missing",
      method: "getSnapshot",
      args: [],
    }, ["state:read"])).resolves.toMatchObject({ ok: false, error: { code: "method-not-found" } });
    await expect(registry.dispatch({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "under-scoped",
      method: "refreshSnapshot",
      args: [],
    }, [])).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });

    const failed = await registry.dispatch({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "failed",
      method: "refreshSnapshot",
      args: [],
    }, ["state:read"]);
    expect(failed).toMatchObject({ ok: false, error: { code: "operation-failed", message: "The operation failed." } });
    expect(JSON.stringify(failed)).not.toContain("sensitive internal detail");
    expect(onOperationError).toHaveBeenCalledOnce();
  });

  it("persists mutation idempotency and replays a completed command only for the same payload", async () => {
    let db = await createDatabase();
    const mutation = vi.fn(async () => emptySnapshot);
    const registry = new RemoteOperationRegistry(undefined, db);
    registry.register("refreshSnapshot", mutation, validateNoRemoteArgs, "admin", true);
    registry.register("getSnapshot", mutation, validateNoRemoteArgs, "admin", true);
    const request = {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "mutation-1",
      idempotencyKey: "command-0001",
      method: "refreshSnapshot" as const,
      args: [],
    };

    await expect(registry.dispatch(request, ["admin"], "session-1")).resolves.toMatchObject({ ok: true });
    db = await reopenDatabase(db);
    const replayRegistry = new RemoteOperationRegistry(undefined, db);
    replayRegistry.register("refreshSnapshot", mutation, validateNoRemoteArgs, "admin", true);
    replayRegistry.register("getSnapshot", mutation, validateNoRemoteArgs, "admin", true);

    await expect(replayRegistry.dispatch({ ...request, requestId: "mutation-retry" }, ["admin"], "session-1"))
      .resolves.toMatchObject({ ok: true, requestId: "mutation-retry" });
    await expect(replayRegistry.dispatch({ ...request, requestId: "mutation-conflict", method: "getSnapshot" }, ["admin"], "session-1"))
      .resolves.toMatchObject({ ok: false, error: { code: "idempotency-conflict" } });
    await expect(replayRegistry.dispatch({ ...request, requestId: "mutation-missing", idempotencyKey: undefined }, ["admin"], "session-1"))
      .resolves.toMatchObject({ ok: false, error: { code: "idempotency-required" } });

    expect(mutation).toHaveBeenCalledOnce();
    expect(db.getRemoteCommandIdempotency("session-1", "command-0001")?.completedAt).not.toBeNull();
  });

  it("reports an in-progress idempotent command instead of starting a concurrent duplicate", async () => {
    const db = await createDatabase();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const mutation = vi.fn(async () => {
      await pending;
      return emptySnapshot;
    });
    const registry = new RemoteOperationRegistry(undefined, db);
    registry.register("refreshSnapshot", mutation, validateNoRemoteArgs, "admin", true);
    const request = {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "pending-1",
      idempotencyKey: "command-pending",
      method: "refreshSnapshot" as const,
      args: [],
    };

    const first = registry.dispatch(request, ["admin"], "session-1");
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce());
    await expect(registry.dispatch({ ...request, requestId: "pending-retry" }, ["admin"], "session-1"))
      .resolves.toMatchObject({ ok: false, error: { code: "command-in-progress" } });
    finish();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(mutation).toHaveBeenCalledOnce();
  });

  it("reports a failed idempotency completion instead of silently returning success", async () => {
    const db = await createDatabase();
    const completion = vi.spyOn(db, "completeRemoteCommandIdempotency").mockReturnValue(false);
    const onOperationError = vi.fn();
    const registry = new RemoteOperationRegistry(onOperationError, db);
    registry.register("refreshSnapshot", async () => emptySnapshot, validateNoRemoteArgs, "admin", true);

    const response = await registry.dispatch({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "completion-failed",
      idempotencyKey: "command-failed-completion",
      method: "refreshSnapshot",
      args: [],
    }, ["admin"], "session-1");

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "operation-failed",
        message: "The command completed, but its replay result could not be persisted.",
      },
    });
    expect(completion).toHaveBeenCalledOnce();
    expect(onOperationError).toHaveBeenCalledWith(expect.objectContaining({
      method: "refreshSnapshot",
      requestId: "completion-failed",
      error: expect.any(Error),
    }));
  });
});

describe("remote access authentication", () => {
  const startServer = async (staticRoot?: string) => {
    const db = await createDatabase();
    const auth = new RemoteAuthService({ store: db, credentialKey: new Uint8Array(32).fill(7) });
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
    const server = new RemoteAccessServer({ appVersion: "0.5.5-test", operations, events, auth, port: 0, staticRoot });
    startedServers.push(server);
    return {
      auth,
      db,
      server,
      info: await server.start(),
      publishEvent: (event: RemoteStreamEvent) => publishEvent(event),
    };
  };

  const pair = async (baseUrl: string, auth: RemoteAuthService, input: RemoteAccessPairingInput = {}) => {
    const grant = auth.createPairingGrant(input);
    const response = await fetch(`${baseUrl}${REMOTE_ACCESS_PAIRING_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: grant.code, label: "Test browser" }),
    });
    return { grant, response, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
  };

  it("keeps health public but requires a paired session for RPC", async () => {
    const { auth, info } = await startServer();
    expect(info.host).toBe("127.0.0.1");

    const healthResponse = await fetch(`${info.baseUrl}${REMOTE_ACCESS_HEALTH_PATH}`);
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers.get("access-control-allow-origin")).toBeNull();
    expect(healthResponse.headers.get("content-security-policy")).toContain("default-src 'none'");
    await expect(healthResponse.json()).resolves.toMatchObject({
      status: "ok",
      app: "buildwarden",
      appVersion: "0.5.5-test",
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      scope: "loopback",
      authentication: "session",
    });

    const unauthorized = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rpcBody("unauthorized"),
    });
    expect(unauthorized.status).toBe(401);

    const { cookie: underScopedCookie } = await pair(info.baseUrl, auth, { scopes: ["chat:operate"] });
    const underScoped = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: underScopedCookie },
      body: rpcBody("under-scoped"),
    });
    expect(underScoped.status).toBe(200);
    await expect(underScoped.json()).resolves.toMatchObject({
      ok: false,
      requestId: "under-scoped",
      error: { code: "forbidden" },
    });

    const { response, cookie } = await pair(info.baseUrl, auth);
    expect(response.status).toBe(201);
    expect(cookie).toContain("buildwarden_session=");

    const sessionResponse = await fetch(`${info.baseUrl}${REMOTE_ACCESS_SESSION_PATH}`, {
      headers: { Cookie: cookie },
    });
    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.not.toHaveProperty("session.scopesJson");

    const rpcResponse = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: rpcBody(),
    });
    expect(rpcResponse.status).toBe(200);
    await expect(rpcResponse.json()).resolves.toMatchObject({ ok: true, requestId: "snapshot", result: emptySnapshot });
  });

  it("serves the shared web client without exposing authenticated APIs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildwarden-remote-web-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "assets"), { recursive: true });
    await writeFile(join(directory, "index.html"), "<!doctype html><title>BuildWarden Remote</title>", "utf8");
    await writeFile(join(directory, "assets", "app.js"), "console.log('remote');", "utf8");
    const { info } = await startServer(directory);

    const indexResponse = await fetch(`${info.baseUrl}/`);
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(indexResponse.headers.get("cache-control")).toBe("no-store");
    await expect(indexResponse.text()).resolves.toContain("BuildWarden Remote");

    const assetResponse = await fetch(`${info.baseUrl}/assets/app.js`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("content-type")).toContain("text/javascript");
    expect(assetResponse.headers.get("cache-control")).toContain("immutable");

    const sessionResponse = await fetch(`${info.baseUrl}${REMOTE_ACCESS_SESSION_PATH}`);
    expect(sessionResponse.status).toBe(401);
  });

  it("serializes concurrent lifecycle transitions without orphaning an ephemeral server", async () => {
    const db = await createDatabase();
    const auth = new RemoteAuthService({ store: db, credentialKey: new Uint8Array(32).fill(13) });
    const operations = new RemoteOperationRegistry();
    operations.register("getSnapshot", async () => emptySnapshot, validateNoRemoteArgs);
    const server = new RemoteAccessServer({ appVersion: "0.5.5-test", operations, auth, port: 0 });
    startedServers.push(server);

    const firstStart = server.start();
    const concurrentStart = server.start();
    expect(concurrentStart).toBe(firstStart);
    const [firstInfo, concurrentInfo] = await Promise.all([firstStart, concurrentStart]);
    expect(concurrentInfo).toBe(firstInfo);

    const stopping = server.stop();
    const concurrentStop = server.stop();
    const restartAfterStop = server.start();
    expect(concurrentStop).toBe(stopping);
    await stopping;
    const restartedInfo = await restartAfterStop;

    expect(server.getInfo()).toBe(restartedInfo);
    expect(restartedInfo.port).toBeGreaterThan(0);
    await expect(fetch(`${restartedInfo.baseUrl}${REMOTE_ACCESS_HEALTH_PATH}`)).resolves.toMatchObject({ status: 200 });
  });

  it("negotiates protocol versions and advertises host capabilities", async () => {
    const { auth, info } = await startServer();
    const { cookie } = await pair(info.baseUrl, auth);

    const unauthorized = await fetch(`${info.baseUrl}${REMOTE_ACCESS_INFO_PATH}`);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`${info.baseUrl}${REMOTE_ACCESS_INFO_PATH}`, {
      headers: {
        "X-BuildWarden-Protocol-Version": String(REMOTE_ACCESS_PROTOCOL_VERSION),
        Cookie: cookie,
      },
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
      headers: { "X-BuildWarden-Protocol-Version": "999", Cookie: cookie },
    });
    expect(incompatible.status).toBe(426);
  });

  it("validates operation arguments before invoking host methods", async () => {
    const { auth, info } = await startServer();
    const { cookie } = await pair(info.baseUrl, auth);

    const response = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        requestId: "invalid-args",
        method: "getSnapshot",
        args: ["unexpected"],
      }),
    });

    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "invalid-request" } });
  });

  it("separates malformed and oversized request bodies from internal failures", async () => {
    const { auth, info } = await startServer();
    const { cookie } = await pair(info.baseUrl, auth);

    const malformed = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "Invalid JSON request body." });

    const oversized = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "x".repeat(1_048_577),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "Request body is too large." });

    const internalError = new Error("unexpected dispatch failure");
    const onServerError = vi.fn();
    const db = await createDatabase();
    const internalAuth = new RemoteAuthService({ store: db, credentialKey: new Uint8Array(32).fill(17) });
    const operations = new RemoteOperationRegistry(() => {
      throw internalError;
    });
    operations.register("getSnapshot", async () => {
      throw new Error("operation failure");
    }, validateNoRemoteArgs);
    const server = new RemoteAccessServer({
      appVersion: "0.5.5-test",
      operations,
      auth: internalAuth,
      onServerError,
      port: 0,
    });
    startedServers.push(server);
    const internalInfo = await server.start();
    const { cookie: internalCookie } = await pair(internalInfo.baseUrl, internalAuth);
    const failed = await fetch(`${internalInfo.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: internalCookie },
      body: rpcBody("internal-failure"),
    });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: "Internal server error." });
    expect(onServerError).toHaveBeenCalledWith(internalError);
  });

  it("streams validated host events over a version-negotiated WebSocket", async () => {
    const { auth, info, publishEvent } = await startServer();
    const { cookie } = await pair(info.baseUrl, auth);
    const socket = new WebSocket(
      `${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`,
      { headers: { Cookie: cookie } },
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

  it("rejects unauthorized and under-scoped WebSocket upgrades", async () => {
    const { auth, info } = await startServer();
    const webSocketUrl = `${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`;
    const unauthorized = new WebSocket(webSocketUrl);
    const unauthorizedStatus = await new Promise<number>((resolve) => {
      unauthorized.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    });
    expect(unauthorizedStatus).toBe(401);

    const grant = auth.createPairingGrant({ scopes: ["chat:operate"] });
    const pairingResponse = await fetch(`${info.baseUrl}${REMOTE_ACCESS_PAIRING_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: grant.code, label: "Under-scoped browser" }),
    });
    const cookie = pairingResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const underScoped = new WebSocket(webSocketUrl, { headers: { Cookie: cookie } });
    const underScopedStatus = await new Promise<number>((resolve) => {
      underScoped.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    });
    expect(underScopedStatus).toBe(403);
  });

  it("closes an established WebSocket after its session is revoked", async () => {
    const { auth, info } = await startServer();
    const { cookie } = await pair(info.baseUrl, auth);
    const socket = new WebSocket(
      `${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`,
      { headers: { Cookie: cookie } },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const session = auth.listSessions()[0];
    expect(session).toBeDefined();
    auth.revokeSession(session!.id);
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "ping",
      requestId: "after-revoke",
    }));

    await expect(closed).resolves.toBe(1008);
  });

  it("rejects replayed pairing codes and revoked sessions", async () => {
    const { auth, db, info } = await startServer();
    const { grant, cookie, response } = await pair(info.baseUrl, auth);
    expect(response.status).toBe(201);
    const sessionToken = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
    expect(JSON.stringify({ sessions: db.listRemoteAccessSessions(), audit: db.listRemoteAccessAuditRecords() }))
      .not.toContain(sessionToken);

    const replay = await fetch(`${info.baseUrl}${REMOTE_ACCESS_PAIRING_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: grant.code }),
    });
    expect(replay.status).toBe(401);

    const logout = await fetch(`${info.baseUrl}${REMOTE_ACCESS_SESSION_PATH}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(logout.status).toBe(200);

    const revoked = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: rpcBody("revoked"),
    });
    expect(revoked.status).toBe(401);
  });

  it("rejects expired pairing grants and records redacted security audits", async () => {
    const db = await createDatabase();
    let now = new Date("2026-07-15T10:00:00.000Z");
    const auth = new RemoteAuthService({
      store: db,
      credentialKey: new Uint8Array(32).fill(9),
      now: () => now,
      pairingTtlMs: 1_000,
    });
    const grant = auth.createPairingGrant();
    now = new Date("2026-07-15T10:00:02.000Z");

    expect(auth.exchangePairingCode(grant.code, "Expired browser", "127.0.0.1")).toBeNull();
    const serializedState = JSON.stringify({
      sessions: db.listRemoteAccessSessions(),
      audit: db.listRemoteAccessAuditRecords(),
    });
    expect(serializedState).not.toContain(grant.code);
    expect(db.listRemoteAccessAuditRecords()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "pairing-created", outcome: "success" }),
      expect.objectContaining({ event: "pairing-failed", outcome: "failure" }),
    ]));
  });

  it("rejects expired sessions", async () => {
    const db = await createDatabase();
    let now = new Date("2026-07-15T10:00:00.000Z");
    const auth = new RemoteAuthService({
      store: db,
      credentialKey: new Uint8Array(32).fill(11),
      now: () => now,
      sessionTtlMs: 1_000,
    });
    const grant = auth.createPairingGrant();
    const authenticated = auth.exchangePairingCode(grant.code, "Short session", "127.0.0.1");
    expect(authenticated).not.toBeNull();
    now = new Date("2026-07-15T10:00:02.000Z");

    expect(auth.authenticate(authenticated?.token ?? "", "127.0.0.1")).toBeNull();
  });

  it("periodically prunes retained remote-access records without reclaiming incomplete commands", async () => {
    const db = await createDatabase();
    let now = new Date("2026-07-15T10:00:00.000Z");
    const oldTimestamp = "2025-01-01T00:00:00.000Z";
    const addOldRecords = (suffix: string) => {
      db.createRemoteAccessPairingGrant({
        id: `pairing-${suffix}`,
        tokenHash: `pairing-hash-${suffix}`,
        scopes: ["state:read"],
        expiresAt: oldTimestamp,
        usedAt: oldTimestamp,
        createdAt: oldTimestamp,
      });
      db.addRemoteAccessAuditRecord({
        id: `audit-${suffix}`,
        event: "pairing-failed",
        outcome: "failure",
        sessionId: null,
        pairingGrantId: null,
        remoteAddress: null,
        details: null,
        createdAt: oldTimestamp,
      });
      db.createRemoteCommandIdempotency({
        sessionId: "session-retention",
        idempotencyKey: `completed-${suffix}`,
        method: "refreshSnapshot",
        requestHash: `completed-hash-${suffix}`,
        responseJson: "{}",
        createdAt: oldTimestamp,
        completedAt: oldTimestamp,
      });
    };
    addOldRecords("startup");
    db.createRemoteCommandIdempotency({
      sessionId: "session-retention",
      idempotencyKey: "incomplete-command",
      method: "refreshSnapshot",
      requestHash: "incomplete-hash",
      responseJson: null,
      createdAt: oldTimestamp,
      completedAt: null,
    });

    const auth = new RemoteAuthService({
      store: db,
      credentialKey: new Uint8Array(32).fill(19),
      now: () => now,
      cleanupIntervalMs: 60_000,
    });
    expect(db.listRemoteAccessAuditRecords()).toEqual([]);
    expect(db.getRemoteCommandIdempotency("session-retention", "completed-startup")).toBeNull();
    expect(db.getRemoteCommandIdempotency("session-retention", "incomplete-command")).not.toBeNull();

    addOldRecords("periodic");
    expect(db.listRemoteAccessAuditRecords()).toHaveLength(1);
    now = new Date("2026-07-15T10:02:00.000Z");
    auth.listSessions();
    expect(db.listRemoteAccessAuditRecords()).toEqual([]);
    expect(db.getRemoteCommandIdempotency("session-retention", "completed-periodic")).toBeNull();
    expect(db.getRemoteCommandIdempotency("session-retention", "incomplete-command")).not.toBeNull();
  });

  it("rate limits repeated pairing attempts", async () => {
    const { info } = await startServer();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(`${info.baseUrl}${REMOTE_ACCESS_PAIRING_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: `invalid-${String(attempt)}` }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("rejects non-loopback Host headers and cross-origin browser requests", async () => {
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

    const wrongPortStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({
        hostname: info.host,
        port: info.port,
        path: REMOTE_ACCESS_HEALTH_PATH,
        headers: { Host: `${info.host}:1` },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    expect(wrongPortStatus).toBe(421);

    const crossOrigin = await fetch(`${info.baseUrl}${REMOTE_ACCESS_HEALTH_PATH}`, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(crossOrigin.status).toBe(403);

    const sameOrigin = await fetch(`${info.baseUrl}${REMOTE_ACCESS_HEALTH_PATH}`, {
      headers: { Origin: info.baseUrl },
    });
    expect(sameOrigin.status).toBe(200);

    const webSocketUrl = `${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}` +
      `?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`;
    const wrongHostSocket = new WebSocket(webSocketUrl, {
      headers: { Host: `${info.host}:1` },
    });
    const wrongHostUpgradeStatus = await new Promise<number>((resolve, reject) => {
      wrongHostSocket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      wrongHostSocket.once("open", () => {
        wrongHostSocket.close();
        reject(new Error("WebSocket upgrade unexpectedly accepted the mismatched Host header."));
      });
      wrongHostSocket.once("error", reject);
    });
    expect(wrongHostUpgradeStatus).toBe(421);

    const crossOriginSocket = new WebSocket(webSocketUrl, {
      headers: { Origin: "https://attacker.example" },
    });
    const crossOriginUpgradeStatus = await new Promise<number>((resolve, reject) => {
      crossOriginSocket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      crossOriginSocket.once("open", () => {
        crossOriginSocket.close();
        reject(new Error("WebSocket upgrade unexpectedly accepted the cross-origin request."));
      });
      crossOriginSocket.once("error", reject);
    });
    expect(crossOriginUpgradeStatus).toBe(403);
  });
});
