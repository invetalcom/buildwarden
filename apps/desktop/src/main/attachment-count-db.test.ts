import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { ChatAttachmentPayload } from "@buildwarden/shared";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const databases: BuildWardenDatabase[] = [];

const makeDatabase = async (): Promise<BuildWardenDatabase> => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-attachment-count-"));
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
  const project = db.addProject({ repoPath: "C:\\count-repo", baseBranch: "main", resolvedName: "Count Repo" });
  const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "AI SDK", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "model", displayName: "Model", config: {}, capabilities: {} });
  return { project, model };
};

const file = (name: string): ChatAttachmentPayload => ({ fileName: name, mimeType: "text/plain", dataBase64: Buffer.from(name).toString("base64") });

const rawUpdate = (db: BuildWardenDatabase, sql: string) => {
  const raw = new DatabaseSync(db.getFilePath());
  try {
    raw.exec(sql);
  } finally {
    raw.close();
  }
};

describe("attachment counts", () => {
  it("follows a task's attachments as they are created and replaced", async () => {
    const db = await makeDatabase();
    const { project } = seed(db);
    const task = db.createProjectTask(project.id, { title: "Task", prompt: "Do it", attachments: [file("a"), file("b")] });
    expect(db.listProjectTaskSummaries(project.id)[0]?.attachmentCount).toBe(2);

    db.updateProjectTask(task.id, { attachments: [file("c")] });
    expect(db.listProjectTaskSummaries(project.id)[0]?.attachmentCount).toBe(1);
    db.updateProjectTask(task.id, { title: "Renamed" });
    expect(db.listProjectTaskSummaries(project.id)[0]?.attachmentCount).toBe(1);
  });

  it("lists automations with their count and without their files", async () => {
    const db = await makeDatabase();
    const { project, model } = seed(db);
    const automation = db.createProjectAutomation(project.id, {
      name: "Daily", prompt: "Review", cronExpression: "0 9 * * *", modelId: model.id, workspaceType: "worktree",
      attachments: [file("a"), file("b"), file("c")], executionOptions: { reasoningEffort: "high" },
    }, "2026-08-20T09:00:00.000Z", "UTC");

    const [item] = db.listProjectAutomationItems(project.id, []);
    const { attachments, ...expected } = db.getProjectAutomation(automation.id);
    expect(attachments).toHaveLength(3);
    expect(item?.automation).toEqual({ ...expected, attachmentCount: 3 });
    expect(item?.automation).not.toHaveProperty("attachments");

    db.updateProjectAutomation(automation.id, { attachments: [] });
    expect(db.listProjectAutomationItems(project.id, [])[0]?.automation.attachmentCount).toBe(0);
  });

  it("counts rows written before the column existed, and treats unreadable JSON as none", async () => {
    const db = await makeDatabase();
    const { project } = seed(db);
    db.createProjectTask(project.id, { title: "Old", prompt: "Old task", attachments: [file("a"), file("b")] });
    const broken = db.createProjectTask(project.id, { title: "Broken", prompt: "Broken task" });
    rawUpdate(db, `update project_tasks set attachments_json = 'not json' where id = '${broken.id}'`);
    rawUpdate(db, "update project_tasks set attachment_count = null");
    await db.close();
    await db.init();

    const counts = Object.fromEntries(db.listProjectTaskSummaries(project.id).map((task) => [task.title, task.attachmentCount]));
    expect(counts).toEqual({ Old: 2, Broken: 0 });
  });
});
