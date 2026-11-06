import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
      autoMerged: [],
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
      autoMerged: [],
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
        autoMerged: [],
        unsupportedPaths: [],
      });
      await applyOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator, backupPath: join(artifacts, "backup") });

      await expect(readFile(join(coordinator, "file.txt"), "utf8")).resolves.toBe("child");
    });

    it("adopts other changes when a copied link still points into the coordinator", async () => {
      const { coordinator, child, artifacts, baselinePath } = await linkedWorkspaces("copied");
      await rm(join(child, "link"), { recursive: true });
      await symlink(join(coordinator, "real"), join(child, "link"), "junction");
      await writeFile(join(child, "file.txt"), "child");
      const linkBefore = await readlink(join(coordinator, "link"));

      await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator })).resolves.toEqual({
        changedFiles: ["file.txt"],
        conflicts: [],
        autoMerged: [],
        unsupportedPaths: [],
      });
      await applyOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator, backupPath: join(artifacts, "backup") });

      await expect(readFile(join(coordinator, "file.txt"), "utf8")).resolves.toBe("child");
      await expect(readlink(join(coordinator, "link"))).resolves.toBe(linkBefore);
    });

    it("blocks adoption when a child retargets a link elsewhere in the coordinator", async () => {
      const { coordinator, child, baselinePath } = await linkedWorkspaces("copied-retargeted");
      await rm(join(child, "link"), { recursive: true });
      await symlink(join(coordinator, "other"), join(child, "link"), "junction");

      await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator }))
        .resolves.toMatchObject({ unsupportedPaths: ["link"] });
    });

    it("treats an unchanged link outside the workspace as unchanged", async () => {
      const outside = await makeWorkspace("outside");
      const { coordinator, child, artifacts } = await linkedWorkspaces("outside-link");
      for (const root of [coordinator, child]) {
        await rm(join(root, "link"), { recursive: true });
        await symlink(outside, join(root, "link"), "junction");
      }
      const baselinePath = await captureOrchestrationBaseline({
        workspacePath: coordinator,
        workspaceVcs: "folder",
        artifactRoot: artifacts,
        orchestrationId: "outside-link",
        waveId: "wave-2",
      });

      await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator }))
        .resolves.toMatchObject({ unsupportedPaths: [] });
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
        autoMerged: [],
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

describe("adopting changes the coordinator also touched", () => {
  const LINES = ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n");

  const setup = async () => {
    const coordinator = await makeWorkspace("coordinator");
    const child = await makeWorkspace("child");
    const artifacts = await makeWorkspace("artifacts");
    await writeFile(join(coordinator, "shared.txt"), `${LINES}\n`);
    await writeFile(join(child, "shared.txt"), `${LINES}\n`);
    const baselinePath = await captureOrchestrationBaseline({
      workspacePath: coordinator, workspaceVcs: "folder", artifactRoot: artifacts, orchestrationId: "orchestration-1", waveId: "wave-1",
    });
    const paths = { baselinePath, childPath: child, targetPath: coordinator };
    return { coordinator, child, artifacts, paths, backupPath: join(artifacts, "backup") };
  };

  it("merges edits that do not overlap, and undo restores the coordinator's own version", async () => {
    const { coordinator, child, paths, backupPath } = await setup();
    const coordinatorEdit = `${LINES.replace("one", "ONE")}\n`;
    await writeFile(join(coordinator, "shared.txt"), coordinatorEdit);
    await writeFile(join(child, "shared.txt"), `${LINES.replace("eight", "EIGHT")}\n`);

    await expect(previewOrchestrationDelta(paths)).resolves.toMatchObject({ conflicts: [], autoMerged: ["shared.txt"] });
    await applyOrchestrationDelta({ ...paths, backupPath });

    await expect(readFile(join(coordinator, "shared.txt"), "utf8")).resolves.toBe(`${LINES.replace("one", "ONE").replace("eight", "EIGHT")}\n`);

    await undoOrchestrationDelta({ backupPath, targetPath: coordinator });
    await expect(readFile(join(coordinator, "shared.txt"), "utf8")).resolves.toBe(coordinatorEdit);
  });

  it("still blocks edits that overlap and leaves the file alone", async () => {
    const { coordinator, child, paths, backupPath } = await setup();
    const coordinatorEdit = `${LINES.replace("four", "COORDINATOR")}\n`;
    await writeFile(join(coordinator, "shared.txt"), coordinatorEdit);
    await writeFile(join(child, "shared.txt"), `${LINES.replace("four", "CHILD")}\n`);

    await expect(previewOrchestrationDelta(paths)).resolves.toMatchObject({ conflicts: ["shared.txt"], autoMerged: [] });
    await expect(applyOrchestrationDelta({ ...paths, backupPath })).rejects.toThrow("changed since delegation");

    await expect(readFile(join(coordinator, "shared.txt"), "utf8")).resolves.toBe(coordinatorEdit);
  });

  it("says so when the merge itself could not run", async () => {
    const { coordinator, child, paths } = await setup();
    await writeFile(join(coordinator, "shared.txt"), `${LINES.replace("one", "ONE")}\n`);
    await writeFile(join(child, "shared.txt"), `${LINES.replace("eight", "EIGHT")}\n`);
    const searchPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(previewOrchestrationDelta(paths)).resolves.toMatchObject({
        conflicts: ["shared.txt (could not merge: git was not found)"],
        autoMerged: [],
      });
    } finally {
      process.env.PATH = searchPath;
    }
  });

  it("does not merge binary files", async () => {
    const coordinator = await makeWorkspace("coordinator");
    const child = await makeWorkspace("child");
    const artifacts = await makeWorkspace("artifacts");
    await writeFile(join(coordinator, "data.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(child, "data.bin"), Buffer.from([0, 1, 2, 3]));
    const baselinePath = await captureOrchestrationBaseline({
      workspacePath: coordinator, workspaceVcs: "folder", artifactRoot: artifacts, orchestrationId: "orchestration-1", waveId: "wave-1",
    });
    await writeFile(join(coordinator, "data.bin"), Buffer.from([0, 9, 2, 3]));
    await writeFile(join(child, "data.bin"), Buffer.from([0, 1, 2, 8]));

    await expect(previewOrchestrationDelta({ baselinePath, childPath: child, targetPath: coordinator }))
      .resolves.toMatchObject({ conflicts: ["data.bin"], autoMerged: [] });
  });

  it("treats the same change on both sides as already applied, so undo keeps it", async () => {
    const { coordinator, child, paths, backupPath } = await setup();
    const same = `${LINES.replace("two", "TWO")}\n`;
    await writeFile(join(coordinator, "shared.txt"), same);
    await writeFile(join(child, "shared.txt"), same);
    await writeFile(join(child, "new.txt"), "from the child");

    await expect(previewOrchestrationDelta(paths)).resolves.toMatchObject({ conflicts: [], autoMerged: [] });
    await applyOrchestrationDelta({ ...paths, backupPath });
    await undoOrchestrationDelta({ backupPath, targetPath: coordinator });

    await expect(readFile(join(coordinator, "shared.txt"), "utf8")).resolves.toBe(same);
    await expect(readFile(join(coordinator, "new.txt"), "utf8")).rejects.toThrow();
  });

  it("does not guess when both sides added the same path differently", async () => {
    const { coordinator, child, paths } = await setup();
    await writeFile(join(coordinator, "added.txt"), "coordinator");
    await writeFile(join(child, "added.txt"), "child");

    await expect(previewOrchestrationDelta(paths)).resolves.toMatchObject({ conflicts: ["added.txt"] });
  });
});

describe("baseline storage", () => {
  const countFiles = async (path: string): Promise<number> => {
    const entries = await readdir(path, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  };

  it("stores each distinct file once across waves", async () => {
    const coordinator = await makeWorkspace("coordinator");
    const artifacts = await makeWorkspace("artifacts");
    await writeFile(join(coordinator, "same.txt"), "unchanged");
    await writeFile(join(coordinator, "copy.txt"), "unchanged");
    await writeFile(join(coordinator, "moving.txt"), "wave 1");
    const capture = (waveId: string) => captureOrchestrationBaseline({
      workspacePath: coordinator, workspaceVcs: "folder", artifactRoot: artifacts, orchestrationId: "orchestration-1", waveId,
    });

    await capture("wave-1");
    await writeFile(join(coordinator, "moving.txt"), "wave 2");
    await capture("wave-2");

    await expect(countFiles(join(artifacts, "orchestration-1", "blobs"))).resolves.toBe(3);
  });

  it("restores a child from the shared store", async () => {
    const coordinator = await makeWorkspace("coordinator");
    const child = await makeWorkspace("child");
    const artifacts = await makeWorkspace("artifacts");
    await writeFile(join(coordinator, "file.txt"), "baseline");
    const baselinePath = await captureOrchestrationBaseline({
      workspacePath: coordinator, workspaceVcs: "folder", artifactRoot: artifacts, orchestrationId: "orchestration-1", waveId: "wave-1",
    });
    await writeFile(join(child, "file.txt"), "moved on");
    await writeFile(join(child, "extra.txt"), "not in the baseline");

    await restoreOrchestrationBaseline({ baselinePath, workspacePath: child });

    await expect(readFile(join(child, "file.txt"), "utf8")).resolves.toBe("baseline");
    await expect(readFile(join(child, "extra.txt"), "utf8")).rejects.toThrow();
  });

  it("still reads a baseline captured before the shared store existed", async () => {
    const coordinator = await makeWorkspace("coordinator");
    const child = await makeWorkspace("child");
    const artifacts = await makeWorkspace("artifacts");
    const baselinePath = join(artifacts, "orchestration-1", "waves", "wave-1", "baseline");
    await mkdir(join(baselinePath, "files"), { recursive: true });
    await writeFile(join(baselinePath, "files", "file.txt"), "baseline");
    await writeFile(join(baselinePath, "manifest.json"), JSON.stringify({
      version: 1,
      sourcePath: coordinator,
      workspaceVcs: "folder",
      createdAt: new Date().toISOString(),
      entries: [{ path: "file.txt", hash: createHash("sha256").update("baseline").digest("hex"), size: 8 }],
      unsupportedPaths: [],
    }));
    await writeFile(join(child, "file.txt"), "moved on");

    await restoreOrchestrationBaseline({ baselinePath, workspacePath: child });

    await expect(readFile(join(child, "file.txt"), "utf8")).resolves.toBe("baseline");
  });
});
