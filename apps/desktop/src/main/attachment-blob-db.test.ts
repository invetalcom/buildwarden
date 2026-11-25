import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateInlineAttachments } from "./attachment-storage-maintenance";
import { withStoredAttachmentMetadata } from "./services/run-step-content";
import {
  ATTACHMENT_STEP_TABLES,
  BuildWardenDatabase,
  INLINE_ATTACHMENT_MAX_BASE64_CHARS,
  getAttachmentBlobDirectory,
  syncDirectory,
} from "@buildwarden/db";
import {
  extractAttachmentPayloadsFromMetadata,
  extractStoredAttachmentsFromMetadata,
  type ChatAttachmentPayload,
} from "@buildwarden/shared";

const tempDirs: string[] = [];
const dbs: BuildWardenDatabase[] = [];

const makeDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-attachment-blobs-"));
  tempDirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "buildwarden.sqlite"));
  await db.init();
  dbs.push(db);
  return db;
};

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const makeFixture = (db: BuildWardenDatabase) => {
  const project = db.addProject({ repoPath: "C:\\repo", baseBranch: "main", resolvedName: "Repo" });
  const provider = db.addProviderAccount({ providerType: "claude-code", label: "Claude", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "claude-sonnet", displayName: "Claude", config: {}, capabilities: {}, enabled: true });
  const run = db.createRun({
    projectId: project.id,
    providerAccountId: provider.id,
    modelId: model.id,
    harnessType: "claude-code",
    mode: "code",
    workspaceType: "worktree",
    prompt: "Initial prompt",
    branchName: "main",
    worktreePath: "C:\\repo",
  });
  const chat = db.createChat(provider.id, model.id, "Initial prompt");
  return { run, chat };
};

const bytes = (size: number, seed = 7) => Buffer.from(Array.from({ length: size }, (_, index) => (index * seed) % 251));
const largeImage = (seed = 7): ChatAttachmentPayload => ({ fileName: "generated.png", mimeType: "image/png", dataBase64: bytes(64 * 1024, seed).toString("base64") });
const smallNote: ChatAttachmentPayload = { fileName: "note.md", mimeType: "text/markdown", dataBase64: Buffer.from("# Note").toString("base64") };
const metadataOf = (json: string) => JSON.parse(json) as Record<string, unknown>;
const blobFiles = (db: BuildWardenDatabase) => {
  const directory = db.getAttachmentBlobDirectory();
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
};

describe("attachment blob storage", () => {
  it("stores large chat attachments as files and keeps small ones inline", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    const image = largeImage();

    const step = db.appendChatEvent(chat.id, "log", "User", "See image", { source: "user", attachments: [image, smallNote] });

    expect(step.metadataJson).not.toContain(image.dataBase64);
    expect(step.metadataJson.length).toBeLessThan(INLINE_ATTACHMENT_MAX_BASE64_CHARS);
    const [stored, inline] = extractStoredAttachmentsFromMetadata(metadataOf(db.getChatSteps(chat.id).at(-1)!.metadataJson));
    expect(stored).toMatchObject({ fileName: "generated.png", mimeType: "image/png", byteLength: 64 * 1024 });
    expect(stored?.dataBase64).toBeUndefined();
    expect(inline).toEqual(smallNote);
    expect(db.getAttachmentBlob(stored!.blobId!)).toEqual({ blobId: stored!.blobId, dataBase64: image.dataBase64 });
    expect(getAttachmentBlobDirectory(db.getFilePath())).toBe(db.getAttachmentBlobDirectory());
  });

  it("hydrates stored references for provider history and skips them without a resolver", async () => {
    const db = await makeDb();
    const { run } = makeFixture(db);
    const image = largeImage();
    const step = db.appendRunStep(run.id, "log", "User", "Prompt", JSON.stringify({ source: "user", attachments: [image] }));
    const metadata = metadataOf(step.metadataJson);

    expect(extractAttachmentPayloadsFromMetadata(metadata)).toEqual([]);
    expect(extractAttachmentPayloadsFromMetadata(metadata, db.resolveAttachmentBlob)).toEqual([image]);
  });

  it("shares one file between a chat and its bookmark and removes it once nothing references it", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    db.appendChatEvent(chat.id, "output", "Image", "", { assistantKind: "files", attachments: [largeImage()] });
    db.addChatBookmark(chat.id);
    expect(blobFiles(db)).toHaveLength(1);

    const later = Date.now() + 2 * 60 * 60 * 1000;
    db.deleteChat(chat.id);
    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later)).toEqual({ removed: 0, removedBytes: 0 });
    db.removeChatBookmark(chat.id);
    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later)).toEqual({ removed: 1, removedBytes: 64 * 1024 });
    expect(blobFiles(db)).toHaveLength(0);
  });

  it("keeps files that only an archived rewind still references", async () => {
    const db = await makeDb();
    const { run } = makeFixture(db);
    const step = db.appendRunStep(run.id, "log", "User", "Prompt", JSON.stringify({ source: "user", attachments: [largeImage()] }));
    const raw = new DatabaseSync(db.getFilePath());
    try {
      raw.prepare("insert into run_rewind_archives (id, run_id, archive_json) values ('archive', ?, ?)")
        .run(run.id, JSON.stringify({ id: "archive", createdAt: step.createdAt, prompt: "Prompt", mode: "conversation", steps: [step] }));
      raw.prepare("delete from run_steps where id = ?").run(step.id);
    } finally {
      raw.close();
    }
    const later = Date.now() + 2 * 60 * 60 * 1000;

    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later).removed).toBe(0);
    db.deleteRun(run.id);
    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later).removed).toBe(1);
  });

  it("saves no partial bookmark when an attachment file cannot be written", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    db.appendChatEvent(chat.id, "log", "User", "First", { source: "user" });
    const raw = new DatabaseSync(db.getFilePath());
    try {
      raw.prepare("insert into chat_steps (id, chat_id, event_type, title, content, metadata_json, created_at) values ('legacy', ?, 'output', 'Image', '', ?, ?)")
        .run(chat.id, JSON.stringify({ attachments: [largeImage()] }), new Date(Date.now() + 1000).toISOString());
    } finally {
      raw.close();
    }
    // A file where the store directory belongs makes the attachment write fail.
    writeFileSync(db.getAttachmentBlobDirectory(), "blocked");

    expect(() => db.addChatBookmark(chat.id)).toThrow();
    expect(db.getChatBookmarksWithSteps()).toHaveLength(0);

    rmSync(db.getAttachmentBlobDirectory());
    db.addChatBookmark(chat.id);
    expect(db.getChatBookmarksWithSteps()[0]?.steps).toHaveLength(db.getChatSteps(chat.id).length);
  });

  it("keeps recent unreferenced files for a write whose row is not committed yet", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    db.appendChatEvent(chat.id, "output", "Image", "", { attachments: [largeImage()] });
    db.deleteChat(chat.id);

    expect(db.collectUnreferencedAttachmentBlobs().removed).toBe(0);
    expect(blobFiles(db)).toHaveLength(1);
  });

  it("externalizes replaced run step metadata", async () => {
    const db = await makeDb();
    const { run } = makeFixture(db);
    const step = db.appendRunStep(run.id, "output", "Image", "", "{}");
    const updated = db.updateRunStep(step.id, { metadataJson: JSON.stringify({ attachments: [largeImage()] }) });

    expect(extractStoredAttachmentsFromMetadata(metadataOf(updated.metadataJson))[0]?.blobId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("migrates inline attachments written by earlier versions in batches", async () => {
    const db = await makeDb();
    const { run, chat } = makeFixture(db);
    const image = largeImage(11);
    const legacyMetadata = JSON.stringify({ source: "user", attachments: [image, smallNote] });
    const raw = new DatabaseSync(db.getFilePath());
    try {
      for (let index = 0; index < 3; index += 1) {
        raw.prepare("insert into chat_steps (id, chat_id, event_type, title, content, metadata_json, created_at) values (?, ?, 'log', 'User', '', ?, ?)")
          .run(`legacy-chat-${String(index)}`, chat.id, legacyMetadata, new Date().toISOString());
      }
      raw.prepare("insert into run_steps (id, run_id, event_type, title, content, metadata_json, created_at) values ('legacy-run', ?, 'log', 'User', '', ?, ?)")
        .run(run.id, JSON.stringify({ attachments: [smallNote] }), new Date().toISOString());
    } finally {
      raw.close();
    }

    let moved = 0;
    let batches = 0;
    for (const table of ATTACHMENT_STEP_TABLES) {
      let after = 0;
      for (let batch = db.migrateInlineAttachmentBatch(table, after, 2); batch; batch = db.migrateInlineAttachmentBatch(table, after, 2)) {
        after = batch.lastRowId;
        moved += batch.moved;
        batches += 1;
      }
    }

    expect(moved).toBe(3);
    expect(batches).toBe(3);
    expect(blobFiles(db)).toHaveLength(1);
    const steps = db.getChatSteps(chat.id).filter((step) => step.id.startsWith("legacy-chat-"));
    for (const step of steps) {
      expect(step.metadataJson).not.toContain(image.dataBase64);
      expect(extractAttachmentPayloadsFromMetadata(metadataOf(step.metadataJson), db.resolveAttachmentBlob)).toEqual([image, smallNote]);
    }
    expect(db.getRunSteps(run.id).find((step) => step.id === "legacy-run")?.metadataJson).toContain(smallNote.dataBase64);
    expect(db.isDataMigrationComplete("attachment-blobs-v1")).toBe(false);
    db.markDataMigrationComplete("attachment-blobs-v1");
    expect(db.isDataMigrationComplete("attachment-blobs-v1")).toBe(true);
  });

  it("runs the startup migration once and records its completion", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    const raw = new DatabaseSync(db.getFilePath());
    try {
      raw.prepare("insert into chat_steps (id, chat_id, event_type, title, content, metadata_json, created_at) values ('legacy', ?, 'log', 'User', '', ?, ?)")
        .run(chat.id, JSON.stringify({ attachments: [largeImage()] }), new Date().toISOString());
    } finally {
      raw.close();
    }
    const pause = vi.fn(async () => {});

    await expect(migrateInlineAttachments(db, pause)).resolves.toEqual({ moved: 1, skipped: false });
    await expect(migrateInlineAttachments(db, pause)).resolves.toEqual({ moved: 0, skipped: true });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(blobFiles(db)).toHaveLength(1);
  });

  it("keeps every file while a backup holds the store", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    db.appendChatEvent(chat.id, "output", "Image", "", { attachments: [largeImage()] });
    db.deleteChat(chat.id);
    const later = Date.now() + 2 * 60 * 60 * 1000;
    const release = db.holdAttachmentBlobs();

    expect(db.collectUnreferencedAttachmentBlobs(0, later).removed).toBe(0);
    release();
    release();
    expect(db.collectUnreferencedAttachmentBlobs(0, later).removed).toBe(1);
  });

  it("removes interrupted temporary writes once they are old", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    db.appendChatEvent(chat.id, "output", "Image", "", { attachments: [largeImage()] });
    const directory = db.getAttachmentBlobDirectory();
    const shard = readdirSync(directory)[0]!;
    const blobId = readdirSync(join(directory, shard))[0]!;
    const temporary = join(directory, shard, `${blobId}.abcdef012345.tmp`);
    writeFileSync(temporary, "partial");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(temporary, old, old);

    expect(db.collectUnreferencedAttachmentBlobs().removed).toBe(1);
    expect(existsSync(temporary)).toBe(false);
    expect(db.getAttachmentBlob(blobId)).not.toBeNull();
  });

  it("refuses a reset while a backup export holds the store", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    db.appendChatEvent(chat.id, "output", "Image", "", { attachments: [largeImage()] });
    const release = db.holdAttachmentBlobs();

    await expect(db.resetAndReinit()).rejects.toThrow(/backup export/);
    expect(blobFiles(db)).toHaveLength(1);
    expect(db.getChatSteps(chat.id)).not.toHaveLength(0);
    release();
    await db.resetAndReinit();
    expect(blobFiles(db)).toHaveLength(0);
  });

  it("removes stored files when the database is reset", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    db.appendChatEvent(chat.id, "output", "Image", "", { attachments: [largeImage()] });
    await db.resetAndReinit();

    expect(existsSync(db.getAttachmentBlobDirectory())).toBe(false);
  });

  it("sends live events with the stored references instead of inline data", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    const metadata = { assistantKind: "files", attachments: [largeImage()] };
    const step = db.appendChatEvent(chat.id, "output", "Image", "", metadata);

    const event = withStoredAttachmentMetadata({ metadata, step });
    expect(JSON.stringify(event)).not.toContain(largeImage().dataBase64);
    expect(event.metadata?.assistantKind).toBe("files");
    expect(extractStoredAttachmentsFromMetadata(event.metadata!)[0]?.blobId).toMatch(/^[a-f0-9]{64}$/);
    const plain = { metadata: { source: "user" }, step };
    expect(withStoredAttachmentMetadata(plain)).toBe(plain);
  });

  it("syncs directory entries where the platform supports it", () => {
    const dir = mkdtempSync(join(tmpdir(), "buildwarden-sync-dir-"));
    tempDirs.push(dir);
    // Windows cannot open a directory for fsync; the helper must not try.
    expect(() => syncDirectory(join(dir, "missing"), "win32")).not.toThrow();
    if (process.platform !== "win32") expect(() => syncDirectory(dir)).not.toThrow();
  });

  it("rejects ids that are not content hashes", async () => {
    const db = await makeDb();
    expect(db.getAttachmentBlob("../buildwarden.sqlite")).toBeNull();
    expect(db.resolveAttachmentBlob("a".repeat(64))).toBeNull();
  });
});
