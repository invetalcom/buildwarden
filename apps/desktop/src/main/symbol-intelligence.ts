import { readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { CODE_INTELLIGENCE_DISPATCH_TOOL_NAME, type CodeIntelligenceToolName, type RunToolCall, type RunToolResult } from "@buildwarden/shared";

const MAX_INDEX_FILES = 2_500;
const MAX_INDEX_FILE_BYTES = 300_000;
const MAX_RESULT_CHARS = 24_000;
const DEFAULT_RESULT_LIMIT = 40;
const MAX_RESULT_LIMIT = 120;
const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", "node_modules", "vendor", "dist", "build", "out",
  "coverage", ".next", ".nuxt", ".cache", ".venv", "venv", "__pycache__", "target", "bin", "obj",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".h": "c", ".hh": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".go": "go", ".java": "java", ".js": "javascript", ".jsx": "javascript",
  ".kt": "kotlin", ".kts": "kotlin", ".m": "objective-c", ".mm": "objective-cpp", ".php": "php",
  ".pl": "perl", ".pm": "perl", ".py": "python", ".rb": "ruby", ".rs": "rust", ".scala": "scala",
  ".swift": "swift", ".ts": "typescript", ".tsx": "typescript", ".vue": "vue", ".svelte": "svelte",
};

type SymbolKind = "class" | "interface" | "type" | "enum" | "function" | "method" | "variable" | "module" | "namespace";
type Precision = "structural" | "candidate";

interface IndexedSymbol {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  endLine: number;
  signature: string;
  language: string;
  precision: Precision;
}

interface DependencyEdge {
  from: string;
  to: string;
  line: number;
  kind: "import" | "include" | "require" | "use";
  precision: Precision;
}

interface IndexedFile {
  path: string;
  language: string;
  lines: string[];
  symbols: IndexedSymbol[];
  dependencies: DependencyEdge[];
}

interface CodeIndex {
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  dependencies: DependencyEdge[];
  skippedFiles: number;
  truncated: boolean;
}

type SymbolPattern = { kind: SymbolKind; expression: RegExp; nameGroup?: number; precision?: Precision };

const COMMON_TYPE_PATTERNS: SymbolPattern[] = [
  { kind: "class", expression: /^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|sealed\s+)*class\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "interface", expression: /^\s*(?:export\s+)?(?:public\s+)?interface\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "enum", expression: /^\s*(?:export\s+)?(?:public\s+)?enum\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "namespace", expression: /^\s*(?:export\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)\b/ },
];

const PATTERNS_BY_LANGUAGE: Record<string, SymbolPattern[]> = {
  typescript: [
    ...COMMON_TYPE_PATTERNS,
    { kind: "type", expression: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/ },
    { kind: "function", expression: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/ },
    { kind: "function", expression: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: "variable", expression: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/ },
  ],
  javascript: [
    ...COMMON_TYPE_PATTERNS,
    { kind: "function", expression: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/ },
    { kind: "function", expression: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: "variable", expression: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/ },
  ],
  python: [
    { kind: "class", expression: /^\s*class\s+([A-Za-z_]\w*)\b/ },
    { kind: "function", expression: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  java: [
    ...COMMON_TYPE_PATTERNS,
    { kind: "type", expression: /^\s*(?:public\s+)?record\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "method", expression: /^\s*(?:@[\w.]+\s*)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+(?:[\w<>?,.[\]]+\s+)+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?(?:{|;).*$/ },
  ],
  perl: [
    { kind: "module", expression: /^\s*package\s+([A-Za-z_]\w*(?:::\w+)*)\s*;/ },
    { kind: "function", expression: /^\s*sub\s+([A-Za-z_]\w*)\b/ },
  ],
  go: [
    { kind: "type", expression: /^\s*type\s+([A-Za-z_]\w*)\s+/ },
    { kind: "function", expression: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/ },
  ],
  rust: [
    { kind: "class", expression: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)\b/ },
    { kind: "enum", expression: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)\b/ },
    { kind: "interface", expression: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)\b/ },
    { kind: "function", expression: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/ },
  ],
  ruby: [
    { kind: "class", expression: /^\s*class\s+([A-Za-z_]\w*(?:::\w+)*)\b/ },
    { kind: "module", expression: /^\s*module\s+([A-Za-z_]\w*(?:::\w+)*)\b/ },
    { kind: "function", expression: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)\b/ },
  ],
  php: [
    ...COMMON_TYPE_PATTERNS,
    { kind: "function", expression: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/ },
  ],
};

const GENERIC_PATTERNS: SymbolPattern[] = [
  ...COMMON_TYPE_PATTERNS.map((pattern) => ({ ...pattern, precision: "candidate" as const })),
  { kind: "function", expression: /^\s*(?:pub(?:lic)?\s+|private\s+|protected\s+|static\s+|async\s+|final\s+)*[\w:<>,.?[\]*&]+\s+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:{|=>)/, precision: "candidate" },
];

const toPosix = (value: string): string => value.replace(/\\/g, "/");
const truncate = (value: string): string => value.length <= MAX_RESULT_CHARS ? value : `${value.slice(0, MAX_RESULT_CHARS)}\n…truncated`;
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeFilterPath = (value: unknown): string => {
  const raw = String(value ?? ".").trim().replace(/\\/g, "/");
  if (!raw || raw === ".") return ".";
  if (isAbsolute(raw) || raw === ".." || raw.startsWith("../") || raw.includes("/../")) {
    throw new Error("Code-intelligence paths must stay inside the run workspace.");
  }
  return raw.replace(/^\.\//, "").replace(/\/$/, "");
};

const isWithinFilter = (path: string, filter: string): boolean =>
  filter === "." || path === filter || path.startsWith(`${filter}/`);

const resultLimit = (value: unknown): number => {
  const parsed = Number(value ?? DEFAULT_RESULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_RESULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_RESULT_LIMIT);
};

const sourceLanguage = (path: string): string | null => LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? null;

const walkSourceFiles = async (root: string): Promise<{ paths: string[]; truncated: boolean }> => {
  const paths: string[] = [];
  const pending = [root];
  let truncated = false;
  while (pending.length > 0 && paths.length < MAX_INDEX_FILES) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (paths.length >= MAX_INDEX_FILES) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) pending.push(absolutePath);
      } else if (entry.isFile() && sourceLanguage(entry.name)) {
        paths.push(absolutePath);
      }
    }
  }
  return { paths, truncated };
};

const stripLineForBraceCounting = (line: string): string =>
  line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "").replace(/\/\/.*$/, "").replace(/#.*$/, "");

const findBraceEnd = (lines: string[], startIndex: number): number | null => {
  let depth = 0;
  let started = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const source = stripLineForBraceCounting(lines[index]!);
    for (const char of source) {
      if (char === "{") { depth += 1; started = true; }
      if (char === "}") depth -= 1;
    }
    if (started && depth <= 0) return index + 1;
  }
  return null;
};

const findIndentEnd = (lines: string[], startIndex: number): number => {
  const indentation = lines[startIndex]!.match(/^\s*/)?.[0].length ?? 0;
  let lastContentLine = startIndex + 1;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const nextIndentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (nextIndentation <= indentation) break;
    lastContentLine = index + 1;
  }
  return lastContentLine;
};

const symbolEndLine = (language: string, lines: string[], startIndex: number): number => {
  if (language === "python" || language === "ruby") return findIndentEnd(lines, startIndex);
  return findBraceEnd(lines, startIndex) ?? startIndex + 1;
};

const extractSymbols = (path: string, language: string, lines: string[]): IndexedSymbol[] => {
  const patterns = PATTERNS_BY_LANGUAGE[language] ?? GENERIC_PATTERNS;
  const symbols: IndexedSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (const pattern of patterns) {
      const match = pattern.expression.exec(line);
      const name = match?.[pattern.nameGroup ?? 1];
      if (!name) continue;
      const existing = symbols.find((symbol) => symbol.line === index + 1 && symbol.name === name);
      if (!existing) {
        const nested = /^\s+/.test(line);
        symbols.push({
          name,
          kind: pattern.kind === "function" && nested ? "method" : pattern.kind,
          path,
          line: index + 1,
          endLine: symbolEndLine(language, lines, index),
          signature: line.trim().slice(0, 300),
          language,
          precision: pattern.precision ?? "structural",
        });
      }
      break;
    }
  }
  return symbols;
};

const dependencyMatchers: Array<{ kind: DependencyEdge["kind"]; expression: RegExp }> = [
  { kind: "import", expression: /^\s*(?:import|export)\b(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/ },
  { kind: "require", expression: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/ },
  { kind: "import", expression: /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/ },
  { kind: "import", expression: /^\s*import\s+([A-Za-z_][\w.]*)/ },
  { kind: "include", expression: /^\s*#\s*include\s*[<"]([^>"]+)[>"]/ },
  { kind: "use", expression: /^\s*use\s+([A-Za-z_][\w:]*)\b/ },
];

const extractDependencies = (path: string, lines: string[]): DependencyEdge[] => {
  const result: DependencyEdge[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    for (const matcher of dependencyMatchers) {
      const target = matcher.expression.exec(lines[index]!)?.[1];
      if (target) {
        result.push({ from: path, to: target, line: index + 1, kind: matcher.kind, precision: "structural" });
        break;
      }
    }
  }
  return result;
};

const buildIndex = async (root: string): Promise<CodeIndex> => {
  const discovered = await walkSourceFiles(root);
  const files: IndexedFile[] = [];
  let skippedFiles = 0;
  for (const absolutePath of discovered.paths) {
    try {
      const fileStat = await stat(absolutePath);
      if (fileStat.size > MAX_INDEX_FILE_BYTES) { skippedFiles += 1; continue; }
      const content = await readFile(absolutePath, "utf8");
      if (content.includes("\u0000")) { skippedFiles += 1; continue; }
      const path = toPosix(relative(root, absolutePath));
      const language = sourceLanguage(path)!;
      const lines = content.replace(/\r\n?/g, "\n").split("\n");
      files.push({ path, language, lines, symbols: extractSymbols(path, language, lines), dependencies: extractDependencies(path, lines) });
    } catch {
      skippedFiles += 1;
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    symbols: files.flatMap((file) => file.symbols),
    dependencies: files.flatMap((file) => file.dependencies),
    skippedFiles,
    truncated: discovered.truncated,
  };
};

const symbolLocation = (symbol: IndexedSymbol): string =>
  `${symbol.path}:${String(symbol.line)}-${String(symbol.endLine)} ${symbol.kind} ${symbol.name} — ${symbol.signature}`;

const symbolsMatching = (index: CodeIndex, name: string, pathFilter: string): IndexedSymbol[] =>
  index.symbols.filter((symbol) => symbol.name === name && isWithinFilter(symbol.path, pathFilter));

export class SymbolIntelligenceIndex {
  private cachedIndex: Promise<CodeIndex> | null = null;

  constructor(private readonly root: string) {}

  invalidate(): void {
    this.cachedIndex = null;
  }

  get(): Promise<CodeIndex> {
    this.cachedIndex ??= buildIndex(this.root);
    return this.cachedIndex;
  }
}

const executeCodebaseMap = async (index: CodeIndex, args: Record<string, unknown>) => {
  const pathFilter = normalizeFilterPath(args.path);
  const maxFiles = resultLimit(args.maxFiles);
  const files = index.files.filter((file) => isWithinFilter(file.path, pathFilter)).slice(0, maxFiles);
  const lines = files.flatMap((file) => [
    `${file.path} [${file.language}]${file.dependencies.length ? ` deps:${String(file.dependencies.length)}` : ""}`,
    ...file.symbols.slice(0, 18).map((symbol) => `  ${symbol.kind} ${symbol.name} L${String(symbol.line)}-${String(symbol.endLine)}`),
    ...(file.symbols.length > 18 ? [`  …${String(file.symbols.length - 18)} more symbols`] : []),
  ]);
  return {
    content: truncate(lines.length ? lines.join("\n") : "No supported source files found."),
    metadata: { path: pathFilter, indexedFiles: index.files.length, returnedFiles: files.length, indexedSymbols: index.symbols.length, skippedFiles: index.skippedFiles, truncated: index.truncated || files.length < index.files.filter((file) => isWithinFilter(file.path, pathFilter)).length },
  };
};

const executeSearchSymbols = async (index: CodeIndex, args: Record<string, unknown>) => {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("search_symbols requires a non-empty query.");
  const pathFilter = normalizeFilterPath(args.path);
  const kind = String(args.kind ?? "").trim();
  const lowerQuery = query.toLowerCase();
  const matches = index.symbols
    .filter((symbol) => isWithinFilter(symbol.path, pathFilter) && (!kind || symbol.kind === kind) && symbol.name.toLowerCase().includes(lowerQuery))
    .sort((left, right) => Number(right.name.toLowerCase() === lowerQuery) - Number(left.name.toLowerCase() === lowerQuery) || left.name.localeCompare(right.name))
    .slice(0, resultLimit(args.maxResults));
  return { content: matches.length ? matches.map(symbolLocation).join("\n") : "No matching symbols found.", metadata: { query, path: pathFilter, kind: kind || null, resultCount: matches.length } };
};

const executeFileOutline = async (index: CodeIndex, args: Record<string, unknown>) => {
  const path = normalizeFilterPath(args.path);
  if (path === ".") throw new Error("file_outline requires a source file path.");
  const file = index.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`No indexed source file found at ${path}.`);
  return { content: file.symbols.length ? file.symbols.map(symbolLocation).join("\n") : `No symbols recognized in ${path}.`, metadata: { path, language: file.language, symbolCount: file.symbols.length, precision: file.symbols.some((symbol) => symbol.precision === "candidate") ? "mixed" : "structural" } };
};

const executeReadSymbol = async (index: CodeIndex, args: Record<string, unknown>) => {
  const name = String(args.name ?? "").trim();
  if (!name) throw new Error("read_symbol requires an exact symbol name.");
  const pathFilter = normalizeFilterPath(args.path);
  const matches = symbolsMatching(index, name, pathFilter).slice(0, 5);
  if (!matches.length) return { content: "No exact symbol definition found. Try search_symbols first.", metadata: { name, path: pathFilter, resultCount: 0 } };
  const snippets = matches.map((symbol) => {
    const file = index.files.find((candidate) => candidate.path === symbol.path)!;
    const source = file.lines.slice(symbol.line - 1, Math.min(symbol.endLine, symbol.line + 199)).map((line, offset) => `${String(symbol.line + offset)}|${line}`).join("\n");
    return `${symbolLocation(symbol)}\n${source}`;
  });
  return { content: truncate(snippets.join("\n\n")), metadata: { name, path: pathFilter, resultCount: matches.length, truncated: matches.some((symbol) => symbol.endLine - symbol.line >= 200) } };
};

const executeResolveSymbol = async (index: CodeIndex, args: Record<string, unknown>) => {
  const name = String(args.name ?? "").trim();
  if (!name) throw new Error("resolve_symbol requires an exact symbol name.");
  const pathFilter = normalizeFilterPath(args.path);
  const fromPath = normalizeFilterPath(args.fromPath);
  const fromDirectory = fromPath === "." ? "" : fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const matches = symbolsMatching(index, name, pathFilter)
    .map((symbol) => ({ symbol, rank: symbol.path === fromPath ? 0 : fromDirectory && symbol.path.startsWith(`${fromDirectory}/`) ? 1 : 2 }))
    .sort((left, right) => left.rank - right.rank || left.symbol.path.localeCompare(right.symbol.path))
    .slice(0, resultLimit(args.maxResults));
  return { content: matches.length ? matches.map(({ symbol, rank }) => `[rank:${String(rank)}] ${symbolLocation(symbol)}`).join("\n") : "No exact symbol definition found.", metadata: { name, path: pathFilter, fromPath: fromPath === "." ? null : fromPath, resultCount: matches.length, resolution: matches.length === 1 ? "unique" : matches.length > 1 ? "ambiguous" : "unresolved" } };
};

const executeFindReferences = async (index: CodeIndex, args: Record<string, unknown>) => {
  const name = String(args.name ?? "").trim();
  if (!name) throw new Error("find_references requires an exact symbol name.");
  const pathFilter = normalizeFilterPath(args.path);
  const expression = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
  const definitions = new Set(symbolsMatching(index, name, pathFilter).map((symbol) => `${symbol.path}:${String(symbol.line)}`));
  const references: string[] = [];
  const limit = resultLimit(args.maxResults);
  for (const file of index.files) {
    if (!isWithinFilter(file.path, pathFilter)) continue;
    for (let indexLine = 0; indexLine < file.lines.length; indexLine += 1) {
      expression.lastIndex = 0;
      if (expression.test(file.lines[indexLine]!) && !definitions.has(`${file.path}:${String(indexLine + 1)}`)) {
        references.push(`${file.path}:${String(indexLine + 1)} ${file.lines[indexLine]!.trim().slice(0, 300)}`);
        if (references.length >= limit) break;
      }
    }
    if (references.length >= limit) break;
  }
  return { content: references.length ? references.join("\n") : "No lexical references found.", metadata: { name, path: pathFilter, resultCount: references.length, precision: "candidate", note: "References are lexical candidates; dynamic dispatch and generated code may be incomplete." } };
};

const executeDependencyEdges = async (index: CodeIndex, args: Record<string, unknown>) => {
  const pathFilter = normalizeFilterPath(args.path);
  const edges = index.dependencies.filter((edge) => isWithinFilter(edge.from, pathFilter)).slice(0, resultLimit(args.maxResults));
  return { content: edges.length ? edges.map((edge) => `${edge.from}:${String(edge.line)} -${edge.kind}-> ${edge.to}`).join("\n") : "No dependency edges recognized.", metadata: { path: pathFilter, resultCount: edges.length, precision: "structural" } };
};

export const executeCodeIntelligenceOperation = async (
  symbolIndex: SymbolIntelligenceIndex,
  operation: CodeIntelligenceToolName,
  call: RunToolCall & { name: typeof CODE_INTELLIGENCE_DISPATCH_TOOL_NAME },
): Promise<RunToolResult> => {
  const index = await symbolIndex.get();
  const result = await (async () => {
    switch (operation) {
      case "codebase_map": return executeCodebaseMap(index, call.arguments);
      case "search_symbols": return executeSearchSymbols(index, call.arguments);
      case "file_outline": return executeFileOutline(index, call.arguments);
      case "read_symbol": return executeReadSymbol(index, call.arguments);
      case "resolve_symbol": return executeResolveSymbol(index, call.arguments);
      case "find_references": return executeFindReferences(index, call.arguments);
      case "dependency_edges": return executeDependencyEdges(index, call.arguments);
    }
  })();
  return {
    toolCallId: call.id,
    name: CODE_INTELLIGENCE_DISPATCH_TOOL_NAME,
    ok: true,
    content: truncate(result.content),
    metadata: { operation, ...result.metadata },
  };
};
