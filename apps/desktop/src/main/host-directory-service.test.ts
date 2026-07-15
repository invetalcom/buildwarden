import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostDirectoryService } from "./host-directory-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HostDirectoryService", () => {
  it("lists only real child directories and returns a host parent path", async () => {
    const root = await mkdtemp(join(tmpdir(), "buildwarden-host-browser-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "Beta"));
    await mkdir(join(root, "alpha"));
    await writeFile(join(root, "not-a-directory.txt"), "ignored", "utf8");

    const listing = await new HostDirectoryService().list({ path: root });

    expect(listing.path).toBe(root);
    expect(listing.parentPath).toBeTruthy();
    expect(listing.entries.map((entry) => entry.name)).toEqual(["alpha", "Beta"]);
  });

  it("rejects relative and file paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "buildwarden-host-browser-"));
    temporaryDirectories.push(root);
    const filePath = join(root, "file.txt");
    await writeFile(filePath, "file", "utf8");
    const service = new HostDirectoryService();

    await expect(service.list({ path: "relative/path" })).rejects.toThrow("absolute");
    await expect(service.list({ path: filePath })).rejects.toThrow("not a directory");
  });

  it("bounds large host directory listings", async () => {
    const root = await mkdtemp(join(tmpdir(), "buildwarden-host-browser-"));
    temporaryDirectories.push(root);
    await Promise.all(Array.from({ length: 501 }, (_, index) => mkdir(join(root, `folder-${String(index).padStart(3, "0")}`))));

    const listing = await new HostDirectoryService().list({ path: root });

    expect(listing.entries).toHaveLength(500);
  });
});
