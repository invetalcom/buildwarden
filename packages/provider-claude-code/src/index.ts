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
  ShellApprovalDecision,
  RunTokenUsage,
} from "@easycode/shared";
import {
  PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY,
  buildNetworkProxyUrl,
} from "@easycode/shared";

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
  onChunk?: (chunk: HarnessRunChunk) => void;
};

type ClaudeTurnExecutionResult = {
  summary: string;
  sessionId: string | null;
  usage: RunTokenUsage;
};

export type ClaudeCodeProcessLaunch = {
  command: string;
  args: string[];
};

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asFiniteNumber = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
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
    "You are Easycode, a desktop coding agent running inside a local repository.",
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

const readUsage = (value: unknown): RunTokenUsage => {
  if (!isRecord(value)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const baseInputTokens = asFiniteNumber(value.input_tokens ?? value.inputTokens);
  const outputTokens = asFiniteNumber(value.output_tokens ?? value.outputTokens);
  const cacheReadInputTokens = asFiniteNumber(value.cache_read_input_tokens ?? value.cacheReadInputTokens ?? value.cachedInputTokens);
  const cacheCreationInputTokens = asFiniteNumber(value.cache_creation_input_tokens ?? value.cacheCreationInputTokens);
  const inputTokens = baseInputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  const totalTokens = asFiniteNumber(value.total_tokens ?? value.totalTokens) || inputTokens + outputTokens;
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
  if (totalTokens > 0) {
    usage.totalTokens = totalTokens;
  }
  return usage;
};

const addUsage = (left: RunTokenUsage, right: RunTokenUsage): RunTokenUsage => {
  const reasoningTokens = (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0);
  const cachedInputTokens = (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0);
  const cacheCreationInputTokens = (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0);
  const totalTokens = (left.totalTokens ?? left.inputTokens + left.outputTokens) + (right.totalTokens ?? right.inputTokens + right.outputTokens);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    ...(totalTokens > 0 ? { totalTokens } : {}),
  };
};

const readModelUsage = (value: unknown): RunTokenUsage | null => {
  if (!isRecord(value)) {
    return null;
  }
  let usage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const entry of Object.values(value)) {
    if (isRecord(entry)) {
      usage = addUsage(usage, readUsage(entry));
    }
  }
  return usage.inputTokens > 0 || usage.outputTokens > 0 ? usage : null;
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
  new Set(["write_file", "edit_file", "write", "edit", "multiedit", "notebookedit", "todowrite"]).has(
    normalizeClaudeCodeToolName(toolName),
  );

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

export const buildClaudeCanUseTool = (options: ClaudeTurnExecutionOptions): CanUseTool => async (toolName, input, callbackOptions) => {
  if (callbackOptions.signal.aborted || options.signal.aborted) {
    return claudePermissionDenied("Run cancelled.");
  }

  const normalizedToolName = normalizeClaudeCodeToolName(toolName);
  if (normalizedToolName === "askuserquestion") {
    const question = readClaudeUserQuestion(input);
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
    return claudePermissionDenied("Easycode recorded this question in the run timeline. Wait for the user to answer in a follow-up.");
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
      message: "Easycode captured the proposed plan for user review. Stop here and wait for a follow-up.",
      interrupt: true,
    };
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
      return claudePermissionDenied("Easycode could not determine the shell command to approve.");
    }
    const decision = options.requestShellApproval ? await options.requestShellApproval(command) : "allow-once";
    return decision === "deny"
      ? claudePermissionDenied("User denied shell command execution.")
      : claudePermissionAllowed(input, shouldApplyClaudeSessionPermissions(decision) ? callbackOptions.suggestions : undefined);
  }

  if (isClaudeFileChangeTool(normalizedToolName)) {
    return options.inputMode === "code"
      ? claudePermissionAllowed(input, callbackOptions.suggestions)
      : claudePermissionDenied("Easycode only allows file edits in code mode.");
  }

  return options.inputMode === "code"
    ? claudePermissionAllowed(input, callbackOptions.suggestions)
    : claudePermissionDenied("Easycode only allows this tool in code mode.");
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
): { assistantText: string; chunks: HarnessRunChunk[]; usage?: RunTokenUsage; sessionId?: string } => {
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
    const usage = readModelUsage(event.modelUsage) ?? readUsage(event.usage);
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

  const message = event.message ?? event;
  if (!isRecord(message)) {
    return { assistantText: "", chunks: [], sessionId };
  }

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

  return { assistantText, chunks, sessionId };
};

async function executeClaudeTurn(options: ClaudeTurnExecutionOptions): Promise<ClaudeTurnExecutionResult> {
  const { binaryPath, launchArgs } = resolveClaudeCodeConfig(options.config);
  let assistantText = "";
  let latestAssistantText = "";
  let sessionId: string | null = null;
  let usage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };

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
      if (parsed.usage) {
        usage = parsed.usage;
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
      throw new Error("Run cancelled.");
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

  constructor(private readonly requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>) {}

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
