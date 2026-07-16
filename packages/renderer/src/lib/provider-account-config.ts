import {
  PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY,
  PROVIDER_CONFIG_AZURE_API_VERSION_KEY,
  PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY,
  PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CODEX_HOME_PATH_KEY,
  PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY,
  PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY,
  type ProviderType,
  type UnifiedProviderFamily,
} from "@buildwarden/shared";

export interface ProviderAccountConfigDraft {
  providerType: ProviderType;
  providerFamily: UnifiedProviderFamily;
  providerConfigJson: string;
  providerAzureApiVersion: string;
  codexBinaryPath: string;
  codexHomePath: string;
  detectedCodexBinaryPath: string | null;
  claudeBinaryPath: string;
  claudeLaunchArgs: string;
  detectedClaudeBinaryPath: string | null;
  cursorBinaryPath: string;
  cursorApiEndpoint: string;
  detectedCursorBinaryPath: string | null;
}

const setOrDelete = (config: Record<string, unknown>, key: string, value: string): void => {
  if (value) {
    config[key] = value;
  } else {
    delete config[key];
  }
};

const parseAiSdkConfigJson = (json: string): Record<string, unknown> => {
  try {
    return JSON.parse(json.trim() || "{}") as Record<string, unknown>;
  } catch {
    throw new Error("Provider configuration (JSON) is invalid.");
  }
};

/**
 * Builds the persisted provider-account config for the draft form state.
 * Provider-specific keys are only kept for the matching provider type; all
 * other provider keys are removed so stale values never leak between types.
 */
export const buildProviderAccountConfig = (draft: ProviderAccountConfigDraft): Record<string, unknown> => {
  const isType = (type: ProviderType): boolean => draft.providerType === type;
  const config: Record<string, unknown> = isType("ai-sdk") ? parseAiSdkConfigJson(draft.providerConfigJson) : {};

  if (isType("ai-sdk")) {
    config[PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY] = draft.providerFamily;
  }

  setOrDelete(
    config,
    PROVIDER_CONFIG_AZURE_API_VERSION_KEY,
    isType("azure-legacy") ? draft.providerAzureApiVersion.trim() || "2024-06-01" : "",
  );

  const codexBinary = isType("codex-cli") ? draft.codexBinaryPath.trim() || draft.detectedCodexBinaryPath?.trim() || "" : "";
  setOrDelete(config, PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY, codexBinary);
  setOrDelete(config, PROVIDER_CONFIG_CODEX_HOME_PATH_KEY, isType("codex-cli") ? draft.codexHomePath.trim() : "");

  const claudeBinary = isType("claude-code") ? draft.claudeBinaryPath.trim() || draft.detectedClaudeBinaryPath?.trim() || "" : "";
  setOrDelete(config, PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY, claudeBinary);
  setOrDelete(config, PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY, isType("claude-code") ? draft.claudeLaunchArgs.trim() : "");

  const cursorBinary = isType("cursor-agent") ? draft.cursorBinaryPath.trim() || draft.detectedCursorBinaryPath?.trim() || "" : "";
  setOrDelete(config, PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY, cursorBinary);
  setOrDelete(config, PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY, isType("cursor-agent") ? draft.cursorApiEndpoint.trim() : "");

  return config;
};
