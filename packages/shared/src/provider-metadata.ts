import type { ProviderCapabilityMap, ProviderType } from "./index";

export type UnifiedProviderFamily = "openai" | "anthropic" | "google" | "xai" | "openai-compatible";

/**
 * Where a model preset is offered in the UI. Use the same literal values when adding a new model so it appears
 * only for matching provider accounts (e.g. Claude models never appear for a Codex-only connection).
 * Add `ai-sdk-adapter-curated` to surface a model in `AI_SDK_RECOMMENDED_MODEL_IDS` (AI SDK `listRecommendedModels`).
 * Otherwise edit this file and bump {@link DEFAULT_ADD_MODEL_DRAFT_PRESET_ID} when promoting a new “default”
 * for the add-model form.
 */
export type ModelPresetTag =
  | "ai-sdk:openai"
  | "ai-sdk:anthropic"
  | "ai-sdk:google"
  | "ai-sdk:xai"
  | "ai-sdk-adapter-curated"
  | "codex-cli"
  | "claude-code"
  | "cursor-agent"
  | "azure-legacy";

/** @see ModelPresetTag */
export type ProviderConnectionKind = "local-sdk-cli" | "bring-your-own-key";

export const PROVIDER_CONNECTION_KIND_LABELS: Record<ProviderConnectionKind, string> = {
  "local-sdk-cli": "Local SDK or CLI",
  "bring-your-own-key": "Bring your own key",
};

export const PROVIDER_TYPES_BY_CONNECTION_KIND: Record<ProviderConnectionKind, readonly ProviderType[]> = {
  "local-sdk-cli": ["codex-cli", "claude-code", "cursor-agent"],
  "bring-your-own-key": ["ai-sdk", "azure-legacy"],
};

export function connectionKindForProviderType(providerType: ProviderType): ProviderConnectionKind {
  return PROVIDER_TYPES_BY_CONNECTION_KIND["local-sdk-cli"].includes(providerType)
    ? "local-sdk-cli"
    : "bring-your-own-key";
}

/**
 * For preset matching, OpenAI-compatible endpoints use the same suggested models as the OpenAI family.
 */
function resolvedAiSdkFamilyForPresets(
  family: UnifiedProviderFamily | undefined,
): "openai" | "anthropic" | "google" | "xai" {
  const f = family ?? "openai";
  if (f === "openai-compatible") return "openai";
  if (f === "openai" || f === "anthropic" || f === "google" || f === "xai") return f;
  return "openai";
}

// Must match PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY in index.ts
const AI_SDK_FAMILY_CONFIG_KEY = "providerFamily" as const;

/**
 * Read stored AI SDK provider family from a provider account's configJson.
 * Prefer this over re-parsing in the renderer; values match buildwarden's persisted provider form.
 */
export function getAiSdkProviderFamilyFromConfigJson(configJson: string): UnifiedProviderFamily {
  try {
    const config = JSON.parse(configJson || "{}") as Record<string, unknown>;
    const raw = config[AI_SDK_FAMILY_CONFIG_KEY];
    return raw === "openai" || raw === "anthropic" || raw === "google" || raw === "xai" || raw === "openai-compatible"
      ? raw
      : "openai";
  } catch {
    return "openai";
  }
}

const DIRECT_PROVIDER_BY_PRESET_TAG: Partial<Record<ModelPresetTag, ProviderType>> = {
  "azure-legacy": "azure-legacy",
  "claude-code": "claude-code",
  "codex-cli": "codex-cli",
  "cursor-agent": "cursor-agent",
};

function modelPresetTagMatches(
  tag: ModelPresetTag,
  providerType: ProviderType,
  aiSdkFamily: UnifiedProviderFamily | undefined,
): boolean {
  const directProvider = DIRECT_PROVIDER_BY_PRESET_TAG[tag];
  if (directProvider) {
    return providerType === directProvider;
  }
  if (providerType !== "ai-sdk" || !tag.startsWith("ai-sdk:")) {
    return false;
  }
  return resolvedAiSdkFamilyForPresets(aiSdkFamily) === tag.slice("ai-sdk:".length);
}

export function modelPresetAppliesToProvider(
  preset: UnifiedModelPreset,
  providerType: ProviderType,
  aiSdkFamily: UnifiedProviderFamily | undefined,
): boolean {
  return preset.tags.some((tag) => modelPresetTagMatches(tag, providerType, aiSdkFamily));
}

/**
 * Suggested models for a provider account. Only {@link UNIFIED_MODEL_PRESETS} that apply to the given
 * connection and (for AI SDK) provider family.
 */
export function getModelPresetsForProvider(
  providerType: ProviderType,
  aiSdkFamily: UnifiedProviderFamily | undefined,
): UnifiedModelPreset[] {
  return UNIFIED_MODEL_PRESETS.filter((preset) => modelPresetAppliesToProvider(preset, providerType, aiSdkFamily));
}

const UNIFIED_MODEL_PRESET_GROUP_ORDER: UnifiedModelPresetGroup[] = ["openai", "anthropic", "google", "xai", "coding"];

export function getModelPresetsByGroupForProvider(
  providerType: ProviderType,
  aiSdkFamily: UnifiedProviderFamily | undefined,
): Record<UnifiedModelPresetGroup, UnifiedModelPreset[]> {
  const map: Record<UnifiedModelPresetGroup, UnifiedModelPreset[]> = {
    openai: [],
    anthropic: [],
    google: [],
    xai: [],
    coding: [],
  };
  for (const preset of getModelPresetsForProvider(providerType, aiSdkFamily)) {
    map[preset.group].push(preset);
  }
  return map;
}

export function emptyModelPresetsByGroup(): Record<UnifiedModelPresetGroup, UnifiedModelPreset[]> {
  return {
    openai: [],
    anthropic: [],
    google: [],
    xai: [],
    coding: [],
  };
}

export type UnifiedModelPresetGroup = "openai" | "anthropic" | "google" | "xai" | "coding";

export interface UnifiedModelPreset {
  readonly modelId: string;
  readonly displayName: string;
  readonly group: UnifiedModelPresetGroup;
  /** Which provider / AI SDK family contexts should list this preset */
  readonly tags: readonly ModelPresetTag[];
}

export const UNIFIED_MODEL_PRESET_GROUP_LABELS: Record<UnifiedModelPresetGroup, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  coding: "Coding & agents",
};

export const UNIFIED_MODEL_PRESETS: readonly UnifiedModelPreset[] = [
  {
    group: "coding",
    modelId: "default",
    displayName: "Cursor Auto",
    tags: ["cursor-agent"],
  },
  {
    group: "openai",
    modelId: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    tags: ["ai-sdk:openai", "codex-cli", "azure-legacy", "ai-sdk-adapter-curated"],
  },
  { group: "openai", modelId: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", tags: ["ai-sdk:openai", "codex-cli", "azure-legacy"] },
  {
    group: "openai",
    modelId: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    tags: ["ai-sdk:openai", "codex-cli", "azure-legacy", "ai-sdk-adapter-curated"],
  },
  { group: "openai", modelId: "gpt-5.5", displayName: "GPT-5.5", tags: ["ai-sdk:openai", "codex-cli", "azure-legacy"] },
  { group: "openai", modelId: "gpt-5.5-pro", displayName: "GPT-5.5 Pro", tags: ["ai-sdk:openai", "codex-cli", "azure-legacy"] },
  { group: "openai", modelId: "gpt-5.4", displayName: "GPT-5.4", tags: ["ai-sdk:openai", "codex-cli", "azure-legacy"] },
  {
    group: "openai",
    modelId: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    tags: ["ai-sdk:openai", "codex-cli", "azure-legacy"],
  },
  { group: "openai", modelId: "gpt-5-mini", displayName: "GPT-5 mini", tags: ["ai-sdk:openai", "codex-cli", "azure-legacy"] },
  {
    group: "anthropic",
    modelId: "sonnet",
    displayName: "Claude Code Sonnet (auto)",
    tags: ["claude-code", "ai-sdk:anthropic"],
  },
  {
    group: "anthropic",
    modelId: "opus",
    displayName: "Claude Code Opus (auto)",
    tags: ["claude-code", "ai-sdk:anthropic"],
  },
  {
    group: "anthropic",
    modelId: "haiku",
    displayName: "Claude Code Haiku (auto)",
    tags: ["claude-code", "ai-sdk:anthropic"],
  },
  {
    group: "anthropic",
    modelId: "opusplan",
    displayName: "Claude Code Opus Plan (auto)",
    tags: ["claude-code", "ai-sdk:anthropic"],
  },
  {
    group: "anthropic",
    modelId: "fable",
    displayName: "Claude Code Fable (auto)",
    tags: ["claude-code"],
  },
  {
    group: "anthropic",
    modelId: "claude-fable-5",
    displayName: "Claude Fable 5",
    tags: ["claude-code", "ai-sdk:anthropic"],
  },
  {
    group: "anthropic",
    modelId: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    tags: ["claude-code", "ai-sdk:anthropic", "ai-sdk-adapter-curated"],
  },
  {
    group: "anthropic",
    modelId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    tags: ["claude-code", "ai-sdk:anthropic"],
  },
  {
    group: "anthropic",
    modelId: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    tags: ["claude-code", "ai-sdk:anthropic"],
  },
  {
    group: "anthropic",
    modelId: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    tags: ["claude-code", "ai-sdk:anthropic"],
  },
  {
    group: "anthropic",
    modelId: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    tags: ["claude-code", "ai-sdk:anthropic"],
  },
  { group: "google", modelId: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", tags: ["ai-sdk:google"] },
  {
    group: "google",
    modelId: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    tags: ["ai-sdk:google", "ai-sdk-adapter-curated"],
  },
  { group: "google", modelId: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", tags: ["ai-sdk:google"] },
  { group: "google", modelId: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", tags: ["ai-sdk:google"] },
  { group: "xai", modelId: "grok-4.5", displayName: "Grok 4.5", tags: ["ai-sdk:xai"] },
  { group: "xai", modelId: "grok-4.3", displayName: "Grok 4.3", tags: ["ai-sdk:xai"] },
  { group: "xai", modelId: "grok-4.1-fast-reasoning", displayName: "Grok 4.1 Fast (Reasoning)", tags: ["ai-sdk:xai"] },
  { group: "xai", modelId: "grok-4.1-fast-non-reasoning", displayName: "Grok 4.1 Fast (Non-Reasoning)", tags: ["ai-sdk:xai"] },
  {
    group: "coding",
    modelId: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    tags: ["ai-sdk:openai", "codex-cli", "azure-legacy", "ai-sdk-adapter-curated"],
  },
  {
    group: "coding",
    modelId: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    tags: ["ai-sdk:openai", "codex-cli", "azure-legacy"],
  },
] as const;

/** Ids in {@link UNIFIED_MODEL_PRESETS} (tag `ai-sdk-adapter-curated`); `AiSdkProviderAdapter#listRecommendedModels`. */
export const AI_SDK_RECOMMENDED_MODEL_IDS: readonly string[] = UNIFIED_MODEL_PRESETS.filter((preset) =>
  preset.tags.includes("ai-sdk-adapter-curated"),
).map((preset) => preset.modelId);

/**
 * Default “Add model” form + App settings draft. Point at an existing `modelId` in {@link UNIFIED_MODEL_PRESETS}.
 * When a new model becomes the product default, add it to the catalog and set this to its id.
 */
export const DEFAULT_ADD_MODEL_DRAFT_PRESET_ID: string = "gpt-5.6-sol";

export const DEFAULT_ADD_MODEL_DRAFT: { modelId: string; displayName: string } = (() => {
  const preset = UNIFIED_MODEL_PRESETS.find((p) => p.modelId === DEFAULT_ADD_MODEL_DRAFT_PRESET_ID);
  if (!preset) {
    return { modelId: DEFAULT_ADD_MODEL_DRAFT_PRESET_ID, displayName: DEFAULT_ADD_MODEL_DRAFT_PRESET_ID };
  }
  return { modelId: preset.modelId, displayName: preset.displayName };
})();

/**
 * Suggested `modelId` list for Codex CLI `listRecommendedModels`: `codex-cli`-tagged presets, with `coding` group
 * first, then the rest in catalog order.
 */
export function getCodexCliRecommendedModelIds(): string[] {
  return UNIFIED_MODEL_PRESETS
    .map((preset, index) => ({ preset, index }))
    .filter(({ preset }) => preset.tags.includes("codex-cli"))
    .sort((a, b) => {
      const aFirst = a.preset.group === "coding" ? 0 : 1;
      const bFirst = b.preset.group === "coding" ? 0 : 1;
      if (aFirst !== bFirst) {
        return aFirst - bFirst;
      }
      return a.index - b.index;
    })
    .map(({ preset }) => preset.modelId);
}

export const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilityMap = {
  supportsStreaming: true,
  supportsTools: false,
  supportsCustomBaseUrl: false,
};

const PROVIDER_CAPABILITIES_BY_TYPE: Record<ProviderType, ProviderCapabilityMap> = {
  "ai-sdk": {
    supportsStreaming: true,
    supportsTools: true,
    supportsCustomBaseUrl: true,
  },
  "azure-legacy": {
    supportsStreaming: true,
    supportsTools: true,
    supportsCustomBaseUrl: true,
  },
  "codex-cli": {
    supportsStreaming: true,
    supportsTools: true,
    supportsCustomBaseUrl: false,
  },
  "claude-code": {
    supportsStreaming: true,
    supportsTools: true,
    supportsCustomBaseUrl: false,
  },
  "cursor-agent": {
    supportsStreaming: true,
    supportsTools: true,
    supportsCustomBaseUrl: false,
  },
};

export const getDefaultProviderCapabilities = (providerType: ProviderType): ProviderCapabilityMap => ({
  ...PROVIDER_CAPABILITIES_BY_TYPE[providerType],
});

export function unifiedModelPresetsByGroup(): Record<UnifiedModelPresetGroup, UnifiedModelPreset[]> {
  const map: Record<UnifiedModelPresetGroup, UnifiedModelPreset[]> = {
    openai: [],
    anthropic: [],
    google: [],
    xai: [],
    coding: [],
  };
  for (const preset of UNIFIED_MODEL_PRESETS) {
    map[preset.group].push(preset);
  }
  return map;
}

export function unifiedModelPresetGroupsInOrder(): UnifiedModelPresetGroup[] {
  return UNIFIED_MODEL_PRESET_GROUP_ORDER;
}
