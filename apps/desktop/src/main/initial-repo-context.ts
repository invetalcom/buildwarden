import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { countTokens } from "gpt-tokenizer";
import { isTextLikeFileName, type RunMode, type RunWorkspaceVcs } from "@buildwarden/shared";
import { createRunToolContext } from "./run-tools";

/** Rough token estimate if `countTokens` fails (rare). */
const charsToApproxTokens = (chars: number) => Math.max(1, Math.ceil(chars / 4));

const estimateContextTokens = (text: string): number => {
  try {
    return countTokens(text);
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
      { relativePath: "pnpm-workspace.yaml", maxBodyTokens: 550 },
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
      { relativePath: "pnpm-workspace.yaml", maxBodyTokens: 360 },
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

const listTopLevelEntries = async (worktreePath: string, maxEntries: number): Promise<string> => {
  const dirents = await readdir(worktreePath, { withFileTypes: true });
  const lines: string[] = [];

  for (const ent of dirents) {
    if (lines.length >= maxEntries) {
      break;
    }
    if (ent.name === ".git" || ent.name === "node_modules") {
      continue;
    }
    lines.push(ent.isDirectory() ? `${ent.name}/` : ent.name);
  }

  lines.sort((a, b) => a.localeCompare(b));
  return lines.length > 0 ? lines.join("\n") : "(empty worktree)";
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

const parsePackageScriptsSummary = (packageJsonText: string): string => {
  const parsed = safeJsonParse(packageJsonText);
  const scripts = parsed.scripts;
  if (!scripts || typeof scripts !== "object") {
    return "(no scripts section)";
  }
  return Object.entries(scripts)
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
    const packageMatches = workspaceYamlText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
    if (packageMatches.length > 0) {
      parts.push(`pnpm workspace globs: ${packageMatches.slice(0, 10).join(", ")}`);
    }
  }
  return parts.join("\n") || "(single-package or workspace config not detected)";
};

const extractEntryPointCandidates = (listingContent: string): string[] => {
  const lines = listingContent.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const preferred = lines.filter((line) =>
    /(?:^|\/)(src\/index|src\/main|src\/app|app|main|index|App)\.(ts|tsx|js|jsx|py|go|rs|java|html)$/i.test(line),
  );
  return preferred.slice(0, 8);
};

const detectEntryPointCandidates = async (toolContext: ReturnType<typeof createRunToolContext>): Promise<string[]> => {
  const result = await toolContext.executeTool({
    id: "initial-entrypoints-search",
    name: "list_files",
    arguments: { path: ".", maxEntries: 220 },
  });
  return result.ok ? extractEntryPointCandidates(result.content) : [];
};

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
  return `${relativePath}:\n${await minimizePreviewText(preview.content, maxBodyTokens)}`;
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
    if (truncated.trim()) {
      selected.push(truncated);
    }
    break;
  }

  return selected.join("\n\n");
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
  const recursiveListingPromise =
    profile.listStyle === "recursive"
      ? toolContext.executeTool({
          id: "initial-list-files",
          name: "list_files",
          arguments: { path: ".", maxEntries: profile.listMaxEntries },
        })
      : null;
  const topLevelListingPromise = profile.listStyle === "top_level" ? listTopLevelEntries(worktreePath, profile.listMaxEntries) : null;
  const entrypointsPromise =
    profile.listStyle === "recursive" && recursiveListingPromise
      ? recursiveListingPromise.then((result) => (result.ok ? extractEntryPointCandidates(result.content) : []))
      : detectEntryPointCandidates(toolContext);

  const [gitStatus, packageJsonPreview, workspaceYamlPreview, entrypoints, recursiveListing, topLevelListing] = await Promise.all([
    gitStatusPromise,
    packageJsonPreviewPromise,
    workspaceYamlPreviewPromise,
    entrypointsPromise,
    recursiveListingPromise ?? Promise.resolve(null),
    topLevelListingPromise ?? Promise.resolve(null),
  ]);

  const gitStatusText = gitStatus?.content ?? "Git history unavailable: this run uses a plain project folder.";
  const changedFiles = gitStatus?.content ? parseChangedFiles(gitStatus.content, profile.changedFilesMax) : [];
  const sections: ContextSection[] = [
    {
      key: "facts",
      priority: 10,
      text: [
        workspaceVcs === "git" ? "Repository facts:" : "Project folder facts:",
        "- Workspace root: .",
        `- Mode: ${mode}`,
        `- Model: ${normalizedOptions.modelId ?? "(unknown)"}`,
        "",
        workspaceVcs === "git" ? "Git (branch + short status):" : "Git:",
        gitStatusText,
      ].join("\n"),
    },
  ];

  if (packageJsonPreview?.ok) {
    sections.push({
      key: "workspace",
      priority: 20,
      text: [
        "Package / workspace map:",
        parseWorkspaceSummary(packageJsonPreview.content, workspaceYamlPreview?.ok ? workspaceYamlPreview.content : null),
        "",
        "Likely commands:",
        parsePackageScriptsSummary(packageJsonPreview.content),
      ].join("\n"),
    });
  }

  if (entrypoints.length > 0) {
    sections.push({
      key: "entrypoints",
      priority: 30,
      text: ["Key entrypoints:", ...entrypoints.map((entry) => `- ${entry}`)].join("\n"),
    });
  }

  if (changedFiles.length > 0) {
    sections.push({
      key: "changed-files",
      priority: 40,
      text: ["Recently changed files:", ...changedFiles.map((entry) => `- ${entry}`)].join("\n"),
    });
  }

  if (promptHints.length > 0) {
    sections.push({
      key: "prompt-hints",
      priority: 50,
      text: ["Files or paths mentioned in the prompt:", ...promptHints.map((entry) => `- ${entry}`)].join("\n"),
    });
  }

  if (profile.listStyle === "top_level" && topLevelListing) {
    sections.push({
      key: "top-level",
      priority: 60,
      text: `Top-level files and folders:\n${topLevelListing}`,
    });
  }

  if (profile.listStyle === "recursive" && recursiveListing?.ok) {
    sections.push({
      key: "file-map",
      priority: 60,
      text: `Workspace file map:\n${recursiveListing.content}`,
    });
  }

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
            text: `${basename(spec.relativePath)} preview:\n${await minimizePreviewText(preview.content, spec.maxBodyTokens)}`,
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
