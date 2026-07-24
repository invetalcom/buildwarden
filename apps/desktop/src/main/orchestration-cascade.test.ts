import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { OrchestrationTeamSettings, SecretStore } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "./app-controller";
import type { AppControllerDesktopServices } from "./desktop-platform-services";
import { createFolderWorkspaceCopy } from "./folder-workspace";
import { HostEventBus } from "./host-events";
import { getOrchestrationArtifactRoot } from "./orchestration-workspace";

const temporaryDirectories: string[] = [];
const databases: BuildWardenDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("mandatory coordinator deletion cascade", () => {
  it("blocks direct child deletion, removes the complete owned closure, and preserves the original local project", async () => {
    const root = await mkdtemp(join(tmpdir(), "buildwarden-orchestration-cascade-"));
    temporaryDirectories.push(root);
    const originalProject = join(root, "original-project");
    const workspaceContainer = join(root, "managed");
    await mkdir(originalProject, { recursive: true });
    await writeFile(join(originalProject, "keep.txt"), "user project content");

    const db = new BuildWardenDatabase(join(root, "state", "buildwarden.sqlite"));
    await db.init();
    databases.push(db);
    const project = db.addProject({
      repoPath: originalProject,
      baseBranch: "",
      resolvedName: "Folder project",
      kind: "folder",
    });
    const provider = db.addProviderAccount({
      providerType: "claude-code",
      label: "Claude",
      apiBaseUrl: null,
      apiKeyRef: "",
      configJson: "{}",
    });
    const model = db.addModel({
      providerAccountId: provider.id,
      modelId: "sonnet",
      displayName: "Sonnet",
      config: {},
      capabilities: {},
      enabled: true,
    });
    const coordinator = db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: "claude-code",
      mode: "code",
      workspaceType: "local",
      workspaceVcs: "folder",
      prompt: "Coordinate changes",
      branchName: "folder",
      worktreePath: originalProject,
      delegationEnabled: true,
    });
    const childWorkspace = await createFolderWorkspaceCopy({
      sourcePath: originalProject,
      projectName: project.name,
      runId: "child-run",
      configuredWorkspaceRoot: workspaceContainer,
    });
    const child = db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: "claude-code",
      mode: "code",
      workspaceType: "copy",
      workspaceVcs: "folder",
      prompt: "Implement child work",
      branchName: childWorkspace.branchName,
      worktreePath: childWorkspace.worktreePath,
      kind: "orchestration-task",
      parentRunId: coordinator.id,
      rootRunId: coordinator.id,
      delegationEnabled: false,
    });
    const team: OrchestrationTeamSettings = {
      version: 1,
      maxConcurrentTasks: 3,
      maxTasksPerOrchestration: 12,
      models: [{ modelId: model.id, enabled: true, maxConcurrent: 2 }],
      roles: [{
        id: "implementer",
        name: "Implementer",
        description: "",
        eligibleModelIds: [model.id],
        preferredModelId: model.id,
        maxConcurrent: 2,
      }],
    };
    const orchestration = db.createOrchestration({
      projectId: project.id,
      coordinatorRunId: coordinator.id,
      teamSnapshot: team,
    });
    const artifactRoot = getOrchestrationArtifactRoot(db.getFilePath());
    const baseline = join(artifactRoot, orchestration.id, "waves", "wave-1", "baseline");
    const backup = join(artifactRoot, orchestration.id, "adoptions", "task-1", "backup");
    await mkdir(baseline, { recursive: true });
    await mkdir(backup, { recursive: true });
    await writeFile(join(baseline, "manifest.json"), "{}");
    await writeFile(join(backup, "manifest.json"), "{}");
    const wave = db.createOrchestrationWave(orchestration.id, baseline);
    const task = db.createOrchestrationTask({
      orchestrationId: orchestration.id,
      waveId: wave.id,
      clientTaskId: "child-task",
      title: "Child task",
      prompt: child.prompt,
      roleId: "implementer",
      modelId: model.id,
      intent: "implement",
      childRunId: child.id,
    });
    db.upsertOrchestrationAdoption({
      orchestrationId: orchestration.id,
      taskId: task.id,
      status: "adopted",
      backupPath: backup,
    });
    db.addBookmark(coordinator.id);
    db.addBookmark(child.id);

    const secrets: SecretStore = {
      readSecret: vi.fn(async () => null),
      saveSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
    };
    const desktop: AppControllerDesktopServices = {
      pickProjectDirectory: vi.fn(async () => null),
      pickIdeExecutable: vi.fn(async () => null),
      openPathInFileManager: vi.fn(async () => ({ ok: true })),
      openExternalUrl: vi.fn(async () => ({ ok: true })),
      launchIdeWithFolder: vi.fn(async () => undefined),
    };
    const terminal = { killForRunId: vi.fn() };
    const lifecycle = { onRunDeleted: vi.fn() };
    const controller = new AppController(db, secrets, join(root, "logs"), desktop, terminal, new HostEventBus(), lifecycle);

    await expect(controller.deleteRun(child.id)).rejects.toThrow("owned by an orchestration");
    const impact = await controller.getRunDeletionImpact(coordinator.id);
    expect(impact.runIds).toEqual(expect.arrayContaining([coordinator.id, child.id]));
    expect(impact.ownedDirectories).toContain(childWorkspace.worktreePath);
    await controller.deleteRun(coordinator.id);

    expect(existsSync(childWorkspace.worktreePath)).toBe(false);
    expect(existsSync(join(artifactRoot, orchestration.id))).toBe(false);
    expect(existsSync(originalProject)).toBe(true);
    await expect(readFile(join(originalProject, "keep.txt"), "utf8")).resolves.toBe("user project content");
    expect(() => db.getRun(child.id)).toThrow("not found");
    expect(() => db.getRun(coordinator.id)).toThrow("not found");
    expect(db.getOrchestrationByCoordinatorRunId(coordinator.id)).toBeNull();
    expect(db.listBookmarks()).toEqual([]);
    expect(db.listPendingOrchestrationCleanupJobs()).toEqual([]);
    expect(lifecycle.onRunDeleted).toHaveBeenCalledWith(child.id);
    expect(lifecycle.onRunDeleted).toHaveBeenCalledWith(coordinator.id);
  });
});
