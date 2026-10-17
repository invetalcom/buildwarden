import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";

const tempDirs: string[] = [];
const dbs: BuildWardenDatabase[] = [];

const makeDbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-restore-points-db-"));
  tempDirs.push(dir);
  return join(dir, "buildwarden.sqlite");
};

const openDb = async (filePath: string) => {
  const db = new BuildWardenDatabase(filePath);
  await db.init();
  dbs.push(db);
  return db;
};

const addRunFixture = (db: BuildWardenDatabase, repoPath = "C:\\repo") => {
  const project = db.addProject({ repoPath, baseBranch: "main", resolvedName: "Repo" });
  const provider = db.addProviderAccount({
    providerType: "ai-sdk",
    label: "AI SDK",
    apiBaseUrl: null,
    apiKeyRef: "",
    configJson: "{}",
  });
  const model = db.addModel({
    providerAccountId: provider.id,
    modelId: "claude-fable-5",
    displayName: "Fable",
    config: {},
    capabilities: {},
    enabled: true,
  });
  const run = db.createRun({
    projectId: project.id,
    providerAccountId: provider.id,
    modelId: model.id,
    harnessType: "ai-sdk",
    mode: "code",
    workspaceType: "worktree",
    prompt: "Implement",
    branchName: "main",
    worktreePath: "C:\\repo\\.buildwarden-worktrees\\run",
  });
  return { project, run };
};

const restorePoint = { createdAt: "2026-10-01T10:00:00.000Z", commandType: "follow-up" as const, patch: "diff --git a/x b/x\n" };

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("run prompt restore points", () => {
  it("stores restore points outside app settings and snapshots", async () => {
    const db = await openDb(makeDbPath());
    const { run } = addRunFixture(db);

    db.setRunPromptRestorePoint(run.id, restorePoint);
    db.setRunPromptRestorePoint(run.id, { ...restorePoint, commandType: "initial" });

    expect(db.getRunPromptRestorePoint(run.id)).toEqual({ ...restorePoint, commandType: "initial" });
    expect(Object.keys(db.getSettings()).some((key) => key.startsWith("runPromptRestorePoint:"))).toBe(false);
    expect(JSON.stringify(db.getSnapshot())).not.toContain(restorePoint.patch.trim());

    db.deleteRunPromptRestorePoint(run.id);
    expect(db.getRunPromptRestorePoint(run.id)).toBeNull();
  });

  it("moves legacy settings rows into the table and drops orphaned or malformed ones", async () => {
    const filePath = makeDbPath();
    const first = await openDb(filePath);
    const { run } = addRunFixture(first);
    const { run: untypedRun } = addRunFixture(first, "C:\\other-repo");
    first.setSetting(`runPromptRestorePoint:${run.id}`, JSON.stringify(restorePoint));
    first.setSetting("runPromptRestorePoint:deleted-run", JSON.stringify(restorePoint));
    first.setSetting("runPromptRestorePoint:broken", "{not json");
    first.setSetting(`runPromptRestorePoint:${untypedRun.id}`, JSON.stringify({ ...restorePoint, commandType: "unknown" }));
    await first.close();

    const reopened = await openDb(filePath);

    expect(reopened.getRunPromptRestorePoint(run.id)).toEqual(restorePoint);
    expect(reopened.getRunPromptRestorePoint("deleted-run")).toBeNull();
    expect(reopened.getRunPromptRestorePoint(untypedRun.id)).toBeNull();
    expect(Object.keys(reopened.getSettings()).filter((key) => key.startsWith("runPromptRestorePoint:"))).toEqual([]);
  });

  it("deletes restore points with their run or project", async () => {
    const db = await openDb(makeDbPath());
    const first = addRunFixture(db);
    const second = addRunFixture(db, "C:\\other-repo");
    db.setRunPromptRestorePoint(first.run.id, restorePoint);
    db.setRunPromptRestorePoint(second.run.id, restorePoint);

    db.deleteRun(first.run.id);
    db.deleteProject(second.project.id);

    expect(db.getRunPromptRestorePoint(first.run.id)).toBeNull();
    expect(db.getRunPromptRestorePoint(second.run.id)).toBeNull();
  });
});
