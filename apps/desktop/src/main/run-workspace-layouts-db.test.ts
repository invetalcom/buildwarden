import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, parseRunWorkspaceLayoutsSetting, type RunWorkspaceLayoutPreference } from "@buildwarden/shared";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const databases: BuildWardenDatabase[] = [];

const openDatabase = async (path: string): Promise<BuildWardenDatabase> => {
  const database = new BuildWardenDatabase(path);
  await database.init();
  databases.push(database);
  return database;
};

const makeDatabasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-run-layouts-"));
  tempDirs.push(directory);
  return join(directory, "buildwarden.sqlite");
};

afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const seedRuns = (db: BuildWardenDatabase, count: number): string[] => {
  const project = db.addProject({ repoPath: "C:\\layout-repo", baseBranch: "main", resolvedName: "Layout Repo" });
  const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "AI SDK", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "model", displayName: "Model", config: {}, capabilities: {} });
  return Array.from({ length: count }, (_, index) => db.createRun({
    projectId: project.id,
    providerAccountId: provider.id,
    modelId: model.id,
    harnessType: "ai-sdk",
    mode: "code",
    workspaceType: "local",
    prompt: `run ${String(index)}`,
    branchName: `run-${String(index)}`,
    worktreePath: project.repoPath,
  }).id);
};

const layout = (diff: boolean): RunWorkspaceLayoutPreference => {
  const [parsed] = Object.values(parseRunWorkspaceLayoutsSetting(JSON.stringify({
    run: {
      visiblePanels: { activity: true, diff },
      tileOrder: ["activity", "diff"],
      tileLayout: { activity: { colSpan: 7, rowSpan: 4 } },
      secondaryPanelPosition: "bottom",
    },
  })));
  if (!parsed) throw new Error("Test layout did not parse.");
  return parsed;
};

describe("run workspace layouts", () => {
  it("moves the former settings value into per-run rows and drops deleted runs", async () => {
    const path = makeDatabasePath();
    const first = await openDatabase(path);
    const [kept, other] = seedRuns(first, 2);
    first.setSetting(APP_SETTING_KEYS.runWorkspaceLayouts, JSON.stringify({
      [kept!]: layout(true),
      [other!]: layout(false),
      "deleted-run": layout(true),
      [`${kept!}-invalid`]: { visiblePanels: "nope" },
    }));
    await first.close();
    databases.splice(databases.indexOf(first), 1);

    const reopened = await openDatabase(path);

    expect(reopened.listRunWorkspaceLayouts()).toEqual({ [kept!]: layout(true), [other!]: layout(false) });
    expect(reopened.getSettings()[APP_SETTING_KEYS.runWorkspaceLayouts]).toBeUndefined();
    expect(reopened.getSnapshot().settings[APP_SETTING_KEYS.runWorkspaceLayouts]).toBeUndefined();
  });

  it("saves, replaces and removes one run's layout, and removes it with its run", async () => {
    const db = await openDatabase(makeDatabasePath());
    const [first, second] = seedRuns(db, 2);

    db.setRunWorkspaceLayout(first!, layout(false));
    db.setRunWorkspaceLayout(first!, layout(true));
    db.setRunWorkspaceLayout(second!, layout(false));
    db.setRunWorkspaceLayout("missing-run", layout(true));
    expect(db.listRunWorkspaceLayouts()).toEqual({ [first!]: layout(true), [second!]: layout(false) });

    db.setRunWorkspaceLayout(second!, null);
    expect(Object.keys(db.listRunWorkspaceLayouts())).toEqual([first]);

    db.deleteRun(first!);
    expect(db.listRunWorkspaceLayouts()).toEqual({});
  });
});
