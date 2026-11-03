import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { IntegratedSkillDefinition, IntegratedSkillMetadata, SkillImportInput, SkillPackageRecord } from "@buildwarden/shared";

const execFileAsync = promisify(execFile);
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 500;
export type SkillFiles = Map<string, Buffer>;

export const validateSkillResourcePath = (path: string): string => {
  if (!path || path.length > 1024 || isAbsolute(path) || path.includes("\\") || /[:<>"|?*]/.test(path) || [...path].some((char) => char.charCodeAt(0) < 32) ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Invalid skill resource path: ${path}`);
  }
  return path;
};

const checkFiles = (files: SkillFiles) => {
  let bytes = 0;
  let pathChars = 0;
  const seen = new Set<string>();
  const entries = new Set<string>();
  if (files.size > MAX_FILES) throw new Error(`A skill may contain at most ${MAX_FILES} files.`);
  for (const [path, data] of files) {
    validateSkillResourcePath(path);
    const parts = path.split("/");
    if (parts.includes("node_modules")) throw new Error("Skill packages cannot contain node_modules.");
    if (parts.length > 13) throw new Error("Skill directory is too deeply nested.");
    parts.forEach((_, index) => entries.add(parts.slice(0, index + 1).join("/")));
    if (entries.size > 1000) throw new Error("Skill directory contains too many entries.");
    if (seen.has(path.toLowerCase())) throw new Error(`Conflicting skill file paths: ${path}`);
    seen.add(path.toLowerCase());
    pathChars += path.length + 4;
    if (pathChars > 32_000) throw new Error("Skill resource manifest exceeds 32,000 characters.");
    bytes += data.length;
    if (data.length > MAX_FILE_BYTES || bytes > MAX_PACKAGE_BYTES) throw new Error("Skill package exceeds the file or package size limit.");
  }
};

export const hashSkillFiles = (files: SkillFiles): string => {
  const hash = createHash("sha256");
  for (const [path, data] of [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    hash.update(`${Buffer.byteLength(path)}:${path}:${data.length}:`).update(data);
  }
  return hash.digest("hex");
};

export const readSkillDirectory = async (directory: string): Promise<SkillFiles> => {
  const root = await realpath(directory);
  const files: SkillFiles = new Map();
  let totalBytes = 0;
  let entries = 0;
  const walk = async (path: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 12) throw new Error("Skill directory is too deeply nested.");
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      if (entry.name === "node_modules") throw new Error("Skill packages cannot contain node_modules.");
      if (++entries > 1000) throw new Error("Skill directory contains too many entries.");
      const key = validateSkillResourcePath(prefix + entry.name);
      const fullPath = join(path, entry.name);
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Skill packages cannot contain symbolic links: ${key}`);
      const actual = await realpath(fullPath);
      const rel = relative(root, actual);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Skill resource escapes its package.");
      if (stat.isDirectory()) await walk(fullPath, `${key}/`, depth + 1);
      else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES || (totalBytes += stat.size) > MAX_PACKAGE_BYTES || files.size >= MAX_FILES) throw new Error("Skill package exceeds the file or package size limit.");
        files.set(key, await readFile(actual));
      } else throw new Error(`Unsupported skill resource: ${key}`);
    }
  };
  await walk(root, "", 0);
  checkFiles(files);
  return files;
};

export const skillPackagePath = (store: string, hash: string): string => {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid skill package hash.");
  return join(store, hash);
};

const packageWrites = new Map<string, Promise<string>>();
export const storeSkillFiles = async (store: string, files: SkillFiles): Promise<string> => {
  const key = skillPackagePath(resolve(store), hashSkillFiles(files));
  const previous = packageWrites.get(key);
  const pending = (previous ?? Promise.resolve()).catch(() => {}).then(() => writeSkillFiles(store, files));
  packageWrites.set(key, pending);
  try { return await pending; } finally { if (packageWrites.get(key) === pending) packageWrites.delete(key); }
};

const writeSkillFiles = async (store: string, files: SkillFiles): Promise<string> => {
  checkFiles(files);
  const hash = hashSkillFiles(files);
  const destination = skillPackagePath(store, hash);
  await mkdir(store, { recursive: true });
  try {
    if (hashSkillFiles(await readSkillDirectory(destination)) === hash) return hash;
  } catch (error) {
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  const temporary = await mkdtemp(join(store, ".import-"));
  try {
    for (const [path, data] of files) {
      const target = join(temporary, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    // Quarantine an invalid destination before publishing verified replacement bytes.
    let quarantine: string | undefined;
    try {
      const existing = await readSkillDirectory(destination).catch(() => null);
      if (existing && hashSkillFiles(existing) === hash) return hash;
      await lstat(destination);
      quarantine = await mkdtemp(join(store, ".damaged-"));
      await rename(destination, join(quarantine, "package"));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(temporary, destination); }
    catch (error) {
      if (hashSkillFiles(await readSkillDirectory(destination)) !== hash) throw error;
    }
  } finally {
    // temporary is created directly beneath the app-owned store.
    await rm(temporary, { recursive: true, force: true });
  }
  return hash;
};

export const parseSkillPackage = (files: SkillFiles, source: SkillImportInput): SkillPackageRecord => {
  checkFiles(files);
  const text = files.get("SKILL.md")?.toString("utf8");
  const header = text?.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!text || !header) throw new Error("SKILL.md must contain YAML frontmatter with name and description.");
  const document = parseDocument(header[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid SKILL.md frontmatter: ${document.errors[0]!.message}`);
  const parsed: unknown = document.toJS({ maxAliasCount: 20 });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Skill frontmatter must be a mapping.");
  const data = parsed as Record<string, unknown>;
  if (typeof data.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) || data.name.length > 64) throw new Error("Skill name must be lowercase words separated by hyphens (up to 64 characters).");
  if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024) throw new Error("Skill description is required (up to 1024 characters).");
  const diagnostics = findMissingSkillResources(text, files);
  const hash = hashSkillFiles(files);
  const location = source.source === "local" ? resolve(source.path) : `${source.url}#${source.subdirectory}`;
  const id = `${source.source}:${data.name}:${createHash("sha256").update(location).digest("hex").slice(0, 12)}`;
  return {
    hash, resources: [...files.keys()].sort(), diagnostics,
    ...(source.source === "git" ? { revision: source.revision.toLowerCase() } : {}),
    metadata: {
      id, source: source.source, category: "custom", name: data.name, title: data.name,
      description: data.description.trim(), license: typeof data.license === "string" ? data.license : null,
      relativeDir: source.source === "git" ? source.subdirectory : "", sourceUrl: source.source === "git" ? source.url : "",
      contentHash: hash, diagnostics, resourceCount: files.size,
      ...(source.source === "git" ? { revision: source.revision.toLowerCase() } : {}),
      ...(typeof data.compatibility === "string" ? { compatibility: data.compatibility } : {}),
    },
  };
};

export const findMissingSkillResources = (content: string, files: SkillFiles): string[] =>
  [...new Set((content.match(/(?:references|scripts|assets)\/[A-Za-z0-9._/-]+/g) ?? []).map((path) => path.replace(/\.+$/, "")))]
    .filter((path) => !files.has(path) && ![...files.keys()].some((key) => key.startsWith(path.replace(/\/$/, "") + "/")))
    .map((path) => `Referenced resource is not packaged: ${path}`);

export const skillMetadata = (skill: IntegratedSkillDefinition): IntegratedSkillMetadata => ({
  id: skill.id, source: skill.source, category: skill.category, name: skill.name, title: skill.title,
  description: skill.description, license: skill.license, relativeDir: skill.relativeDir, sourceUrl: skill.sourceUrl,
  compatibility: skill.compatibility,
});

export const packageBundledSkill = async (store: string, skill: IntegratedSkillDefinition): Promise<SkillPackageRecord> => {
  const files: SkillFiles = new Map([["SKILL.md", Buffer.from(skill.content)]]);
  for (const reference of skill.references) files.set(reference.path, Buffer.from(reference.content));
  const hash = await storeSkillFiles(store, files);
  const metadata = skillMetadata(skill);
  const diagnostics = findMissingSkillResources(skill.content, files);
  return { hash, resources: [...files.keys()], diagnostics, metadata: { ...metadata, contentHash: hash, diagnostics, resourceCount: files.size } };
};

/** Fetch blobs by pinned commit without checking out files, executing hooks, or applying Git filters. */
export type SkillGitRunner = (cwd: string, args: string[]) => Promise<Buffer>;
const runSkillGit: SkillGitRunner = async (cwd, args) => (await execFileAsync("git", ["-c", "core.hooksPath=", "-c", "protocol.file.allow=never", ...args], {
  cwd, windowsHide: true, timeout: 120_000, maxBuffer: MAX_FILE_BYTES, encoding: "buffer",
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
})).stdout;

export const readGitSkill = async (store: string, input: Extract<SkillImportInput, { source: "git" }>, runner: SkillGitRunner = runSkillGit): Promise<SkillFiles> => {
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS Git URL without embedded credentials, query, or fragment.");
  if (!/^[a-f0-9]{40}$/i.test(input.revision)) throw new Error("Git imports require a full 40-character commit SHA.");
  const subdirectory = input.subdirectory ? validateSkillResourcePath(input.subdirectory) : "";
  await mkdir(store, { recursive: true });
  const temporary = await mkdtemp(join(store, ".git-import-"));
  const git = (args: string[]) => runner(temporary, args);
  try {
    await git(["init", "--bare"]);
    await git(["fetch", "--depth=1", "--no-tags", url.href, input.revision]);
    const tree = `${input.revision}${subdirectory ? `:${subdirectory}` : ""}`;
    const listing = (await git(["ls-tree", "-rz", tree])).toString("utf8").split("\0").filter(Boolean);
    if (listing.length > MAX_FILES) throw new Error("Skill package contains too many files.");
    const files: SkillFiles = new Map();
    for (const entry of listing) {
      const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s);
      if (!match) throw new Error("Git skill packages cannot contain symlinks or submodules.");
      const path = validateSkillResourcePath(match[3]!);
      files.set(path, await git(["cat-file", "blob", match[2]!]));
      checkFiles(files);
    }
    return files;
  } finally { await rm(temporary, { recursive: true, force: true }); }
};
