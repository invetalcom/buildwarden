import type { RunBrowserElementCapture } from "@buildwarden/shared";
import { createDraftAttachmentStorage, type DraftAttachmentStorage } from "./composer-draft-attachments";

export type ComposerDraftKind = "project" | "run" | "chat" | "new-chat" | "task-run" | "run-chat";
const PREFIX = "buildwarden.composer-draft.v1:";
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
  promptInitialized: boolean;
  prompt: string;
  attachments: DraftAttachmentReference[];
}
export interface ComposerDraftSnapshot {
  attachmentIds: string[];
  prompt: string;
  files: File[];
  captures: RunBrowserElementCapture[];
  loading: boolean;
  saving: boolean;
  submitting: boolean;
  error: string | null;
  missing: DraftAttachmentReference[];
}
type Update<T> = T | ((previous: T) => T);
interface Entry {
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

export class ComposerDraftStore {
  private entries = new Map<string, Entry>();
  constructor(private readonly storage: () => Storage, private readonly attachments: DraftAttachmentStorage) {}

  private entry(key: string): Entry {
    const existing = this.entries.get(key);
    if (existing) return existing;
    let metadata = empty();
    let error: string | null = null;
    try {
      const raw = this.storage().getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedDraft>;
        if (parsed.version !== 1 || typeof parsed.prompt !== "string" || !Array.isArray(parsed.attachments) || !parsed.attachments.every(referenceIsValid)) {
          throw new Error("Unsupported draft format");
        }
        metadata = { ...parsed as PersistedDraft, promptInitialized: parsed.promptInitialized !== false };
      }
    } catch { error = "Could not restore this draft. Browser storage may be unavailable or damaged."; }
    const entry: Entry = {
      key, metadata, objects: new Map(), listeners: new Set(), writes: new Map(), released: false,
      metadataError: error, failedAttachments: new Set(),
      snapshot: { attachmentIds: metadata.attachments.map((ref) => ref.id), prompt: metadata.prompt, files: [], captures: [], loading: metadata.attachments.length > 0, saving: false, submitting: false, error, missing: [] },
    };
    this.entries.set(key, entry);
    if (entry.snapshot.loading) void this.restoreAttachments(entry);
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
    entry.snapshot = { ...entry.snapshot, attachmentIds: entry.metadata.attachments.map((ref) => ref.id), prompt: entry.metadata.prompt, files, captures,
      saving: entry.writes.size > 0, error: entry.metadataError ?? attachmentError, ...changes };
    entry.listeners.forEach((listener) => listener());
    this.release(entry);
  }

  private release(entry: Entry) {
    // Keep unsaved attachments in memory after navigation; release persisted blobs
    // when no composer uses them so visiting many runs does not retain every File.
    if (entry.released && !entry.snapshot.loading && !entry.snapshot.saving && !entry.snapshot.submitting && !entry.snapshot.error && this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }

  private save(entry: Entry) {
    let saved = true;
    try {
      if (!entry.metadata.promptInitialized && !entry.metadata.prompt && entry.metadata.attachments.length === 0) this.storage().removeItem(entry.key);
      else this.storage().setItem(entry.key, JSON.stringify(entry.metadata));
      entry.metadataError = null;
    } catch {
      saved = false;
      entry.metadataError = "Draft could not be saved on this device. Keep this window open until you send or copy it.";
    }
    this.publish(entry);
    return saved;
  }

  private async restoreAttachments(entry: Entry) {
    const missing: DraftAttachmentReference[] = [];
    await Promise.all(entry.metadata.attachments.map(async (ref) => {
      try {
        const blob = await this.attachments.get(ref.id);
        if (!blob || blob.size !== ref.size) throw new Error("Attachment missing");
        if (ref.kind === "file") entry.objects.set(ref.id, new File([blob], ref.name, { type: ref.type, lastModified: ref.lastModified }));
        else {
          const capture = JSON.parse(await blob.text()) as RunBrowserElementCapture;
          if (!capture.id || !capture.contextAttachment?.dataBase64 || !capture.screenshotAttachment?.dataBase64) throw new Error("Invalid capture");
          entry.objects.set(ref.id, capture);
        }
      } catch { missing.push(ref); }
    }));
    this.publish(entry, { loading: false, missing: missing.filter((ref) => entry.metadata.attachments.some((current) => current.id === ref.id)) });
  }

  getSnapshot = (key: string) => this.entry(key).snapshot;

  /** Own a draft's in-flight send across composer unmounts; never persist a transient lock. */
  beginSubmission(key: string): (() => void) | null {
    const entry = this.entry(key);
    if (entry.snapshot.submitting) return null;
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
    return () => { entry.listeners.delete(listener); entry.released = entry.listeners.size === 0; this.release(entry); };
  };

  setPrompt(key: string, update: Update<string>) {
    const entry = this.entry(key);
    entry.metadata.promptInitialized = true;
    entry.metadata.prompt = typeof update === "function" ? update(entry.metadata.prompt) : update;
    this.save(entry);
  }

  /** Seed defaults once; an explicitly cleared prompt is still an initialized draft. */
  seedPrompt(key: string, prompt: string) {
    if (!this.entry(key).metadata.promptInitialized) this.setPrompt(key, prompt);
  }

  private setObjects(key: string, kind: DraftAttachmentReference["kind"], objects: Array<File | RunBrowserElementCapture>) {
    const entry = this.entry(key);
    const previous = entry.metadata.attachments;
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
      }).finally(() => { entry.writes.delete(ref.id); this.publish(entry); });
      entry.writes.set(ref.id, write);
      return ref;
    });
    entry.metadata.attachments = [...previous.filter((ref) => ref.kind !== kind || !entry.objects.has(ref.id)), ...next];
    if (this.save(entry)) this.removeUnused(entry, previous);
  }

  setFiles(key: string, update: Update<File[]>) {
    const current = this.getSnapshot(key).files;
    this.setObjects(key, "file", typeof update === "function" ? update(current) : update);
  }
  setCaptures(key: string, update: Update<RunBrowserElementCapture[]>) {
    const current = this.getSnapshot(key).captures;
    this.setObjects(key, "capture", typeof update === "function" ? update(current) : update);
  }

  private removeUnused(entry: Entry, previous: DraftAttachmentReference[]) {
    for (const ref of previous) {
      if (entry.metadata.attachments.some((current) => current.id === ref.id)) continue;
      entry.objects.delete(ref.id);
      entry.failedAttachments.delete(ref.id);
      // A clear/remove must run after an in-flight write, or the blob could reappear.
      void (entry.writes.get(ref.id) ?? Promise.resolve()).then(() => this.attachments.remove(ref.id)).catch(() => {});
    }
    this.publish(entry, { missing: entry.snapshot.missing.filter((ref) => entry.metadata.attachments.some((current) => current.id === ref.id)) });
  }

  removeMissing(key: string, id: string) {
    const entry = this.entry(key);
    const previous = entry.metadata.attachments;
    entry.metadata.attachments = previous.filter((ref) => ref.id !== id);
    if (this.save(entry)) this.removeUnused(entry, previous);
  }

  clearSubmitted(key: string, submitted: ComposerDraftSnapshot) {
    const entry = this.entry(key);
    const promptUnchanged = entry.metadata.prompt === submitted.prompt;
    if (promptUnchanged) entry.metadata.prompt = "";
    const previous = entry.metadata.attachments;
    entry.metadata.attachments = previous.filter((ref) => !submitted.attachmentIds.includes(ref.id));
    if (promptUnchanged && entry.metadata.attachments.length === 0) entry.metadata.promptInitialized = false;
    if (this.save(entry)) this.removeUnused(entry, previous);
  }
}

export const composerDraftStore = new ComposerDraftStore(() => window.localStorage, createDraftAttachmentStorage());
