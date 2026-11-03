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
it.each([null, { signature: "batch", acceptedModelIds: "model" }, { signature: "batch", acceptedModelIds: [42] }])("rejects malformed batch progress synchronized from another window: %j", (runBatch) => {
  const store = new ComposerDraftStore(() => localStorage, createDraftAttachmentStorage());
  store.setPrompt(key, "Keep this draft");
  store.prepareRunBatch(key, "batch").recordAccepted("accepted");
  const metadata = JSON.parse(localStorage.getItem(key)!);
  localStorage.setItem(key, JSON.stringify({ ...metadata, prompt: "Invalid update", runBatch }));
  store.synchronize(key);
  expect(store.getSnapshot(key).prompt).toBe("Keep this draft");
  expect(store.getSnapshot(key).error).toContain("Could not synchronize");
  const batch = store.prepareRunBatch(key, "batch");
  expect(batch.acceptedModelIds).toEqual(["accepted"]);
  expect(() => batch.recordAccepted("next")).not.toThrow();
});
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

it("revokes owners and queued locks, and does not revive stale writers when a connection is paired again", async () => {
  const locks = broker(); const blobs = createDraftAttachmentStorage();
  const owner = new ComposerDraftStore(() => localStorage, blobs, locks);
  const waiting = new ComposerDraftStore(() => localStorage, blobs, locks);
  const remover = new ComposerDraftStore(() => localStorage, blobs, locks);
  const leaveOwner = owner.subscribe(key, () => {});
  await vi.waitFor(() => expect(owner.getSnapshot(key).readOnly).toBe(false));
  owner.setPrompt(key, "Private draft"); owner.setFiles(key, [new File(["secret"], "secret.txt")]);
  await vi.waitFor(() => expect(owner.getSnapshot(key).saving).toBe(false));
  const stale = owner.getSnapshot(key);
  const batch = owner.prepareRunBatch(key, "batch");
  const leaveWaiting = waiting.subscribe(key, () => {});
  await remover.removeEnvironment("host");
  const marker = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).find((item) => item.startsWith("buildwarden.composer-draft-scope."))!;
  owner.synchronize(marker);
  waiting.synchronize(marker);
  expect(owner.getSnapshot(key)).toMatchObject({ readOnly: true, prompt: "", files: [], captures: [] });
  expect(owner.getSnapshot(key).error).toContain("connection was removed");
  expect(waiting.getSnapshot(key).readOnly).toBe(true);
  owner.setPrompt(key, "Resurrected text"); owner.setFiles(key, stale.files);
  owner.seedPrompt(key, "Late task default"); batch.recordAccepted("model");
  expect(owner.beginSubmission(key, stale)).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
  await vi.waitFor(async () => expect(await blobs.keys!()).toEqual([]));

  remover.restoreEnvironment("host");
  const fresh = new ComposerDraftStore(() => localStorage, blobs, locks);
  const leaveFresh = fresh.subscribe(key, () => {});
  await vi.waitFor(() => expect(fresh.getSnapshot(key).readOnly).toBe(false));
  fresh.setPrompt(key, "Fresh connection draft");
  owner.clearSubmitted(key, stale);
  owner.setPrompt(key, "Old callback");
  expect(JSON.parse(localStorage.getItem(key)!).prompt).toBe("Fresh connection draft");
  const newKey = composerDraftKey("host", "chat", "never-opened");
  owner.setPrompt(newKey, "Old client, different composer");
  expect(localStorage.getItem(newKey)).toBeNull();
  leaveOwner(); leaveWaiting(); leaveFresh();
});
it("blocks writes before the revocation event arrives and preserves other environments", async () => {
  const blobs = createDraftAttachmentStorage();
  const writer = new ComposerDraftStore(() => localStorage, blobs);
  const remover = new ComposerDraftStore(() => localStorage, blobs);
  writer.observeEnvironment("host");
  const other = composerDraftKey("other-host", "run", "run");
  writer.setPrompt(other, "Keep me");
  await remover.removeEnvironment("host");
  writer.setPrompt(key, "Late write from the removed connection");
  expect(localStorage.getItem(key)).toBeNull();
  expect(writer.getSnapshot(key).readOnly).toBe(true);
  writer.setPrompt(other, "Still editable");
  expect(writer.getSnapshot(other).prompt).toBe("Still editable");
  const restarted = new ComposerDraftStore(() => localStorage, blobs);
  restarted.setPrompt(key, "New window with stale connection");
  expect(localStorage.getItem(key)).toBeNull();
});
it("removes attachment writes finishing after scope revocation without relying on a storage event", async () => {
  let finish!: () => void;
  const objects = new Map<string, Blob>();
  const blobs = { get: async (id: string) => objects.get(id), keys: async () => [...objects.keys()], remove: async (id: string) => { objects.delete(id); }, put: async (id: string, blob: Blob) => { await new Promise<void>((resolve) => { finish = resolve; }); objects.set(id, blob); } };
  const writer = new ComposerDraftStore(() => localStorage, blobs);
  const remover = new ComposerDraftStore(() => localStorage, blobs);
  writer.setFiles(key, [new File(["secret"], "secret.txt")]);
  await remover.removeEnvironment("host");
  finish();
  await vi.waitFor(() => expect(writer.getSnapshot(key).saving).toBe(false));
  await vi.waitFor(() => expect(objects.size).toBe(0));
  expect(writer.getSnapshot(key).readOnly).toBe(true);
  expect(localStorage.getItem(key)).toBeNull();
});
it("removes a stale metadata write if revocation races its save", async () => {
  const blobs = createDraftAttachmentStorage();
  const remover = new ComposerDraftStore(() => localStorage, blobs);
  let cleanup: Promise<void> | undefined;
  const racingStorage = new Proxy(localStorage, { get(target, property) {
    if (property === "setItem") return (id: string, value: string) => {
      if (id === key && !cleanup) cleanup = remover.removeEnvironment("host");
      target.setItem(id, value);
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const writer = new ComposerDraftStore(() => racingStorage, blobs);
  writer.setPrompt(key, "Racing stale write");
  await cleanup;
  expect(localStorage.getItem(key)).toBeNull();
  expect(writer.getSnapshot(key).readOnly).toBe(true);
});

it("lets a newly paired scope acquire its lock even while the old owner has not processed revocation", async () => {
  const locks = broker(); const blobs = createDraftAttachmentStorage();
  const old = new ComposerDraftStore(() => localStorage, blobs, locks);
  const leaveOld = old.subscribe(key, () => {});
  await vi.waitFor(() => expect(old.getSnapshot(key).readOnly).toBe(false));
  const pairing = new ComposerDraftStore(() => localStorage, blobs, locks);
  await pairing.removeEnvironment("host");
  pairing.restoreEnvironment("host");
  const fresh = new ComposerDraftStore(() => localStorage, blobs, locks);
  const leaveFresh = fresh.subscribe(key, () => {});
  await vi.waitFor(() => expect(fresh.getSnapshot(key).readOnly).toBe(false));
  fresh.setPrompt(key, "New session work");
  old.setPrompt(key, "Old owner woke up");
  expect(JSON.parse(localStorage.getItem(key)!).prompt).toBe("New session work");
  expect(old.getSnapshot(key).readOnly).toBe(true);
  leaveOld(); leaveFresh();
});
