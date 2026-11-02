/** @vitest-environment happy-dom */
import { Blob as NativeBlob, File as NativeFile } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerDraftStore, composerDraftKey } from "./composer-draft-store";
import { createDraftAttachmentStorage } from "./composer-draft-attachments";
beforeEach(() => { localStorage.clear(); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("File", NativeFile); });
afterEach(() => vi.unstubAllGlobals());
/** A FIFO lock broker shared by separate stores, like browser windows sharing an origin. */
function broker() {
  const tails = new Map<string, Promise<void>>();
  return { request: (key: string, options: LockOptions, action: () => Promise<void>) => {
    const pending = (tails.get(key) ?? Promise.resolve()).then(async () => { if (!options.signal?.aborted) await action(); });
    tails.set(key, pending.catch(() => {}));
    return pending;
  } } as unknown as LockManager;
}
const key = composerDraftKey("host", "run", "run");
it("gives one window ownership and reloads the cleared draft before handing it to the next window", async () => {
  const locks = broker();
  const blobs = createDraftAttachmentStorage();
  const first = new ComposerDraftStore(() => localStorage, blobs, locks);
  const second = new ComposerDraftStore(() => localStorage, blobs, locks);
  const leaveFirst = first.subscribe(key, () => {});
  await vi.waitFor(() => expect(first.getSnapshot(key).readOnly).toBe(false));
  first.setPrompt(key, "Send once"); first.setFiles(key, [new File(["secret"], "secret.txt")]);
  await vi.waitFor(() => expect(first.getSnapshot(key).saving).toBe(false));
  const leaveSecond = second.subscribe(key, () => {});
  await vi.waitFor(() => expect(second.getSnapshot(key).loading).toBe(false));
  const stale = second.getSnapshot(key);
  expect(stale.files).toHaveLength(1);
  second.setPrompt(key, "Stale edit"); second.setFiles(key, stale.files);
  expect(second.beginSubmission(key, stale)).toBeNull();
  expect(first.getSnapshot(key).prompt).toBe("Send once");
  const releaseSend = first.beginSubmission(key)!;
  leaveFirst();
  expect(second.getSnapshot(key).readOnly).toBe(true);
  first.clearSubmitted(key, first.getSnapshot(key));
  second.synchronize(key);
  expect(second.getSnapshot(key).files).toEqual([]);
  expect(second.getSnapshot(key).prompt).toBe("");
  expect(second.getSnapshot(key).readOnly).toBe(true);
  releaseSend();
  await vi.waitFor(() => expect(second.getSnapshot(key).readOnly).toBe(false));
  expect(second.beginSubmission(key, stale)).toBeNull();
  second.setPrompt(key, "New work");
  expect(JSON.parse(localStorage.getItem(key)!).attachments).toEqual([]);
  await vi.waitFor(async () => expect(await blobs.keys!()).toEqual([]));
  leaveSecond();
});
it("hydrates the latest attachment bytes after ownership transfers and preserves drafts on failed sends", async () => {
  const locks = broker(); const blobs = createDraftAttachmentStorage();
  const first = new ComposerDraftStore(() => localStorage, blobs, locks);
  const second = new ComposerDraftStore(() => localStorage, blobs, locks);
  const leaveFirst = first.subscribe(key, () => {}); const leaveSecond = second.subscribe(key, () => {});
  await vi.waitFor(() => expect(first.getSnapshot(key).readOnly).toBe(false));
  first.setPrompt(key, "Keep on failure"); first.setFiles(key, [new File(["bytes"], "keep.txt")]);
  const releaseSend = first.beginSubmission(key)!;
  leaveFirst(); releaseSend();
  await vi.waitFor(() => expect(second.getSnapshot(key).readOnly || second.getSnapshot(key).loading).toBe(false));
  expect(second.getSnapshot(key).prompt).toBe("Keep on failure");
  expect(await second.getSnapshot(key).files[0]!.text()).toBe("bytes");
  leaveSecond();
});
it("queues task defaults until ownership is granted without replacing existing work", async () => {
  const store = new ComposerDraftStore(() => localStorage, createDraftAttachmentStorage(), broker());
  const leave = store.subscribe(key, () => {});
  store.seedPrompt(key, "Task default");
  await vi.waitFor(() => expect(store.getSnapshot(key).readOnly).toBe(false));
  expect(store.getSnapshot(key).prompt).toBe("Task default");
  leave();
});
it("refreshes cached metadata before a mutation even if its storage event has not arrived", () => {
  const first = new ComposerDraftStore(() => localStorage, createDraftAttachmentStorage());
  const second = new ComposerDraftStore(() => localStorage, createDraftAttachmentStorage());
  first.setPrompt(key, "Old"); second.getSnapshot(key);
  first.clearSubmitted(key, first.getSnapshot(key));
  second.setPrompt(key, "New");
  expect(JSON.parse(localStorage.getItem(key)!).attachments).toEqual([]);
});

it("does not resurrect a blob when another window deletes its draft during a pending write", async () => {
  let finish!: () => void;
  const objects = new Map<string, Blob>();
  const blobs = { get: async (id: string) => objects.get(id), keys: async () => [...objects.keys()], remove: async (id: string) => { objects.delete(id); }, put: async (id: string, blob: Blob) => { await new Promise<void>((resolve) => { finish = resolve; }); objects.set(id, blob); } };
  const first = new ComposerDraftStore(() => localStorage, blobs);
  const second = new ComposerDraftStore(() => localStorage, blobs);
  first.setFiles(key, [new File(["secret"], "secret.txt")]);
  await second.deleteDrafts("host");
  finish();
  await vi.waitFor(() => expect(first.getSnapshot(key).saving).toBe(false));
  await vi.waitFor(() => expect(objects.size).toBe(0));
  expect(first.getSnapshot(key).files).toEqual([]);
  expect(localStorage.getItem(key)).toBeNull();
});
