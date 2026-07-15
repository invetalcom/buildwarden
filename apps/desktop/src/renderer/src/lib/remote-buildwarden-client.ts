import {
  APP_SETTING_KEYS,
  DEFAULT_NETWORK_PROXY_SETTINGS,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  type AppSnapshot,
  type DesktopApi,
  type RemoteApiMethod,
  type RemoteApiMethodArgs,
  type RemoteApiMethodResult,
  type RemoteRpcResponse,
} from "@buildwarden/shared";
import type { BuildWardenClient, BuildWardenClientCapabilities } from "./buildwarden-client-core";

const WEB_CAPABILITIES: Readonly<BuildWardenClientCapabilities> = Object.freeze({
  platform: "web",
  nativeTitleBar: false,
  nativeAppMenu: false,
  directoryPicker: false,
  ideIntegration: false,
  fileManager: false,
  systemTerminal: false,
  embeddedTerminal: false,
  settings: false,
  mutations: false,
  liveEvents: false,
});

const REMOTE_READ_METHODS = new Set<RemoteApiMethod>([
  "getSnapshot",
  "refreshSnapshot",
  "getProjectBranches",
  "getProjectCurrentBranch",
  "getRunDetail",
  "getRunWorktreeDiff",
  "getRunWorkspaceFile",
  "getProjectLoopUiReviewImage",
  "getChatDetail",
  "listChatsWithSteps",
  "getBookmarksWithSteps",
  "getChatBookmarksWithSteps",
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

const remoteSettings = (snapshot: AppSnapshot, localSettings: Record<string, string>): Record<string, string> => {
  const settings: Record<string, string> = {};
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
  fetch?: typeof globalThis.fetch;
  onSessionExpired?: () => void;
}

export const createRemoteBuildWardenClient = (options: RemoteBuildWardenClientOptions = {}): BuildWardenClient => {
  const baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "";
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let selectedProjectId: string | null = null;
  let selectedRunId: string | null = null;
  let localSettings = readLocalSettings();

  const invoke = async <Method extends RemoteApiMethod>(
    method: Method,
    args: RemoteApiMethodArgs<Method>,
  ): Promise<RemoteApiMethodResult<Method>> => {
    const response = await fetcher(`${baseUrl}${REMOTE_ACCESS_RPC_PATH}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        method,
        args,
      }),
    });
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
      settings: remoteSettings(snapshot, localSettings),
    };
  };

  const localApi: Partial<DesktopApi> & { capabilities: Readonly<BuildWardenClientCapabilities> } = {
    capabilities: WEB_CAPABILITIES,
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
      if (!REMOTE_LOCAL_SETTING_KEYS.has(key)) return;
      localSettings = { ...localSettings, [key]: value };
      writeLocalSettings(localSettings);
    },
    getNetworkProxySettings: async () => ({ ...DEFAULT_NETWORK_PROXY_SETTINGS, hasPassword: false }),
    getAppPaths: async () => ({ logDirPath: "", logDirectorySize: { totalBytes: 0, fileCount: 0, unreadableEntryCount: 0 } }),
    getDetectedCodexInstallation: async () => ({ binaryPath: null }),
    getDetectedClaudeInstallation: async () => ({ binaryPath: null }),
    getDetectedCursorInstallation: async () => ({ binaryPath: null }),
    listIntegratedSkills: async () => [],
    getIntegratedSkillContent: async () => null,
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
  };

  const client = new Proxy(localApi as BuildWardenClient, {
    get(target, property, receiver) {
      const existing = Reflect.get(target, property, receiver) as unknown;
      if (existing !== undefined) return existing;
      if (typeof property !== "string") return undefined;
      if (property.startsWith("on")) return () => () => {};
      if (REMOTE_READ_METHODS.has(property as RemoteApiMethod)) {
        return (...args: unknown[]) => invoke(property as RemoteApiMethod, args as never);
      }
      return async () => {
        throw new Error(`"${property}" is not available in the read-only remote client.`);
      };
    },
  });

  return client;
};
