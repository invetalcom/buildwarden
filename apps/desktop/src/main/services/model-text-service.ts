import { mkdirSync } from "node:fs";
import { APP_SETTING_KEYS, type ModelRecord, type ProviderAccountRecord, type RunTokenUsage } from "@buildwarden/shared";
import { loadAiSdkProvider, loadAzureLegacyProvider, loadClaudeProvider, loadCodexProvider, loadCursorProvider } from "../provider-modules";
import { advanceUsageTracker, EMPTY_REPORTED_TOKEN_USAGE, type UsageReportTracker } from "../token-usage-accounting";
import { generateUtilityText, type UtilityTextPurpose, validateUtilityText } from "../utility-text-generation";
import { AppService } from "./app-service";
import { type ModelInvocationContext, providerAllowsMissingApiKey } from "./provider-model-support";

const extractChatCompletionText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return [];
      }
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") {
        return [record.text];
      }
      const nestedText = record.text;
      if (nestedText && typeof nestedText === "object" && !Array.isArray(nestedText)) {
        const value = (nestedText as Record<string, unknown>).value;
        if (typeof value === "string") {
          return [value];
        }
      }
      return [];
    })
    .join("")
    .trim();
};

const usageFromChatCompletion = (usage: unknown): RunTokenUsage => {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const raw = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  const inputTokens = Number(raw.prompt_tokens ?? raw.promptTokens ?? 0);
  const outputTokens = Number(raw.completion_tokens ?? raw.completionTokens ?? 0);
  const totalTokens = Number(raw.total_tokens ?? raw.totalTokens ?? inputTokens + outputTokens);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    ...(Number.isFinite(totalTokens) && totalTokens > 0 ? { totalTokens } : {}),
  };
};

const AZURE_LEGACY_REASONING_ASK_TEXT_MIN_COMPLETION_TOKENS = 24_000;
const isReasoningCompletionModelId = (modelId: string): boolean => /^(?:o\d|gpt-5)(?:$|[.\-_])/i.test(modelId.trim());

const resolveAzureLegacyAskTextCompletionTokenLimit = (modelId: string, requestedMaxTokens: number): number => {
  if (!isReasoningCompletionModelId(modelId)) {
    return requestedMaxTokens;
  }
  return Math.max(requestedMaxTokens, AZURE_LEGACY_REASONING_ASK_TEXT_MIN_COMPLETION_TOKENS);
};

/** Asks a configured model for a single text answer outside a run or chat. */
export class ModelTextService extends AppService<"settings"> {
  async resolveModelInvocationContext(modelId: string): Promise<ModelInvocationContext> {
    const model = this.db.getModel(modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    return {
      model,
      provider,
      apiKey: apiKey ?? "",
      providerConfig: JSON.parse(provider.configJson || "{}") as Record<string, unknown>,
      modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
      networkProxy: await this.services.settings.resolveNetworkProxyRuntimeConfig(),
    };
  }

  async askModelForUtilityText(
    cwd: string,
    context: ModelInvocationContext,
    input: {
      purpose: UtilityTextPurpose;
      prompt: string;
      systemPrompt: string;
      maxTokens: number;
      temperature: number;
      usageProjectId?: string;
      signal?: AbortSignal;
    },
  ): Promise<string> {
    const { model, provider, apiKey, providerConfig, modelConfig, networkProxy } = context;
    const devLogging = this.db.getSettings()[APP_SETTING_KEYS.enableDevMode] === "true"
      ? { logDirPath: this.logDirPath, runId: input.purpose }
      : undefined;
    const result = await generateUtilityText({
      ...input,
      cwd,
      providerType: provider.providerType,
      modelId: model.modelId,
      apiKey,
      apiBaseUrl: model.baseUrlOverride ?? provider.apiBaseUrl,
      config: providerConfig,
      modelConfig,
      networkProxy,
      devLogging,
    });
    // Account for a completed model call even when its output fails validation.
    this.recordStandaloneModelUsage(input.usageProjectId, provider, model, result.usage);
    return validateUtilityText(result.text, input.purpose);
  }

  async askModelForText(
    cwd: string,
    context: ModelInvocationContext,
    input: {
      prompt: string;
      systemPrompt: string;
      maxTokens: number;
      temperature: number;
      usageProjectId?: string;
    },
  ): Promise<string> {
    const { model, provider, apiKey, providerConfig, modelConfig, networkProxy } = context;
    const settings = this.db.getSettings();
    const devLogging =
      settings[APP_SETTING_KEYS.enableDevMode] === "true"
        ? {
            logDirPath: this.logDirPath,
            runId: "ask-text",
            sessionType: "run" as const,
          }
        : undefined;
    if (devLogging) {
      mkdirSync(this.logDirPath, { recursive: true });
    }
    if (provider.providerType === "codex-cli") {
      const result = await (await loadCodexProvider()).generateAskTextResultWithCodexCli({
        cwd,
        prompt: [input.systemPrompt, input.prompt].filter((part) => part.trim()).join("\n\n"),
        modelId: model.modelId,
        config: providerConfig,
        modelConfig,
        networkProxy,
        devLogging,
      });
      this.recordStandaloneModelUsage(input.usageProjectId, provider, model, result.usage);
      return result.text.trim();
    }

    if (provider.providerType === "claude-code") {
      const result = await (await loadClaudeProvider()).generateAskTextResultWithClaudeCode({
        cwd,
        prompt: [input.systemPrompt, input.prompt].filter((part) => part.trim()).join("\n\n"),
        modelId: model.modelId,
        config: providerConfig,
        networkProxy,
      });
      this.recordStandaloneModelUsage(input.usageProjectId, provider, model, result.usage);
      return result.text.trim();
    }

    if (provider.providerType === "cursor-agent") {
      const result = await (await loadCursorProvider()).generateAskTextResultWithCursorAgent({
        cwd,
        prompt: [input.systemPrompt, input.prompt].filter((part) => part.trim()).join("\n\n"),
        modelId: model.modelId,
        config: providerConfig,
        modelConfig,
        devLogging,
      });
      this.recordStandaloneModelUsage(input.usageProjectId, provider, model, result.usage);
      return result.text.trim();
    }

    if (provider.providerType === "azure-legacy") {
      const baseURL = (model.baseUrlOverride ?? provider.apiBaseUrl)?.trim();
      if (!baseURL) {
        throw new Error("Azure Legacy requires a deployment base URL on the provider or model.");
      }
      const azureProvider = await loadAzureLegacyProvider();
      const devLogger = azureProvider.createAzureLegacyDevLogger({
        logDirPath: devLogging?.logDirPath,
        runId: devLogging?.runId ?? "ask-text",
        providerType: provider.providerType,
        modelId: model.modelId,
        sessionType: devLogging?.sessionType ?? "run",
      });
      const client = azureProvider.createAzureLegacyClientFromParts(
        baseURL,
        apiKey,
        providerConfig,
        devLogger.enabled ? devLogger.createLoggedFetch() : undefined,
        networkProxy,
      );
      const completion = await client.chat.completions.create({
        model: model.modelId,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.prompt },
        ],
        max_completion_tokens: resolveAzureLegacyAskTextCompletionTokenLimit(model.modelId, input.maxTokens),
        temperature: input.temperature,
      });
      const choice = completion.choices[0];
      const text = extractChatCompletionText(choice?.message?.content);
      if (!text && choice?.finish_reason === "length") {
        throw new Error(
          "Azure Legacy returned an empty response after exhausting the completion token budget. Try a smaller diff or a model with lower reasoning effort.",
        );
      }
      this.recordStandaloneModelUsage(input.usageProjectId, provider, model, usageFromChatCompletion(completion.usage));
      return text;
    }

    const result = await (await loadAiSdkProvider()).generateAskTextResultWithAiSdk({
      providerType: provider.providerType === "openrouter" ? "openrouter" : "ai-sdk",
      modelId: model.modelId,
      apiKey,
      apiBaseUrl: (model.baseUrlOverride ?? provider.apiBaseUrl)?.trim(),
      config: providerConfig,
      modelConfig,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      networkProxy,
      devLogging,
    });
    this.recordStandaloneModelUsage(input.usageProjectId, provider, model, result.usage);
    return result.text.trim();
  }

  private recordStandaloneModelUsage(
    projectId: string | undefined,
    provider: Pick<ProviderAccountRecord, "providerType">,
    model: Pick<ModelRecord, "modelId">,
    usage: RunTokenUsage,
  ): void {
    if (!projectId || (usage.inputTokens === 0 && usage.outputTokens === 0)) {
      return;
    }
    const tracker: UsageReportTracker = {
      reportedUsage: { ...EMPTY_REPORTED_TOKEN_USAGE },
      attribution: { providerType: provider.providerType, modelId: model.modelId },
    };
    for (const delta of advanceUsageTracker(tracker, usage)) {
      this.db.recordProjectTokenUsage(projectId, "model-call", crypto.randomUUID(), delta.inputTokensDelta, delta.outputTokensDelta, delta.attribution);
    }
  }
}
