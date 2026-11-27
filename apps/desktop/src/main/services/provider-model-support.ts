import {
  getAiSdkProviderFamilyFromConfigJson,
  isKnownProviderType,
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

/** Why this version cannot run an agent for the provider, or null when it can. */
export const unknownProviderReason = (provider: ProviderAccountRecord): string | null =>
  isKnownProviderType(provider.providerType)
    ? null
    : `${provider.label} uses a provider type this version of BuildWarden does not support (${provider.providerType}).`;

/** Refuses before anything starts: a worker would otherwise run workspace setup and then fail. */
export const requireKnownProvider = (provider: ProviderAccountRecord): void => {
  const reason = unknownProviderReason(provider);
  if (reason) throw new Error(reason);
};

export const providerSupportsInterruptedRunRecovery = (providerType: ProviderAccountRecord["providerType"]): boolean =>
  providerType === "codex-cli" || providerType === "claude-code" || providerType === "cursor-agent" || providerType === "acp";

/** A subscription usage window that is used up. */
export interface ProviderLimitState {
  reason: string;
  resetsAt: string | null;
}
