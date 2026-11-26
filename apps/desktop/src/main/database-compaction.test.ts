import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BuildWardenDatabase } from "@buildwarden/db";
import { afterEach, describe, expect, it } from "vitest";
import { switchToIncrementalVacuum } from "./attachment-storage-maintenance";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const createDatabase = async (): Promise<{ database: BuildWardenDatabase; path: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "buildwarden-compact-"));
  const path = join(directory, "state.sqlite");
  const database = new BuildWardenDatabase(path);
  await database.init();
  cleanups.push(async () => {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { database, path };
};

const connectionOf = (database: BuildWardenDatabase): DatabaseSync =>
  (database as unknown as { db: DatabaseSync }).db;

const settingRowIds = (database: BuildWardenDatabase): Array<{ key: string; rowId: number }> =>
  connectionOf(database).prepare("select key, rowid as rowId from app_settings where key like 'bulk-%' order by rowid").all() as
    Array<{ key: string; rowId: number }>;

describe("database compaction", () => {
  it("returns space left by deleted rows to the filesystem and keeps the remaining data and row ids", async () => {
    const { database, path } = await createDatabase();
    const payload = "x".repeat(4_000);
    for (let index = 0; index < 1_500; index += 1) database.setSetting(`bulk-${String(index)}`, payload);
    // Interleaved deletes leave mostly partly filled pages, which the free-page count does not see.
    connectionOf(database).exec("delete from app_settings where key like 'bulk-%' and cast(substr(key, 6) as integer) % 3 != 0");
    const remainingBefore = settingRowIds(database);

    const before = database.getStorageInfo();
    expect(before.totalBytes).toBe(before.fileBytes + before.walBytes);
    expect(before.totalBytes).toBeGreaterThan(0);

    const result = database.compact();

    expect(result.beforeBytes).toBe(before.totalBytes);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(result.afterBytes).toBe(result.beforeBytes - result.reclaimedBytes);
    const after = database.getStorageInfo();
    expect(after).toMatchObject({ totalBytes: result.afterBytes, walBytes: 0, freeBytes: 0 });
    expect(statSync(path).size).toBe(after.fileBytes);
    expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);

    expect(settingRowIds(database)).toEqual(remainingBefore);
    expect(database.getSettings()["bulk-0"]).toBe(payload);
  });

  it("keeps run and chat history row ids, so paging cursors issued before compaction stay valid", async () => {
    const { database } = await createDatabase();
    const project = database.addProject({ repoPath: "C:\\repo", baseBranch: "main", resolvedName: "Repo" });
    const provider = database.addProviderAccount({ providerType: "claude-code", label: "Claude", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
    const model = database.addModel({ providerAccountId: provider.id, modelId: "claude-sonnet", displayName: "Claude", config: {}, capabilities: {}, enabled: true });
    const createRun = (prompt: string) => database.createRun({
      projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "claude-code", mode: "code",
      workspaceType: "worktree", prompt, branchName: "main", worktreePath: "C:\\repo",
    });
    const kept = { run: createRun("kept"), chat: database.createChat(provider.id, model.id, "kept") };
    const removed = { run: createRun("removed"), chat: database.createChat(provider.id, model.id, "removed") };
    const content = "y".repeat(2_000);
    // Interleave a second owner whose rows are deleted afterwards, leaving gaps VACUUM must close.
    for (let index = 0; index < 40; index += 1) {
      for (const owner of [kept, removed]) {
        database.appendRunStep(owner.run.id, "log", `user-${String(index)}`, content, JSON.stringify({ source: "user" }));
        database.appendRunStep(owner.run.id, "output", `assistant-${String(index)}`, content);
        database.appendChatEvent(owner.chat.id, "log", `user-${String(index)}`, content, { source: "user" });
        database.appendChatEvent(owner.chat.id, "output", `assistant-${String(index)}`, content);
      }
    }
    connectionOf(database).prepare("delete from run_steps where run_id = ?").run(removed.run.id);
    connectionOf(database).prepare("delete from chat_steps where chat_id = ?").run(removed.chat.id);

    const stepRowIds = () => ({
      run: connectionOf(database).prepare("select id, rowid as rowId from run_steps order by rowid").all(),
      chat: connectionOf(database).prepare("select id, rowid as rowId from chat_steps order by rowid").all(),
    });
    const rowIdsBefore = stepRowIds();
    const runCursor = database.getInitialRunHistory(kept.run.id).page;
    const chatCursor = database.getInitialChatHistory(kept.chat.id).page;
    const earlierRunBefore = database.getEarlierRunHistory(kept.run.id, { beforeCursor: runCursor.beforeCursor!, snapshotRevision: runCursor.snapshotRevision });
    const earlierChatBefore = database.getEarlierChatHistory(kept.chat.id, { beforeCursor: chatCursor.beforeCursor!, snapshotRevision: chatCursor.snapshotRevision });

    expect(database.compact().reclaimedBytes).toBeGreaterThan(0);

    expect(stepRowIds()).toEqual(rowIdsBefore);
    const earlierRunAfter = database.getEarlierRunHistory(kept.run.id, { beforeCursor: runCursor.beforeCursor!, snapshotRevision: runCursor.snapshotRevision });
    const earlierChatAfter = database.getEarlierChatHistory(kept.chat.id, { beforeCursor: chatCursor.beforeCursor!, snapshotRevision: chatCursor.snapshotRevision });
    expect(earlierRunAfter.stale).toBe(false);
    expect(earlierChatAfter.stale).toBe(false);
    expect(earlierRunAfter).toEqual(earlierRunBefore);
    expect(earlierChatAfter).toEqual(earlierChatBefore);
  });

  it("reports an incomplete compaction when another connection keeps the log from being truncated", async () => {
    const { database, path } = await createDatabase();
    for (let index = 0; index < 200; index += 1) database.setSetting(`bulk-${String(index)}`, "z".repeat(4_000));
    connectionOf(database).exec("delete from app_settings where key like 'bulk-%'; pragma busy_timeout = 50");
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      reader.exec("begin");
      reader.prepare("select count(*) from app_settings").get();
      expect(() => database.compact()).toThrow("another program is reading it");
      reader.exec("commit");
    } finally {
      reader.close();
    }

    expect(database.compact().afterBytes).toBe(database.getStorageInfo().totalBytes);
    expect(database.getStorageInfo().walBytes).toBe(0);
  });

  it("refuses to compact inside an open transaction", async () => {
    const { database } = await createDatabase();
    expect(() => database.transaction(() => database.compact())).toThrow("transaction is open");
    database.setSetting("still-writable", "yes");
    expect(database.getSettings()["still-writable"]).toBe("yes");
  });
});

describe("incremental free-page reclaim", () => {
  const autoVacuumMode = (database: BuildWardenDatabase): number =>
    Number((connectionOf(database).prepare("pragma auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum);

  it("creates new databases in incremental mode and returns a bounded batch of free pages", async () => {
    const { database } = await createDatabase();
    expect(autoVacuumMode(database)).toBe(2);
    for (let index = 0; index < 1_500; index += 1) database.setSetting(`bulk-${String(index)}`, "y".repeat(4_000));
    connectionOf(database).exec("delete from app_settings where key like 'bulk-%'");
    const freeBefore = database.getStorageInfo().freeBytes;
    expect(freeBefore).toBeGreaterThan(4 * 1024 * 1024);

    const reclaimed = database.reclaimFreePages(256);
    const pageSize = Number((connectionOf(database).prepare("pragma page_size").get() as { page_size: number }).page_size);
    expect(reclaimed.reclaimedBytes).toBe(256 * pageSize);
    expect(database.getStorageInfo().freeBytes).toBe(freeBefore - reclaimed.reclaimedBytes);

    database.reclaimFreePages(1_000_000);
    expect(database.getStorageInfo().freeBytes).toBe(0);
    expect(database.reclaimFreePages().reclaimedBytes).toBe(0);
  });

  it("leaves databases without incremental mode alone until compaction switches them over", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildwarden-legacy-vacuum-"));
    const path = join(directory, "state.sqlite");
    // Earlier versions created files without auto_vacuum; the mode cannot change before a VACUUM.
    const legacy = new DatabaseSync(path);
    legacy.exec("create table legacy_marker (id integer primary key)");
    legacy.close();
    const database = new BuildWardenDatabase(path);
    await database.init();
    cleanups.push(async () => {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    });
    expect(autoVacuumMode(database)).toBe(0);
    for (let index = 0; index < 1_500; index += 1) database.setSetting(`bulk-${String(index)}`, "w".repeat(4_000));
    connectionOf(database).exec("delete from app_settings where key like 'bulk-%'");
    expect(database.reclaimFreePages().reclaimedBytes).toBe(0);

    database.compact();
    expect(autoVacuumMode(database)).toBe(2);
    database.setSetting("after-compaction", "kept");
    expect(database.getSettings()["after-compaction"]).toBe("kept");
  });

  it("switches a mostly free legacy file to incremental mode once, and only while idle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildwarden-legacy-switch-"));
    const path = join(directory, "state.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec("create table legacy_marker (id integer primary key)");
    legacy.close();
    const database = new BuildWardenDatabase(path);
    await database.init();
    cleanups.push(async () => {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    });
    database.setSetting("kept", "value");
    for (let index = 0; index < 6_000; index += 1) database.setSetting(`bulk-${String(index)}`, "v".repeat(4_000));
    connectionOf(database).exec("delete from app_settings where key like 'bulk-%'");
    expect(database.getStorageInfo().freeBytes).toBeGreaterThan(16 * 1024 * 1024);

    expect(switchToIncrementalVacuum(database, () => false)).toBeNull();
    expect(autoVacuumMode(database)).toBe(0);

    const switched = switchToIncrementalVacuum(database, () => true);
    expect(switched?.reclaimedBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(autoVacuumMode(database)).toBe(2);
    expect(database.getSettings().kept).toBe("value");
    expect(switchToIncrementalVacuum(database, () => true)).toBeNull();
  });

  it("leaves a legacy file alone while little of it is free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildwarden-legacy-small-"));
    const path = join(directory, "state.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec("create table legacy_marker (id integer primary key)");
    legacy.close();
    const database = new BuildWardenDatabase(path);
    await database.init();
    cleanups.push(async () => {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    });
    for (let index = 0; index < 200; index += 1) database.setSetting(`bulk-${String(index)}`, "s".repeat(4_000));
    connectionOf(database).exec("delete from app_settings where key like 'bulk-%'");

    expect(switchToIncrementalVacuum(database, () => true)).toBeNull();
    expect(autoVacuumMode(database)).toBe(0);
  });

  it("keeps serving queries after the connection is reopened", async () => {
    const { database } = await createDatabase();
    database.setSetting("before-reopen", "one");
    expect(database.getSettings()["before-reopen"]).toBe("one");
    await database.close();
    await database.init();
    // Statements prepared on the closed connection must not be reused.
    database.setSetting("after-reopen", "two");
    expect(database.getSettings()).toMatchObject({ "before-reopen": "one", "after-reopen": "two" });
  });
});
