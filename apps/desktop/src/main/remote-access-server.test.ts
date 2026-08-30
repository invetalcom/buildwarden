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
  projectRemoteStreamEvent,
  shouldCompressRemoteWebSocketMessage,
  validateNoRemoteArgs,
  type RemoteAccessServerOptions,
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
  type RemoteWebSocketServerMessage,
  type RunBrowserInput,
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

/** Fixed ceilings for deliberately repetitive fixtures, guarding the remote transport against regressions. */
const REMOTE_TRANSFER_BUDGETS = {
  brotliJsonRatio: 0.02,
  gzipJsonRatio: 0.02,
  brotliStaticRatio: 0.02,
  projectedLiveEventBytes: 4_096,
  projectedLiveEventRatio: 0.05,
} as const;

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
      | "getNetworkProxySettings"
      | "getProjectBranches"
      | "getProjectCurrentBranch"
      | "queryProjectActivity"
      | "checkProjectFolderGitStatus"
      | "getRunDetail"
      | "getEarlierRunHistory"
      | "getOrchestrationDetail"
      | "getOrchestrationTaskDetail"
      | "getOrchestrationAdoptionPreview"
      | "getRunDeletionImpact"
      | "getModelDeletionImpact"
      | "getRunWorktreeDiff"
      | "getRunWorktreeDiffSummary"
      | "getRunWorkspaceFile"
      | "getProjectLoopUiReviewImage"
      | "getProjectLoopDetail"
      | "getProjectLoopAvailability"
      | "getRunChat"
      | "getChatDetail"
      | "getEarlierChatHistory"
      | "listChatsWithSteps"
      | "getBookmarksWithSteps"
      | "getChatBookmarksWithSteps"
      | "getRunPublishOptions"
      | "getProjectBranchOverview"
      | "getProjectTask"
      | "getProjectAutomation"
      | "getProjectForgeAuthStatus"
      | "getProjectForgePrMonitorSettings"
      | "listProjectForgeRequests"
      | "getProjectForgeRequestDetails"
      | "getProjectForgeRequestStatus"
      | "getRunForgeRequestDetails"
      | "refreshRunForgeRequest"
      | "getRunForgeRequestDiff"
      | "fetchProjectPrMrDiff"
      | "checkProjectGitConversion"
      | "getProjectBranchDeleteImpact"
      | "listHostDirectories"
      | "listAvailableProviderModels"
      | "getAppPaths"
      | "getDetectedCodexInstallation"
      | "getDetectedClaudeInstallation"
      | "getDetectedCursorInstallation"
      | "listIntegratedSkills"
      | "getIntegratedSkillContent"
      | "createRun"
      | "continueRun"
      | "followUpRun"
      | "cancelRun"
      | "cancelRunShell"
      | "resumeRunFromCheckpoint"
      | "recoverInterruptedRun"
      | "undoRunToLastPrompt"
      | "deleteRun"
      | "pauseOrchestration"
      | "resumeOrchestration"
      | "cancelOrchestration"
      | "finishOrchestration"
      | "sendOrchestrationTaskMessage"
      | "retryOrchestrationTask"
      | "decideOrchestrationAdoption"
      | "refreshOrchestrationTeam"
      | "setRunListVisibility"
      | "addBookmark"
      | "removeBookmark"
      | "removeBookmarkById"
      | "addRunNote"
      | "updateRunNote"
      | "deleteRunNote"
      | "respondToShellApproval"
      | "respondToRunUserInput"
      | "createChat"
      | "createRunChat"
      | "followUpChat"
      | "cancelChat"
      | "deleteChat"
      | "addChatBookmark"
      | "removeChatBookmark"
      | "removeChatBookmarkById"
      | "createProjectTask"
      | "updateProjectTask"
      | "deleteProjectTask"
      | "generateProjectTaskRunPrompt"
      | "createProjectAutomation"
      | "updateProjectAutomation"
      | "deleteProjectAutomation"
      | "runProjectAutomationNow"
      | "generateProjectInsight"
      | "runProjectLab"
      | "deleteProjectLabThread"
      | "createProjectLoop"
      | "cancelProjectLoop"
      | "resumeProjectLoop"
      | "deleteProjectLoop"
      | "respondToProjectLoopUiReview"
      | "analyzeProjectPrMrDiff"
      | "postProjectPrMrReview"
      | "submitProjectPrMrComments"
      | "replyProjectPrMrReviewThread"
      | "resolveProjectPrMrReviewThread"
      | "updateProjectForgeRequest"
      | "mergeProjectForgeRequest"
      | "updateRunForgeRequest"
      | "mergeRunForgeRequest"
      | "commitRun"
      | "suggestCommitMessage"
      | "createRunLocalBranch"
      | "suggestRunBranchName"
      | "publishRunBranch"
      | "createRunPullRequest"
      | "suggestRunPullRequestDraft"
      | "suggestRunPullRequestDescription"
      | "checkoutProjectBranch"
      | "fetchProjectBranches"
      | "createProjectBranch"
      | "renameProjectBranch"
      | "deleteProjectBranch"
      | "pullProjectBranch"
      | "pushProjectBranch"
      | "convertProjectToGit"
      | "updateProjectBaseBranch"
      | "addProject"
      | "reorderProjects"
      | "addProviderAccount"
      | "addModel"
      | "deleteProject"
      | "deleteProviderAccount"
      | "deleteModel"
      | "setAppSetting"
      | "saveNetworkProxySettings"
      | "saveProjectForgeAuthToken"
      | "deleteProjectForgeAuthToken"
      | "saveProjectForgePrMonitorSettings"
      | "runTerminalStart"
      | "runTerminalWrite"
      | "runTerminalResize"
      | "runTerminalKill"
      | "ensureRunBrowser"
      | "navigateRunBrowser"
      | "runBrowserAction"
      | "setRunBrowserViewport"
      | "getRunBrowserElementCapture"
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

  it("dispatches model deletion impact requests with their model id", async () => {
    const registry = new RemoteOperationRegistry();
    const impact = {
      modelId: "model-1",
      modelDisplayName: "GPT-5",
      runIds: ["run-1", "run-2"],
      chatIds: ["chat-1"],
      runCount: 2,
      chatCount: 1,
      projectInsightCount: 0,
      projectLabThreadCount: 0,
      projectLoopCount: 0,
      orchestrationCount: 1,
    };
    const getModelDeletionImpact = vi.fn(async () => impact);
    const validateModelId = (args: unknown[]): args is [string] =>
      args.length === 1 && typeof args[0] === "string";
    registry.register("getModelDeletionImpact", getModelDeletionImpact, validateModelId);

    const response = await registry.dispatch({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "model-impact-1",
      method: "getModelDeletionImpact",
      args: ["model-1"],
    }, ["state:read"]);

    expect(getModelDeletionImpact).toHaveBeenCalledWith("model-1");
    expect(response).toMatchObject({ ok: true, result: impact });
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

  it("requires every composite scope for adoption and active-team refresh mutations", async () => {
    const db = await createDatabase();
    const registry = new RemoteOperationRegistry(undefined, db);
    const adoption = vi.fn(async () => undefined);
    const refreshTeam = vi.fn(async () => undefined);
    const validateAdoption = (args: unknown[]): args is [{ taskId: string; decision: "approve" | "reject" | "undo" }] =>
      args.length === 1 && typeof args[0] === "object" && args[0] != null;
    const validateCoordinator = (args: unknown[]): args is [string] =>
      args.length === 1 && typeof args[0] === "string";
    registry.register("decideOrchestrationAdoption", adoption, validateAdoption, ["run:operate", "git:write"], true);
    registry.register("refreshOrchestrationTeam", refreshTeam, validateCoordinator, ["run:operate", "admin"], true);

    const adoptionRequest = {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "adopt-1",
      idempotencyKey: "adoption-command-1",
      method: "decideOrchestrationAdoption" as const,
      args: [{ taskId: "task-1", decision: "approve" as const }],
    };
    await expect(registry.dispatch(adoptionRequest, ["run:operate"], "session-1"))
      .resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
    await expect(registry.dispatch({ ...adoptionRequest, requestId: "adopt-2" }, ["run:operate", "git:write"], "session-1"))
      .resolves.toMatchObject({ ok: true });

    const refreshRequest = {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "refresh-team-1",
      idempotencyKey: "refresh-team-command-1",
      method: "refreshOrchestrationTeam" as const,
      args: ["run-1"],
    };
    await expect(registry.dispatch(refreshRequest, ["run:operate"], "session-1"))
      .resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
    await expect(registry.dispatch({ ...refreshRequest, requestId: "refresh-team-2" }, ["run:operate", "admin"], "session-1"))
      .resolves.toMatchObject({ ok: true });

    expect(adoption).toHaveBeenCalledOnce();
    expect(refreshTeam).toHaveBeenCalledOnce();
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
  const startServer = async (
    staticRoot?: string,
    trustedProxyHosts?: () => readonly string[],
    trustedWebOrigins?: () => readonly string[],
    webSocketAuthenticationTimeoutMs?: number,
    browserOptions: Pick<RemoteAccessServerOptions, "onBrowserInput" | "onBrowserSubscriptionChange" | "onServerError"> = {},
    snapshot: AppSnapshot = emptySnapshot,
  ) => {
    const db = await createDatabase();
    const auth = new RemoteAuthService({ store: db, credentialKey: new Uint8Array(32).fill(7) });
    const operations = new RemoteOperationRegistry();
    operations.register("getSnapshot", async () => snapshot, validateNoRemoteArgs);
    let publishEvent: (event: RemoteStreamEvent) => void = () => undefined;
    const events: RemoteHostEventSource = {
      subscribe(listener) {
        publishEvent = listener;
        return () => {
          publishEvent = () => undefined;
        };
      },
    };
    const server = new RemoteAccessServer({
      appVersion: "0.5.5-test",
      operations,
      events,
      auth,
      port: 0,
      staticRoot,
      trustedProxyHosts,
      trustedWebOrigins,
      webSocketAuthenticationTimeoutMs,
      ...browserOptions,
    });
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

  it("issues origin-bound bearer sessions with exact CORS, private-network preflight, and WebSocket authentication", async () => {
    const hostedOrigin = "https://buildwarden.example.com";
    const otherTrustedOrigin = "https://preview.example.com";
    const { auth, info } = await startServer(undefined, undefined, () => [hostedOrigin, otherTrustedOrigin]);
    const grant = auth.createPairingGrant({ clientOrigin: hostedOrigin, scopes: ["state:read"] });

    const wrongOrigin = await fetch(`${info.baseUrl}${REMOTE_ACCESS_PAIRING_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: otherTrustedOrigin },
      body: JSON.stringify({ code: grant.code, label: "Wrong hosted origin" }),
    });
    expect(wrongOrigin.status).toBe(401);

    const preflight = await fetch(`${info.baseUrl}${REMOTE_ACCESS_PAIRING_PATH}`, {
      method: "OPTIONS",
      headers: {
        Origin: hostedOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(hostedOrigin);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

    const paired = await fetch(`${info.baseUrl}${REMOTE_ACCESS_PAIRING_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: hostedOrigin,
        "Access-Control-Request-Private-Network": "true",
      },
      body: JSON.stringify({ code: grant.code, label: "Hosted browser" }),
    });
    expect(paired.status).toBe(201);
    expect(paired.headers.get("set-cookie")).toBeNull();
    expect(paired.headers.get("access-control-allow-origin")).toBe(hostedOrigin);
    expect(paired.headers.get("access-control-allow-private-network")).toBeNull();
    const pairedPayload = await paired.json() as { token?: string; session: { clientOrigin: string | null } };
    expect(pairedPayload.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pairedPayload.session.clientOrigin).toBe(hostedOrigin);

    const mismatchedSession = await fetch(`${info.baseUrl}${REMOTE_ACCESS_SESSION_PATH}`, {
      headers: { Authorization: `Bearer ${pairedPayload.token ?? ""}`, Origin: otherTrustedOrigin },
    });
    expect(mismatchedSession.status).toBe(401);

    const session = await fetch(`${info.baseUrl}${REMOTE_ACCESS_SESSION_PATH}`, {
      headers: { Authorization: `Bearer ${pairedPayload.token ?? ""}`, Origin: hostedOrigin },
    });
    expect(session.status).toBe(200);

    const socket = new WebSocket(
      `${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`,
      { headers: { Origin: hostedOrigin } },
    );
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(messages).toEqual([]);

    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "authenticate",
      requestId: "hosted-auth",
      token: pairedPayload.token,
    }));
    await vi.waitFor(() => expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "authenticated", requestId: "hosted-auth" }),
      expect.objectContaining({ type: "hello" }),
    ])));
    socket.close();
  });

  it("closes a hosted WebSocket that does not authenticate in time", async () => {
    const hostedOrigin = "https://buildwarden.example.com";
    const { info } = await startServer(undefined, undefined, () => [hostedOrigin], 20);
    const socket = new WebSocket(
      `${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`,
      { headers: { Origin: hostedOrigin } },
    );
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    await expect(closed).resolves.toBe(1008);
  });

  it("serves the shared web client without exposing authenticated APIs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildwarden-remote-web-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "assets"), { recursive: true });
    await writeFile(join(directory, "index.html"), "<!doctype html><title>BuildWarden Remote</title>", "utf8");
    const assetBody = "console.log('compressible remote asset');\n".repeat(4_000);
    await writeFile(join(directory, "assets", "app-ABC12345.js"), assetBody, "utf8");
    await writeFile(join(directory, "manifest.webmanifest"), "{\"name\":\"BuildWarden\"}", "utf8");
    const { info } = await startServer(directory);

    const indexResponse = await fetch(`${info.baseUrl}/`);
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(indexResponse.headers.get("cache-control")).toBe("no-cache");
    await expect(indexResponse.text()).resolves.toContain("BuildWarden Remote");

    const assetResponse = await fetch(`${info.baseUrl}/assets/app-ABC12345.js`, { headers: { "Accept-Encoding": "br" } });
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("content-type")).toContain("text/javascript");
    expect(assetResponse.headers.get("cache-control")).toContain("immutable");
    expect(assetResponse.headers.get("content-encoding")).toBe("br");
    expect(assetResponse.headers.get("vary")).toContain("Accept-Encoding");
    expect(Number(assetResponse.headers.get("content-length"))).toBeLessThanOrEqual(
      Buffer.byteLength(assetBody) * REMOTE_TRANSFER_BUDGETS.brotliStaticRatio,
    );
    await expect(assetResponse.text()).resolves.toBe(assetBody);

    const headResponse = await fetch(`${info.baseUrl}/assets/app-ABC12345.js`, {
      method: "HEAD",
      headers: { "Accept-Encoding": "identity" },
    });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("content-length")).toBe(String(Buffer.byteLength(assetBody)));
    await expect(headResponse.text()).resolves.toBe("");

    const manifestResponse = await fetch(`${info.baseUrl}/manifest.webmanifest`);
    expect(manifestResponse.headers.get("content-type")).toContain("application/manifest+json");
    expect(manifestResponse.headers.get("cache-control")).toBe("no-cache");

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
      capabilities: [
        "rpc",
        "events:run",
        "events:chat",
        "events:warning",
        "events:loop",
        "events:task",
        "events:terminal",
        "events:browser",
        "events:forge",
      ],
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

  it("compresses large JSON RPC responses with negotiated Brotli or gzip", async () => {
    const largeSnapshot = {
      ...emptySnapshot,
      settings: { largeFixture: "compressible-buildwarden-data-".repeat(8_000) },
    } satisfies AppSnapshot;
    const { auth, info } = await startServer(undefined, undefined, undefined, undefined, {}, largeSnapshot);
    const { cookie } = await pair(info.baseUrl, auth);
    const fetchSnapshot = (acceptEncoding: string) => fetch(`${info.baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      headers: {
        "Accept-Encoding": acceptEncoding,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: rpcBody(`compression-${acceptEncoding.replace(/\W/g, "-")}`),
    });

    const identity = await fetchSnapshot("identity");
    const gzipResponse = await fetchSnapshot("gzip");
    const brotliResponse = await fetchSnapshot("br, gzip;q=0.8");
    const refused = await fetchSnapshot("br;q=0, gzip;q=0");

    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(gzipResponse.headers.get("content-encoding")).toBe("gzip");
    expect(brotliResponse.headers.get("content-encoding")).toBe("br");
    expect(refused.headers.get("content-encoding")).toBeNull();
    expect(gzipResponse.headers.get("vary")).toContain("Accept-Encoding");
    const identityBytes = Number(identity.headers.get("content-length"));
    expect(Number(gzipResponse.headers.get("content-length"))).toBeLessThanOrEqual(
      identityBytes * REMOTE_TRANSFER_BUDGETS.gzipJsonRatio,
    );
    expect(Number(brotliResponse.headers.get("content-length"))).toBeLessThanOrEqual(
      identityBytes * REMOTE_TRANSFER_BUDGETS.brotliJsonRatio,
    );
    expect(Number(brotliResponse.headers.get("content-length"))).toBeLessThan(Number(gzipResponse.headers.get("content-length")));
    await expect(brotliResponse.json()).resolves.toMatchObject({ ok: true, result: largeSnapshot });
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
    const onServerError = vi.fn();
    const { auth, info, publishEvent } = await startServer(
      undefined,
      undefined,
      undefined,
      undefined,
      { onServerError },
    );
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
    expect(socket.extensions).toContain("permessage-deflate");
    await expect(hello).resolves.toMatchObject({ type: "hello", protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION });

    const subscribed = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "subscribe",
      requestId: "subscribe-1",
      events: ["task", "forge", "orchestration"],
    }));
    await expect(subscribed).resolves.toMatchObject({
      type: "subscribed",
      requestId: "subscribe-1",
      events: ["task", "forge", "orchestration"],
    });

    const streamed = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    publishEvent({ event: "task", payload: { projectId: "project-1", taskId: "task-1", status: "in_progress" } });
    await expect(streamed).resolves.toMatchObject({
      type: "event",
      event: "task",
      payload: { projectId: "project-1", taskId: "task-1", status: "in_progress" },
    });

    const forgeCleared = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    publishEvent({ event: "forge", payload: { runId: "run-1", projectId: "project-1", forgeRequest: null } });
    await expect(forgeCleared).resolves.toMatchObject({
      type: "event",
      event: "forge",
      payload: { runId: "run-1", projectId: "project-1", forgeRequest: null },
    });

    const forgeUpdated = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    publishEvent({
      event: "forge",
      payload: {
        runId: "run-1",
        projectId: "project-1",
        forgeRequest: {
          provider: "github",
          number: 42,
          title: "Update cards",
          url: "https://github.example.test/org/repo/pull/42",
          state: "open",
          readiness: "ready",
          draft: false,
          mergeability: "mergeable",
          reviewDecision: "none",
          author: "octocat",
          sourceBranch: "feat/update-cards",
          targetBranch: "main",
          headSha: "abc123",
          checks: { completed: 1, total: 1, successful: 1, failed: 0, running: 0 },
          unresolvedThreadCount: 0,
          supportedActions: ["refresh", "open"],
          supportedMergeMethods: ["merge", "squash"],
          updatedAt: "2026-08-13T12:00:00.000Z",
          lastSyncedAt: "2026-08-13T12:00:01.000Z",
          stale: false,
          syncError: null,
        },
      },
    });
    await expect(forgeUpdated).resolves.toMatchObject({
      type: "event",
      event: "forge",
      payload: { runId: "run-1", forgeRequest: { provider: "github", number: 42 } },
    });

    const orchestrationUpdated = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    publishEvent({
      event: "orchestration",
      payload: {
        projectId: "project-1",
        coordinatorRunId: "run-1",
        orchestrationId: "orchestration-1",
        taskId: null,
        status: "active",
        sequence: 0,
      },
    });
    await expect(orchestrationUpdated).resolves.toMatchObject({
      type: "event",
      event: "orchestration",
      payload: { orchestrationId: "orchestration-1", status: "active", sequence: 0 },
    });
    expect(onServerError).not.toHaveBeenCalled();

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

    const forbidden = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "subscribe",
      requestId: "terminal-without-scope",
      events: ["terminal-data", "terminal-exit"],
    }));
    await expect(forbidden).resolves.toMatchObject({
      type: "error",
      requestId: "terminal-without-scope",
      code: "forbidden",
    });
    socket.close();
  });

  it("keeps WebSocket compression optional and skips already-compressed browser frames", async () => {
    const { auth, info } = await startServer();
    const { cookie } = await pair(info.baseUrl, auth);
    const socket = new WebSocket(
      `${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`,
      { headers: { Cookie: cookie }, perMessageDeflate: false },
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
    });
    expect(socket.extensions).toBe("");
    socket.close();

    const frameMessage = {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "event",
      sequence: 1,
      event: "browser",
      payload: {
        type: "frame",
        runId: "run-1",
        frame: { runId: "run-1", sequence: 1, width: 1280, height: 720, mimeType: "image/jpeg", dataBase64: "jpeg" },
      },
    } satisfies RemoteWebSocketServerMessage;
    const runMessage = {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "event",
      sequence: 2,
      event: "run",
      payload: { runId: "run-1", type: "output", title: "Output", content: "text", createdAt: new Date().toISOString() },
    } satisfies RemoteWebSocketServerMessage;
    expect(shouldCompressRemoteWebSocketMessage(frameMessage)).toBe(false);
    expect(shouldCompressRemoteWebSocketMessage(runMessage)).toBe(true);
  });

  it("projects durable live steps without leaking duplicate or host-only payloads", () => {
    const hugeToolOutput = "tool-output-line\n".repeat(10_000);
    const fullEvent = {
      event: "run",
      payload: {
        runId: "run-1",
        type: "tool-result",
        title: "Shell result",
        content: hugeToolOutput,
        metadata: {
          toolName: "run_shell",
          providerSessionRuntime: { resumeCursor: "private-host-cursor" },
          resumeCheckpoint: { messages: [hugeToolOutput] },
        },
        createdAt: "2026-08-28T12:00:00.000Z",
        run: { id: "run-1", prompt: "duplicated run row" },
        step: {
          id: "step-1",
          runId: "run-1",
          eventType: "tool-result",
          title: "Shell result",
          content: hugeToolOutput,
          metadataJson: JSON.stringify({
            toolName: "run_shell",
            command: "pnpm test",
            attachments: [{ fileName: "trace.txt", mimeType: "text/plain", dataBase64: hugeToolOutput }],
            providerSessionRuntime: { resumeCursor: "private-host-cursor" },
            resumeCheckpoint: { messages: [hugeToolOutput] },
          }),
          createdAt: "2026-08-28T12:00:00.000Z",
        },
      },
    } as unknown as RemoteStreamEvent;

    const projected = projectRemoteStreamEvent(fullEvent);
    expect(projected.event).toBe("run");
    if (projected.event !== "run") throw new Error("Expected a run event.");
    expect(projected.payload).not.toHaveProperty("run");
    expect(projected.payload.content).toBe("");
    expect(projected.payload.metadata).toEqual({ toolName: "run_shell" });
    expect(projected.payload.step?.content).toContain("live preview truncated");
    expect(Buffer.byteLength(projected.payload.step?.content ?? "")).toBeLessThanOrEqual(2_048);
    expect(JSON.parse(projected.payload.step?.metadataJson ?? "{}") as unknown).toEqual({
      toolName: "run_shell",
      command: "pnpm test",
      attachmentNames: ["trace.txt"],
    });
    const projectedBytes = Buffer.byteLength(JSON.stringify(projected));
    const fullBytes = Buffer.byteLength(JSON.stringify(fullEvent));
    expect(projectedBytes).toBeLessThanOrEqual(REMOTE_TRANSFER_BUDGETS.projectedLiveEventBytes);
    expect(projectedBytes).toBeLessThanOrEqual(fullBytes * REMOTE_TRANSFER_BUDGETS.projectedLiveEventRatio);

    const unicodeContent = "😀".repeat(5_000);
    const unicodeEvent = {
      ...fullEvent,
      payload: {
        ...projected.payload,
        content: unicodeContent,
        step: { ...projected.payload.step!, content: unicodeContent },
      },
    } as RemoteStreamEvent;
    const unicodeProjected = projectRemoteStreamEvent(unicodeEvent);
    if (unicodeProjected.event !== "run") throw new Error("Expected a run event.");
    const unicodePreview = unicodeProjected.payload.step?.content ?? "";
    const unicodeHead = unicodePreview.split("\n\n…", 1)[0] ?? "";
    expect(Buffer.byteLength(unicodePreview)).toBeLessThanOrEqual(2_048);
    expect(unicodeHead).not.toContain("�");
    expect([...unicodeHead].every((character) => character === "😀")).toBe(true);
  });

  it("keeps authoritative run rows on non-step events", () => {
    const terminalEvent = {
      event: "run",
      payload: {
        runId: "run-1",
        type: "status",
        title: "Run completed",
        content: "Run completed successfully.",
        createdAt: "2026-08-28T12:00:00.000Z",
        run: { id: "run-1", status: "completed" },
      },
    } as unknown as RemoteStreamEvent;

    expect(projectRemoteStreamEvent(terminalEvent)).toBe(terminalEvent);
  });

  it("filters browser events by run and validates scoped browser input", async () => {
    let releaseFirstInput!: () => void;
    const firstInput = new Promise<void>((resolve) => {
      releaseFirstInput = resolve;
    });
    const dispatchOrder: string[] = [];
    const onBrowserInput = vi.fn(async (_runId: string, input: RunBrowserInput) => {
      if (input.type !== "mouse") return;
      dispatchOrder.push(input.eventType);
      if (input.eventType === "mousePressed") await firstInput;
      if (input.eventType === "mouseReleased") throw new Error("private input payload");
    });
    const onBrowserSubscriptionChange = vi.fn();
    const onServerError = vi.fn();
    const { auth, info, publishEvent } = await startServer(
      undefined,
      undefined,
      undefined,
      undefined,
      { onBrowserInput, onBrowserSubscriptionChange, onServerError },
    );
    const { cookie } = await pair(info.baseUrl, auth, { scopes: ["state:read", "browser:operate"] });
    const socket = new WebSocket(
      `${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`,
      { headers: { Cookie: cookie } },
    );
    const nextMessage = () => new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
    });
    const hello = nextMessage();
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
    });
    await expect(hello).resolves.toMatchObject({ type: "hello" });

    const subscribed = nextMessage();
    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "subscribe",
      requestId: "browser-subscribe",
      events: ["browser"],
      browserRunIds: ["run-1"],
    }));
    await expect(subscribed).resolves.toMatchObject({
      type: "subscribed",
      requestId: "browser-subscribe",
      events: ["browser"],
      browserRunIds: ["run-1"],
    });
    expect(onBrowserSubscriptionChange).toHaveBeenCalledWith([], ["run-1"]);

    const runOneEvent = nextMessage();
    publishEvent({
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
    });
    publishEvent({
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
    });
    await expect(runOneEvent).resolves.toMatchObject({
      type: "event",
      event: "browser",
      payload: { type: "state", runId: "run-1" },
    });

    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "browser-input",
      requestId: "valid-browser-input",
      runId: "run-1",
      input: { type: "mouse", eventType: "mousePressed", x: 12, y: 34, button: "left", clickCount: 1 },
    }));
    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "browser-input",
      requestId: "queued-browser-input",
      runId: "run-1",
      input: { type: "mouse", eventType: "mouseMoved", x: 13, y: 35 },
    }));
    await vi.waitFor(() => expect(onBrowserInput).toHaveBeenCalledWith("run-1", {
      type: "mouse",
      eventType: "mousePressed",
      x: 12,
      y: 34,
      button: "left",
      clickCount: 1,
    }));
    expect(onBrowserInput).toHaveBeenCalledOnce();
    releaseFirstInput();
    await vi.waitFor(() => expect(onBrowserInput).toHaveBeenCalledTimes(2));
    expect(dispatchOrder).toEqual(["mousePressed", "mouseMoved"]);

    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "browser-input",
      requestId: "failed-browser-input",
      runId: "run-1",
      input: { type: "mouse", eventType: "mouseReleased", x: 13, y: 35, button: "left" },
    }));
    await vi.waitFor(() => expect(onServerError).toHaveBeenCalledOnce());
    expect(String(onServerError.mock.calls[0]?.[0])).toBe("Error: Browser input dispatch failed.");

    const invalidInput = nextMessage();
    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "browser-input",
      requestId: "invalid-browser-input",
      runId: "run-1",
      input: { type: "mouse", eventType: "mouseMoved", x: null, y: 0 },
    }));
    await expect(invalidInput).resolves.toMatchObject({
      type: "error",
      requestId: "invalid-browser-input",
      code: "invalid-message",
    });

    socket.close();
    await vi.waitFor(() => expect(onBrowserSubscriptionChange).toHaveBeenLastCalledWith(["run-1"], []));
  });

  it("does not grant browser streaming to an existing session without the browser scope", async () => {
    const { auth, info } = await startServer();
    const { cookie } = await pair(info.baseUrl, auth, { scopes: ["state:read"] });
    const socket = new WebSocket(
      `${info.baseUrl.replace("http://", "ws://")}${REMOTE_ACCESS_WEBSOCKET_PATH}?protocolVersion=${String(REMOTE_ACCESS_PROTOCOL_VERSION)}`,
      { headers: { Cookie: cookie } },
    );
    const messages: Record<string, unknown>[] = [];
    socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
    });
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ type: "hello" })));

    socket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "subscribe",
      requestId: "browser-without-scope",
      events: ["browser"],
      browserRunIds: ["run-1"],
    }));
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      type: "error",
      requestId: "browser-without-scope",
      code: "forbidden",
    })));
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

  it("accepts only an explicitly trusted MagicDNS proxy Host and matching Origin", async () => {
    const magicDnsHost = "buildwarden-host.example.ts.net";
    const { info } = await startServer(undefined, () => [magicDnsHost]);
    const requestHealth = (host: string, origin: string) => new Promise<number | undefined>((resolve, reject) => {
      const req = request({
        hostname: info.host,
        port: info.port,
        path: REMOTE_ACCESS_HEALTH_PATH,
        headers: { Host: host, Origin: origin },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      req.on("error", reject);
      req.end();
    });

    await expect(requestHealth(magicDnsHost, `https://${magicDnsHost}`)).resolves.toBe(200);
    await expect(requestHealth(magicDnsHost, "https://attacker.example")).resolves.toBe(403);
    await expect(requestHealth("untracked.example.ts.net", "https://untracked.example.ts.net")).resolves.toBe(421);
  });
});
