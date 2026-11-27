import { composerDraftStore } from "./composer-draft-store";
import { withComposerDraftCleanup } from "./composer-draft-cleanup";
import {
  APP_SETTING_KEYS,
  DEFAULT_NETWORK_PROXY_SETTINGS,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  REMOTE_ACCESS_WEBSOCKET_PATH,
  REMOTE_STEP_DELTA_STREAM_ENCODING,
  REMOTE_STREAM_ENCODING_PARAM,
  StreamedStepEventDecoder,
  createDisabledProviderCliUpdateSnapshot,
  parseRunWorkspaceLayoutsSetting,
  type AppSnapshot,
  type BookmarkListEntry,
  type BookmarkRecord,
  type ChatBookmarkRecord,
  type DesktopApi,
  type RemoteApiMethod,
  type RemoteApiMethodArgs,
  type RemoteApiMethodResult,
  type RemoteAccessScope,
  type RemoteRpcErrorCode,
  type RemoteRpcResponse,
  type RemoteStreamEventPayloadMap,
  type RemoteStreamEventType,
  type RemoteWebSocketServerMessage,
} from "@buildwarden/shared";
import { bookmarkMatchesSearch } from "./bookmark-search";
import type { BuildWardenClient, BuildWardenClientCapabilities } from "./buildwarden-client-core";
import { chatDetailMatchesSearch } from "./chat-search";
import {
  REMOTE_BROWSER_METHODS,
  REMOTE_MUTATION_METHODS,
  REMOTE_MUTATION_SCOPES,
  REMOTE_READ_METHODS,
  webCapabilities,
} from "./remote-client-policy";

export { listRemoteMutationMethodsMissingScopePolicy } from "./remote-client-policy";

const REMOTE_LOCAL_SETTING_KEYS = new Set<string>([
  APP_SETTING_KEYS.darkMode,
  APP_SETTING_KEYS.uiTheme,
  APP_SETTING_KEYS.designScheme,
  APP_SETTING_KEYS.homeLayout,
  APP_SETTING_KEYS.sidebarContrast,
  APP_SETTING_KEYS.sidebarRunEntrySize,
  APP_SETTING_KEYS.sidebarGroupRunsByProject,
  APP_SETTING_KEYS.sidebarHideActiveRuns,
  APP_SETTING_KEYS.sidebarUncategorizedFirst,
  APP_SETTING_KEYS.sidebarUncategorizedSection,
  APP_SETTING_KEYS.sidebarWidth,
  APP_SETTING_KEYS.recentRunDays,
  APP_SETTING_KEYS.runTimelineDensity,
  APP_SETTING_KEYS.keyboardShortcuts,
  APP_SETTING_KEYS.followUpDelivery,
]);

const LOCAL_SETTINGS_STORAGE_KEY = "buildwarden.remote.ui-settings.v1";

/** A host's refusal of one operation, with the reason a client can act on. */
class RemoteOperationError extends Error {
  constructor(message: string, readonly code: RemoteRpcErrorCode) {
    super(message);
    this.name = "RemoteOperationError";
  }
}

/**
 * Runs an operation that hosts of an earlier version do not have. Such a host answers
 * "method-not-found"; `olderHost` then gets the same result from operations it does have.
 */
const withOlderHostFallback = async <Result>(call: () => Promise<Result>, olderHost: () => Promise<Result>): Promise<Result> => {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof RemoteOperationError) || error.code !== "method-not-found") throw error;
    return olderHost();
  }
};

const withoutSteps = (bookmark: BookmarkRecord | ChatBookmarkRecord): BookmarkListEntry => {
  const entry: Partial<BookmarkRecord | ChatBookmarkRecord> = { ...bookmark };
  delete entry.steps;
  return entry as BookmarkListEntry;
};

export const remoteDraftScope = (baseUrl?: string): string => {
  try {
    const base = typeof window === "undefined" ? undefined : window.location.href || window.location.origin;
    const url = new URL(baseUrl || (typeof window === "undefined" ? "" : window.location.origin), base);
    return `remote:${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return `remote:${baseUrl || "unknown"}`;
  }
};

export const isRemoteBrowserSetting = (key: string): boolean => REMOTE_LOCAL_SETTING_KEYS.has(key);

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
export const readRemoteUiSettings = readLocalSettings;

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
  /** Connection registry identity, shared with the federated composer scope. */
  draftScopeId?: string;
  baseUrl?: string;
  /** Origin-bound bearer used by the standalone hosted client. Omit for same-origin cookie sessions. */
  sessionToken?: string;
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: (url: string) => WebSocket;
  scopes?: readonly RemoteAccessScope[];
  onSessionExpired?: () => void;
  /** Bound background list reads without imposing a deadline on long-running commands. */
  backgroundReadTimeoutMs?: number;
  /** Connection registries can block commands while retaining an offline detail view. */
  canSendMutations?: () => boolean;
}

const REMOTE_EVENT_TYPES = new Set<RemoteStreamEventType>([
  "run-organization",
  "run",
  "chat",
  "warning",
  "loop",
  "task",
  "orchestration",
  "terminal-data",
  "terminal-exit",
  "browser",
  "forge",
  "provider-cli-updates",
  "owned-processes",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const isRemoteEventPayload = (event: RemoteStreamEventType, payload: unknown): boolean => {
  if (!isObject(payload)) return false;
  if (event === "run-organization") return typeof payload.changedAt === "string";
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
  if (event === "forge") return typeof payload.runId === "string" && typeof payload.projectId === "string" &&
    (payload.forgeRequest === null || isObject(payload.forgeRequest));
  if (event === "provider-cli-updates") return typeof payload.enabled === "boolean" && Array.isArray(payload.providers);
  if (event === "owned-processes") {
    return isObject(payload.owner) && typeof payload.owner.id === "string" && Array.isArray(payload.processes);
  }
  if (event === "orchestration") {
    return typeof payload.projectId === "string" && typeof payload.coordinatorRunId === "string" &&
      typeof payload.orchestrationId === "string" && typeof payload.status === "string" &&
      typeof payload.sequence === "number";
  }
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
    // Streamed run/chat text arrives as deltas from hosts that support it; others send whole events.
    url.searchParams.set(REMOTE_STREAM_ENCODING_PARAM, REMOTE_STEP_DELTA_STREAM_ENCODING);
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
    // The host keeps one encoder per connection, so each socket starts with empty decoders.
    const stepDecoders = { run: new StreamedStepEventDecoder(), chat: new StreamedStepEventDecoder() };
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
      let payload: unknown = message.payload;
      // Decode every run/chat event, even without listeners, to stay in step with the host.
      if (message.event === "run" || message.event === "chat") {
        const decoded = message.event === "run"
          ? stepDecoders.run.decode(message.payload as RemoteStreamEventPayloadMap["run"])
          : stepDecoders.chat.decode(message.payload as RemoteStreamEventPayloadMap["chat"]);
        if (!decoded.ok) {
          // Not expected on an ordered socket. Reconnect: the next update of each stream is whole again.
          socket.close(4000, "Stream encoding out of sync");
          return;
        }
        payload = decoded.event;
      }
      listeners.get(message.event)?.forEach((listener) => {
        if (message.event === "browser") {
          const browserPayload = payload as RemoteStreamEventPayloadMap["browser"];
          if (!browserListenerRunIds.get(listener)?.has(browserPayload.runId)) return;
        }
        listener(payload);
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
    if (capabilities.liveEvents) {
      if (eventSocket?.readyState === 1) sendSubscription();
      else connectEvents();
    }
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
    const backgroundRead = ["getSnapshot", "refreshSnapshot", "getAttentionInbox", "getBookmarksWithSteps", "getChatBookmarksWithSteps"].includes(method);
    const send = () => {
      if (idempotencyKey && options.canSendMutations?.() === false) {
        throw new Error("This instance is not connected. Reconnect it before making changes.");
      }
      return fetcher(`${baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
        method: "POST",
        credentials: options.sessionToken ? "omit" : "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(options.sessionToken ? { Authorization: `Bearer ${options.sessionToken}` } : {}),
        },
        body: requestBody,
        ...(backgroundRead && options.backgroundReadTimeoutMs ? { signal: AbortSignal.timeout(options.backgroundReadTimeoutMs) } : {}),
      });
    };
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
      throw new RemoteOperationError(payload.error.message, payload.error.code);
    }
    return payload.result as RemoteApiMethodResult<Method>;
  };

  /** Every saved run and chat with its steps: all that a host without the lighter operations offers. */
  const loadBookmarksWithSteps = async (): Promise<Array<BookmarkRecord | ChatBookmarkRecord>> => {
    const [runs, chats] = await Promise.all([invoke("getBookmarksWithSteps", []), invoke("getChatBookmarksWithSteps", [])]);
    return [...runs, ...chats].sort((left, right) => right.bookmarkedAt.localeCompare(left.bookmarkedAt));
  };

  const loadSnapshot = async (method: "getSnapshot" | "refreshSnapshot"): Promise<AppSnapshot> => {
    const snapshot = await invoke(method, []);
    // Several live clients share browser preferences. Re-read changes made through another host.
    localSettings = { ...localSettings, ...readLocalSettings() };
    return {
      ...snapshot,
      selectedProjectId: selectedProjectId ?? snapshot.selectedProjectId,
      selectedRunId,
      settings: remoteSettings(snapshot, localSettings, capabilities.settings),
    };
  };

  const localApi: Partial<DesktopApi> & { capabilities: Readonly<BuildWardenClientCapabilities>; draftScopeId: string } = {
    draftScopeId: options.draftScopeId ?? remoteDraftScope(options.baseUrl),
    capabilities,
    getSnapshot: () => loadSnapshot("getSnapshot"),
    refreshSnapshot: () => loadSnapshot("refreshSnapshot"),
    listBookmarkEntries: () => withOlderHostFallback(
      () => invoke("listBookmarkEntries", []),
      async () => (await loadBookmarksWithSteps()).map(withoutSteps),
    ),
    getBookmarkWithSteps: (bookmarkId) => withOlderHostFallback(
      () => invoke("getBookmarkWithSteps", [bookmarkId]),
      async () => (await loadBookmarksWithSteps()).find((bookmark) => bookmark.id === bookmarkId) ?? null,
    ),
    searchBookmarks: (query) => withOlderHostFallback(
      () => invoke("searchBookmarks", [query]),
      // Like the host's own search, an empty text matches nothing (the page filters treat it as "show all").
      async () => query.trim()
        ? (await loadBookmarksWithSteps()).filter((bookmark) => bookmarkMatchesSearch(bookmark, query)).map((bookmark) => bookmark.id)
        : [],
    ),
    listChats: () => withOlderHostFallback(
      () => invoke("listChats", []),
      async () => (await invoke("listChatsWithSteps", [])).map((detail) => detail.chat),
    ),
    searchChats: (query) => withOlderHostFallback(
      () => invoke("searchChats", [query]),
      async () => query.trim()
        ? (await invoke("listChatsWithSteps", [])).filter((detail) => chatDetailMatchesSearch(detail, query)).map((detail) => detail.chat.id)
        : [],
    ),
    // The host answers with a path on itself; the frame must load it from the host, not this page's origin.
    getVisualReplyFrame: async (runId, stepId) => {
      const frame = await invoke("getVisualReplyFrame", [runId, stepId]);
      return frame.kind === "url" ? { kind: "url", url: new URL(frame.url, baseUrl || window.location.origin).href } : frame;
    },
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
    // The background image lives on the host's disk; remote browsers show the design without it.
    getDesignBackgroundImage: async () => null,
    setDesignBackgroundImage: async () => {
      throw new Error("The background image can only be changed in the desktop app.");
    },
    // Panel layouts stay per browser, in the same storage entry earlier versions used.
    listRunWorkspaceLayouts: async () => {
      localSettings = { ...localSettings, ...readLocalSettings() };
      return parseRunWorkspaceLayoutsSetting(localSettings[APP_SETTING_KEYS.runWorkspaceLayouts]);
    },
    setRunWorkspaceLayout: async (runId, layout) => {
      localSettings = { ...localSettings, ...readLocalSettings() };
      const layouts = parseRunWorkspaceLayoutsSetting(localSettings[APP_SETTING_KEYS.runWorkspaceLayouts]);
      if (layout) layouts[runId] = layout;
      else delete layouts[runId];
      localSettings = { ...localSettings, [APP_SETTING_KEYS.runWorkspaceLayouts]: JSON.stringify(layouts) };
      writeLocalSettings(localSettings);
    },
    setAppSetting: async (key, value) => {
      if (REMOTE_LOCAL_SETTING_KEYS.has(key)) {
        localSettings = { ...localSettings, ...readLocalSettings(), [key]: value };
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
    getUsageCostReport: (input) => invoke("getUsageCostReport", [input]),
    getSubscriptionLimits: (input) => invoke("getSubscriptionLimits", [input]),
    getSubscriptionLimitsAvailability: () => invoke("getSubscriptionLimitsAvailability", []),
    useSubscriptionReset: async (input) => {
      if (!capabilities.settings) throw new Error("Using reset credits requires settings access.");
      return invoke("useSubscriptionReset", [input]);
    },
    // Checks and installers run on the host, so they need the same admin scope as other settings.
    getProviderCliUpdates: () => capabilities.settings
      ? invoke("getProviderCliUpdates", [])
      : Promise.resolve(createDisabledProviderCliUpdateSnapshot()),
    checkProviderCliUpdates: async () => {
      if (!capabilities.settings) throw new Error("Provider CLI updates require a remote session with settings access.");
      return invoke("checkProviderCliUpdates", []);
    },
    runProviderCliUpdate: async (providerType) => {
      if (!capabilities.settings) throw new Error("Provider CLI updates require a remote session with settings access.");
      return invoke("runProviderCliUpdate", [providerType]);
    },
    // The host rejects the whole subscription for sessions without admin, so only admins subscribe.
    onProviderCliUpdatesChanged: (listener) => capabilities.settings ? subscribe("provider-cli-updates", listener) : () => undefined,
    getOwnedProcesses: (owner) => invoke("getOwnedProcesses", [owner]),
    getOwnedProcessOutput: (owner, processId) => invoke("getOwnedProcessOutput", [owner, processId]),
    // The host checks the owner's operate scope, so runs and chats travel as separate operations.
    manageOwnedProcesses: async (input) => {
      if (input.owner.kind === "run") {
        if (!capabilities.runMutations) throw new Error("Managing run processes requires a remote session that can operate runs.");
        return invoke("manageRunOwnedProcesses", [input]);
      }
      if (!capabilities.chatMutations) throw new Error("Managing chat processes requires a remote session that can operate chats.");
      return invoke("manageChatOwnedProcesses", [input]);
    },
    onOwnedProcessesChanged: (listener) => subscribe("owned-processes", listener),
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
    importSkill: (input) => invoke("importSkill", [input]),
    removeImportedSkill: (skillId) => invoke("removeImportedSkill", [skillId]),
    getSessionSkills: (kind, id) => invoke("getSessionSkills", [kind, id]),
    setSessionSkills: (kind, id, skillIds) => invoke("setSessionSkills", [kind, id, skillIds]),
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
    // Browsers receive links through the page URL; only the desktop app has OS-delivered links.
    consumePendingDeepLink: async () => null,
    onProjectLoopChanged: (listener) => subscribe("loop", listener),
    onProjectTaskChanged: (listener) => subscribe("task", listener),
    onRunOrganizationChanged: (listener) => subscribe("run-organization", listener),
    onOrchestrationChanged: (listener) => subscribe("orchestration", listener),
    onRunForgeRequestChanged: (listener) => subscribe("forge", listener),
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
        const requiredScopes = REMOTE_MUTATION_SCOPES.get(property as RemoteApiMethod);
        if (!requiredScopes) {
          return async () => {
            throw new Error(`"${property}" is disabled because its remote authorization policy is not configured.`);
          };
        }
        const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
        if (missingScopes.length > 0) {
          return async () => {
            const reason = capabilities.mutations ? "this remote session" : "the read-only remote client";
            throw new Error(`"${property}" is not available for ${reason}; missing ${missingScopes.join(", ")}.`);
          };
        }
        return (...args: unknown[]) => invoke(property as RemoteApiMethod, args as never);
      }
      return async () => {
        throw new Error(`"${property}" is not available in the read-only remote client.`);
      };
    },
  });

  composerDraftStore.observeEnvironment(client.draftScopeId!);
  return withComposerDraftCleanup(client, client.draftScopeId!);
};
