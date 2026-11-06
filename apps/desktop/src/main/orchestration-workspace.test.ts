import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "@buildwarden/git-service";
import {
  applyOrchestrationDelta,
  captureOrchestrationBaseline,
  previewOrchestrationDelta,
  removeOwnedOrchestrationArtifact,
  restoreOrchestrationBaseline,
  undoOrchestrationDelta,
} from "./orchestration-workspace";

const temporaryDirectories: string[] = [];

const makeWorkspace = async (name: string) => {
  const path = await mkdtemp(join(tmpdir(), `buildwarden-orchestration-${name}-`));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("orchestration workspace manifests and adoption", () => {
  it("adopts a complete add/modify/delete delta and can undo while adopted hashes still match", async () => {
    const coordinator = await makeWorkspace("coordinator");
    const child = await makeWorkspace("child");
    const artifacts = await makeWorkspace("artifacts");
    await mkdir(join(coordinator, "src"), { recursive: true });
    await mkdir(join(child, "src"), { recursive: true });
    await writeFile(join(coordinator, "src", "modify.txt"), "before");
    await writeFile(join(coordinator, "src", "delete.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(child, "src", "modify.txt"), "before");
    await writeFile(join(child, "src", "delete.bin"), Buffer.from([0, 1, 2, 3]));

    const baselinePath = await captureOrchestrationBaseline({
      workspacePath: coordinator,
      workspaceVcs: "folder",
      artifactRoot: artifacts,
      orchestrationId: "orchestration-1",
      waveId: "wave-1",
    });
    await writeFile(join(child, "src", "modify.txt"), "after");
    await rm(join(child, "src", "delete.bin"));
    await writeFile(join(child, "src", "added.bin"), Buffer.alloc(1024 * 1024, 7));

    await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator })).resolves.toEqual({
      changedFiles: ["src/added.bin", "src/delete.bin", "src/modify.txt"],
      conflicts: [],
      unsupportedPaths: [],
    });

    const backupPath = join(artifacts, "orchestration-1", "adoptions", "task-1", "backup");
    await applyOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator, backupPath });
    await expect(readFile(join(coordinator, "src", "modify.txt"), "utf8")).resolves.toBe("after");
    await expect(readFile(join(coordinator, "src", "added.bin"))).resolves.toHaveLength(1024 * 1024);

    await undoOrchestrationDelta({ backupPath, targetPath: coordinator });
    await expect(readFile(join(coordinator, "src", "modify.txt"), "utf8")).resolves.toBe("before");
    await expect(readFile(join(coordinator, "src", "delete.bin"))).resolves.toEqual(Buffer.from([0, 1, 2, 3]));
    await expect(readFile(join(coordinator, "src", "added.bin"))).rejects.toThrow();
  });

  it("blocks the whole adoption when the coordinator changed and blocks undo after a later edit", async () => {
    const coordinator = await makeWorkspace("conflict-coordinator");
    const child = await makeWorkspace("conflict-child");
    const artifacts = await makeWorkspace("conflict-artifacts");
    await writeFile(join(coordinator, "file.txt"), "baseline");
    await writeFile(join(child, "file.txt"), "baseline");
    const baselinePath = await captureOrchestrationBaseline({
      workspacePath: coordinator,
      workspaceVcs: "folder",
      artifactRoot: artifacts,
      orchestrationId: "orchestration-2",
      waveId: "wave-1",
    });
    await writeFile(join(child, "file.txt"), "child");
    await writeFile(join(coordinator, "file.txt"), "concurrent");
    const backupPath = join(artifacts, "orchestration-2", "backup");
    await expect(applyOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator, backupPath }))
      .rejects.toThrow("coordinator workspace changed");
    await expect(readFile(join(coordinator, "file.txt"), "utf8")).resolves.toBe("concurrent");

    await writeFile(join(coordinator, "file.txt"), "baseline");
    await applyOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator, backupPath });
    await writeFile(join(coordinator, "file.txt"), "edited-after-adoption");
    await expect(undoOrchestrationDelta({ backupPath, targetPath: coordinator }))
      .rejects.toThrow("changed after adoption");
  });

  it("gives a child cloned after the coordinator moved on only its own changes", async () => {
    const coordinator = await makeWorkspace("drift-coordinator");
    const child = await makeWorkspace("drift-child");
    const artifacts = await makeWorkspace("drift-artifacts");
    await writeFile(join(coordinator, "adopted.txt"), "baseline");
    await writeFile(join(coordinator, "removed.txt"), "baseline");
    await writeFile(join(coordinator, "own.txt"), "baseline");
    const baselinePath = await captureOrchestrationBaseline({
      workspacePath: coordinator,
      workspaceVcs: "folder",
      artifactRoot: artifacts,
      orchestrationId: "orchestration-3",
      waveId: "wave-1",
    });
    await writeFile(join(coordinator, "adopted.txt"), "adopted from a sibling");
    await writeFile(join(coordinator, "added.txt"), "added by a sibling");
    await rm(join(coordinator, "removed.txt"));
    await cp(coordinator, child, { recursive: true });

    await restoreOrchestrationBaseline({ baselinePath, workspacePath: child });
    await writeFile(join(child, "own.txt"), "child");

    await expect(readFile(join(child, "adopted.txt"), "utf8")).resolves.toBe("baseline");
    await expect(readFile(join(child, "removed.txt"), "utf8")).resolves.toBe("baseline");
    await expect(readFile(join(child, "added.txt"))).rejects.toThrow();
    await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator })).resolves.toEqual({
      changedFiles: ["own.txt"],
      conflicts: [],
      unsupportedPaths: [],
    });
  });

  describe("links", () => {
    const linkedWorkspaces = async (name: string) => {
      const coordinator = await makeWorkspace(`${name}-coordinator`);
      const child = await makeWorkspace(`${name}-child`);
      const artifacts = await makeWorkspace(`${name}-artifacts`);
      for (const root of [coordinator, child]) {
        await mkdir(join(root, "real"));
        await mkdir(join(root, "other"));
        await writeFile(join(root, "file.txt"), "baseline");
        await symlink(join(root, "real"), join(root, "link"), "junction");
      }
      const baselinePath = await captureOrchestrationBaseline({
        workspacePath: coordinator,
        workspaceVcs: "folder",
        artifactRoot: artifacts,
        orchestrationId: name,
        waveId: "wave-1",
      });
      return { coordinator, child, artifacts, baselinePath };
    };

    it("adopts other changes when a link is untouched", async () => {
      const { coordinator, child, artifacts, baselinePath } = await linkedWorkspaces("untouched");
      await writeFile(join(child, "file.txt"), "child");

      await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator })).resolves.toEqual({
        changedFiles: ["file.txt"],
        conflicts: [],
        unsupportedPaths: [],
      });
      await applyOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator, backupPath: join(artifacts, "backup") });

      await expect(readFile(join(coordinator, "file.txt"), "utf8")).resolves.toBe("child");
    });

    it("blocks adoption when the child retargets a link", async () => {
      const { coordinator, child, artifacts, baselinePath } = await linkedWorkspaces("retargeted");
      await rm(join(child, "link"), { recursive: true });
      await symlink(join(child, "other"), join(child, "link"), "junction");

      await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator }))
        .resolves.toMatchObject({ unsupportedPaths: ["link"] });
      await expect(applyOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator, backupPath: join(artifacts, "backup") }))
        .rejects.toThrow("Symlink adoption is unsupported: link");
    });

    it("blocks adoption when the child adds or removes a link", async () => {
      const { coordinator, child, baselinePath } = await linkedWorkspaces("added-removed");
      await rm(join(child, "link"), { recursive: true });
      await symlink(join(child, "other"), join(child, "new-link"), "junction");

      await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator }))
        .resolves.toMatchObject({ unsupportedPaths: ["link", "new-link"] });
    });

    it("treats a surviving link as unchanged in a baseline without recorded targets", async () => {
      const { coordinator, child, baselinePath } = await linkedWorkspaces("legacy");
      const manifestPath = join(baselinePath, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      delete manifest.links;
      await writeFile(manifestPath, JSON.stringify(manifest));

      await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator }))
        .resolves.toMatchObject({ unsupportedPaths: [] });
    });
  });

  describe("git workspaces", () => {
    const gitWorkspace = async (name: string) => {
      const root = await makeWorkspace(name);
      const artifacts = await makeWorkspace(`${name}-artifacts`);
      const repoPath = join(root, "repo");
      await mkdir(join(repoPath, "folder"), { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
      git("init", "--initial-branch=main");
      git("config", "user.name", "BuildWarden Test");
      git("config", "user.email", "buildwarden@example.test");
      git("config", "core.autocrlf", "false");
      await writeFile(join(repoPath, "tracked.txt"), "baseline");
      await writeFile(join(repoPath, "folder", "nested.txt"), "baseline");
      git("add", ".");
      git("commit", "-m", "Base commit");
      const service = new GitService();
      const createChild = async () =>
        (await service.createWorktreeForRun(repoPath, "Project", "child", "main", join(root, "worktrees"))).worktreePath;
      const capture = () => captureOrchestrationBaseline({
        workspacePath: repoPath,
        workspaceVcs: "git",
        artifactRoot: artifacts,
        orchestrationId: name,
        waveId: "wave-1",
      });
      return { repoPath, artifacts, service, createChild, capture };
    };

    it("restores a tracked file the coordinator deleted after the baseline", async () => {
      const { repoPath, service, createChild, capture } = await gitWorkspace("git-restore");
      const baselinePath = await capture();
      await rm(join(repoPath, "tracked.txt"));
      const child = await createChild();
      await service.cloneWorkspaceChanges(repoPath, child);

      await restoreOrchestrationBaseline({ baselinePath, workspacePath: child });

      await expect(readFile(join(child, "tracked.txt"), "utf8")).resolves.toBe("baseline");
    });

    it("adopts a child's deletion of a tracked file", async () => {
      const { repoPath, artifacts, createChild, capture } = await gitWorkspace("git-delete");
      const baselinePath = await capture();
      const child = await createChild();
      await rm(join(child, "tracked.txt"));

      await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: repoPath })).resolves.toEqual({
        changedFiles: ["tracked.txt"],
        conflicts: [],
        unsupportedPaths: [],
      });
      await applyOrchestrationDelta({ baselinePath, childPath: child, targetPath: repoPath, backupPath: join(artifacts, "backup") });

      await expect(readFile(join(repoPath, "tracked.txt"))).rejects.toThrow();
    });

    it("sees a tracked folder a child replaced with a file", async () => {
      const { repoPath, createChild, capture } = await gitWorkspace("git-replaced");
      const baselinePath = await capture();
      const child = await createChild();
      await rm(join(child, "folder"), { recursive: true });
      await writeFile(join(child, "folder"), "now a file");

      await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: repoPath })).resolves.toMatchObject({
        changedFiles: ["folder", "folder/nested.txt"],
      });
    });

    it("captures a baseline while a tracked file is deleted", async () => {
      const { repoPath, createChild, capture } = await gitWorkspace("git-capture");
      await rm(join(repoPath, "tracked.txt"));
      const baselinePath = await capture();
      const child = await createChild();
      await rm(join(child, "tracked.txt"));

      await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: repoPath })).resolves.toMatchObject({
        changedFiles: [],
      });
    });
  });

  it("refuses to recursively remove the artifact root or an unrelated directory", async () => {
    const artifacts = await makeWorkspace("owned-root");
    const unrelated = await makeWorkspace("unrelated");
    await expect(removeOwnedOrchestrationArtifact(artifacts, artifacts)).rejects.toThrow("unowned");
    await expect(removeOwnedOrchestrationArtifact(artifacts, unrelated)).rejects.toThrow("unowned");
  });
});
