import type { AppSnapshot } from "@buildwarden/shared";
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
  const cascadeIds = async (runIds: string[], snapshot: AppSnapshot | undefined) => {
    const ids = new Set(runIds);
    const impacts = await Promise.all(runIds.map((id) => bestEffort(() => client.getRunDeletionImpact(id))));
    impacts.forEach((impact) => impact?.runIds.forEach((id) => ids.add(id)));
    snapshot?.chats.filter((chat) => chat.runId && ids.has(chat.runId)).forEach((chat) => ids.add(chat.id));
    return ids;
  };
  const overrides: Partial<BuildWardenClient> = {
    deleteProjectAutomation: async (id) => {
      const snapshot = store.hasDrafts(environment) ? await bestEffort(() => client.getSnapshot()) : undefined;
      const runs = snapshot?.projects.flatMap((project) => project.automations ?? [])
        .find((item) => item.automation.id === id)?.runs ?? [];
      const ids = await cascadeIds(runs.map((run) => run.id), snapshot);
      ids.add(id);
      await client.deleteProjectAutomation(id);
      await cleanup(ids);
    },
    deleteProjectLabThread: async (id) => {
      const [snapshot, detail] = store.hasDrafts(environment) ? await Promise.all([
        bestEffort(() => client.getSnapshot()), bestEffort(() => client.getProjectLabThreadDetail(id)),
      ]) : [];
      const thread = detail?.thread ?? snapshot?.projects.flatMap((project) => project.labThreads).find((item) => item.thread.id === id)?.thread;
      const ids = await cascadeIds(thread?.implementationRunId ? [thread.implementationRunId] : [], snapshot);
      ids.add(id);
      await client.deleteProjectLabThread(id);
      await cleanup(ids);
    },
    deleteProjectLoop: async (id) => {
      const [snapshot, detail] = store.hasDrafts(environment) ? await Promise.all([
        bestEffort(() => client.getSnapshot()), bestEffort(() => client.getProjectLoopDetail(id)),
      ]) : [];
      const iterations = detail?.iterations ?? snapshot?.projects.flatMap((project) => project.loops).find((item) => item.loop.id === id)?.iterations ?? [];
      const runIds = [...new Set(iterations.flatMap((iteration) => iteration.runId ? [iteration.runId] : []))];
      const cascades = new Map(await Promise.all(runIds.map(async (runId) => [runId, await cascadeIds([runId], snapshot)] as const)));
      const result = await client.deleteProjectLoop(id);
      const ids = new Set([id]);
      // Loop deletion can retain runs after individual failures. Older hosts do not
      // report outcomes, so retain their run drafts rather than guessing they vanished.
      result?.deletedRunIds.forEach((runId) => {
        ids.add(runId);
        cascades.get(runId)?.forEach((relatedId) => ids.add(relatedId));
      });
      await cleanup(ids);
      return result;
    },
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
