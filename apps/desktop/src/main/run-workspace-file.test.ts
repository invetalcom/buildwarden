import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRunWorkspaceFileReference } from "@buildwarden/shared";
import { isPathInsideRoot, readRunWorkspaceFileForPreview } from "./run-workspace-file";

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const path = await mkdtemp(join(tmpdir(), "buildwarden-run-file-"));
  tempDirs.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("run workspace file references", () => {
  it("parses common line and column suffixes", () => {
    expect(parseRunWorkspaceFileReference("src/App.tsx:42")).toEqual({
      path: "src/App.tsx",
      line: 42,
      column: null,
    });
    expect(parseRunWorkspaceFileReference("src/App.tsx:42:7")).toEqual({
      path: "src/App.tsx",
      line: 42,
      column: 7,
    });
    expect(parseRunWorkspaceFileReference("src/App.tsx#L42C7")).toEqual({
      path: "src/App.tsx",
      line: 42,
      column: 7,
    });
  });

  it("keeps Windows drive letters as part of the path", () => {
    expect(parseRunWorkspaceFileReference("C:\\repo\\src\\App.tsx:42")).toEqual({
      path: "C:\\repo\\src\\App.tsx",
      line: 42,
      column: null,
    });
  });

  it("ignores external URLs", () => {
    expect(parseRunWorkspaceFileReference("https://example.com/src/App.tsx")).toBeNull();
    expect(parseRunWorkspaceFileReference("mailto:dev@example.com")).toBeNull();
  });
});

describe("run workspace file guard", () => {
  it("accepts paths inside the workspace and rejects parent traversal", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "example.ts"), "one\ntwo\n", "utf8");

    expect(isPathInsideRoot(root, join(root, "src", "example.ts"))).toBe(true);
    expect(isPathInsideRoot(root, resolve(root, "..", "outside.ts"))).toBe(false);

    const ok = await readRunWorkspaceFileForPreview({ workspacePath: root, requestedPath: "src/example.ts:2" });
    expect(ok.unavailableReason).toBeUndefined();
    expect(ok.path).toBe("src/example.ts");
    expect(ok.content).toBe("one\ntwo\n");
    expect(ok.line).toBe(2);

    const outside = await readRunWorkspaceFileForPreview({ workspacePath: root, requestedPath: "../outside.ts" });
    expect(outside.unavailableReason).toBe("outside-workspace");
    expect(outside.content).toBeNull();
  });

  it("returns structured unavailable reasons", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "src"), { recursive: true });

    const missing = await readRunWorkspaceFileForPreview({ workspacePath: root, requestedPath: "src/missing.ts" });
    expect(missing.unavailableReason).toBe("not-found");

    const directory = await readRunWorkspaceFileForPreview({ workspacePath: root, requestedPath: "src" });
    expect(directory.unavailableReason).toBe("directory");
  });
});
