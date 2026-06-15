import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createFolderSnapshot, deleteFolderSnapshot, diffFolderAgainstSnapshot } from "./folder-diff";

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildwarden-folder-diff-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("folder diff snapshots", () => {
  it("reports changed, created, and deleted text files", async () => {
    const workspacePath = await makeTempDir();
    const snapshotsRoot = await makeTempDir();
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await writeFile(join(workspacePath, "README.md"), "hello\n", "utf8");
    await writeFile(join(workspacePath, "src", "old.ts"), "export const oldValue = 1;\n", "utf8");

    await createFolderSnapshot({ runId: "run-1", workspacePath, snapshotsRoot });
    await writeFile(join(workspacePath, "README.md"), "hello\nworld\n", "utf8");
    await writeFile(join(workspacePath, "src", "new.ts"), "export const newValue = 2;\n", "utf8");
    await rm(join(workspacePath, "src", "old.ts"));

    const result = await diffFolderAgainstSnapshot({ runId: "run-1", workspacePath, snapshotsRoot });

    expect(result.missingSnapshot).toBe(false);
    expect(result.diff).toContain("README.md");
    expect(result.diff).toContain("+world");
    expect(result.diff).toContain("src/new.ts");
    expect(result.diff).toContain("src/old.ts");
    expect(result.diff).toContain("-export const oldValue = 1;");
  });

  it("returns a missing-snapshot result after snapshot cleanup", async () => {
    const workspacePath = await makeTempDir();
    const snapshotsRoot = await makeTempDir();
    await writeFile(join(workspacePath, "README.md"), "hello\n", "utf8");

    await createFolderSnapshot({ runId: "run-2", workspacePath, snapshotsRoot });
    await deleteFolderSnapshot(snapshotsRoot, "run-2");

    await expect(readFile(join(snapshotsRoot, "run-2", "manifest.json"), "utf8")).rejects.toThrow();
    const result = await diffFolderAgainstSnapshot({ runId: "run-2", workspacePath, snapshotsRoot });
    expect(result).toEqual({ diff: "", missingSnapshot: true });
  });
});
