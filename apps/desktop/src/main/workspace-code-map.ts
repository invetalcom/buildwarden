import { execFile } from "node:child_process";
import { lstat, open, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import type { WorkspaceCodeMapFile, WorkspaceCodeMapResult } from "@buildwarden/shared";
import { FOLDER_WORKSPACE_IGNORED_NAMES, MANAGED_WORKSPACE_DIR } from "./folder-workspace-constants";

/** Workspaces beyond this many files are mapped partially and reported as truncated. */
const WORKSPACE_CODE_MAP_MAX_FILES = 20_000;
/** Larger files are generated or data far more often than source, and would dwarf the map. */
const MAX_FILE_BYTES = 1_000_000;
const MAX_IMPORT_SCAN_BYTES = 400_000;
const READ_CONCURRENCY = 24;
const BINARY_SNIFF_BYTES = 8_000;

const SKIPPED_FILE_NAMES = new Set([
  "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb",
  "Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock", "go.sum", "flake.lock",
]);
const SKIPPED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "icns", "tif", "tiff", "psd",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "avi", "mkv", "webm", "wav", "ogg", "flac",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "exe", "dll", "so", "dylib", "node", "wasm", "bin", "dat", "db", "sqlite", "class", "pyc", "o", "a",
  "map",
]);
const IMPORT_SCAN_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".vue", ".svelte", ".astro", ".css"];
const TS_FOR_JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts"];
const CONFIG_FILE_PATTERN = /(?:^|\/)(?:package\.json|[tj]sconfig(?:\.[\w-]+)?\.json)$/;

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const isSkippedPath = (path: string): boolean =>
  SKIPPED_FILE_NAMES.has(path.slice(path.lastIndexOf("/") + 1))
  || SKIPPED_EXTENSIONS.has(extensionOf(path))
  // BuildWarden's own worktrees are other runs' workspaces, not part of this one.
  || `/${path}`.includes(`/${MANAGED_WORKSPACE_DIR}/`);

/** `import` or `export` as a whole word. */
const IMPORT_KEYWORD = String.raw`(?:import|export)(?![\w$])`;
/**
 * The bindings between the keyword and `from`. The clause may not run past the next import/export
 * keyword, so no two match attempts walk the same text and the scan stays linear. Without that
 * limit, a file that repeats the keyword or follows it with a long whitespace run takes seconds
 * to minutes, which would block the main process.
 */
const IMPORT_CLAUSE = String.raw`(?:(?!(?<![\w$])${IMPORT_KEYWORD})[\w$*{}\s,])*?`;
const STATIC_IMPORT_PATTERN = new RegExp(
  String.raw`(?:^|[^.\w$])${IMPORT_KEYWORD}(?:${IMPORT_CLAUSE}from)?\s*["']([^"'\n]+)["']`,
  "g",
);
const DYNAMIC_IMPORT_PATTERN = /(?:^|[^.\w$])(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*[,)]/g;

/** Module specifiers of static, re-export, dynamic, and CommonJS imports. Regex-based: commented-out imports count too. */
export const extractImportSpecifiers = (text: string): string[] => {
  const specifiers = new Set<string>();
  for (const pattern of [STATIC_IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
};

/** Strips comments and trailing commas so tsconfig-style JSON parses; returns null when it still does not. */
const parseLooseJson = (text: string): unknown => {
  let output = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      output += char;
      if (char === "\\") output += text[++index] ?? "";
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
    } else if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end - 1;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 1;
    } else {
      output += char;
    }
  }
  try {
    return JSON.parse(output.replace(/,(\s*[}\]])/g, "$1")) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};

/** Joins workspace-relative POSIX paths; null when the result escapes the workspace. */
const joinInside = (base: string, target: string): string | null => {
  const joined = posix.normalize(posix.join(base || ".", target));
  if (joined === ".." || joined.startsWith("../") || posix.isAbsolute(joined)) return null;
  return joined === "." ? "" : joined.replace(/\/$/, "");
};

type PathAlias = { prefix: string; suffix: string; wildcard: boolean; targets: string[] };
type AliasScope = { dir: string; baseDir: string | null; aliases: PathAlias[] };
type WorkspacePackage = { dir: string; entries: string[] };

const isInDir = (path: string, dir: string): boolean => dir === "" || path.startsWith(`${dir}/`);

const readPackageEntries = (manifest: Record<string, unknown>): string[] => {
  const entries: string[] = [];
  const collect = (value: unknown, depth = 0) => {
    if (typeof value === "string") entries.push(value);
    else if (isRecord(value) && depth < 3) Object.values(value).forEach((child) => collect(child, depth + 1));
  };
  for (const value of [manifest.source, manifest.types, manifest.module, manifest.main]) collect(value);
  collect(isRecord(manifest.exports) ? manifest.exports["."] ?? manifest.exports : manifest.exports);
  return entries.filter((entry) => !entry.includes("*"));
};

const readPathAliases = (paths: unknown): PathAlias[] => {
  if (!isRecord(paths)) return [];
  return Object.entries(paths).map(([key, value]) => {
    const targets = Array.isArray(value) ? value.filter((target): target is string => typeof target === "string") : [];
    const star = key.indexOf("*");
    return star === -1
      ? { prefix: key, suffix: "", wildcard: false, targets }
      : { prefix: key.slice(0, star), suffix: key.slice(star + 1), wildcard: true, targets };
  });
};

const aliasCapture = (alias: PathAlias, specifier: string): string | null => {
  if (!alias.wildcard) return specifier === alias.prefix ? "" : null;
  const matches = specifier.length >= alias.prefix.length + alias.suffix.length
    && specifier.startsWith(alias.prefix)
    && specifier.endsWith(alias.suffix);
  return matches ? specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length) : null;
};

export type CodeMapScannedFile = { path: string; lines: number; specifiers: readonly string[] };

/** Resolves import specifiers against the scanned file set only; nothing here touches the filesystem. */
export const resolveCodeMapImports = (
  scanned: readonly CodeMapScannedFile[],
  configTexts: ReadonlyMap<string, string>,
): WorkspaceCodeMapFile[] => {
  const indexByPath = new Map<string, number>();
  scanned.forEach((file, index) => indexByPath.set(file.path, index));

  const packages = new Map<string, WorkspacePackage>();
  const aliasScopes: AliasScope[] = [];
  for (const [path, text] of configTexts) {
    const parsed = parseLooseJson(text);
    if (!isRecord(parsed)) continue;
    const dir = dirOf(path);
    if (path.endsWith("package.json")) {
      if (typeof parsed.name === "string" && parsed.name) packages.set(parsed.name, { dir, entries: readPackageEntries(parsed) });
      continue;
    }
    const options = isRecord(parsed.compilerOptions) ? parsed.compilerOptions : null;
    if (!options) continue;
    const baseDir = typeof options.baseUrl === "string" ? joinInside(dir, options.baseUrl) : null;
    const aliases = readPathAliases(options.paths);
    if (baseDir !== null || aliases.length > 0) aliasScopes.push({ dir, baseDir, aliases });
  }
  // The nearest config wins, as it does for the TypeScript compiler.
  aliasScopes.sort((left, right) => right.dir.length - left.dir.length);

  const probeWith = (base: string, suffixes: readonly string[]): number | undefined => {
    for (const suffix of suffixes) {
      const hit = indexByPath.get(base + suffix);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const probe = (base: string | null): number | undefined => {
    if (base === null) return undefined;
    // TypeScript ESM sources import their siblings by the emitted `.js` name.
    const emitted = /\.[cm]?jsx?$/.exec(base);
    return indexByPath.get(base)
      ?? probeWith(base, RESOLVE_EXTENSIONS)
      ?? (emitted ? probeWith(base.slice(0, emitted.index), TS_FOR_JS_EXTENSIONS) : undefined)
      ?? probeWith(`${base}/index`, RESOLVE_EXTENSIONS);
  };
  const probeAll = (dir: string, candidates: readonly string[]): number | undefined => {
    for (const candidate of candidates) {
      const hit = probe(joinInside(dir, candidate));
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const resolveAlias = (scopes: readonly AliasScope[], specifier: string): number | undefined => {
    for (const scope of scopes) {
      for (const alias of scope.aliases) {
        const captured = aliasCapture(alias, specifier);
        if (captured === null) continue;
        const hit = probeAll(scope.baseDir ?? scope.dir, alias.targets.map((target) => target.replace("*", captured)));
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  const resolvePackage = (specifier: string): number | undefined => {
    const segments = specifier.split("/");
    const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
    const workspacePackage = packages.get(packageName);
    if (!workspacePackage) return undefined;
    const subpath = specifier.slice(packageName.length + 1);
    return probeAll(workspacePackage.dir, subpath ? [subpath, `src/${subpath}`] : [...workspacePackage.entries, "src/index", "index"]);
  };
  const resolveFromBaseUrl = (scopes: readonly AliasScope[], specifier: string): number | undefined => {
    for (const scope of scopes) {
      const hit = scope.baseDir === null ? undefined : probe(joinInside(scope.baseDir, specifier));
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const resolveSpecifier = (fromPath: string, rawSpecifier: string): number | undefined => {
    const specifier = rawSpecifier.replace(/[?#].*$/, "");
    if (!specifier || specifier.startsWith("/")) return undefined;
    if (specifier.startsWith(".")) return probe(joinInside(dirOf(fromPath), specifier));
    const scopes = aliasScopes.filter((scope) => isInDir(fromPath, scope.dir));
    return resolveAlias(scopes, specifier) ?? resolvePackage(specifier) ?? resolveFromBaseUrl(scopes, specifier);
  };

  return scanned.map((file, index) => {
    const imports = new Set<number>();
    for (const specifier of file.specifiers) {
      const target = resolveSpecifier(file.path, specifier);
      if (target !== undefined && target !== index) imports.add(target);
    }
    return imports.size > 0
      ? { path: file.path, lines: file.lines, imports: [...imports].sort((left, right) => left - right) }
      : { path: file.path, lines: file.lines };
  });
};

const runGit = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout)),
    );
  });

type FileListing = { root: string; paths: string[] };

/**
 * Tracked and untracked-but-not-ignored files below `workspacePath`. Paths are relative to the
 * repository top level so they line up with diff paths even when the workspace is a subfolder.
 */
const listGitFiles = async (workspacePath: string): Promise<FileListing> => {
  // Sequential on purpose: outside a repository the first command fails and no second Git process is left running.
  const topLevel = (await runGit(workspacePath, ["rev-parse", "--show-toplevel"])).trim();
  const listing = await runGit(workspacePath, ["ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard"]);
  return { root: topLevel || workspacePath, paths: listing.split("\0").filter(Boolean) };
};

const listFolderFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const pending = [""];
  while (pending.length > 0 && files.length <= WORKSPACE_CODE_MAP_MAX_FILES) {
    const dir = pending.pop()!;
    const absoluteDir = join(root, dir);
    // The workspace can change during the walk. A folder that has become a link since its parent was
    // listed must not be followed out of the workspace. The root is exempt: a project may live behind a link.
    if (dir && !(await lstat(absoluteDir).catch(() => null))?.isDirectory()) continue;
    const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (FOLDER_WORKSPACE_IGNORED_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
};

type FileScan = { file: CodeMapScannedFile; configText: string | null };

const countLines = (buffer: Buffer): number => {
  let lines = 0;
  for (let offset = buffer.indexOf(10); offset !== -1; offset = buffer.indexOf(10, offset + 1)) lines += 1;
  return buffer.length > 0 && buffer[buffer.length - 1] !== 10 ? lines + 1 : lines;
};

const scanFile = async (root: string, path: string): Promise<FileScan | null> => {
  try {
    const absolutePath = join(root, path);
    // lstat, not stat: symlinks and submodule gitlinks must never lead the scan outside the workspace.
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;
    const buffer = Buffer.alloc(stats.size);
    if (stats.size > 0) {
      const handle = await open(absolutePath, "r");
      try {
        await handle.read(buffer, 0, stats.size, 0);
      } finally {
        await handle.close();
      }
    }
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;

    const isConfig = CONFIG_FILE_PATTERN.test(path);
    const scanImports = IMPORT_SCAN_EXTENSIONS.has(extensionOf(path)) && stats.size <= MAX_IMPORT_SCAN_BYTES;
    const text = isConfig || scanImports ? buffer.toString("utf8") : null;
    return {
      file: { path, lines: countLines(buffer), specifiers: scanImports && text ? extractImportSpecifiers(text) : [] },
      configText: isConfig ? text : null,
    };
  } catch {
    // Files that vanish mid-scan (an agent is editing the workspace) are simply left out.
    return null;
  }
};

/**
 * Sizes and import edges of every text file in a workspace. Git workspaces honor `.gitignore`;
 * anything else falls back to a directory walk that skips well-known build and VCS folders.
 * Strictly read-only: it lists and reads files, and never runs a Git command that writes.
 */
export const scanWorkspaceCodeMap = async (workspacePath: string): Promise<WorkspaceCodeMapResult> => {
  let listing: FileListing;
  try {
    listing = await listGitFiles(workspacePath);
  } catch {
    listing = { root: workspacePath, paths: await listFolderFiles(workspacePath) };
  }
  const candidates = [...new Set(listing.paths.map((path) => path.replace(/\\/g, "/")))]
    .filter((path) => !isSkippedPath(path))
    .sort((left, right) => (left < right ? -1 : Number(left > right)));
  const truncated = candidates.length > WORKSPACE_CODE_MAP_MAX_FILES;
  const selected = truncated ? candidates.slice(0, WORKSPACE_CODE_MAP_MAX_FILES) : candidates;

  const scans = new Array<FileScan | null>(selected.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, selected.length) }, async () => {
    while (next < selected.length) {
      const index = next++;
      scans[index] = await scanFile(listing.root, selected[index]!);
    }
  }));

  const scanned: CodeMapScannedFile[] = [];
  const configTexts = new Map<string, string>();
  for (const scan of scans) {
    if (!scan) continue;
    scanned.push(scan.file);
    if (scan.configText !== null) configTexts.set(scan.file.path, scan.configText);
  }
  return { files: resolveCodeMapImports(scanned, configTexts), truncated, workspaceUnavailable: false };
};
