import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFolderWorkspaceCopy, removeFolderWorkspaceCopy } from "./folder-workspace";

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildwarden-folder-workspace-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("folder workspace copies", () => {
  it("copies source files into a managed workspace and skips ignored folders", async () => {
    const sourcePath = await makeTempDir();
    const workspaceRoot = await makeTempDir();
    await mkdir(join(sourcePath, "src"), { recursive: true });
    await mkdir(join(sourcePath, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(sourcePath, "README.md"), "# Example\n", "utf8");
    await writeFile(join(sourcePath, "src", "index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(sourcePath, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

    const copy = await createFolderWorkspaceCopy({
      sourcePath,
      projectName: "Example Project",
      runId: "run-1",
      configuredWorkspaceRoot: workspaceRoot,
    });

    await expect(readFile(join(copy.worktreePath, "README.md"), "utf8")).resolves.toBe("# Example\n");
    await expect(readFile(join(copy.worktreePath, "src", "index.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
    expect(existsSync(join(copy.worktreePath, "node_modules"))).toBe(false);

    await removeFolderWorkspaceCopy(copy.worktreePath);
    expect(existsSync(copy.worktreePath)).toBe(false);
  });

  it("refuses to delete paths outside the managed workspace directory", async () => {
    const sourcePath = await makeTempDir();
    await writeFile(join(sourcePath, "README.md"), "# Keep\n", "utf8");

    await expect(removeFolderWorkspaceCopy(sourcePath)).rejects.toThrow("Refusing to delete");
    await expect(readFile(join(sourcePath, "README.md"), "utf8")).resolves.toBe("# Keep\n");
  });
});
