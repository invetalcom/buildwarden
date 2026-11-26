import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ATTACHMENT_BLOB_REFS_MIGRATION, BuildWardenDatabase } from "@buildwarden/db";
import type { ChatAttachmentPayload } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillAttachmentBlobRefs } from "./attachment-storage-maintenance";

const tempDirs: string[] = [];
const dbs: BuildWardenDatabase[] = [];

const makeDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-blob-refs-"));
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

const bytes = (size: number, seed: number) => Buffer.from(Array.from({ length: size }, (_, index) => (index * seed) % 251));
const largeImage = (seed = 7): ChatAttachmentPayload => ({ fileName: "generated.png", mimeType: "image/png", dataBase64: bytes(64 * 1024, seed).toString("base64") });
const later = () => Date.now() + 2 * 60 * 60 * 1000;
const blobFiles = (db: BuildWardenDatabase) => {
  const directory = db.getAttachmentBlobDirectory();
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
};

const withRaw = <T>(db: BuildWardenDatabase, operation: (raw: DatabaseSync) => T): T => {
  const raw = new DatabaseSync(db.getFilePath());
  try {
    return operation(raw);
  } finally {
    raw.close();
  }
};

const refsOf = (db: BuildWardenDatabase) => withRaw(db, (raw) =>
  raw.prepare("select owner_table as ownerTable, owner_id as ownerId, blob_id as blobId from attachment_blob_refs order by owner_table, owner_id, blob_id").all() as
    Array<{ ownerTable: string; ownerId: string; blobId: string }>);

describe("attachment blob references", () => {
  it("follows steps as they are written, changed and deleted", async () => {
    const db = await makeDb();
    const { run, chat } = makeFixture(db);
    const chatStep = db.appendChatEvent(chat.id, "output", "Image", "", { attachments: [largeImage(3)] });
    const runStep = db.appendRunStep(run.id, "output", "Image", "", JSON.stringify({ attachments: [largeImage(5)] }));
    const visual = db.putAttachmentBlob(Buffer.from("<p>page</p>"));
    const visualStep = db.appendRunStep(run.id, "output", "Visual reply", "", JSON.stringify({ visualReply: { title: "Page", ...visual } }));

    expect(refsOf(db).map(({ ownerTable, ownerId }) => `${ownerTable}:${ownerId}`)).toEqual([
      `chat_steps:${chatStep.id}`,
      ...[`run_steps:${runStep.id}`, `run_steps:${visualStep.id}`].sort(),
    ]);
    expect(refsOf(db).find((ref) => ref.ownerId === visualStep.id)?.blobId).toBe(visual.blobId);

    db.updateRunStep(runStep.id, { metadataJson: "{}" });
    expect(refsOf(db).some((ref) => ref.ownerId === runStep.id)).toBe(false);

    db.deleteChat(chat.id);
    expect(refsOf(db).some((ref) => ref.ownerTable === "chat_steps")).toBe(false);
    db.deleteRun(run.id);
    expect(refsOf(db)).toEqual([]);
  });

  it("records nothing for metadata it cannot read, and still saves the step", async () => {
    const db = await makeDb();
    const { run } = makeFixture(db);
    withRaw(db, (raw) => {
      const insert = raw.prepare("insert into run_steps (id, run_id, event_type, title, content, metadata_json, created_at) values (?, ?, 'output', '', '', ?, ?)");
      const at = new Date().toISOString();
      insert.run("broken", run.id, '{"blobId": oops', at);
      insert.run("scalar-attachments", run.id, JSON.stringify({ attachments: ["blobId", 3, null, { blobId: 4 }] }), at);
      insert.run("object-attachments", run.id, JSON.stringify({ attachments: { blobId: "x" } }), at);
      insert.run("array-metadata", run.id, JSON.stringify([{ blobId: "x" }]), at);
    });
    expect(db.getRunSteps(run.id).map((step) => step.id)).toEqual(expect.arrayContaining(["broken", "scalar-attachments", "object-attachments", "array-metadata"]));
    expect(refsOf(db)).toEqual([]);
  });

  it("backfills steps of earlier versions in batches and then cleans up from the table", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    db.appendChatEvent(chat.id, "output", "Image", "", { attachments: [largeImage(3)] });
    db.appendChatEvent(chat.id, "output", "Image", "", { attachments: [largeImage(5)] });
    db.addChatBookmark(chat.id);
    const expected = refsOf(db);
    expect(expected).toHaveLength(4);
    // Earlier versions wrote these steps before the triggers existed.
    withRaw(db, (raw) => raw.exec("delete from attachment_blob_refs"));

    // Until the backfill finished, cleanup reads the steps and keeps every referenced file.
    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later()).removed).toBe(0);

    const pause = vi.fn(async () => {});
    for (let afterId = "", batch = db.backfillAttachmentBlobRefsBatch("chat_steps", afterId, 1); batch; batch = db.backfillAttachmentBlobRefsBatch("chat_steps", afterId, 1)) {
      expect(batch.lastId > afterId).toBe(true);
      afterId = batch.lastId;
    }
    await expect(backfillAttachmentBlobRefs(db, pause)).resolves.toEqual({ skipped: false });
    await expect(backfillAttachmentBlobRefs(db, pause)).resolves.toEqual({ skipped: true });
    expect(db.isDataMigrationComplete(ATTACHMENT_BLOB_REFS_MIGRATION)).toBe(true);
    expect(refsOf(db)).toEqual(expected);

    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later()).removed).toBe(0);
    db.deleteChat(chat.id);
    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later()).removed).toBe(0);
    db.removeChatBookmark(chat.id);
    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later())).toEqual({ removed: 2, removedBytes: 2 * 64 * 1024 });
    expect(blobFiles(db)).toHaveLength(0);
  });

  it("keeps a file that only an archived rewind still references once the table is in use", async () => {
    const db = await makeDb();
    db.markDataMigrationComplete(ATTACHMENT_BLOB_REFS_MIGRATION);
    const { run } = makeFixture(db);
    const step = db.appendRunStep(run.id, "log", "User", "Prompt", JSON.stringify({ source: "user", attachments: [largeImage()] }));
    withRaw(db, (raw) => {
      raw.prepare("insert into run_rewind_archives (id, run_id, archive_json) values ('archive', ?, ?)")
        .run(run.id, JSON.stringify({ id: "archive", createdAt: step.createdAt, prompt: "Prompt", mode: "conversation", steps: [step] }));
      raw.prepare("delete from run_steps where id = ?").run(step.id);
    });

    expect(refsOf(db)).toEqual([]);
    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later()).removed).toBe(0);
    db.deleteRun(run.id);
    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later()).removed).toBe(1);
  });

  it("keeps references across a compaction", async () => {
    const db = await makeDb();
    db.markDataMigrationComplete(ATTACHMENT_BLOB_REFS_MIGRATION);
    const { chat } = makeFixture(db);
    db.appendChatEvent(chat.id, "output", "Image", "", { attachments: [largeImage()] });
    const before = refsOf(db);
    db.compact();
    expect(refsOf(db)).toEqual(before);
    expect(db.collectUnreferencedAttachmentBlobs(60 * 60 * 1000, later()).removed).toBe(0);
  });
});
