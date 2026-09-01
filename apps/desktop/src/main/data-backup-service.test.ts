import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingDataRestore, DataBackupService, writePendingDataRestore } from "./data-backup-service";

const temporaryDirectories: string[] = [];

const createFixture = async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "buildwarden-backup-test-"));
  temporaryDirectories.push(dataDirectory);
  const database = new BuildWardenDatabase(join(dataDirectory, "buildwarden.sqlite"));
  await database.init();
  database.setSetting("portable-setting", "kept");
  const secrets = {
    "provider:test": "api-key-value",
    "project:forge-token:project-1": "github-token-value",
  };
  const secretStore = {
    exportSecrets: async () => ({ ...secrets }),
    writeEncryptedCopy: async (targetFilePath: string, values: Readonly<Record<string, string>>) => {
      await writeFile(targetFilePath, JSON.stringify(values), "utf8");
    },
  };
  const service = new DataBackupService({
    database,
    secretStore,
    dataDirectory,
    appVersion: "test-version",
  });
  return { dataDirectory, database, secrets, service };
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("DataBackupService", () => {
  it("rebases managed artifact paths when data is restored on another machine", async () => {
    const fixture = await createFixture();
    const wave = fixture.database.createOrchestrationWave(
      "orchestration-1",
      "/source/buildwarden/data/orchestrations/orchestration-1/baseline",
    );

    fixture.database.rebaseManagedArtifactPaths("/source/buildwarden/data", fixture.dataDirectory);

    expect(fixture.database.getOrchestrationWave(wave.id).baselinePath)
      .toBe(join(fixture.dataDirectory, "orchestrations", "orchestration-1", "baseline"));
    await fixture.database.close();
  });

  it("round-trips database state, secrets, and managed artifacts through an encrypted backup", async () => {
    const fixture = await createFixture();
    const artifactDirectory = join(fixture.dataDirectory, "loop-ui-reviews", "review-1");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(join(artifactDirectory, "preview.png"), Buffer.from([1, 2, 3, 4]));
    const backupPath = join(fixture.dataDirectory, "portable.bwarden");

    const exported = await fixture.service.exportTo(backupPath, "correct horse battery staple");
    expect(exported.canceled).toBe(false);
    expect(existsSync(backupPath)).toBe(true);
    expect((await fixture.service.inspect(backupPath)).appVersion).toBe("test-version");

    const staged = await fixture.service.stageImport(backupPath, "correct horse battery staple");
    const restoredDatabase = new BuildWardenDatabase(join(staged.stagingDirectory, "database.sqlite"));
    await restoredDatabase.init();
    expect(restoredDatabase.getSettings()["portable-setting"]).toBe("kept");
    await restoredDatabase.close();
    expect(JSON.parse(await readFile(join(staged.stagingDirectory, "restored-secrets.json"), "utf8"))).toEqual(fixture.secrets);
    expect(await readFile(join(staged.stagingDirectory, "artifacts", "loop-ui-reviews", "review-1", "preview.png")))
      .toEqual(Buffer.from([1, 2, 3, 4]));

    await fixture.database.close();
  });

  it("rejects an incorrect password without leaving staged plaintext data", async () => {
    const fixture = await createFixture();
    const backupPath = join(fixture.dataDirectory, "portable.bwarden");
    await fixture.service.exportTo(backupPath, "correct horse battery staple");

    await expect(fixture.service.stageImport(backupPath, "incorrect password"))
      .rejects.toThrow(/password is incorrect|damaged/i);
    expect((await readdir(fixture.dataDirectory)).some((name) => name.startsWith("restore-staging-"))).toBe(false);

    await fixture.database.close();
  });

  it("marks welcome setup complete when restoring from the first-run dialog", async () => {
    const fixture = await createFixture();
    const backupPath = join(fixture.dataDirectory, "portable.bwarden");
    await fixture.service.exportTo(backupPath, "correct horse battery staple");

    const staged = await fixture.service.stageImport(
      backupPath,
      "correct horse battery staple",
      { skipWelcome: true },
    );
    const restoredDatabase = new BuildWardenDatabase(join(staged.stagingDirectory, "database.sqlite"));
    await restoredDatabase.init();
    expect(JSON.parse(restoredDatabase.getSettings()["welcomeCompletedCheckIds"] ?? "[]"))
      .toEqual(["project", "provider-models"]);
    await restoredDatabase.close();
    await fixture.database.close();
  });

  it("applies a staged restore on startup and retains the previous data as a rollback", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "buildwarden-restore-test-"));
    temporaryDirectories.push(dataDirectory);
    const stagingDirectory = join(dataDirectory, "restore-staging-test");
    await mkdir(join(stagingDirectory, "artifacts", "loop-ui-reviews"), { recursive: true });
    await writeFile(join(dataDirectory, "active.sqlite"), "old-database");
    await writeFile(join(dataDirectory, "active-secrets.json"), "old-secrets");
    await mkdir(join(dataDirectory, "loop-ui-reviews"), { recursive: true });
    await writeFile(join(dataDirectory, "loop-ui-reviews", "old.png"), "old-image");
    await writeFile(join(stagingDirectory, "database.sqlite"), "new-database");
    await writeFile(join(stagingDirectory, "restored-secrets.json"), "new-secrets");
    await writeFile(join(stagingDirectory, "artifacts", "loop-ui-reviews", "new.png"), "new-image");
    const markerPath = join(dataDirectory, "pending-restore.json");
    await writePendingDataRestore(markerPath, stagingDirectory);

    await expect(applyPendingDataRestore({
      markerPath,
      dataDirectory,
      databaseFileName: "active.sqlite",
      secretsFileName: "active-secrets.json",
    })).resolves.toBe(true);

    expect(await readFile(join(dataDirectory, "active.sqlite"), "utf8")).toBe("new-database");
    expect(await readFile(join(dataDirectory, "active-secrets.json"), "utf8")).toBe("new-secrets");
    expect(await readFile(join(dataDirectory, "loop-ui-reviews", "new.png"), "utf8")).toBe("new-image");
    const rollbackName = (await readdir(dataDirectory)).find((name) => name.startsWith("restore-rollback-"));
    expect(rollbackName).toBeTruthy();
    expect(await readFile(join(dataDirectory, rollbackName!, "active.sqlite"), "utf8")).toBe("old-database");
    expect(await readFile(join(dataDirectory, rollbackName!, "active-secrets.json"), "utf8")).toBe("old-secrets");
    expect(await readFile(join(dataDirectory, rollbackName!, "loop-ui-reviews", "old.png"), "utf8")).toBe("old-image");
    expect(existsSync(markerPath)).toBe(false);
  });
});
