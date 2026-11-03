import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSkillFiles, parseSkillPackage, readGitSkill, readSkillDirectory, skillPackagePath, storeSkillFiles, validateSkillResourcePath, type SkillGitRunner } from "./skill-packages";

const directories: string[] = [];
const temporary = async () => { const directory = await mkdtemp(join(tmpdir(), "buildwarden-skills-")); directories.push(directory); return directory; };
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const body = "---\nname: example\ndescription: |\n  Use this workflow for tests.\ncompatibility: Requires Python\nlicense: MIT\n---\nRead references/guide.md and run scripts/check.py.\n";
const files = () => new Map([["SKILL.md", Buffer.from(body)], ["references/guide.md", Buffer.from("Reference instructions")], ["scripts/check.py", Buffer.from("print('check')")], ["assets/sample.bin", Buffer.from([0, 1, 255])]]);

describe("skill packages", () => {
  it("round-trips legitimate child names beginning with two dots", async () => {
    const source = await temporary(); const store = await temporary();
    await writeFile(join(source, "..notes.md"), "valid child");
    await mkdir(join(source, "..guides"));
    await writeFile(join(source, "..guides", "guide.md"), "nested child");
    const original = await readSkillDirectory(source);
    const hash = await storeSkillFiles(store, original);
    expect(await readSkillDirectory(skillPackagePath(store, hash))).toEqual(original);
    expect(original.get("..notes.md")?.toString()).toBe("valid child");
  });
  it("preserves a complete package and validates YAML metadata", async () => {
    const root = await temporary();
    const hash = await storeSkillFiles(root, files());
    const restored = await readSkillDirectory(skillPackagePath(root, hash));
    expect(restored).toEqual(files());
    const record = parseSkillPackage(restored, { source: "local", path: root });
    expect(record.metadata).toMatchObject({ source: "local", compatibility: "Requires Python", license: "MIT", resourceCount: 4 });
    expect(record.diagnostics).toEqual([]);
    expect(await storeSkillFiles(root, files())).toBe(hash);
  });

  it("hashes file names and bytes deterministically and repairs tampered stored packages", async () => {
    const root = await temporary();
    const original = files();
    expect(hashSkillFiles(new Map([...original].reverse()))).toBe(hashSkillFiles(original));
    const hash = await storeSkillFiles(root, original);
    await writeFile(join(skillPackagePath(root, hash), "SKILL.md"), "tampered");
    expect(await Promise.all([storeSkillFiles(root, original), storeSkillFiles(root, original)])).toEqual([hash, hash]);
    expect(await readSkillDirectory(skillPackagePath(root, hash))).toEqual(original);
  });

  it.each(["../secret", "C:/secret", "/secret", "references/../../secret", "references\\secret", "assets/x:stream", "a//b", "a/CON.txt", "assets/x.", "x\0y"])("rejects unsafe resource path %s", (path) => {
    expect(() => validateSkillResourcePath(path)).toThrow();
  });

  it("rejects packages that cannot round-trip through the directory reader", async () => {
    const root = await temporary();
    for (const path of ["node_modules/dependency.js", `${"deep/".repeat(13)}file`]) {
      await expect(storeSkillFiles(root, new Map([[path, Buffer.from("data")]]))).rejects.toThrow();
    }
  });

  it("rejects links instead of copying files outside the skill", async () => {
    const root = await temporary();
    const outside = await temporary();
    await writeFile(join(outside, "secret"), "must not be copied");
    await symlink(outside, join(root, "linked"), "junction");
    await expect(readSkillDirectory(root)).rejects.toThrow("symbolic links");
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("must not be copied");
  });

  it("reports missing supporting files without claiming they are present", () => {
    const incomplete = new Map([["SKILL.md", Buffer.from(body)]]);
    expect(parseSkillPackage(incomplete, { source: "local", path: "/example" }).diagnostics).toHaveLength(2);
  });

  it("rejects malformed frontmatter and oversized resources", async () => {
    expect(() => parseSkillPackage(new Map([["SKILL.md", Buffer.from("not frontmatter")]]), { source: "local", path: "/example" })).toThrow("frontmatter");
    expect(() => parseSkillPackage(new Map([["SKILL.md", Buffer.from("---\nname: example\ndescription: [broken\n---\nbody")]]), { source: "local", path: "/example" })).toThrow("frontmatter");
    const root = await temporary();
    await expect(storeSkillFiles(root, new Map([["large", Buffer.alloc(8 * 1024 * 1024 + 1)]]))).rejects.toThrow("size limit");
  });

  it("copies local files without changing their source", async () => {
    const source = await temporary();
    const store = await temporary();
    await mkdir(join(source, "references"));
    await writeFile(join(source, "SKILL.md"), body);
    await writeFile(join(source, "references", "guide.md"), "original");
    const hash = await storeSkillFiles(store, await readSkillDirectory(source));
    await writeFile(join(source, "references", "guide.md"), "updated");
    expect(await readFile(join(skillPackagePath(store, hash), "references", "guide.md"), "utf8")).toBe("original");
  });

  it("imports Git blobs at the pinned commit without checkout or hooks", async () => {
    const root = await temporary();
    const revision = "a".repeat(40);
    const blob = "b".repeat(40);
    const runner = vi.fn<SkillGitRunner>(async (_cwd, args) => {
      if (args[0] === "ls-tree") return Buffer.from(`100644 blob ${blob}\tSKILL.md\0`);
      if (args[0] === "cat-file") return Buffer.from(body);
      return Buffer.alloc(0);
    });
    const source = { source: "git" as const, url: "https://example.com/skills.git", revision, subdirectory: "skills/example" };
    const result = await readGitSkill(root, source, runner);
    expect(result.get("SKILL.md")?.toString()).toBe(body);
    expect(runner.mock.calls.map(([, args]) => args)).toEqual([
      ["init", "--bare"], ["fetch", "--depth=1", "--no-tags", source.url, revision],
      ["ls-tree", "-rz", `${revision}:skills/example`], ["cat-file", "blob", blob],
    ]);
    expect(parseSkillPackage(result, source).revision).toBe(revision);
  });

  it("rejects credential URLs, unpinned revisions, and Git symlinks", async () => {
    const root = await temporary();
    const source = { source: "git" as const, url: "https://example.com/skills.git", revision: "a".repeat(40), subdirectory: "" };
    await expect(readGitSkill(root, { ...source, url: "https://user:password@example.com/repo" })).rejects.toThrow("credentials");
    await expect(readGitSkill(root, { ...source, revision: "main" })).rejects.toThrow("commit SHA");
    await expect(readGitSkill(root, source, async (_cwd, args) => Buffer.from(args[0] === "ls-tree" ? `120000 blob ${"b".repeat(40)}\tSKILL.md\0` : ""))).rejects.toThrow("symlinks");
  });
});
