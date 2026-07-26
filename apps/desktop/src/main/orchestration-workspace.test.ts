import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyOrchestrationDelta,
  captureOrchestrationBaseline,
  previewOrchestrationDelta,
  removeOwnedOrchestrationArtifact,
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

  it("refuses to recursively remove the artifact root or an unrelated directory", async () => {
    const artifacts = await makeWorkspace("owned-root");
    const unrelated = await makeWorkspace("unrelated");
    await expect(removeOwnedOrchestrationArtifact(artifacts, artifacts)).rejects.toThrow("unowned");
    await expect(removeOwnedOrchestrationArtifact(artifacts, unrelated)).rejects.toThrow("unowned");
  });
});
