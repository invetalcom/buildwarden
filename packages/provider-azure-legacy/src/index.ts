import OpenAI from "openai";
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
  RunResumeCheckpoint,
  RunTokenUsage,
  AzureLegacyResumeCheckpointMessage,
} from "@buildwarden/shared";
import {
  PROVIDER_CONFIG_AZURE_API_VERSION_KEY,
  buildNetworkProxyUrl,
  runShellActivityStreamId,
  shouldBypassNetworkProxyForUrl,
} from "@buildwarden/shared";
import { createDevLogger } from "./dev-logger";
import {
  MODE_INSTRUCTIONS,
  MODE_POLICIES,
  SYSTEM_PROMPT,
  addUsage,
  buildCheckpointMemo,
  capAttachmentText,
  decodeAttachmentText,
  describeToolCall,
  isRunToolName,
  safeJsonParse,
  withProviderRetry,
} from "./harness-shared";

const CHAT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Answer the user's questions directly and concisely. You do not have access to any tools or files.";

export { createDevLogger as createAzureLegacyDevLogger };

const normalizeDeploymentBaseUrl = (url: string): string => {
  const trimmed = url.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

const withAzureLegacyCompatHeaders = (rawKey: string, innerFetch: typeof fetch = fetch): typeof fetch => {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.set("api-key", rawKey.length > 0 ? rawKey : "none");
    headers.set("http-referer", "https://kilocode.ai/vn");
    headers.set("x-title", "Kilo Code(vn)");
    headers.set("x-kilocde-version", "5.7.0");
    headers.set("user-agent", "Kilo-Code/5.7.0");
    return innerFetch(input, {
      ...init,
      headers,
    });
  };
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

const createProxyAwareFetch = (
  networkProxy: NetworkProxyRuntimeConfig | undefined,
  innerFetch: typeof fetch = fetch,
): typeof fetch | undefined => {
  if (!networkProxy) {
    return innerFetch;
  }
  const proxyAgent = new ProxyAgent(buildNetworkProxyUrl(networkProxy));
  return (input, init) => {
    const url = getRequestUrl(input);
    if (shouldBypassNetworkProxyForUrl(url, networkProxy)) {
      return innerFetch(input, init);
    }
    return innerFetch(
      input,
      {
        ...(init ?? {}),
        dispatcher: proxyAgent,
      } as RequestInit & { dispatcher: ProxyAgent },
    );
  };
};

export const createAzureLegacyClientFromParts = (
  apiBaseUrl: string | null | undefined,
  apiKeyInput: string | undefined,
  config: Record<string, unknown> | undefined,
  transportFetch?: typeof fetch,
  networkProxy?: NetworkProxyRuntimeConfig,
): OpenAI => {
  const base = apiBaseUrl?.trim();
  if (!base) {
    throw new Error("Azure Legacy requires a deployment base URL.");
  }

  const providerConfig = config ?? {};
  const defaultHeaders =
    typeof providerConfig.defaultHeaders === "object" && providerConfig.defaultHeaders
      ? (providerConfig.defaultHeaders as Record<string, string>)
      : {};

  const apiVersionRaw = providerConfig[PROVIDER_CONFIG_AZURE_API_VERSION_KEY];
  const apiVersion = typeof apiVersionRaw === "string" && apiVersionRaw.trim() ? apiVersionRaw.trim() : "2024-06-01";

  const rawKey = apiKeyInput?.trim() ?? "";
  const apiKey = rawKey.length > 0 ? rawKey : "none";

  return new OpenAI({
    apiKey,
    baseURL: normalizeDeploymentBaseUrl(base),
    defaultQuery: { "api-version": apiVersion },
    defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
    fetch: withAzureLegacyCompatHeaders(rawKey, createProxyAwareFetch(networkProxy, transportFetch ?? fetch)),
    dangerouslyAllowBrowser: false,
  });
};

type ChatContentPart = OpenAI.Chat.ChatCompletionContentPart;
export type AzureLegacyCompletionState = {
  filesChanged: Set<string>;
  filesRead: Set<string>;
  repoSearches: number;
  shellValidationsAttempted: string[];
  shellValidationSucceeded: boolean;
  shellValidationFailed: boolean;
  toolFailures: number;
  latestRoundHadEdits: boolean;
  latestRoundHadFollowupInspection: boolean;
};

const buildAzureLegacyUserContent = (
  promptText: string,
  attachments: ChatAttachmentPayload[] | undefined,
): ChatContentPart[] => {
  const textParts: string[] = [];
  const trimmed = promptText.trim();
  if (trimmed) {
    textParts.push(trimmed);
  }

  const parts: ChatContentPart[] = [];

  for (const att of attachments ?? []) {
    const mime = (att.mimeType || "application/octet-stream").toLowerCase();
    const name = att.fileName.trim() || "attachment";

    if (mime.startsWith("image/")) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${att.dataBase64}` },
      });
      continue;
    }

    if (mime === "application/pdf" || mime.startsWith("text/") || mime === "application/json") {
      const capped = capAttachmentText(decodeAttachmentText(att));
      textParts.push(`\n\n--- ${name} ---\n${capped}`);
      continue;
    }

    textParts.push(`\n\n[Attached binary file: ${name}, mime ${mime}]`);
  }

  const combined = textParts.join("").trim() || (attachments?.length ? "See attachments." : "");
  if (combined) {
    parts.unshift({ type: "text", text: combined });
  }
  return parts;
};

const usageFromCompletion = (usage: OpenAI.CompletionUsage | undefined): RunTokenUsage => {
  const raw = usage as
    | (OpenAI.CompletionUsage & {
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      })
    | undefined;
  const inputTokens = raw?.prompt_tokens ?? 0;
  const outputTokens = raw?.completion_tokens ?? 0;
  const totalTokens = raw?.total_tokens ?? inputTokens + outputTokens;
  const reasoningTokens = raw?.completion_tokens_details?.reasoning_tokens ?? 0;
  const cachedInputTokens = raw?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(totalTokens > 0 ? { totalTokens } : {}),
  };
};

export const createCompletionState = (): AzureLegacyCompletionState => ({
  filesChanged: new Set<string>(),
  filesRead: new Set<string>(),
  repoSearches: 0,
  shellValidationsAttempted: [],
  shellValidationSucceeded: false,
  shellValidationFailed: false,
  toolFailures: 0,
  latestRoundHadEdits: false,
  latestRoundHadFollowupInspection: false,
});

export const isLikelyValidationCommand = (command: string): boolean =>
  /\b(test|typecheck|lint|build|tsc|gradle|gradlew|mvn|pytest|vitest|jest|cargo test|go test)\b/i.test(command);

const trackReadFile = (state: AzureLegacyCompletionState, path: string): void => {
  state.filesRead.add(path);
  if (state.filesChanged.has(path)) state.latestRoundHadFollowupInspection = true;
};

const trackChangedFile = (state: AzureLegacyCompletionState, path: string): void => {
  state.filesChanged.add(path);
  state.latestRoundHadEdits = true;
};

const trackRepoSearch = (state: AzureLegacyCompletionState): void => {
  state.repoSearches += 1;
  if (state.filesChanged.size > 0) state.latestRoundHadFollowupInspection = true;
};

const trackShellValidation = (state: AzureLegacyCompletionState, toolResult: { ok: boolean; metadata?: Record<string, unknown> }): void => {
  const command = typeof toolResult.metadata?.command === "string" ? toolResult.metadata.command : "";
  if (!isLikelyValidationCommand(command)) return;
  state.shellValidationsAttempted.push(command);
  if (toolResult.ok) state.shellValidationSucceeded = true;
  else state.shellValidationFailed = true;
};

const completionHasFailure = (state: AzureLegacyCompletionState): boolean => state.toolFailures > 0 || state.shellValidationFailed;
const completionNeedsInspection = (state: AzureLegacyCompletionState): boolean => state.latestRoundHadEdits && !state.latestRoundHadFollowupInspection;
const completionLacksEvidence = (state: AzureLegacyCompletionState): boolean =>
  !state.latestRoundHadFollowupInspection && state.repoSearches === 0 && state.filesRead.size <= state.filesChanged.size;

export const updateCompletionStateFromToolResult = (
  state: AzureLegacyCompletionState,
  toolName: string,
  toolResult: { ok: boolean; metadata?: Record<string, unknown> },
) => {
  const path = typeof toolResult.metadata?.path === "string" ? toolResult.metadata.path : null;
  if (!toolResult.ok) {
    state.toolFailures += 1;
  }

  if (toolName === "read_file" && path) {
    trackReadFile(state, path);
    return;
  }

  if ((toolName === "write_file" || toolName === "edit_file" || toolName === "delete_file") && path) {
    trackChangedFile(state, path);
    return;
  }

  if (toolName === "search_repo") {
    trackRepoSearch(state);
    return;
  }

  if (toolName === "run_shell") {
    trackShellValidation(state, toolResult);
  }
};

export const shouldForceContinuation = (
  mode: RunExecutionRequest["mode"],
  state: AzureLegacyCompletionState,
): boolean => {
  if (mode !== "code") {
    return false;
  }
  if (state.filesChanged.size === 0) {
    return false;
  }
  if (completionHasFailure(state)) {
    return true;
  }
  if (state.shellValidationSucceeded) {
    return false;
  }
  if (completionNeedsInspection(state)) {
    return true;
  }
  if (completionLacksEvidence(state)) {
    return true;
  }
  return false;
};

export const buildContinuationPrompt = (state: AzureLegacyCompletionState): string => {
  if (state.shellValidationFailed) {
    return "You are not done yet. Validation failed after your edits. Continue fixing the issues instead of concluding.";
  }
  if (state.toolFailures > 0) {
    return "You are not done yet. One or more tool calls failed. Resolve the failure or adapt your approach before concluding.";
  }
  if (state.latestRoundHadEdits && !state.latestRoundHadFollowupInspection) {
    return "You are not done yet. In code mode, after modifying files you must verify completeness before finishing. Inspect affected references or run an appropriate validation command if available.";
  }
  return "You are not done yet. In code mode, after modifying files you must verify the result before finishing. Run relevant validation if available, or inspect changed files and affected references before concluding.";
};

const serializeCheckpointMessage = (message: OpenAI.Chat.ChatCompletionMessageParam): AzureLegacyResumeCheckpointMessage => {
  if (message.role === "tool") return {
    role: "tool",
    content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
    toolCallId: message.tool_call_id,
  };
  if (message.role === "assistant") return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : "",
    toolCalls: (message.tool_calls ?? []).flatMap((toolCall) => toolCall.type === "function" ? [{
      id: toolCall.id,
      type: "function" as const,
      function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
    }] : []),
  };
  if (message.role === "system" || message.role === "user") return {
    role: message.role,
    content: typeof message.content === "string" ? message.content : null,
  };
  return { role: "system", content: typeof message.content === "string" ? message.content : null };
};

const serializeCheckpointMessages = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): AzureLegacyResumeCheckpointMessage[] => messages.map(serializeCheckpointMessage);

const restoreCheckpointMessages = (
  messages: AzureLegacyResumeCheckpointMessage[] | undefined,
): OpenAI.Chat.ChatCompletionMessageParam[] | null => {
  if (!messages || messages.length === 0) {
    return null;
  }
  return messages.map((message) => {
    if (message.role === "function") {
      return {
        role: "tool",
        tool_call_id: `legacy_${message.name}`,
        content: message.content,
      } satisfies OpenAI.Chat.ChatCompletionToolMessageParam;
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      } satisfies OpenAI.Chat.ChatCompletionToolMessageParam;
    }

    if (message.role === "assistant") {
      const toolCalls =
        message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          type: "function" as const,
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        })) ??
        (message.functionCall
          ? [
              {
                id: `legacy_${message.functionCall.name}`,
                type: "function" as const,
                function: {
                  name: message.functionCall.name,
                  arguments: message.functionCall.arguments,
                },
              },
            ]
          : undefined);
      return {
        role: "assistant",
        content: message.content ?? "",
        tool_calls: toolCalls,
      } satisfies OpenAI.Chat.ChatCompletionAssistantMessageParam;
    }

    return {
      role: message.role,
      content: message.content ?? "",
    } satisfies OpenAI.Chat.ChatCompletionMessageParam;
  });
};

export class AzureLegacyProviderAdapter implements ProviderAdapter {
  readonly providerType = "azure-legacy" as const;

  listRecommendedModels(): string[] {
    return [];
  }

  validateConfiguration(input: ProviderAccountInput): void {
    if (!input.apiBaseUrl?.trim()) {
      throw new Error("A base URL is required for Azure Legacy providers.");
    }
  }
}

export class AzureLegacyHarnessAdapter implements HarnessAdapter {
  readonly harnessType = "azure-legacy" as const;

  async run(
    input: RunExecutionRequest,
    toolContext: HarnessToolContext,
    onChunk: (chunk: HarnessRunChunk) => void,
    signal: AbortSignal,
  ): Promise<{ summary: string; responseId: string | null; usage: RunTokenUsage }> {
    return runAzureLegacyHarness(input, toolContext, onChunk, signal);
  }
}

export const runAzureLegacyHarness = async (
  input: RunExecutionRequest,
  toolContext: HarnessToolContext,
  onChunk: (chunk: HarnessRunChunk) => void,
  signal: AbortSignal,
): Promise<{ summary: string; responseId: string | null; usage: RunTokenUsage }> => {
  const isChat = input.isChat === true;
  const devLogger = createDevLogger({
    logDirPath: input.devLogging?.logDirPath,
    runId: input.runId,
    providerType: input.providerType,
    modelId: input.modelId,
    sessionType: isChat ? "chat" : "run",
  });
  const activeLogger = devLogger.enabled ? devLogger : undefined;
  const client = createAzureLegacyClientFromParts(
    input.apiBaseUrl,
    input.apiKey,
    input.config,
    devLogger.createLoggedFetch(),
    input.networkProxy,
  );

  onChunk({
    type: "status",
    value: isChat ? "Starting chat (Azure Legacy / Chat Completions)" : `Starting ${input.mode} run (Azure Legacy / Chat Completions)`,
  });

  if (isChat) {
    return runAzureLegacyChat(client, input, onChunk, signal, activeLogger);
  }

  return runAzureLegacyAgent(client, input, toolContext, onChunk, signal, activeLogger);
};

const runAzureLegacyChat = async (
  client: OpenAI,
  input: RunExecutionRequest,
  onChunk: (chunk: HarnessRunChunk) => void,
  signal: AbortSignal,
  devLogger?: { log: (event: string, data: unknown) => void },
): Promise<{ summary: string; responseId: string | null; usage: RunTokenUsage }> => {
  const userContent = buildAzureLegacyUserContent(input.prompt, input.attachments);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: CHAT_SYSTEM_PROMPT }];
  for (const message of input.priorChatMessages ?? []) {
    messages.push({ role: message.role, content: message.content });
  }
  messages.push({ role: "user", content: userContent });

  devLogger?.log("Azure Legacy.chat_completions.request", {
    model: input.modelId,
    messages,
    stream: true,
    temperature: 0,
    stream_options: { include_usage: true },
  });

  const stream = await withProviderRetry("chat request", signal, onChunk, devLogger, () =>
    client.chat.completions.create(
      {
        model: input.modelId,
        messages,
        stream: true,
        temperature: 0,
        stream_options: { include_usage: true },
      },
      { signal },
    ),
  );

  const streamOutId = crypto.randomUUID();
  let full = "";
  let usage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = usageFromCompletion(chunk.usage);
    }
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      full += delta;
      onChunk({
        type: "message",
        title: "Agent output",
        value: full,
        metadata: { streamId: streamOutId, replace: true },
      });
    }
  }

  const output = full.trim() || "No output returned.";
  onChunk({ type: "status", value: "Azure Legacy chat completed." });
  return { summary: output.slice(0, 4000), responseId: null, usage };
};

const buildAzureAgentSetup = (input: RunExecutionRequest, toolContext: HarnessToolContext) => {
  const systemPrompt = `${SYSTEM_PROMPT}\n\n${MODE_INSTRUCTIONS[input.mode]}\n\nPolicy: ${MODE_POLICIES[input.mode].completionStyle}`;
  const userContent: ChatContentPart[] = [
    { type: "text", text: `<task>\n${input.prompt.trim() || "(no task provided)"}\n</task>` },
    {
      type: "text",
      text: [
        "<environment_details>",
        `Mode: ${input.mode}`,
        "Workspace: .",
        "",
        input.repoContext ? `Repository context:\n${input.repoContext}` : "Repository context is unavailable.",
        "</environment_details>",
      ].join("\n"),
    },
  ];
  const tools: OpenAI.Chat.ChatCompletionTool[] = toolContext.tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema as Record<string, unknown> },
  }));
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...(restoreCheckpointMessages(input.resumeCheckpoint?.chatMessages) ?? [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ]),
  ];
  const startingRound = input.resumeCheckpoint?.chatMessages?.length ? input.resumeCheckpoint.round : 0;
  return { messages, startingRound, tools };
};

const runAzureLegacyAgent = async (
  client: OpenAI,
  input: RunExecutionRequest,
  toolContext: HarnessToolContext,
  onChunk: (chunk: HarnessRunChunk) => void,
  signal: AbortSignal,
  devLogger?: { log: (event: string, data: unknown) => void },
): Promise<{ summary: string; responseId: string | null; usage: RunTokenUsage }> => {
  const { messages, startingRound, tools: openAITools } = buildAzureAgentSetup(input, toolContext);

  let accumulatedUsage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };
  const streamOutId = crypto.randomUUID();
  const completionState = createCompletionState();

  for (let round = startingRound; round < MODE_POLICIES[input.mode].maxToolRounds; round += 1) {
    completionState.latestRoundHadEdits = false;
    completionState.latestRoundHadFollowupInspection = false;
    const stream = await withProviderRetry("chat completion round", signal, onChunk, devLogger, () =>
      client.chat.completions.create(
        {
          model: input.modelId,
          messages,
          tools: openAITools,
          tool_choice: "auto",
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0,
        },
        { signal },
      ),
    );

    let roundUsage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };
    let assistantContent = "";
    const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        roundUsage = usageFromCompletion(chunk.usage);
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) {
        continue;
      }
      if (delta.content) {
        assistantContent += delta.content;
        onChunk({
          type: "message",
          title: "Agent output",
          value: assistantContent,
          metadata: { streamId: streamOutId, replace: true },
        });
      }
      for (const toolCallDelta of delta.tool_calls ?? []) {
        const index = toolCallDelta.index ?? 0;
        const current = toolCallParts.get(index) ?? { id: "", name: "", arguments: "" };
        if (toolCallDelta.id) {
          current.id = toolCallDelta.id;
        }
        if (toolCallDelta.function?.name) {
          current.name += toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
          current.arguments += toolCallDelta.function.arguments;
        }
        toolCallParts.set(index, current);
      }
    }

    accumulatedUsage = addUsage(accumulatedUsage, roundUsage);
    const toolCalls = [...toolCallParts.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, toolCall]) => ({
        id: toolCall.id || crypto.randomUUID(),
        type: "function" as const,
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments || "{}",
        },
      }));

    if (toolCalls.length === 0) {
      const text = assistantContent.trim() || "No output returned from the provider.";
      if (shouldForceContinuation(input.mode, completionState)) {
        const continuationPrompt = buildContinuationPrompt(completionState);
        messages.push({
          role: "assistant",
          content: assistantContent,
        });
        messages.push({
          role: "user",
          content: continuationPrompt,
        });
        onChunk({
          type: "status",
          value: continuationPrompt,
        });
        continue;
      }
      onChunk({
        type: "message",
        title: "Agent output",
        value: text,
        metadata: { streamId: streamOutId, replace: true },
      });
      onChunk({ type: "status", value: "Azure Legacy run completed." });
      return { summary: text.slice(0, 4000), responseId: null, usage: accumulatedUsage };
    }

    messages.push({
      role: "assistant",
      content: assistantContent,
      tool_calls: toolCalls,
    });

    const toolResultsForCheckpoint: string[] = [];

    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function") {
        continue;
      }
      const name = toolCall.function.name;
      const parsedArgs = safeJsonParse(toolCall.function.arguments || "{}");

      if (!isRunToolName(name, toolContext)) {
        throw new Error(`The model requested an unsupported tool: ${name}`);
      }

      onChunk({
        type: "tool-call",
        title: `Tool call: ${name}`,
        value: describeToolCall(name, parsedArgs),
        metadata: { toolName: name, arguments: parsedArgs, callId: toolCall.id },
      });

      const toolResult = await toolContext.executeTool({
        id: toolCall.id,
        name,
        arguments: parsedArgs,
      });
      updateCompletionStateFromToolResult(completionState, name, toolResult);

      onChunk({
        type: "tool-result",
        title: `Tool result: ${name}`,
        value: toolResult.content,
        metadata: {
          toolName: name,
          callId: toolCall.id,
          ok: toolResult.ok,
          ...toolResult.metadata,
          ...(name === "run_shell"
            ? { streamId: runShellActivityStreamId(toolCall.id), replace: true }
            : {}),
        },
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult.content,
      });
      toolResultsForCheckpoint.push(toolResult.content);
    }

    const checkpointMemo = buildCheckpointMemo(
      toolCalls.map((toolCall) => ({
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })),
      toolResultsForCheckpoint,
    );
    onChunk({
      type: "status",
      value: checkpointMemo,
      metadata: {
        silent: true,
        checkpoint: true,
        resumeCheckpoint: {
          chatMessages: serializeCheckpointMessages(messages),
          round: round + 1,
          memo: checkpointMemo,
        } satisfies RunResumeCheckpoint,
      },
    });
  }

  throw new Error("The run exceeded the maximum number of tool rounds (Azure Legacy).");
};
