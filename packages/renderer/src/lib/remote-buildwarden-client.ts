import {
  APP_SETTING_KEYS,
  DEFAULT_NETWORK_PROXY_SETTINGS,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  REMOTE_ACCESS_WEBSOCKET_PATH,
  type AppSnapshot,
  type DesktopApi,
  type RemoteApiMethod,
  type RemoteApiMethodArgs,
  type RemoteApiMethodResult,
  type RemoteAccessScope,
  type RemoteRpcResponse,
  type RemoteStreamEventPayloadMap,
  type RemoteStreamEventType,
  type RemoteWebSocketServerMessage,
} from "@buildwarden/shared";
import type { BuildWardenClient, BuildWardenClientCapabilities } from "./buildwarden-client-core";

const webCapabilities = (scopes: readonly RemoteAccessScope[]): Readonly<BuildWardenClientCapabilities> => {
  const has = (scope: RemoteAccessScope) => scopes.includes(scope);
  const runMutations = has("run:operate");
  const chatMutations = has("chat:operate");
  const approvalResponses = has("approval:respond");
  const gitMutations = has("git:write");
  const projectCreation = has("admin");
  const adminMutations = has("admin");
  const terminalOperations = has("terminal:operate");
  const browserOperations = has("browser:operate");
  return Object.freeze({
    platform: "web" as const,
    nativeTitleBar: false,
    nativeAppMenu: false,
    directoryPicker: false,
    ideIntegration: false,
    fileManager: false,
    systemTerminal: false,
    embeddedTerminal: terminalOperations,
    browserControl: browserOperations,
    settings: adminMutations,
    mutations: runMutations || chatMutations || approvalResponses || gitMutations || projectCreation || terminalOperations || browserOperations,
    runMutations,
    chatMutations,
    bookmarkMutations: runMutations || chatMutations,
    runListVisibilityMutations: runMutations,
    taskMutations: adminMutations,
    insightMutations: adminMutations,
    projectLabMutations: adminMutations,
    projectLoopMutations: adminMutations,
    prReview: gitMutations,
    projectSettingsMutations: adminMutations,
    approvalResponses,
    gitMutations,
    projectCreation,
    hostDirectoryBrowser: projectCreation,
    liveEvents: true,
  });
};

const REMOTE_READ_METHODS = new Set<RemoteApiMethod>([
  "getSnapshot",
  "refreshSnapshot",
  "getNetworkProxySettings",
  "getProjectBranches",
  "getProjectCurrentBranch",
  "checkProjectFolderGitStatus",
  "getRunDetail",
  "getRunWorktreeDiff",
  "getRunWorkspaceFile",
  "getProjectLoopUiReviewImage",
  "getProjectLoopDetail",
  "getProjectLoopAvailability",
  "getChatDetail",
  "listChatsWithSteps",
  "getBookmarksWithSteps",
  "getChatBookmarksWithSteps",
  "getRunPublishOptions",
  "getProjectBranchOverview",
  "getProjectBranchDeleteImpact",
  "getProjectForgeAuthStatus",
  "getProjectForgePrMonitorSettings",
  "listProjectForgeRequests",
  "getProjectForgeRequestDetails",
  "checkProjectGitConversion",
  "listHostDirectories",
  "listAvailableProviderModels",
  "getAppPaths",
  "getDetectedCodexInstallation",
  "getDetectedClaudeInstallation",
  "getDetectedCursorInstallation",
  "listIntegratedSkills",
  "getIntegratedSkillContent",
]);

const REMOTE_BROWSER_METHODS = new Set<RemoteApiMethod>([
  "ensureRunBrowser",
  "navigateRunBrowser",
  "runBrowserAction",
  "setRunBrowserViewport",
  "getRunBrowserElementCapture",
]);

const REMOTE_MUTATION_METHODS = new Set<RemoteApiMethod>([
  "createRun",
  "continueRun",
  "followUpRun",
  "respondToShellApproval",
  "respondToRunUserInput",
  "cancelRunShell",
  "cancelRun",
  "resumeRunFromCheckpoint",
  "recoverInterruptedRun",
  "undoRunToLastPrompt",
  "deleteRun",
  "setRunListVisibility",
  "addBookmark",
  "removeBookmark",
  "removeBookmarkById",
  "createChat",
  "followUpChat",
  "cancelChat",
  "deleteChat",
  "addChatBookmark",
  "removeChatBookmark",
  "removeChatBookmarkById",
  "createProjectTask",
  "updateProjectTask",
  "deleteProjectTask",
  "generateProjectTaskRunPrompt",
  "generateProjectInsight",
  "runProjectLab",
  "deleteProjectLabThread",
  "createProjectLoop",
  "cancelProjectLoop",
  "resumeProjectLoop",
  "deleteProjectLoop",
  "respondToProjectLoopUiReview",
  "fetchProjectPrMrDiff",
  "analyzeProjectPrMrDiff",
  "postProjectPrMrReview",
  "submitProjectPrMrComments",
  "replyProjectPrMrReviewThread",
  "resolveProjectPrMrReviewThread",
  "commitRun",
  "createRunLocalBranch",
  "publishRunBranch",
  "createRunPullRequest",
  "checkoutProjectBranch",
  "fetchProjectBranches",
  "createProjectBranch",
  "renameProjectBranch",
  "deleteProjectBranch",
  "pullProjectBranch",
  "pushProjectBranch",
  "convertProjectToGit",
  "updateProjectBaseBranch",
  "addProject",
  "reorderProjects",
  "addProviderAccount",
  "addModel",
  "deleteProject",
  "deleteProviderAccount",
  "deleteModel",
  "setAppSetting",
  "saveNetworkProxySettings",
  "saveProjectForgeAuthToken",
  "deleteProjectForgeAuthToken",
  "saveProjectForgePrMonitorSettings",
  "runTerminalStart",
  "runTerminalWrite",
  "runTerminalResize",
  "runTerminalKill",
]);

const REMOTE_MUTATION_SCOPES = new Map<RemoteApiMethod, RemoteAccessScope>([
  ...[
    "createRun", "continueRun", "followUpRun", "cancelRunShell", "cancelRun", "resumeRunFromCheckpoint",
    "recoverInterruptedRun", "undoRunToLastPrompt", "deleteRun", "setRunListVisibility", "addBookmark", "removeBookmark",
    "removeBookmarkById",
  ].map((method) => [method as RemoteApiMethod, "run:operate" as const] as const),
  ...["respondToShellApproval", "respondToRunUserInput"]
    .map((method) => [method as RemoteApiMethod, "approval:respond" as const] as const),
  ...["createChat", "followUpChat", "cancelChat", "deleteChat", "addChatBookmark", "removeChatBookmark", "removeChatBookmarkById"]
    .map((method) => [method as RemoteApiMethod, "chat:operate" as const] as const),
  ...[
    "commitRun", "createRunLocalBranch", "publishRunBranch", "createRunPullRequest", "checkoutProjectBranch",
    "fetchProjectBranches", "createProjectBranch", "renameProjectBranch", "deleteProjectBranch", "pullProjectBranch",
    "pushProjectBranch", "convertProjectToGit", "updateProjectBaseBranch",
    "analyzeProjectPrMrDiff", "postProjectPrMrReview", "submitProjectPrMrComments", "replyProjectPrMrReviewThread",
    "resolveProjectPrMrReviewThread", "fetchProjectPrMrDiff",
  ].map((method) => [method as RemoteApiMethod, "git:write" as const] as const),
  ...[
    "addProject", "reorderProjects", "addProviderAccount", "addModel", "deleteProject", "deleteProviderAccount", "deleteModel",
    "setAppSetting", "saveNetworkProxySettings", "saveProjectForgeAuthToken", "deleteProjectForgeAuthToken",
    "saveProjectForgePrMonitorSettings", "createProjectTask", "updateProjectTask", "deleteProjectTask",
    "generateProjectTaskRunPrompt", "generateProjectInsight", "runProjectLab", "deleteProjectLabThread", "createProjectLoop",
    "cancelProjectLoop", "resumeProjectLoop", "deleteProjectLoop", "respondToProjectLoopUiReview",
  ].map((method) => [method as RemoteApiMethod, "admin" as const] as const),
  ...["runTerminalStart", "runTerminalWrite", "runTerminalResize", "runTerminalKill"]
    .map((method) => [method as RemoteApiMethod, "terminal:operate" as const] as const),
]);

const REMOTE_LOCAL_SETTING_KEYS = new Set<string>([
  APP_SETTING_KEYS.darkMode,
  APP_SETTING_KEYS.uiTheme,
  APP_SETTING_KEYS.sidebarContrast,
  APP_SETTING_KEYS.sidebarWidth,
  APP_SETTING_KEYS.recentRunDays,
  APP_SETTING_KEYS.runTimelineDensity,
  APP_SETTING_KEYS.runWorkspaceLayouts,
  APP_SETTING_KEYS.keyboardShortcuts,
]);

const LOCAL_SETTINGS_STORAGE_KEY = "buildwarden.remote.ui-settings.v1";

const readLocalSettings = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOCAL_SETTINGS_STORAGE_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
  } catch {
    return {};
  }
};

const writeLocalSettings = (settings: Record<string, string>): void => {
  try {
    window.localStorage.setItem(LOCAL_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing modes can disable storage. The in-memory preference still
    // applies for the current remote session.
  }
};

const remoteSettings = (
  snapshot: AppSnapshot,
  localSettings: Record<string, string>,
  includeHostSettings: boolean,
): Record<string, string> => {
  const settings: Record<string, string> = includeHostSettings ? { ...snapshot.settings } : {};
  for (const key of REMOTE_LOCAL_SETTING_KEYS) {
    const value = localSettings[key] ?? snapshot.settings[key];
    if (value != null) settings[key] = value;
  }
  return settings;
};

export class RemoteSessionExpiredError extends Error {
  constructor() {
    super("The remote session has expired or was revoked.");
    this.name = "RemoteSessionExpiredError";
  }
}

export interface RemoteBuildWardenClientOptions {
  baseUrl?: string;
  /** Origin-bound bearer used by the standalone hosted client. Omit for same-origin cookie sessions. */
  sessionToken?: string;
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: (url: string) => WebSocket;
  scopes?: readonly RemoteAccessScope[];
  onSessionExpired?: () => void;
}

const REMOTE_EVENT_TYPES = new Set<RemoteStreamEventType>([
  "run",
  "chat",
  "warning",
  "loop",
  "task",
  "terminal-data",
  "terminal-exit",
  "browser",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const isRemoteEventPayload = (event: RemoteStreamEventType, payload: unknown): boolean => {
  if (!isObject(payload)) return false;
  if (event === "run") {
    return typeof payload.runId === "string" && typeof payload.type === "string" &&
      typeof payload.title === "string" && typeof payload.content === "string" && typeof payload.createdAt === "string";
  }
  if (event === "chat") {
    return typeof payload.chatId === "string" && typeof payload.runId === "string" &&
      typeof payload.type === "string" && typeof payload.title === "string" &&
      typeof payload.content === "string" && typeof payload.createdAt === "string";
  }
  if (event === "warning") return typeof payload.title === "string" && typeof payload.message === "string";
  if (event === "loop") return typeof payload.loopId === "string" && typeof payload.projectId === "string";
  if (event === "terminal-data") return typeof payload.sessionId === "string" && typeof payload.data === "string";
  if (event === "terminal-exit") return typeof payload.sessionId === "string" && Number.isInteger(payload.exitCode);
  if (event === "browser") return typeof payload.runId === "string" &&
    (payload.type === "state" || payload.type === "selection-ready" || payload.type === "frame" || payload.type === "error");
  return typeof payload.projectId === "string" && typeof payload.taskId === "string" &&
    (payload.status === "open" || payload.status === "in_progress" || payload.status === "in_review" || payload.status === "done");
};

const parseRemoteServerMessage = (raw: unknown): RemoteWebSocketServerMessage | null => {
  if (!isObject(raw) || raw.protocolVersion !== REMOTE_ACCESS_PROTOCOL_VERSION || typeof raw.type !== "string") return null;
  if (raw.type === "event") {
    if (typeof raw.event !== "string" || !REMOTE_EVENT_TYPES.has(raw.event as RemoteStreamEventType) ||
      typeof raw.sequence !== "number" || !Number.isSafeInteger(raw.sequence)) return null;
    const event = raw.event as RemoteStreamEventType;
    return isRemoteEventPayload(event, raw.payload) ? raw as unknown as RemoteWebSocketServerMessage : null;
  }
  if (raw.type === "hello") return isObject(raw.info) ? raw as unknown as RemoteWebSocketServerMessage : null;
  if (raw.type === "authenticated") {
    return typeof raw.requestId === "string" && isObject(raw.session)
      ? raw as unknown as RemoteWebSocketServerMessage : null;
  }
  if (raw.type === "subscribed") {
    return typeof raw.requestId === "string" && Array.isArray(raw.events) &&
      raw.events.every((event) => typeof event === "string" && REMOTE_EVENT_TYPES.has(event as RemoteStreamEventType))
      ? raw as unknown as RemoteWebSocketServerMessage : null;
  }
  if (raw.type === "pong") return typeof raw.requestId === "string" ? raw as unknown as RemoteWebSocketServerMessage : null;
  if (raw.type === "error") {
    return typeof raw.requestId === "string" && typeof raw.code === "string" && typeof raw.message === "string"
      ? raw as unknown as RemoteWebSocketServerMessage : null;
  }
  return null;
};

export const createRemoteBuildWardenClient = (options: RemoteBuildWardenClientOptions = {}): BuildWardenClient => {
  const baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "";
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let selectedProjectId: string | null = null;
  let selectedRunId: string | null = null;
  let localSettings = readLocalSettings();
  const scopes = options.scopes ?? ["state:read"];
  const capabilities = webCapabilities(scopes);
  const listeners = new Map<RemoteStreamEventType, Set<(payload: unknown) => void>>();
  const browserListenerRunIds = new Map<(payload: unknown) => void, Set<string>>();
  let eventSocket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const activeEventTypes = (): RemoteStreamEventType[] =>
    [...listeners.entries()].filter(([, handlers]) => handlers.size > 0).map(([event]) => event);

  const activeBrowserRunIds = (): string[] => [...new Set([...browserListenerRunIds.values()].flatMap((runIds) => [...runIds]))];

  const eventSocketUrl = (): string => {
    const origin = baseUrl || window.location.origin;
    const url = new URL(REMOTE_ACCESS_WEBSOCKET_PATH, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("protocolVersion", String(REMOTE_ACCESS_PROTOCOL_VERSION));
    return url.toString();
  };

  const sendSubscription = () => {
    if (eventSocket?.readyState !== 1) return;
    eventSocket.send(JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "subscribe",
      requestId: crypto.randomUUID(),
      events: activeEventTypes(),
      ...(activeEventTypes().includes("browser") ? { browserRunIds: activeBrowserRunIds() } : {}),
    }));
  };

  const connectEvents = () => {
    if (eventSocket || activeEventTypes().length === 0) return;
    const socket = options.webSocketFactory?.(eventSocketUrl()) ?? new WebSocket(eventSocketUrl());
    eventSocket = socket;
    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      if (options.sessionToken) {
        socket.send(JSON.stringify({
          protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
          type: "authenticate",
          requestId: crypto.randomUUID(),
          token: options.sessionToken,
        }));
      } else {
        sendSubscription();
      }
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      const message = parseRemoteServerMessage(decoded);
      if (message?.type === "authenticated") {
        sendSubscription();
        return;
      }
      if (message?.type !== "event") return;
      listeners.get(message.event)?.forEach((listener) => {
        if (message.event === "browser") {
          const payload = message.payload as RemoteStreamEventPayloadMap["browser"];
          if (!browserListenerRunIds.get(listener)?.has(payload.runId)) return;
        }
        listener(message.payload);
      });
    });
    socket.addEventListener("close", (event) => {
      if (eventSocket === socket) eventSocket = null;
      if (event.code === 1008) {
        options.onSessionExpired?.();
        return;
      }
      if (activeEventTypes().length > 0 && reconnectTimer == null) {
        const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt++);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectEvents();
        }, delay);
      }
    });
    socket.addEventListener("error", () => socket.close());
  };

  const subscribe = <Event extends RemoteStreamEventType>(
    event: Event,
    listener: (payload: RemoteStreamEventPayloadMap[Event]) => void,
    runIds?: readonly string[],
  ): (() => void) => {
    const untypedListener = listener as (payload: unknown) => void;
    if (event === "browser") {
      const requestedRunIds = new Set(runIds ?? []);
      const uniqueRunIds = new Set<string>();
      for (const [registeredListener, registeredRunIds] of browserListenerRunIds) {
        if (registeredListener !== untypedListener) registeredRunIds.forEach((runId) => uniqueRunIds.add(runId));
      }
      requestedRunIds.forEach((runId) => uniqueRunIds.add(runId));
      if (uniqueRunIds.size > 8) {
        throw new Error("Remote browser events can subscribe to at most eight runs at once.");
      }
    }
    const eventListeners = listeners.get(event) ?? new Set<(payload: unknown) => void>();
    eventListeners.add(untypedListener);
    listeners.set(event, eventListeners);
    if (event === "browser") browserListenerRunIds.set(untypedListener, new Set(runIds ?? []));
    if (eventSocket?.readyState === 1) sendSubscription();
    else connectEvents();
    return () => {
      eventListeners.delete(untypedListener);
      browserListenerRunIds.delete(untypedListener);
      if (eventSocket?.readyState === 1) sendSubscription();
      if (activeEventTypes().length === 0) {
        if (reconnectTimer != null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        eventSocket?.close(1000, "No active subscriptions");
        eventSocket = null;
      }
    };
  };

  const invoke = async <Method extends RemoteApiMethod>(
    method: Method,
    args: RemoteApiMethodArgs<Method>,
  ): Promise<RemoteApiMethodResult<Method>> => {
    const wireArgs: unknown[] = [...args];
    while (wireArgs.length > 0 && wireArgs[wireArgs.length - 1] === undefined) {
      wireArgs.pop();
    }
    const idempotencyKey = REMOTE_MUTATION_METHODS.has(method) ? crypto.randomUUID() : undefined;
    const requestBody = JSON.stringify({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      method,
      args: wireArgs,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const send = () => fetcher(`${baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      credentials: options.sessionToken ? "omit" : "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.sessionToken ? { Authorization: `Bearer ${options.sessionToken}` } : {}),
      },
      body: requestBody,
    });
    let response: Response;
    try {
      response = await send();
    } catch (firstError) {
      if (!idempotencyKey) throw firstError;
      // A transport failure can happen after the host completed a command. Retry
      // once with the exact same persisted key so the host replays the result
      // instead of executing the mutation twice.
      response = await send();
    }
    if (response.status === 401) {
      options.onSessionExpired?.();
      throw new RemoteSessionExpiredError();
    }
    if (!response.ok) {
      throw new Error(`Remote request failed with status ${String(response.status)}.`);
    }
    const payload = await response.json() as RemoteRpcResponse;
    if (!payload.ok) {
      throw new Error(payload.error.message);
    }
    return payload.result as RemoteApiMethodResult<Method>;
  };

  const loadSnapshot = async (method: "getSnapshot" | "refreshSnapshot"): Promise<AppSnapshot> => {
    const snapshot = await invoke(method, []);
    return {
      ...snapshot,
      selectedProjectId: selectedProjectId ?? snapshot.selectedProjectId,
      selectedRunId,
      settings: remoteSettings(snapshot, localSettings, capabilities.settings),
    };
  };

  const localApi: Partial<DesktopApi> & { capabilities: Readonly<BuildWardenClientCapabilities> } = {
    capabilities,
    getSnapshot: () => loadSnapshot("getSnapshot"),
    refreshSnapshot: () => loadSnapshot("refreshSnapshot"),
    selectProject: async (projectId) => {
      selectedProjectId = projectId;
      selectedRunId = null;
    },
    activateRun: async (runId) => {
      selectedRunId = runId;
    },
    releaseRun: async (runId) => {
      if (selectedRunId === runId) selectedRunId = null;
    },
    setAppSetting: async (key, value) => {
      if (REMOTE_LOCAL_SETTING_KEYS.has(key)) {
        localSettings = { ...localSettings, [key]: value };
        writeLocalSettings(localSettings);
        return;
      }
      if (!capabilities.settings) {
        throw new Error('"setAppSetting" is not available for this remote session.');
      }
      await invoke("setAppSetting", [key, value]);
    },
    getNetworkProxySettings: () => capabilities.settings
      ? invoke("getNetworkProxySettings", [])
      : Promise.resolve({ ...DEFAULT_NETWORK_PROXY_SETTINGS, hasPassword: false }),
    getAppPaths: () => capabilities.settings
      ? invoke("getAppPaths", [])
      : Promise.resolve({ logDirPath: "", logDirectorySize: { totalBytes: 0, fileCount: 0, unreadableEntryCount: 0 } }),
    getDetectedCodexInstallation: () => capabilities.settings
      ? invoke("getDetectedCodexInstallation", [])
      : Promise.resolve({ binaryPath: null }),
    getDetectedClaudeInstallation: () => capabilities.settings
      ? invoke("getDetectedClaudeInstallation", [])
      : Promise.resolve({ binaryPath: null }),
    getDetectedCursorInstallation: () => capabilities.settings
      ? invoke("getDetectedCursorInstallation", [])
      : Promise.resolve({ binaryPath: null }),
    listIntegratedSkills: () => capabilities.settings ? invoke("listIntegratedSkills", []) : Promise.resolve([]),
    getIntegratedSkillContent: (skillId) => capabilities.settings
      ? invoke("getIntegratedSkillContent", [skillId])
      : Promise.resolve(null),
    pickProjectDirectory: async () => null,
    pickIdeExecutable: async () => null,
    reportRendererLog: async (payload) => {
      const method = payload.level === "error" ? console.error : console.warn;
      method(`[BuildWarden remote] ${payload.source}: ${payload.message}`, payload.metadata ?? {});
    },
    openExternalUrl: async (url) => {
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      return opened ? { ok: true } : { ok: false, error: "The browser blocked the new tab." };
    },
    onRunEvent: (listener) => subscribe("run", listener),
    onChatEvent: (listener) => subscribe("chat", listener),
    onAppWarning: (listener) => subscribe("warning", listener),
    onProjectLoopChanged: (listener) => subscribe("loop", listener),
    onProjectTaskChanged: (listener) => subscribe("task", listener),
    onRunTerminalData: (listener) => subscribe("terminal-data", listener),
    onRunTerminalExit: (listener) => subscribe("terminal-exit", listener),
    onRunBrowserEvent: (listener, runIds) => subscribe("browser", listener, runIds),
    sendRunBrowserInput: async ({ runId, input }) => {
      if (!capabilities.browserControl) throw new Error("Browser control is not available for this remote session. Re-pair the device.");
      if (eventSocket?.readyState !== 1) throw new Error("The remote browser event connection is not ready.");
      eventSocket.send(JSON.stringify({
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        type: "browser-input",
        requestId: crypto.randomUUID(),
        runId,
        input,
      }));
    },
  };

  const client = new Proxy(localApi as BuildWardenClient, {
    get(target, property, receiver) {
      const existing = Reflect.get(target, property, receiver) as unknown;
      if (existing !== undefined) return existing;
      if (typeof property !== "string") return undefined;
      if (property.startsWith("on")) return () => () => {};
      if (REMOTE_BROWSER_METHODS.has(property as RemoteApiMethod)) {
        if (!capabilities.browserControl) {
          return async () => {
            throw new Error(`"${property}" requires browser control. Re-pair the device.`);
          };
        }
        return (...args: unknown[]) => invoke(property as RemoteApiMethod, args as never);
      }
      if (REMOTE_READ_METHODS.has(property as RemoteApiMethod)) {
        return (...args: unknown[]) => invoke(property as RemoteApiMethod, args as never);
      }
      if (REMOTE_MUTATION_METHODS.has(property as RemoteApiMethod)) {
        const requiredScope = REMOTE_MUTATION_SCOPES.get(property as RemoteApiMethod);
        if (requiredScope && !scopes.includes(requiredScope)) {
          return async () => {
            const reason = capabilities.mutations ? "this remote session" : "the read-only remote client";
            throw new Error(`"${property}" is not available for ${reason}.`);
          };
        }
        return (...args: unknown[]) => invoke(property as RemoteApiMethod, args as never);
      }
      return async () => {
        throw new Error(`"${property}" is not available in the read-only remote client.`);
      };
    },
  });

  return client;
};
