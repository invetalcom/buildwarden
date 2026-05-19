import { Buffer } from "node:buffer";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { generateText, jsonSchema, stepCountIs, streamText, tool, type LanguageModel } from "ai";
import { ProxyAgent } from "undici";
import type {
  ChatAttachmentPayload,
  HarnessAdapter,
  HarnessRunChunk,
  HarnessToolContext,
  NetworkProxyRuntimeConfig,
  ProviderAccountInput,
  ProviderAdapter,
  RunExecutionRequest,
  RunTokenUsage,
  UnifiedProviderFamily,
} from "@easycode/shared";
import {
  AI_SDK_RECOMMENDED_MODEL_IDS,
  MODEL_CONFIG_ANTHROPIC_EFFORT_KEY,
  MODEL_CONFIG_OPENAI_REASONING_EFFORT_KEY,
  PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY,
  PROVIDER_CONFIG_DEFAULT_HEADERS_KEY,
  buildNetworkProxyUrl,
  runShellActivityStreamId,
  shouldBypassNetworkProxyForUrl,
} from "@easycode/shared";
import pRetry, { AbortError } from "p-retry";
import { createDevLogger } from "./dev-logger";

const CHAT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Answer the user's questions directly and concisely. You do not have access to any tools or files.";

const SYSTEM_PROMPT = [
  "You are Easycode, a desktop coding agent running inside a Git worktree.",
  "You are operating on a local codebase and can inspect and modify files via provided tools.",
  "Use the tools whenever repository context is needed and apply concrete changes when the task requires implementation.",
  "Do not claim to have changed files unless you used the file tools successfully.",
  "All file-tool paths must be relative to the run worktree root.",
  "run_shell already starts in the run worktree root. Do not prefix commands with cd or chain commands with operators.",
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

const describeToolCall = (name: string, args: Record<string, unknown>) => {
  const interestingValue = args.path ?? args.command ?? args.query ?? JSON.stringify(args);
  return `${name}: ${String(interestingValue)}`;
};

const addUsage = (left: RunTokenUsage, right: RunTokenUsage): RunTokenUsage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
  cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
  cacheCreationInputTokens: (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0),
  totalTokens: (left.totalTokens ?? left.inputTokens + left.outputTokens) + (right.totalTokens ?? right.inputTokens + right.outputTokens),
});

const usageFromUnknown = (usage: unknown): RunTokenUsage => {
  const raw = (usage ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
  };
  const inputTokens = Number(raw.inputTokens ?? 0);
  const outputTokens = Number(raw.outputTokens ?? 0);
  const result: RunTokenUsage = {
    inputTokens: Number(raw.inputTokens ?? 0),
    outputTokens: Number(raw.outputTokens ?? 0),
  };
  const reasoningTokens = Number(raw.reasoningTokens ?? 0);
  const cachedInputTokens = Number(raw.cachedInputTokens ?? 0);
  const totalTokens = Number(raw.totalTokens ?? inputTokens + outputTokens);
  if (Number.isFinite(reasoningTokens) && reasoningTokens > 0) {
    result.reasoningTokens = reasoningTokens;
  }
  if (Number.isFinite(cachedInputTokens) && cachedInputTokens > 0) {
    result.cachedInputTokens = cachedInputTokens;
  }
  if (Number.isFinite(totalTokens) && totalTokens > 0) {
    result.totalTokens = totalTokens;
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
      name: "easycode-compatible",
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
    const provider = createOpenAI(commonOptions);
    return provider.responses(input.modelId);
  }

  const factories = {
    anthropic: createAnthropic,
    google: createGoogleGenerativeAI,
    xai: createXai,
  } satisfies Record<Exclude<UnifiedProviderFamily, "openai" | "openai-compatible">, (options?: Record<string, unknown>) => (modelId: string) => LanguageModel>;

  return factories[family](commonOptions)(input.modelId);
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
      content: `${SYSTEM_PROMPT}\n\n${MODE_INSTRUCTIONS[input.mode]}`,
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
          input.repoContext ? `Repository context:\n${input.repoContext}` : "Repository context is unavailable. Use tools to inspect the worktree.",
        ].join("\n"),
        input.attachments,
      ),
    },
  ];
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
    messages: [
      {
        role: "system",
        content: input.systemPrompt,
      },
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
    usage: usageFromUnknown(result.usage),
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
    const devLogger = createDevLogger({
      logDirPath: input.devLogging?.logDirPath,
      runId: input.runId,
      providerType: input.providerType,
      modelId: input.modelId,
      sessionType: isChat ? "chat" : "run",
    });
    const model = createLanguageModel(input, devLogger.enabled ? devLogger : undefined);
    const providerOptions = buildAiSdkProviderOptions(getProviderFamily(input.config), input.modelId, input.providerOptions, input.modelConfig);
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
        content: CHAT_SYSTEM_PROMPT,
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

    const tools =
      isChat
        ? undefined
        : Object.fromEntries(
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

    let latestResponseId: string | null = null;
    const streamOutId = crypto.randomUUID();
    let streamedText = "";
    let emittedAssistantOutput = false;
    let activeReasoningStreamId: string | null = null;
    let activeReasoningText = "";
    let completedReasoningTranscript = "";
    let streamedReasoningSinceLastStep = false;

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

    const result = await withProviderRetry(isChat ? "chat request" : "agent run", signal, onChunk, () =>
      streamText({
        model,
        messages: startingMessages as never,
        tools,
        ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
        stopWhen: stepCountIs(isChat ? 1 : MODE_POLICIES[input.mode].maxToolRounds),
        abortSignal: signal,
        onStepFinish: async (stepResult) => {
          accumulatedUsage = addUsage(accumulatedUsage, usageFromUnknown(stepResult.usage));

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

    for await (const part of result.fullStream as AsyncIterable<Record<string, unknown>>) {
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

      if (part.type === "tool-call-streaming-start") {
        resetReasoningSegment();
        const toolName = typeof part.toolName === "string" ? part.toolName : "tool";
        onChunk({
          type: "status",
          value: `Preparing tool call: ${toolName}`,
          metadata: {
            silent: true,
          },
        });
        continue;
      }

      if (part.type === "tool-call-delta") {
        resetReasoningSegment();
        const toolName = typeof part.toolName === "string" ? part.toolName : "tool";
        onChunk({
          type: "status",
          value: `Streaming arguments for tool call: ${toolName}`,
          metadata: {
            silent: true,
          },
        });
        continue;
      }

      if (part.type === "reasoning-part-finish" || part.type === "finish") {
        resetReasoningSegment();
      }
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

    const summary = streamedText.trim() || finalText || "No output returned from the provider.";

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
