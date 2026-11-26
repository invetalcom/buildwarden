import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isTextLikeFileName, type RunMode, type RunWorkspaceVcs } from "@buildwarden/shared";
import { createRunToolContext } from "./run-tools";

/** Rough token estimate if `countTokens` fails (rare). */
const charsToApproxTokens = (chars: number) => Math.max(1, Math.ceil(chars / 4));

// The tokenizer's encoding tables are ~2 MB of code and ~16 MB of heap. Load them only when a run
// builds its initial context, not whenever a run worker starts.
let countTokens: ((text: string) => number) | undefined;
let tokenizerLoad: Promise<void> | undefined;
const loadTokenizer = (): Promise<void> => tokenizerLoad ??= import("gpt-tokenizer").then(
  (module) => { countTokens = module.countTokens; },
  () => { /* The character estimate stays in use. */ },
);

const estimateContextTokens = (text: string): number => {
  try {
    return countTokens ? countTokens(text) : charsToApproxTokens(text.length);
  } catch {
    return charsToApproxTokens(text.length);
  }
};
const logContextStats = (mode: RunMode, text: string): void => {
  if (process.env.BUILDWARDEN_LOG_REPO_CONTEXT !== "1") {
    return;
  }
  const tokens = estimateContextTokens(text);
  console.info(`[buildwarden] initial repo context (${mode}): ${String(text.length)} chars, ~${String(tokens)} tokens`);
};

type KeyFileSpec = { relativePath: string; maxBodyTokens: number };

type ContextProfile = {
  listMaxEntries: number;
  maxTotalTokens: number;
  changedFilesMax: number;
  promptFilesMax: number;
  listStyle: "recursive" | "top_level";
  keyFiles: KeyFileSpec[];
};

type ContextSection = {
  key: string;
  text: string;
  priority: number;
};

const MODEL_CONTEXT_BUDGETS: Array<{ match: RegExp; tokensDelta: number }> = [
  { match: /gpt-5(\.4|\.3|\.2|\.1)?/i, tokensDelta: 1_400 },
  { match: /gpt-4\.1/i, tokensDelta: 600 },
  { match: /mini|nano|small|haiku|flash/i, tokensDelta: -700 },
];

const BASE_CONTEXT_PROFILE: Record<RunMode, ContextProfile> = {
  code: {
    listStyle: "recursive",
    listMaxEntries: 110,
    maxTotalTokens: 5_000,
    changedFilesMax: 10,
    promptFilesMax: 6,
    keyFiles: [
      { relativePath: "README.md", maxBodyTokens: 900 },
      { relativePath: "package.json", maxBodyTokens: 1_100 },
      { relativePath: "tsconfig.json", maxBodyTokens: 520 },
      { relativePath: "tsconfig.base.json", maxBodyTokens: 520 },
    ],
  },
  plan: {
    listStyle: "top_level",
    listMaxEntries: 72,
    maxTotalTokens: 2_700,
    changedFilesMax: 6,
    promptFilesMax: 4,
    keyFiles: [
      { relativePath: "README.md", maxBodyTokens: 600 },
      { relativePath: "package.json", maxBodyTokens: 760 },
    ],
  },
  ask: {
    listStyle: "top_level",
    listMaxEntries: 72,
    maxTotalTokens: 2_300,
    changedFilesMax: 5,
    promptFilesMax: 3,
    keyFiles: [
      { relativePath: "README.md", maxBodyTokens: 520 },
      { relativePath: "package.json", maxBodyTokens: 640 },
    ],
  },
};

const createChunkPrefix = (value: string, maxTokens: number): string => {
  if (estimateContextTokens(value) <= maxTokens) {
    return value;
  }

  const targetChars = Math.max(160, Math.floor(maxTokens * 4.5));
  const candidate = value.slice(0, Math.min(value.length, targetChars * 2));
  const separators = ["\n\n", "\n", " "];

  for (const separator of separators) {
    const pieces = candidate.split(separator);
    if (pieces.length <= 1) {
      continue;
    }

    let prefix = "";
    for (const piece of pieces) {
      const next = prefix ? `${prefix}${separator}${piece}` : piece;
      if (estimateContextTokens(next) > maxTokens) {
        break;
      }
      prefix = next;
    }

    if (prefix.trim()) {
      return prefix;
    }
  }

  return truncateToTokenBudget(candidate, maxTokens);
};

const minimizePreviewText = async (value: string, maxTokens: number): Promise<string> => {
  if (estimateContextTokens(value) <= maxTokens) {
    return value;
  }

  const firstChunk = createChunkPrefix(value, maxTokens).trimEnd();
  if (!firstChunk) {
    return truncateToTokenBudget(value, maxTokens);
  }

  const preview = firstChunk.trimEnd();
  const suffix = "\n... truncated for initial context ...";
  const candidate = `${preview}${suffix}`;
  if (estimateContextTokens(candidate) <= maxTokens) {
    return candidate;
  }
  return truncateToTokenBudget(preview, maxTokens);
};

const truncateToTokenBudget = (value: string, maxTokens: number): string => {
  if (maxTokens <= 0) {
    return "";
  }
  if (estimateContextTokens(value) <= maxTokens) {
    return value;
  }

  const suffix = "\n... truncated for initial context ...";
  let low = 0;
  let high = value.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${value.slice(0, middle)}${suffix}`;
    if (estimateContextTokens(candidate) <= maxTokens) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best || suffix.trim();
};

const withModelBudget = (mode: RunMode, modelId?: string): ContextProfile => {
  const base = BASE_CONTEXT_PROFILE[mode];
  const tokensDelta = MODEL_CONTEXT_BUDGETS.reduce(
    (sum, entry) => (modelId && entry.match.test(modelId) ? sum + entry.tokensDelta : sum),
    0,
  );
  return {
    ...base,
    maxTotalTokens: Math.max(1_800, base.maxTotalTokens + tokensDelta),
  };
};

const safeJsonParse = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** `read_file` numbers every line (`12|text`). Context previews and parsers need the plain text. */
export const stripReadFileLineNumbers = (content: string): string => content.replace(/^\d+\|/gm, "");

const MAX_LISTED_WORKSPACE_FILES = 20_000;
const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

const listGitWorkspaceFiles = (worktreePath: string): Promise<string[] | null> =>
  new Promise((resolvePaths) => {
    // Tracked plus untracked files, without anything .gitignore excludes (build output, nested worktrees).
    execFile("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: worktreePath, timeout: 10_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolvePaths(null);
        return;
      }
      // Shallow files first, as in a folder walk, so the limit cuts deep subtrees, never a top-level folder.
      const files = [...new Set(stdout.split("\0").filter(Boolean))];
      const depth = (file: string) => file.split("/").length;
      resolvePaths(files.length <= MAX_LISTED_WORKSPACE_FILES ? files
        : files.sort((left, right) => depth(left) - depth(right)).slice(0, MAX_LISTED_WORKSPACE_FILES));
    });
  });

const listFolderWorkspaceFiles = async (worktreePath: string): Promise<string[]> => {
  const files: string[] = [];
  // Breadth first, so a large subtree cannot use up the limit before the rest of the project is seen.
  let level = [""];
  while (level.length > 0 && files.length < MAX_LISTED_WORKSPACE_FILES) {
    const next: string[] = [];
    for (const directory of level) {
      let dirents;
      try {
        dirents = await readdir(resolve(worktreePath, directory), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of dirents) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) next.push(path);
        else if (files.length < MAX_LISTED_WORKSPACE_FILES) files.push(path);
      }
    }
    level = next;
  }
  return files;
};

/** Workspace files relative to the root, with forward slashes. Git workspaces honor .gitignore. */
const listWorkspaceFiles = async (worktreePath: string, workspaceVcs: RunWorkspaceVcs): Promise<string[]> =>
  (workspaceVcs === "git" ? await listGitWorkspaceFiles(worktreePath) : null) ?? listFolderWorkspaceFiles(worktreePath);

/**
 * A map of the workspace that fits `maxEntries`: shallow entries first, so every top-level folder is
 * shown before any folder is expanded further. Directories end with a slash.
 */
export const buildWorkspaceFileMap = (files: readonly string[], maxEntries: number, maxDepth = Number.POSITIVE_INFINITY): string => {
  const entries = new Map<string, number>();
  for (const file of files) {
    const parts = file.split("/").filter(Boolean);
    for (let depth = 0; depth < parts.length && depth < maxDepth; depth += 1) {
      const isDirectory = depth < parts.length - 1;
      const path = `${parts.slice(0, depth + 1).join("/")}${isDirectory ? "/" : ""}`;
      if (!entries.has(path)) entries.set(path, depth);
    }
  }
  if (entries.size === 0) return "(empty workspace)";
  const byDepth = [...entries].sort(([leftPath, left], [rightPath, right]) => left - right || leftPath.localeCompare(rightPath));
  const shown = byDepth.slice(0, maxEntries).map(([path]) => path).sort((left, right) => left.localeCompare(right));
  const hidden = entries.size - shown.length;
  return [...shown, ...(hidden > 0 ? [`(${String(hidden)} more entries; use the file tools to look deeper)`] : [])].join("\n");
};

const isPromptPathCharacter = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === "_" ||
    character === "." ||
    character === "/" ||
    character === "-"
  );
};

const normalizePromptPathToken = (rawToken: string): string => {
  let token = rawToken;
  while (token && !isPromptPathCharacter(token[0] ?? "")) {
    token = token.slice(1);
  }
  while (token && !isPromptPathCharacter(token.at(-1) ?? "")) {
    token = token.slice(0, -1);
  }
  while (token.endsWith(".")) {
    token = token.slice(0, -1);
  }
  const lineSuffixIndex = token.lastIndexOf(":");
  if (lineSuffixIndex > 0 && [...token.slice(lineSuffixIndex + 1)].every((character) => character >= "0" && character <= "9")) {
    token = token.slice(0, lineSuffixIndex);
  }
  return token.startsWith("./") ? token.slice(2) : token;
};

export const extractPromptPathHints = (prompt: string): string[] => {
  const hints = prompt
    .split(/\s+/)
    .map(normalizePromptPathToken)
    .filter((token) => token.includes("/") || isTextLikeFileName(token));
  return [...new Set(hints)].slice(0, 12);
};

const parseChangedFiles = (gitStatusOutput: string, maxFiles: number): string[] => {
  const lines = gitStatusOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const files = lines
    .filter((line) => !line.startsWith("##"))
    .map((line) => line.replace(/^[A-Z?]{1,2}\s+/, ""))
    .map((line) => line.split(" -> ").at(-1)?.trim() ?? line)
    .filter(Boolean);
  return [...new Set(files)].slice(0, maxFiles);
};

const PREFERRED_SCRIPT_NAMES = ["test", "typecheck", "lint", "check", "build", "dev", "start", "format"];

const parsePackageScriptsSummary = (packageJsonText: string): string => {
  const parsed = safeJsonParse(packageJsonText);
  const scripts = parsed.scripts;
  if (!scripts || typeof scripts !== "object") {
    return "(no scripts section)";
  }
  // Verification and run commands first: a long list of release variants must not crowd them out.
  const rank = (name: string) => {
    const index = PREFERRED_SCRIPT_NAMES.indexOf(name);
    return index < 0 ? PREFERRED_SCRIPT_NAMES.length : index;
  };
  return Object.entries(scripts)
    .map((entry, order) => ({ entry, order }))
    .sort((left, right) => rank(left.entry[0]) - rank(right.entry[0]) || left.order - right.order)
    .map(({ entry }) => entry)
    .slice(0, 12)
    .map(([name, cmd]) => `${name}: ${String(cmd)}`)
    .join("\n");
};

const parseWorkspaceSummary = (packageJsonText: string, workspaceYamlText: string | null): string => {
  const parsed = safeJsonParse(packageJsonText);
  const workspaces = parsed.workspaces;
  const parts: string[] = [];
  if (Array.isArray(workspaces) && workspaces.length > 0) {
    parts.push(`package.json workspaces: ${workspaces.join(", ")}`);
  } else if (workspaces && typeof workspaces === "object" && Array.isArray((workspaces as { packages?: unknown }).packages)) {
    parts.push(`package.json workspaces: ${((workspaces as { packages: string[] }).packages).join(", ")}`);
  }
  if (workspaceYamlText?.trim()) {
    // Only the list under `packages:`; other keys (overrides, onlyBuiltDependencies) hold lists too.
    const packageMatches: string[] = [];
    let inPackages = false;
    for (const line of workspaceYamlText.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      if (/^\S/.test(line)) inPackages = /^packages\s*:/.test(line);
      else if (inPackages && line.trim().startsWith("- ")) packageMatches.push(line.trim().slice(2).replace(/^["']|["']$/g, ""));
    }
    if (packageMatches.length > 0) {
      parts.push(`pnpm workspace globs: ${packageMatches.slice(0, 10).join(", ")}`);
    }
  }
  return parts.join("\n") || "(single-package or workspace config not detected)";
};

const extractEntryPointCandidates = (files: readonly string[]): string[] =>
  files
    .filter((file) => /(?:^|\/)(src\/index|src\/main|src\/app|app|main|index|App)\.(ts|tsx|js|jsx|py|go|rs|java|html)$/i.test(file))
    .filter((file) => !/(?:^|\/)(?:dist|out|build|coverage)\//.test(file) && !/\.(?:test|spec)\./.test(file))
    // Shallow files are the likelier entry points of a project.
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))
    .slice(0, 8);

const readPriorityFilePreview = async (
  toolContext: ReturnType<typeof createRunToolContext>,
  relativePath: string,
  maxBodyTokens: number,
): Promise<string | null> => {
  const preview = await toolContext.executeTool({
    id: `initial-priority-${relativePath.replace(/[^\w.-]+/g, "_")}`,
    name: "read_file",
    arguments: { path: relativePath },
  });
  if (!preview.ok) {
    return null;
  }
  return `${relativePath}:\n${await minimizePreviewText(stripReadFileLineNumbers(preview.content), maxBodyTokens)}`;
};

const pushNonEmpty = (values: string[], value: string): void => {
  if (value.trim()) values.push(value);
};

const assembleSectionsWithinBudget = (sections: ContextSection[], maxTotalTokens: number): string => {
  const sorted = [...sections].sort((left, right) => left.priority - right.priority);
  const selected: string[] = [];
  let usedTokens = 0;

  for (const section of sorted) {
    const sectionText = section.text.trim();
    if (!sectionText) {
      continue;
    }
    const prefix = selected.length > 0 ? "\n\n" : "";
    const fullCandidate = `${prefix}${sectionText}`;
    const sectionTokens = estimateContextTokens(fullCandidate);
    if (usedTokens + sectionTokens <= maxTotalTokens) {
      selected.push(sectionText);
      usedTokens += estimateContextTokens(sectionText) + (selected.length > 1 ? estimateContextTokens("\n\n") : 0);
      continue;
    }

    const remainingTokens = maxTotalTokens - usedTokens - (selected.length > 0 ? estimateContextTokens("\n\n") : 0);
    if (remainingTokens <= 0) {
      break;
    }
    const truncated = truncateToTokenBudget(sectionText, remainingTokens);
    pushNonEmpty(selected, truncated);
    break;
  }

  return selected.join("\n\n");
};

type InitialToolResult = { ok: boolean; content: string } | null;

const buildInitialSections = (input: {
  workspaceVcs: RunWorkspaceVcs;
  mode: RunMode;
  modelId?: string;
  gitStatus: InitialToolResult;
  packageJsonPreview: InitialToolResult;
  workspaceYamlPreview: InitialToolResult;
  entrypoints: string[];
  changedFiles: string[];
  promptHints: string[];
  listStyle: "recursive" | "top_level" | "none";
  recursiveListing: InitialToolResult;
  topLevelListing: string | null;
}): ContextSection[] => {
  const gitStatusText = input.gitStatus?.content ?? "Git history unavailable: this run uses a plain project folder.";
  const sections: ContextSection[] = [{
    key: "facts",
    priority: 10,
    text: [
      input.workspaceVcs === "git" ? "Repository facts:" : "Project folder facts:",
      "- Workspace root: .",
      `- Mode: ${input.mode}`,
      `- Model: ${input.modelId ?? "(unknown)"}`,
      "",
      input.workspaceVcs === "git" ? "Git (branch + short status):" : "Git:",
      gitStatusText,
    ].join("\n"),
  }];
  if (input.packageJsonPreview?.ok) sections.push({
    key: "workspace",
    priority: 20,
    text: [
      "Package / workspace map:",
      parseWorkspaceSummary(input.packageJsonPreview.content, input.workspaceYamlPreview?.ok ? input.workspaceYamlPreview.content : null),
      "",
      "Likely commands:",
      parsePackageScriptsSummary(input.packageJsonPreview.content),
    ].join("\n"),
  });
  if (input.entrypoints.length > 0) sections.push({ key: "entrypoints", priority: 30, text: ["Key entrypoints:", ...input.entrypoints.map((entry) => `- ${entry}`)].join("\n") });
  if (input.changedFiles.length > 0) sections.push({ key: "changed-files", priority: 40, text: ["Recently changed files:", ...input.changedFiles.map((entry) => `- ${entry}`)].join("\n") });
  if (input.promptHints.length > 0) sections.push({ key: "prompt-hints", priority: 50, text: ["Files or paths mentioned in the prompt:", ...input.promptHints.map((entry) => `- ${entry}`)].join("\n") });
  if (input.listStyle === "top_level" && input.topLevelListing) sections.push({ key: "top-level", priority: 60, text: `Top-level files and folders:\n${input.topLevelListing}` });
  if (input.listStyle === "recursive" && input.recursiveListing?.ok) sections.push({ key: "file-map", priority: 60, text: `Workspace file map:\n${input.recursiveListing.content}` });
  return sections;
};

/**
 * Builds a mode-aware initial repository snapshot for the first model turn.
 * The output is structured and prompt-aware rather than being one flat blob.
 */
export const buildInitialRepoContext = async (
  worktreePath: string,
  options: RunMode | { mode?: RunMode; modelId?: string; prompt?: string; workspaceVcs?: RunWorkspaceVcs } = {},
): Promise<string> => {
  const normalizedOptions = typeof options === "string" ? { mode: options } : options;
  const mode = normalizedOptions.mode ?? "code";
  const workspaceVcs = normalizedOptions.workspaceVcs ?? "git";
  const profile = withModelBudget(mode, normalizedOptions.modelId);
  const toolContext = createRunToolContext(worktreePath, mode);
  const promptHints = extractPromptPathHints(normalizedOptions.prompt ?? "");
  // Budgeting below counts tokens synchronously; load the tokenizer alongside the tool reads.
  const tokenizerReady = loadTokenizer();

  const gitStatusPromise =
    workspaceVcs === "git"
      ? toolContext.executeTool({
          id: "initial-git-status-sb",
          name: "run_shell",
          arguments: { command: "git status -sb" },
        })
      : Promise.resolve(null);
  const packageJsonPreviewPromise = existsSync(resolve(worktreePath, "package.json"))
    ? toolContext.executeTool({
        id: "initial-read-package-json",
        name: "read_file",
        arguments: { path: "package.json" },
      })
    : Promise.resolve(null);
  const workspaceYamlPreviewPromise = existsSync(resolve(worktreePath, "pnpm-workspace.yaml"))
    ? toolContext.executeTool({
        id: "initial-read-pnpm-workspace",
        name: "read_file",
        arguments: { path: "pnpm-workspace.yaml" },
      })
    : Promise.resolve(null);
  const [gitStatus, rawPackageJsonPreview, rawWorkspaceYamlPreview, workspaceFiles] = await Promise.all([
    gitStatusPromise,
    packageJsonPreviewPromise,
    workspaceYamlPreviewPromise,
    listWorkspaceFiles(worktreePath, workspaceVcs).catch(() => []),
  ]);
  await tokenizerReady;
  const withoutLineNumbers = (result: InitialToolResult): InitialToolResult =>
    result ? { ...result, content: stripReadFileLineNumbers(result.content) } : null;
  const packageJsonPreview = withoutLineNumbers(rawPackageJsonPreview);
  const workspaceYamlPreview = withoutLineNumbers(rawWorkspaceYamlPreview);
  const entrypoints = extractEntryPointCandidates(workspaceFiles);
  const recursiveListing: InitialToolResult = profile.listStyle === "recursive"
    ? { ok: true, content: buildWorkspaceFileMap(workspaceFiles, profile.listMaxEntries) }
    : null;
  const topLevelListing = profile.listStyle === "top_level" ? buildWorkspaceFileMap(workspaceFiles, profile.listMaxEntries, 1) : null;

  const changedFiles = gitStatus?.content ? parseChangedFiles(gitStatus.content, profile.changedFilesMax) : [];
  const sections = buildInitialSections({
    workspaceVcs,
    mode,
    modelId: normalizedOptions.modelId,
    gitStatus,
    packageJsonPreview,
    workspaceYamlPreview,
    entrypoints,
    changedFiles,
    promptHints,
    listStyle: profile.listStyle,
    recursiveListing,
    topLevelListing,
  });

  const priorityPreviewPaths = [...changedFiles, ...promptHints]
    .filter((value, index, list) => list.indexOf(value) === index)
    .filter((value) => existsSync(resolve(worktreePath, value)))
    .slice(0, profile.promptFilesMax);
  const priorityPreviews = (
    await Promise.all(priorityPreviewPaths.map((relativePath) => readPriorityFilePreview(toolContext, relativePath, 520)))
  ).filter((preview): preview is string => Boolean(preview));
  if (priorityPreviews.length > 0) {
    sections.push({
      key: "priority-previews",
      priority: 70,
      text: `Priority file previews:\n\n${priorityPreviews.join("\n\n")}`,
    });
  }

  const keyFilePreviews = (
    await Promise.all(
      profile.keyFiles
        .filter((spec) => existsSync(resolve(worktreePath, spec.relativePath)) && !priorityPreviewPaths.includes(spec.relativePath))
        .map(async (spec) => {
          const preview = await toolContext.executeTool({
            id: `initial-read-${spec.relativePath.replace(/[^\w.-]+/g, "_")}`,
            name: "read_file",
            arguments: { path: spec.relativePath },
          });
          if (!preview.ok) {
            return null;
          }
          return {
            relativePath: spec.relativePath,
            text: `${basename(spec.relativePath)} preview:\n${await minimizePreviewText(stripReadFileLineNumbers(preview.content), spec.maxBodyTokens)}`,
          };
        }),
    )
  ).filter((preview): preview is { relativePath: string; text: string } => Boolean(preview));
  for (const preview of keyFilePreviews) {
    sections.push({
      key: `key-file-${preview.relativePath}`,
      priority: 80,
      text: preview.text,
    });
  }

  const assembled = assembleSectionsWithinBudget(sections, profile.maxTotalTokens);
  logContextStats(mode, assembled);
  return assembled;
};
