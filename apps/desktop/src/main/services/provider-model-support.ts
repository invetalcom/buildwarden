import {
  getAiSdkProviderFamilyFromConfigJson,
  type ModelRecord,
  type NetworkProxyRuntimeConfig,
  type ProviderAccountRecord,
} from "@buildwarden/shared";

export type ModelInvocationContext = {
  model: ModelRecord;
  provider: ProviderAccountRecord;
  apiKey: string;
  providerConfig: Record<string, unknown>;
  modelConfig: Record<string, unknown>;
  networkProxy: NetworkProxyRuntimeConfig | undefined;
};

export const parseProviderConfigJson = (configJson: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(configJson || "{}") as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const providerAllowsMissingApiKey = (provider: ProviderAccountRecord): boolean =>
  provider.providerType === "codex-cli" ||
  provider.providerType === "claude-code" ||
  provider.providerType === "cursor-agent" ||
  provider.providerType === "acp" ||
  (provider.providerType === "ai-sdk" && getAiSdkProviderFamilyFromConfigJson(provider.configJson) === "openai-compatible");

export const assertModelBelongsToProvider = (model: ModelRecord, provider: ProviderAccountRecord): void => {
  if (model.providerAccountId !== provider.id) {
    throw new Error("The selected model does not belong to the selected provider account.");
  }
};

export const providerSupportsInterruptedRunRecovery = (providerType: ProviderAccountRecord["providerType"]): boolean =>
  providerType === "codex-cli" || providerType === "claude-code" || providerType === "cursor-agent" || providerType === "acp";

/** A subscription usage window that is used up. */
export interface ProviderLimitState {
  reason: string;
  resetsAt: string | null;
}
