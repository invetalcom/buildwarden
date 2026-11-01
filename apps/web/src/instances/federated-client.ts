import { APP_SETTING_KEYS, type AppSnapshot, type DesktopApi, type RunOrganizationSnapshot } from "@buildwarden/shared";
import { mapEntityIds, parseScopedId, scopedId, isRemoteBrowserSetting, readRemoteUiSettings, type BuildWardenClient } from "@buildwarden/renderer";
import { EMPTY_SNAPSHOT } from "@buildwarden/renderer/logic";
import type { InstanceManager, ConnectedInstance } from "./instance-manager";

type Method = keyof DesktopApi;
type Callable = (...args: unknown[]) => unknown;
const AGGREGATE_READS = new Set<Method>(["getAttentionInbox", "getBookmarksWithSteps", "getChatBookmarksWithSteps", "listChats", "listChatsWithSteps", "searchRunUserInput"]);
const HOST_METHODS = new Set<Method>([
  "getNetworkProxySettings", "saveNetworkProxySettings", "getUsageCostReport", "getProviderCliUpdates", "checkProviderCliUpdates", "runProviderCliUpdate",
  "getAppPaths", "getDetectedCodexInstallation", "getDetectedClaudeInstallation", "getDetectedCursorInstallation", "listIntegratedSkills", "getIntegratedSkillContent",
  "listHostDirectories", "checkProjectFolderGitStatus", "addProject", "addProviderAccount", "addModel", "listAvailableProviderModels", "listComposerCommands",
  "createChat", "createRunSection", "setAppSetting", "pickProjectDirectory", "pickIdeExecutable", "openExternalUrl", "reportRendererLog",
  "getRemoteAccessStatus", "createRemoteAccessPairing", "listRemoteAccessSessions", "revokeRemoteAccessSession", "getDataRetentionCleanupImpact",
  "deleteDataRetentionCandidates", "getStartupAutomationCatchUp", "resolveStartupAutomationCatchUp",
  "openPathInFileManager", "openFolderInIde", "openSystemTerminalAtPath", "exportDataBackup", "selectDataBackupForImport", "importDataBackup", "resetDatabase", "showAppMenu",
]);
const HOST_ENTITY_ARGUMENTS = new Set<Method>(["getIntegratedSkillContent", "revokeRemoteAccessSession"]);
// Provider catalogs and external forge IDs are not BuildWarden entity IDs.
const RAW_RESULTS = new Set<Method>(["listIntegratedSkills", "listAvailableProviderModels", "listComposerCommands", "listProjectForgeRequests", "getProjectForgeRequestDetails", "getProjectForgeRequestStatus", "getRunForgeRequestDetails", "refreshRunForgeRequest", "updateProjectForgeRequest", "mergeProjectForgeRequest", "updateRunForgeRequest", "mergeRunForgeRequest", "getProviderCliUpdates", "checkProviderCliUpdates", "runProviderCliUpdate"]);
const ORGANIZATION_METHODS = new Set<Method>(["createRunSection", "setRunSectionColor", "renameRunSection", "deleteRunSection", "reorderRunSections", "updateRunOrganization"]);
const PROJECT_SETTINGS = new Set<string>([APP_SETTING_KEYS.projectRunDefaults, APP_SETTING_KEYS.projectActiveSkills, APP_SETTING_KEYS.projectLabSettings, APP_SETTING_KEYS.projectForgePrMonitorSettings, APP_SETTING_KEYS.revisionVerificationPolicy]);

const rawClientCall = (client: BuildWardenClient, method: string, args: unknown[]) => (client[method as Method] as Callable)(...args);
const encode = <T>(instanceId: string, value: T): T => mapEntityIds(value, (id) => id ? scopedId(instanceId, id) : id);
const decode = <T>(value: T, owners: Set<string>): T => mapEntityIds(value, (id) => {
  const ref = parseScopedId(id);
  if (!ref) return id;
  owners.add(ref.instanceId); return ref.id;
});
const mapSettingReferences = (value: unknown, map: (id: string) => string): unknown => {
  if (Array.isArray(value)) return value.map((item) => mapSettingReferences(item, map));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ["modelId", "providerAccountId", "preferredModelId"].includes(key) && typeof item === "string" && item ? map(item)
      : key === "worktreeModelIds" && Array.isArray(item) ? item.map((id: string) => map(id))
      : key === "modelConfigurations" && item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([id, config]) => [map(id), config]))
      : mapSettingReferences(item, map),
  ]));
};
const mapSetting = (key: string, value: unknown, map: (id: string) => string): unknown => {
  const mapped = mapSettingReferences(value, map);
  return PROJECT_SETTINGS.has(key) && mapped && typeof mapped === "object" && !Array.isArray(mapped)
    ? Object.fromEntries(Object.entries(mapped).map(([id, config]) => [map(id), config])) : mapped;
};

export class FederatedWorkspace {
  private selectedProjectId: string | null = null;
  private selectedRunId: string | null = null;
  private activeId: string | null = null;
  private version = 0;
  private listeners = new Set<() => void>();
  private projectOrder: string[] = [];
  private browserSettings: Record<string, string> = {};
  private lastRefresh = 0;
  private cache = new Map<string, unknown[]>();
  private clients = new Map<string | null, BuildWardenClient>();
  constructor(readonly manager: Pick<InstanceManager, "getSnapshot" | "subscribe" | "refresh">) {
    try { this.activeId = localStorage.getItem("buildwarden.instances.active"); this.selectedProjectId = localStorage.getItem("buildwarden.instances.project"); const order: unknown = JSON.parse(localStorage.getItem("buildwarden.instances.project-order") ?? "[]"); if (Array.isArray(order)) this.projectOrder = order.filter((id): id is string => typeof id === "string"); } catch { /* Private browsing. */ }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private notify() { this.version++; this.listeners.forEach((listener) => listener()); }
  get activeInstanceId() {
    const instances = this.manager.getSnapshot().instances;
    return instances.some((entry) => entry.connection.id === this.activeId) ? this.activeId : instances[0]?.connection.id ?? null;
  }
  selectInstance = (id: string) => {
    if (!this.manager.getSnapshot().instances.some((entry) => entry.connection.id === id)) return;
    if (this.activeId === id) return;
    this.activeId = id;
    try { localStorage.setItem("buildwarden.instances.active", id); } catch { /* Keep in memory. */ }
    this.notify();
  };
  private entry(id: string | null): ConnectedInstance {
    const entry = this.manager.getSnapshot().instances.find((item) => item.connection.id === id);
    if (!entry?.client || entry.status !== "online") throw new Error(`${entry?.connection.name ?? "This instance"} is not connected. Reconnect it in Manage instances.`);
    return entry;
  }
  snapshot(defaultId: string | null): AppSnapshot {
    const entries = this.manager.getSnapshot().instances;
    const snapshots = entries.flatMap((entry) => entry.snapshot ? [{ id: entry.connection.id, snapshot: encode(entry.connection.id, entry.snapshot) }] : []);
    const active = snapshots.find((entry) => entry.id === defaultId)?.snapshot;
    const rawSettings = entries.find((entry) => entry.connection.id === defaultId)?.snapshot?.settings ?? {};
    const settings = { ...rawSettings, ...readRemoteUiSettings(), ...this.browserSettings };
    if (defaultId) {
      for (const [key, value] of Object.entries(settings)) {
        if (key === APP_SETTING_KEYS.lastUsedRunModelId && value) settings[key] = scopedId(defaultId, value);
        else if (value.startsWith("{")) {
          try { settings[key] = JSON.stringify(mapSetting(key, JSON.parse(value) as unknown, (id) => scopedId(defaultId, id))); } catch { /* Plain settings remain unchanged. */ }
        }
      }
    }
    const projects = snapshots.flatMap((entry) => entry.snapshot.projects);
    if (this.projectOrder.length) projects.sort((a, b) => {
      const left = this.projectOrder.indexOf(a.project.id); const right = this.projectOrder.indexOf(b.project.id);
      return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right);
    });
    const selectedProjectId = projects.some((entry) => entry.project.id === this.selectedProjectId) ? this.selectedProjectId : active?.selectedProjectId ?? projects[0]?.project.id ?? null;
    return {
      ...EMPTY_SNAPSHOT, ...active, settings, projects, selectedProjectId, selectedRunId: this.selectedRunId,
      chats: snapshots.flatMap((entry) => entry.snapshot.chats), bookmarks: snapshots.flatMap((entry) => entry.snapshot.bookmarks), chatBookmarks: snapshots.flatMap((entry) => entry.snapshot.chatBookmarks),
      providerAccounts: snapshots.flatMap((entry) => entry.snapshot.providerAccounts), models: snapshots.flatMap((entry) => entry.snapshot.models),
      runOrganization: this.organization(snapshots.map((entry) => entry.snapshot.runOrganization)),
    };
  }
  private organization(snapshots: Array<RunOrganizationSnapshot | undefined>): RunOrganizationSnapshot {
    return { sections: snapshots.flatMap((snapshot) => snapshot?.sections ?? []), runs: snapshots.flatMap((snapshot) => snapshot?.runs ?? []) };
  }
  private async aggregate(method: Method, args: unknown[]): Promise<unknown[]> {
    const entries = this.manager.getSnapshot().instances;
    const results = await Promise.all(entries.map(async (entry) => {
      const key = JSON.stringify([entry.connection.id, method, args]);
      if (entry.status !== "online" || !entry.client) return this.cache.get(key) ?? [];
      try {
        const result = await rawClientCall(entry.client, method, args) as unknown[];
        const mapped = method === "searchRunUserInput" ? result.map((id) => scopedId(entry.connection.id, String(id))) : encode(entry.connection.id, result);
        this.cache.set(key, mapped); return mapped;
      } catch { return this.cache.get(key) ?? []; }
    }));
    return results.flat();
  }
  /** A facade captures the default host. In-flight settings callbacks cannot jump to another host. */
  client(defaultId: string | null): BuildWardenClient {
    const existing = this.clients.get(defaultId);
    if (existing) return existing;
    const client = new Proxy({} as BuildWardenClient, {
      get: (_target, key) => {
        if (key === "capabilities") {
          const entry = this.manager.getSnapshot().instances.find((item) => item.connection.id === defaultId);
          const fallback = this.manager.getSnapshot().instances.find((item) => item.client)?.client;
          const capabilities = entry?.client?.capabilities ?? fallback?.capabilities;
          if (!capabilities) return { platform: "web", liveEvents: true };
          return entry?.status === "online" ? capabilities : Object.fromEntries(Object.entries(capabilities).map(([name, value]) => [name, name === "platform" ? "web" : name === "liveEvents" ? true : typeof value === "boolean" ? false : value]));
        }
        if (typeof key !== "string" || key === "then") return undefined;
        if (key.startsWith("on")) return (listener: (...args: unknown[]) => void, runIds?: string[]) => this.listen(key, listener, runIds, defaultId);
        return (...args: unknown[]) => this.invoke(defaultId, key as Method, args);
      },
    });
    this.clients.set(defaultId, client);
    return client;
  }
  private listen(method: string, listener: (...args: unknown[]) => void, runIds: string[] | undefined, defaultId: string | null) {
    const subscriptions = new Map<string, { client: BuildWardenClient; dispose: () => void }>();
    const sync = () => {
      const entries = this.manager.getSnapshot().instances;
      for (const [id, subscription] of subscriptions) if (!entries.some((entry) => entry.connection.id === id && entry.client === subscription.client)) { subscription.dispose(); subscriptions.delete(id); }
      for (const entry of entries) {
        if (!entry.client || subscriptions.has(entry.connection.id)) continue;
        if (method === "onProviderCliUpdatesChanged" && entry.connection.id !== defaultId) continue;
        const scopedRuns = runIds?.flatMap((id) => { const ref = parseScopedId(id); return ref?.instanceId === entry.connection.id ? [ref.id] : []; });
        if (method === "onRunBrowserEvent" && runIds && !scopedRuns?.length) continue;
        const dispose = rawClientCall(entry.client, method, [(...args: unknown[]) => listener(...args.map((value) => encode(entry.connection.id, value))), ...(scopedRuns ? [scopedRuns] : [])]) as () => void;
        subscriptions.set(entry.connection.id, { client: entry.client, dispose });
      }
    };
    sync();
    const stop = this.manager.subscribe(() => { sync(); if (method === "onRunOrganizationChanged") listener(); });
    const stopSelection = method === "onRunOrganizationChanged" ? this.subscribe(() => listener()) : () => {};
    return () => { stop(); stopSelection(); subscriptions.forEach((entry) => entry.dispose()); };
  }
  private async invoke(defaultId: string | null, method: Method, args: unknown[]): Promise<unknown> {
    if (method === "getSnapshot" || method === "refreshSnapshot") {
      if (Date.now() - this.lastRefresh > 5_000) { this.lastRefresh = Date.now(); this.manager.getSnapshot().instances.forEach((entry) => { void this.manager.refresh(entry.connection.id); }); }
      return this.snapshot(defaultId);
    }
    if (AGGREGATE_READS.has(method)) return this.aggregate(method, args);
    if (method === "setAppSetting" && isRemoteBrowserSetting(args[0] as string)) {
      const client = this.manager.getSnapshot().instances.find((entry) => entry.client)?.client;
      if (!client) throw new Error("Connect an instance to initialize browser preferences.");
      await client.setAppSetting(args[0] as string, args[1] as string); this.browserSettings[args[0] as string] = args[1] as string; this.notify(); return;
    }
    if (method === "reorderProjects") { this.projectOrder = args[0] as string[]; try { localStorage.setItem("buildwarden.instances.project-order", JSON.stringify(this.projectOrder)); } catch { /* Keep in memory. */ } this.notify(); return; }
    if (method === "acknowledgeAttentionItems" || method === "reorderRunSections" || method === "resolveStartupAutomationCatchUp") {
      const groups = new Map<string, string[]>();
      for (const value of args[0] as string[]) {
        const ref = parseScopedId(value); if (!ref) throw new Error("Missing instance on this item.");
        groups.set(ref.instanceId, [...(groups.get(ref.instanceId) ?? []), ref.id]);
      }
      // Check every destination before sending a batch; never fall back to the selected host.
      const destinations = [...groups].map(([id, ids]) => ({ entry: this.entry(id), ids }));
      const results = [];
      for (const { entry, ids } of destinations) results.push(encode(entry.connection.id, await rawClientCall(entry.client!, method, [ids])));
      await Promise.all(destinations.map(({ entry }) => this.manager.refresh(entry.connection.id)));
      return method === "reorderRunSections" ? this.snapshot(defaultId).runOrganization : method === "resolveStartupAutomationCatchUp" ? results.flat() : undefined;
    }
    const owners = new Set<string>();
    const wireArgs = args.map((arg, index) => {
      // Only the first positional string is an entity reference. Other strings can be prompts or tokens.
      if (index === 0 && typeof arg === "string" && method !== "setAppSetting" && (!HOST_METHODS.has(method) || HOST_ENTITY_ARGUMENTS.has(method))) {
        const ref = parseScopedId(arg); if (ref) { owners.add(ref.instanceId); return ref.id; }
      }
      // Answers are keyed by arbitrary question IDs, and their values are user text.
      if ((method === "respondToRunUserInput" || method === "respondToChatUserInput") && index === 2) return arg;
      return typeof arg === "object" ? decode(arg, owners) : arg;
    });
    if (owners.size > 1) throw new Error("These items belong to different instances. Select a model and workspace from the same instance.");
    const owner = [...owners][0] ?? defaultId;
    if (!owners.size && !HOST_METHODS.has(method) && !(method === "setRunSectionColor" && args[0] === "uncategorized")) throw new Error(`Cannot route ${method} without an instance-owned item.`);
    if (method === "selectProject") {
      const changed = this.selectedProjectId !== args[0];
      this.selectedProjectId = args[0] as string; this.selectedRunId = null;
      try { localStorage.setItem("buildwarden.instances.project", this.selectedProjectId); } catch { /* Keep in memory. */ }
      this.selectInstance(owner!); if (changed) this.notify(); return;
    }
    if (method === "activateRun") { this.selectedRunId = args[0] as string; this.selectInstance(owner!); return; }
    if (method === "releaseRun") { if (this.selectedRunId === args[0]) this.selectedRunId = null; return; }
    if (method === "respondToShellApproval" || method === "respondToRunUserInput" || method === "respondToChatUserInput" || method === "cancelRunShell") {
      const ref = parseScopedId(args[1] as string);
      if (ref) { if (ref.instanceId !== owner) throw new Error("The request belongs to a different instance."); wireArgs[1] = ref.id; }
    }
    if (method === "setAppSetting") {
      if (args[0] === APP_SETTING_KEYS.lastUsedRunModelId) {
        const ref = parseScopedId(args[1] as string);
        if (ref && ref.instanceId !== owner) throw new Error("Settings contain references to a different instance.");
        wireArgs[1] = ref?.id ?? args[1];
      }
      else if (typeof args[1] === "string" && args[1].startsWith("{")) {
        try { wireArgs[1] = JSON.stringify(mapSetting(args[0] as string, JSON.parse(args[1]) as unknown, (value) => { const ref = parseScopedId(value); if (ref) owners.add(ref.instanceId); return ref?.id ?? value; })); } catch { /* Plain text is preserved. */ }
        if ([...owners].some((id) => id !== owner)) throw new Error("Settings contain references to a different instance.");
      }
    }
    const entry = this.entry(owner);
    const result = await rawClientCall(entry.client!, method, wireArgs);
    const isWrite = !/^(get|list|check|query|search|is|open|pick|report)/.test(method);
    if (isWrite) await this.manager.refresh(entry.connection.id);
    if (ORGANIZATION_METHODS.has(method)) return this.snapshot(defaultId).runOrganization;
    return RAW_RESULTS.has(method) ? result : encode(entry.connection.id, result);
  }
}
