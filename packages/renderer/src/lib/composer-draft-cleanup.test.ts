/** @vitest-environment happy-dom */
import { Blob as NativeBlob, File as NativeFile } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BuildWardenClient } from "./buildwarden-client-core";
import { withComposerDraftCleanup } from "./composer-draft-cleanup";
import { ComposerDraftStore, composerDraftKey } from "./composer-draft-store";
import { createDraftAttachmentStorage } from "./composer-draft-attachments";
beforeEach(() => { localStorage.clear(); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("File", NativeFile); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const key = (id: string, scope = "host") => composerDraftKey(scope, "run", id);
it("cleans a deleted project's drafts and orphan blobs while keeping other hosts and projects", async () => {
  const blobs = createDraftAttachmentStorage();
  const store = new ComposerDraftStore(() => localStorage, blobs);
  for (const id of ["project", "run", "task", "hidden", "other"]) store.setPrompt(key(id), id);
  store.setFiles(key("run"), [new File(["secret"], "secret.txt")]);
  store.setFiles(key("other"), [new File(["keep"], "keep.txt")]);
  store.setPrompt(key("run", "other-host"), "Other host");
  await vi.waitFor(() => expect(store.getSnapshot(key("other")).saving).toBe(false));
  await blobs.put("orphan", new Blob(["orphan"]));
  const client = withComposerDraftCleanup({ getSnapshot: async () => ({ projects: [{ project: { id: "project" }, runs: [{ id: "run" }], forLaterRuns: [{ id: "hidden" }], tasks: [{ id: "task" }] }], chats: [] }), deleteProject: vi.fn(async () => {}) } as unknown as BuildWardenClient, "host", store);
  await client.deleteProject("project");
  for (const id of ["project", "run", "task", "hidden"]) expect(localStorage.getItem(key(id))).toBeNull();
  expect(store.getSnapshot(key("run")).files).toEqual([]);
  expect(store.getSnapshot(key("other")).prompt).toBe("other");
  expect(store.getSnapshot(key("run", "other-host")).prompt).toBe("Other host");
  expect(await blobs.keys!()).toEqual(store.getSnapshot(key("other")).attachmentIds);
});
it("retains drafts on failed deletion and includes orchestration children on success", async () => {
  const store = new ComposerDraftStore(() => localStorage, createDraftAttachmentStorage());
  for (const id of ["run", "child"]) store.setPrompt(key(id), "Draft");
  const remove = vi.fn().mockRejectedValueOnce(new Error("Busy")).mockResolvedValue(undefined);
  const client = withComposerDraftCleanup({ getSnapshot: async () => ({ chats: [] }), getRunDeletionImpact: async () => ({ runIds: ["run", "child"] }), deleteRun: remove } as unknown as BuildWardenClient, "host", store);
  await expect(client.deleteRun("run")).rejects.toThrow("Busy");
  expect(store.getSnapshot(key("run")).prompt).toBe("Draft");
  await client.deleteRun("run");
  expect(localStorage.getItem(key("run"))).toBeNull();
  expect(localStorage.getItem(key("child"))).toBeNull();
});
it("waits for attachment writes when permanently removing a host", async () => {
  let finish!: () => void;
  const blobs = new Map<string, Blob>();
  const storage = { get: async (id: string) => blobs.get(id), keys: async () => [...blobs.keys()], remove: async (id: string) => { blobs.delete(id); }, put: async (id: string, blob: Blob) => { await new Promise<void>((resolve) => { finish = resolve; }); blobs.set(id, blob); } };
  const store = new ComposerDraftStore(() => localStorage, storage);
  store.setFiles(key("run"), [new File(["secret"], "secret.txt")]);
  const removed = store.deleteDrafts("host");
  finish(); await removed;
  expect(blobs.size).toBe(0);
  expect(localStorage.getItem(key("run"))).toBeNull();
});
it("deleting a run chat keeps the separate run follow-up", async () => {
  const store = new ComposerDraftStore(() => localStorage, createDraftAttachmentStorage());
  store.setPrompt(key("run"), "Follow up");
  const chatKey = composerDraftKey("host", "run-chat", "run");
  store.setPrompt(chatKey, "Chat question");
  const client = withComposerDraftCleanup({ getChatDetail: async () => ({ chat: { runId: "run" } }), deleteChat: async () => {} } as unknown as BuildWardenClient, "host", store);
  await client.deleteChat("chat");
  expect(store.getSnapshot(key("run")).prompt).toBe("Follow up");
  expect(localStorage.getItem(chatKey)).toBeNull();
});

it("preserves client methods and capabilities when callers copy the client", () => {
  const getSnapshot = vi.fn();
  const capabilities = { chatMutations: true };
  const client = withComposerDraftCleanup({ getSnapshot, capabilities } as unknown as BuildWardenClient, "host");
  expect({ ...client }.getSnapshot).toBe(getSnapshot);
  expect({ ...client }.capabilities).toBe(capabilities);
});

it.each(["keys", "remove"] as const)("keeps successful host deletion successful when orphan %s fails", async (failure) => {
  const blobs = { get: async () => undefined, put: async () => {}, keys: vi.fn(async () => ["orphan"]), remove: vi.fn(async () => {}) };
  blobs[failure].mockRejectedValueOnce(new Error("IndexedDB unavailable"));
  const store = new ComposerDraftStore(() => localStorage, blobs);
  const remove = vi.fn(async () => {});
  const client = withComposerDraftCleanup({ deleteRun: remove } as unknown as BuildWardenClient, "host", store);
  await expect(client.deleteRun("run")).resolves.toBeUndefined();
  expect(remove).toHaveBeenCalledExactlyOnceWith("run");
});
it("does not block deletion or disconnect cleanup when localStorage access throws", async () => {
  const store = new ComposerDraftStore(() => { throw new Error("Storage denied"); }, createDraftAttachmentStorage());
  const reset = vi.fn(async () => {});
  const client = withComposerDraftCleanup({ resetDatabase: reset } as unknown as BuildWardenClient, "host", store);
  expect(store.hasDrafts("host")).toBe(false);
  await expect(client.resetDatabase()).resolves.toBeUndefined();
  await expect(store.deleteDrafts("host")).resolves.toBeUndefined();
  expect(reset).toHaveBeenCalledOnce();
});
it("continues after a metadata removal failure without orphaning the retained draft's files", async () => {
  const blobs = createDraftAttachmentStorage();
  const store = new ComposerDraftStore(() => localStorage, blobs);
  store.setFiles(key("first"), [new File(["keep"], "keep.txt")]);
  store.setPrompt(key("second"), "Remove this");
  await vi.waitFor(() => expect(store.getSnapshot(key("first")).saving).toBe(false));
  const refs = store.getSnapshot(key("first")).attachmentIds;
  const removeItem = localStorage.removeItem.bind(localStorage);
  const failingRemove = vi.spyOn(localStorage, "removeItem").mockImplementation((id) => {
    if (id === key("first")) throw new Error("Storage unavailable for this key");
    removeItem(id);
  });
  await expect(store.deleteDrafts("host")).resolves.toBeUndefined();
  expect(localStorage.getItem(key("first"))).not.toBeNull();
  expect(localStorage.getItem(key("second"))).toBeNull();
  expect(await blobs.keys!()).toEqual(refs);
  failingRemove.mockRestore();
  await store.deleteDrafts("host");
  expect(await blobs.keys!()).toEqual([]);
});
