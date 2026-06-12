import { Buffer } from "node:buffer";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import readline from "node:readline";
import type {
  ChatAttachmentPayload,
  HarnessAdapter,
  HarnessToolContext,
  HarnessRunChunk,
  NetworkProxyRuntimeConfig,
  ProviderAccountInput,
  ProviderAdapter,
  RunExecutionRequest,
  RunUserInputAnswers,
  RunUserInputQuestion,
  RunUserInputRequest,
  ShellApprovalDecision,
  RunTokenUsage,
} from "@buildwarden/shared";
import {
  getCodexCliRecommendedModelIds,
  MODEL_CONFIG_CODEX_REASONING_EFFORT_KEY,
  PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CODEX_HOME_PATH_KEY,
  buildNetworkProxyUrl,
  runShellActivityStreamId,
} from "@buildwarden/shared";
import { createDevLogger } from "./dev-logger";

const CODEX_DEFAULT_MODEL = getCodexCliRecommendedModelIds()[0] ?? "gpt-5.3-codex";
const INITIALIZE_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 20 * 60 * 1_000;
const MAX_FILE_BYTES = 120_000;
const MAX_WRITE_FILE_DIFF_CHARS = 100_000;
const CODEX_SANDBOX_MODE = process.platform === "win32" ? "danger-full-access" : "workspace-write";
const CODEX_APPROVAL_POLICY = "on-request";
const CODEX_YOLO_SANDBOX_MODE = "danger-full-access";
const CODEX_YOLO_APPROVAL_POLICY = "never";
const CODEX_YOLO_FLAG = "--dangerously-bypass-approvals-and-sandbox";

type JsonRpcId = string | number;

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type CodexCliResolvedConfig = {
  binaryPath: string;
  homePath?: string;
};

type PendingRequest = {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type TurnExecutionOptions = {
  runId: string;
  cwd: string;
  prompt: string;
  modelId: string;
  previousThreadId?: string | null;
  repoContext?: string;
  inputMode: RunExecutionRequest["mode"];
  isChat?: boolean;
  attachments?: ChatAttachmentPayload[];
  networkProxy?: NetworkProxyRuntimeConfig;
  config?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  providerOptions?: {
    reasoningEffort?: string;
  };
  yoloMode?: boolean;
  signal: AbortSignal;
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>;
  requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>;
  onChunk?: (chunk: HarnessRunChunk) => void;
  devLogging?: {
    logDirPath: string;
  };
};

type TurnExecutionResult = {
  summary: string;
  threadId: string;
  usage: RunTokenUsage;
};

const readProviderSessionCursorId = (value: RunExecutionRequest["providerSessionRuntime"] | undefined | null): string | null => {
  const cursor = value?.resumeCursor;
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    return null;
  }
  const threadId = cursor.threadId;
  return typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
};

type CommandExecutionContext = {
  command: string;
  cwd?: string;
  toolName: "run_shell" | "read_file";
  path?: string;
};

type FileChangeSnapshot = {
  paths: string[];
  beforeByPath: Map<string, string | null>;
};

const DEFAULT_COLLABORATION_INSTRUCTIONS =
  "<collaboration_mode># Collaboration Mode: Default\n\nExecute concrete work when appropriate, keep progress updates concise, and finish with a short practical summary.\n</collaboration_mode>";

const PLAN_COLLABORATION_INSTRUCTIONS =
  "<collaboration_mode># Plan Mode\n\nInspect first, avoid making changes, and produce a concrete implementation plan. If an important product or implementation choice is ambiguous and would materially change the plan, ask the user one concise structured question with the request_user_input tool before finalizing the plan. End the final plan with a compact numbered implementation-step table or checklist that BuildWarden can display as plan steps.\n</collaboration_mode>";

const BUILDWARDEN_DEVELOPER_INSTRUCTIONS = [
  "You are BuildWarden, a desktop coding agent running inside a Git worktree.",
  "You are operating on a local codebase and can inspect and modify files from the current workspace.",
  "Use repository context when it is provided, and inspect files before making assumptions.",
  "The workspace root is already the current working directory. Do not prefix commands with cd.",
  "Run one non-interactive repo-local command at a time. Avoid chaining commands with &&, |, ;, redirection, or backticks.",
  "All file paths should be relative to the workspace root unless the user explicitly asks for an absolute path.",
  "On Windows, shell commands run in PowerShell. Prefer Windows-safe commands.",
  "On Windows, use npm.cmd, pnpm.cmd, and npx.cmd instead of npm, pnpm, or npx to avoid PowerShell ExecutionPolicy issues.",
  "On Windows, prefer .\\\\script.bat over ./script when invoking batch files such as Gradle wrappers.",
  "When diffing specific files with git, use git diff -- <path1> <path2> so Git treats them as pathspecs.",
  "Use git inspection commands for read-only repo inspection unless the user clearly asked for a git-changing action.",
  "Share short progress updates during substantive work and finish with a concise summary.",
].join("\n");

const MODE_INSTRUCTIONS: Record<RunExecutionRequest["mode"], string> = {
  code: [
    "You are in code mode.",
    "Implement the requested changes directly when appropriate.",
    "Inspect files and verify your work when useful.",
  ].join("\n"),
  plan: [
    "You are in plan mode.",
    "Do not modify files or claim to have changed files.",
    "Inspect the repository and produce a concrete implementation plan.",
    "If an important product or implementation choice is ambiguous and would materially change the plan, ask one concise structured question with request_user_input before finalizing the plan.",
    "End with a compact numbered implementation-step table or checklist.",
  ].join("\n"),
  ask: [
    "You are in ask mode.",
    "Do not modify files or claim to have changed files.",
    "Inspect only what you need and answer directly.",
  ].join("\n"),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const asArray = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const stringifyValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const normalizeUserInputOption = (value: unknown): { label: string; description?: string } | null => {
  if (typeof value === "string") {
    const label = value.trim();
    return label ? { label } : null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const label = asString(record.label)?.trim() ?? asString(record.value)?.trim() ?? "";
  if (!label) {
    return null;
  }
  const description = asString(record.description)?.trim();
  return {
    label,
    ...(description ? { description } : {}),
  };
};

const normalizeUserInputQuestions = (value: unknown, fallbackPrompt: string): RunUserInputQuestion[] => {
  const record = asRecord(value) ?? {};
  const rawQuestions = asArray(record.questions);
  const candidates = rawQuestions && rawQuestions.length > 0 ? rawQuestions : [record];

  const questions = candidates
    .map((candidate, index): RunUserInputQuestion | null => {
      const questionRecord = asRecord(candidate) ?? {};
      const question =
        asString(questionRecord.question)?.trim() ??
        asString(questionRecord.prompt)?.trim() ??
        asString(questionRecord.message)?.trim() ??
        (typeof candidate === "string" ? candidate.trim() : "") ??
        (index === 0 ? fallbackPrompt.trim() : "");
      if (!question) {
        return null;
      }
      const id = asString(questionRecord.id)?.trim() || question;
      const header = asString(questionRecord.header)?.trim() || `Question ${String(index + 1)}`;
      const options = (asArray(questionRecord.options) ?? [])
        .map(normalizeUserInputOption)
        .filter((option): option is { label: string; description?: string } => option !== null);
      return {
        id,
        header,
        question,
        options,
        multiSelect: questionRecord.multiSelect === true,
        allowCustomAnswer:
          options.length === 0 || questionRecord.allowCustomAnswer === true || questionRecord.isOther === true,
      };
    })
    .filter((question): question is RunUserInputQuestion => question !== null);

  return questions.length > 0
    ? questions
    : [
        {
          id: "response",
          header: "Question",
          question: fallbackPrompt || "Codex requested user input.",
          options: [],
          allowCustomAnswer: true,
        },
      ];
};

const toCodexUserInputAnswers = (answers: RunUserInputAnswers): Record<string, { answers: string[] }> =>
  Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      {
        answers: (Array.isArray(value) ? value : [value]).map((entry) => String(entry)),
      },
    ]),
  );

const humanizeCodexItemType = (value: string): string =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());

const toPosix = (value: string): string => value.replaceAll("\\", "/");

const normalizeTextForDiff = (value: string): string =>
  value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const buildWriteFileUnifiedDiff = (
  posixPath: string,
  oldContent: string | null,
  newContent: string | null,
): string | null => {
  const path = posixPath.replace(/\\/g, "/");
  const normalizedOld = oldContent === null ? null : normalizeTextForDiff(oldContent);
  const normalizedNew = newContent === null ? null : normalizeTextForDiff(newContent);

  if (normalizedOld === normalizedNew) {
    return null;
  }

  let diff: string;
  if (normalizedOld === null && normalizedNew !== null) {
    const newLines = normalizedNew.split("\n");
    diff = `diff --git a/${path} b/${path}\n`;
    diff += "new file mode 100644\n";
    diff += "--- /dev/null\n";
    diff += `+++ b/${path}\n`;
    diff += `@@ -0,0 +1,${newLines.length} @@\n`;
    for (const line of newLines) {
      diff += `+${line}\n`;
    }
  } else if (normalizedOld !== null && normalizedNew === null) {
    const oldLines = normalizedOld.split("\n");
    diff = `diff --git a/${path} b/${path}\n`;
    diff += "deleted file mode 100644\n";
    diff += `--- a/${path}\n`;
    diff += "+++ /dev/null\n";
    diff += `@@ -1,${oldLines.length} +0,0 @@\n`;
    for (const line of oldLines) {
      diff += `-${line}\n`;
    }
  } else if (normalizedOld !== null && normalizedNew !== null) {
    const oldLines = normalizedOld.split("\n");
    const newLines = normalizedNew.split("\n");
    diff = `diff --git a/${path} b/${path}\n`;
    diff += `--- a/${path}\n`;
    diff += `+++ b/${path}\n`;
    diff += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
    for (const line of oldLines) {
      diff += `-${line}\n`;
    }
    for (const line of newLines) {
      diff += `+${line}\n`;
    }
  } else {
    return null;
  }

  if (diff.length > MAX_WRITE_FILE_DIFF_CHARS) {
    return `${diff.slice(0, MAX_WRITE_FILE_DIFF_CHARS)}\n# ... diff truncated for display\n`;
  }

  return diff;
};

const readDiffableFile = async (rootCwd: string, filePath: string): Promise<string | null> => {
  const target = resolve(rootCwd, filePath);
  try {
    const fileStat = await stat(target);
    if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) {
      return null;
    }
    return await readFile(target, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
};

const normalizePathCandidate = (cwd: string, value: string): string | null => {
  const trimmed = value.trim().replace(/^['"`]|['"`]$/g, "");
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) {
    return null;
  }
  if (/^(https?:|data:)/i.test(trimmed)) {
    return null;
  }
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  const rel = relative(cwd, absolute);
  if (!rel || rel.startsWith("..")) {
    return null;
  }
  return toPosix(rel);
};

const extractPathCandidates = (cwd: string, value: unknown, seen = new Set<string>()): string[] => {
  if (typeof value === "string") {
    const normalized = normalizePathCandidate(cwd, value);
    if (normalized) {
      seen.add(normalized);
    }
    return [...seen];
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractPathCandidates(cwd, item, seen);
    }
    return [...seen];
  }

  const record = asRecord(value);
  if (!record) {
    return [...seen];
  }

  for (const [key, child] of Object.entries(record)) {
    const lowerKey = key.toLowerCase();
    const looksPathLike =
      lowerKey === "path" ||
      lowerKey.endsWith("path") ||
      lowerKey === "file" ||
      lowerKey === "filepath" ||
      lowerKey === "relativepath";
    if (looksPathLike && typeof child === "string") {
      const normalized = normalizePathCandidate(cwd, child);
      if (normalized) {
        seen.add(normalized);
      }
    } else if (typeof child === "object" && child !== null) {
      extractPathCandidates(cwd, child, seen);
    }
  }

  return [...seen];
};

const buildShellResultContent = (output: string, exitCode?: number): string => {
  const trimmed = output.trim();
  if (trimmed) {
    return trimmed;
  }
  if (exitCode != null && exitCode !== 0) {
    return `Command exited with code ${String(exitCode)} with no output.`;
  }
  return "Command completed with no output.";
};

const inferReadFilePathFromCommand = (cwd: string, command: string): string | null => {
  const patterns = [
    /(?:Get-Content|gc)\s+(?:-LiteralPath\s+|-Path\s+)?['"]([^'"\r\n]+)['"]/i,
    /(?:Get-Content|gc)\s+(?:-LiteralPath\s+|-Path\s+)?([^\s'"`][^\r\n]*)/i,
    /(?:^|\s)(?:cat|type)\s+['"]([^'"\r\n]+)['"]/i,
    /(?:^|\s)(?:cat|type)\s+([^\s'"`][^\r\n]*)/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(command);
    const candidate = match?.[1]?.trim();
    if (!candidate) {
      continue;
    }
    const normalized = normalizePathCandidate(cwd, candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};

const inferCommandExecutionContext = (
  cwd: string,
  fullCommand: string,
  simplifiedCommand?: string,
): CommandExecutionContext => {
  const command = simplifiedCommand?.trim() || fullCommand.trim() || "Command";
  const readFilePath = inferReadFilePathFromCommand(cwd, simplifiedCommand ?? fullCommand);
  if (readFilePath) {
    return {
      command,
      cwd,
      toolName: "read_file",
      path: readFilePath,
    };
  }
  return {
    command,
    cwd,
    toolName: "run_shell",
  };
};

const isRecoverableThreadResumeError = (error: unknown): boolean => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("thread/resume") &&
    ["not found", "missing thread", "no such thread", "unknown thread", "does not exist"].some((snippet) =>
      message.includes(snippet),
    )
  );
};

export const normalizeCodexTokenUsage = (value: unknown): RunTokenUsage => {
  const usage = asRecord(value);
  const total = asRecord(usage?.total_token_usage ?? usage?.totalTokenUsage ?? usage?.total);
  const last = asRecord(usage?.last_token_usage ?? usage?.lastTokenUsage ?? usage?.last ?? usage);
  const totalInputTokens = asNumber(total?.input_tokens) ?? asNumber(total?.inputTokens);
  const totalOutputTokens = asNumber(total?.output_tokens) ?? asNumber(total?.outputTokens);
  const totalReasoningTokens =
    asNumber(total?.reasoning_tokens) ??
    asNumber(total?.reasoningTokens) ??
    asNumber(total?.reasoning_output_tokens) ??
    asNumber(total?.reasoningOutputTokens);
  const totalCachedInputTokens =
    asNumber(total?.cached_input_tokens) ??
    asNumber(total?.cachedInputTokens) ??
    asNumber(total?.cache_read_input_tokens) ??
    asNumber(total?.cacheReadInputTokens);
  const totalCacheCreationInputTokens =
    asNumber(total?.cache_creation_input_tokens) ??
    asNumber(total?.cacheCreationInputTokens) ??
    asNumber(total?.cache_write_input_tokens) ??
    asNumber(total?.cacheWriteInputTokens);
  const totalTokens = asNumber(total?.total_tokens) ?? asNumber(total?.totalTokens);
  const lastInputTokens = asNumber(last?.input_tokens) ?? asNumber(last?.inputTokens);
  const lastOutputTokens = asNumber(last?.output_tokens) ?? asNumber(last?.outputTokens);
  const lastReasoningTokens =
    asNumber(last?.reasoning_tokens) ??
    asNumber(last?.reasoningTokens) ??
    asNumber(last?.reasoning_output_tokens) ??
    asNumber(last?.reasoningOutputTokens);
  const lastCachedInputTokens =
    asNumber(last?.cached_input_tokens) ??
    asNumber(last?.cachedInputTokens) ??
    asNumber(last?.cache_read_input_tokens) ??
    asNumber(last?.cacheReadInputTokens);
  const lastCacheCreationInputTokens =
    asNumber(last?.cache_creation_input_tokens) ??
    asNumber(last?.cacheCreationInputTokens) ??
    asNumber(last?.cache_write_input_tokens) ??
    asNumber(last?.cacheWriteInputTokens);
  const lastUsedTokens =
    asNumber(last?.total_tokens) ??
    asNumber(last?.totalTokens) ??
    ((lastInputTokens ?? 0) + (lastOutputTokens ?? 0) > 0
      ? (lastInputTokens ?? 0) + (lastOutputTokens ?? 0)
      : undefined);
  const totalProcessedTokens =
    totalTokens ??
    ((totalInputTokens ?? 0) + (totalOutputTokens ?? 0) > 0
      ? (totalInputTokens ?? 0) + (totalOutputTokens ?? 0)
      : undefined);
  const maxTokens =
    asNumber(usage?.model_context_window) ??
    asNumber(usage?.modelContextWindow) ??
    asNumber(total?.model_context_window) ??
    asNumber(total?.modelContextWindow);
  return {
    inputTokens: totalInputTokens ?? lastInputTokens ?? 0,
    outputTokens: totalOutputTokens ?? lastOutputTokens ?? 0,
    reasoningTokens: totalReasoningTokens ?? lastReasoningTokens,
    cachedInputTokens: totalCachedInputTokens ?? lastCachedInputTokens,
    cacheCreationInputTokens: totalCacheCreationInputTokens ?? lastCacheCreationInputTokens,
    totalTokens: totalProcessedTokens ?? lastUsedTokens,
    usedTokens: lastUsedTokens,
    totalProcessedTokens,
    maxTokens,
    lastUsedTokens,
    lastInputTokens,
    lastCachedInputTokens,
    lastOutputTokens,
    lastReasoningTokens,
  };
};

const decodeAttachmentText = (attachment: ChatAttachmentPayload): string => {
  try {
    return Buffer.from(attachment.dataBase64, "base64").toString("utf8");
  } catch {
    return `[Could not decode ${attachment.fileName}]`;
  }
};

const buildPromptWithAttachments = (prompt: string, attachments: ChatAttachmentPayload[] | undefined): string => {
  const base = prompt.trim();
  if (!attachments?.length) {
    return base;
  }

  const parts = [base];
  for (const attachment of attachments) {
    const mime = attachment.mimeType.toLowerCase();
    if (mime.startsWith("image/")) {
      continue;
    }
    if (mime === "application/pdf") {
      parts.push(`Attached PDF: ${attachment.fileName}`);
      continue;
    }
    const text = decodeAttachmentText(attachment);
    parts.push(`Attached file: ${attachment.fileName}\n\`\`\`\n${text.slice(0, 200_000)}\n\`\`\``);
  }

  return parts.filter(Boolean).join("\n\n").trim();
};

const buildTurnInput = (prompt: string, attachments: ChatAttachmentPayload[] | undefined) => {
  const items: Array<{ type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }> = [];
  const promptWithAttachments = buildPromptWithAttachments(prompt, attachments);
  if (promptWithAttachments) {
    items.push({
      type: "text",
      text: promptWithAttachments,
      text_elements: [],
    });
  }
  for (const attachment of attachments ?? []) {
    if (!attachment.mimeType.toLowerCase().startsWith("image/")) {
      continue;
    }
    items.push({
      type: "image",
      url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
    });
  }
  if (items.length === 0) {
    items.push({
      type: "text",
      text: "Continue.",
      text_elements: [],
    });
  }
  return items;
};

const buildPromptForMode = (input: {
  prompt: string;
  inputMode: RunExecutionRequest["mode"];
  repoContext?: string;
  previousThreadId?: string | null;
  isChat?: boolean;
}): string => {
  if (input.isChat) {
    return input.prompt;
  }
  if (input.inputMode === "ask") {
    return [
      `Task: ${input.prompt}`,
      input.repoContext ? `Repository context:\n${input.repoContext}` : "Repository context is unavailable.",
      MODE_INSTRUCTIONS.ask,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    `Mode: ${input.inputMode}`,
    "Workspace: .",
    input.previousThreadId ? `Follow-up task: ${input.prompt}` : `Task: ${input.prompt}`,
    input.repoContext ? `Repository context:\n${input.repoContext}` : "Repository context is unavailable. Inspect the workspace as needed.",
    MODE_INSTRUCTIONS[input.inputMode],
  ]
    .filter(Boolean)
    .join("\n\n");
};

const buildCollaborationMode = (
  mode: RunExecutionRequest["mode"],
  modelId: string,
  reasoningEffort: string,
):
  | {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string;
        developer_instructions: string;
      };
    }
  | undefined => {
  if (mode === "ask") {
    return undefined;
  }
    return {
      mode: mode === "plan" ? "plan" : "default",
      settings: {
        model: modelId || CODEX_DEFAULT_MODEL,
        reasoning_effort: reasoningEffort,
        developer_instructions: [
          mode === "plan" ? PLAN_COLLABORATION_INSTRUCTIONS : DEFAULT_COLLABORATION_INSTRUCTIONS,
          BUILDWARDEN_DEVELOPER_INSTRUCTIONS,
        ].join("\n\n"),
      },
  };
};

const resolveCodexReasoningEffort = (
  providerOptions: { reasoningEffort?: string } | undefined,
  modelConfig: Record<string, unknown> | undefined,
): string => {
  const raw = providerOptions?.reasoningEffort || modelConfig?.[MODEL_CONFIG_CODEX_REASONING_EFFORT_KEY];
  return typeof raw === "string" && raw.trim() ? raw.trim() : "medium";
};

const resolveCodexCliConfig = (config: Record<string, unknown> | undefined): CodexCliResolvedConfig => {
  const binaryPath = asString(config?.[PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY])?.trim() || "codex";
  const homePath = asString(config?.[PROVIDER_CONFIG_CODEX_HOME_PATH_KEY])?.trim() || undefined;
  return {
    binaryPath,
    ...(homePath ? { homePath } : {}),
  };
};

const buildCodexProcessEnv = (
  cwd: string,
  homePath?: string,
  networkProxy?: NetworkProxyRuntimeConfig,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(homePath ? { CODEX_HOME: homePath } : {}),
  };

  if (networkProxy) {
    const proxyUrl = buildNetworkProxyUrl(networkProxy);
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    const noProxy = networkProxy.noProxyHosts.join(",");
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const existingEntries = String(env[pathKey] ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const preferredEntries = [resolve(cwd, "node_modules", ".bin")];
  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      preferredEntries.push(resolve(process.env.APPDATA, "npm"));
    }
    preferredEntries.push(resolve(process.execPath, ".."));
    if (process.env.LOCALAPPDATA) {
      preferredEntries.push(resolve(process.env.LOCALAPPDATA, "Programs", "nodejs"));
    }
    if (process.env.ProgramFiles) {
      preferredEntries.push(resolve(process.env.ProgramFiles, "nodejs"));
    }
    if (process.env["ProgramFiles(x86)"]) {
      preferredEntries.push(resolve(process.env["ProgramFiles(x86)"], "nodejs"));
    }
  }

  const nextPathEntries: string[] = [];
  for (const entry of [...preferredEntries, ...existingEntries]) {
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    if (nextPathEntries.some((current) => current.toLowerCase() === normalized.toLowerCase())) {
      continue;
    }
    nextPathEntries.push(normalized);
  }

  const nextPath = nextPathEntries.join(delimiter);
  env[pathKey] = nextPath;
  if (process.platform === "win32") {
    env.Path = nextPath;
    env.PATH = nextPath;
  }

  const existingGitConfigCount = Number(env.GIT_CONFIG_COUNT ?? "0");
  const safeDirectoryIndex = Number.isFinite(existingGitConfigCount) && existingGitConfigCount >= 0 ? existingGitConfigCount : 0;
  env.GIT_CONFIG_COUNT = String(safeDirectoryIndex + 1);
  env[`GIT_CONFIG_KEY_${String(safeDirectoryIndex)}`] = "safe.directory";
  env[`GIT_CONFIG_VALUE_${String(safeDirectoryIndex)}`] = toPosix(cwd);

  return env;
};

const killChildTree = (child: ChildProcessWithoutNullStreams): void => {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fall through
    }
  }
  child.kill();
};

class CodexAppServerSession {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly output: readline.Interface;
  private nextRequestId = 1;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private usage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };
  private assistantText = "";
  private stopped = false;
  private readonly activeItemTypes = new Map<string, string>();
  private readonly itemOutputs = new Map<string, string>();
  private readonly itemPhases = new Map<string, string>();
  private readonly agentMessages = new Map<string, string>();
  private readonly reasoningMessages = new Map<string, string>();
  private readonly planMessages = new Map<string, string>();
  private readonly commandExecutions = new Map<string, CommandExecutionContext>();
  private readonly fileChangeSnapshots = new Map<string, FileChangeSnapshot>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestThreadId: string,
    private readonly cwd: string,
    private readonly requestShellApproval: ((command: string) => Promise<ShellApprovalDecision>) | undefined,
    private readonly requestUserInput: ((request: RunUserInputRequest) => Promise<RunUserInputAnswers>) | undefined,
    private readonly onChunk: ((chunk: HarnessRunChunk) => void) | undefined,
    private readonly devLogger?: { log: (event: string, data: unknown) => void },
  ) {
    this.output = readline.createInterface({ input: child.stdout });
    this.output.on("line", (line) => {
      this.handleStdoutLine(line);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (!message) {
        return;
      }
      this.devLogger?.log("codex.stderr", { message });
      this.onChunk?.({
        type: "status",
        title: "Codex CLI",
        value: message,
        metadata: { silent: true },
      });
    });
    this.child.on("error", (error) => {
      const pendingTurn = this.pending.get("__turn_complete__");
      if (pendingTurn) {
        clearTimeout(pendingTurn.timeout);
        pendingTurn.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.on("exit", (code, signal) => {
      if (this.stopped) {
        return;
      }
      const pendingTurn = this.pending.get("__turn_complete__");
      if (pendingTurn) {
        clearTimeout(pendingTurn.timeout);
        pendingTurn.reject(
          new Error(`Codex app-server exited early (code=${code ?? "null"}, signal=${signal ?? "null"}).`),
        );
      }
    });
  }

  getResult(): TurnExecutionResult {
    return {
      summary: this.assistantText.trim() || "Codex run completed.",
      threadId: this.threadId ?? this.requestThreadId,
      usage: this.usage,
    };
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex session stopped before the request completed."));
    }
    this.pending.clear();
    this.output.close();
    if (!this.child.killed) {
      killChildTree(this.child);
    }
  }

  async initialize(modelId: string, cwd: string, previousThreadId?: string | null, yoloMode = false): Promise<void> {
    await this.sendRequest("initialize", {
      clientInfo: {
        name: "buildwarden_desktop",
        title: "BuildWarden Desktop",
        version: "0.4.3",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.writeMessage({ method: "initialized" });
    try {
      await this.sendRequest("account/read", {});
    } catch {
      // Older/newer Codex builds may vary here. The app server still works without this call.
    }

    if (previousThreadId) {
      try {
        const resumed = await this.sendRequest("thread/resume", {
          threadId: previousThreadId,
          model: modelId,
          cwd,
          approvalPolicy: yoloMode ? CODEX_YOLO_APPROVAL_POLICY : CODEX_APPROVAL_POLICY,
          sandbox: yoloMode ? CODEX_YOLO_SANDBOX_MODE : CODEX_SANDBOX_MODE,
        });
        const threadId = this.readThreadId(resumed);
        if (threadId) {
          this.threadId = threadId;
          return;
        }
      } catch (error) {
        if (!isRecoverableThreadResumeError(error)) {
          throw error;
        }
      }
    }

    const started = await this.sendRequest("thread/start", {
      model: modelId,
      cwd,
      approvalPolicy: yoloMode ? CODEX_YOLO_APPROVAL_POLICY : CODEX_APPROVAL_POLICY,
      sandbox: yoloMode ? CODEX_YOLO_SANDBOX_MODE : CODEX_SANDBOX_MODE,
      experimentalRawEvents: false,
    });
    const threadId = this.readThreadId(started);
    if (!threadId) {
      throw new Error("Codex thread/start did not return a thread id.");
    }
    this.threadId = threadId;
  }

  async startTurn(input: {
    prompt: string;
    attachments?: ChatAttachmentPayload[];
    modelId: string;
    mode: RunExecutionRequest["mode"];
    repoContext?: string;
    isChat?: boolean;
    modelConfig?: Record<string, unknown>;
    providerOptions?: {
      reasoningEffort?: string;
    };
    signal: AbortSignal;
  }): Promise<TurnExecutionResult> {
    if (!this.threadId) {
      throw new Error("Codex session was not initialized.");
    }

    const turnCompletion = new Promise<TurnExecutionResult>((resolve, reject) => {
      const abortListener = () => {
        void this.interruptTurn().finally(() => {
          reject(new Error("Run cancelled."));
          this.stop();
        });
      };
      input.signal.addEventListener("abort", abortListener, { once: true });

      const finish = (error?: Error) => {
        input.signal.removeEventListener("abort", abortListener);
        if (error) {
          reject(error);
          return;
        }
        resolve(this.getResult());
      };

      this.pending.set("__turn_complete__", {
        method: "turn/completed",
        timeout: setTimeout(() => {
          this.pending.delete("__turn_complete__");
          finish(new Error("Timed out waiting for Codex to finish the turn."));
        }, TURN_TIMEOUT_MS),
        resolve: () => {
          this.pending.delete("__turn_complete__");
          finish();
        },
        reject: (error) => {
          this.pending.delete("__turn_complete__");
          finish(error);
        },
      });
    });

    const response = await this.sendRequest("turn/start", {
      threadId: this.threadId,
      input: buildTurnInput(
        buildPromptForMode({
          prompt: input.prompt,
          inputMode: input.mode,
          repoContext: input.repoContext,
          previousThreadId: this.threadId,
          isChat: input.isChat,
        }),
        input.attachments,
      ),
      model: input.modelId,
      collaborationMode: buildCollaborationMode(
        input.mode,
        input.modelId,
        resolveCodexReasoningEffort(input.providerOptions, input.modelConfig),
      ),
    });
    const turnId = asString(asRecord(asRecord(response)?.turn)?.id);
    if (!turnId) {
      throw new Error("Codex turn/start did not return a turn id.");
    }
    this.turnId = turnId;
    this.onChunk?.({
      type: "status",
      value: input.isChat ? "Chat started." : "Codex is working in the workspace.",
    });

    return turnCompletion;
  }

  private async interruptTurn(): Promise<void> {
    if (!this.threadId || !this.turnId) {
      return;
    }
    try {
      await this.sendRequest("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.turnId,
      });
    } catch {
      // Best effort before terminating the child process.
    }
  }

  private handleStdoutLine(line: string): void {
    this.devLogger?.log("codex.stdout", { line });
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (this.isServerNotification(parsed)) {
      this.handleNotification(parsed);
      return;
    }

    if (this.isServerRequest(parsed)) {
      this.handleServerRequest(parsed);
      return;
    }

    if (this.isResponse(parsed)) {
      this.handleResponse(parsed);
    }
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    this.devLogger?.log("codex.rpc.request", request);
    if (request.method === "item/commandExecution/requestApproval") {
      const params = asRecord(request.params);
      const command =
        asString(params?.command) ??
        asString(asRecord(params?.item)?.command) ??
        asString(asRecord(asArray(asRecord(params?.item)?.commandActions)?.[0])?.command) ??
        "Command";
      void (async () => {
        const decision = this.requestShellApproval ? await this.requestShellApproval(command) : "allow-once";
        this.writeMessage({
          id: request.id,
          result: {
            decision: decision === "deny" ? "deny" : "accept",
          },
        });
      })().catch((error) => {
        this.writeMessage({
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : "Shell approval failed.",
          },
        });
      });
      return;
    }

    if (request.method === "item/fileRead/requestApproval" || request.method === "item/fileChange/requestApproval") {
      this.writeMessage({
        id: request.id,
        result: {
          decision: "accept",
        },
      });
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      const params = asRecord(request.params);
      const item = asRecord(params?.item);
      const prompt =
        asString(params?.prompt)?.trim() ||
        asString(params?.question)?.trim() ||
        asString(params?.message)?.trim() ||
        asString(item?.prompt)?.trim() ||
        asString(item?.question)?.trim() ||
        asString(item?.message)?.trim() ||
        "";
      const questionSource = asArray(params?.questions) ? params : item ?? params ?? {};
      const questions = normalizeUserInputQuestions(questionSource, prompt || "Codex requested user input.");
      const hasStructuredQuestions = questions.length > 0;
      const displayContent = prompt || (hasStructuredQuestions ? "" : stringifyValue(params));
      if (this.requestUserInput) {
        void (async () => {
          const answers = await this.requestUserInput?.({
            requestId: String(request.id),
            title: "Codex question",
            content: displayContent,
            questions,
            metadata: {
              provider: "codex-cli",
              rawRequestMethod: request.method,
              rawRequestParams: params ?? {},
            },
          });
          if (!answers) {
            throw new Error("No answers were returned for Codex user input.");
          }
          this.writeMessage({
            id: request.id,
            result: {
              answers: toCodexUserInputAnswers(answers),
            },
          });
        })().catch((error) => {
          this.writeMessage({
            id: request.id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : "User input failed.",
            },
          });
        });
        return;
      }
      this.onChunk?.({
        type: "user-input-requested",
        title: "Codex question",
        value: displayContent,
        metadata: {
          provider: "codex-cli",
          requestKind: "user-input",
          requestStatus: "opened",
          requestId: request.id,
          userInputQuestions: questions,
          rawRequestMethod: request.method,
          rawRequestParams: params ?? {},
        },
      });
      this.writeMessage({
        id: request.id,
        error: {
          code: -32601,
          message: "BuildWarden does not support Codex request_user_input in this mode.",
        },
      });
      return;
    }

    this.writeMessage({
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported request: ${request.method}`,
      },
    });
  }

  private handleNotification(notification: JsonRpcNotification): void {
    this.devLogger?.log("codex.rpc.notification", notification);
    const params = asRecord(notification.params);
    if (notification.method === "thread/started") {
      this.threadId = this.readThreadId(params) ?? this.threadId;
      return;
    }

    if (notification.method === "thread/tokenUsage/updated") {
      this.usage = normalizeCodexTokenUsage(asRecord(params?.tokenUsage) ?? params);
      this.onChunk?.({
        type: "status",
        value: "Usage updated.",
        metadata: {
          silent: true,
          usageTotals: this.usage,
        },
      });
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = asRecord(params?.turn);
      const errorMessage = asString(asRecord(turn?.error)?.message);
      this.usage = normalizeCodexTokenUsage(asRecord(turn?.usage) ?? turn?.usage);
      this.onChunk?.({
        type: "status",
        value: "Usage updated.",
        metadata: {
          silent: true,
          usageTotals: this.usage,
        },
      });
      const pendingTurn = this.pending.get("__turn_complete__");
      if (pendingTurn) {
        clearTimeout(pendingTurn.timeout);
        if ((asString(turn?.status) ?? "").toLowerCase() === "failed") {
          pendingTurn.reject(new Error(errorMessage || "Codex turn failed."));
        } else {
          pendingTurn.resolve(null);
        }
      }
      return;
    }

    if (notification.method === "error") {
      const message = asString(asRecord(params?.error)?.message) ?? "Codex app-server reported an error.";
      const willRetry = params?.willRetry === true;
      this.onChunk?.({
        type: willRetry ? "status" : "error",
        title: willRetry ? "Codex retrying" : "Codex error",
        value: message,
      });
      if (!willRetry) {
        const pendingTurn = this.pending.get("__turn_complete__");
        if (pendingTurn) {
          clearTimeout(pendingTurn.timeout);
          pendingTurn.reject(new Error(message));
        }
      }
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const itemId = asString(params?.itemId) ?? `codex-agent:${this.turnId ?? "turn"}`;
      const delta = asString(params?.delta) ?? asString(asRecord(params?.content)?.text) ?? "";
      if (!delta) {
        return;
      }
      const nextValue = `${this.agentMessages.get(itemId) ?? ""}${delta}`;
      this.agentMessages.set(itemId, nextValue);
      if (this.itemPhases.get(itemId) === "final_answer") {
        this.assistantText = nextValue;
      }
      this.onChunk?.({
        type: "message",
        title: "Agent output",
        value: nextValue,
        metadata: {
          streamId: itemId,
          replace: true,
        },
      });
      return;
    }

    if (notification.method === "item/reasoning/summaryTextDelta") {
      const itemId = asString(params?.itemId) ?? `codex-reasoning:${this.turnId ?? "turn"}`;
      const delta = asString(params?.delta) ?? "";
      if (!delta) {
        return;
      }
      const nextValue = `${this.reasoningMessages.get(itemId) ?? ""}${delta}`;
      this.reasoningMessages.set(itemId, nextValue);
      this.onChunk?.({
        type: "message",
        title: "Reasoning",
        value: nextValue,
        metadata: {
          streamId: itemId,
          replace: true,
          assistantKind: "reasoning",
        },
      });
      return;
    }

    if (notification.method === "item/plan/delta") {
      const itemId = asString(params?.itemId) ?? `codex-plan:${this.turnId ?? "turn"}`;
      const delta = asString(params?.delta) ?? asString(asRecord(params?.content)?.text) ?? "";
      if (!delta) {
        return;
      }
      const nextValue = `${this.planMessages.get(itemId) ?? ""}${delta}`;
      this.planMessages.set(itemId, nextValue);
      this.onChunk?.({
        type: "plan-updated",
        title: "Proposed plan",
        value: nextValue,
        metadata: {
          provider: "codex-cli",
          planKind: "proposal",
          streamId: itemId,
          replace: true,
        },
      });
      return;
    }

    if (
      notification.method === "item/commandExecution/outputDelta" ||
      notification.method === "item/fileChange/outputDelta"
    ) {
      const itemId = asString(params?.itemId) ?? asString(asRecord(params?.item)?.id) ?? "item";
      const delta = asString(params?.delta) ?? "";
      if (!delta) {
        return;
      }
      const existingType = this.activeItemTypes.get(itemId);
      const nextValue = `${this.itemOutputs.get(itemId) ?? ""}${delta}`;
      this.itemOutputs.set(itemId, nextValue);
      if (existingType === "commandExecution") {
        const commandExecution = this.commandExecutions.get(itemId);
        if (commandExecution?.toolName !== "run_shell") {
          return;
        }
        this.onChunk?.({
          type: "tool-progress",
          title: "Tool progress: run_shell",
          value: nextValue,
          metadata: {
            toolName: "run_shell",
            callId: itemId,
            command: commandExecution?.command,
            cwd: commandExecution?.cwd,
            streamId: runShellActivityStreamId(itemId),
            shellStreaming: true,
            replace: true,
          },
        });
      }
      return;
    }

    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = asRecord(params?.item) ?? params ?? {};
      const itemId = asString(item?.id);
      const itemType = asString(item?.type) ?? asString(item?.kind) ?? "item";
      if (itemId) {
        this.activeItemTypes.set(itemId, itemType);
      }

      if (itemType === "agentMessage" && itemId) {
        const phase = asString(item?.phase);
        if (phase) {
          this.itemPhases.set(itemId, phase);
        }
        if (notification.method === "item/completed" && phase === "final_answer") {
          const text = asString(item?.text)?.trim();
          if (text) {
            this.assistantText = text;
          }
        }
        return;
      }

      if (itemType === "reasoning" || itemType === "userMessage") {
        return;
      }

      if (itemType === "plan" && itemId) {
        const planText =
          asString(item?.text)?.trim() ??
          asString(item?.plan)?.trim() ??
          asString(item?.content)?.trim() ??
          "";
        if (notification.method === "item/completed" && planText) {
          this.planMessages.set(itemId, planText);
          this.onChunk?.({
            type: "plan-updated",
            title: "Proposed plan",
            value: planText,
            metadata: {
              provider: "codex-cli",
              planKind: "proposal",
              streamId: itemId,
              replace: true,
            },
          });
        }
        return;
      }

      if (itemType === "commandExecution") {
        const fullCommand = asString(item?.command) ?? asString(params?.command) ?? "Command";
        const simplifiedCommand = asString(asRecord(asArray(item?.commandActions)?.[0])?.command) ?? undefined;
        const cwd = asString(item?.cwd);
        const executionContext = inferCommandExecutionContext(this.cwd, fullCommand, simplifiedCommand);
        if (itemId) {
          this.commandExecutions.set(itemId, {
            ...executionContext,
            cwd,
          });
        }
        if (notification.method === "item/started") {
          this.onChunk?.({
            type: "tool-call",
            title: `Tool call: ${executionContext.toolName}`,
            value: executionContext.path ?? executionContext.command,
            metadata: {
              toolName: executionContext.toolName,
              callId: itemId ?? `codex-command:${executionContext.command}`,
              command: executionContext.command,
              cwd,
              ...(executionContext.path ? { path: executionContext.path } : {}),
            },
          });
          return;
        }

        const output = asString(item?.aggregatedOutput)?.trim() || "";
        const exitCode = asNumber(item?.exitCode);
        this.onChunk?.({
          type: "tool-result",
          title: `Tool result: ${executionContext.toolName}`,
          value:
            executionContext.toolName === "read_file"
              ? output || "File read completed with no output."
              : buildShellResultContent(output, exitCode),
          metadata: {
            toolName: executionContext.toolName,
            callId: itemId ?? `codex-command:${executionContext.command}`,
            ok: exitCode === 0,
            command: executionContext.command,
            cwd,
            exitCode,
            ...(executionContext.path ? { path: executionContext.path } : {}),
            ...(itemId && executionContext.toolName === "run_shell"
              ? { streamId: runShellActivityStreamId(itemId), replace: true }
              : {}),
          },
        });
        return;
      }

      if (itemType === "fileChange") {
        const filePaths = extractPathCandidates(this.cwd, item);
        if (notification.method === "item/started") {
          if (itemId) {
            const beforeByPath = new Map<string, string | null>();
            this.fileChangeSnapshots.set(itemId, { paths: filePaths, beforeByPath });
            void Promise.all(
              filePaths.map(async (filePath) => {
                beforeByPath.set(filePath, await readDiffableFile(this.cwd, filePath));
              }),
            );
          }
          if (filePaths.length > 0) {
            for (const [index, filePath] of filePaths.entries()) {
              this.onChunk?.({
                type: "tool-call",
                title: "Tool call: write_file",
                value: filePath,
                metadata: {
                  toolName: "write_file",
                  callId: `${itemId ?? "codex-file-change"}:${String(index)}`,
                  path: filePath,
                },
              });
            }
          } else {
            this.onChunk?.({
              type: "tool-call",
              title: "Tool call: write_file",
              value: "Applying file changes.",
              metadata: {
                toolName: "write_file",
                callId: itemId ?? "codex-file-change",
              },
            });
          }
          return;
        }

        void this.emitFileChangeResults({
          item,
          itemId,
          filePaths,
        });
        return;
      }

      const detail =
        asString(item?.detail) ??
        asString(item?.title) ??
        asString(item?.text) ??
        asString(params?.command) ??
        asString(params?.reason) ??
        humanizeCodexItemType(itemType);

      this.onChunk?.({
        type: notification.method === "item/started" ? "status" : "status",
        title: "Codex update",
        value: detail,
        metadata: itemId ? { itemId, itemType } : { itemType },
      });
    }
  }

  private async emitFileChangeResults(input: {
    item: Record<string, unknown>;
    itemId?: string;
    filePaths: string[];
  }): Promise<void> {
    const snapshot = input.itemId ? this.fileChangeSnapshots.get(input.itemId) : undefined;
    const paths = input.filePaths.length > 0 ? input.filePaths : snapshot?.paths ?? [];
    const output = asString(input.item.aggregatedOutput)?.trim() || asString(input.item.text) || "File changes applied.";

    if (paths.length === 0) {
      this.onChunk?.({
        type: "tool-result",
        title: "Tool result: write_file",
        value: output,
        metadata: {
          toolName: "write_file",
          callId: input.itemId ?? "codex-file-change",
          ok: true,
        },
      });
      return;
    }

    const newContents = await Promise.all(paths.map((filePath) => readDiffableFile(this.cwd, filePath)));
    const diffs = paths.map((filePath, index) => {
      const before = snapshot?.beforeByPath.get(filePath) ?? null;
      const after = newContents[index] ?? null;
      return buildWriteFileUnifiedDiff(filePath, before, after);
    });

    paths.forEach((filePath, index) => {
      const diffText = diffs[index];
      const after = newContents[index] ?? null;
      const before = snapshot?.beforeByPath.get(filePath) ?? null;
      const toolName = after === null && before !== null ? "delete_file" : "write_file";
      const content =
        toolName === "delete_file"
          ? `Deleted ${filePath}.`
          : output === "File changes applied."
            ? `Updated ${filePath}.`
            : output;

      this.onChunk?.({
        type: "diff-updated",
        title: `Diff updated: ${toolName}`,
        value: diffText || content,
        metadata: {
          toolName,
          callId: `${input.itemId ?? "codex-file-change"}:${String(index)}:diff`,
          path: filePath,
          ...(diffText ? { writeFileUnifiedDiff: diffText } : {}),
        },
      });

      this.onChunk?.({
        type: "tool-result",
        title: `Tool result: ${toolName}`,
        value: content,
        metadata: {
          toolName,
          callId: `${input.itemId ?? "codex-file-change"}:${String(index)}`,
          ok: true,
          path: filePath,
          ...(diffText && toolName === "write_file" ? { writeFileUnifiedDiff: diffText } : {}),
        },
      });
    });
  }

  private handleResponse(response: JsonRpcResponse): void {
    this.devLogger?.log("codex.rpc.response", response);
    const key = String(response.id);
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(key);
    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message}`));
      return;
    }
    pending.resolve(response.result);
  }

  private async sendRequest<T = unknown>(method: string, params: unknown, timeoutMs = INITIALIZE_TIMEOUT_MS): Promise<T> {
    const id = this.nextRequestId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });
      this.devLogger?.log("codex.rpc.outbound", { id, method, params });
      this.writeMessage({ id, method, params });
    });
    return result as T;
  }

  private writeMessage(message: unknown): void {
    if (!this.child.stdin.writable) {
      throw new Error("Cannot write to Codex app-server stdin.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private readThreadId(value: unknown): string | null {
    const record = asRecord(value);
    const thread = asRecord(record?.thread);
    return asString(thread?.id) ?? asString(record?.threadId) ?? null;
  }

  private isServerRequest(value: unknown): value is JsonRpcRequest {
    return isRecord(value) && typeof value.method === "string" && (typeof value.id === "string" || typeof value.id === "number");
  }

  private isServerNotification(value: unknown): value is JsonRpcNotification {
    return isRecord(value) && typeof value.method === "string" && !("id" in value);
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    return isRecord(value) && (typeof value.id === "string" || typeof value.id === "number") && !("method" in value);
  }
}

async function executeCodexTurn(options: TurnExecutionOptions): Promise<TurnExecutionResult> {
  const { binaryPath, homePath } = resolveCodexCliConfig(options.config);
  const devLogger = createDevLogger({
    logDirPath: options.devLogging?.logDirPath,
    runId: options.runId,
    providerType: "codex-cli",
    modelId: options.modelId || CODEX_DEFAULT_MODEL,
    sessionType: options.isChat ? "chat" : "run",
  });
  const childArgs = [
    ...(options.yoloMode ? [CODEX_YOLO_FLAG] : []),
    "-c",
    "shell_environment_policy.inherit=all",
    "app-server",
  ];
  const child = spawn(binaryPath, childArgs, {
    cwd: options.cwd,
    env: buildCodexProcessEnv(options.cwd, homePath, options.networkProxy),
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  const session = new CodexAppServerSession(
    child,
    options.previousThreadId ?? "",
    options.cwd,
    options.requestShellApproval,
    options.requestUserInput,
    options.onChunk,
    devLogger.enabled ? devLogger : undefined,
  );
  try {
    await session.initialize(options.modelId || CODEX_DEFAULT_MODEL, options.cwd, options.previousThreadId, options.yoloMode === true);
    const threadId = session.getThreadId();
    if (threadId) {
      options.onChunk?.({
        type: "status",
        title: "Codex session",
        value: options.previousThreadId ? "Codex session resumed." : "Codex session ready.",
        metadata: {
          silent: true,
          providerSessionRuntime: {
            cwd: options.cwd,
            modelId: options.modelId || CODEX_DEFAULT_MODEL,
            runtimeMode: options.inputMode,
            status: "running",
            resumeCursor: { threadId },
            runtimePayload: {
              previousResponseId: threadId,
              sessionType: options.isChat ? "chat" : "run",
            },
          },
        },
      });
    }
    return await session.startTurn({
      prompt: options.prompt,
      attachments: options.attachments,
      modelId: options.modelId || CODEX_DEFAULT_MODEL,
      mode: options.inputMode,
      repoContext: options.repoContext,
      isChat: options.isChat,
      signal: options.signal,
    });
  } finally {
    session.stop();
  }
}

export class CodexCliProviderAdapter implements ProviderAdapter {
  readonly providerType = "codex-cli" as const;

  listRecommendedModels(): string[] {
    return getCodexCliRecommendedModelIds();
  }

  validateConfiguration(input: ProviderAccountInput): void {
    const config = input.config;
    const binaryPath = asString(config?.[PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY]);
    const homePath = asString(config?.[PROVIDER_CONFIG_CODEX_HOME_PATH_KEY]);
    if (binaryPath !== undefined && !binaryPath.trim()) {
      throw new Error("Codex binary path cannot be blank when provided.");
    }
    if (homePath !== undefined && !homePath.trim()) {
      throw new Error("CODEX_HOME cannot be blank when provided.");
    }
  }
}

export function assertCodexCliAvailable(config: Record<string, unknown> | undefined): void {
  const { binaryPath, homePath } = resolveCodexCliConfig(config);
  const result = spawnSync(binaryPath, ["--version"], {
    env: {
      ...process.env,
      ...(homePath ? { CODEX_HOME: homePath } : {}),
    },
    shell: process.platform === "win32",
    timeout: 4_000,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Could not start Codex CLI (${result.error.message}).`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim() || `exit code ${String(result.status)}`;
    throw new Error(`Codex CLI is not available: ${detail}`);
  }
}

export class CodexCliHarnessAdapter implements HarnessAdapter {
  readonly harnessType = "codex-app-server" as const;

  constructor(
    private readonly requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>,
    private readonly requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>,
  ) {}

  async run(
    input: RunExecutionRequest,
    _toolContext: HarnessToolContext,
    onChunk: (chunk: HarnessRunChunk) => void,
    signal: AbortSignal,
  ): ReturnType<HarnessAdapter["run"]> {
    const result = await executeCodexTurn({
      runId: input.runId,
      cwd: input.worktreePath,
      prompt: input.prompt,
      modelId: input.modelId,
      previousThreadId: readProviderSessionCursorId(input.providerSessionRuntime) ?? input.previousResponseId,
      repoContext: input.repoContext,
      inputMode: input.mode,
      isChat: input.isChat,
      attachments: input.attachments,
      networkProxy: input.networkProxy,
      config: input.config,
      modelConfig: input.modelConfig,
      providerOptions: input.providerOptions,
      yoloMode: input.yoloMode === true,
      devLogging: input.devLogging,
      signal,
      requestShellApproval: input.yoloMode === true ? undefined : this.requestShellApproval,
      requestUserInput: this.requestUserInput,
      onChunk,
    });
    return {
      summary: result.summary,
      responseId: result.threadId,
      usage: result.usage,
      providerSessionRuntime: {
        cwd: input.worktreePath,
        modelId: input.modelId || CODEX_DEFAULT_MODEL,
        runtimeMode: input.mode,
        status: "ready",
        resumeCursor: {
          threadId: result.threadId,
        },
        runtimePayload: {
          previousResponseId: result.threadId,
          sessionType: input.isChat ? "chat" : "run",
        },
      },
    };
  }
}

export async function suggestCommitMessageWithCodexCli(input: {
  cwd: string;
  diffPrompt: string;
  modelId: string;
  networkProxy?: NetworkProxyRuntimeConfig;
  config?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  providerOptions?: {
    reasoningEffort?: string;
  };
  signal?: AbortSignal;
}): Promise<string> {
  const result = await executeCodexTurn({
    runId: "commit-message",
    cwd: input.cwd,
    prompt: input.diffPrompt,
    modelId: input.modelId,
    inputMode: "ask",
    isChat: true,
    networkProxy: input.networkProxy,
    config: input.config,
    modelConfig: input.modelConfig,
    providerOptions: input.providerOptions,
    signal: input.signal ?? new AbortController().signal,
  });
  return result.summary.trim();
}

type GenerateAskTextWithCodexCliInput = {
  cwd: string;
  prompt: string;
  modelId: string;
  networkProxy?: NetworkProxyRuntimeConfig;
  config?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  providerOptions?: {
    reasoningEffort?: string;
  };
  signal?: AbortSignal;
  devLogging?: {
    logDirPath: string;
    runId?: string;
    sessionType?: "run" | "chat";
  };
};

export async function generateAskTextResultWithCodexCli(input: GenerateAskTextWithCodexCliInput): Promise<{
  text: string;
  usage: RunTokenUsage;
}> {
  const result = await executeCodexTurn({
    runId: input.devLogging?.runId ?? "ask-text",
    cwd: input.cwd,
    prompt: input.prompt,
    modelId: input.modelId,
    inputMode: "ask",
    isChat: true,
    networkProxy: input.networkProxy,
    config: input.config,
    modelConfig: input.modelConfig,
    providerOptions: input.providerOptions,
    devLogging: input.devLogging
      ? {
          logDirPath: input.devLogging.logDirPath,
        }
      : undefined,
    signal: input.signal ?? new AbortController().signal,
  });
  return {
    text: result.summary.trim(),
    usage: result.usage,
  };
}

export async function generateAskTextWithCodexCli(input: GenerateAskTextWithCodexCliInput): Promise<string> {
  return (await generateAskTextResultWithCodexCli(input)).text;
}
