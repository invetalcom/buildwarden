import {
  REMOTE_ACCESS_PAIRING_PATH, REMOTE_ACCESS_SESSION_PATH,
  type AppSnapshot, type AttentionItem, type BookmarkRecord, type ChatBookmarkRecord,
  type RemoteAccessPairingExchangeResponse,
} from "@buildwarden/shared";
import { createRemoteBuildWardenClient, RemoteSessionExpiredError, type BuildWardenClient } from "@buildwarden/renderer";
import {
  defaultInstanceName, readInstanceConnections, removeInstanceConnection, saveInstanceConnection,
  type InstanceConnection,
} from "../hosted-connection-store";
import { normalizeRemoteHostOrigin } from "../remote-pairing-code";

export type InstanceStatus = "connecting" | "online" | "offline" | "pairing-required";
export interface ConnectedInstance {
  connection: InstanceConnection;
  status: InstanceStatus;
  client: BuildWardenClient | null;
  snapshot: AppSnapshot | null;
  attention: AttentionItem[];
  bookmarks: BookmarkRecord[];
  chatBookmarks: ChatBookmarkRecord[];
  bookmarksLoaded: boolean;
  lastSeen: number | null;
  error?: string;
  attentionError?: string;
  bookmarksError?: string;
}
interface RegistryState { loaded: boolean; instances: ConnectedInstance[]; error?: string }
interface Dependencies {
  read: typeof readInstanceConnections;
  save: typeof saveInstanceConnection;
  remove: typeof removeInstanceConnection;
  fetch: typeof fetch;
  createClient: typeof createRemoteBuildWardenClient;
  cookieOrigin?: string;
}

/** Owns each connection, its credentials, and its independently refreshed snapshot. */
export class InstanceManager {
  private state: RegistryState = { loaded: false, instances: [] };
  private listeners = new Set<() => void>();
  private running = false;
  private generation = 0;
  private timer?: ReturnType<typeof setInterval>;
  private disposers = new Map<string, () => void>();
  private pending = new Map<string, Promise<void>>();
  private bookmarkPending = new Map<string, Promise<void>>();
  private deps: Dependencies;

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.deps = { read: readInstanceConnections, save: saveInstanceConnection, remove: removeInstanceConnection, fetch: (input, init) => fetch(input, init), createClient: createRemoteBuildWardenClient, ...dependencies };
  }
  private request: typeof fetch = (input, init) => this.deps.fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
  getSnapshot = (): RegistryState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: RegistryState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private update(id: string, patch: Partial<ConnectedInstance>) {
    this.publish({ ...this.state, instances: this.state.instances.map((entry) => entry.connection.id === id ? { ...entry, ...patch } : entry) });
  }
  private find(id: string) { return this.state.instances.find((entry) => entry.connection.id === id); }
  private fresh(connection: InstanceConnection): ConnectedInstance {
    return { connection, status: "connecting", client: null, snapshot: null, attention: [], bookmarks: [], chatBookmarks: [], bookmarksLoaded: false, lastSeen: null };
  }
  start = async () => {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    try {
      const connections = await this.deps.read();
      if (!this.running || generation !== this.generation) return;
      this.publish({ loaded: connections.length > 0 || !this.deps.cookieOrigin, instances: connections.map((connection) => this.fresh(connection)) });
      connections.forEach((connection) => { void this.refresh(connection.id); });
      if (this.deps.cookieOrigin && !connections.some((connection) => connection.cookieSession)) void this.restoreCookieSession(generation);
      this.timer = setInterval(this.refreshVisible, 30_000);
      window.addEventListener("online", this.refreshVisible);
      document.addEventListener("visibilitychange", this.refreshVisible);
    } catch (error) {
      if (this.running && generation === this.generation) this.publish({ ...this.state, loaded: true, error: String(error) });
    }
  };
  private async restoreCookieSession(generation: number) {
    const hostOrigin = this.deps.cookieOrigin!;
    try {
      const response = await this.request(`${hostOrigin}${REMOTE_ACCESS_SESSION_PATH}`, { credentials: "same-origin" });
      if (!response.ok) return;
      const payload = await response.json() as RemoteAccessPairingExchangeResponse;
      if (!this.running || generation !== this.generation) return;
      const connection: InstanceConnection = { id: `cookie:${hostOrigin}`, name: defaultInstanceName(hostOrigin), hostOrigin, token: "", cookieSession: true, session: payload.session };
      await this.deps.save(connection);
      if (!this.running || generation !== this.generation) return;
      this.publish({ ...this.state, instances: [...this.state.instances, this.fresh(connection)] });
      void this.refresh(connection.id);
    } catch { /* The pairing form remains available when the local cookie cannot be restored. */ }
    finally { if (this.running && generation === this.generation) this.publish({ ...this.state, loaded: true }); }
  }
  stop = () => {
    this.running = false;
    ++this.generation;
    clearInterval(this.timer);
    window.removeEventListener("online", this.refreshVisible);
    document.removeEventListener("visibilitychange", this.refreshVisible);
    this.disposers.forEach((dispose) => dispose());
    this.disposers.clear();
    this.pending.clear();
    this.bookmarkPending.clear();
  };
  private refreshVisible = () => {
    if (document.hidden) return;
    this.state.instances.forEach((entry) => { void this.refresh(entry.connection.id); });
  };
  private listen(id: string, client: BuildWardenClient) {
    this.disposers.get(id)?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { timer ??= setTimeout(() => { timer = undefined; void this.refresh(id); }, 500); };
    const dispose = [client.onRunEvent(refresh), client.onChatEvent(refresh), client.onProjectTaskChanged(refresh), client.onProjectLoopChanged(refresh), client.onOrchestrationChanged(refresh), client.onRunForgeRequestChanged(refresh)];
    this.disposers.set(id, () => { clearTimeout(timer); dispose.forEach((unsubscribe) => unsubscribe()); });
  }
  refresh = (id: string): Promise<void> => {
    const previous = this.pending.get(id);
    if (previous) return previous;
    const entry = this.find(id);
    if (!this.running || !entry || entry.status === "pairing-required") return Promise.resolve();
    const generation = this.generation;
    const connection = entry.connection;
    const current = () => this.running && generation === this.generation && this.find(id)?.connection.token === connection.token && this.find(id)?.connection.session.id === connection.session.id;
    const work = (async () => {
      try {
        let client = entry.client;
        if (!client) {
          const response = await this.request(`${connection.hostOrigin}${REMOTE_ACCESS_SESSION_PATH}`, { credentials: connection.cookieSession ? "same-origin" : "omit", headers: connection.cookieSession ? {} : { Authorization: `Bearer ${connection.token}` } });
          if (response.status === 401) throw new RemoteSessionExpiredError();
          if (!response.ok) throw new Error(`Could not verify session (${response.status}).`);
          const payload = await response.json() as RemoteAccessPairingExchangeResponse;
          if (!current()) return;
          client = this.deps.createClient({ baseUrl: connection.cookieSession ? undefined : connection.hostOrigin, sessionToken: connection.cookieSession ? undefined : connection.token, scopes: payload.session.scopes, fetch: this.deps.fetch,
            backgroundReadTimeoutMs: 15_000,
            canSendMutations: () => current() && this.find(id)?.status === "online",
            onSessionExpired: () => {
              if (!current()) return;
              this.disposers.get(id)?.();
              this.disposers.delete(id);
              this.update(id, { status: "pairing-required", client: null, error: "Session expired or revoked. Pair this instance again." });
            },
          });
          this.update(id, { client });
          this.listen(id, client);
        }
        const snapshot = await client.refreshSnapshot();
        if (!current() || this.find(id)?.status === "pairing-required") return;
        this.update(id, { snapshot, status: "online", lastSeen: Date.now(), error: undefined });
        // Older hosts may not implement the inbox. A failed optional read must not hide projects.
        try {
          const attention = await client.getAttentionInbox();
          if (current()) this.update(id, { attention, attentionError: undefined });
        } catch (error) {
          if (current()) this.update(id, { attentionError: `Attention inbox unavailable: ${String(error)}` });
        }
      } catch (error) {
        if (!current()) return;
        const expired = error instanceof RemoteSessionExpiredError;
        this.update(id, { status: expired ? "pairing-required" : "offline", error: expired ? "Session expired or revoked. Pair this instance again." : "Host unavailable. Showing last known activity." });
      }
    })();
    this.pending.set(id, work);
    void work.finally(() => { if (this.pending.get(id) === work) this.pending.delete(id); });
    return work;
  };
  pair = async (rawHost: string, rawCode: string, rawName: string): Promise<void> => {
    const hostOrigin = normalizeRemoteHostOrigin(rawHost);
    const code = rawCode.replace(/\s+/g, "").toUpperCase();
    if (!hostOrigin || !code) throw new Error("Enter a valid BuildWarden host URL and pairing code.");
    const existing = this.state.instances.find((entry) => entry.connection.hostOrigin === hostOrigin);
    const cookieSession = hostOrigin === this.deps.cookieOrigin;
    const response = await this.request(`${hostOrigin}${REMOTE_ACCESS_PAIRING_PATH}`, {
      method: "POST", credentials: cookieSession ? "same-origin" : "omit", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, label: `Web · ${navigator.platform || "browser"}`.slice(0, 80) }),
    });
    if (!response.ok) throw new Error(`Pairing failed (${response.status}). Request a fresh ${cookieSession ? "host-served" : "hosted website"} code and check that this browser origin is allowed by the host.`);
    const payload = await response.json() as RemoteAccessPairingExchangeResponse;
    if (!cookieSession && !payload.token) throw new Error("Use a hosted website pairing code for this connection.");
    const connection: InstanceConnection = {
      id: existing?.connection.id ?? crypto.randomUUID(), name: rawName.trim().slice(0, 80) || existing?.connection.name || defaultInstanceName(hostOrigin),
      hostOrigin, token: cookieSession ? "" : payload.token!, session: payload.session, ...(cookieSession ? { cookieSession: true as const } : {}),
    };
    await this.deps.save(connection);
    this.disposers.get(connection.id)?.();
    this.disposers.delete(connection.id);
    this.pending.delete(connection.id);
    this.bookmarkPending.delete(connection.id);
    const instances = this.state.instances.filter((entry) => entry.connection.id !== connection.id);
    this.publish({ ...this.state, instances: [...instances, this.fresh(connection)] });
    await this.refresh(connection.id);
  };
  rename = async (id: string, name: string) => {
    const entry = this.find(id);
    const trimmed = name.trim().slice(0, 80);
    if (!entry || !trimmed) throw new Error("Enter an instance name.");
    const connection = { ...entry.connection, name: trimmed };
    await this.deps.save(connection);
    this.update(id, { connection });
  };
  remove = async (id: string): Promise<string | null> => {
    const entry = this.find(id);
    if (!entry) return null;
    const { connection } = entry;
    let warning: string | null = null;
    try {
      const response = await this.request(`${connection.hostOrigin}${REMOTE_ACCESS_SESSION_PATH}`, { method: "DELETE", credentials: connection.cookieSession ? "same-origin" : "omit", headers: connection.cookieSession ? {} : { Authorization: `Bearer ${connection.token}` } });
      if (!response.ok && response.status !== 401) throw new Error("Revocation failed");
    } catch { warning = "Connection removed locally. The host could not confirm revocation; revoke this browser session in its desktop settings."; }
    await this.deps.remove(id);
    this.disposers.get(id)?.();
    this.disposers.delete(id);
    this.pending.delete(id);
    this.bookmarkPending.delete(id);
    this.publish({ ...this.state, instances: this.state.instances.filter((item) => item.connection.id !== id) });
    return warning;
  };
  loadBookmarks = (id: string): Promise<void> => {
    const previous = this.bookmarkPending.get(id);
    if (previous) return previous;
    const entry = this.find(id);
    if (!entry?.client || entry.status !== "online") return Promise.resolve();
    const client = entry.client;
    const generation = this.generation;
    const current = () => this.running && generation === this.generation && this.find(id)?.client === client;
    const work = (async () => {
      try {
        const [bookmarks, chatBookmarks] = await Promise.all([client.getBookmarksWithSteps(), client.getChatBookmarksWithSteps()]);
        if (current()) this.update(id, { bookmarks, chatBookmarks, bookmarksLoaded: true, bookmarksError: undefined });
      } catch (error) { if (current()) this.update(id, { bookmarksLoaded: true, bookmarksError: String(error) }); }
    })();
    this.bookmarkPending.set(id, work);
    void work.finally(() => { if (this.bookmarkPending.get(id) === work) this.bookmarkPending.delete(id); });
    return work;
  };
}
