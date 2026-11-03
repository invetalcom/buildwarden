import type { BuildWardenClient } from "./buildwarden-client-core";
import { composerDraftStore, type ComposerDraftStore } from "./composer-draft-store";

/** Include task, hidden run, loop and lab IDs as well as the ordinary project run list. */
function collectIds(value: unknown, ids: Set<string>) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item) => collectIds(item, ids)); return; }
  for (const [key, item] of Object.entries(value)) {
    if (key === "id" && typeof item === "string") ids.add(item);
    else if (typeof item === "object") collectIds(item, ids);
  }
}

async function bestEffort<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); } catch { return undefined; }
}

/** Apply successful deletion to browser-owned drafts for both desktop and mobile clients. */
export function withComposerDraftCleanup(client: BuildWardenClient, environment: string, store: ComposerDraftStore = composerDraftStore): BuildWardenClient {
  const cleanup = (ids?: ReadonlySet<string>) => store.deleteDrafts(environment, ids);
  const overrides: Partial<BuildWardenClient> = {
    deleteProject: async (id) => {
      const ids = new Set([id]);
      if (store.hasDrafts(environment)) {
        const snapshot = await bestEffort(() => client.getSnapshot());
        collectIds(snapshot?.projects.find((item) => item.project.id === id), ids);
        snapshot?.chats.filter((chat) => chat.runId && ids.has(chat.runId)).forEach((chat) => ids.add(chat.id));
      }
      await client.deleteProject(id);
      await cleanup(ids);
    },
    deleteRun: async (id) => {
      const ids = new Set([id]);
      if (store.hasDrafts(environment)) {
        const [impact, snapshot] = await Promise.all([bestEffort(() => client.getRunDeletionImpact(id)), bestEffort(() => client.getSnapshot())]);
        impact?.runIds.forEach((runId) => ids.add(runId));
        snapshot?.chats.filter((chat) => chat.runId && ids.has(chat.runId)).forEach((chat) => ids.add(chat.id));
      }
      await client.deleteRun(id);
      await cleanup(ids);
    },
    deleteChat: async (id) => {
      const ids = new Set([id]);
      if (store.hasDrafts(environment)) {
        const detail = await bestEffort(() => client.getChatDetail(id));
        if (detail?.chat.runId) ids.add(detail.chat.runId);
      }
      await client.deleteChat(id);
      // A run's own follow-up draft is independent of its associated chat.
      await store.deleteDrafts(environment, ids, new Set(["chat", "run-chat"]));
    },
    deleteProjectTask: async (id) => { await client.deleteProjectTask(id); await cleanup(new Set([id])); },
    deleteDataRetentionCandidates: async (days, cutoff) => {
      const result = await client.deleteDataRetentionCandidates(days, cutoff);
      await cleanup(new Set([...result.runIds, ...result.chatIds]));
      return result;
    },
    resetDatabase: async () => { await client.resetDatabase(); await cleanup(); },
  };
  return new Proxy({ ...client, ...overrides }, {
    get: (target, key) => Reflect.get(target, key) ?? Reflect.get(client, key),
  });
}
