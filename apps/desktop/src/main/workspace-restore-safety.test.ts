import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { workspacePathsOverlap } from "./workspace-restore-safety";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("detects equal, parent and child paths without confusing sibling prefixes", () => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-restore-paths-"));
  roots.push(root);
  expect(workspacePathsOverlap(root, join(root, "."))).toBe(true);
  expect(workspacePathsOverlap(root, join(root, "missing", "child"))).toBe(true);
  expect(workspacePathsOverlap(join(root, "child"), root)).toBe(true);
  expect(workspacePathsOverlap(join(root, "a"), join(root, "ab"))).toBe(false);
  if (process.platform === "win32") expect(workspacePathsOverlap(root, root.toUpperCase())).toBe(true);
});

it("resolves symlink or junction aliases, including missing descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-restore-alias-"));
  roots.push(root);
  const actual = join(root, "actual");
  const alias = join(root, "alias");
  mkdirSync(actual);
  symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
  expect(workspacePathsOverlap(actual, alias)).toBe(true);
  expect(workspacePathsOverlap(join(actual, "new"), join(alias, "new", "child"))).toBe(true);
});
