import type { RunBrowserElementCapture } from "@buildwarden/shared";
import { createDraftAttachmentStorage, type DraftAttachmentStorage } from "./composer-draft-attachments";
import type { RunBatchProgress } from "./run-batch";

export type ComposerDraftKind = "project" | "run" | "chat" | "new-chat" | "task-run" | "run-chat";
const PREFIX = "buildwarden.composer-draft.v1:";
const SCOPE_PREFIX = "buildwarden.composer-draft-scope.v1:";
const scopeKey = (environment: string) => SCOPE_PREFIX + JSON.stringify(environment);
export const composerDraftKey = (environment: string, kind: ComposerDraftKind, id: string) =>
  `${PREFIX}${JSON.stringify([environment, kind, id])}`;

export interface DraftAttachmentReference {
  id: string;
  kind: "file" | "capture";
  name: string;
  type: string;
  size: number;
  lastModified: number;
}
interface PersistedDraft {
  version: 1;
  scopeGeneration?: string | null;
  promptInitialized: boolean;
  prompt: string;
  attachments: DraftAttachmentReference[];
  runBatch?: { signature: string; acceptedModelIds: string[] };
}
export interface ComposerDraftSnapshot {
  attachmentIds: string[];
  prompt: string;
  files: File[];
  captures: RunBrowserElementCapture[];
  readOnly: boolean;
  acquiringLock: boolean;
  loading: boolean;
  saving: boolean;
  submitting: boolean;
  error: string | null;
  missing: DraftAttachmentReference[];
}
type Update<T> = T | ((previous: T) => T);
interface Entry {
  environment: string;
  generation: string | null;
  revoked: boolean;
  seed?: string;
  raw: string | null;
  lockAbort?: AbortController;
  unlock?: () => void;
  key: string;
  metadata: PersistedDraft;
  snapshot: ComposerDraftSnapshot;
  objects: Map<string, File | RunBrowserElementCapture>;
  listeners: Set<() => void>;
  writes: Map<string, Promise<void>>;
  released: boolean;
  metadataError: string | null;
  failedAttachments: Set<string>;
}
const empty = (): PersistedDraft => ({ version: 1, promptInitialized: false, prompt: "", attachments: [] });
const referenceIsValid = (value: unknown): value is DraftAttachmentReference => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DraftAttachmentReference>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.type === "string" &&
    (item.kind === "file" || item.kind === "capture") && typeof item.size === "number" && item.size >= 0 && typeof item.lastModified === "number";
};
const parseDraft = (raw: string): PersistedDraft => {
  const parsed = JSON.parse(raw) as Partial<PersistedDraft> | null;
  if (!parsed || parsed.version !== 1 || typeof parsed.prompt !== "string" || !Array.isArray(parsed.attachments) || !parsed.attachments.every(referenceIsValid)) {
    throw new Error("Unsupported draft format");
  }
  if (parsed.runBatch !== undefined && (!parsed.runBatch || typeof parsed.runBatch.signature !== "string" || !Array.isArray(parsed.runBatch.acceptedModelIds) || !parsed.runBatch.acceptedModelIds.every((id) => typeof id === "string"))) {
    throw new Error("Invalid draft submission progress");
  }
  return { ...parsed as PersistedDraft, promptInitialized: parsed.promptInitialized !== false };
};

export class ComposerDraftStore {
  private entries = new Map<string, Entry>();
  private environments = new Map<string, string | null>();
  constructor(private readonly storage: () => Storage, private readonly attachments: DraftAttachmentStorage, private readonly locks?: LockManager) {}

  /** Bind a client to its current scope generation without reactivating a removed connection. */
  observeEnvironment(environment: string) {
    if (!this.environments.has(environment)) {
      let generation: string | null = null;
      try { generation = this.storage().getItem(scopeKey(environment)); } catch { /* Storage is unavailable. */ }
      this.environments.set(environment, generation);
    }
    return this.environments.get(environment) ?? null;
  }

  /** Only an explicit successful pairing may start a new generation for a removed scope. */
  restoreEnvironment(environment: string) {
    const current = this.observeEnvironment(environment);
    let persisted = current;
    try { persisted = this.storage().getItem(scopeKey(environment)); } catch { /* Keep the known state. */ }
    if (!persisted?.startsWith("removed:") && persisted === current) return;
    const generation = "active:" + crypto.randomUUID();
    try { this.storage().setItem(scopeKey(environment), generation); } catch { return; }
    this.environments.set(environment, generation);
    this.synchronize(scopeKey(environment));
  }

  async removeEnvironment(environment: string) {
    const generation = "removed:" + crypto.randomUUID();
    // Publish revocation before enumerating keys. Old writers check this again when saving.
    try { this.storage().setItem(scopeKey(environment), generation); } catch { /* Cleanup remains best-effort. */ }
    this.environments.set(environment, generation);
    this.synchronize(scopeKey(environment));
    await this.deleteDrafts(environment);
  }

  private currentScope(entry: Entry): boolean {
    if (entry.revoked) return false;
    let generation = this.environments.get(entry.environment) ?? null;
    try { generation = this.storage().getItem(scopeKey(entry.environment)); } catch { /* Use the last known scope. */ }
    if (!generation?.startsWith("removed:") && generation === entry.generation && this.environments.get(entry.environment) === entry.generation) return true;
    entry.revoked = true;
    entry.metadata = empty();
    entry.objects.clear();
    entry.failedAttachments.clear();
    delete entry.seed;
    entry.lockAbort?.abort();
    entry.unlock?.();
    entry.metadataError = "This connection was removed. Reconnect before editing drafts.";
    this.publish(entry, { readOnly: true, acquiringLock: false, loading: false, missing: [] });
    return false;
  }

  /** Storage events refresh passive windows; mutations also re-read before changing metadata. */
  synchronize(key: string | null) {
    for (const entry of this.entries.values()) if (key === null || entry.key === key || scopeKey(entry.environment) === key) this.refresh(entry);
  }

  private refresh(entry: Entry) {
    if (!this.currentScope(entry)) return;
    try {
      const raw = this.storage().getItem(entry.key);
      if (raw === entry.raw) return;
      let metadata = raw ? parseDraft(raw) : empty();
      if ((metadata.scopeGeneration ?? null) !== entry.generation) metadata = empty();
      entry.raw = raw;
      entry.metadata = { ...metadata, promptInitialized: metadata.promptInitialized !== false };
      for (const id of entry.objects.keys()) if (!metadata.attachments.some((ref) => ref.id === id)) entry.objects.delete(id);
      const loading = metadata.attachments.some((ref) => !entry.objects.has(ref.id));
      this.publish(entry, { loading, missing: [] });
      if (loading) void this.restoreAttachments(entry);
    } catch { entry.metadataError = "Could not synchronize this draft with another window."; this.publish(entry); }
  }

  private claim(entry: Entry) {
    if (!this.currentScope(entry) || !this.locks || entry.lockAbort) return;
    const controller = new AbortController();
    entry.lockAbort = controller;
    const name = `${entry.key}:${entry.generation ?? "legacy"}`;
    const acquire = async () => {
      if (controller.signal.aborted) return;
      const held = new Promise<void>((resolve) => { entry.unlock = resolve; });
      this.refresh(entry);
      if (entry.revoked) return;
      this.publish(entry, { readOnly: false, acquiringLock: false });
      if (entry.snapshot.missing.length) { this.publish(entry, { loading: true }); void this.restoreAttachments(entry); }
      await held;
    };
    // Probe first so initial acquisition is not reported as another window's ownership.
    void this.locks.request(name, { ifAvailable: true }, async (lock) => {
      if (controller.signal.aborted) return;
      if (lock) return acquire();
      this.publish(entry, { acquiringLock: false });
      await this.locks!.request(name, { signal: controller.signal }, acquire);
    }).catch(() => {
      if (!controller.signal.aborted) { entry.metadataError = "Could not obtain exclusive access to this draft. Reload this window to retry."; this.publish(entry, { readOnly: true, acquiringLock: false }); }
    });
  }

  private editable(key: string) {
    const entry = this.entry(key);
    this.refresh(entry);
    return entry.snapshot.readOnly ? null : entry;
  }

  /** Enumerate only this environment; entity IDs are not globally unique across hosts. */
  private matchingKeys(environment: string, ids?: ReadonlySet<string>, kinds?: ReadonlySet<ComposerDraftKind>) {
    const keys = new Set(this.entries.keys());
    try {
      const storage = this.storage();
      for (let index = 0; index < storage.length; index++) keys.add(storage.key(index) ?? "");
    } catch { /* Storage may be blocked; still attempt cleanup of known in-memory drafts. */ }
    return [...keys].filter((key) => {
      if (!key.startsWith(PREFIX)) return false;
      try { const [scope, kind, id] = JSON.parse(key.slice(PREFIX.length)) as string[]; return scope === environment && (!ids || ids.has(id!)) && (!kinds || kinds.has(kind as ComposerDraftKind)); }
      catch { return false; }
    });
  }

  hasDrafts(environment: string) { return this.matchingKeys(environment).length > 0; }

  async deleteDrafts(environment: string, ids?: ReadonlySet<string>, kinds?: ReadonlySet<ComposerDraftKind>) {
    for (const key of this.matchingKeys(environment, ids, kinds)) {
      const entry = this.entries.get(key);
      if (!entry) {
        let references: DraftAttachmentReference[] = [];
        try {
          const raw = this.storage().getItem(key);
          if (raw) references = parseDraft(raw).attachments;
        } catch { /* Damaged metadata can still be explicitly deleted and swept. */ }
        try { this.storage().removeItem(key); } catch { continue; }
        await Promise.all(references.map((ref) => Promise.resolve().then(() => this.attachments.remove(ref.id)).catch(() => undefined)));
        continue;
      }
      try { this.storage().removeItem(key); }
      catch { continue; } // Retain referenced blobs if their metadata could not be removed.
      entry.raw = null;
      const previous = entry.metadata.attachments;
      entry.metadata = empty();
      delete entry.seed;
      this.removeUnused(entry, previous);
      // A pending write must finish before the final sweep, including writes removed earlier.
      await Promise.all(entry.writes.values());
      entry.objects.clear();
      entry.failedAttachments.clear();
      entry.metadataError = null;
      entry.released = entry.listeners.size === 0;
      this.publish(entry, { loading: false, missing: [] });
    }
    // Local housekeeping must not fail a completed host deletion or prevent disconnecting.
    await this.sweepAttachments().catch(() => undefined);
  }

  /** Collect orphan blobs without guessing that an offline host or a filtered list was deleted. */
  async sweepAttachments() {
    if (!this.attachments.keys) return;
    const candidates = await this.attachments.keys();
    const referenced = new Set([...this.entries.values()].flatMap((entry) => entry.metadata.attachments.map((ref) => ref.id)));
    const storage = this.storage();
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      // If metadata is damaged, retain blobs until it can be recovered or explicitly deleted.
      let metadata: PersistedDraft | null;
      try { metadata = JSON.parse(storage.getItem(key) ?? "null") as PersistedDraft | null; } catch { return; }
      if (metadata?.version !== 1 || !Array.isArray(metadata.attachments)) return;
      metadata.attachments.forEach((ref) => referenced.add(ref.id));
    }
    await Promise.all(candidates.filter((id) => !referenced.has(id)).map((id) => this.attachments.remove(id)));
  }

  private entry(key: string): Entry {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const [environment] = JSON.parse(key.slice(PREFIX.length)) as [string];
    const generation = this.observeEnvironment(environment);
    let metadata = empty();
    let raw: string | null = null;
    let error: string | null = null;
    try {
      raw = this.storage().getItem(key);
      if (raw) {
        const parsed = parseDraft(raw);
        if ((parsed.scopeGeneration ?? null) === generation) metadata = parsed;
      }
    } catch { error = "Could not restore this draft. Browser storage may be unavailable or damaged."; }
    const entry: Entry = {
      key, environment, generation, revoked: false, raw, metadata, objects: new Map(), listeners: new Set(), writes: new Map(), released: false,
      metadataError: error, failedAttachments: new Set(),
      snapshot: { readOnly: Boolean(this.locks), acquiringLock: Boolean(this.locks), attachmentIds: metadata.attachments.map((ref) => ref.id), prompt: metadata.prompt, files: [], captures: [], loading: metadata.attachments.length > 0, saving: false, submitting: false, error, missing: [] },
    };
    this.entries.set(key, entry);
    if (this.currentScope(entry) && entry.snapshot.loading) void this.restoreAttachments(entry);
    return entry;
  }

  private publish(entry: Entry, changes: Partial<ComposerDraftSnapshot> = {}) {
    const files: File[] = [];
    const captures: RunBrowserElementCapture[] = [];
    for (const ref of entry.metadata.attachments) {
      const object = entry.objects.get(ref.id);
      if (object && ref.kind === "file") files.push(object as File);
      if (object && ref.kind === "capture") captures.push(object as RunBrowserElementCapture);
    }
    const attachmentError = entry.metadata.attachments.some((ref) => entry.failedAttachments.has(ref.id))
      ? "Draft attachments could not be saved. Keep this window open until you send or copy them." : null;
    entry.snapshot = { ...entry.snapshot, attachmentIds: entry.metadata.attachments.map((ref) => ref.id), prompt: entry.metadata.promptInitialized ? entry.metadata.prompt : entry.seed ?? entry.metadata.prompt, files, captures,
      saving: entry.writes.size > 0, error: entry.metadataError ?? attachmentError, ...changes };
    entry.listeners.forEach((listener) => listener());
    this.release(entry);
  }

  private release(entry: Entry) {
    // Keep unsaved attachments in memory after navigation; release persisted blobs
    // when no composer uses them so visiting many runs does not retain every File.
    if (entry.released && !entry.snapshot.loading && !entry.snapshot.saving && !entry.snapshot.submitting && (!entry.snapshot.error || entry.revoked) && this.entries.get(entry.key) === entry) {
      entry.lockAbort?.abort();
      entry.unlock?.();
      this.entries.delete(entry.key);
    }
  }

  private save(entry: Entry) {
    if (!this.currentScope(entry)) return false;
    entry.metadata.scopeGeneration = entry.generation;
    let saved = true;
    try {
      if (!entry.metadata.promptInitialized && !entry.metadata.prompt && entry.metadata.attachments.length === 0) this.storage().removeItem(entry.key);
      else this.storage().setItem(entry.key, JSON.stringify(entry.metadata));
      entry.raw = this.storage().getItem(entry.key);
      const written = entry.raw;
      if (!this.currentScope(entry)) {
        // A removal may race the synchronous write in another renderer process.
        // Remove only this generation's write, never a newly paired client's draft.
        if (this.storage().getItem(entry.key) === written) this.storage().removeItem(entry.key);
        return false;
      }
      entry.metadataError = null;
    } catch {
      saved = false;
      entry.metadataError = "Draft could not be saved on this device. Keep this window open until you send or copy it.";
    }
    this.publish(entry);
    return saved;
  }

  private async restoreAttachments(entry: Entry) {
    const metadata = entry.metadata;
    const missing: DraftAttachmentReference[] = [];
    await Promise.all(metadata.attachments.map(async (ref) => {
      try {
        const blob = await this.attachments.get(ref.id);
        if (!blob || blob.size !== ref.size) throw new Error("Attachment missing");
        if (!this.currentScope(entry) || !entry.metadata.attachments.some((current) => current.id === ref.id)) return;
        if (ref.kind === "file") entry.objects.set(ref.id, new File([blob], ref.name, { type: ref.type, lastModified: ref.lastModified }));
        else {
          const capture = JSON.parse(await blob.text()) as RunBrowserElementCapture;
          if (!capture.id || !capture.contextAttachment?.dataBase64 || !capture.screenshotAttachment?.dataBase64) throw new Error("Invalid capture");
          if (this.currentScope(entry) && entry.metadata === metadata) entry.objects.set(ref.id, capture);
        }
      } catch { missing.push(ref); }
    }));
    if (entry.metadata !== metadata) return;
    this.publish(entry, { loading: false, missing: missing.filter((ref) => entry.metadata.attachments.some((current) => current.id === ref.id)) });
  }

  getSnapshot = (key: string) => this.entry(key).snapshot;

  /** Own a draft's in-flight send across composer unmounts; never persist a transient lock. */
  beginSubmission(key: string, expected?: ComposerDraftSnapshot): (() => void) | null {
    const entry = this.entry(key);
    this.refresh(entry);
    if (entry.snapshot.submitting || entry.snapshot.readOnly || entry.snapshot.loading) return null;
    if (expected && (expected.prompt !== entry.snapshot.prompt || expected.attachmentIds.join() !== entry.snapshot.attachmentIds.join())) return null;
    this.publish(entry, { submitting: true });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.publish(entry, { submitting: false });
    };
  }

  subscribe = (key: string, listener: () => void) => {
    const entry = this.entry(key);
    entry.released = false;
    entry.listeners.add(listener);
    this.claim(entry);
    return () => { entry.listeners.delete(listener); entry.released = entry.listeners.size === 0; this.release(entry); };
  };

  setPrompt(key: string, update: Update<string>) {
    const entry = this.editable(key);
    if (!entry) return;
    entry.metadata.prompt = typeof update === "function" ? update(entry.snapshot.prompt) : update;
    entry.metadata.promptInitialized = true;
    delete entry.seed;
    this.save(entry);
  }

  /** Defaults stay in memory until the user edits, attaches content, or starts a run. */
  seedPrompt(key: string, prompt: string) {
    const entry = this.entry(key);
    this.refresh(entry);
    if (entry.revoked) return;
    if (!entry.metadata.promptInitialized) {
      entry.seed = prompt;
      this.publish(entry);
    }
  }

  private retainSeed(entry: Entry) {
    if (entry.seed === undefined || entry.metadata.promptInitialized) return;
    entry.metadata.prompt = entry.seed;
    entry.metadata.promptInitialized = true;
    delete entry.seed;
  }

  /** Persist partial launch progress with the draft; changed launch inputs start a fresh batch. */
  prepareRunBatch(key: string, signature: string): RunBatchProgress {
    const entry = this.editable(key);
    if (!entry) throw new Error("This draft is open in another window.");
    this.retainSeed(entry);
    if (entry.metadata.runBatch?.signature !== signature) {
      entry.metadata.runBatch = { signature, acceptedModelIds: [] };
      this.save(entry);
    }
    const batch = entry.metadata.runBatch;
    return {
      acceptedModelIds: [...batch.acceptedModelIds],
      recordAccepted: (modelId) => {
        if (entry.metadata.runBatch !== batch || batch.acceptedModelIds.includes(modelId)) return;
        batch.acceptedModelIds.push(modelId);
        this.save(entry);
      },
    };
  }

  private setObjects(key: string, kind: DraftAttachmentReference["kind"], objects: Array<File | RunBrowserElementCapture>) {
    const entry = this.editable(key);
    if (!entry) return;
    const previous = entry.metadata.attachments;
    this.retainSeed(entry);
    const next = objects.map((object): DraftAttachmentReference => {
      const found = previous.find((ref) => ref.kind === kind && entry.objects.get(ref.id) === object);
      if (found) return found;
      const blob = kind === "file" ? object as File : new Blob([JSON.stringify(object)], { type: "application/json" });
      const file = kind === "file" ? object as File : null;
      const ref: DraftAttachmentReference = { id: crypto.randomUUID(), kind, name: file?.name ?? `Browser selection ${(object as RunBrowserElementCapture).annotationNumber}`,
        type: blob.type, size: blob.size, lastModified: file?.lastModified ?? Date.now() };
      entry.objects.set(ref.id, object);
      const write = this.attachments.put(ref.id, blob).catch(() => {
        entry.failedAttachments.add(ref.id);
        this.publish(entry);
      }).finally(() => {
        this.refresh(entry);
        entry.writes.delete(ref.id);
        // Another window may delete the draft before this window's IndexedDB write finishes.
        if (!entry.metadata.attachments.some((current) => current.id === ref.id)) void Promise.resolve().then(() => this.attachments.remove(ref.id)).catch(() => {});
        this.publish(entry);
      });
      entry.writes.set(ref.id, write);
      return ref;
    });
    entry.metadata.attachments = [...previous.filter((ref) => ref.kind !== kind || !entry.objects.has(ref.id)), ...next];
    if (this.save(entry)) this.removeUnused(entry, previous);
  }

  setFiles(key: string, update: Update<File[]>) {
    const entry = this.editable(key);
    // Callers validate against the current files; that list is incomplete during hydration.
    if (!entry || entry.snapshot.loading) return;
    const current = entry.snapshot.files;
    this.setObjects(key, "file", typeof update === "function" ? update(current) : update);
  }
  setCaptures(key: string, update: Update<RunBrowserElementCapture[]>) {
    const entry = this.editable(key);
    if (!entry || entry.snapshot.loading) return;
    const current = entry.snapshot.captures;
    this.setObjects(key, "capture", typeof update === "function" ? update(current) : update);
  }

  private removeUnused(entry: Entry, previous: DraftAttachmentReference[]) {
    for (const ref of previous) {
      if (entry.metadata.attachments.some((current) => current.id === ref.id)) continue;
      entry.objects.delete(ref.id);
      entry.failedAttachments.delete(ref.id);
      // Pending writes remove abandoned blobs in their completion handler.
      if (!entry.writes.has(ref.id)) void Promise.resolve().then(() => this.attachments.remove(ref.id)).catch(() => {});
    }
    this.publish(entry, { missing: entry.snapshot.missing.filter((ref) => entry.metadata.attachments.some((current) => current.id === ref.id)) });
  }

  removeMissing(key: string, id: string) {
    const entry = this.editable(key);
    if (!entry) return;
    const previous = entry.metadata.attachments;
    entry.metadata.attachments = previous.filter((ref) => ref.id !== id);
    if (this.save(entry)) this.removeUnused(entry, previous);
  }

  clearSubmitted(key: string, submitted: ComposerDraftSnapshot) {
    const entry = this.editable(key);
    if (!entry) return;
    delete entry.metadata.runBatch;
    const promptUnchanged = entry.snapshot.prompt === submitted.prompt;
    if (promptUnchanged) { entry.metadata.prompt = ""; delete entry.seed; }
    const previous = entry.metadata.attachments;
    entry.metadata.attachments = previous.filter((ref) => !submitted.attachmentIds.includes(ref.id));
    if (promptUnchanged && entry.metadata.attachments.length === 0) entry.metadata.promptInitialized = false;
    if (this.save(entry)) this.removeUnused(entry, previous);
  }
}

export const composerDraftStore = new ComposerDraftStore(() => window.localStorage, createDraftAttachmentStorage(), typeof navigator === "undefined" ? undefined : navigator.locks);
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.storageArea === window.localStorage) composerDraftStore.synchronize(event.key);
});
