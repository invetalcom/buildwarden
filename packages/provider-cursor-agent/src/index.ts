import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  formatRunPlanProgressContent,
  getModelPresetsForProvider,
  normalizeRunPlanProgressPayload,
  normalizeRunPlanStepStatus,
  PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY,
  PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY,
  type ChatAttachmentPayload,
  type HarnessAdapter,
  type HarnessRunChunk,
  type HarnessToolContext,
  type ProviderAdapter,
  type ProviderAvailableModel,
  type ProviderAvailableModelsContext,
  type ProviderAccountInput,
  type RunExecutionRequest,
  type RunMode,
  type RunPlanProgressPayload,
  type RunTokenUsage,
  type RunUserInputAnswers,
  type RunUserInputQuestion,
  type RunUserInputRequest,
  type ShellApprovalDecision,
} from "@buildwarden/shared";

const PROVIDER = "cursor-agent" as const;
const HARNESS = "cursor-acp" as const;
const CURSOR_RESUME_SCHEMA_VERSION = 1;
const CURSOR_DEFAULT_MODEL = "default";
const CURSOR_MODEL_CONFIG_OPTIONS_KEY = "cursorAcpConfigOptions";
const CURSOR_MODEL_MAX_TOKENS_KEY = "cursorMaxTokens";
const ABOUT_TIMEOUT_MS = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

type JsonRpcId = number | string;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type CursorProcessLaunch = {
  command: string;
  args: string[];
  shell?: boolean;
};

type CursorAcpConfigOption = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  category?: unknown;
  currentValue?: unknown;
  options?: unknown;
};

type CursorToolState = {
  id: string;
  kind?: string;
  title?: string;
  status?: "pending" | "inProgress" | "completed" | "failed";
  command?: string;
  detail?: string;
  raw?: unknown;
};

type CursorAcpStartedSession = {
  sessionId: string;
  configOptions: CursorAcpConfigOption[];
  modelConfigId?: string;
};

type CursorRuntimeOptions = {
  cwd: string;
  binaryPath: string;
  apiEndpoint?: string;
  devLogger?: CursorDevLogger;
  resumeSessionId?: string;
  modelId: string;
  mode: RunMode;
  yoloMode?: boolean;
  modelConfig?: Record<string, unknown>;
  providerOptions?: {
    reasoningEffort?: string;
  };
  attachments?: ChatAttachmentPayload[];
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>;
  requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>;
  onChunk?: (chunk: HarnessRunChunk) => void;
  onUsage?: (usage: RunTokenUsage) => void;
  onAssistantText?: (text: string) => void;
  signal: AbortSignal;
};

type CursorDevLogger = {
  enabled: boolean;
  log: (event: string, data: unknown) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asArray = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined);

const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

const sanitizeMetadataValue = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
};

const toJsonLine = (event: string, data: unknown) =>
  JSON.stringify({
    ts: new Date().toISOString(),
    event,
    data: sanitizeMetadataValue(data),
  }) + "\n";

export const createCursorDevLogger = (input: {
  logDirPath?: string;
  runId: string;
  modelId: string;
  sessionType: "run" | "chat";
}): CursorDevLogger => {
  const enabled = Boolean(input.logDirPath?.trim());
  const logDirPath = input.logDirPath?.trim() ?? "";
  const filePath = enabled ? join(logDirPath, `${input.sessionType}-${input.runId}-${PROVIDER}-${input.modelId}.jsonl`) : "";

  if (enabled) {
    mkdirSync(logDirPath, { recursive: true });
  }

  return {
    enabled,
    log: (event, data) => {
      if (!enabled) {
        return;
      }
      appendFileSync(filePath, toJsonLine(event, data), "utf8");
    },
  };
};

export const resolveCursorAgentProcessLaunch = (binaryPath: string, args: string[]): CursorProcessLaunch => {
  if (process.platform !== "win32") {
    return { command: binaryPath, args };
  }

  const hasPathSeparator = /[\\/]/.test(binaryPath);
  const isCommandShim = /\.(?:cmd|bat)$/i.test(binaryPath);
  if (!hasPathSeparator || isCommandShim) {
    return { command: binaryPath, args, shell: true };
  }

  return { command: binaryPath, args };
};

const readConfigString = (
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export const getCursorAgentBinaryPath = (config?: Record<string, unknown>): string =>
  readConfigString(config, PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY) ?? getDefaultCursorAgentBinaryPath();

const getCursorAgentApiEndpoint = (config?: Record<string, unknown>): string | undefined =>
  readConfigString(config, PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY);

export const getDefaultCursorAgentBinaryPath = (): string => {
  return getCursorAgentBinaryPathCandidates().find((candidate) => existsSync(candidate)) ?? "agent";
};

const candidateBaseDirs = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const home = env.USERPROFILE || homedir();
  const dirs = [
    join(home, ".local", "bin"),
    env.APPDATA ? join(env.APPDATA, "npm") : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "pnpm") : undefined,
    join(home, "scoop", "shims"),
    env.ProgramData ? join(env.ProgramData, "chocolatey", "bin") : undefined,
  ];
  return Array.from(new Set(dirs.filter((dir): dir is string => Boolean(dir))));
};

export const getCursorAgentBinaryPathCandidates = (env: NodeJS.ProcessEnv = process.env): string[] => {
  if (process.platform !== "win32") {
    return [join(homedir(), ".local", "bin", "agent"), join(homedir(), ".local", "bin", "cursor-agent")];
  }
  return candidateBaseDirs(env).flatMap((dir) => [
    join(dir, "agent.exe"),
    join(dir, "agent.cmd"),
    join(dir, "cursor-agent.exe"),
    join(dir, "cursor-agent.cmd"),
  ]);
};

const normalizeToken = (value: string | undefined): string =>
  (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "-");

const configOptionId = (option: CursorAcpConfigOption): string => asString(option.id)?.trim() ?? "";

const configOptionName = (option: CursorAcpConfigOption): string => asString(option.name)?.trim() ?? "";

const flattenSelectOptions = (option: CursorAcpConfigOption | undefined): Array<{ value: string; name: string }> => {
  const options = asArray(option?.options) ?? [];
  const flattened: Array<{ value: string; name: string }> = [];
  for (const entry of options) {
    if (!isRecord(entry)) {
      continue;
    }
    const value = asString(entry.value)?.trim();
    const name = asString(entry.name)?.trim() ?? asString(entry.label)?.trim() ?? value;
    if (value) {
      flattened.push({ value, name: name || value });
      continue;
    }
    const nested = asArray(entry.options) ?? [];
    for (const nestedEntry of nested) {
      if (!isRecord(nestedEntry)) {
        continue;
      }
      const nestedValue = asString(nestedEntry.value)?.trim();
      const nestedName = asString(nestedEntry.name)?.trim() ?? asString(nestedEntry.label)?.trim() ?? nestedValue;
      if (nestedValue) {
        flattened.push({ value: nestedValue, name: nestedName || nestedValue });
      }
    }
  }
  return flattened;
};

const findConfigOption = (
  configOptions: readonly CursorAcpConfigOption[] | undefined,
  matcher: (option: CursorAcpConfigOption) => boolean,
): CursorAcpConfigOption | undefined => configOptions?.find(matcher);

const isModelConfigOption = (option: CursorAcpConfigOption): boolean => {
  const id = normalizeToken(configOptionId(option));
  const name = normalizeToken(configOptionName(option));
  const category = normalizeToken(asString(option.category));
  if (id === "model" || id === "model-id" || name === "model" || name === "model-id") {
    return true;
  }
  if (category !== "model" && category !== "model-config") {
    return false;
  }
  const combined = `${id} ${name}`;
  return (
    combined.includes("model") &&
    !combined.includes("context") &&
    !combined.includes("reasoning") &&
    !combined.includes("effort") &&
    !combined.includes("fast") &&
    !combined.includes("thinking")
  );
};

const isReasoningConfigOption = (option: CursorAcpConfigOption): boolean => {
  const id = normalizeToken(configOptionId(option));
  const name = normalizeToken(configOptionName(option));
  return id.includes("reasoning") || id.includes("effort") || name.includes("reasoning") || name.includes("effort");
};

const isContextConfigOption = (option: CursorAcpConfigOption): boolean => {
  const id = normalizeToken(configOptionId(option));
  const name = normalizeToken(configOptionName(option));
  return id.includes("context") || name.includes("context");
};

const isModeConfigOption = (option: CursorAcpConfigOption): boolean => normalizeToken(configOptionId(option)) === "mode";

const parseContextWindowTokenCount = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*([km])?/);
  if (!match) {
    return undefined;
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) {
    return undefined;
  }
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Math.round(base * multiplier);
};

export const deriveCursorMaxTokensFromConfigOptions = (
  configOptions: readonly CursorAcpConfigOption[] | undefined,
): number | undefined => {
  const contextOption = findConfigOption(configOptions, isContextConfigOption);
  if (!contextOption) {
    return undefined;
  }
  const current = parseContextWindowTokenCount(contextOption.currentValue);
  if (current) {
    return current;
  }
  const optionCounts = flattenSelectOptions(contextOption)
    .flatMap((option) => [parseContextWindowTokenCount(option.value), parseContextWindowTokenCount(option.name)])
    .filter((value): value is number => typeof value === "number" && value > 0);
  return optionCounts.length > 0 ? Math.max(...optionCounts) : undefined;
};

const buildCursorModelConfig = (
  configOptions: readonly CursorAcpConfigOption[] | undefined,
): Record<string, unknown> | undefined => {
  if (!configOptions?.length) {
    return undefined;
  }
  const maxTokens = deriveCursorMaxTokensFromConfigOptions(configOptions);
  return {
    [CURSOR_MODEL_CONFIG_OPTIONS_KEY]: configOptions,
    ...(maxTokens ? { [CURSOR_MODEL_MAX_TOKENS_KEY]: maxTokens } : {}),
  };
};

const cursorConfigOptionsFromModelConfig = (modelConfig?: Record<string, unknown>): CursorAcpConfigOption[] => {
  const value = modelConfig?.[CURSOR_MODEL_CONFIG_OPTIONS_KEY];
  return Array.isArray(value) ? value.filter(isRecord) : [];
};

export function resolveCursorAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : CURSOR_DEFAULT_MODEL;
  return base.includes("[") ? base.slice(0, base.indexOf("[")).trim() : base;
}

const normalizeReasoningEffort = (value: string | undefined): string | undefined => {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return undefined;
  }
  const map: Record<string, string> = {
    min: "low",
    minimum: "low",
    low: "low",
    medium: "medium",
    med: "medium",
    high: "high",
    xhigh: "xhigh",
    "x-high": "xhigh",
    max: "max",
    maximum: "max",
  };
  return map[normalized] ?? normalized;
};

export const resolveCursorAcpConfigUpdates = (
  configOptions: readonly CursorAcpConfigOption[] | undefined,
  providerOptions: { reasoningEffort?: string } | undefined,
): Array<{ configId: string; value: string | boolean }> => {
  const reasoning = normalizeReasoningEffort(providerOptions?.reasoningEffort);
  if (!reasoning) {
    return [];
  }
  const reasoningOption = findConfigOption(configOptions, isReasoningConfigOption);
  const configId = reasoningOption ? configOptionId(reasoningOption) : "";
  if (!configId) {
    return [];
  }
  const selected = flattenSelectOptions(reasoningOption).find((option) => {
    const normalizedValue = normalizeReasoningEffort(option.value);
    const normalizedName = normalizeReasoningEffort(option.name);
    return normalizedValue === reasoning || normalizedName === reasoning;
  });
  return selected ? [{ configId, value: selected.value }] : [];
};

const addUsage = (left: RunTokenUsage, right: RunTokenUsage): RunTokenUsage => {
  const totalTokens = (left.totalTokens ?? left.inputTokens + left.outputTokens) + (right.totalTokens ?? right.inputTokens + right.outputTokens);
  const reasoningTokens = (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0);
  const cachedInputTokens = (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0);
  const result: RunTokenUsage = {
    ...left,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens,
    totalProcessedTokens: totalTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(right.usedTokens !== undefined ? { usedTokens: right.usedTokens, lastUsedTokens: right.usedTokens } : {}),
    ...(right.maxTokens !== undefined ? { maxTokens: right.maxTokens } : {}),
    ...(right.lastInputTokens !== undefined ? { lastInputTokens: right.lastInputTokens } : {}),
    ...(right.lastOutputTokens !== undefined ? { lastOutputTokens: right.lastOutputTokens } : {}),
    ...(right.lastReasoningTokens !== undefined ? { lastReasoningTokens: right.lastReasoningTokens } : {}),
    ...(right.lastCachedInputTokens !== undefined ? { lastCachedInputTokens: right.lastCachedInputTokens } : {}),
  };
  return result;
};

const readUsageFromRecord = (record: Record<string, unknown>): RunTokenUsage | null => {
  const inputTokens = asFiniteNumber(
    record.inputTokens ?? record.input_tokens ?? record.promptTokens ?? record.prompt_tokens,
  ) ?? 0;
  const outputTokens = asFiniteNumber(
    record.outputTokens ?? record.output_tokens ?? record.completionTokens ?? record.completion_tokens,
  ) ?? 0;
  const reasoningTokens = asFiniteNumber(record.reasoningTokens ?? record.reasoning_tokens);
  const cachedInputTokens = asFiniteNumber(record.cachedInputTokens ?? record.cached_input_tokens);
  const totalTokens = asFiniteNumber(record.totalTokens ?? record.total_tokens ?? record.tokens);
  const usedTokens = asFiniteNumber(
    record.usedTokens ?? record.used_tokens ?? record.contextUsedTokens ?? record.context_used_tokens,
  );
  const maxTokens = asFiniteNumber(
    record.maxTokens ?? record.max_tokens ?? record.contextWindow ?? record.context_window ?? record.contextWindowTokens,
  );

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    reasoningTokens === undefined &&
    cachedInputTokens === undefined &&
    totalTokens === undefined &&
    usedTokens === undefined &&
    maxTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens, lastReasoningTokens: reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens, totalProcessedTokens: totalTokens } : {}),
    ...(usedTokens !== undefined ? { usedTokens, lastUsedTokens: usedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
    ...(outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
  };
};

export const normalizeCursorTokenUsage = (payload: unknown): RunTokenUsage | null => {
  if (!isRecord(payload)) {
    return null;
  }
  const direct = readUsageFromRecord(payload);
  if (direct) {
    return direct;
  }
  const candidates = [
    payload.usage,
    payload.tokenUsage,
    payload.token_usage,
    payload.modelUsage,
    payload.model_usage,
    payload.contextUsage,
    payload.context_usage,
    payload.context,
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      const usage = readUsageFromRecord(candidate);
      if (usage) {
        return usage;
      }
    }
  }
  const update = isRecord(payload.update) ? payload.update : undefined;
  return update ? normalizeCursorTokenUsage(update) : null;
};

export const extractCursorTodosAsPlanProgress = (params: unknown): RunPlanProgressPayload | null => {
  if (!isRecord(params)) {
    return null;
  }
  const todos = asArray(params.todos) ?? [];
  const steps = todos.flatMap((todo, index) => {
    if (!isRecord(todo)) {
      return [];
    }
    const title =
      asString(todo.content)?.trim() ??
      asString(todo.title)?.trim() ??
      asString(todo.name)?.trim() ??
      `Step ${String(index + 1)}`;
    return [
      {
        title,
        status: normalizeRunPlanStepStatus(todo.status),
      },
    ];
  });
  if (steps.length === 0) {
    return null;
  }
  return normalizeRunPlanProgressPayload({ steps, source: "cursor-acp" }, "cursor-acp");
};

export const buildCursorPlanProgressChunk = (
  progress: RunPlanProgressPayload,
  rawPayload: unknown,
): HarnessRunChunk => {
  const normalized = normalizeRunPlanProgressPayload({ ...progress, source: "cursor-acp" }, "cursor-acp") ?? progress;
  return {
    type: "plan-progress",
    title: "Plan progress",
    value: formatRunPlanProgressContent(normalized),
    metadata: {
      provider: PROVIDER,
      planProgress: normalized,
      streamId: "cursor-plan-progress",
      replace: true,
      rawPlanUpdate: sanitizeMetadataValue(rawPayload),
    },
  };
};

const buildCursorPlanUpdatedChunk = (params: unknown): HarnessRunChunk | null => {
  if (!isRecord(params)) {
    return null;
  }
  const plan = asString(params.plan)?.trim();
  if (!plan) {
    return null;
  }
  return {
    type: "plan-updated",
    title: asString(params.name)?.trim() || "Cursor plan",
    value: plan,
    metadata: {
      provider: PROVIDER,
      source: "cursor-acp",
      planKind: "proposal",
      rawPlanUpdate: sanitizeMetadataValue(params),
    },
  };
};

const parseSessionPlanUpdate = (params: unknown): RunPlanProgressPayload | null => {
  if (!isRecord(params)) {
    return null;
  }
  const update = isRecord(params.update) ? params.update : params;
  if (update.sessionUpdate !== "plan") {
    return null;
  }
  const entries = asArray(update.entries) ?? [];
  const steps = entries.flatMap((entry, index) => {
    if (!isRecord(entry)) {
      return [];
    }
    const title = asString(entry.content)?.trim() || `Step ${String(index + 1)}`;
    return [{ title, status: normalizeRunPlanStepStatus(entry.status) }];
  });
  return steps.length > 0 ? normalizeRunPlanProgressPayload({ steps, source: "cursor-acp" }, "cursor-acp") : null;
};

const normalizeCursorToolName = (kind: string | undefined): string => {
  switch (normalizeToken(kind)) {
    case "execute":
      return "run_shell";
    case "edit":
      return "edit_file";
    case "delete":
      return "delete_file";
    case "move":
      return "edit_file";
    case "search":
      return "search_repo";
    case "read":
    case "fetch":
      return "read_file";
    default:
      return "tool";
  }
};

const normalizeCursorToolStatus = (value: unknown): CursorToolState["status"] | undefined => {
  const normalized = normalizeToken(asString(value));
  if (normalized === "completed" || normalized === "complete" || normalized === "done" || normalized === "success") return "completed";
  if (normalized === "failed" || normalized === "failure" || normalized === "error") return "failed";
  if (normalized === "pending") return "pending";
  if (normalized === "in-progress" || normalized === "running" || normalized === "started") return "inProgress";
  return undefined;
};

const normalizeCommandValue = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
};

const extractCommandFromRawInput = (rawInput: unknown, title: string | undefined): string | undefined => {
  if (isRecord(rawInput)) {
    const direct = normalizeCommandValue(rawInput.command);
    if (direct) {
      return direct;
    }
    const executable = asString(rawInput.executable)?.trim();
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) {
      return `${executable} ${args}`;
    }
    if (executable) {
      return executable;
    }
  }
  const match = title?.match(/`([^`]+)`/);
  return match?.[1]?.trim();
};

const textContentFromToolContent = (content: unknown): string | undefined => {
  const entries = asArray(content) ?? [];
  const chunks: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const nested = isRecord(entry.content) ? entry.content : entry;
    if (nested.type === "text" && typeof nested.text === "string" && nested.text.trim()) {
      chunks.push(nested.text.trim());
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
};

const parseCursorToolState = (params: unknown): CursorToolState | null => {
  if (!isRecord(params)) {
    return null;
  }
  const update = isRecord(params.update) ? params.update : params;
  const updateKind = asString(update.sessionUpdate);
  if (updateKind !== "tool_call" && updateKind !== "tool_call_update") {
    return null;
  }
  const id = asString(update.toolCallId)?.trim();
  if (!id) {
    return null;
  }
  const title = asString(update.title)?.trim();
  const kind = asString(update.kind)?.trim();
  const status = normalizeCursorToolStatus(update.status) ?? (updateKind === "tool_call" ? "pending" : undefined);
  const command = extractCommandFromRawInput(update.rawInput, title);
  const detail = command ?? textContentFromToolContent(update.content) ?? title;
  return {
    id,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    raw: sanitizeMetadataValue(params),
  };
};

const mergeCursorToolState = (left: CursorToolState | undefined, right: CursorToolState): CursorToolState => ({
  id: right.id,
  kind: right.kind ?? left?.kind,
  title: right.title ?? left?.title,
  status: right.status ?? left?.status,
  command: right.command ?? left?.command,
  detail: right.detail ?? left?.detail,
  raw: right.raw ?? left?.raw,
});

const cursorToolChunkForState = (tool: CursorToolState): HarnessRunChunk => {
  const toolName = normalizeCursorToolName(tool.kind);
  const title = tool.title ?? (toolName === "run_shell" ? "Shell command" : "Cursor tool");
  const value = tool.command ?? tool.detail ?? title;
  const metadata = {
    provider: PROVIDER,
    toolName,
    callId: tool.id,
    cursorToolKind: tool.kind,
    command: tool.command,
    status: tool.status,
    rawToolCall: tool.raw,
  };
  if (tool.status === "completed" || tool.status === "failed") {
    return {
      type: "tool-result",
      title,
      value,
      metadata: {
        ...metadata,
        ok: tool.status === "completed",
      },
    };
  }
  return {
    type: tool.status === "pending" ? "tool-call" : "tool-progress",
    title,
    value,
    metadata,
  };
};

const textFromSessionUpdate = (params: unknown): string | null => {
  if (!isRecord(params)) {
    return null;
  }
  const update = isRecord(params.update) ? params.update : params;
  if (update.sessionUpdate !== "agent_message_chunk") {
    return null;
  }
  const content = isRecord(update.content) ? update.content : {};
  return content.type === "text" && typeof content.text === "string" ? content.text : null;
};

class CursorAcpJsonRpcConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout?: NodeJS.Timeout;
      method: string;
    }
  >();
  private readonly requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
  private readonly notificationHandlers = new Map<string, Array<(params: unknown) => void | Promise<void>>>();
  private stderr = "";

  constructor(
    private readonly launch: CursorProcessLaunch,
    private readonly cwd: string,
    private readonly devLogger?: CursorDevLogger,
    private readonly timeoutMs = 30_000,
  ) {}

  handleRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void {
    this.requestHandlers.set(method, handler);
  }

  handleNotification(method: string, handler: (params: unknown) => void | Promise<void>): void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
  }

  start(): void {
    if (this.child) {
      return;
    }
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.cwd,
      env: process.env,
      stdio: "pipe",
      windowsHide: true,
      shell: this.launch.shell,
    });
    this.child = child;
    this.devLogger?.log("cursor.process.start", {
      command: this.launch.command,
      args: this.launch.args,
      cwd: this.cwd,
      shell: this.launch.shell === true,
    });

    const stdoutLines = createInterface({ input: child.stdout });
    stdoutLines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8");
      this.stderr += message;
      this.devLogger?.log("cursor.stderr", { message });
    });
    child.on("error", (error) => {
      this.devLogger?.log("cursor.process.error", { message: error.message });
      this.rejectAll(error);
    });
    child.on("exit", (code, signal) => {
      this.devLogger?.log("cursor.process.exit", {
        code,
        signal,
        stderr: this.stderr.trim(),
      });
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`Cursor Agent ACP exited (${code ?? signal ?? "unknown"}). ${this.stderr.trim()}`.trim()));
      }
    });
  }

  close(): void {
    const child = this.child;
    this.child = null;
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error("Cursor Agent ACP connection closed."));
    }
    this.pending.clear();
    if (child && !child.killed) {
      child.kill();
    }
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const child = this.child;
    if (!child) {
      throw new Error("Cursor Agent ACP connection has not started.");
    }
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    this.devLogger?.log("cursor.rpc.outbound", message);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Cursor Agent ACP request timed out: ${method}`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timeout, method });
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return (await promise) as T;
  }

  notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child) {
      return;
    }
    const message = { jsonrpc: "2.0", method, params };
    this.devLogger?.log("cursor.rpc.outbound", message);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.devLogger?.log("cursor.rpc.invalid", { line: trimmed });
      return;
    }

    if (message.id !== undefined && !message.method) {
      this.devLogger?.log("cursor.rpc.response", message);
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message || `Cursor Agent ACP request failed: ${pending.method}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      this.devLogger?.log("cursor.rpc.request", message);
      void this.handleIncomingRequest(message);
      return;
    }

    if (message.method) {
      this.devLogger?.log("cursor.rpc.notification", message);
      const handlers = this.notificationHandlers.get(message.method) ?? [];
      for (const handler of handlers) {
        void Promise.resolve(handler(message.params)).catch(() => {
          /* Ignore notification handler failures. */
        });
      }
    }
  }

  private async handleIncomingRequest(message: JsonRpcMessage): Promise<void> {
    const handler = message.method ? this.requestHandlers.get(message.method) : undefined;
    try {
      const result = handler ? await handler(message.params) : null;
      this.sendResponse({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.sendResponse({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Cursor Agent request handler failed.",
        },
      });
    }
  }

  private sendResponse(message: JsonRpcMessage): void {
    this.devLogger?.log("cursor.rpc.outbound", message);
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const extractSessionId = (value: unknown): string | undefined =>
  isRecord(value) ? asString(value.sessionId)?.trim() : undefined;

const extractConfigOptions = (value: unknown): CursorAcpConfigOption[] =>
  isRecord(value) && Array.isArray(value.configOptions) ? value.configOptions.filter(isRecord) : [];

const extractModelConfigId = (configOptions: readonly CursorAcpConfigOption[]): string | undefined =>
  configOptionId(configOptions.find(isModelConfigOption) ?? {}) || undefined;

const responseConfigOptions = (value: unknown): CursorAcpConfigOption[] => extractConfigOptions(value);

const selectConfigOptionValue = (
  option: CursorAcpConfigOption | undefined,
  candidates: readonly string[],
): string | undefined => {
  if (!option) {
    return undefined;
  }
  const normalizedCandidates = new Set(candidates.map(normalizeToken));
  return flattenSelectOptions(option).find((entry) => {
    const value = normalizeToken(entry.value);
    const name = normalizeToken(entry.name);
    return normalizedCandidates.has(value) || normalizedCandidates.has(name);
  })?.value;
};

const modeCandidatesForRunMode = (mode: RunMode): string[] => {
  if (mode === "plan") {
    return ["plan", "architect"];
  }
  if (mode === "ask") {
    return ["ask", "chat", "default"];
  }
  return ["code", "agent", "implement", "default", "chat"];
};

const modeFallbackInstruction = (mode: RunMode): string => {
  if (mode === "plan") {
    return "Operate in planning mode. Do not modify files or run destructive commands unless the user explicitly asks you to switch to implementation.";
  }
  if (mode === "ask") {
    return "Operate in ask mode. Answer directly and avoid modifying files.";
  }
  return "Operate in code mode. Make the requested code changes and keep the work reviewable.";
};

const selectPermissionOption = (params: unknown, kinds: readonly string[]): string | undefined => {
  if (!isRecord(params)) {
    return undefined;
  }
  const options = asArray(params.options) ?? [];
  const normalizedKinds = new Set(kinds.map(normalizeToken));
  for (const option of options) {
    if (!isRecord(option)) {
      continue;
    }
    const kind = normalizeToken(asString(option.kind));
    const optionId = asString(option.optionId)?.trim();
    if (optionId && (normalizedKinds.has(kind) || normalizedKinds.has(normalizeToken(optionId)))) {
      return optionId;
    }
  }
  return undefined;
};

const selectAllowOnceOption = (params: unknown): string | undefined => selectPermissionOption(params, ["allow-once", "allow_once"]);

const selectAllowAlwaysOption = (params: unknown): string | undefined => selectPermissionOption(params, ["allow-always", "allow_always"]);

const selectRejectOption = (params: unknown): string | undefined =>
  selectPermissionOption(params, ["reject-once", "reject_once", "deny", "decline"]);

const permissionResponse = (optionId: string | undefined): Record<string, unknown> => {
  if (!optionId) {
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId } };
};

const getPermissionTool = (params: unknown): CursorToolState | null => {
  if (!isRecord(params) || !isRecord(params.toolCall)) {
    return null;
  }
  return parseCursorToolState({
    update: {
      sessionUpdate: "tool_call",
      ...params.toolCall,
    },
  });
};

type ParsedCursorQuestion = {
  question: RunUserInputQuestion;
  answersByLabel: Record<string, string>;
};

const questionFromCursor = (value: unknown): ParsedCursorQuestion | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value.id)?.trim();
  const question = asString(value.prompt)?.trim();
  if (!id || !question) {
    return null;
  }
  const answersByLabel: Record<string, string> = {};
  const options = (asArray(value.options) ?? []).flatMap((option) => {
    if (!isRecord(option)) {
      return [];
    }
    const label = asString(option.label)?.trim() ?? asString(option.id)?.trim();
    if (!label) {
      return [];
    }
    answersByLabel[label] = asString(option.id)?.trim() ?? asString(option.value)?.trim() ?? label;
    return [{ label, description: label }];
  });
  return {
    question: {
      id,
      header: "Question",
      question,
      options: options.length > 0 ? options : [{ label: "OK", description: "Continue" }],
      multiSelect: value.allowMultiple === true,
      allowCustomAnswer: false,
    },
    answersByLabel,
  };
};

const mapCursorAnswerValue = (
  value: string | string[],
  answersByLabel: Record<string, string> | undefined,
): string | string[] => {
  if (!answersByLabel) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => answersByLabel[entry] ?? entry);
  }
  return answersByLabel[value] ?? value;
};

export const mapCursorUserInputAnswers = (
  answers: RunUserInputAnswers,
  answerMapsByQuestionId: Record<string, Record<string, string>>,
): RunUserInputAnswers => {
  const mapped: RunUserInputAnswers = {};
  for (const [questionId, value] of Object.entries(answers)) {
    mapped[questionId] = mapCursorAnswerValue(value, answerMapsByQuestionId[questionId]);
  }
  return mapped;
};

const decodeTextAttachment = (attachment: ChatAttachmentPayload): string | null => {
  const mime = attachment.mimeType.toLowerCase();
  if (!mime.startsWith("text/") && mime !== "application/json" && mime !== "application/xml") {
    return null;
  }
  try {
    return Buffer.from(attachment.dataBase64, "base64").toString("utf8");
  } catch {
    return null;
  }
};

const buildPromptParts = (
  prompt: string,
  attachments: ChatAttachmentPayload[] | undefined,
  modeInstruction?: string,
): Array<Record<string, unknown>> => {
  const parts: Array<Record<string, unknown>> = [];
  const text = [modeInstruction, prompt.trim()].filter(Boolean).join("\n\n");
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const attachment of attachments ?? []) {
    if (attachment.mimeType.toLowerCase().startsWith("image/")) {
      parts.push({
        type: "image",
        data: attachment.dataBase64,
        mimeType: attachment.mimeType,
      });
      continue;
    }
    const textAttachment = decodeTextAttachment(attachment);
    if (textAttachment) {
      parts.push({
        type: "text",
        text: `Attached file: ${attachment.fileName}\n\n${textAttachment}`,
      });
      continue;
    }
    parts.push({
      type: "text",
      text: `Attached file: ${attachment.fileName} (${attachment.mimeType || "application/octet-stream"})`,
    });
  }
  return parts;
};

class CursorAcpRuntime {
  private readonly connection: CursorAcpJsonRpcConnection;
  private session: CursorAcpStartedSession | null = null;
  private readonly toolStates = new Map<string, CursorToolState>();
  private assistantText = "";
  private usage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(private readonly options: CursorRuntimeOptions) {
    const launch = resolveCursorAgentProcessLaunch(options.binaryPath, [
      ...(options.apiEndpoint ? ["-e", options.apiEndpoint] : []),
      "acp",
    ]);
    this.connection = new CursorAcpJsonRpcConnection(launch, options.cwd, options.devLogger);
    this.registerHandlers();
  }

  async start(timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS): Promise<CursorAcpStartedSession> {
    this.connection.start();
    const abort = () => {
      void this.cancel().catch(() => undefined);
      this.connection.close();
    };
    this.options.signal.addEventListener("abort", abort, { once: true });

    await this.connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
        _meta: {
          parameterizedModelPicker: true,
        },
      },
      clientInfo: {
        name: "buildwarden",
        version: "0.5.2",
      },
    }, timeoutMs);
    await this.connection.request("authenticate", { methodId: "cursor_login" }, timeoutMs);

    let setup: unknown;
    let loadedExistingSession = false;
    if (this.options.resumeSessionId) {
      try {
        setup = await this.connection.request("session/load", {
          sessionId: this.options.resumeSessionId,
          cwd: this.options.cwd,
          mcpServers: [],
        }, timeoutMs);
        loadedExistingSession = true;
      } catch {
        setup = undefined;
      }
    }
    if (!setup) {
      setup = await this.connection.request("session/new", {
        cwd: this.options.cwd,
        mcpServers: [],
      }, timeoutMs);
    }
    const sessionId = loadedExistingSession ? this.options.resumeSessionId : extractSessionId(setup);
    if (!sessionId) {
      throw new Error("Cursor Agent ACP did not return a session id.");
    }
    const configOptions = extractConfigOptions(setup);
    this.session = {
      sessionId,
      configOptions,
      modelConfigId: extractModelConfigId(configOptions),
    };
    await this.applyModelSelection();
    const modeApplied = await this.applyMode();
    if (!modeApplied) {
      this.options.onChunk?.({
        type: "status",
        title: "Cursor mode",
        value: `Cursor did not expose a ${this.options.mode} mode selector; using prompt guidance instead.`,
        metadata: { provider: PROVIDER, cursorModeFallback: true },
      });
    }
    return this.session;
  }

  async discoverModels(): Promise<ProviderAvailableModel[]> {
    await this.start(MODEL_DISCOVERY_TIMEOUT_MS);
    const response = await this.connection.request("cursor/list_available_models", {}, MODEL_DISCOVERY_TIMEOUT_MS);
    return parseCursorAvailableModelsResponse(response);
  }

  async prompt(prompt: string): Promise<{
    summary: string;
    usage: RunTokenUsage;
    result: unknown;
  }> {
    const session = this.requireSession();
    const modeApplied = await this.applyMode();
    const result = await this.connection.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: buildPromptParts(prompt, this.options.attachments, modeApplied ? undefined : modeFallbackInstruction(this.options.mode)),
    }, 0);
    this.mergeUsage(normalizeCursorTokenUsage(result));
    return {
      summary: this.assistantText.trim(),
      usage: this.usage,
      result,
    };
  }

  async cancel(): Promise<void> {
    if (!this.session) {
      return;
    }
    await this.connection.request("session/cancel", { sessionId: this.session.sessionId }).catch(() => undefined);
  }

  close(): void {
    this.connection.close();
  }

  get providerSessionRuntime(): {
    cwd: string;
    modelId: string;
    runtimeMode: RunMode;
    resumeCursor: Record<string, unknown>;
    runtimePayload: Record<string, unknown>;
  } {
    const session = this.requireSession();
    return {
      cwd: this.options.cwd,
      modelId: this.options.modelId,
      runtimeMode: this.options.mode,
      resumeCursor: {
        schemaVersion: CURSOR_RESUME_SCHEMA_VERSION,
        sessionId: session.sessionId,
      },
      runtimePayload: {
        sessionId: session.sessionId,
      },
    };
  }

  private registerHandlers(): void {
    this.connection.handleNotification("session/update", (params) => this.handleSessionUpdate(params));
    this.connection.handleNotification("cursor/update_todos", (params) => this.handleCursorTodos(params));
    this.connection.handleRequest("cursor/create_plan", (params) => this.handleCursorCreatePlan(params));
    this.connection.handleRequest("cursor/ask_question", (params) => this.handleCursorAskQuestion(params));
    this.connection.handleRequest("session/request_permission", (params) => this.handlePermissionRequest(params));
  }

  private requireSession(): CursorAcpStartedSession {
    if (!this.session) {
      throw new Error("Cursor Agent ACP session is not started.");
    }
    return this.session;
  }

  private async applyModelSelection(): Promise<void> {
    const session = this.requireSession();
    const baseModelId = resolveCursorAcpBaseModelId(this.options.modelId);
    const configId = session.modelConfigId ?? "model";
    try {
      const response = await this.connection.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId,
        value: baseModelId,
      });
      const nextOptions = responseConfigOptions(response);
      if (nextOptions.length > 0) {
        session.configOptions = nextOptions;
        session.modelConfigId = extractModelConfigId(nextOptions) ?? session.modelConfigId;
      }
    } catch {
      await this.connection.request("session/set_model", {
        sessionId: session.sessionId,
        modelId: baseModelId,
      }).catch(() => undefined);
    }

    const liveConfigOptions = session.configOptions.length > 0 ? session.configOptions : cursorConfigOptionsFromModelConfig(this.options.modelConfig);
    for (const update of resolveCursorAcpConfigUpdates(liveConfigOptions, this.options.providerOptions)) {
      await this.connection.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId: update.configId,
        ...(typeof update.value === "boolean" ? { type: "boolean" } : {}),
        value: update.value,
      }).catch(() => undefined);
    }

    const maxTokens =
      asFiniteNumber(this.options.modelConfig?.[CURSOR_MODEL_MAX_TOKENS_KEY]) ??
      deriveCursorMaxTokensFromConfigOptions(liveConfigOptions);
    if (maxTokens) {
      this.mergeUsage({ inputTokens: 0, outputTokens: 0, maxTokens });
    }
  }

  private async applyMode(): Promise<boolean> {
    const session = this.requireSession();
    const modeOption = findConfigOption(session.configOptions, isModeConfigOption);
    const selected = selectConfigOptionValue(modeOption, modeCandidatesForRunMode(this.options.mode));
    if (!selected) {
      return false;
    }
    try {
      const response = await this.connection.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId: configOptionId(modeOption ?? {}),
        value: selected,
      });
      const nextOptions = responseConfigOptions(response);
      if (nextOptions.length > 0) {
        session.configOptions = nextOptions;
      }
      return true;
    } catch {
      return false;
    }
  }

  private handleSessionUpdate(params: unknown): void {
    this.mergeUsage(normalizeCursorTokenUsage(params));

    const text = textFromSessionUpdate(params);
    if (text) {
      this.assistantText += text;
      this.options.onAssistantText?.(text);
      this.options.onChunk?.({
        type: "message",
        title: "Cursor output",
        value: this.assistantText,
        metadata: {
          provider: PROVIDER,
          streamId: "cursor-assistant",
          replace: true,
          ...(this.usage.inputTokens > 0 || this.usage.outputTokens > 0 || this.usage.maxTokens ? { usageTotals: this.usage } : {}),
        },
      });
      return;
    }

    const planProgress = parseSessionPlanUpdate(params);
    if (planProgress) {
      this.options.onChunk?.(this.withUsage(buildCursorPlanProgressChunk(planProgress, params)));
      return;
    }

    const tool = parseCursorToolState(params);
    if (tool) {
      const merged = mergeCursorToolState(this.toolStates.get(tool.id), tool);
      this.toolStates.set(tool.id, merged);
      this.options.onChunk?.(this.withUsage(cursorToolChunkForState(merged)));
    }
  }

  private handleCursorTodos(params: unknown): void {
    this.mergeUsage(normalizeCursorTokenUsage(params));
    const progress = extractCursorTodosAsPlanProgress(params);
    if (progress) {
      this.options.onChunk?.(this.withUsage(buildCursorPlanProgressChunk(progress, params)));
    }
  }

  private handleCursorCreatePlan(params: unknown): Record<string, unknown> {
    this.mergeUsage(normalizeCursorTokenUsage(params));
    const chunk = buildCursorPlanUpdatedChunk(params);
    if (chunk) {
      this.options.onChunk?.(this.withUsage(chunk));
    }
    return { accepted: true };
  }

  private async handleCursorAskQuestion(params: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(params)) {
      return { answers: {} };
    }
    const parsedQuestions = (asArray(params.questions) ?? []).flatMap((question) => {
      const parsed = questionFromCursor(question);
      return parsed ? [parsed] : [];
    });
    const questions = parsedQuestions.map((parsed) => parsed.question);
    if (questions.length === 0 || !this.options.requestUserInput) {
      return { answers: {} };
    }
    const answerMapsByQuestionId = Object.fromEntries(
      parsedQuestions.map((parsed) => [parsed.question.id, parsed.answersByLabel]),
    );
    const requestId = asString(params.toolCallId)?.trim() || randomUUID();
    const answers = await this.options.requestUserInput({
      requestId,
      title: asString(params.title)?.trim() || "Cursor question",
      content: questions.map((question) => question.question).join("\n"),
      questions,
      metadata: {
        provider: PROVIDER,
        source: "cursor-acp",
        rawRequest: sanitizeMetadataValue(params),
      },
    });
    return { answers: mapCursorUserInputAnswers(answers, answerMapsByQuestionId) };
  }

  private async handlePermissionRequest(params: unknown): Promise<Record<string, unknown>> {
    const allowOnce = selectAllowOnceOption(params) ?? "allow-once";
    const allowAlways = selectAllowAlwaysOption(params) ?? "allow-always";
    const reject = selectRejectOption(params) ?? "reject-once";
    const tool = getPermissionTool(params);
    const kind = normalizeToken(tool?.kind);

    if (this.options.yoloMode) {
      return permissionResponse(allowAlways ?? allowOnce);
    }
    if (kind === "read" || kind === "fetch" || kind === "search") {
      return permissionResponse(allowOnce ?? allowAlways);
    }
    if (kind === "edit" || kind === "delete" || kind === "move") {
      return permissionResponse(this.options.mode === "code" ? allowOnce ?? allowAlways : reject);
    }
    if (kind === "execute") {
      const command = tool?.command;
      if (!command || !this.options.requestShellApproval) {
        return permissionResponse(reject);
      }
      const decision = await this.options.requestShellApproval(command);
      if (decision === "allow-always" || decision === "allow-for-run") {
        return permissionResponse(allowAlways ?? allowOnce);
      }
      if (decision === "allow-once") {
        return permissionResponse(allowOnce ?? allowAlways);
      }
      return permissionResponse(reject);
    }
    return permissionResponse(this.options.mode === "code" ? allowOnce ?? allowAlways : reject);
  }

  private mergeUsage(update: RunTokenUsage | null): void {
    if (!update) {
      return;
    }
    this.usage = addUsage(this.usage, update);
    this.options.onUsage?.(this.usage);
  }

  private withUsage(chunk: HarnessRunChunk): HarnessRunChunk {
    if (this.usage.inputTokens === 0 && this.usage.outputTokens === 0 && this.usage.maxTokens === undefined) {
      return chunk;
    }
    return {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        usageTotals: this.usage,
      },
    };
  }
}

export const parseCursorAvailableModelsResponse = (response: unknown): ProviderAvailableModel[] => {
  if (!isRecord(response) || !Array.isArray(response.models)) {
    return [];
  }
  const seen = new Set<string>();
  const models: ProviderAvailableModel[] = [];
  for (const raw of response.models) {
    if (!isRecord(raw)) {
      continue;
    }
    const modelId = asString(raw.value)?.trim() ?? asString(raw.model)?.trim() ?? asString(raw.id)?.trim();
    if (!modelId || seen.has(modelId.toLowerCase())) {
      continue;
    }
    seen.add(modelId.toLowerCase());
    const displayName = asString(raw.name)?.trim() ?? asString(raw.displayName)?.trim() ?? modelId;
    const configOptions = Array.isArray(raw.configOptions) ? raw.configOptions.filter(isRecord) : [];
    models.push({
      modelId,
      displayName,
      source: "provider",
      config: buildCursorModelConfig(configOptions),
    });
  }
  return models;
};

export const listAvailableModelsWithCursorAgent = async (
  context: ProviderAvailableModelsContext,
): Promise<ProviderAvailableModel[]> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  const runtime = new CursorAcpRuntime({
    cwd: process.cwd(),
    binaryPath: getCursorAgentBinaryPath(context.config),
    apiEndpoint: getCursorAgentApiEndpoint(context.config),
    modelId: CURSOR_DEFAULT_MODEL,
    mode: "ask",
    signal: controller.signal,
  });
  try {
    return await runtime.discoverModels();
  } finally {
    clearTimeout(timeout);
    runtime.close();
  }
};

const getCursorFallbackModels = (): string[] =>
  getModelPresetsForProvider(PROVIDER, undefined).map((preset) => preset.modelId);

const runCursorAbout = (binaryPath: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } => {
  const launch = resolveCursorAgentProcessLaunch(binaryPath, args);
  const result = spawnSync(launch.command, launch.args, {
    encoding: "utf8",
    timeout: ABOUT_TIMEOUT_MS,
    windowsHide: true,
    shell: launch.shell,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
};

const combinedCommandOutput = (result: { stdout: string; stderr: string }): string =>
  [result.stdout, result.stderr].join("\n").trim();

const isCursorAboutJsonFormatUnsupported = (result: { stdout: string; stderr: string }): boolean => {
  const lower = combinedCommandOutput(result).toLowerCase();
  return (
    lower.includes("unknown option '--format'") ||
    lower.includes("unexpected argument '--format'") ||
    lower.includes("unrecognized option '--format'") ||
    lower.includes("unknown argument '--format'") ||
    lower.includes("not in the list of known options")
  );
};

const isCursorDesktopCliOutput = (output: string): boolean => {
  const lower = output.toLowerCase();
  return lower.includes("usage: cursor.exe") || lower.includes("run with 'cursor -'") || lower.includes("subcommands");
};

export const parseCursorAboutOutput = (output: string): { authenticated: boolean | null; detail?: string } => {
  const trimmed = output.trim();
  if (!trimmed) {
    return { authenticated: null };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      if (Object.prototype.hasOwnProperty.call(parsed, "userEmail") && parsed.userEmail == null) {
        return { authenticated: false };
      }
      const email = asString(parsed.userEmail)?.trim() ?? asString(parsed.email)?.trim();
      if (email) {
        const lowerEmail = email.toLowerCase();
        if (lowerEmail === "not logged in" || lowerEmail.includes("login required") || lowerEmail.includes("authentication required")) {
          return { authenticated: false };
        }
        return { authenticated: true, detail: email };
      }
      if (parsed.authenticated === false || parsed.loggedIn === false) {
        return { authenticated: false };
      }
    }
  } catch {
    /* Fall back to plain text heuristics. */
  }
  const lower = trimmed.toLowerCase();
  if (lower.includes("not logged") || lower.includes("not authenticated") || lower.includes("login required")) {
    return { authenticated: false };
  }
  return { authenticated: null, detail: trimmed.split(/\r?\n/)[0] };
};

export async function assertCursorAgentAvailable(config?: Record<string, unknown>): Promise<void> {
  const explicitBinaryPath = readConfigString(config, PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY);
  const binaryCandidates = explicitBinaryPath
    ? [explicitBinaryPath]
    : Array.from(new Set([getDefaultCursorAgentBinaryPath(), "agent", "cursor-agent"]));
  let lastDetail = "";
  let lastBinaryPath = binaryCandidates[0] ?? "agent";

  for (const binaryPath of binaryCandidates) {
    lastBinaryPath = binaryPath;
    const first = runCursorAbout(binaryPath, ["about", "--format", "json"]);
    const second = first.status === 0 && !isCursorAboutJsonFormatUnsupported(first) ? first : runCursorAbout(binaryPath, ["about"]);
    lastDetail = combinedCommandOutput(second) || combinedCommandOutput(first);
    if (second.error) {
      lastDetail = second.error.message;
      continue;
    }
    if (second.status !== 0) {
      continue;
    }
    if (isCursorDesktopCliOutput(lastDetail)) {
      throw new Error(
        "Cursor desktop was found, but it is not the Cursor Agent CLI ACP server. Install or expose the Cursor Agent CLI as `agent` or `cursor-agent`, run `agent login`, then try again.",
      );
    }
    const auth = parseCursorAboutOutput(lastDetail);
    if (auth.authenticated === false) {
      throw new Error('Cursor Agent is not authenticated. Run "agent login" in your terminal and try again.');
    }
    return;
  }

  throw new Error(
    `Cursor Agent CLI was not found or is not available at "${lastBinaryPath}". Install Cursor CLI, expose \`agent\` or \`cursor-agent\` on PATH, run "agent login", and ensure "agent about" works.${lastDetail ? `\n\n${lastDetail}` : ""}`,
  );
}

export class CursorAgentProviderAdapter implements ProviderAdapter {
  readonly providerType = PROVIDER;

  listRecommendedModels(): string[] {
    return getCursorFallbackModels();
  }

  async listAvailableModels(context: ProviderAvailableModelsContext): Promise<ProviderAvailableModel[]> {
    return listAvailableModelsWithCursorAgent(context);
  }

  validateConfiguration(input: ProviderAccountInput): void {
    const binaryPath = input.config?.[PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY];
    if (typeof binaryPath === "string" && binaryPath.trim().length === 0) {
      throw new Error("Cursor binary path cannot be blank when provided.");
    }
    const apiEndpoint = input.config?.[PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY];
    if (typeof apiEndpoint === "string" && apiEndpoint.trim().length === 0) {
      throw new Error("Cursor API endpoint cannot be blank when provided.");
    }
  }
}

const sessionIdFromResumeCursor = (input: RunExecutionRequest): string | undefined => {
  const cursor = input.providerSessionRuntime?.resumeCursor;
  if (!isRecord(cursor)) {
    return undefined;
  }
  const schemaVersion = asFiniteNumber(cursor.schemaVersion);
  const sessionId = asString(cursor.sessionId)?.trim();
  return schemaVersion === CURSOR_RESUME_SCHEMA_VERSION && sessionId ? sessionId : undefined;
};

const cursorRuntimeFromRunInput = (
  input: RunExecutionRequest,
  onChunk: (chunk: HarnessRunChunk) => void,
  signal: AbortSignal,
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>,
  requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>,
): CursorAcpRuntime => {
  const devLogger = createCursorDevLogger({
    logDirPath: input.devLogging?.logDirPath,
    runId: input.runId,
    modelId: input.modelId || CURSOR_DEFAULT_MODEL,
    sessionType: input.isChat ? "chat" : "run",
  });
  return new CursorAcpRuntime({
    cwd: input.worktreePath,
    binaryPath: getCursorAgentBinaryPath(input.config),
    apiEndpoint: getCursorAgentApiEndpoint(input.config),
    devLogger: devLogger.enabled ? devLogger : undefined,
    resumeSessionId: sessionIdFromResumeCursor(input),
    modelId: input.modelId,
    mode: input.mode,
    yoloMode: input.yoloMode,
    modelConfig: input.modelConfig,
    providerOptions: input.providerOptions,
    attachments: input.attachments,
    requestShellApproval: input.yoloMode ? undefined : requestShellApproval,
    requestUserInput,
    onChunk,
    signal,
  });
};

export class CursorAgentHarnessAdapter implements HarnessAdapter {
  readonly harnessType = HARNESS;

  constructor(
    private readonly requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>,
    private readonly requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>,
  ) {}

  async run(
    input: RunExecutionRequest,
    _toolContext: HarnessToolContext,
    onChunk: (chunk: HarnessRunChunk) => void,
    signal: AbortSignal,
  ): Promise<{
    summary: string;
    responseId: string | null;
    usage: RunTokenUsage;
    providerSessionRuntime?: {
      cwd: string;
      modelId: string;
      runtimeMode: RunMode;
      resumeCursor: Record<string, unknown>;
      runtimePayload: Record<string, unknown>;
      status?: "starting" | "running" | "ready" | "stopped" | "error";
    };
  }> {
    const runtime = cursorRuntimeFromRunInput(input, onChunk, signal, this.requestShellApproval, this.requestUserInput);
    try {
      const started = await runtime.start();
      const providerSessionRuntime = runtime.providerSessionRuntime;
      onChunk({
        type: "status",
        title: "Cursor session started",
        value: `Cursor ACP session ${started.sessionId} is ready.`,
        metadata: {
          provider: PROVIDER,
          providerSessionRuntime: {
            ...providerSessionRuntime,
            status: "running",
          },
        },
      });
      const result = await runtime.prompt(input.prompt);
      return {
        summary: result.summary,
        responseId: started.sessionId,
        usage: result.usage,
        providerSessionRuntime: {
          ...providerSessionRuntime,
          status: "ready",
        },
      };
    } finally {
      runtime.close();
    }
  }
}

type GenerateAskTextWithCursorAgentInput = {
  cwd: string;
  prompt: string;
  modelId: string;
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

export async function generateAskTextResultWithCursorAgent(input: GenerateAskTextWithCursorAgentInput): Promise<{
  text: string;
  usage: RunTokenUsage;
}> {
  const harness = new CursorAgentHarnessAdapter();
  const result = await harness.run(
    {
      runId: input.devLogging?.runId ?? "ask-text",
      worktreePath: input.cwd,
      mode: "ask",
      prompt: input.prompt,
      providerType: PROVIDER,
      modelId: input.modelId || CURSOR_DEFAULT_MODEL,
      apiKey: "",
      config: input.config,
      modelConfig: input.modelConfig,
      providerOptions: input.providerOptions,
      isChat: true,
      devLogging: input.devLogging ? { logDirPath: input.devLogging.logDirPath } : undefined,
    },
    {
      tools: [],
      executeTool: async () => {
        throw new Error("Cursor ask text has no BuildWarden tools.");
      },
    },
    () => undefined,
    input.signal ?? new AbortController().signal,
  );
  return {
    text: result.summary.trim(),
    usage: result.usage,
  };
}

export async function generateAskTextWithCursorAgent(input: GenerateAskTextWithCursorAgentInput): Promise<string> {
  return (await generateAskTextResultWithCursorAgent(input)).text;
}

export async function suggestCommitMessageWithCursorAgent(input: {
  cwd: string;
  diffPrompt: string;
  modelId: string;
  config?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  providerOptions?: {
    reasoningEffort?: string;
  };
  signal?: AbortSignal;
}): Promise<string> {
  return generateAskTextWithCursorAgent({
    cwd: input.cwd,
    prompt: input.diffPrompt,
    modelId: input.modelId || CURSOR_DEFAULT_MODEL,
    config: input.config,
    modelConfig: input.modelConfig,
    providerOptions: input.providerOptions,
    signal: input.signal,
  });
}
