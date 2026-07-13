import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";

const tempDirs: string[] = [];
const dbs: BuildWardenDatabase[] = [];

const makeDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-folder-project-db-"));
  tempDirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "buildwarden.sqlite"));
  await db.init();
  dbs.push(db);
  return db;
};

const addModelFixture = (db: BuildWardenDatabase) => {
  const provider = db.addProviderAccount({
    providerType: "codex-cli",
    label: "Codex",
    apiBaseUrl: null,
    apiKeyRef: "",
    configJson: "{}",
  });
  const model = db.addModel({
    providerAccountId: provider.id,
    modelId: "gpt-5.3-codex",
    displayName: "Codex",
    config: {},
    capabilities: {},
    enabled: true,
  });
  return { provider, model };
};

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("folder project persistence", () => {
  it("defaults legacy-shaped project and run inserts to Git capability", async () => {
    const db = await makeDb();
    const project = db.addProject({
      repoPath: "C:\\repo",
      baseBranch: "main",
      resolvedName: "Repo",
    });
    const { provider, model } = addModelFixture(db);

    const run = db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: "codex-app-server",
      mode: "code",
      workspaceType: "worktree",
      prompt: "Implement",
      branchName: "main",
      worktreePath: "C:\\repo\\.buildwarden-worktrees\\run",
    });

    expect(db.getProject(project.id).kind).toBe("git");
    expect(db.getRun(run.id).workspaceVcs).toBe("git");
  });

  it("updates the single persisted project base branch", async () => {
    const db = await makeDb();
    const project = db.addProject({
      repoPath: "C:\\repo-base",
      baseBranch: "main",
      resolvedName: "Repo",
    });

    expect(db.updateProjectBaseBranch(project.id, "release/next").baseBranch).toBe("release/next");
    expect(db.getProject(project.id).baseBranch).toBe("release/next");
  });

  it("persists folder projects and folder-capability runs", async () => {
    const db = await makeDb();
    const project = db.addProject({
      repoPath: "C:\\plain-folder",
      baseBranch: "",
      resolvedName: "Plain Folder",
      kind: "folder",
    });
    const { provider, model } = addModelFixture(db);

    const run = db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: "codex-app-server",
      mode: "code",
      workspaceType: "copy",
      workspaceVcs: "folder",
      prompt: "Implement",
      branchName: "folder-copy",
      worktreePath: "C:\\managed\\folder-copy",
    });

    expect(db.getProject(project.id)).toMatchObject({
      kind: "folder",
      baseBranch: "",
      repoPath: "C:\\plain-folder",
    });
    expect(db.getRun(run.id)).toMatchObject({
      workspaceType: "copy",
      workspaceVcs: "folder",
      branchName: "folder-copy",
    });
  });

  it("persists Kanban status and links tasks to agent runs and pull requests", async () => {
    const db = await makeDb();
    const project = db.addProject({
      repoPath: "C:\\repo",
      baseBranch: "main",
      resolvedName: "Repo",
    });
    const { provider, model } = addModelFixture(db);
    const task = db.createProjectTask(project.id, { title: "Ship Kanban", prompt: "Build the board" });

    expect(task).toMatchObject({ status: "open", runId: null, pullRequestUrl: null });

    const run = db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: "codex-app-server",
      mode: "code",
      workspaceType: "worktree",
      prompt: task.prompt,
      branchName: "feat/kanban",
      worktreePath: "C:\\repo\\.buildwarden-worktrees\\kanban",
      projectTaskId: task.id,
    });

    expect(run.projectTaskId).toBe(task.id);
    expect(db.linkProjectTaskToRun(task.id, run.id)).toMatchObject({ status: "in_progress", runId: run.id });
    expect(db.markProjectTaskInReview(task.id, "https://github.com/acme/repo/pull/42")).toMatchObject({
      status: "in_review",
      pullRequestUrl: "https://github.com/acme/repo/pull/42",
    });
    expect(db.updateProjectTask(task.id, { status: "done" }).status).toBe("done");
  });
});
