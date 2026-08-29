import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, buildDefaultProjectRunDefaults, parseProjectRunDefaultsSetting } from "@buildwarden/shared";
import { afterEach, describe, expect, it } from "vitest";

type TestDatabase = {
  database: BuildWardenDatabase;
  directory: string;
  path: string;
};

class ResetObservationDatabase extends BuildWardenDatabase {
  private initialized = false;
  sidecarsBeforeReinit: { wal: boolean; shm: boolean } | null = null;

  constructor(private readonly observedPath: string) {
    super(observedPath);
  }

  override async init(): Promise<void> {
    if (this.initialized) {
      this.sidecarsBeforeReinit = {
        wal: existsSync(`${this.observedPath}-wal`),
        shm: existsSync(`${this.observedPath}-shm`),
      };
    }
    await super.init();
    this.initialized = true;
  }
}

const openDatabases: TestDatabase[] = [];

const createDatabase = async (): Promise<TestDatabase> => {
  const directory = await mkdtemp(join(tmpdir(), "buildwarden-sqlite-wal-"));
  const path = join(directory, "state.sqlite");
  const database = new BuildWardenDatabase(path);
  await database.init();
  const entry = { database, directory, path };
  openDatabases.push(entry);
  return entry;
};

const readSetting = (path: string, key: string): string | undefined => {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    const row = reader.prepare("select value from app_settings where key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  } finally {
    reader.close();
  }
};

const waitForChildReady = (child: ReturnType<typeof spawn>): Promise<void> => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Timed out waiting for crash-recovery fixture")), 5_000);
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.stdout?.once("data", () => {
    clearTimeout(timeout);
    resolve();
  });
});

afterEach(async () => {
  for (const entry of openDatabases.splice(0)) {
    await entry.database.close();
    await rm(entry.directory, { recursive: true, force: true });
  }
});

describe("node:sqlite WAL persistence", () => {
  it("commits writes immediately and uses the configured WAL pragmas", async () => {
    const { database, path } = await createDatabase();
    database.setSetting("streaming", "visible");

    const connection = (database as unknown as { db: DatabaseSync }).db;
    const journalMode = connection.prepare("pragma journal_mode").get() as { journal_mode: string };
    const synchronous = connection.prepare("pragma synchronous").get() as { synchronous: number };
    const busyTimeout = connection.prepare("pragma busy_timeout").get() as { timeout: number };
    const autoCheckpoint = connection.prepare("pragma wal_autocheckpoint").get() as { wal_autocheckpoint: number };

    expect(journalMode.journal_mode).toBe("wal");
    expect(synchronous.synchronous).toBe(1);
    expect(busyTimeout.timeout).toBe(5_000);
    expect(autoCheckpoint.wal_autocheckpoint).toBe(1_000);
    expect(readSetting(path, "streaming")).toBe("visible");
  });

  it("restores the last selected run models and their settings after the application database is reopened", async () => {
    const entry = await createDatabase();
    const persistedDefaults = {
      "project-1": {
        ...buildDefaultProjectRunDefaults(),
        mode: "code",
        workspaceType: "worktree",
        modelId: "model-a",
        worktreeModelIds: ["model-a", "model-b"],
        modelConfigurations: {
          "model-a": { effort: "high", executionMode: "fast" },
          "model-b": { effort: "xhigh", executionMode: "auto" },
        },
        reasoningEffort: "high",
        anthropicEffort: "xhigh",
        executionMode: "fast",
        yoloMode: false,
      },
    };
    entry.database.setSetting(APP_SETTING_KEYS.projectRunDefaults, JSON.stringify(persistedDefaults));

    await entry.database.close();
    entry.database = new BuildWardenDatabase(entry.path);
    await entry.database.init();

    const restored = parseProjectRunDefaultsSetting(
      entry.database.getSnapshot().settings[APP_SETTING_KEYS.projectRunDefaults],
    );
    expect(restored).toEqual(persistedDefaults);
  });

  it("creates a pre-WAL backup only while converting an existing rollback-journal database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildwarden-sqlite-legacy-"));
    const path = join(directory, "state.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      create table projects (
        id text primary key,
        name text not null,
        repo_path text not null unique,
        default_branch text not null,
        cumulative_input_tokens integer not null default 0,
        cumulative_output_tokens integer not null default 0,
        created_at text not null,
        updated_at text not null,
        last_opened_at text
      );
      create table app_settings (
        key text primary key,
        value text not null,
        updated_at text not null
      );
      insert into app_settings (key, value, updated_at) values ('legacy', 'kept', '2026-01-01');
    `);
    legacy.close();

    const database = new BuildWardenDatabase(path);
    const entry = { database, directory, path };
    openDatabases.push(entry);
    await database.init();

    const backupPath = `${path}.pre-wal-backup`;
    const originalBackup = readFileSync(backupPath);
    expect(database.getSettings().legacy).toBe("kept");

    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      const columns = reader.prepare("pragma table_info(projects)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "project_kind")).toBe(true);
    } finally {
      reader.close();
    }

    database.setSetting("after-migration", "new");
    await database.close();
    await database.init();
    expect(readFileSync(backupPath).equals(originalBackup)).toBe(true);

    await database.close();
    unlinkSync(backupPath);
    await database.init();
    expect(existsSync(backupPath)).toBe(false);
    expect(database.getSettings()["after-migration"]).toBe("new");
  });

  it("rolls back failed transactions and checkpoints durable boundaries into the main file", async () => {
    const { database, directory, path } = await createDatabase();

    expect(() => database.transaction(() => {
      database.setSetting("rolled-back", "no");
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(database.getSettings()["rolled-back"]).toBeUndefined();

    database.setSetting("durable", "yes");
    await database.flushDurable();
    const checkpointCopy = join(directory, "checkpoint.sqlite");
    copyFileSync(path, checkpointCopy);
    expect(readSetting(checkpointCopy, "durable")).toBe("yes");

    database.setSetting("sync-checkpoint", "yes");
    database.flushToDiskSync();
    const syncCopy = join(directory, "sync-checkpoint.sqlite");
    copyFileSync(path, syncCopy);
    expect(readSetting(syncCopy, "sync-checkpoint")).toBe("yes");
  });

  it("deletes only the database WAL sidecars during reset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildwarden-sqlite-reset-"));
    const path = join(directory, "state.sqlite");
    const database = new ResetObservationDatabase(path);
    openDatabases.push({ database, directory, path });
    await database.init();
    database.setSetting("before-reset", "present");
    await database.close();

    const unrelatedPath = `${path}-notes`;
    writeFileSync(`${path}-wal`, "stale wal");
    writeFileSync(`${path}-shm`, "stale shm");
    writeFileSync(unrelatedPath, "keep me");

    await database.resetAndReinit();

    expect(database.getSettings()["before-reset"]).toBeUndefined();
    expect(database.sidecarsBeforeReinit).toEqual({ wal: false, shm: false });
    expect(existsSync(unrelatedPath)).toBe(true);
  });

  it("recovers a committed WAL transaction after an unclean writer exit", async () => {
    const { database, path } = await createDatabase();
    await database.close();

    const fixture = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("pragma journal_mode=WAL; pragma synchronous=NORMAL");
      db.prepare("insert into app_settings (key, value, updated_at) values (?, ?, ?)")
        .run("crash-recovery", "committed", new Date().toISOString());
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1_000);
    `;
    const child = spawn(process.execPath, ["-e", fixture, path], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForChildReady(child);
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    await database.init();
    expect(database.getSettings()["crash-recovery"]).toBe("committed");
  }, 10_000);
});
