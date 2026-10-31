import { describe, expect, it, vi } from "vitest";
import { resolve, join } from "node:path";
const mocks = vi.hoisted(() => ({ readdir: vi.fn(), rm: vi.fn() }));
vi.mock("node:fs/promises", () => mocks);
import { pruneCompileCaches } from "./compile-cache-cleanup";
describe("compile cache cleanup", () => {
  it("removes owned stale directories only, preserving the active cache and links", async () => {
    const entry = (name: string, link = false) => ({ name, isDirectory: () => true, isSymbolicLink: () => link });
    mocks.readdir.mockResolvedValue([entry("app-old"), entry("app-current"), entry("dev-old"), entry("v24.22.0-legacy"), entry("unrelated"), entry("app-link", true), entry("app-../../escape")]);
    const root = resolve("cache-root");
    await pruneCompileCaches(root, "app-current");
    expect(mocks.rm.mock.calls.map(([path]) => path)).toEqual([join(root, "app-old"), join(root, "dev-old"), join(root, "v24.22.0-legacy")]);
  });
  it("tolerates cleanup failures", async () => {
    mocks.readdir.mockRejectedValue(new Error("Permission denied"));
    await expect(pruneCompileCaches("cache-root", "app-current")).resolves.toBeUndefined();
  });
});
