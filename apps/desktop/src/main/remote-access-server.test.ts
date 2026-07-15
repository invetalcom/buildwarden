import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { RemoteAccessServer, RemoteAuthService, RemoteOperationRegistry } from "@buildwarden/remote-server";
import {
  REMOTE_ACCESS_HEALTH_PATH,
  REMOTE_ACCESS_PAIRING_PATH,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  REMOTE_ACCESS_SESSION_PATH,
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
const databases: Array<{ db: BuildWardenDatabase; directory: string }> = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => server.stop()));
  await Promise.all(databases.splice(0).map(async ({ db, directory }) => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }));
});

const createDatabase = async (): Promise<BuildWardenDatabase> => {
  const directory = await mkdtemp(join(tmpdir(), "buildwarden-remote-auth-"));
  const db = new BuildWardenDatabase(join(directory, "test.sqlite"));
  await db.init();
  databases.push({ db, directory });
  return db;
};

const rpcBody = (requestId = "snapshot") => JSON.stringify({
  protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
  requestId,
  method: "getSnapshot",
  args: [],
});

describe("remote operation registry", () => {
  it("dispatches registered DesktopApi operations through the versioned scoped envelope", async () => {
    const registry = new RemoteOperationRegistry();
    const getSnapshot = vi.fn(async () => emptySnapshot);
    registry.register("getSnapshot", getSnapshot);

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
    });

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
});

describe("remote access authentication", () => {
  const startServer = async () => {
    const db = await createDatabase();
    const auth = new RemoteAuthService({ store: db, credentialKey: new Uint8Array(32).fill(7) });
    const operations = new RemoteOperationRegistry();
    operations.register("getSnapshot", async () => emptySnapshot);
    const server = new RemoteAccessServer({ appVersion: "0.5.5-test", operations, auth, port: 0 });
    startedServers.push(server);
    return { auth, db, info: await server.start() };
  };

  const pair = async (baseUrl: string, auth: RemoteAuthService) => {
    const grant = auth.createPairingGrant();
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
    await expect(healthResponse.json()).resolves.toMatchObject({
      status: "ok",
      app: "buildwarden",
      appVersion: "0.5.5-test",
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      scope: "loopback",
      authentication: "required",
    });

    const unauthorized = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rpcBody("unauthorized"),
    });
    expect(unauthorized.status).toBe(401);

    const { response, cookie } = await pair(info.baseUrl, auth);
    expect(response.status).toBe(201);
    expect(cookie).toContain("buildwarden_session=");

    const rpcResponse = await fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: rpcBody(),
    });
    expect(rpcResponse.status).toBe(200);
    await expect(rpcResponse.json()).resolves.toMatchObject({ ok: true, requestId: "snapshot", result: emptySnapshot });
  });

  it("rejects replayed pairing codes and revoked sessions", async () => {
    const { auth, info } = await startServer();
    const { grant, cookie, response } = await pair(info.baseUrl, auth);
    expect(response.status).toBe(201);

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

    const crossOrigin = await fetch(`${info.baseUrl}${REMOTE_ACCESS_HEALTH_PATH}`, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(crossOrigin.status).toBe(403);
  });
});
