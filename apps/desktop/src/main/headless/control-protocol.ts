import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  DatabaseCompactResult,
  DatabaseStorageInfo,
  DataRetentionCleanupImpact,
  ModelDeletionImpact,
  NetworkProxySettingsSnapshot,
  ProjectForgeAuthStatus,
  ProviderCliUpdateSnapshot,
  ProviderType,
  RemoteAccessAgentToken,
  RemoteAccessExposure,
  RemoteAccessPairingGrant,
  RemoteAccessScope,
  RemoteAccessSession,
  RemoteAccessStatus,
  UnifiedProviderFamily,
} from "@buildwarden/shared";

export interface HostStatus {
  version: string;
  pid: number;
  /** Identifies the start by systemd this host comes from. */
  invocationId: string | null;
  startedAt: string;
  dataDir: string;
  logDir: string | null;
  secretStorage: string;
  remote: RemoteAccessStatus;
  pairedDevices: number;
  projects: number;
  activeRuns: number;
  activeChats: number;
  proxy: NetworkProxySettingsSnapshot;
}

export interface HostProject {
  id: string;
  name: string;
  path: string;
  kind: string;
}

export interface HostProvider {
  id: string;
  label: string;
  type: ProviderType;
  models: number;
}

export interface HostModel {
  id: string;
  modelId: string;
  name: string;
  provider: string;
}

export interface HostAutomation {
  id: string;
  name: string;
  project: string;
  enabled: boolean;
  nextRunAt: string;
  lastError: string | null;
}

export interface HostRun {
  id: string;
  status: string;
  project: string;
  title: string;
  createdAt: string;
}

/** Options of `provider add` that end up in the provider's configuration. */
export const PROVIDER_OPTION_NAMES = ["binary", "home", "launch-args", "auto-compact-window", "endpoint", "command", "env", "api-version"] as const;
export type ProviderOptionName = (typeof PROVIDER_OPTION_NAMES)[number];

/** Every request a terminal command can send to the running host. */
interface HostControlApi {
  status: { input: undefined; output: HostStatus };
  stop: { input: undefined; output: null };
  pair: { input: { scopes?: RemoteAccessScope[]; clientOrigin?: string }; output: RemoteAccessPairingGrant };
  agentToken: { input: { readOnly?: boolean }; output: RemoteAccessAgentToken };
  remoteExpose: { input: { exposure: RemoteAccessExposure }; output: RemoteAccessStatus };
  remoteOrigins: { input: { add?: string; remove?: string }; output: string[] };
  listSessions: { input: undefined; output: RemoteAccessSession[] };
  revokeSession: { input: { sessionId: string }; output: boolean };
  proxyShow: { input: undefined; output: NetworkProxySettingsSnapshot };
  proxySet: {
    input: { protocol: "http" | "https"; host: string; port: string; username: string; password?: string };
    output: NetworkProxySettingsSnapshot;
  };
  proxyEnable: { input: { enabled: boolean }; output: NetworkProxySettingsSnapshot };
  proxyClear: { input: undefined; output: NetworkProxySettingsSnapshot };
  listProjects: { input: undefined; output: HostProject[] };
  addProject: { input: { path: string; name?: string }; output: HostProject };
  projectImpact: { input: { project: string }; output: { project: HostProject; runs: number; activeRuns: number } };
  removeProject: { input: { projectId: string }; output: null };
  projectToken: { input: { project: string }; output: ProjectForgeAuthStatus };
  setProjectToken: { input: { project: string; token: string }; output: ProjectForgeAuthStatus };
  removeProjectToken: { input: { project: string }; output: ProjectForgeAuthStatus };
  listProviders: { input: undefined; output: HostProvider[] };
  findProvider: { input: { provider: string }; output: HostProvider };
  detectProviders: { input: undefined; output: Array<{ type: ProviderType; label: string; path: string | null; message?: string }> };
  addProvider: {
    input: {
      providerType: ProviderType;
      family?: UnifiedProviderFamily;
      label: string;
      apiKey: string;
      apiBaseUrl?: string;
      configJson?: string;
      options: Partial<Record<ProviderOptionName, string>>;
    };
    output: HostProvider;
  };
  setProviderKey: { input: { provider: string; apiKey: string }; output: HostProvider };
  checkProvider: { input: { provider: string }; output: { message: string } };
  removeProvider: { input: { provider: string }; output: null };
  listModels: { input: undefined; output: HostModel[] };
  availableModels: {
    input: { provider: string };
    output: { models: Array<{ modelId: string; name: string; added: boolean }>; errorMessage?: string };
  };
  addModel: { input: { provider: string; modelId: string; name?: string; baseUrl?: string }; output: HostModel };
  modelImpact: { input: { model: string }; output: ModelDeletionImpact };
  removeModel: { input: { modelId: string }; output: null };
  providerClis: { input: undefined; output: ProviderCliUpdateSnapshot };
  checkProviderClis: { input: undefined; output: ProviderCliUpdateSnapshot };
  updateProviderCli: { input: { providerType: ProviderType }; output: ProviderCliUpdateSnapshot };
  enableProviderCliUpdates: { input: { enabled: boolean }; output: ProviderCliUpdateSnapshot };
  listAutomations: { input: undefined; output: HostAutomation[] };
  runAutomation: { input: { automation: string }; output: { runId: string } };
  enableAutomation: { input: { automation: string; enabled: boolean }; output: HostAutomation };
  listRuns: { input: { all: boolean }; output: HostRun[] };
  cancelRun: { input: { run: string }; output: HostRun };
  storage: { input: undefined; output: DatabaseStorageInfo & { diskFreeBytes: number } };
  compactStorage: { input: undefined; output: DatabaseCompactResult };
  cleanupImpact: { input: { days: number }; output: DataRetentionCleanupImpact };
  cleanup: { input: { days: number; cutoffAt: string }; output: DataRetentionCleanupImpact };
  backupCreate: { input: { filePath: string; password: string }; output: { filePath: string } };
  backupRestore: { input: { filePath: string; password: string }; output: { createdAt: string } };
}

type HostControlMethod = keyof HostControlApi;

export type HostControlHandlers = {
  [Method in HostControlMethod]: (input: HostControlApi[Method]["input"]) => Promise<HostControlApi[Method]["output"]>;
};

export type HostControlRequest = <Method extends HostControlMethod>(
  method: Method,
  ...input: HostControlApi[Method]["input"] extends undefined ? [] : [HostControlApi[Method]["input"]]
) => Promise<HostControlApi[Method]["output"]>;

export type HostControlResponse = { ok: true; result: unknown } | { ok: false; error: string };

export const MAX_CONTROL_MESSAGE_BYTES = 256 * 1024;

export class HostNotRunningError extends Error {}

/** A socket inside an owner-only directory; on Windows, where only tests use it, a named pipe. */
export const controlSocketPath = (dataDir: string, platform: NodeJS.Platform = process.platform): string =>
  platform === "win32"
    ? `\\\\.\\pipe\\buildwarden-${createHash("sha256").update(dataDir).digest("hex").slice(0, 24)}`
    : join(dataDir, "control", "host.sock");
