import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const databases: BuildWardenDatabase[] = [];

const makeDatabase = async (): Promise<BuildWardenDatabase> => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-run-sections-"));
  tempDirs.push(directory);
  const database = new BuildWardenDatabase(join(directory, "buildwarden.sqlite"));
  await database.init();
  databases.push(database);
  return database;
};

afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const createRun = (db: BuildWardenDatabase, projectId: string, providerAccountId: string, modelId: string, prompt: string) =>
  db.createRun({
    projectId,
    providerAccountId,
    modelId,
    harnessType: "ai-sdk",
    mode: "code",
    workspaceType: "worktree",
    prompt,
    branchName: `run/${prompt}`,
    worktreePath: `C:\\worktrees\\${prompt}`,
  });

describe("run sidebar sections", () => {
  it("assigns runs to sections without touching updatedAt and clears deleted sections", async () => {
    const db = await makeDatabase();
    const project = db.addProject({ repoPath: "C:\\section-repo", baseBranch: "main", resolvedName: "Section Repo" });
    const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "AI SDK", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
    const model = db.addModel({ providerAccountId: provider.id, modelId: "model", displayName: "Model", config: {}, capabilities: {} });
    const first = createRun(db, project.id, provider.id, model.id, "first");
    const second = createRun(db, project.id, provider.id, model.id, "second");

    expect(db.getRun(first.id).sidebarSectionId).toBeNull();

    const moved = db.updateRunSidebarSection(first.id, "release");
    expect(moved.sidebarSectionId).toBe("release");
    expect(moved.updatedAt).toBe(first.updatedAt);
    db.updateRunSidebarSection(second.id, "perf");
    expect(db.getSnapshot().projects[0]?.runs.map((run) => run.sidebarSectionId).sort()).toEqual(["perf", "release"]);

    db.clearRunSidebarSectionsExcept(["perf"]);
    expect(db.getRun(first.id).sidebarSectionId).toBeNull();
    expect(db.getRun(second.id).sidebarSectionId).toBe("perf");

    db.clearRunSidebarSectionsExcept([]);
    expect(db.getRun(second.id).sidebarSectionId).toBeNull();
    expect(() => db.updateRunSidebarSection("missing", null)).toThrow("Run not found");
  });
});
