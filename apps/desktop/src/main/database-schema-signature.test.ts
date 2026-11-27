import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BuildWardenDatabase, databaseSchemaSignature } from "@buildwarden/db";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const databases: BuildWardenDatabase[] = [];

const makePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-schema-signature-"));
  tempDirs.push(directory);
  return join(directory, "buildwarden.sqlite");
};

const open = async (path: string) => {
  const database = new BuildWardenDatabase(path);
  await database.init();
  databases.push(database);
  return database;
};

const withRaw = (path: string, operation: (raw: DatabaseSync) => void) => {
  const raw = new DatabaseSync(path);
  try {
    operation(raw);
  } finally {
    raw.close();
  }
};

const migrationSpy = () =>
  vi.spyOn(BuildWardenDatabase.prototype as unknown as { applySchemaMigrations: () => void }, "applySchemaMigrations");

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) await database.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("database schema signature", () => {
  it("migrates a new file once and skips the migrations when this build reopens it", async () => {
    const path = makePath();
    const migrations = migrationSpy();
    const first = await open(path);
    expect(migrations).toHaveBeenCalledTimes(1);
    first.setSetting("kept", "yes");
    await first.close();

    const second = await open(path);
    expect(migrations).toHaveBeenCalledTimes(1);
    expect(second.getSettings().kept).toBe("yes");
    second.setSetting("after-reopen", "works");
    expect(second.getSettings()["after-reopen"]).toBe("works");
  });

  it("migrates again when the file was last migrated by another build or before signatures existed", async () => {
    const path = makePath();
    await (await open(path)).close();
    const migrations = migrationSpy();

    withRaw(path, (raw) => raw.exec("update schema_state set signature = 'older-build'"));
    const otherBuild = await open(path);
    expect(migrations).toHaveBeenCalledTimes(1);
    await otherBuild.close();

    withRaw(path, (raw) => raw.exec("drop table schema_state"));
    const beforeSignatures = await open(path);
    expect(migrations).toHaveBeenCalledTimes(2);
    await beforeSignatures.close();

    withRaw(path, (raw) => {
      expect((raw.prepare("select signature from schema_state").get() as { signature: string }).signature).toBe(databaseSchemaSignature());
    });
    await open(path);
    expect(migrations).toHaveBeenCalledTimes(2);
  });

  it("keeps transcript search on the index after a skipped migration", async () => {
    const path = makePath();
    const indexOf = (database: BuildWardenDatabase) => (database as unknown as { historySearchIndex: string }).historySearchIndex;
    const first = await open(path);
    const expected = indexOf(first);
    await first.close();
    expect(indexOf(await open(path))).toBe(expected);
  });

  it("is a stable content hash", () => {
    expect(databaseSchemaSignature()).toMatch(/^[a-f0-9]{64}$/);
    expect(databaseSchemaSignature()).toBe(databaseSchemaSignature());
  });
});
