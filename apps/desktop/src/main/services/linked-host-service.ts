import { randomUUID } from "node:crypto";
import { McpHttpClient } from "@buildwarden/agent-runtime";
import { APP_SETTING_KEYS, MAX_LINKED_HOSTS, parseLinkedHostsSetting, type LinkedHostInput, type LinkedHostRecord } from "@buildwarden/shared";
import { AppService } from "./app-service";

const tokenSecretKey = (hostId: string) => `linked-host-token:${hostId}`;

/** A host's answer to a tool call; the call failed when the host says so. */
export class LinkedHostToolError extends Error {}

/**
 * Other BuildWarden hosts this one delegates tasks to. Each is reached through its MCP endpoint
 * (`/mcp`) with an agent token the user created there, kept in the secret store.
 */
export class LinkedHostService extends AppService {
  /** Saves and removals run one at a time: each awaits the secret store between reading and writing the list. */
  private mutations: Promise<unknown> = Promise.resolve();

  private serialize<T>(change: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(change, change);
    this.mutations = next.catch(() => undefined);
    return next;
  }

  listLinkedHosts(): LinkedHostRecord[] {
    return parseLinkedHostsSetting(this.db.getSettings()[APP_SETTING_KEYS.linkedHosts]);
  }

  getLinkedHost(hostId: string): LinkedHostRecord {
    const host = this.listLinkedHosts().find((entry) => entry.id === hostId);
    if (!host) throw new Error(`Linked host ${hostId} does not exist.`);
    return host;
  }

  saveLinkedHost(input: LinkedHostInput): Promise<LinkedHostRecord> {
    return this.serialize(() => this.saveLinkedHostNow(input));
  }

  private async saveLinkedHostNow(input: LinkedHostInput): Promise<LinkedHostRecord> {
    const label = input.label.trim().slice(0, 80);
    if (!label) throw new Error("Name the linked host.");
    let url: URL;
    try {
      url = new URL(input.mcpUrl.trim());
    } catch {
      throw new Error("Enter the host's MCP URL, such as https://host.example.ts.net/mcp.");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
      throw new Error("A linked host needs an HTTPS URL; plain HTTP is accepted only on this computer.");
    }
    const hosts = this.listLinkedHosts();
    const existing = input.id ? hosts.find((entry) => entry.id === input.id) : undefined;
    if (input.id && !existing) throw new Error(`Linked host ${input.id} does not exist.`);
    // Checked before the token is stored: the setting keeps no more, and a host past it would vanish.
    if (!existing && hosts.length >= MAX_LINKED_HOSTS) throw new Error(`BuildWarden keeps up to ${String(MAX_LINKED_HOSTS)} linked hosts. Remove one first.`);
    const token = input.token?.trim();
    if (!existing && !token) throw new Error("Paste the agent token the host created.");
    // A saved token belongs to the host that issued it; another address must not receive it.
    if (existing && !token && new URL(existing.mcpUrl).origin !== url.origin) {
      throw new Error("The host's address changed. Paste an agent token from the new host.");
    }
    const host: LinkedHostRecord = { id: existing?.id ?? randomUUID(), label, mcpUrl: url.toString() };
    if (token) await this.secrets.saveSecret(tokenSecretKey(host.id), token);
    // Read again after the await, so a change that finished meanwhile is not written over.
    const current = this.listLinkedHosts();
    this.db.setSetting(APP_SETTING_KEYS.linkedHosts, JSON.stringify([...current.filter((entry) => entry.id !== host.id), host]));
    return host;
  }

  removeLinkedHost(hostId: string): Promise<void> {
    return this.serialize(async () => {
      const hosts = this.listLinkedHosts();
      this.db.setSetting(APP_SETTING_KEYS.linkedHosts, JSON.stringify(hosts.filter((entry) => entry.id !== hostId)));
      await this.secrets.deleteSecret(tokenSecretKey(hostId));
    });
  }

  /** Connects to the host and lists its projects, so the user sees the link works. */
  async checkLinkedHost(hostId: string): Promise<{ projects: Array<{ id: string; name: string }> }> {
    const result = await this.callHostTool<{ projects?: Array<{ id: string; name: string }> }>(hostId, "list_projects", {});
    return { projects: (result.projects ?? []).map(({ id, name }) => ({ id, name })) };
  }

  /** Calls one of the host's MCP tools and returns its structured result. */
  async callHostTool<T = Record<string, unknown>>(hostId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const host = this.getLinkedHost(hostId);
    const token = await this.secrets.readSecret(tokenSecretKey(host.id));
    if (!token) throw new Error(`The token for linked host ${host.label} is missing. Save it again in Settings.`);
    const client = new McpHttpClient({ name: host.label, url: host.mcpUrl, headers: { Authorization: `Bearer ${token}` } });
    try {
      await client.initialize(signal);
      const result = await client.callTool(name, args, signal);
      if (!result.ok) throw new LinkedHostToolError(`${host.label}: ${result.content || `${name} failed.`}`);
      try {
        return JSON.parse(result.content) as T;
      } catch {
        throw new LinkedHostToolError(`${host.label} answered ${name} with something other than JSON.`);
      }
    } finally {
      await client.close();
    }
  }
}
