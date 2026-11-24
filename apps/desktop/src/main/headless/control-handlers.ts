import {
  APP_SETTING_KEYS,
  REMOTE_ACCESS_SCOPES,
  isNetworkProxyProtocol,
  normalizeRemoteAccessWebOrigin,
  parseRemoteAccessWebOriginsSetting,
  serializeRemoteAccessWebOriginsSetting,
  type NetworkProxySettingsInput,
  type NetworkProxySettingsSnapshot,
  type RemoteAccessPairingGrant,
  type RemoteAccessPairingInput,
  type RemoteAccessScope,
  type RemoteAccessSession,
  type RemoteAccessStatus,
} from "@buildwarden/shared";
import { requireAbsolutePath, requireText } from "./control-input";
import { createHostSetupHandlers, type HostSetupDependencies } from "./control-setup-handlers";
import type { HostControlHandlers, HostStatus } from "./control-protocol";

export interface HostControlDependencies {
  info: Pick<HostStatus, "version" | "pid" | "startedAt" | "dataDir" | "logDir" | "secretStorage">;
  setup: HostSetupDependencies;
  db: {
    getSettings(): Record<string, string>;
    setSetting(key: string, value: string): void;
    listRemoteAccessSessions(): RemoteAccessSession[];
  };
  controller: {
    getNetworkProxySettings(): Promise<NetworkProxySettingsSnapshot>;
    saveNetworkProxySettings(input: NetworkProxySettingsInput): Promise<NetworkProxySettingsSnapshot>;
    getActiveSessionCounts(): { runs: number; chats: number };
  };
  remote: {
    getStatus(): Promise<RemoteAccessStatus>;
    applyExposure(): Promise<void>;
    createPairing(input: RemoteAccessPairingInput): Promise<RemoteAccessPairingGrant>;
    revokeSession(sessionId: string): Promise<boolean>;
  };
  backup: {
    exportTo(filePath: string, password: string): Promise<unknown>;
    restoreFrom(filePath: string, password: string): Promise<{ createdAt: string }>;
  };
  /** Called after the answer had time to reach the terminal. */
  onStop: () => void;
  onRestart: () => void;
}

const RESPONSE_DELAY_MS = 200;

const requireScopes = (value: unknown): RemoteAccessScope[] | undefined => {
  if (value === undefined) return undefined;
  const known: readonly string[] = REMOTE_ACCESS_SCOPES;
  if (!Array.isArray(value) || value.length === 0 || value.some((scope) => !known.includes(String(scope)))) {
    throw new Error(`Scopes must come from: ${known.join(", ")}.`);
  }
  return value as RemoteAccessScope[];
};

const requireOrigin = (value: string): string => {
  const origin = normalizeRemoteAccessWebOrigin(value);
  if (!origin) throw new Error("Enter an exact HTTPS origin, such as https://buildwarden-app.vercel.app.");
  return origin;
};

const isActiveSession = (session: RemoteAccessSession): boolean =>
  session.revokedAt == null && Date.parse(session.expiresAt) > Date.now();

/** What terminal commands may do. Inputs arrive as untyped JSON, so each handler checks its own. */
export const createHostControlHandlers = (deps: HostControlDependencies): HostControlHandlers => {
  const { db, controller, remote } = deps;
  const activeSessions = () => db.listRemoteAccessSessions().filter(isActiveSession);
  const afterResponse = (action: () => void) => void setTimeout(action, RESPONSE_DELAY_MS);

  return {
    status: async () => {
      const active = controller.getActiveSessionCounts();
      return {
        ...deps.info,
        remote: await remote.getStatus(),
        pairedDevices: activeSessions().length,
        projects: deps.setup.db.listProjects().length,
        activeRuns: active.runs,
        activeChats: active.chats,
        proxy: await controller.getNetworkProxySettings(),
      };
    },
    stop: async () => {
      afterResponse(deps.onStop);
      return null;
    },
    pair: async (input) => {
      const clientOrigin = input?.clientOrigin === undefined ? undefined : requireOrigin(requireText(input.clientOrigin, "Origin"));
      return remote.createPairing({ scopes: requireScopes(input?.scopes), ...(clientOrigin ? { clientOrigin } : {}) });
    },
    remoteExpose: async (input) => {
      if (!["local", "tailnet", "internet"].includes(input?.exposure)) throw new Error("Choose local, private or internet.");
      db.setSetting(APP_SETTING_KEYS.remoteAccessExposure, input.exposure);
      await remote.applyExposure();
      return remote.getStatus();
    },
    remoteOrigins: async (input) => {
      const origins = new Set(parseRemoteAccessWebOriginsSetting(db.getSettings()[APP_SETTING_KEYS.remoteAccessWebOrigins]));
      if (input?.add === undefined && input?.remove === undefined) return [...origins];
      if (input.add !== undefined) origins.add(requireOrigin(requireText(input.add, "Origin")));
      if (input.remove !== undefined && !origins.delete(requireOrigin(requireText(input.remove, "Origin")))) {
        throw new Error("This origin is not in the list.");
      }
      db.setSetting(APP_SETTING_KEYS.remoteAccessWebOrigins, serializeRemoteAccessWebOriginsSetting(origins));
      return [...origins];
    },
    listSessions: async () => activeSessions(),
    revokeSession: async (input) => remote.revokeSession(requireText(input?.sessionId, "Session id")),
    proxyShow: () => controller.getNetworkProxySettings(),
    proxySet: async (input) => {
      if (!isNetworkProxyProtocol(input?.protocol)) throw new Error("The proxy protocol must be http or https.");
      if (input.password !== undefined && typeof input.password !== "string") throw new Error("The proxy password is invalid.");
      return controller.saveNetworkProxySettings({
        enabled: true,
        protocol: input.protocol,
        host: requireText(input.host, "Proxy host"),
        port: requireText(input.port, "Proxy port"),
        username: typeof input.username === "string" ? input.username : "",
        // A saved password belongs to the previous proxy and must not be sent to another one.
        ...(input.password ? { password: input.password } : { clearSavedPassword: true }),
      });
    },
    proxyEnable: async (input) => {
      const { protocol, host, port, username } = await controller.getNetworkProxySettings();
      return controller.saveNetworkProxySettings({ enabled: input?.enabled === true, protocol, host, port, username });
    },
    proxyClear: () => controller.saveNetworkProxySettings({
      enabled: false, protocol: "http", host: "", port: "", username: "", clearSavedPassword: true,
    }),
    ...createHostSetupHandlers(deps.setup),
    backupCreate: async (input) => {
      const filePath = requireAbsolutePath(input?.filePath, "Backup file");
      await deps.backup.exportTo(filePath, requireText(input?.password, "Backup password"));
      return { filePath };
    },
    backupRestore: async (input) => {
      const restored = await deps.backup.restoreFrom(
        requireAbsolutePath(input?.filePath, "Backup file"),
        requireText(input?.password, "Backup password"),
      );
      afterResponse(deps.onRestart);
      return restored;
    },
  };
};
