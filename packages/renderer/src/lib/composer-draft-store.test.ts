/** @vitest-environment happy-dom */
import { Blob as NativeBlob, File as NativeFile } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunBrowserElementCapture } from "@buildwarden/shared";
import { createDraftAttachmentStorage, type DraftAttachmentStorage } from "./composer-draft-attachments";
import { ComposerDraftStore, composerDraftKey } from "./composer-draft-store";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
  // fake-indexeddb uses Node's structured clone, which supports native Blobs.
  vi.stubGlobal("Blob", NativeBlob);
  vi.stubGlobal("File", NativeFile);
});
afterEach(() => vi.unstubAllGlobals());
const key = composerDraftKey("host-a", "run", "run-1");
const createStore = (attachments = createDraftAttachmentStorage()) => new ComposerDraftStore(() => localStorage, attachments);
const settled = async (store: ComposerDraftStore, scope = key) => {
  await vi.waitFor(() => {
    expect(store.getSnapshot(scope).loading).toBe(false);
    expect(store.getSnapshot(scope).saving).toBe(false);
  });
};

describe("persistent composer drafts", () => {
  it("seeds only new drafts and retains an intentionally empty prompt across restarts", () => {
    const store = createStore();
    store.seedPrompt(key, "Task default");
    expect(store.getSnapshot(key).prompt).toBe("Task default");
    store.setPrompt(key, "");
    const restarted = createStore();
    restarted.seedPrompt(key, "Do not restore this text");
    expect(restarted.getSnapshot(key).prompt).toBe("");
    restarted.clearSubmitted(key, restarted.getSnapshot(key));
    expect(localStorage.getItem(key)).toBeNull();
    const next = createStore();
    next.seedPrompt(key, "New task default");
    expect(next.getSnapshot(key).prompt).toBe("New task default");
  });

  it("treats legacy saved drafts as initialized and never overwrites edits with defaults", () => {
    localStorage.setItem(key, JSON.stringify({ version: 1, prompt: "", attachments: [] }));
    const store = createStore();
    store.seedPrompt(key, "Default");
    expect(store.getSnapshot(key).prompt).toBe("");
    store.setPrompt(key, "User edit");
    store.seedPrompt(key, "Late default");
    expect(store.getSnapshot(key).prompt).toBe("User edit");
  });

  it("guards submissions atomically by draft key without persisting stale locks", () => {
    const store = createStore();
    const unsubscribe = store.subscribe(key, () => {});
    const release = store.beginSubmission(key)!;
    unsubscribe();
    expect(store.beginSubmission(key)).toBeNull();
    const otherRelease = store.beginSubmission(composerDraftKey("host-b", "run", "run-1"));
    expect(otherRelease).toBeTypeOf("function");
    expect(createStore().getSnapshot(key).submitting).toBe(false);
    release();
    expect(store.getSnapshot(key).submitting).toBe(false);
    const nextRelease = store.beginSubmission(key)!;
    release();
    expect(store.getSnapshot(key).submitting).toBe(true);
    nextRelease();
    otherRelease?.();
  });

  it("writes prompt text synchronously and isolates kinds, entities, and environments", () => {
    const store = createStore();
    const keys = [key, composerDraftKey("host-b", "run", "run-1"), composerDraftKey("host-a", "chat", "run-1"), composerDraftKey("host-a", "project", "project-1")];
    keys.forEach((scope, i) => store.setPrompt(scope, `draft ${i}`));
    const restarted = createStore();
    keys.forEach((scope, i) => expect(restarted.getSnapshot(scope).prompt).toBe(`draft ${i}`));
    expect(restarted.getSnapshot(composerDraftKey("host-a", "run", "run-2")).prompt).toBe("");
    expect(composerDraftKey("a:b", "run", "c")).not.toBe(composerDraftKey("a", "run", "b:c"));
  });

  it("restores file bytes, names, types, and timestamps after a fresh store and database connection", async () => {
    const store = createStore();
    const files = [new File([new Uint8Array([0, 255, 13, 10])], "image.png", { type: "image/png", lastModified: 1234 }), new File(["notes"], "notes.txt", { type: "text/plain", lastModified: 4567 })];
    store.setPrompt(key, "Review these files");
    store.setFiles(key, files);
    await settled(store);
    const raw = localStorage.getItem(key)!;
    expect(raw).not.toContain("dataBase64");
    expect(JSON.parse(raw).attachments).toHaveLength(2);
    const restarted = createStore();
    expect(restarted.getSnapshot(key).loading).toBe(true);
    await settled(restarted);
    const recovered = restarted.getSnapshot(key);
    expect(recovered.error).toBeNull();
    expect(recovered.missing).toEqual([]);
    expect(recovered.files.map(({ name, type, lastModified }) => ({ name, type, lastModified })))
      .toEqual(files.map(({ name, type, lastModified }) => ({ name, type, lastModified })));
    expect(new Uint8Array(await recovered.files[0]!.arrayBuffer())).toEqual(new Uint8Array([0, 255, 13, 10]));
    expect(await recovered.files[1]!.text()).toBe("notes");
  });

  it("stores browser capture data outside localStorage and restores it with its references", async () => {
    const capture = { id: "capture", annotationNumber: 1, comment: "Fix button", contextAttachment: { dataBase64: "Y29udGV4dA==" }, screenshotAttachment: { dataBase64: "cGl4ZWxz" } } as RunBrowserElementCapture;
    const store = createStore();
    store.setCaptures(key, [capture]);
    await settled(store);
    expect(localStorage.getItem(key)).not.toContain("cGl4ZWxz");
    const restarted = createStore();
    await settled(restarted);
    expect(restarted.getSnapshot(key).captures).toEqual([capture]);
  });

  it("clears only submitted content and removes its stored attachment blobs", async () => {
    const attachments = createDraftAttachmentStorage();
    const store = createStore(attachments);
    const first = new File(["first"], "first.txt");
    const next = new File(["next"], "next.txt");
    store.setPrompt(key, "first prompt");
    store.setFiles(key, [first]);
    await settled(store);
    const submitted = store.getSnapshot(key);
    store.setPrompt(key, "next prompt");
    store.setFiles(key, [first, next]);
    store.clearSubmitted(key, submitted);
    await settled(store);
    expect(store.getSnapshot(key).prompt).toBe("next prompt");
    expect(store.getSnapshot(key).files).toEqual([next]);
    await vi.waitFor(async () => expect(await attachments.get(submitted.attachmentIds[0]!)).toBeUndefined());
    store.clearSubmitted(key, store.getSnapshot(key));
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("does not resurrect a cleared attachment when its write completes later", async () => {
    let finish!: () => void;
    const remove = vi.fn(async () => {});
    const storage: DraftAttachmentStorage = { get: vi.fn(), put: () => new Promise((resolve) => { finish = resolve; }), remove };
    const store = createStore(storage);
    store.setFiles(key, [new File(["data"], "file.txt")]);
    store.clearSubmitted(key, store.getSnapshot(key));
    expect(remove).not.toHaveBeenCalled();
    finish();
    await settled(store);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(store.getSnapshot(key).files).toEqual([]);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("keeps edits made during hydration and explicitly retains missing references", async () => {
    const attachments = createDraftAttachmentStorage();
    const initial = createStore(attachments);
    initial.setFiles(key, [new File(["missing"], "missing.txt")]);
    await settled(initial);
    const ref = initial.getSnapshot(key).attachmentIds[0]!;
    await attachments.remove(ref);
    const restarted = createStore();
    expect(restarted.getSnapshot(key).loading).toBe(true);
    restarted.setPrompt(key, "typed while loading");
    await settled(restarted);
    expect(restarted.getSnapshot(key).prompt).toBe("typed while loading");
    expect(restarted.getSnapshot(key).missing).toMatchObject([{ id: ref, name: "missing.txt" }]);
    restarted.setFiles(key, [new File(["new"], "new.txt")]);
    expect(restarted.getSnapshot(key).missing).toHaveLength(1);
    restarted.removeMissing(key, ref);
    expect(restarted.getSnapshot(key).missing).toEqual([]);
  });

  it("retains in-memory drafts on storage failure without deleting the previous saved blobs", async () => {
    const attachments = createDraftAttachmentStorage();
    let failWrites = false;
    const storage = { getItem: (key: string) => localStorage.getItem(key), removeItem: (key: string) => localStorage.removeItem(key),
      setItem: (key: string, value: string) => { if (failWrites) throw new Error("Quota exceeded"); localStorage.setItem(key, value); } } as Storage;
    const store = new ComposerDraftStore(() => storage, attachments);
    store.setFiles(key, [new File(["saved"], "saved.txt")]);
    await settled(store);
    const oldId = store.getSnapshot(key).attachmentIds[0]!;
    failWrites = true;
    store.setPrompt(key, "new unsaved text");
    store.setFiles(key, []);
    expect(store.getSnapshot(key).prompt).toBe("new unsaved text");
    expect(store.getSnapshot(key).error).toContain("could not be saved");
    expect(await attachments.get(oldId)).toBeDefined();
    failWrites = false;
    store.setPrompt(key, "saved again");
    expect(store.getSnapshot(key).error).toBeNull();
  });

  it.each(['{"version":99}', "{broken"])("handles incompatible or corrupt metadata without crashing: %s", (raw) => {
    localStorage.setItem(key, raw);
    const store = createStore();
    expect(store.getSnapshot(key).error).toContain("Could not restore");
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it("retains unsaved files in memory when IndexedDB is unavailable", async () => {
    const store = createStore({ get: vi.fn(), put: async () => { throw new Error("Unavailable"); }, remove: vi.fn() });
    const unsubscribe = store.subscribe(key, () => {});
    const file = new File(["keep"], "keep.txt");
    store.setFiles(key, [file]);
    unsubscribe();
    await settled(store);
    expect(store.getSnapshot(key).files).toEqual([file]);
    expect(store.getSnapshot(key).error).toContain("attachments could not be saved");
    store.clearSubmitted(key, store.getSnapshot(key));
    expect(store.getSnapshot(key).error).toBeNull();
  });

  it("blocks file mutations until every saved attachment is restored", async () => {
    const attachments = createDraftAttachmentStorage();
    const initial = createStore(attachments);
    initial.setFiles(key, Array.from({ length: 8 }, (_, index) => new File(["saved"], `saved-${index}.txt`)));
    await settled(initial);
    let restore!: () => void;
    const gate = new Promise<void>((resolve) => { restore = resolve; });
    const restarted = createStore({ ...attachments, get: async (id) => { await gate; return attachments.get(id); } });
    expect(restarted.getSnapshot(key).loading).toBe(true);
    const append = vi.fn((current: File[]) => [...current, new File(["pasted"], "pasted.txt")]);
    restarted.setFiles(key, append);
    expect(append).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(key)!).attachments).toHaveLength(8);
    restore();
    await settled(restarted);
    expect(restarted.getSnapshot(key).files).toHaveLength(8);
    restarted.setFiles(key, (current) => current.slice(1));
    expect(restarted.getSnapshot(key).files).toHaveLength(7);
  });
});
