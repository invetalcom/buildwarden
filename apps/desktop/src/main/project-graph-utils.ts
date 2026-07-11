import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

export type DependencyGraphSnapshot = {
  modules: Array<{
    source: string;
    dependencies: Array<{
      resolved: string | null;
    }>;
  }>;
};

const PROJECT_INSIGHT_IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".turbo",
  ".tmp",
  ".temp",
  ".cache",
  ".parcel-cache",
  ".angular",
  ".nuxt",
  ".next",
  ".output",
  ".svelte-kit",
  ".yarn",
  ".pnpm-store",
  ".gradle",
  ".mvn",
  "__pycache__",
  "node_modules",
  "coverage",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "deps",
]);

const DEPENDENCY_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java", ".go", ".py", ".rs"]);
const PYTHON_SOURCE_ROOT_SEGMENTS = new Set(["src", "python", "lib"]);

type JavaGraphIndexes = {
  classToFile: Map<string, string>;
  packageToFile: Map<string, string>;
};

type GoGraphIndexes = {
  modulePath: string | null;
  importPathToFile: Map<string, string>;
};

type PythonGraphIndexes = {
  moduleToFile: Map<string, string>;
};

type RustGraphIndexes = {
  moduleToFile: Map<string, string>;
};

type DependencyGraphIndexes = {
  java: JavaGraphIndexes;
  go: GoGraphIndexes;
  python: PythonGraphIndexes;
  rust: RustGraphIndexes;
};

type PythonImportEntry =
  | { kind: "import"; module: string }
  | { kind: "from"; module: string | null; names: string[]; level: number };

export const normalizeProjectInsightRepoPath = (input: string): string => input.replace(/\\/g, "/").replace(/^\.\//, "").trim();

const shouldIgnoreProjectInsightDirectoryName = (name: string): boolean => {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) {
    return true;
  }
  if (PROJECT_INSIGHT_IGNORED_DIRECTORY_NAMES.has(trimmed) || PROJECT_INSIGHT_IGNORED_DIRECTORY_NAMES.has(normalized)) {
    return true;
  }
  if (/^(cache|caches|generated|gen|build|dist|out|tmp|temp)([-_.].+)?$/i.test(trimmed)) {
    return true;
  }
  if (/^__.*__$/.test(trimmed) && trimmed !== "__tests__" && trimmed !== "__mocks__") {
    return true;
  }
  return false;
};

export const shouldIgnoreProjectInsightPath = (path: string): boolean => {
  const normalized = normalizeProjectInsightRepoPath(path);
  if (!normalized) {
    return true;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => shouldIgnoreProjectInsightDirectoryName(segment))) {
    return true;
  }
  const lower = normalized.toLowerCase();
  if (
    lower.includes("/cache/") ||
    lower.includes("/caches/") ||
    lower.includes("/generated/") ||
    lower.includes("/gen/") ||
    lower.includes("/build/") ||
    lower.includes("/dist/") ||
    lower.includes("/out/") ||
    lower.includes("/coverage/") ||
    lower.includes("/vendor/") ||
    lower.includes("/deps/") ||
    lower.includes("/node_modules/")
  ) {
    return true;
  }
  if (
    /(^|\/)(chunk|vendor|bundle|runtime|polyfills|main|styles)-[a-z0-9]{6,}\.(js|mjs|cjs|css|map)$/i.test(lower) ||
    /(^|\/)[a-z0-9_-]+\.[a-f0-9]{8,}\.(js|mjs|cjs|css|map)$/i.test(lower) ||
    lower.endsWith(".min.js") ||
    lower.endsWith(".min.css") ||
    lower.endsWith(".map")
  ) {
    return true;
  }
  return false;
};

export const listDependencySourceFilesForProjectGraph = (repoPath: string): string[] => {
  const files: string[] = [];

  const walk = (currentPath: string) => {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!shouldIgnoreProjectInsightDirectoryName(entry.name)) {
          walk(join(currentPath, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (!DEPENDENCY_SOURCE_EXTENSIONS.has(extension)) {
        continue;
      }
      const normalized = normalizeProjectInsightRepoPath(relative(repoPath, join(currentPath, entry.name)));
      if (!shouldIgnoreProjectInsightPath(normalized)) {
        files.push(normalized);
      }
    }
  };

  walk(repoPath);
  files.sort((left, right) => left.localeCompare(right));
  return files;
};

const detectJavaPackage = (content: string): string | null => {
  const match = /^[ \t]*package[ \t]+([A-Za-z_][\w.]*)[ \t]*;/m.exec(content);
  return match?.[1]?.trim() || null;
};

const buildJavaIndexes = (repoPath: string, sourceFiles: string[]): JavaGraphIndexes => {
  const classToFile = new Map<string, string>();
  const packageToFile = new Map<string, string>();

  for (const source of sourceFiles.filter((file) => extname(file).toLowerCase() === ".java")) {
    const absoluteSource = join(repoPath, source);
    const content = readFileSync(absoluteSource, "utf8");
    const packageName = detectJavaPackage(content);
    const className = basename(source, ".java");
    const typeName = packageName ? `${packageName}.${className}` : className;
    if (!classToFile.has(typeName)) {
      classToFile.set(typeName, source);
    }
    if (packageName && !packageToFile.has(packageName)) {
      packageToFile.set(packageName, source);
    }
  }

  return { classToFile, packageToFile };
};

const readGoModulePath = (repoPath: string): string | null => {
  const goModPath = join(repoPath, "go.mod");
  if (!existsSync(goModPath)) {
    return null;
  }
  const content = readFileSync(goModPath, "utf8");
  const match = /^[ \t]*module[ \t]+(\S+)[ \t]*$/m.exec(content);
  return match?.[1]?.trim() || null;
};

const buildGoIndexes = (repoPath: string, sourceFiles: string[]): GoGraphIndexes => {
  const modulePath = readGoModulePath(repoPath);
  const importPathToFile = new Map<string, string>();
  if (!modulePath) {
    return { modulePath: null, importPathToFile };
  }

  for (const source of sourceFiles.filter((file) => extname(file).toLowerCase() === ".go")) {
    const normalizedDir = normalizeProjectInsightRepoPath(dirname(source));
    const importPath = normalizedDir && normalizedDir !== "."
      ? `${modulePath}/${normalizedDir}`
      : modulePath;
    if (!importPathToFile.has(importPath)) {
      importPathToFile.set(importPath, source);
    }
  }

  return { modulePath, importPathToFile };
};

const buildPythonModuleCandidates = (source: string): string[] => {
  const normalized = normalizeProjectInsightRepoPath(source);
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1] ?? "";
  const isInit = fileName === "__init__.py";
  const withoutExtension = normalized.replace(/\.py$/i, "");
  const directCandidate = isInit ? dirname(withoutExtension).replace(/\\/g, "/") : withoutExtension;
  const candidates = new Set<string>();
  if (directCandidate && directCandidate !== ".") {
    candidates.add(directCandidate.replace(/\//g, "."));
  }

  if (segments.length > 1 && PYTHON_SOURCE_ROOT_SEGMENTS.has(segments[0] ?? "")) {
    const stripped = segments.slice(1);
    if (stripped.length > 0) {
      const strippedFileName = stripped[stripped.length - 1] ?? "";
      const strippedCandidate = strippedFileName === "__init__.py"
        ? stripped.slice(0, -1).join(".")
        : stripped.join(".").replace(/\.py$/i, "");
      if (strippedCandidate) {
        candidates.add(strippedCandidate);
      }
    }
  }

  return [...candidates].filter(Boolean);
};

const buildPythonIndexes = (sourceFiles: string[]): PythonGraphIndexes => {
  const moduleToFile = new Map<string, string>();
  for (const source of sourceFiles.filter((file) => extname(file).toLowerCase() === ".py")) {
    for (const candidate of buildPythonModuleCandidates(source)) {
      if (!moduleToFile.has(candidate)) {
        moduleToFile.set(candidate, source);
      }
    }
  }
  return { moduleToFile };
};

const rustModuleCandidateFromPath = (source: string): string | null => {
  const normalized = normalizeProjectInsightRepoPath(source);
  if (!normalized.startsWith("src/")) {
    return null;
  }
  const relativeSource = normalized.slice("src/".length);
  if (relativeSource === "lib.rs" || relativeSource === "main.rs") {
    return "crate";
  }
  if (relativeSource.endsWith("/mod.rs")) {
    return `crate::${relativeSource.slice(0, -"/mod.rs".length).replace(/\//g, "::")}`;
  }
  if (relativeSource.endsWith(".rs")) {
    return `crate::${relativeSource.slice(0, -".rs".length).replace(/\//g, "::")}`;
  }
  return null;
};

const buildRustIndexes = (sourceFiles: string[]): RustGraphIndexes => {
  const moduleToFile = new Map<string, string>();
  for (const source of sourceFiles.filter((file) => extname(file).toLowerCase() === ".rs")) {
    const candidate = rustModuleCandidateFromPath(source);
    if (candidate && !moduleToFile.has(candidate)) {
      moduleToFile.set(candidate, source);
    }
  }
  return { moduleToFile };
};

const buildDependencyGraphIndexes = (repoPath: string, sourceFiles: string[]): DependencyGraphIndexes => ({
  java: buildJavaIndexes(repoPath, sourceFiles),
  go: buildGoIndexes(repoPath, sourceFiles),
  python: buildPythonIndexes(sourceFiles),
  rust: buildRustIndexes(sourceFiles),
});

const extractJsLikeLocalDependencies = (repoPath: string, absoluteSource: string, sourceSet: Set<string>): string[] => {
  const content = readFileSync(absoluteSource, "utf8");
  const patterns = [
    /(?:import|export)\s+(?:[^"'`]+\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  const specifiers = new Set<string>();
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier?.startsWith(".")) {
        specifiers.add(specifier);
      }
    }
  }

  const sourceDir = dirname(absoluteSource);
  const resolved = new Set<string>();
  for (const specifier of specifiers) {
    const baseAbsolute = join(sourceDir, specifier);
    const candidates = [
      baseAbsolute,
      `${baseAbsolute}.ts`,
      `${baseAbsolute}.tsx`,
      `${baseAbsolute}.js`,
      `${baseAbsolute}.jsx`,
      `${baseAbsolute}.mjs`,
      `${baseAbsolute}.cjs`,
      join(baseAbsolute, "index.ts"),
      join(baseAbsolute, "index.tsx"),
      join(baseAbsolute, "index.js"),
      join(baseAbsolute, "index.jsx"),
      join(baseAbsolute, "index.mjs"),
      join(baseAbsolute, "index.cjs"),
    ];
    for (const candidate of candidates) {
      const relativeCandidate = normalizeProjectInsightRepoPath(relative(repoPath, candidate));
      if (sourceSet.has(relativeCandidate)) {
        resolved.add(relativeCandidate);
        break;
      }
    }
  }

  return [...resolved];
};

const extractJavaDependencies = (content: string, indexes: JavaGraphIndexes): string[] => {
  const resolved = new Set<string>();
  const importPattern = /^[ \t]*import\s+(?:static\s+)?([A-Za-z_][\w$]*(?:\.[\w$*]+)+)[ \t]*;/gm;
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1]?.trim();
    if (!specifier) {
      continue;
    }
    if (specifier.endsWith(".*")) {
      const packageName = specifier.slice(0, -2);
      const target = indexes.packageToFile.get(packageName);
      if (target) {
        resolved.add(target);
      }
      continue;
    }
    const direct = indexes.classToFile.get(specifier);
    if (direct) {
      resolved.add(direct);
    }
  }
  return [...resolved];
};

const extractGoImportPaths = (content: string): string[] => {
  const importPaths = new Set<string>();
  const blockPattern = /^[ \t]*import[ \t]*\(([\s\S]*?)^[ \t]*\)/gm;
  for (const match of content.matchAll(blockPattern)) {
    const block = match[1] ?? "";
    for (const pathMatch of block.matchAll(/"([^"]+)"/g)) {
      const importPath = pathMatch[1]?.trim();
      if (importPath) {
        importPaths.add(importPath);
      }
    }
  }
  const singlePattern = /^[ \t]*import[ \t]+(?:[.\w]+[ \t]+)?"([^"]+)"/gm;
  for (const match of content.matchAll(singlePattern)) {
    const importPath = match[1]?.trim();
    if (importPath) {
      importPaths.add(importPath);
    }
  }
  return [...importPaths];
};

const resolveGoDependencies = (content: string, indexes: GoGraphIndexes): string[] => {
  if (!indexes.modulePath) {
    return [];
  }
  const resolved = new Set<string>();
  for (const importPath of extractGoImportPaths(content)) {
    if (importPath === indexes.modulePath || importPath.startsWith(`${indexes.modulePath}/`)) {
      const target = indexes.importPathToFile.get(importPath);
      if (target) {
        resolved.add(target);
      }
    }
  }
  return [...resolved];
};

/** Strips a trailing ` as alias` clause from an import segment without regex backtracking. */
const stripImportAlias = (value: string): string => {
  const parts = value.trim().split(/\s+/);
  const aliasIndex = parts.findIndex((part) => part.toLowerCase() === "as");
  return aliasIndex >= 0 ? parts.slice(0, aliasIndex).join(" ") : value;
};

const parsePythonImports = (content: string): PythonImportEntry[] => {
  const entries: PythonImportEntry[] = [];
  const importPattern = /^[ \t]*import[ \t]+([^\n#]+)/gm;
  for (const match of content.matchAll(importPattern)) {
    const rawModules = match[1] ?? "";
    for (const part of rawModules.split(",")) {
      const moduleName = stripImportAlias(part).trim();
      if (moduleName) {
        entries.push({ kind: "import", module: moduleName });
      }
    }
  }

  const fromPattern = /^[ \t]*from[ \t]+(\.*)([A-Za-z_][\w.]*)?[ \t]+import[ \t]+([^\n#]+)/gm;
  for (const match of content.matchAll(fromPattern)) {
    const dots = match[1] ?? "";
    const moduleName = match[2]?.trim() || null;
    const importedNames = (match[3] ?? "")
      .split(",")
      .map((part) => stripImportAlias(part.replace(/[()]/g, "")).trim())
      .filter(Boolean);
    entries.push({
      kind: "from",
      module: moduleName,
      names: importedNames,
      level: dots.length,
    });
  }

  return entries;
};

const canonicalPythonModulePath = (source: string): string => {
  const normalized = normalizeProjectInsightRepoPath(source);
  if (normalized.endsWith("/__init__.py")) {
    return normalized.slice(0, -"/__init__.py".length).replace(/\//g, ".");
  }
  return normalized.replace(/\.py$/i, "").replace(/\//g, ".");
};

const resolvePythonDependencies = (source: string, content: string, indexes: PythonGraphIndexes): string[] => {
  const resolved = new Set<string>();
  const currentModulePath = canonicalPythonModulePath(source);
  const currentContainer = source.endsWith("/__init__.py")
    ? currentModulePath
    : currentModulePath.split(".").slice(0, -1).join(".");

  for (const entry of parsePythonImports(content)) {
    if (entry.kind === "import") {
      const target = indexes.moduleToFile.get(entry.module);
      if (target) {
        resolved.add(target);
      }
      continue;
    }

    let baseParts = entry.level > 0 && currentContainer ? currentContainer.split(".") : [];
    if (entry.level > 0) {
      baseParts = baseParts.slice(0, Math.max(0, baseParts.length - (entry.level - 1)));
    }
    const moduleBase = entry.module ? [...baseParts, ...entry.module.split(".").filter(Boolean)].join(".") : baseParts.join(".");
    for (const importedName of entry.names) {
      if (importedName === "*") {
        continue;
      }
      const directCandidate = moduleBase ? `${moduleBase}.${importedName}` : importedName;
      const directTarget = indexes.moduleToFile.get(directCandidate);
      if (directTarget) {
        resolved.add(directTarget);
      }
    }
    if (moduleBase) {
      const moduleTarget = indexes.moduleToFile.get(moduleBase);
      if (moduleTarget) {
        resolved.add(moduleTarget);
      }
    }
  }

  return [...resolved];
};

const canonicalRustModulePath = (source: string): string | null => rustModuleCandidateFromPath(source);

const resolveRustModulePath = (candidate: string, indexes: RustGraphIndexes): string | null => {
  let current = candidate;
  while (current) {
    const target = indexes.moduleToFile.get(current);
    if (target) {
      return target;
    }
    const trimIndex = current.lastIndexOf("::");
    if (trimIndex === -1) {
      break;
    }
    current = current.slice(0, trimIndex);
  }
  return null;
};

const expandRustUseExpression = (expression: string): string[] => {
  const trimmed = stripImportAlias(expression.trim());
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart === -1 || braceEnd === -1 || braceEnd < braceStart) {
    return [trimmed];
  }

  let prefix = trimmed.slice(0, braceStart);
  while (prefix.endsWith(":")) {
    prefix = prefix.slice(0, -1);
  }
  const inner = trimmed.slice(braceStart + 1, braceEnd);
  return inner
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `${prefix}::${part}`);
};

const normalizeRustPath = (currentModulePath: string | null, rawPath: string): string | null => {
  const trimmed = rawPath.trim().replace(/^::/, "");
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("crate::")) {
    return trimmed;
  }
  const currentParts = currentModulePath ? currentModulePath.split("::") : ["crate"];
  const currentModuleParts = currentParts;
  const parentParts = currentParts.length > 1 ? currentParts.slice(0, -1) : currentParts;

  if (trimmed.startsWith("self::")) {
    return [...currentModuleParts, ...trimmed.slice("self::".length).split("::")].filter(Boolean).join("::");
  }
  if (trimmed.startsWith("super::")) {
    return [...parentParts, ...trimmed.slice("super::".length).split("::")].filter(Boolean).join("::");
  }
  if (trimmed === "self") {
    return currentModuleParts.join("::");
  }
  if (trimmed === "super") {
    return parentParts.join("::");
  }
  return null;
};

const resolveRustDependencies = (source: string, content: string, indexes: RustGraphIndexes): string[] => {
  const resolved = new Set<string>();
  const currentModulePath = canonicalRustModulePath(source);

  const usePattern = /(?:^|\n)[ \t]*(?:pub\s+)?use\s+([^;]+);/g;
  for (const match of content.matchAll(usePattern)) {
    for (const expandedPath of expandRustUseExpression(match[1] ?? "")) {
      const normalizedPath = normalizeRustPath(currentModulePath, expandedPath) ?? expandedPath.trim();
      const target = resolveRustModulePath(normalizedPath, indexes);
      if (target) {
        resolved.add(target);
      }
    }
  }

  const modPattern = /^[ \t]*(?:pub\s+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm;
  for (const match of content.matchAll(modPattern)) {
    const modName = match[1]?.trim();
    if (!modName) {
      continue;
    }
    let basePath = `crate::${modName}`;
    if (currentModulePath && currentModulePath !== "crate") {
      basePath = `${currentModulePath}::${modName}`;
    }
    const target = resolveRustModulePath(basePath, indexes);
    if (target) {
      resolved.add(target);
    }
  }

  return [...resolved];
};

const extractDependenciesForSourceFile = (
  repoPath: string,
  source: string,
  sourceSet: Set<string>,
  indexes: DependencyGraphIndexes,
): string[] => {
  const absoluteSource = join(repoPath, source);
  const extension = extname(source).toLowerCase();
  const content = readFileSync(absoluteSource, "utf8");

  switch (extension) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return extractJsLikeLocalDependencies(repoPath, absoluteSource, sourceSet);
    case ".java":
      return extractJavaDependencies(content, indexes.java);
    case ".go":
      return resolveGoDependencies(content, indexes.go);
    case ".py":
      return resolvePythonDependencies(source, content, indexes.python);
    case ".rs":
      return resolveRustDependencies(source, content, indexes.rust);
    default:
      return [];
  }
};

export const buildDependencyGraphSnapshotForProjectGraph = (repoPath: string): DependencyGraphSnapshot => {
  const sourceFiles = listDependencySourceFilesForProjectGraph(repoPath);
  const sourceSet = new Set(sourceFiles);
  const indexes = buildDependencyGraphIndexes(repoPath, sourceFiles);

  return {
    modules: sourceFiles.map((source) => ({
      source,
      dependencies: extractDependenciesForSourceFile(repoPath, source, sourceSet, indexes).map((resolved) => ({ resolved })),
    })),
  };
};
