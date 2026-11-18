import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const databases: BuildWardenDatabase[] = [];

const makeDatabase = async (): Promise<BuildWardenDatabase> => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-automation-db-"));
  tempDirs.push(directory);
  const database = new BuildWardenDatabase(join(directory, "buildwarden.sqlite"));
  await database.init();
  databases.push(database);
  return database;
};

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const seed = (db: BuildWardenDatabase) => {
  const project = db.addProject({ repoPath: "C:\\automation-repo", baseBranch: "main", resolvedName: "Automation Repo" });
  const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "AI SDK", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "model", displayName: "Model", config: {}, capabilities: {} });
  return { project, model };
};

describe("project automation schedule persistence", () => {
  it("defaults existing and new automations to repeating schedules", async () => {
    const db = await makeDatabase();
    const { project, model } = seed(db);
    const automation = db.createProjectAutomation(project.id, {
      name: "Daily", prompt: "Review", cronExpression: "0 9 * * *", modelId: model.id, workspaceType: "worktree",
    }, "2026-08-20T09:00:00.000Z", "UTC");

    expect(automation.scheduleKind).toBe("cron");
    expect(db.listProjectAutomations(project.id)[0]?.scheduleKind).toBe("cron");
  });

  it("stores a one-time start, disables it when fired, and clears the consumed occurrence on reschedule", async () => {
    const db = await makeDatabase();
    const { project, model } = seed(db);
    const created = db.createProjectAutomation(project.id, {
      name: "Once", prompt: "Audit", scheduleKind: "once", cronExpression: "", modelId: model.id, workspaceType: "worktree",
    }, "2026-11-20T08:00:00.000Z", "Europe/Vienna");
    expect(created).toMatchObject({ scheduleKind: "once", cronExpression: "", nextRunAt: "2026-11-20T08:00:00.000Z", enabled: 1, lastScheduledAt: null });

    db.markProjectAutomationFired(created.id, created.nextRunAt);
    const fired = db.getProjectAutomation(created.id);
    expect(fired).toMatchObject({ enabled: 0, lastScheduledAt: "2026-11-20T08:00:00.000Z", nextRunAt: "2026-11-20T08:00:00.000Z" });

    const renamed = db.updateProjectAutomation(created.id, { name: "Renamed" });
    expect(renamed).toMatchObject({ name: "Renamed", lastScheduledAt: "2026-11-20T08:00:00.000Z" });

    const rescheduled = db.updateProjectAutomation(created.id, { enabled: true }, "2026-11-27T08:00:00.000Z");
    expect(rescheduled).toMatchObject({ enabled: 1, lastScheduledAt: null, nextRunAt: "2026-11-27T08:00:00.000Z", scheduleKind: "once" });
  });
});
