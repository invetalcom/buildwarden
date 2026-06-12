import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import type { HarnessToolContext, RunMode, RunToolCall, RunToolDefinition, RunToolName, RunToolResult, ShellApprovalDecision } from "@buildwarden/shared";
import { compileShellAllowlistRegExes } from "./shell-allowlist";

const MAX_FILE_BYTES = 120_000;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_MATCHES = 80;
const SEARCH_CONTEXT_RADIUS = 2;
/** Cap in-memory shell capture so very chatty commands do not grow without bound while streaming. */
const MAX_SHELL_STREAM_RAW_CHARS = MAX_OUTPUT_CHARS * 2;
const SHELL_STREAM_THROTTLE_MS = 75;
const TEXT_FILE_EXTENSIONS = /\.(cjs|css|go|html|java|js|json|jsx|md|mjs|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/i;
const SUSPICIOUS_WRITE_PLACEHOLDER_PATTERNS = [
  /^<updated>$/i,
  /^<insert.*>$/i,
  /^<replace.*>$/i,
  /^todo$/i,
  /^tbd$/i,
  /^same as above$/i,
  /^unchanged$/i,
];

const buildAgentShellEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const hasCiKey = Object.keys(env).some((key) => key.toLowerCase() === "ci");
  if (!hasCiKey) {
    env.CI = "true";
  }
  return env;
};

const TOOL_DEFINITIONS: RunToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the run worktree. Use this before editing files. Pass optional 1-based startLine/endLine to inspect a focused range of a large file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the worktree root." },
        startLine: { type: ["number", "null"], description: "Optional 1-based first line to read." },
        endLine: { type: ["number", "null"], description: "Optional 1-based final line to read, inclusive." },
      },
      required: ["path", "startLine", "endLine"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or replace a UTF-8 text file in the run worktree.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the worktree root." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace exact literal text in an existing file, or create a new file when old_string is empty.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path relative to the worktree root." },
        old_string: { type: "string", description: "Exact literal text to replace. Use empty string to create a new file." },
        new_string: { type: "string", description: "Replacement text, or full file contents when creating a new file." },
        expected_replacements: { type: "number", description: "Exact number of replacements expected.", minimum: 1 },
      },
      required: ["file_path", "old_string", "new_string", "expected_replacements"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file or directory inside the run worktree.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the worktree root." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_files",
    description: "List files in the run worktree, optionally below a relative subdirectory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: ["string", "null"], description: "Optional relative directory path." },
        maxEntries: { type: ["number", "null"], description: "Optional result cap." },
      },
      required: ["path", "maxEntries"],
      additionalProperties: false,
    },
  },
  {
    name: "search_repo",
    description: "Search text in the run worktree and return matching files and lines.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain text or regex-like query." },
        path: { type: ["string", "null"], description: "Optional relative search root." },
        maxMatches: { type: ["number", "null"], description: "Optional result cap." },
      },
      required: ["query", "path", "maxMatches"],
      additionalProperties: false,
    },
  },
  {
    name: "run_shell",
    description: "Run a safe non-interactive repo-local command for inspection or validation, such as git status, git diff, ls, pwd, rg, pnpm test, or npm run lint.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "A safe repo-local command." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

const TOOL_ALLOWLIST_BY_MODE: Record<RunMode, Set<RunToolDefinition["name"]>> = {
  code: new Set(["read_file", "write_file", "edit_file", "delete_file", "list_files", "search_repo", "run_shell"]),
  plan: new Set(["read_file", "list_files", "search_repo", "run_shell"]),
  ask: new Set(["read_file", "list_files", "search_repo", "run_shell"]),
};

/** Max characters stored for the activity-log unified diff preview (metadata). */
const MAX_WRITE_FILE_DIFF_CHARS = 100_000;

/**
 * Normalize text so line-based diff matches human intent: disk often has CRLF (Windows)
 * while model output uses LF, which would otherwise make every line look changed.
 */
const normalizeTextForDiff = (value: string): string =>
  value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const buildWriteFileUnifiedDiff = (
  posixPath: string,
  oldContent: string | null,
  newContent: string,
): string | null => {
  if (newContent.length > MAX_FILE_BYTES) {
    return null;
  }
  if (oldContent !== null && oldContent.length > MAX_FILE_BYTES) {
    return null;
  }
  if (oldContent !== null && oldContent === newContent) {
    return null;
  }

  const path = posixPath.replace(/\\/g, "/");
  const normalizedNew = normalizeTextForDiff(newContent);
  const newLines = normalizedNew.split("\n");

  let diff: string;
  if (oldContent === null) {
    diff = `diff --git a/${path} b/${path}\n`;
    diff += "new file mode 100644\n";
    diff += "--- /dev/null\n";
    diff += `+++ b/${path}\n`;
    diff += `@@ -0,0 +1,${newLines.length} @@\n`;
    for (const line of newLines) {
      diff += `+${line}\n`;
    }
  } else {
    const normalizedOld = normalizeTextForDiff(oldContent);
    if (normalizedOld === normalizedNew) {
      return null;
    }
    const patchBody = createTwoFilesPatch(`a/${path}`, `b/${path}`, normalizedOld, normalizedNew, "", "", {
      context: 3,
      headerOptions: FILE_HEADERS_ONLY,
      stripTrailingCr: true,
    });
    if (!patchBody?.trim()) {
      return null;
    }
    diff = `diff --git a/${path} b/${path}\n${patchBody}`;
  }

  if (diff.length > MAX_WRITE_FILE_DIFF_CHARS) {
    return `${diff.slice(0, MAX_WRITE_FILE_DIFF_CHARS)}\n# ... diff truncated for display\n`;
  }
  return diff;
};

const truncate = (value: string, maxChars = MAX_OUTPUT_CHARS) =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n... output truncated ...`;

const isTextFile = (path: string) => TEXT_FILE_EXTENSIONS.test(path);

const toPosix = (value: string) => value.replaceAll("\\", "/");

const detectLineEnding = (value: string) => (value.includes("\r\n") ? "\r\n" : "\n");

const countOccurrences = (haystack: string, needle: string) => {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const nextIndex = haystack.indexOf(needle, index);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    index = nextIndex + needle.length;
  }
};

const isSuspiciousWritePlaceholder = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return SUSPICIOUS_WRITE_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
};

const validateWriteFileRequest = ({
  rel,
  content,
  previousContent,
  wasReadEarlier,
}: {
  rel: string;
  content: string;
  previousContent: string | null;
  wasReadEarlier: boolean;
}) => {
  if (previousContent === null) {
    return;
  }

  const trimmed = content.trim();
  if (!wasReadEarlier) {
    throw new Error(`Refusing to overwrite existing file ${rel} before it has been read in this run. Use read_file first.`);
  }
  if (!trimmed) {
    throw new Error(`Refusing to overwrite existing file ${rel} with empty content.`);
  }
  if (isSuspiciousWritePlaceholder(trimmed)) {
    throw new Error(`Refusing to overwrite existing file ${rel} with placeholder content (${JSON.stringify(trimmed)}).`);
  }

  const previousTrimmedLength = previousContent.trim().length;
  const nextTrimmedLength = trimmed.length;
  if (previousTrimmedLength >= 200) {
    const minimumExpectedLength = Math.max(32, Math.floor(previousTrimmedLength * 0.05));
    if (nextTrimmedLength < minimumExpectedLength) {
      throw new Error(
        `Refusing to overwrite existing file ${rel} with suspiciously small content (${nextTrimmedLength} chars vs ${previousTrimmedLength} previously).`,
      );
    }
  }
};

const formatRelativePathHint = (inputPath: string) => {
  const trimmed = inputPath.trim();
  return trimmed ? trimmed : ".";
};

const isMissingPathError = (error: unknown): error is NodeJS.ErrnoException =>
  Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");

const findNearestExistingAncestor = async (
  root: string,
  inputPath: string,
): Promise<{ absolutePath: string; relativePath: string } | null> => {
  const normalized = formatRelativePathHint(inputPath);
  const segments = normalized
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (let index = segments.length; index >= 0; index -= 1) {
    const candidateRel = index === 0 ? "." : segments.slice(0, index).join("/");
    const candidateAbs = resolveWorktreePath(root, candidateRel);
    try {
      await stat(candidateAbs);
      return {
        absolutePath: candidateAbs,
        relativePath: toPosix(relative(root, candidateAbs)) || ".",
      };
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }
  }

  return null;
};

const listImmediateEntries = async (target: string, root: string, limit = 24): Promise<string[]> => {
  const children = await readdir(target, { withFileTypes: true });
  return children
    .filter((child) => child.name !== ".git" && child.name !== "node_modules")
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, limit)
    .map((child) => {
      const fullPath = resolve(target, child.name);
      const rel = toPosix(relative(root, fullPath)) || child.name;
      return child.isDirectory() ? `${rel}/` : rel;
    });
};

const buildMissingPathMessage = async (root: string, kind: "file" | "directory", inputPath: string) => {
  const lines = [
    `${kind === "file" ? "File" : "Directory"} not found in the run worktree: ${formatRelativePathHint(inputPath)}.`,
    "Paths must be relative to the worktree root.",
    "If the exact location is unknown, call list_files on . or a confirmed parent directory before retrying.",
  ];

  const nearest = await findNearestExistingAncestor(root, inputPath);
  if (!nearest) {
    return lines.join(" ");
  }

  const nearestStat = await stat(nearest.absolutePath);
  if (!nearestStat.isDirectory()) {
    lines.push(`Nearest existing parent: ${nearest.relativePath}`);
    return lines.join(" ");
  }

  const siblings = await listImmediateEntries(nearest.absolutePath, root);
  lines.push(`Nearest existing parent: ${nearest.relativePath}`);
  if (siblings.length > 0) {
    lines.push(`Entries there: ${siblings.join(", ")}`);
  }
  return lines.join(" ");
};

const buildDisallowedShellOperatorsMessage = (command: string) => {
  const trimmed = command.trim();
  const guidance: string[] = [
    "Shell command contains disallowed operators.",
    "Run a single repo-local command only; do not use cd, &&, |, ;, redirection, or backticks.",
    "BuildWarden already runs run_shell from the worktree root.",
  ];

  if (/\bcd\b/i.test(trimmed)) {
    guidance.push("Drop the leading cd and run the target command directly.");
  }
  if (process.platform === "win32" && /(?:^|[\\/])gradlew(?:\.bat)?\b/i.test(trimmed)) {
    guidance.push('On Windows, prefer ".\\\\gradlew.bat test -q" over "./gradlew test -q".');
  }

  return guidance.join(" ");
};

const findDisallowedShellOperator = (command: string): { operator: string; index: number } | null => {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      return { operator: `${char}${next}`, index };
    }

    if (char === "$" && next === "(") {
      return { operator: "$(", index };
    }

    if (char === "|" || char === ";" || char === ">" || char === "<" || char === "`") {
      return { operator: char, index };
    }
  }

  return null;
};

const formatNumberedLines = (content: string, lineNumberOffset = 0) =>
  content
    .split(/\r?\n/)
    .map((line, index) => `${lineNumberOffset + index + 1}|${line}`)
    .join("\n");

const isWithinRoot = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const resolveWorktreePath = (root: string, inputPath: string) => {
  const target = resolve(root, inputPath || ".");
  if (!isWithinRoot(root, target)) {
    throw new Error(`Path escapes the run worktree: ${inputPath}`);
  }
  return target;
};

const normalizeLineBound = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error("read_file line bounds must be positive 1-based integers.");
  }
  return numeric;
};

const readFilePreview = async (
  path: string,
  options?: {
    startLine?: number | null;
    endLine?: number | null;
  },
) => {
  const file = await readFile(path, "utf8");
  const lines = file.split(/\r?\n/);
  const startLine = options?.startLine ?? null;
  const endLine = options?.endLine ?? null;
  if (startLine === null && endLine === null) {
    return {
      content: truncate(formatNumberedLines(file)),
      lineStart: 1,
      lineEnd: lines.length,
      totalLines: lines.length,
      truncated: formatNumberedLines(file).length > MAX_OUTPUT_CHARS,
    };
  }

  const resolvedStart = startLine ?? 1;
  const resolvedEnd = endLine ?? Math.min(lines.length, resolvedStart + 199);
  if (resolvedEnd < resolvedStart) {
    throw new Error("read_file endLine must be greater than or equal to startLine.");
  }
  const clampedStart = Math.min(resolvedStart, Math.max(lines.length, 1));
  const clampedEnd = Math.min(resolvedEnd, lines.length);
  const selected = lines.slice(clampedStart - 1, clampedEnd).join("\n");
  const numbered = formatNumberedLines(selected, clampedStart - 1);
  return {
    content: truncate(numbered),
    lineStart: clampedStart,
    lineEnd: clampedEnd,
    totalLines: lines.length,
    truncated: numbered.length > MAX_OUTPUT_CHARS || resolvedEnd > clampedEnd,
  };
};

const createSearchMatcher = (query: string): RegExp => {
  try {
    return new RegExp(query, "i");
  } catch {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }
};

const listFilesRecursive = async (root: string, currentPath: string, entries: string[], maxEntries: number): Promise<void> => {
  const children = await readdir(currentPath, { withFileTypes: true });

  for (const child of children) {
    if (entries.length >= maxEntries) {
      return;
    }

    if (child.name === ".git" || child.name === "node_modules") {
      continue;
    }

    const fullPath = resolve(currentPath, child.name);
    const relativePath = toPosix(relative(root, fullPath));

    entries.push(relativePath || ".");
    if (child.isDirectory()) {
      await listFilesRecursive(root, fullPath, entries, maxEntries);
    }
  }
};

const buildSearchRepoStructuredResult = async (root: string, query: string, maxMatches: number) => {
  const matcher = createSearchMatcher(query);
  const fileHits = new Map<string, Array<{ lineNumber: number; excerpt: string }>>();
  let totalMatches = 0;

  const visit = async (dirPath: string): Promise<void> => {
    if (totalMatches >= maxMatches) {
      return;
    }

    const children = await readdir(dirPath, { withFileTypes: true });
    for (const child of children) {
      if (totalMatches >= maxMatches) {
        return;
      }
      if (child.name === ".git" || child.name === "node_modules") {
        continue;
      }

      const fullPath = resolve(dirPath, child.name);
      if (child.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!isTextFile(fullPath)) {
        continue;
      }

      const fileStat = await stat(fullPath);
      if (fileStat.size > MAX_FILE_BYTES) {
        continue;
      }

      const content = await readFile(fullPath, "utf8");
      const lines = content.split(/\r?\n/);
      const rel = toPosix(relative(root, fullPath));
      const hits: Array<{ lineNumber: number; excerpt: string }> = [];

      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher.test(lines[index] ?? "")) {
          continue;
        }
        const start = Math.max(0, index - SEARCH_CONTEXT_RADIUS);
        const end = Math.min(lines.length - 1, index + SEARCH_CONTEXT_RADIUS);
        const excerpt = lines
          .slice(start, end + 1)
          .map((line, excerptIndex) => `${start + excerptIndex + 1}|${line}`)
          .join("\n");
        hits.push({ lineNumber: index + 1, excerpt });
        totalMatches += 1;
        if (totalMatches >= maxMatches) {
          break;
        }
      }

      if (hits.length > 0) {
        fileHits.set(rel, hits);
      }
    }
  };

  await visit(root);

  if (fileHits.size === 0) {
    return {
      content: "No matches found.",
      metadata: {
        totalMatches: 0,
        topFiles: [],
      },
    };
  }

  const topFiles = [...fileHits.entries()]
    .map(([path, hits]) => ({ path, hits: hits.length }))
    .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path))
    .slice(0, 8);

  const sections = [
    "Top candidate files:",
    ...topFiles.map((entry) => `- ${entry.path} (${entry.hits} hit${entry.hits === 1 ? "" : "s"})`),
    "",
    "Match excerpts:",
    ...[...fileHits.entries()].flatMap(([path, hits]) =>
      hits.map((hit) => [`${path}:${hit.lineNumber}`, hit.excerpt, ""].join("\n")),
    ),
  ];

  return {
    content: truncate(sections.join("\n")),
    metadata: {
      totalMatches,
      topFiles,
    },
  };
};

export type RunToolContextHooks = {
  onShellStream?: (info: { callId: string; command: string; output: string }) => void;
  abortSignal?: AbortSignal;
  onShellCommandStart?: (info: { callId: string; command: string; cancel: (reason?: unknown) => void }) => void;
  onShellCommandEnd?: (info: { callId: string }) => void;
};

const SHELL_ABORT_REASON_CANCELLED_BY_USER = "cancelled-by-user";

type RunToolContextOptions = {
  yoloMode?: boolean;
};

const runSafeCommand = async (
  worktreePath: string,
  command: string,
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>,
  shellAllowlistExtra?: string[],
  options?: {
    onStream?: (info: { command: string; accumulated: string }) => void;
    signal?: AbortSignal;
    yoloMode?: boolean;
  },
): Promise<{ content: string; metadata: Record<string, unknown> }> => {
  const trimmed = command.trim();
  const yoloMode = options?.yoloMode === true;
  if (!yoloMode && findDisallowedShellOperator(trimmed)) {
    throw new Error(buildDisallowedShellOperatorsMessage(trimmed));
  }

  const allowedCommands = compileShellAllowlistRegExes(shellAllowlistExtra);

  if (!yoloMode && !allowedCommands.some((pattern) => pattern.test(trimmed))) {
    if (!requestShellApproval) {
      throw new Error(
        `Command is not allowed: ${trimmed}. Use built-in safe commands, add regex patterns in Settings → GIT & Workspace → Shell allowlist, or approve when prompted.`,
      );
    }

    const decision = await requestShellApproval(trimmed);
    if (decision === "deny") {
      throw new Error(`Command was denied by the user: ${trimmed}`);
    }
  }

  return await new Promise((resolve) => {
    let settled = false;
    let raw = "";
    let throttleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastEmit = 0;
    let child: ReturnType<typeof spawn> | null = null;

    const finish = (result: { content: string; metadata: Record<string, unknown> }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = undefined;
      }
      options?.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const emitStream = (force: boolean) => {
      if (!options?.onStream) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastEmit < SHELL_STREAM_THROTTLE_MS) {
        if (!throttleTimer) {
          throttleTimer = setTimeout(() => {
            throttleTimer = undefined;
            emitStream(true);
          }, SHELL_STREAM_THROTTLE_MS - (now - lastEmit));
        }
        return;
      }
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = undefined;
      }
      lastEmit = Date.now();
      const trimmedRaw = raw.trim();
      const accumulated = trimmedRaw ? truncate(trimmedRaw) : "";
      options.onStream({ command: trimmed, accumulated });
    };

    const onAbort = () => {
      child?.kill();
    };

    if (options?.signal?.aborted) {
      const cancelledByUser = options.signal.reason === SHELL_ABORT_REASON_CANCELLED_BY_USER;
      finish({
        content: cancelledByUser
          ? "Command cancelled by user. The user manually stopped this run_shell command because it appeared stuck. Do not retry it automatically."
          : "Command aborted.",
        metadata: {
          command: trimmed,
          exitCode: null,
          aborted: true,
          ...(cancelledByUser ? { cancelledByUser: true } : {}),
        },
      });
      return;
    }

    child = spawn(process.platform === "win32" ? "powershell.exe" : "sh", process.platform === "win32"
      ? ["-NoProfile", "-Command", trimmed]
      : ["-lc", trimmed], {
      cwd: worktreePath,
      env: buildAgentShellEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    options?.signal?.addEventListener("abort", onAbort);

    const appendChunk = (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      raw += text;
      if (raw.length > MAX_SHELL_STREAM_RAW_CHARS) {
        raw = raw.slice(-MAX_SHELL_STREAM_RAW_CHARS);
      }
      emitStream(false);
    };

    child.stdout?.on("data", appendChunk);
    child.stderr?.on("data", appendChunk);

    child.on("error", (spawnError) => {
      const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
      emitStream(true);
      finish({
        content: truncate(message || "Command failed to start."),
        metadata: {
          command: trimmed,
          exitCode: null,
        },
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      emitStream(true);
      const noOutputMsg = "Command completed with no output.";
      const aborted = options?.signal?.aborted === true;
      const body = raw.trim();
      if (aborted) {
        const cancelledByUser = options?.signal?.reason === SHELL_ABORT_REASON_CANCELLED_BY_USER;
        finish({
          content: truncate(
            cancelledByUser
              ? body
                ? `${body}\n\nCommand cancelled by user. The user manually stopped this run_shell command because it appeared stuck. Do not retry it automatically.`
                : "Command cancelled by user. The user manually stopped this run_shell command because it appeared stuck. Do not retry it automatically."
              : body
                ? `${body}\n\n(Command aborted.)`
                : "Command aborted.",
          ),
          metadata: {
            command: trimmed,
            exitCode: null,
            aborted: true,
            ...(cancelledByUser ? { cancelledByUser: true } : {}),
          },
        });
        return;
      }
      const content = truncate(body || noOutputMsg);
      finish({
        content,
        metadata: {
          command: trimmed,
          exitCode: code,
        },
      });
    });

    if (options?.onStream) {
      emitStream(true);
    }
  });
};

export const createRunToolContext = (
  worktreePath: string,
  mode: RunMode = "code",
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>,
  shellAllowlistExtra?: string[],
  hooks?: RunToolContextHooks,
  toolNamesOverride?: readonly RunToolName[],
  options?: RunToolContextOptions,
): HarnessToolContext => {
  const allowedTools = TOOL_ALLOWLIST_BY_MODE[mode];
  const yoloMode = options?.yoloMode === true;
  const effectiveTools =
    yoloMode
      ? new Set(TOOL_DEFINITIONS.map((tool) => tool.name))
      : toolNamesOverride && toolNamesOverride.length > 0
      ? new Set(mode === "code" ? toolNamesOverride : toolNamesOverride.filter((toolName) => allowedTools.has(toolName)))
      : allowedTools;
  const tools = TOOL_DEFINITIONS.filter((tool) => effectiveTools.has(tool.name));
  const readFilesThisRun = new Set<string>();

  const executeTool = async (call: RunToolCall): Promise<RunToolResult> => {
    try {
      if (!effectiveTools.has(call.name)) {
        throw new Error(`Tool ${call.name} is not available in ${mode} mode.`);
      }

      switch (call.name) {
        case "read_file": {
          const inputPath = String(call.arguments.path ?? "");
          const startLine = normalizeLineBound(call.arguments.startLine);
          const endLine = normalizeLineBound(call.arguments.endLine);
          const target = resolveWorktreePath(worktreePath, inputPath);
          let fileStat;
          try {
            fileStat = await stat(target);
          } catch (error) {
            if (isMissingPathError(error)) {
              throw new Error(await buildMissingPathMessage(worktreePath, "file", inputPath));
            }
            throw error;
          }
          if (!fileStat.isFile()) {
            throw new Error("Target path is not a file.");
          }
          if (fileStat.size > MAX_FILE_BYTES) {
            throw new Error("File is too large to read in one tool call.");
          }
          readFilesThisRun.add(toPosix(relative(worktreePath, target)));
          const preview = await readFilePreview(target, { startLine, endLine });
          return {
            toolCallId: call.id,
            name: call.name,
            ok: true,
            content: preview.content,
            metadata: {
              path: toPosix(relative(worktreePath, target)),
              sizeBytes: fileStat.size,
              lineStart: preview.lineStart,
              lineEnd: preview.lineEnd,
              totalLines: preview.totalLines,
              truncated: preview.truncated,
            },
          };
        }

        case "write_file": {
          const target = resolveWorktreePath(worktreePath, String(call.arguments.path ?? ""));
          const rel = toPosix(relative(worktreePath, target));
          if (!rel || rel === "." || rel.startsWith(".git/")) {
            throw new Error("write_file cannot target the repository root or .git internals.");
          }
          let previousContent: string | null = null;
          try {
            const fileStat = await stat(target);
            if (fileStat.isFile() && fileStat.size <= MAX_FILE_BYTES) {
              previousContent = await readFile(target, "utf8");
            }
          } catch (err) {
            const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
            if (code !== "ENOENT") {
              throw err;
            }
            previousContent = null;
          }

          await mkdir(dirname(target), { recursive: true });
          const content = String(call.arguments.content ?? "");
          if (content.length > MAX_FILE_BYTES) {
            throw new Error("Refusing to write a file larger than the tool size limit.");
          }
          validateWriteFileRequest({
            rel,
            content,
            previousContent,
            wasReadEarlier: readFilesThisRun.has(rel),
          });

          try {
            await writeFile(target, content, "utf8");
            const writtenContent = await readFile(target, "utf8");
            if (writtenContent !== content) {
              throw new Error(`Verification failed after writing ${rel}: file contents did not match the requested content.`);
            }
            validateWriteFileRequest({
              rel,
              content: writtenContent,
              previousContent,
              wasReadEarlier: true,
            });
          } catch (error) {
            if (previousContent === null) {
              await rm(target, { force: true });
            } else {
              await writeFile(target, previousContent, "utf8");
            }
            throw error;
          }
          const unifiedDiff = buildWriteFileUnifiedDiff(rel, previousContent, content);
          return {
            toolCallId: call.id,
            name: call.name,
            ok: true,
            content: `Wrote ${content.length} characters to ${rel}.`,
            metadata: {
              path: rel,
              sizeBytes: content.length,
              ...(unifiedDiff ? { writeFileUnifiedDiff: unifiedDiff } : {}),
            },
          };
        }

        case "edit_file": {
          const target = resolveWorktreePath(worktreePath, String(call.arguments.file_path ?? ""));
          const rel = toPosix(relative(worktreePath, target));
          if (!rel || rel === "." || rel.startsWith(".git/")) {
            throw new Error("edit_file cannot target the repository root or .git internals.");
          }

          const oldString = String(call.arguments.old_string ?? "");
          const newString = String(call.arguments.new_string ?? "");
          const expectedReplacements = Number(call.arguments.expected_replacements ?? 1);
          if (!Number.isInteger(expectedReplacements) || expectedReplacements < 1) {
            throw new Error("edit_file requires expected_replacements to be an integer >= 1.");
          }
          if (newString.length > MAX_FILE_BYTES) {
            throw new Error("Refusing to write a file larger than the tool size limit.");
          }

          let previousContent: string | null = null;
          try {
            const fileStat = await stat(target);
            if (!fileStat.isFile()) {
              throw new Error("Target path is not a file.");
            }
            if (fileStat.size <= MAX_FILE_BYTES) {
              previousContent = await readFile(target, "utf8");
            } else {
              throw new Error("File is too large to edit in one tool call.");
            }
          } catch (err) {
            const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
            if (code !== "ENOENT") {
              throw err;
            }
            previousContent = null;
          }

          await mkdir(dirname(target), { recursive: true });

          let nextContent: string;
          let actionSummary: string;
          if (oldString === "") {
            if (previousContent !== null) {
              throw new Error(`Refusing to create ${rel} via edit_file because the file already exists.`);
            }
            nextContent = newString;
            actionSummary = `Created ${rel} via edit_file.`;
          } else {
            if (previousContent === null) {
              throw new Error(`Cannot edit missing file ${rel}. Use write_file or set old_string to empty to create it.`);
            }
            if (!readFilesThisRun.has(rel)) {
              throw new Error(`Refusing to edit existing file ${rel} before it has been read in this run. Use read_file first.`);
            }

            const normalizedOriginal = normalizeTextForDiff(previousContent);
            const normalizedOld = normalizeTextForDiff(oldString);
            const normalizedNew = normalizeTextForDiff(newString);
            const actualReplacements = countOccurrences(normalizedOriginal, normalizedOld);
            if (actualReplacements !== expectedReplacements) {
              throw new Error(
                `edit_file expected ${expectedReplacements} replacement${expectedReplacements === 1 ? "" : "s"} in ${rel}, but found ${actualReplacements}.`,
              );
            }

            const normalizedNext = normalizedOriginal.split(normalizedOld).join(normalizedNew);
            const lineEnding = detectLineEnding(previousContent);
            nextContent = lineEnding === "\n" ? normalizedNext : normalizedNext.replace(/\n/g, "\r\n");
            actionSummary = `Updated ${expectedReplacements} occurrence${expectedReplacements === 1 ? "" : "s"} in ${rel}.`;
          }

          validateWriteFileRequest({
            rel,
            content: nextContent,
            previousContent,
            wasReadEarlier: previousContent === null ? true : readFilesThisRun.has(rel),
          });

          try {
            await writeFile(target, nextContent, "utf8");
            const writtenContent = await readFile(target, "utf8");
            if (writtenContent !== nextContent) {
              throw new Error(`Verification failed after editing ${rel}: file contents did not match the requested content.`);
            }
            validateWriteFileRequest({
              rel,
              content: writtenContent,
              previousContent,
              wasReadEarlier: true,
            });
          } catch (error) {
            if (previousContent === null) {
              await rm(target, { force: true });
            } else {
              await writeFile(target, previousContent, "utf8");
            }
            throw error;
          }

          const unifiedDiff = buildWriteFileUnifiedDiff(rel, previousContent, nextContent);
          return {
            toolCallId: call.id,
            name: call.name,
            ok: true,
            content: actionSummary,
            metadata: {
              path: rel,
              sizeBytes: nextContent.length,
              ...(unifiedDiff ? { writeFileUnifiedDiff: unifiedDiff } : {}),
            },
          };
        }

        case "delete_file": {
          const inputPath = String(call.arguments.path ?? "");
          const target = resolveWorktreePath(worktreePath, inputPath);
          const rel = toPosix(relative(worktreePath, target));
          if (!rel || rel === "." || rel === ".." || rel.startsWith(".git/")) {
            throw new Error("delete_file cannot remove the repository root or .git internals.");
          }
          try {
            await stat(target);
          } catch (error) {
            if (isMissingPathError(error)) {
              throw new Error(await buildMissingPathMessage(worktreePath, "file", inputPath));
            }
            throw error;
          }
          await rm(target, { recursive: true, force: true });
          return {
            toolCallId: call.id,
            name: call.name,
            ok: true,
            content: `Deleted ${rel}.`,
            metadata: {
              path: rel,
            },
          };
        }

        case "list_files": {
          const inputPath = String(call.arguments.path ?? ".");
          const target = resolveWorktreePath(worktreePath, inputPath);
          let directoryStat;
          try {
            directoryStat = await stat(target);
          } catch (error) {
            if (isMissingPathError(error)) {
              throw new Error(await buildMissingPathMessage(worktreePath, "directory", inputPath));
            }
            throw error;
          }
          if (!directoryStat.isDirectory()) {
            throw new Error("Target path is not a directory.");
          }
          const entries: string[] = [];
          const maxEntries = Number(call.arguments.maxEntries ?? MAX_LIST_ENTRIES);
          await listFilesRecursive(worktreePath, target, entries, Math.min(maxEntries, MAX_LIST_ENTRIES));
          return {
            toolCallId: call.id,
            name: call.name,
            ok: true,
            content: truncate(entries.length > 0 ? entries.join("\n") : "No files found."),
            metadata: {
              path: toPosix(relative(worktreePath, target)) || ".",
              totalEntries: entries.length,
            },
          };
        }

        case "search_repo": {
          const inputPath = String(call.arguments.path ?? ".");
          const target = resolveWorktreePath(worktreePath, inputPath);
          const query = String(call.arguments.query ?? "").trim();
          if (!query) {
            throw new Error("search_repo requires a non-empty query.");
          }
          try {
            const targetStat = await stat(target);
            if (!targetStat.isDirectory()) {
              throw new Error("Target path is not a directory.");
            }
          } catch (error) {
            if (isMissingPathError(error)) {
              throw new Error(await buildMissingPathMessage(worktreePath, "directory", inputPath));
            }
            throw error;
          }

          const maxMatches = Math.min(Number(call.arguments.maxMatches ?? MAX_SEARCH_MATCHES), MAX_SEARCH_MATCHES);
          const searchResult = await buildSearchRepoStructuredResult(target, query, maxMatches);

          return {
            toolCallId: call.id,
            name: call.name,
            ok: true,
            content: searchResult.content,
            metadata: {
              path: toPosix(relative(worktreePath, target)) || ".",
              query,
              ...searchResult.metadata,
            },
          };
        }

        case "run_shell": {
          const shellAbortController = new AbortController();
          hooks?.onShellCommandStart?.({
            callId: call.id,
            command: String(call.arguments.command ?? ""),
            cancel: (reason?: unknown) => shellAbortController.abort(reason),
          });
          const streamOpts =
            hooks?.onShellStream || hooks?.abortSignal || hooks?.onShellCommandStart
              ? {
                  onStream: hooks.onShellStream
                    ? ({ command, accumulated }: { command: string; accumulated: string }) => {
                        hooks.onShellStream!({
                          callId: call.id,
                          command,
                          output: accumulated,
                        });
                      }
                    : undefined,
                  signal: shellAbortController.signal,
                }
              : undefined;
          try {
            hooks?.abortSignal?.throwIfAborted();
            const result = await runSafeCommand(
              worktreePath,
              String(call.arguments.command ?? ""),
              requestShellApproval,
              shellAllowlistExtra,
              { ...streamOpts, yoloMode },
            );
            hooks?.abortSignal?.throwIfAborted();
            return {
              toolCallId: call.id,
              name: call.name,
              ok: result.metadata.exitCode === 0,
              content: result.content,
              metadata: result.metadata,
            };
          } finally {
            hooks?.onShellCommandEnd?.({ callId: call.id });
          }
        }

        default:
          throw new Error(`Unsupported tool: ${call.name}`);
      }
    } catch (error) {
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        metadata: {
          ...call.arguments,
        },
      };
    }
  };

  return {
    tools,
    executeTool,
  };
};
