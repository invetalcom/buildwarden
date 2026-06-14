import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  query,
  type CanUseTool,
  type Options as ClaudeAgentOptions,
  type PermissionResult,
  type PermissionUpdate,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatAttachmentPayload,
  HarnessAdapter,
  HarnessRunChunk,
  HarnessToolContext,
  NetworkProxyRuntimeConfig,
  ProviderAccountInput,
  ProviderAdapter,
  RunExecutionRequest,
  RunUserInputAnswers,
  RunUserInputQuestion,
  RunUserInputRequest,
  ShellApprovalDecision,
  RunPlanProgressPayload,
  RunTokenUsage,
} from "@buildwarden/shared";
import {
  PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY,
  buildNetworkProxyUrl,
  formatRunPlanProgressContent,
  normalizeRunPlanStepStatus,
} from "@buildwarden/shared";

const CLAUDE_DEFAULT_MODEL = "sonnet";
const TURN_TIMEOUT_MS = 20 * 60 * 1_000;

type ClaudeCodeResolvedConfig = {
  binaryPath: string;
  launchArgs: string[];
};

type ClaudeSdkExtraArgs = NonNullable<ClaudeAgentOptions["extraArgs"]>;

type ClaudeTurnExecutionOptions = {
  runId: string;
  cwd: string;
  prompt: string;
  modelId: string;
  previousSessionId?: string | null;
  repoContext?: string;
  inputMode: RunExecutionRequest["mode"];
  isChat?: boolean;
  attachments?: ChatAttachmentPayload[];
  networkProxy?: NetworkProxyRuntimeConfig;
  config?: Record<string, unknown>;
  providerOptions?: {
    anthropicEffort?: string;
  };
  yoloMode?: boolean;
  signal: AbortSignal;
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>;
  requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>;
  onChunk?: (chunk: HarnessRunChunk) => void;
};

type ClaudeTurnExecutionResult = {
  summary: string;
  sessionId: string | null;
  usage: RunTokenUsage;
};

export type ClaudeCodeSlashCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
};

export type ClaudeCodeProcessLaunch = {
  command: string;
  args: string[];
};

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined);

const asFiniteNumber = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

const asOptionalFiniteNumber = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const readClaudeResumeSessionId = (value: RunExecutionRequest["providerSessionRuntime"] | undefined | null): string | null => {
  const cursor = value?.resumeCursor;
  if (!isRecord(cursor)) {
    return null;
  }
  const resume = asString(cursor.resume) ?? asString(cursor.sessionId);
  return resume?.trim() || null;
};

export const buildClaudeCodeArgs = (input: {
  modelId: string;
  inputMode: RunExecutionRequest["mode"];
  providerOptions?: {
    anthropicEffort?: string;
  };
  previousSessionId?: string | null;
  launchArgs?: string[];
  yoloMode?: boolean;
}): string[] => {
  const permissionMode = input.yoloMode === true ? "bypassPermissions" : input.inputMode === "code" ? "acceptEdits" : "plan";
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    normalizeClaudeCodeModelId(input.modelId || CLAUDE_DEFAULT_MODEL),
    "--effort",
    resolveClaudeCodeEffort(input.providerOptions),
    "--permission-mode",
    permissionMode,
    ...(input.yoloMode === true ? ["--dangerously-skip-permissions"] : []),
    ...(input.previousSessionId ? ["--resume", input.previousSessionId] : []),
    ...(input.launchArgs ?? []),
  ];
};

const getDefaultClaudeBinaryPath = (): string => {
  if (process.platform === "win32") {
    const nativeInstallerPath = join(homedir(), ".local", "bin", "claude.exe");
    if (existsSync(nativeInstallerPath)) {
      return nativeInstallerPath;
    }
  }
  return "claude";
};

const resolveClaudeCodeConfig = (config: Record<string, unknown> | undefined): ClaudeCodeResolvedConfig => {
  const binaryPath = asString(config?.[PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY])?.trim() || getDefaultClaudeBinaryPath();
  const rawLaunchArgs = asString(config?.[PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY])?.trim() || "";
  return {
    binaryPath,
    launchArgs: splitLaunchArgs(rawLaunchArgs),
  };
};

const splitLaunchArgs = (value: string): string[] => {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    args.push(current);
  }
  return args;
};

const quoteWindowsShellArg = (value: string): string => `"${value.replace(/"/g, '""')}"`;

export const normalizeClaudeCodeModelId = (modelId: string): string => {
  const trimmed = modelId.trim();
  const legacyModelMap: Record<string, string> = {
    "claude-sonnet-4.5": "claude-sonnet-4-6",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-sonnet-4-5": "claude-sonnet-4-6",
    "claude-opus-4-1": "claude-opus-4-7",
  };
  return legacyModelMap[trimmed] ?? trimmed;
};

const resolveClaudeCodeEffort = (providerOptions: { anthropicEffort?: string } | undefined): string => {
  const effort = providerOptions?.anthropicEffort?.trim();
  const supportedEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);
  return effort && supportedEfforts.has(effort) ? effort : "medium";
};

export const resolveClaudeCodeProcessLaunch = (binaryPath: string, args: string[]): ClaudeCodeProcessLaunch => {
  if (process.platform !== "win32") {
    return { command: binaryPath, args };
  }

  const hasPathSeparator = /[\\/]/.test(binaryPath);
  const isCommandShim = /\.(?:cmd|bat)$/i.test(binaryPath);
  if (!hasPathSeparator || isCommandShim) {
    const command = hasPathSeparator ? quoteWindowsShellArg(binaryPath) : binaryPath;
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", [command, ...args.map(quoteWindowsShellArg)].join(" ")],
    };
  }

  return { command: binaryPath, args };
};

const buildClaudeProcessEnv = (networkProxy?: NetworkProxyRuntimeConfig): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };

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

  return env;
};

const launchArgsToSdkOptions = (launchArgs: string[]): Pick<ClaudeAgentOptions, "additionalDirectories" | "extraArgs"> => {
  const extraArgs: ClaudeSdkExtraArgs = {};
  const additionalDirectories: string[] = [];

  for (let index = 0; index < launchArgs.length; index += 1) {
    const current = launchArgs[index];
    if (!current?.startsWith("--")) {
      continue;
    }

    const equalsIndex = current.indexOf("=");
    const rawName = equalsIndex >= 0 ? current.slice(2, equalsIndex) : current.slice(2);
    if (!rawName) {
      continue;
    }

    const value =
      equalsIndex >= 0
        ? current.slice(equalsIndex + 1)
        : launchArgs[index + 1] && !launchArgs[index + 1]!.startsWith("--")
          ? launchArgs[++index]!
          : null;
    extraArgs[rawName] = value;

    if ((rawName === "add-dir" || rawName === "addDir") && value) {
      additionalDirectories.push(value);
    }
  }

  return {
    ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
    ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
  };
};

const waitForAbortSignal = (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
};

const normalizeClaudeSlashCommands = (commands: readonly SlashCommand[] | undefined): ClaudeCodeSlashCommand[] => {
  const byName = new Map<string, ClaudeCodeSlashCommand>();

  for (const command of commands ?? []) {
    const name = command.name.trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    const existing = byName.get(key);
    const description = command.description.trim();
    const argumentHint = command.argumentHint.trim();
    const next: ClaudeCodeSlashCommand = {
      name,
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      ...(command.aliases?.length ? { aliases: command.aliases } : {}),
    };
    byName.set(key, {
      ...next,
      ...(existing?.description && !next.description ? { description: existing.description } : {}),
      ...(existing?.argumentHint && !next.argumentHint ? { argumentHint: existing.argumentHint } : {}),
      ...(existing?.aliases?.length && !next.aliases?.length ? { aliases: existing.aliases } : {}),
    });
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
};

export async function listClaudeCodeSlashCommands(input: {
  cwd?: string;
  config?: Record<string, unknown>;
  networkProxy?: NetworkProxyRuntimeConfig;
  timeoutMs?: number;
}): Promise<ClaudeCodeSlashCommand[]> {
  const { binaryPath, launchArgs } = resolveClaudeCodeConfig(input.config);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), Math.max(1_000, input.timeoutMs ?? 6_000));
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await waitForAbortSignal(abortController.signal);
  })();
  const claudeQuery = query({
    prompt,
    options: {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      persistSession: false,
      pathToClaudeCodeExecutable: binaryPath,
      abortController,
      settingSources: ["user", "project", "local"],
      allowedTools: [],
      env: buildClaudeProcessEnv(input.networkProxy),
      stderr: () => {},
      ...launchArgsToSdkOptions(launchArgs),
    },
  });

  try {
    const init = await claudeQuery.initializationResult();
    return normalizeClaudeSlashCommands(init.commands);
  } finally {
    clearTimeout(timeout);
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    claudeQuery.close();
  }
}

const modeInstruction = (mode: RunExecutionRequest["mode"]): string => {
  if (mode === "code") {
    return "You are in code mode. Implement the requested changes directly when appropriate, then verify your work when useful.";
  }
  if (mode === "plan") {
    return "You are in plan mode. Do not modify files. Inspect the repository and produce a concrete implementation plan.";
  }
  return "You are in ask mode. Do not modify files. Inspect only what you need and answer directly.";
};

const buildPrompt = (options: ClaudeTurnExecutionOptions): string => {
  const parts = [
    "You are BuildWarden, a desktop coding agent running inside a local repository.",
    "The workspace root is already the current working directory.",
    "Use repository context when provided, inspect files before making assumptions, and keep the final answer concise.",
    modeInstruction(options.inputMode),
  ];

  if (options.repoContext?.trim()) {
    parts.push(`<repository_context>\n${options.repoContext.trim()}\n</repository_context>`);
  }

  if (options.attachments?.length) {
    parts.push(buildAttachmentPrompt(options.attachments));
  }

  parts.push(`<task>\n${options.prompt.trim() || "(no task provided)"}\n</task>`);
  return parts.join("\n\n");
};

const buildAttachmentPrompt = (attachments: ChatAttachmentPayload[]): string => {
  const lines: string[] = ["<attachments>"];
  for (const attachment of attachments) {
    const name = attachment.fileName.trim() || "attachment";
    const mime = attachment.mimeType || "application/octet-stream";
    if (mime.startsWith("text/") || mime === "application/json") {
      const text = Buffer.from(attachment.dataBase64, "base64").toString("utf8").slice(0, 80_000);
      lines.push(`--- ${name} (${mime}) ---\n${text}`);
    } else {
      lines.push(`[Attached file: ${name}, mime ${mime}. Binary/image attachments are not expanded for Claude Code CLI.]`);
    }
  }
  lines.push("</attachments>");
  return lines.join("\n\n");
};

type ClaudeUsageReadOptions = {
  includeContext?: boolean;
  contextWindow?: number;
};

const readClaudeContextWindow = (value: unknown): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  let maxContextWindow: number | undefined;
  for (const entry of Object.values(value)) {
    if (!isRecord(entry)) {
      continue;
    }
    const contextWindow = asOptionalFiniteNumber(entry.contextWindow ?? entry.context_window);
    if (contextWindow !== undefined && contextWindow > 0) {
      maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
    }
  }
  return maxContextWindow;
};

const processedTotal = (usage: RunTokenUsage): number =>
  usage.totalTokens ?? usage.totalProcessedTokens ?? usage.inputTokens + usage.outputTokens;

const readUsage = (value: unknown, options: ClaudeUsageReadOptions = {}): RunTokenUsage => {
  if (!isRecord(value)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const baseInputTokens = asFiniteNumber(value.input_tokens ?? value.inputTokens);
  const outputTokens = asFiniteNumber(value.output_tokens ?? value.outputTokens);
  const reasoningTokens = asFiniteNumber(
    value.reasoning_tokens ?? value.reasoningTokens ?? value.thinking_tokens ?? value.thinkingTokens,
  );
  const cacheReadInputTokens = asFiniteNumber(value.cache_read_input_tokens ?? value.cacheReadInputTokens ?? value.cachedInputTokens);
  const cacheCreationInputTokens = asFiniteNumber(value.cache_creation_input_tokens ?? value.cacheCreationInputTokens);
  const inputTokens = baseInputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  const totalTokens = asOptionalFiniteNumber(value.total_tokens ?? value.totalTokens) ?? inputTokens + outputTokens;
  const usage: RunTokenUsage = {
    inputTokens,
    outputTokens,
  };
  if (cacheReadInputTokens > 0) {
    usage.cachedInputTokens = cacheReadInputTokens;
  }
  if (cacheCreationInputTokens > 0) {
    usage.cacheCreationInputTokens = cacheCreationInputTokens;
  }
  if (reasoningTokens > 0) {
    usage.reasoningTokens = reasoningTokens;
  }
  if (totalTokens > 0) {
    usage.totalTokens = totalTokens;
  }
  if (options.includeContext && totalTokens > 0) {
    const maxTokens =
      typeof options.contextWindow === "number" && Number.isFinite(options.contextWindow) && options.contextWindow > 0
        ? options.contextWindow
        : undefined;
    const usedTokens = maxTokens !== undefined ? Math.min(totalTokens, maxTokens) : totalTokens;
    usage.usedTokens = usedTokens;
    usage.lastUsedTokens = usedTokens;
    usage.totalProcessedTokens = totalTokens;
    usage.lastInputTokens = inputTokens;
    usage.lastOutputTokens = outputTokens;
    if (cacheReadInputTokens > 0) {
      usage.lastCachedInputTokens = cacheReadInputTokens;
    }
    if (reasoningTokens > 0) {
      usage.lastReasoningTokens = reasoningTokens;
    }
    if (maxTokens !== undefined) {
      usage.maxTokens = maxTokens;
    }
  }
  return usage;
};

const addUsage = (left: RunTokenUsage, right: RunTokenUsage): RunTokenUsage => {
  const reasoningTokens = (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0);
  const cachedInputTokens = (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0);
  const cacheCreationInputTokens = (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0);
  const totalTokens = processedTotal(left) + processedTotal(right);
  const hasRightContext = right.usedTokens !== undefined || right.lastUsedTokens !== undefined;
  const contextSource = hasRightContext ? right : left;
  const usage: RunTokenUsage = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    ...(totalTokens > 0 ? { totalTokens } : {}),
    ...(totalTokens > 0 ? { totalProcessedTokens: totalTokens } : {}),
  };
  if (contextSource.usedTokens !== undefined) {
    usage.usedTokens = contextSource.usedTokens;
  }
  if (contextSource.maxTokens !== undefined) {
    usage.maxTokens = contextSource.maxTokens;
  }
  if (contextSource.lastUsedTokens !== undefined) {
    usage.lastUsedTokens = contextSource.lastUsedTokens;
  }
  if (contextSource.lastInputTokens !== undefined) {
    usage.lastInputTokens = contextSource.lastInputTokens;
  }
  if (contextSource.lastCachedInputTokens !== undefined) {
    usage.lastCachedInputTokens = contextSource.lastCachedInputTokens;
  }
  if (contextSource.lastOutputTokens !== undefined) {
    usage.lastOutputTokens = contextSource.lastOutputTokens;
  }
  if (contextSource.lastReasoningTokens !== undefined) {
    usage.lastReasoningTokens = contextSource.lastReasoningTokens;
  }
  return usage;
};

const readModelUsage = (value: unknown, options: ClaudeUsageReadOptions = {}): RunTokenUsage | null => {
  if (!isRecord(value)) {
    return null;
  }
  let usage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const entry of Object.values(value)) {
    if (isRecord(entry)) {
      usage = addUsage(usage, readUsage(entry));
    }
  }
  if (options.includeContext && processedTotal(usage) > 0) {
    const maxTokens =
      typeof options.contextWindow === "number" && Number.isFinite(options.contextWindow) && options.contextWindow > 0
        ? options.contextWindow
        : undefined;
    const usedTokens = maxTokens !== undefined ? Math.min(processedTotal(usage), maxTokens) : processedTotal(usage);
    usage.usedTokens = usedTokens;
    usage.lastUsedTokens = usedTokens;
    usage.totalProcessedTokens = processedTotal(usage);
    usage.lastInputTokens = usage.inputTokens;
    usage.lastOutputTokens = usage.outputTokens;
    if (usage.cachedInputTokens !== undefined) {
      usage.lastCachedInputTokens = usage.cachedInputTokens;
    }
    if (usage.reasoningTokens !== undefined) {
      usage.lastReasoningTokens = usage.reasoningTokens;
    }
    if (maxTokens !== undefined) {
      usage.maxTokens = maxTokens;
    }
  }
  return usage.inputTokens > 0 || usage.outputTokens > 0 ? usage : null;
};

const hasUsageTokens = (usage: RunTokenUsage | null | undefined): usage is RunTokenUsage =>
  Boolean(usage && (usage.inputTokens > 0 || usage.outputTokens > 0 || (usage.usedTokens ?? 0) > 0 || (usage.totalTokens ?? 0) > 0));

const readClaudeUsageKey = (event: Record<string, unknown>, message: Record<string, unknown>): string | undefined => {
  const messageId = asString(message.id);
  if (messageId) {
    return `message:${messageId}`;
  }

  const requestId =
    asString(event.requestId) ??
    asString(event.request_id) ??
    asString(message.requestId) ??
    asString(message.request_id);
  if (requestId) {
    return `request:${requestId}`;
  }

  return undefined;
};

export const mergeClaudeUsageUpdate = (
  current: RunTokenUsage,
  previousDeltaUsageByKey: Map<string, RunTokenUsage>,
  update: { usage?: RunTokenUsage; usageIsDelta?: boolean; usageIsContextSnapshot?: boolean; usageKey?: string },
): { usage: RunTokenUsage; changed: boolean } => {
  if (!update.usage) {
    return { usage: current, changed: false };
  }

  if (update.usageIsContextSnapshot) {
    return {
      usage: {
        ...current,
        usedTokens: update.usage.usedTokens,
        totalProcessedTokens: Math.max(current.totalProcessedTokens ?? processedTotal(current), update.usage.totalProcessedTokens ?? processedTotal(update.usage)),
        maxTokens: update.usage.maxTokens ?? current.maxTokens,
        lastUsedTokens: update.usage.lastUsedTokens ?? update.usage.usedTokens ?? current.lastUsedTokens,
        lastInputTokens: update.usage.lastInputTokens ?? current.lastInputTokens,
        lastCachedInputTokens: update.usage.lastCachedInputTokens ?? current.lastCachedInputTokens,
        lastOutputTokens: update.usage.lastOutputTokens ?? current.lastOutputTokens,
        lastReasoningTokens: update.usage.lastReasoningTokens ?? current.lastReasoningTokens,
      },
      changed: true,
    };
  }

  if (!update.usageIsDelta) {
    const currentHasContext = current.usedTokens !== undefined || current.lastUsedTokens !== undefined;
    if (!currentHasContext) {
      return { usage: update.usage, changed: true };
    }
    return {
      usage: {
        ...update.usage,
        usedTokens: current.usedTokens,
        maxTokens: update.usage.maxTokens ?? current.maxTokens,
        lastUsedTokens: current.lastUsedTokens ?? current.usedTokens,
        lastInputTokens: current.lastInputTokens,
        lastCachedInputTokens: current.lastCachedInputTokens,
        lastOutputTokens: current.lastOutputTokens,
        lastReasoningTokens: current.lastReasoningTokens,
        totalProcessedTokens: Math.max(update.usage.totalProcessedTokens ?? processedTotal(update.usage), current.totalProcessedTokens ?? 0),
      },
      changed: true,
    };
  }

  if (update.usageKey) {
    const previous = previousDeltaUsageByKey.get(update.usageKey);
    previousDeltaUsageByKey.set(update.usageKey, update.usage);
    if (previous) {
      const delta: RunTokenUsage = {
        inputTokens: Math.max(0, update.usage.inputTokens - previous.inputTokens),
        outputTokens: Math.max(0, update.usage.outputTokens - previous.outputTokens),
      };
      const reasoningTokens = Math.max(0, (update.usage.reasoningTokens ?? 0) - (previous.reasoningTokens ?? 0));
      const cachedInputTokens = Math.max(0, (update.usage.cachedInputTokens ?? 0) - (previous.cachedInputTokens ?? 0));
      const cacheCreationInputTokens = Math.max(
        0,
        (update.usage.cacheCreationInputTokens ?? 0) - (previous.cacheCreationInputTokens ?? 0),
      );
      const totalTokens = Math.max(
        0,
        (update.usage.totalTokens ?? update.usage.inputTokens + update.usage.outputTokens) -
          (previous.totalTokens ?? previous.inputTokens + previous.outputTokens),
      );
      if (reasoningTokens > 0) {
        delta.reasoningTokens = reasoningTokens;
      }
      if (cachedInputTokens > 0) {
        delta.cachedInputTokens = cachedInputTokens;
      }
      if (cacheCreationInputTokens > 0) {
        delta.cacheCreationInputTokens = cacheCreationInputTokens;
      }
      if (totalTokens > 0) {
        delta.totalTokens = totalTokens;
      }
      if (delta.inputTokens <= 0 && delta.outputTokens <= 0 && totalTokens <= 0) {
        return { usage: current, changed: false };
      }
      return { usage: addUsage(current, delta), changed: true };
    }
  }

  return { usage: addUsage(current, update.usage), changed: true };
};

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

const normalizeClaudeCodeToolName = (name: string): string => {
  const normalized = name.trim().toLowerCase();
  if (normalized === "read") return "read_file";
  if (normalized === "write") return "write_file";
  if (normalized === "edit" || normalized === "multiedit") return "edit_file";
  if (normalized === "bash") return "run_shell";
  if (normalized === "glob" || normalized === "ls") return "list_files";
  if (normalized === "grep") return "search_repo";
  return normalized || "tool";
};

const isClaudeReadOnlyTool = (toolName: string): boolean =>
  new Set(["read_file", "list_files", "search_repo", "glob", "ls", "grep"]).has(normalizeClaudeCodeToolName(toolName));

const isClaudeFileChangeTool = (toolName: string): boolean =>
  new Set(["write_file", "edit_file", "write", "edit", "multiedit", "notebookedit"]).has(
    normalizeClaudeCodeToolName(toolName),
  );

const isClaudeTodoWriteTool = (toolName: string): boolean => normalizeClaudeCodeToolName(toolName) === "todowrite";

const extractClaudeTodoPlanProgress = (input: unknown): RunPlanProgressPayload | null => {
  const record = isRecord(input) ? input : {};
  const todos = asArray(record.todos);
  if (!todos?.length) {
    return null;
  }
  const steps = todos
    .filter((todo): todo is Record<string, unknown> => isRecord(todo))
    .map((todo, index) => {
      const content = asString(todo.content)?.trim() ?? asString(todo.title)?.trim() ?? asString(todo.activeForm)?.trim() ?? "";
      return {
        title: content || `Step ${String(index + 1)}`,
        status: normalizeRunPlanStepStatus(todo.status),
      };
    });
  return steps.length > 0 ? { steps, source: "claude" } : null;
};

const buildPlanProgressChunk = (
  progress: RunPlanProgressPayload,
  metadata: Record<string, unknown>,
): HarnessRunChunk => ({
  type: "plan-progress",
  title: "Plan progress",
  value: formatRunPlanProgressContent(progress),
  metadata: {
    provider: "claude-code",
    planProgress: progress,
    streamId: "claude-plan-progress",
    replace: true,
    ...metadata,
  },
});

const claudePermissionDenied = (message: string): PermissionResult => ({
  behavior: "deny",
  message,
});

const claudePermissionAllowed = (input: Record<string, unknown>, updatedPermissions?: PermissionUpdate[]): PermissionResult => ({
  behavior: "allow",
  updatedInput: input,
  ...(updatedPermissions?.length ? { updatedPermissions } : {}),
});

const shouldApplyClaudeSessionPermissions = (decision: ShellApprovalDecision): boolean =>
  decision === "allow-for-run" || decision === "allow-always";

const readClaudeToolString = (input: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const describeClaudeToolInput = (toolName: string, input: unknown): { value: string; metadata: Record<string, unknown> } => {
  const record = isRecord(input) ? input : {};
  const path = readClaudeToolString(record, ["file_path", "path", "notebook_path"]);
  const command = readClaudeToolString(record, ["command"]);
  const query = readClaudeToolString(record, ["pattern", "query"]);
  const metadata: Record<string, unknown> = {};
  if (path) metadata.path = path;
  if (command) metadata.command = command;
  if (query) metadata.query = query;

  if (toolName === "run_shell" && command) {
    return { value: command, metadata };
  }
  if (path) {
    return { value: path, metadata };
  }
  if (query) {
    return { value: query, metadata };
  }
  return { value: stringifyValue(input), metadata };
};

const readClaudeUserQuestion = (input: Record<string, unknown>): string =>
  (readClaudeToolString(input, ["question", "prompt", "message", "text"]) ?? stringifyValue(input)) || "Claude requested user input.";

const readClaudePlanProposal = (input: Record<string, unknown>): string =>
  (readClaudeToolString(input, ["plan", "content", "text", "message"]) ?? stringifyValue(input)) || "Claude proposed a plan.";

const normalizeClaudeQuestionOption = (value: unknown): { label: string; description?: string } | null => {
  if (typeof value === "string") {
    const label = value.trim();
    return label ? { label } : null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const label = asString(value.label)?.trim() ?? asString(value.value)?.trim() ?? "";
  if (!label) {
    return null;
  }
  const description = asString(value.description)?.trim();
  return {
    label,
    ...(description ? { description } : {}),
  };
};

const normalizeClaudeUserInputQuestions = (input: Record<string, unknown>): RunUserInputQuestion[] => {
  const rawQuestions = asArray(input.questions);
  const candidates = rawQuestions && rawQuestions.length > 0 ? rawQuestions : [input];

  return candidates
    .map((candidate, index): RunUserInputQuestion | null => {
      const questionRecord = isRecord(candidate) ? candidate : {};
      const question =
        asString(questionRecord.question)?.trim() ??
        asString(questionRecord.prompt)?.trim() ??
        asString(questionRecord.message)?.trim() ??
        (typeof candidate === "string" ? candidate.trim() : "") ??
        "";
      if (!question) {
        return null;
      }
      const header = asString(questionRecord.header)?.trim() || `Question ${String(index + 1)}`;
      const options = (asArray(questionRecord.options) ?? [])
        .map(normalizeClaudeQuestionOption)
        .filter((option): option is { label: string; description?: string } => option !== null);
      return {
        // Claude Code currently looks answers up by full question text in some versions.
        id: question,
        header,
        question,
        options,
        multiSelect: questionRecord.multiSelect === true,
        allowCustomAnswer: options.length === 0 || questionRecord.allowCustomAnswer === true,
      };
    })
    .filter((question): question is RunUserInputQuestion => question !== null);
};

export const buildClaudeCanUseTool = (options: ClaudeTurnExecutionOptions): CanUseTool => async (toolName, input, callbackOptions) => {
  if (callbackOptions.signal.aborted || options.signal.aborted) {
    return claudePermissionDenied("Run cancelled.");
  }

  const normalizedToolName = normalizeClaudeCodeToolName(toolName);
  if (normalizedToolName === "askuserquestion") {
    const question = readClaudeUserQuestion(input);
    if (options.requestUserInput) {
      const questions = normalizeClaudeUserInputQuestions(input);
      if (questions.length > 0) {
        try {
          const answers = await options.requestUserInput({
            requestId: callbackOptions.toolUseID,
            title: "Claude question",
            content: question,
            questions,
            metadata: {
              provider: "claude-code",
              toolName: "AskUserQuestion",
              callId: callbackOptions.toolUseID,
              rawToolInput: input,
            },
          });
          return {
            behavior: "allow",
            updatedInput: {
              ...input,
              answers,
            },
          } as PermissionResult;
        } catch (error) {
          return claudePermissionDenied(error instanceof Error ? error.message : "User input was cancelled.");
        }
      }
    }
    options.onChunk?.({
      type: "user-input-requested",
      title: "Claude question",
      value: question,
      metadata: {
        provider: "claude-code",
        requestKind: "user-input",
        requestStatus: "opened",
        toolName: "AskUserQuestion",
        callId: callbackOptions.toolUseID,
        rawToolInput: input,
      },
    });
    return claudePermissionDenied("BuildWarden recorded this question in the run timeline. Wait for the user to answer in a follow-up.");
  }

  if (normalizedToolName === "exitplanmode") {
    const plan = readClaudePlanProposal(input);
    options.onChunk?.({
      type: "plan-updated",
      title: "Proposed plan",
      value: plan,
      metadata: {
        provider: "claude-code",
        planKind: "proposal",
        toolName: "ExitPlanMode",
        callId: callbackOptions.toolUseID,
        rawToolInput: input,
      },
    });
    return {
      behavior: "deny",
      message: "BuildWarden captured the proposed plan for user review. Stop here and wait for a follow-up.",
      interrupt: true,
    };
  }

  if (normalizedToolName === "todowrite") {
    const progress = extractClaudeTodoPlanProgress(input);
    if (progress) {
      options.onChunk?.(
        buildPlanProgressChunk(progress, {
          toolName: "TodoWrite",
          callId: callbackOptions.toolUseID,
          rawToolInput: input,
        }),
      );
    }
    return claudePermissionAllowed(input);
  }

  if (options.yoloMode === true) {
    return claudePermissionAllowed(input);
  }

  if (isClaudeReadOnlyTool(normalizedToolName)) {
    return claudePermissionAllowed(input);
  }

  if (normalizedToolName === "run_shell") {
    const command = readClaudeToolString(input, ["command"]);
    if (!command) {
      return claudePermissionDenied("BuildWarden could not determine the shell command to approve.");
    }
    const decision = options.requestShellApproval ? await options.requestShellApproval(command) : "allow-once";
    return decision === "deny"
      ? claudePermissionDenied("User denied shell command execution.")
      : claudePermissionAllowed(input, shouldApplyClaudeSessionPermissions(decision) ? callbackOptions.suggestions : undefined);
  }

  if (isClaudeFileChangeTool(normalizedToolName)) {
    return options.inputMode === "code"
      ? claudePermissionAllowed(input, callbackOptions.suggestions)
      : claudePermissionDenied("BuildWarden only allows file edits in code mode.");
  }

  return options.inputMode === "code"
    ? claudePermissionAllowed(input, callbackOptions.suggestions)
    : claudePermissionDenied("BuildWarden only allows this tool in code mode.");
};

const extractTextFromMessage = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return "";
  }
  const text = value.text ?? value.content ?? value.delta;
  if (typeof text === "string") {
    return text;
  }
  if (Array.isArray(value.content)) {
    return value.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (isRecord(part) && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
};

const extractStreamEventDelta = (event: Record<string, unknown>): { text: string; isReasoning: boolean } | null => {
  const raw = isRecord(event.event) ? event.event : undefined;
  if (!raw) {
    return null;
  }
  const delta = isRecord(raw.delta) ? raw.delta : undefined;
  const text = asString(delta?.text) ?? asString(delta?.partial_json) ?? asString(raw.text);
  if (!text) {
    return null;
  }
  const deltaType = asString(delta?.type) ?? "";
  return {
    text,
    isReasoning: deltaType.includes("thinking") || deltaType.includes("reasoning"),
  };
};

export const parseClaudeCodeStreamEvent = (
  event: unknown,
): {
  assistantText: string;
  chunks: HarnessRunChunk[];
  usage?: RunTokenUsage;
  usageIsDelta?: boolean;
  usageIsContextSnapshot?: boolean;
  usageKey?: string;
  sessionId?: string;
} => {
  if (!isRecord(event)) {
    return { assistantText: "", chunks: [] };
  }

  const chunks: HarnessRunChunk[] = [];
  const type = String(event.type ?? "");
  const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;

  if (type === "stream_event") {
    const delta = extractStreamEventDelta(event);
    if (!delta) {
      return { assistantText: "", chunks: [], sessionId };
    }
    return {
      assistantText: delta.isReasoning ? "" : delta.text,
      chunks: [
        {
          type: "message",
          title: delta.isReasoning ? "Reasoning" : "Agent output",
          value: delta.text,
          metadata: {
            assistantKind: delta.isReasoning ? "reasoning" : "assistant",
            streamId: delta.isReasoning ? "claude-reasoning" : "claude-assistant",
          },
        },
      ],
      sessionId,
    };
  }

  if (type === "system") {
    const subtype = typeof event.subtype === "string" ? event.subtype : "system";
    return {
      assistantText: "",
      chunks: [{ type: "status", title: "Claude Code", value: subtype, metadata: { silent: true } }],
      sessionId,
    };
  }

  if (type === "result") {
    const resultText = extractTextFromMessage(event.result);
    const errors = Array.isArray(event.errors) ? event.errors.map(stringifyValue).filter(Boolean).join("\n") : "";
    const contextWindow = readClaudeContextWindow(event.modelUsage);
    const usage = readModelUsage(event.modelUsage, { includeContext: true, contextWindow }) ?? readUsage(event.usage, { includeContext: true, contextWindow });
    return {
      assistantText: resultText,
      chunks: resultText
        ? [{ type: "message", title: "Agent output", value: resultText, metadata: { assistantKind: "final-summary" } }]
        : errors
          ? [{ type: "error", title: "Claude Code", value: errors, metadata: { provider: "claude-code" } }]
        : [],
      usage,
      sessionId,
    };
  }

  if (type === "task_progress" || type === "task_notification") {
    const contextWindow = readClaudeContextWindow(event.modelUsage);
    const usage = readUsage(event.usage, { includeContext: true, contextWindow });
    return {
      assistantText: "",
      chunks: [],
      usage: hasUsageTokens(usage) ? usage : undefined,
      usageIsContextSnapshot: true,
      sessionId,
    };
  }

  const message = event.message ?? event;
  if (!isRecord(message)) {
    return { assistantText: "", chunks: [], sessionId };
  }
  const rawMessageUsage = readUsage(message.usage);
  const messageUsage = hasUsageTokens(rawMessageUsage) ? rawMessageUsage : undefined;
  const messageUsageKey = messageUsage ? readClaudeUsageKey(event, message) : undefined;

  const content = Array.isArray(message.content) ? message.content : [message];
  const assistantParts: string[] = [];

  for (const part of content) {
    if (typeof part === "string") {
      assistantParts.push(part);
      continue;
    }
    if (!isRecord(part)) {
      continue;
    }

    const partType = String(part.type ?? "");
    if (partType === "text" || typeof part.text === "string") {
      const text = typeof part.text === "string" ? part.text : extractTextFromMessage(part);
      if (text) {
        assistantParts.push(text);
      }
      continue;
    }

    if (partType === "thinking" || partType === "reasoning" || partType === "redacted_thinking") {
      const thinking = stringifyValue(part.thinking ?? part.text ?? part.content ?? part.summary);
      if (thinking) {
        chunks.push({
          type: "message",
          title: "Reasoning",
          value: thinking,
          metadata: { assistantKind: "reasoning" },
        });
      }
      continue;
    }

    if (partType === "tool_use") {
      const rawName = typeof part.name === "string" ? part.name : "tool";
      const name = normalizeClaudeCodeToolName(rawName);
      if (isClaudeTodoWriteTool(name)) {
        const progress = extractClaudeTodoPlanProgress(part.input);
        if (progress) {
          chunks.push(
            buildPlanProgressChunk(progress, {
              toolName: "TodoWrite",
              rawToolName: rawName,
              callId: typeof part.id === "string" ? part.id : undefined,
              rawToolInput: part.input,
            }),
          );
        }
        continue;
      }
      const toolInput = describeClaudeToolInput(name, part.input);
      chunks.push({
        type: "tool-call",
        title: `Tool call: ${name}`,
        value: toolInput.value || name,
        metadata: {
          toolName: name,
          callId: typeof part.id === "string" ? part.id : undefined,
          rawToolName: rawName,
          provider: "claude-code",
          ...toolInput.metadata,
        },
      });
      continue;
    }

    if (partType === "tool_result") {
      const result = stringifyValue(part.content ?? part.text ?? part.result);
      chunks.push({
        type: "tool-result",
        title: "Tool result",
        value: result || "(no tool result content)",
        metadata: {
          callId: typeof part.tool_use_id === "string" ? part.tool_use_id : undefined,
          ok: part.is_error !== true,
          provider: "claude-code",
        },
      });
    }
  }

  const assistantText = assistantParts.join("").trim();
  if (assistantText) {
    chunks.push({
      type: "message",
      title: "Agent output",
      value: assistantText,
      metadata: { assistantKind: "assistant" },
    });
  }

  return {
    assistantText,
    chunks,
    usage: messageUsage,
    usageIsDelta: Boolean(messageUsage),
    usageKey: messageUsageKey,
    sessionId,
  };
};

async function executeClaudeTurn(options: ClaudeTurnExecutionOptions): Promise<ClaudeTurnExecutionResult> {
  const { binaryPath, launchArgs } = resolveClaudeCodeConfig(options.config);
  let assistantText = "";
  let latestAssistantText = "";
  let sessionId: string | null = null;
  let usage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };
  const previousDeltaUsageByKey = new Map<string, RunTokenUsage>();

  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, TURN_TIMEOUT_MS);
  const abort = () => abortController.abort();
  options.signal.addEventListener("abort", abort, { once: true });

  const permissionMode =
    options.yoloMode === true ? "bypassPermissions" : options.inputMode === "code" ? "acceptEdits" : "plan";
  const sdkOptions: ClaudeAgentOptions = {
    cwd: options.cwd,
    pathToClaudeCodeExecutable: binaryPath,
    model: normalizeClaudeCodeModelId(options.modelId || CLAUDE_DEFAULT_MODEL),
    effort: resolveClaudeCodeEffort(options.providerOptions) as ClaudeAgentOptions["effort"],
    permissionMode,
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(options.previousSessionId ? { resume: options.previousSessionId } : {}),
    abortController,
    canUseTool: buildClaudeCanUseTool(options),
    env: buildClaudeProcessEnv(options.networkProxy),
    ...launchArgsToSdkOptions(launchArgs),
  };
  const claudeQuery = query({
    prompt: buildPrompt(options),
    options: sdkOptions,
  });

  try {
    for await (const event of claudeQuery) {
      const parsed = parseClaudeCodeStreamEvent(event);
      if (parsed.sessionId && parsed.sessionId !== sessionId) {
        sessionId = parsed.sessionId;
        options.onChunk?.({
          type: "status",
          title: "Claude session",
          value: options.previousSessionId ? "Claude Code session resumed." : "Claude Code session ready.",
          metadata: {
            silent: true,
            providerSessionRuntime: {
              cwd: options.cwd,
              modelId: options.modelId || CLAUDE_DEFAULT_MODEL,
              runtimeMode: options.inputMode,
              status: "running",
              resumeCursor: {
                resume: parsed.sessionId,
                sessionId: parsed.sessionId,
              },
              runtimePayload: {
                previousResponseId: parsed.sessionId,
                sessionType: options.isChat ? "chat" : "run",
              },
            },
          },
        });
      }
      const usageUpdate = mergeClaudeUsageUpdate(usage, previousDeltaUsageByKey, parsed);
      if (usageUpdate.changed) {
        usage = usageUpdate.usage;
        options.onChunk?.({
          type: "status",
          title: "Claude usage",
          value: "Usage updated.",
          metadata: {
            silent: true,
            usageTotals: usage,
          },
        });
      }
      if (parsed.assistantText) {
        assistantText += parsed.assistantText;
        latestAssistantText = parsed.assistantText;
      }
      for (const chunk of parsed.chunks) {
        if (chunk.metadata?.assistantKind === "final-summary" && assistantText.trim()) {
          continue;
        }
        options.onChunk?.(chunk);
      }
    }
  } catch (error) {
    if (timedOut) {
      throw new Error("Claude Code request timed out.");
    }
    if (options.signal.aborted) {
      return {
        summary: latestAssistantText.trim() || assistantText.trim() || "Claude Code run cancelled.",
        sessionId,
        usage,
      };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
    claudeQuery.close();
  }

  return {
    summary: latestAssistantText.trim() || assistantText.trim() || "Claude Code run completed.",
    sessionId,
    usage,
  };
}

export class ClaudeCodeProviderAdapter implements ProviderAdapter {
  readonly providerType = "claude-code" as const;

  listRecommendedModels(): string[] {
    return [
      "sonnet",
      "opus",
      "haiku",
      "opusplan",
      "sonnet[1m]",
      "opus[1m]",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
    ];
  }

  validateConfiguration(input: ProviderAccountInput): void {
    const binaryPath = asString(input.config?.[PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY]);
    const launchArgs = asString(input.config?.[PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY]);
    if (binaryPath !== undefined && !binaryPath.trim()) {
      throw new Error("Claude binary path cannot be blank when provided.");
    }
    if (launchArgs !== undefined && launchArgs.includes("\n")) {
      throw new Error("Claude launch arguments must be a single line.");
    }
  }
}

export function assertClaudeCodeAvailable(config: Record<string, unknown> | undefined): void {
  const { binaryPath } = resolveClaudeCodeConfig(config);
  const launch = resolveClaudeCodeProcessLaunch(binaryPath, ["--version"]);
  const result = spawnSync(launch.command, launch.args, {
    timeout: 4_000,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Could not start Claude Code (${result.error.message}).`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim() || `exit code ${String(result.status)}`;
    throw new Error(`Claude Code is not available: ${detail}`);
  }
}

export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  readonly harnessType = "claude-code" as const;

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
    const result = await executeClaudeTurn({
      runId: input.runId,
      cwd: input.worktreePath,
      prompt: input.prompt,
      modelId: input.modelId || CLAUDE_DEFAULT_MODEL,
      previousSessionId: readClaudeResumeSessionId(input.providerSessionRuntime) ?? input.previousResponseId,
      repoContext: input.repoContext,
      inputMode: input.mode,
      isChat: input.isChat,
      attachments: input.attachments,
      networkProxy: input.networkProxy,
      config: input.config,
      providerOptions: input.providerOptions,
      yoloMode: input.yoloMode === true,
      signal,
      requestShellApproval: input.yoloMode === true ? undefined : this.requestShellApproval,
      requestUserInput: this.requestUserInput,
      onChunk,
    });
    return {
      summary: result.summary,
      responseId: result.sessionId,
      usage: result.usage,
      providerSessionRuntime: {
        cwd: input.worktreePath,
        modelId: input.modelId || CLAUDE_DEFAULT_MODEL,
        runtimeMode: input.mode,
        status: "ready",
        resumeCursor: result.sessionId
          ? {
              resume: result.sessionId,
              sessionId: result.sessionId,
            }
          : null,
        runtimePayload: {
          previousResponseId: result.sessionId,
          sessionType: input.isChat ? "chat" : "run",
        },
      },
    };
  }
}

export async function suggestCommitMessageWithClaudeCode(input: {
  cwd: string;
  diffPrompt: string;
  modelId: string;
  networkProxy?: NetworkProxyRuntimeConfig;
  config?: Record<string, unknown>;
  providerOptions?: {
    anthropicEffort?: string;
  };
  signal?: AbortSignal;
}): Promise<string> {
  const result = await executeClaudeTurn({
    runId: "commit-message",
    cwd: input.cwd,
    prompt: input.diffPrompt,
    modelId: input.modelId || CLAUDE_DEFAULT_MODEL,
    inputMode: "ask",
    isChat: true,
    networkProxy: input.networkProxy,
    config: input.config,
    providerOptions: input.providerOptions,
    signal: input.signal ?? new AbortController().signal,
  });
  return result.summary.trim();
}

type GenerateAskTextWithClaudeCodeInput = {
  cwd: string;
  prompt: string;
  modelId: string;
  networkProxy?: NetworkProxyRuntimeConfig;
  config?: Record<string, unknown>;
  providerOptions?: {
    anthropicEffort?: string;
  };
  signal?: AbortSignal;
};

export async function generateAskTextResultWithClaudeCode(input: GenerateAskTextWithClaudeCodeInput): Promise<{
  text: string;
  usage: RunTokenUsage;
}> {
  const result = await executeClaudeTurn({
    runId: "ask-text",
    cwd: input.cwd,
    prompt: input.prompt,
    modelId: input.modelId || CLAUDE_DEFAULT_MODEL,
    inputMode: "ask",
    isChat: true,
    networkProxy: input.networkProxy,
    config: input.config,
    providerOptions: input.providerOptions,
    signal: input.signal ?? new AbortController().signal,
  });
  return {
    text: result.summary.trim(),
    usage: result.usage,
  };
}

export async function generateAskTextWithClaudeCode(input: GenerateAskTextWithClaudeCodeInput): Promise<string> {
  return (await generateAskTextResultWithClaudeCode(input)).text;
}
