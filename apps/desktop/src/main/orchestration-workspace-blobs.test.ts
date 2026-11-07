import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureOrchestrationBaseline } from "./orchestration-workspace";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename) };
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("baseline content store", () => {
  it("leaves no partial file behind when a blob cannot be stored", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "buildwarden-blob-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "buildwarden-blob-artifacts-"));
    directories.push(workspace, artifacts);
    await writeFile(join(workspace, "file.txt"), "content");
    vi.mocked(rename).mockRejectedValueOnce(new Error("Disk failure"));

    await expect(captureOrchestrationBaseline({
      workspacePath: workspace, workspaceVcs: "folder", artifactRoot: artifacts, orchestrationId: "orchestration-1", waveId: "wave-1",
    })).rejects.toThrow("Disk failure");

    const stored = await readdir(join(artifacts, "orchestration-1", "blobs"), { recursive: true, withFileTypes: true });
    expect(stored.filter((entry) => entry.isFile())).toEqual([]);
  });
});
