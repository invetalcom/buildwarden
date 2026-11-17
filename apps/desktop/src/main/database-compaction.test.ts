import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BuildWardenDatabase } from "@buildwarden/db";
import { afterEach, describe, expect, it } from "vitest";

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

  it("refuses to compact inside an open transaction", async () => {
    const { database } = await createDatabase();
    expect(() => database.transaction(() => database.compact())).toThrow("transaction is open");
    database.setSetting("still-writable", "yes");
    expect(database.getSettings()["still-writable"]).toBe("yes");
  });
});
