import { Buffer } from "node:buffer";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  createOpenAI,
  type OpenAIProvider,
  type OpenAIProviderSettings,
  type OpenaiResponsesSourceDocumentProviderMetadata,
  type OpenaiResponsesTextProviderMetadata,
} from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { generateText, jsonSchema, stepCountIs, streamText, tool, type GeneratedFile, type LanguageModel, type ToolSet } from "ai";
import { ProxyAgent } from "undici";
import type {
  ChatAttachmentPayload,
  HarnessAdapter,
  HarnessRunChunk,
  HarnessToolContext,
  NetworkProxyRuntimeConfig,
  ProviderAccountInput,
  ProviderAdapter,
  ProviderAvailableModel,
  ProviderAvailableModelsContext,
  RunExecutionRequest,
  RunTokenUsage,
  UnifiedProviderFamily,
} from "@buildwarden/shared";
import {
  AI_SDK_RECOMMENDED_MODEL_IDS,
  CHAT_ATTACHMENT_LIMITS,
  MODEL_CONFIG_ANTHROPIC_EFFORT_KEY,
  MODEL_CONFIG_OPENAI_REASONING_EFFORT_KEY,
  PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY,
  PROVIDER_CONFIG_DEFAULT_HEADERS_KEY,
  buildNetworkProxyUrl,
  estimateBase64ByteLength,
  formatRunPlanProgressContent,
  getModelPresetsForProvider,
  normalizeRunPlanProgressPayload,
  runShellActivityStreamId,
  shouldBypassNetworkProxyForUrl,
} from "@buildwarden/shared";
import pRetry, { AbortError } from "p-retry";
import { createDevLogger } from "./dev-logger";

const CHAT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Answer the user's questions directly and concisely. You do not have access to any tools or files.";

const CHAT_OPENAI_CODE_INTERPRETER_SYSTEM_PROMPT = [
  "You are a helpful AI assistant. Answer the user's questions directly and concisely.",
  "You have access to OpenAI Code Interpreter for sandboxed Python execution.",
  "When the user asks you to create a downloadable artifact such as a PDF, spreadsheet, data file, chart, or image, use Code Interpreter to create and save the file instead of saying you cannot attach files.",
  "After creating a file, briefly describe it and reference the saved file so the application can attach it.",
].join("\n");

const SYSTEM_PROMPT = [
  "You are BuildWarden, a desktop coding agent running inside a project workspace.",
  "You are operating on a local codebase and can inspect and modify files via provided tools.",
  "Use the tools whenever repository context is needed and apply concrete changes when the task requires implementation.",
  "Do not claim to have changed files unless you used the file tools successfully.",
  "All file-tool paths must be relative to the run workspace root.",
  "run_shell already starts in the run workspace root. Do not prefix commands with cd or chain commands with operators.",
  "On Windows, commands run in PowerShell. Prefer Windows-safe command forms.",
  "Narrate progress briefly and end with a concise summary.",
].join("\n");

const MODE_INSTRUCTIONS = {
  code: "You are in code mode. Implement the requested changes directly when appropriate.",
  plan: "You are in plan mode. Do not modify files; inspect and produce a concrete implementation plan.",
  ask: "You are in ask mode. Do not modify files; inspect only as needed and answer directly.",
} as const;

const MODE_POLICIES = {
  code: { maxToolRounds: 64 },
  plan: { maxToolRounds: 12 },
  ask: { maxToolRounds: 8 },
} as const;

const TEXTISH_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
] as const;

const CODE_LIKE_EXT =
  /\.(txt|md|mdx|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|xml|html|htm|css|scss|less|rs|go|py|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|sql|toml|ini|env|log|vue|svelte)$/i;

const GENERATED_FILE_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/json": "json",
  "application/msword": "doc",
  "application/rtf": "rtf",
  "application/gzip": "gz",
  "application/java-archive": "jar",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.apple.keynote": "key",
  "application/vnd.apple.numbers": "numbers",
  "application/vnd.apple.pages": "pages",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.rar": "rar",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/x-7z-compressed": "7z",
  "application/x-bzip2": "bz2",
  "application/x-tar": "tar",
  "application/x-xz": "xz",
  "application/zip": "zip",
  "audio/aac": "aac",
  "audio/aiff": "aiff",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "weba",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/tab-separated-values": "tsv",
  "video/mp4": "mp4",
  "video/mpeg": "mpg",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-m4v": "m4v",
  "video/x-matroska": "mkv",
  "video/x-ms-wmv": "wmv",
};

const FILE_EXTENSION_MEDIA_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(GENERATED_FILE_EXTENSIONS).map(([mediaType, extension]) => [extension, mediaType]),
);

type OpenAiContainerFileReference = {
  containerId: string;
  fileId: string;
  filename?: string;
  mediaType?: string;
};

const generatedFileStem = (mediaType: string): string => {
  const mime = mediaType.toLowerCase();
  if (mime.startsWith("image/")) return "generated-image";
  if (mime === "application/pdf") return "generated-document";
  if (mime.startsWith("audio/")) return "generated-audio";
  if (mime.startsWith("video/")) return "generated-video";
  if (mime.startsWith("text/")) return "generated-text";
  return "generated-file";
};

const generatedFileName = (mediaType: string, index: number): string => {
  const normalized = mediaType.toLowerCase();
  const extension = GENERATED_FILE_EXTENSIONS[normalized] ?? normalized.split("/")[1]?.split("+").at(-1) ?? "bin";
  return `${generatedFileStem(normalized)}-${String(index)}.${extension.replace(/[^a-z0-9]/gi, "") || "bin"}`;
};

const mediaTypeFromFileName = (fileName: string): string | undefined => {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  return FILE_EXTENSION_MEDIA_TYPES[extension];
};

const sanitizeGeneratedFileName = (fileName: string): string => {
  const normalized = fileName.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  return normalized || "generated-file.bin";
};

const generatedFileKey = (attachment: ChatAttachmentPayload): string =>
  `${attachment.mimeType}:${attachment.dataBase64.slice(0, 96)}:${String(estimateBase64ByteLength(attachment.dataBase64))}`;

const generatedFileToAttachment = (file: GeneratedFile, index: number): ChatAttachmentPayload | null => {
  const mimeType = file.mediaType.trim() || "application/octet-stream";
  const dataBase64 = file.base64.trim();
  if (!dataBase64) {
    return null;
  }
  return {
    fileName: generatedFileName(mimeType, index),
    mimeType,
    dataBase64,
  };
};

const describeToolCall = (name: string, args: Record<string, unknown>) => {
  const interestingValue = args.path ?? args.command ?? args.query ?? JSON.stringify(args);
  return `${name}: ${String(interestingValue)}`;
};

const finiteNumber = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

const usageProcessedTotal = (usage: RunTokenUsage): number =>
  usage.totalTokens ?? usage.totalProcessedTokens ?? usage.inputTokens + usage.outputTokens;

const addUsage = (left: RunTokenUsage, right: RunTokenUsage): RunTokenUsage => {
  const totalTokens = usageProcessedTotal(left) + usageProcessedTotal(right);
  const reasoningTokens = (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0);
  const cachedInputTokens = (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0);
  const cacheCreationInputTokens = (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    ...(totalTokens > 0 ? { totalTokens, totalProcessedTokens: totalTokens } : {}),
    ...(right.lastInputTokens !== undefined ? { lastInputTokens: right.lastInputTokens } : {}),
    ...(right.lastCachedInputTokens !== undefined ? { lastCachedInputTokens: right.lastCachedInputTokens } : {}),
    ...(right.lastOutputTokens !== undefined ? { lastOutputTokens: right.lastOutputTokens } : {}),
    ...(right.lastReasoningTokens !== undefined ? { lastReasoningTokens: right.lastReasoningTokens } : {}),
  };
};

export const normalizeAiSdkTokenUsage = (usage: unknown): RunTokenUsage => {
  const raw = (usage ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    outputTokenDetails?: {
      textTokens?: number;
      reasoningTokens?: number;
    };
  };
  const inputTokens = finiteNumber(raw.inputTokens);
  const outputTokens = finiteNumber(raw.outputTokens);
  const result: RunTokenUsage = {
    inputTokens,
    outputTokens,
  };
  const reasoningTokens = finiteNumber(raw.outputTokenDetails?.reasoningTokens ?? raw.reasoningTokens);
  const cachedInputTokens = finiteNumber(raw.inputTokenDetails?.cacheReadTokens ?? raw.cachedInputTokens);
  const cacheCreationInputTokens = finiteNumber(raw.inputTokenDetails?.cacheWriteTokens);
  const totalTokens = finiteNumber(raw.totalTokens ?? inputTokens + outputTokens);
  if (Number.isFinite(reasoningTokens) && reasoningTokens > 0) {
    result.reasoningTokens = reasoningTokens;
    result.lastReasoningTokens = reasoningTokens;
  }
  if (Number.isFinite(cachedInputTokens) && cachedInputTokens > 0) {
    result.cachedInputTokens = cachedInputTokens;
    result.lastCachedInputTokens = cachedInputTokens;
  }
  if (Number.isFinite(cacheCreationInputTokens) && cacheCreationInputTokens > 0) {
    result.cacheCreationInputTokens = cacheCreationInputTokens;
  }
  if (Number.isFinite(totalTokens) && totalTokens > 0) {
    result.totalTokens = totalTokens;
    result.totalProcessedTokens = totalTokens;
  }
  if (inputTokens > 0) {
    result.lastInputTokens = inputTokens;
  }
  if (outputTokens > 0) {
    result.lastOutputTokens = outputTokens;
  }
  return result;
};

const extractErrorText = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error) {
    const maybeMessage = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
    const maybeError = "error" in error ? String((error as { error?: unknown }).error ?? "") : "";
    return `${maybeMessage} ${maybeError}`.trim();
  }
  return String(error);
};

const shouldRetryProviderRequest = (error: unknown): boolean => {
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status?: unknown }).status ?? 0)
      : 0;
  if (status === 429 || status === 408 || status >= 500) {
    return true;
  }
  const text = extractErrorText(error).toLowerCase();
  return ["rate limit", "too many requests", "temporarily unavailable", "overloaded", "network", "timed out"].some((pattern) =>
    text.includes(pattern),
  );
};

const withProviderRetry = async <T>(
  operationName: string,
  signal: AbortSignal,
  onChunk: (chunk: HarnessRunChunk) => void,
  operation: () => Promise<T> | T,
): Promise<T> =>
  pRetry(
    async () => {
      if (signal.aborted) {
        throw new AbortError("Aborted");
      }
      try {
        return await operation();
      } catch (error) {
        if (signal.aborted || !shouldRetryProviderRequest(error)) {
          throw new AbortError(extractErrorText(error) || "Aborted");
        }
        throw error;
      }
    },
    {
      retries: 4,
      factor: 2,
      minTimeout: 1_000,
      maxTimeout: 15_000,
      randomize: true,
      signal,
      onFailedAttempt: (error) => {
        if (error.retriesLeft <= 0) {
          return;
        }
        onChunk({
          type: "status",
          value: `Transient provider issue during ${operationName}. Retrying...`,
        });
      },
    },
  );

const isTextishAttachment = (mime: string, fileName: string): boolean => {
  const loweredMime = mime.toLowerCase();
  for (const prefix of TEXTISH_MIME_PREFIXES) {
    if (loweredMime === prefix || loweredMime.startsWith(prefix)) {
      return true;
    }
  }
  if (loweredMime === "application/octet-stream" || loweredMime === "") {
    return CODE_LIKE_EXT.test(fileName);
  }
  return false;
};

const decodeAttachmentText = (attachment: ChatAttachmentPayload): string => {
  try {
    return Buffer.from(attachment.dataBase64, "base64").toString("utf8");
  } catch {
    return "[Could not decode file as UTF-8]";
  }
};

const buildAttachmentUserContent = (
  promptText: string,
  attachments: ChatAttachmentPayload[] | undefined,
): Array<Record<string, unknown>> | string => {
  const textParts: string[] = [];
  const trimmedPrompt = promptText.trim();
  if (trimmedPrompt) {
    textParts.push(trimmedPrompt);
  }

  const parts: Array<Record<string, unknown>> = [];

  for (const attachment of attachments ?? []) {
    const mime = (attachment.mimeType || "application/octet-stream").toLowerCase();
    const fileName = attachment.fileName.trim() || "attachment";

    if (mime.startsWith("image/")) {
      parts.push({
        type: "image",
        image: `data:${mime};base64,${attachment.dataBase64}`,
        mediaType: mime,
      });
      continue;
    }

    if (mime === "application/pdf") {
      parts.push({
        type: "file",
        data: `data:${mime};base64,${attachment.dataBase64}`,
        mediaType: mime,
        filename: fileName,
      });
      continue;
    }

    if (isTextishAttachment(mime, fileName)) {
      textParts.push(`\n\n--- Attached file: ${fileName} ---\n${decodeAttachmentText(attachment)}`);
      continue;
    }

    textParts.push(`\n\n[Attached binary file: ${fileName}, mime ${mime}]`);
  }

  const combined = textParts.join("").trim() || (attachments?.length ? "The user attached files. Use them to answer the request." : "");
  if (parts.length === 0) {
    return combined;
  }
  if (combined) {
    parts.unshift({ type: "text", text: combined });
  }
  return parts;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const getProviderFamily = (config: Record<string, unknown> | undefined): UnifiedProviderFamily => {
  const raw = config?.[PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY];
  if (
    raw === "openai" ||
    raw === "anthropic" ||
    raw === "google" ||
    raw === "xai" ||
    raw === "openai-compatible"
  ) {
    return raw;
  }
  return "openai";
};

const AI_SDK_MODELS_API_URL = "https://ai-gateway.vercel.sh/v1/models";

type ModelsApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

const aiSdkModelsApiItems = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }
  const models = asArray(value.models);
  if (models.length > 0) {
    return models;
  }
  const data = asArray(value.data);
  if (data.length > 0) {
    return data;
  }
  return asArray(value.items);
};

export const parseAiSdkModelsApiAvailableModels = (
  value: unknown,
  family: UnifiedProviderFamily,
): ProviderAvailableModel[] => {
  if (family !== "google") {
    return [];
  }

  return aiSdkModelsApiItems(value).flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const rawModelId = asTrimmedString(item.id);
    if (!rawModelId?.startsWith("google/")) {
      return [];
    }

    const modelType = asTrimmedString(item.modelType ?? item.type)?.toLowerCase();
    if (modelType && modelType !== "language") {
      return [];
    }

    const modelId = rawModelId.slice("google/".length).trim();
    if (!modelId) {
      return [];
    }

    return [
      {
        modelId,
        displayName: asTrimmedString(item.name) ?? asTrimmedString(item.displayName) ?? modelId,
        source: "provider" as const,
      },
    ];
  });
};

export const requestAiSdkModelsApiAvailableModels = async (
  family: UnifiedProviderFamily,
  fetchImpl: ModelsApiFetch = fetch,
): Promise<ProviderAvailableModel[]> => {
  const response = await fetchImpl(AI_SDK_MODELS_API_URL, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`AI SDK model catalog request failed (${String(response.status)} ${response.statusText}).`);
  }

  const models = parseAiSdkModelsApiAvailableModels(await response.json(), family);
  if (models.length === 0) {
    throw new Error(`AI SDK model catalog did not report any ${family} language models.`);
  }
  return models;
};

export const listAvailableModelsWithAiSdk = async (
  context: ProviderAvailableModelsContext,
): Promise<ProviderAvailableModel[]> => {
  const family = getProviderFamily(context.config);
  if (family === "google") {
    return requestAiSdkModelsApiAvailableModels(family);
  }

  return getModelPresetsForProvider(context.providerType, family).map((preset) => ({
    modelId: preset.modelId,
    displayName: preset.displayName,
    source: "curated" as const,
  }));
};

const getDefaultHeaders = (config: Record<string, unknown> | undefined): Record<string, string> | undefined => {
  const raw = config?.[PROVIDER_CONFIG_DEFAULT_HEADERS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) => (typeof value === "string" && value.trim() ? [[key, value]] : [])),
  );
};

const supportsOpenAiReasoningSummary = (modelId: string): boolean => {
  const normalized = modelId.trim().toLowerCase();
  return normalized.startsWith("gpt-5") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4");
};

const buildAiSdkProviderOptions = (
  family: UnifiedProviderFamily,
  modelId: string,
  requestProviderOptions: { reasoningEffort?: string; anthropicEffort?: string } | undefined,
  modelConfig: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!requestProviderOptions && !modelConfig) {
    return undefined;
  }

  if (family === "openai") {
    const reasoningEffort = typeof requestProviderOptions?.reasoningEffort === "string" && requestProviderOptions.reasoningEffort.trim()
      ? requestProviderOptions.reasoningEffort.trim()
      : typeof modelConfig?.[MODEL_CONFIG_OPENAI_REASONING_EFFORT_KEY] === "string"
        ? String(modelConfig[MODEL_CONFIG_OPENAI_REASONING_EFFORT_KEY]).trim()
      : "";
    if (reasoningEffort) {
      return {
        openai: {
          reasoningEffort,
          ...(supportsOpenAiReasoningSummary(modelId) ? { reasoningSummary: "auto" } : {}),
        },
      };
    }
    if (supportsOpenAiReasoningSummary(modelId)) {
      return {
        openai: {
          reasoningSummary: "auto",
        },
      };
    }
    return undefined;
  }

  if (family === "anthropic") {
    const effort = typeof requestProviderOptions?.anthropicEffort === "string" && requestProviderOptions.anthropicEffort.trim()
      ? requestProviderOptions.anthropicEffort.trim()
      : typeof modelConfig?.[MODEL_CONFIG_ANTHROPIC_EFFORT_KEY] === "string"
        ? String(modelConfig[MODEL_CONFIG_ANTHROPIC_EFFORT_KEY]).trim()
      : "";
    if (effort) {
      return {
        anthropic: {
          effort,
        },
      };
    }
  }

  return undefined;
};

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const createProxyAwareFetch = (networkProxy: NetworkProxyRuntimeConfig | undefined): typeof fetch | undefined => {
  if (!networkProxy) {
    return undefined;
  }
  const proxyAgent = new ProxyAgent(buildNetworkProxyUrl(networkProxy));
  return (input, init) => {
    const url = getRequestUrl(input);
    if (shouldBypassNetworkProxyForUrl(url, networkProxy)) {
      return fetch(input, init);
    }
    return fetch(
      input,
      {
        ...(init ?? {}),
        dispatcher: proxyAgent,
      } as RequestInit & { dispatcher: ProxyAgent },
    );
  };
};

const createConfiguredOpenAiProvider = (
  input: RunExecutionRequest,
  devLogger?: { createLoggedFetch: (baseFetch?: typeof fetch) => typeof fetch },
): OpenAIProvider => {
  const baseURL = input.apiBaseUrl?.trim() || undefined;
  const headers = getDefaultHeaders(input.config);
  const customFetch = createProxyAwareFetch(input.networkProxy);
  const loggedFetch = devLogger?.createLoggedFetch(customFetch ?? fetch);
  const commonOptions = {
    apiKey: input.apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(headers ? { headers } : {}),
    ...(loggedFetch ? { fetch: loggedFetch } : customFetch ? { fetch: customFetch } : {}),
  } satisfies OpenAIProviderSettings;

  return createOpenAI(commonOptions);
};

const createLanguageModel = (input: RunExecutionRequest, devLogger?: { createLoggedFetch: (baseFetch?: typeof fetch) => typeof fetch }): LanguageModel => {
  const family = getProviderFamily(input.config);
  const baseURL = input.apiBaseUrl?.trim() || undefined;
  const headers = getDefaultHeaders(input.config);
  const customFetch = createProxyAwareFetch(input.networkProxy);
  const loggedFetch = devLogger?.createLoggedFetch(customFetch ?? fetch);

  if (family === "openai-compatible") {
    if (!baseURL) {
      throw new Error("AI SDK providers configured as OpenAI-compatible require a base URL.");
    }
    const provider = createOpenAICompatible({
      name: "buildwarden-compatible",
      baseURL: baseURL,
      apiKey: input.apiKey || "none",
      headers,
      ...(loggedFetch ? { fetch: loggedFetch } : customFetch ? { fetch: customFetch } : {}),
    });
    return provider(input.modelId);
  }

  if (!input.apiKey.trim()) {
    throw new Error("An API key is required for this AI SDK provider.");
  }

  const commonOptions = {
    apiKey: input.apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(headers ? { headers } : {}),
    ...(loggedFetch ? { fetch: loggedFetch } : customFetch ? { fetch: customFetch } : {}),
  } as Record<string, unknown>;

  if (family === "openai") {
    return createConfiguredOpenAiProvider(input, devLogger).responses(input.modelId);
  }

  const factories = {
    anthropic: createAnthropic,
    google: createGoogleGenerativeAI,
    xai: createXai,
  } satisfies Record<Exclude<UnifiedProviderFamily, "openai" | "openai-compatible">, (options?: Record<string, unknown>) => (modelId: string) => LanguageModel>;

  return factories[family](commonOptions)(input.modelId);
};

export const buildAiSdkPlanProgressChunk = (args: unknown): HarnessRunChunk | null => {
  const parsedArgs = isRecord(args) ? args : {};
  const progress = normalizeRunPlanProgressPayload(
    {
      ...parsedArgs,
      source: "ai-sdk",
    },
    "ai-sdk",
  );
  if (!progress) {
    return null;
  }
  return {
    type: "plan-progress",
    title: "Plan progress",
    value: formatRunPlanProgressContent(progress),
    metadata: {
      provider: "ai-sdk",
      planProgress: progress,
      streamId: "ai-sdk-plan-progress",
      replace: true,
    },
  };
};

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const rememberOpenAiContainerFileReference = (
  references: Map<string, OpenAiContainerFileReference>,
  reference: OpenAiContainerFileReference,
): void => {
  if (!reference.containerId || !reference.fileId) {
    return;
  }
  references.set(`${reference.containerId}:${reference.fileId}`, reference);
};

const collectOpenAiContainerFileReferences = (
  part: Record<string, unknown>,
  references: Map<string, OpenAiContainerFileReference>,
): void => {
  const providerMetadata = isRecord(part.providerMetadata) ? part.providerMetadata : undefined;
  const openaiMetadata = providerMetadata && isRecord(providerMetadata.openai) ? providerMetadata.openai : undefined;
  if (!openaiMetadata) {
    return;
  }

  if (part.type === "text") {
    const metadata = providerMetadata as OpenaiResponsesTextProviderMetadata;
    for (const annotation of metadata.openai.annotations ?? []) {
      if (annotation.type !== "container_file_citation") {
        continue;
      }
      const raw = annotation as unknown as Record<string, unknown>;
      rememberOpenAiContainerFileReference(references, {
        containerId: stringField(raw, "container_id") ?? "",
        fileId: stringField(raw, "file_id") ?? "",
        filename: stringField(raw, "filename"),
      });
    }
    return;
  }

  if (part.type === "source" && part.sourceType === "document") {
    const metadata = providerMetadata as OpenaiResponsesSourceDocumentProviderMetadata;
    const annotation = metadata.openai;
    if (annotation.type !== "container_file_citation") {
      return;
    }
    rememberOpenAiContainerFileReference(references, {
      containerId: annotation.containerId,
      fileId: annotation.fileId,
      filename: typeof part.filename === "string" ? part.filename : typeof part.title === "string" ? part.title : undefined,
      mediaType: typeof part.mediaType === "string" ? part.mediaType : undefined,
    });
  }
};

const contentTypeMediaType = (contentType: string | null): string | undefined => {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType === "application/binary" || mediaType === "application/octet-stream") {
    return undefined;
  }
  return mediaType || undefined;
};

const isTextishMediaType = (mediaType: string): boolean =>
  TEXTISH_MIME_PREFIXES.some((prefix) => mediaType.startsWith(prefix));

const chooseGeneratedFileMediaType = (
  responseMediaType: string | undefined,
  referenceMediaType: string | undefined,
  fileNameMediaType: string | undefined,
): string => {
  const normalizedReferenceMediaType = referenceMediaType?.trim().toLowerCase() || undefined;
  const extensionMediaType = fileNameMediaType?.trim().toLowerCase() || undefined;
  const metadataMediaType = extensionMediaType ?? normalizedReferenceMediaType;

  if (
    responseMediaType &&
    metadataMediaType &&
    isTextishMediaType(responseMediaType) &&
    !isTextishMediaType(metadataMediaType)
  ) {
    return metadataMediaType;
  }

  return responseMediaType ?? normalizedReferenceMediaType ?? extensionMediaType ?? "application/octet-stream";
};

const downloadOpenAiContainerFile = async (
  input: RunExecutionRequest,
  reference: OpenAiContainerFileReference,
  index: number,
  devLogger?: { createLoggedFetch: (baseFetch?: typeof fetch) => typeof fetch },
): Promise<ChatAttachmentPayload> => {
  const baseURL = (input.apiBaseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const headers = getDefaultHeaders(input.config);
  const customFetch = createProxyAwareFetch(input.networkProxy);
  const loggedFetch = devLogger?.createLoggedFetch(customFetch ?? fetch);
  const requestFetch = loggedFetch ?? customFetch ?? fetch;
  const url = `${baseURL}/containers/${encodeURIComponent(reference.containerId)}/files/${encodeURIComponent(reference.fileId)}/content`;
  const response = await requestFetch(url, {
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      ...(headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`OpenAI container file download failed (${String(response.status)} ${response.statusText}).`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const fallbackMediaType = reference.filename ? mediaTypeFromFileName(reference.filename) : undefined;
  const mimeType = chooseGeneratedFileMediaType(
    contentTypeMediaType(response.headers.get("content-type")),
    reference.mediaType,
    fallbackMediaType,
  );
  const fileName = sanitizeGeneratedFileName(reference.filename ?? generatedFileName(mimeType, index));
  return {
    fileName,
    mimeType,
    dataBase64: bytes.toString("base64"),
  };
};

const buildRunMessages = (input: RunExecutionRequest): Array<Record<string, unknown>> => {
  const priorMessages = Array.isArray(input.priorMessages) ? [...input.priorMessages] : [];
  if (priorMessages.length > 0) {
    priorMessages.push({
      role: "user",
      content: buildAttachmentUserContent(input.prompt, input.attachments),
    });
    return priorMessages;
  }

  return [
    {
      role: "system",
      content: [
        SYSTEM_PROMPT,
        ...(input.mode === "ask"
          ? []
          : ["When working from a multi-step plan, use update_plan to keep a compact checklist current before and after meaningful implementation steps."]),
        "",
        MODE_INSTRUCTIONS[input.mode],
      ].join("\n"),
    },
    {
      role: "user",
      content: buildAttachmentUserContent(
        [
          `Mode: ${input.mode}`,
          "Workspace: .",
          "",
          `Task: ${input.prompt}`,
          "",
          input.repoContext ? `Workspace context:\n${input.repoContext}` : "Workspace context is unavailable. Use tools to inspect the project files.",
        ].join("\n"),
        input.attachments,
      ),
    },
  ];
};

/**
 * AI SDK 7 rejects `role: "system"` entries inside `messages` — the system
 * prompt moves to the `instructions` option. Persisted chat histories and
 * resume checkpoints from earlier versions still contain system messages, so
 * every prompt array is split here before it reaches generateText/streamText.
 */
export const splitSystemMessagesIntoInstructions = (
  messages: ReadonlyArray<Record<string, unknown>>,
): { instructions?: string; messages: Array<Record<string, unknown>> } => {
  const instructionTexts: string[] = [];
  const rest: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content === "string" && message.content.trim()) {
        instructionTexts.push(message.content);
      }
      continue;
    }
    rest.push(message);
  }
  return {
    ...(instructionTexts.length > 0 ? { instructions: instructionTexts.join("\n\n") } : {}),
    messages: rest,
  };
};

type GenerateAskTextWithAiSdkInput = {
  modelId: string;
  apiKey: string;
  apiBaseUrl?: string | null;
  config?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  networkProxy?: NetworkProxyRuntimeConfig;
  providerOptions?: {
    reasoningEffort?: string;
    anthropicEffort?: string;
  };
  systemPrompt: string;
  prompt: string;
  signal?: AbortSignal;
  devLogging?: {
    logDirPath: string;
    runId?: string;
    sessionType?: "run" | "chat";
  };
};

export const generateAskTextResultWithAiSdk = async (input: GenerateAskTextWithAiSdkInput): Promise<{
  text: string;
  usage: RunTokenUsage;
}> => {
  const devLogger = createDevLogger({
    logDirPath: input.devLogging?.logDirPath,
    runId: input.devLogging?.runId ?? "ask-text",
    providerType: "ai-sdk",
    modelId: input.modelId,
    sessionType: input.devLogging?.sessionType ?? "run",
  });
  const model = createLanguageModel({
    runId: "commit-message",
    worktreePath: ".",
    mode: "ask",
    prompt: input.prompt,
    providerType: "ai-sdk",
    modelId: input.modelId,
    apiKey: input.apiKey,
    apiBaseUrl: input.apiBaseUrl,
    config: input.config,
    modelConfig: input.modelConfig,
    networkProxy: input.networkProxy,
  }, devLogger.enabled ? devLogger : undefined);
  const providerOptions = buildAiSdkProviderOptions(getProviderFamily(input.config), input.modelId, input.providerOptions, input.modelConfig);

  const result = await generateText({
    model,
    instructions: input.systemPrompt,
    messages: [
      {
        role: "user",
        content: input.prompt,
      },
    ] as never,
    ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
    abortSignal: input.signal,
  });
  return {
    text: result.text.trim(),
    usage: normalizeAiSdkTokenUsage(result.usage),
  };
};

export const generateAskTextWithAiSdk = async (input: GenerateAskTextWithAiSdkInput): Promise<string> =>
  (await generateAskTextResultWithAiSdk(input)).text;

export const suggestCommitMessageWithAiSdk = async (input: {
  modelId: string;
  apiKey: string;
  apiBaseUrl?: string | null;
  config?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  networkProxy?: NetworkProxyRuntimeConfig;
  providerOptions?: {
    reasoningEffort?: string;
    anthropicEffort?: string;
  };
  prompt: string;
  signal?: AbortSignal;
}): Promise<string> =>
  generateAskTextWithAiSdk({
    ...input,
    systemPrompt: "You write clear, conventional git commit messages from diffs. Output only the commit message, nothing else.",
  });

export class AiSdkProviderAdapter implements ProviderAdapter {
  readonly providerType = "ai-sdk" as const;

  listRecommendedModels(): string[] {
    return [...AI_SDK_RECOMMENDED_MODEL_IDS];
  }

  async listAvailableModels(context: ProviderAvailableModelsContext): Promise<ProviderAvailableModel[]> {
    return listAvailableModelsWithAiSdk(context);
  }

  validateConfiguration(input: ProviderAccountInput): void {
    const family = getProviderFamily(input.config);
    if (family === "openai-compatible") {
      if (!input.apiBaseUrl?.trim()) {
        throw new Error("A base URL is required for AI SDK providers configured as OpenAI-compatible.");
      }
      return;
    }

    if (!input.apiKey.trim()) {
      throw new Error("An API key is required for AI SDK providers.");
    }
  }
}

export class AiSdkHarnessAdapter implements HarnessAdapter {
  readonly harnessType = "ai-sdk" as const;

  async run(
    input: RunExecutionRequest,
    toolContext: HarnessToolContext,
    onChunk: (chunk: HarnessRunChunk) => void,
    signal: AbortSignal,
  ): Promise<{ summary: string; responseId: string | null; usage: RunTokenUsage }> {
    const isChat = input.isChat === true;
    const providerFamily = getProviderFamily(input.config);
    const devLogger = createDevLogger({
      logDirPath: input.devLogging?.logDirPath,
      runId: input.runId,
      providerType: input.providerType,
      modelId: input.modelId,
      sessionType: isChat ? "chat" : "run",
    });
    const model = createLanguageModel(input, devLogger.enabled ? devLogger : undefined);
    const providerOptions = buildAiSdkProviderOptions(providerFamily, input.modelId, input.providerOptions, input.modelConfig);
    const openAiChatTools =
      isChat && providerFamily === "openai"
        ? {
            code_interpreter: createConfiguredOpenAiProvider(input, devLogger.enabled ? devLogger : undefined).tools.codeInterpreter(),
          }
        : undefined;
    const checkpointMessages = Array.isArray(input.resumeCheckpoint?.messages) ? [...input.resumeCheckpoint.messages] : [];
    const startingMessages =
      checkpointMessages.length > 0
        ? checkpointMessages
        : isChat
          ? []
          : buildRunMessages(input);

    if (isChat) {
      startingMessages.push({
        role: "system",
        content: openAiChatTools ? CHAT_OPENAI_CODE_INTERPRETER_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT,
      });
      if (Array.isArray(input.priorMessages) && input.priorMessages.length > 0) {
        startingMessages.push(...input.priorMessages);
      }
      startingMessages.push({
        role: "user",
        content: buildAttachmentUserContent(input.prompt, input.attachments),
      });
    }

    if (!isChat) {
      onChunk({
        type: "status",
        value: `Starting ${input.mode} run in ${input.worktreePath}`,
      });
    } else {
      onChunk({
        type: "status",
        value: "Starting chat",
      });
    }

    const persistedMessages = [...startingMessages];
    let accumulatedUsage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };
    let completedToolRounds = 0;
    let successfulMutationToolCalls = 0;

    const runTools: ToolSet = Object.fromEntries(
      toolContext.tools.map((runTool) => [
        runTool.name,
        tool({
          description: runTool.description,
          inputSchema: jsonSchema(runTool.inputSchema),
          execute: async (args: unknown) => {
            const parsedArgs = typeof args === "object" && args && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
            const callId = crypto.randomUUID();
            onChunk({
              type: "tool-call",
              title: `Tool call: ${runTool.name}`,
              value: describeToolCall(runTool.name, parsedArgs),
              metadata: {
                toolName: runTool.name,
                arguments: parsedArgs,
                callId,
              },
            });

            const result = await toolContext.executeTool({
              id: callId,
              name: runTool.name,
              arguments: parsedArgs,
            });
            if (
              result.ok &&
              (runTool.name === "write_file" || runTool.name === "edit_file" || runTool.name === "delete_file")
            ) {
              successfulMutationToolCalls += 1;
            }

            onChunk({
              type: "tool-result",
              title: `Tool result: ${runTool.name}`,
              value: result.content,
              metadata: {
                toolName: runTool.name,
                callId,
                ok: result.ok,
                ...result.metadata,
                ...(runTool.name === "run_shell"
                  ? { streamId: runShellActivityStreamId(callId), replace: true }
                  : {}),
              },
            });

            return {
              ok: result.ok,
              content: result.content,
              metadata: result.metadata,
            };
          },
        }),
      ]),
    );

    if (!isChat && input.mode !== "ask") {
      runTools.update_plan = tool({
        description: "Update the visible implementation checklist. This only reports progress to BuildWarden; it does not read or write files.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            explanation: {
              type: ["string", "null"],
              description: "Optional short note explaining why the plan changed.",
            },
            steps: {
              type: "array",
              minItems: 1,
              maxItems: 24,
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  status: { type: "string", enum: ["pending", "inProgress", "in_progress", "completed"] },
                },
                required: ["title", "status"],
                additionalProperties: false,
              },
            },
          },
          required: ["steps"],
          additionalProperties: false,
        }),
        execute: async (args: unknown) => {
          const chunk = buildAiSdkPlanProgressChunk(args);
          const progress = normalizeRunPlanProgressPayload(chunk?.metadata?.planProgress, "ai-sdk");
          if (!chunk || !progress) {
            return {
              ok: false,
              content: "Plan progress was not updated because no valid steps were provided.",
            };
          }
          const completed = progress.steps.filter((step) => step.status === "completed").length;
          onChunk(chunk);
          return {
            ok: true,
            content: `Plan progress updated (${String(completed)}/${String(progress.steps.length)} completed).`,
          };
        },
      });
    }

    const tools = isChat ? openAiChatTools : runTools;

    let latestResponseId: string | null = null;
    const streamOutId = crypto.randomUUID();
    let streamedText = "";
    let emittedAssistantOutput = false;
    let activeReasoningStreamId: string | null = null;
    let activeReasoningText = "";
    let completedReasoningTranscript = "";
    let streamedReasoningSinceLastStep = false;
    const generatedFileAttachments: ChatAttachmentPayload[] = [];
    const generatedFileKeys = new Set<string>();
    const openAiContainerFileReferences = new Map<string, OpenAiContainerFileReference>();
    let generatedFileBytes = 0;
    let droppedGeneratedFileCount = 0;
    let failedGeneratedFileDownloadCount = 0;

    const rememberGeneratedAttachment = (attachment: ChatAttachmentPayload | null): void => {
      if (!attachment) {
        return;
      }
      const key = generatedFileKey(attachment);
      if (generatedFileKeys.has(key)) {
        return;
      }
      generatedFileKeys.add(key);

      const fileBytes = estimateBase64ByteLength(attachment.dataBase64);
      if (
        generatedFileAttachments.length >= CHAT_ATTACHMENT_LIMITS.maxFileCount ||
        fileBytes > CHAT_ATTACHMENT_LIMITS.maxBytesPerFile ||
        generatedFileBytes + fileBytes > CHAT_ATTACHMENT_LIMITS.maxTotalBytes
      ) {
        droppedGeneratedFileCount += 1;
        return;
      }

      generatedFileBytes += fileBytes;
      generatedFileAttachments.push(attachment);
    };

    const rememberGeneratedFile = (file: GeneratedFile): void => {
      rememberGeneratedAttachment(generatedFileToAttachment(file, generatedFileKeys.size + 1));
    };

    const trimCompletedReasoningPrefix = (value: string) => {
      if (!completedReasoningTranscript) {
        return value;
      }
      return value.startsWith(completedReasoningTranscript) ? value.slice(completedReasoningTranscript.length).trimStart() : value;
    };

    const resetReasoningSegment = () => {
      if (activeReasoningText) {
        completedReasoningTranscript += activeReasoningText;
      }
      activeReasoningStreamId = null;
      activeReasoningText = "";
    };

    const { instructions: promptInstructions, messages: promptMessages } = splitSystemMessagesIntoInstructions(
      startingMessages as Array<Record<string, unknown>>,
    );
    const result = await withProviderRetry(isChat ? "chat request" : "agent run", signal, onChunk, () =>
      streamText({
        model,
        ...(promptInstructions ? { instructions: promptInstructions } : {}),
        messages: promptMessages as never,
        tools,
        ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
        stopWhen: stepCountIs(isChat ? (openAiChatTools ? 6 : 1) : MODE_POLICIES[input.mode].maxToolRounds),
        abortSignal: signal,
        onStepEnd: async (stepResult) => {
          accumulatedUsage = addUsage(accumulatedUsage, normalizeAiSdkTokenUsage(stepResult.usage));

          if (!streamedReasoningSinceLastStep && stepResult.reasoningText?.trim()) {
            const novelReasoningText = trimCompletedReasoningPrefix(stepResult.reasoningText.trim());
            if (novelReasoningText) {
              activeReasoningStreamId = crypto.randomUUID();
              activeReasoningText = novelReasoningText;
              onChunk({
                type: "message",
                title: "Reasoning",
                value: activeReasoningText,
                metadata: {
                  assistantKind: "reasoning",
                  streamId: activeReasoningStreamId,
                  replace: true,
                },
              });
            }
          }
          streamedReasoningSinceLastStep = false;

          if (!streamedText && stepResult.text.trim()) {
            emittedAssistantOutput = true;
            onChunk({
              type: "message",
              title: "Agent output",
              value: stepResult.text.trim(),
              metadata: {
                streamId: streamOutId,
                replace: true,
              },
            });
          }

          const responseMessages = ((stepResult.response as { messages?: Array<Record<string, unknown>> })?.messages ?? []).map((message) => ({
            ...message,
          }));
          if (responseMessages.length > 0) {
            persistedMessages.push(...responseMessages);
          }

          latestResponseId = String((stepResult.response as { id?: string }).id ?? latestResponseId ?? "");

          if (!isChat && stepResult.toolCalls.length > 0) {
            completedToolRounds += 1;
            onChunk({
              type: "status",
              title: "Checkpoint updated",
              value: `Completed tool round with ${stepResult.toolCalls.length} tool call${stepResult.toolCalls.length === 1 ? "" : "s"}.`,
              metadata: {
                silent: true,
                checkpoint: true,
                resumeCheckpoint: {
                  messages: persistedMessages,
                  round: stepResult.stepNumber + 1,
                  memo: `Completed tool round with ${stepResult.toolCalls.length} tool call${stepResult.toolCalls.length === 1 ? "" : "s"}.`,
                },
              },
            });
          }

          for (const part of stepResult.content as Array<Record<string, unknown>>) {
            collectOpenAiContainerFileReferences(part, openAiContainerFileReferences);
          }

          for (const file of stepResult.files) {
            rememberGeneratedFile(file);
          }

          onChunk({
            type: "status",
            value: "Usage updated.",
            metadata: {
              silent: true,
              usageTotals: accumulatedUsage,
            },
          });
        },
      }),
    );

    const streamingToolNamesById = new Map<string, string>();
    for await (const part of result.stream as AsyncIterable<Record<string, unknown>>) {
      collectOpenAiContainerFileReferences(part, openAiContainerFileReferences);

      if (part.type === "text-delta" || part.type === "text") {
        resetReasoningSegment();
        const delta =
          typeof part.textDelta === "string"
            ? part.textDelta
            : typeof part.text === "string"
              ? part.text
              : "";
        if (!delta) {
          continue;
        }
        streamedText += delta;
        emittedAssistantOutput = true;
        onChunk({
          type: "message",
          title: "Agent output",
          value: streamedText,
          metadata: {
            streamId: streamOutId,
            replace: true,
          },
        });
        continue;
      }

      if (part.type === "reasoning" || part.type === "reasoning-delta") {
        const reasoningChunk =
          typeof part.textDelta === "string"
            ? part.textDelta
            : typeof part.text === "string"
              ? part.text
              : "";
        if (!reasoningChunk) {
          continue;
        }
        if (!activeReasoningStreamId) {
          activeReasoningStreamId = crypto.randomUUID();
          activeReasoningText = "";
        }
        streamedReasoningSinceLastStep = true;
        if (part.type === "reasoning") {
          activeReasoningText = trimCompletedReasoningPrefix(reasoningChunk);
        } else {
          activeReasoningText += reasoningChunk;
        }
        if (!activeReasoningText) {
          continue;
        }
        onChunk({
          type: "message",
          title: "Reasoning",
          value: activeReasoningText,
          metadata: {
            assistantKind: "reasoning",
            streamId: activeReasoningStreamId,
            replace: true,
          },
        });
        continue;
      }

      if (part.type === "file") {
        const file = (part as { file?: GeneratedFile }).file;
        if (file) {
          rememberGeneratedFile(file);
        }
        continue;
      }

      if (part.type === "tool-input-start") {
        resetReasoningSegment();
        const toolName = typeof part.toolName === "string" ? part.toolName : "tool";
        if (typeof part.id === "string") {
          streamingToolNamesById.set(part.id, toolName);
        }
        onChunk({
          type: "status",
          value: `Preparing tool call: ${toolName}`,
          metadata: {
            silent: true,
          },
        });
        continue;
      }

      if (part.type === "tool-input-delta") {
        resetReasoningSegment();
        const toolName = (typeof part.id === "string" ? streamingToolNamesById.get(part.id) : undefined) ?? "tool";
        onChunk({
          type: "status",
          value: `Streaming arguments for tool call: ${toolName}`,
          metadata: {
            silent: true,
          },
        });
        continue;
      }

      if (part.type === "reasoning-end" || part.type === "finish") {
        resetReasoningSegment();
      }
    }

    if (openAiChatTools && openAiContainerFileReferences.size > 0) {
      let index = generatedFileAttachments.length + 1;
      for (const reference of openAiContainerFileReferences.values()) {
        try {
          const attachment = await downloadOpenAiContainerFile(input, reference, index, devLogger.enabled ? devLogger : undefined);
          rememberGeneratedAttachment(attachment);
          index += 1;
        } catch (error) {
          failedGeneratedFileDownloadCount += 1;
          devLogger?.log("OpenAI.container_file.download.error", {
            containerId: reference.containerId,
            fileId: reference.fileId,
            error: extractErrorText(error),
          });
        }
      }
    }

    if (generatedFileAttachments.length > 0) {
      onChunk({
        type: "message",
        title: generatedFileAttachments.length === 1 ? "Generated file" : "Generated files",
        value: `Generated ${String(generatedFileAttachments.length)} file${generatedFileAttachments.length === 1 ? "" : "s"}.`,
        metadata: {
          assistantKind: "files",
          attachments: generatedFileAttachments,
          attachmentNames: generatedFileAttachments.map((attachment) => attachment.fileName),
        },
      });
    }

    if (failedGeneratedFileDownloadCount > 0) {
      onChunk({
        type: "status",
        title: "Generated file download failed",
        value: `${String(failedGeneratedFileDownloadCount)} generated file${failedGeneratedFileDownloadCount === 1 ? "" : "s"} could not be downloaded from OpenAI Code Interpreter.`,
      });
    }

    if (droppedGeneratedFileCount > 0) {
      onChunk({
        type: "status",
        title: "Generated file skipped",
        value: `${String(droppedGeneratedFileCount)} generated file${droppedGeneratedFileCount === 1 ? " was" : "s were"} too large or exceeded the stored file limit.`,
      });
    }

    const finalText = typeof (result as { text?: PromiseLike<string> | string }).text !== "undefined"
      ? (await (result as { text: PromiseLike<string> | string }).text).trim()
      : "";

    if (!isChat && !emittedAssistantOutput && finalText) {
      streamedText = finalText;
      onChunk({
        type: "message",
        title: "Agent output",
        value: finalText,
        metadata: {
          streamId: streamOutId,
          replace: true,
        },
      });
    }

    const reachedCodeToolRoundLimit =
      !isChat && input.mode === "code" && completedToolRounds >= MODE_POLICIES.code.maxToolRounds;
    if (reachedCodeToolRoundLimit && successfulMutationToolCalls === 0 && !streamedText.trim() && !finalText) {
      throw new Error(
        `Code run reached the tool round limit (${String(MODE_POLICIES.code.maxToolRounds)}) before making any file edits. Try narrowing the task or using read_file with startLine/endLine to inspect large files in focused ranges.`,
      );
    }

    const generatedFileSummary =
      generatedFileAttachments.length > 0
        ? `Generated ${String(generatedFileAttachments.length)} file${generatedFileAttachments.length === 1 ? "" : "s"}.`
        : "";
    const summary = streamedText.trim() || finalText || generatedFileSummary || "No output returned from the provider.";

    onChunk({
      type: "status",
      value: isChat ? "Chat completed." : "AI SDK run completed.",
    });

    return {
      summary: summary.slice(0, 4000),
      responseId: latestResponseId,
      usage: accumulatedUsage,
    };
  }
}
