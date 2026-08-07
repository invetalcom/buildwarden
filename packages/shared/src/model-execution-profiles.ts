import type {
  ModelExecutionControl,
  ModelExecutionControlId,
  ModelExecutionProfile,
  ProviderType,
} from "./index";
import type { UnifiedProviderFamily } from "./provider-metadata";

const emptyProfile = (): ModelExecutionProfile => ({ controls: [] });

export const formatModelExecutionOptionLabel = (value: string): string => {
  if (value === "xhigh") return "Extra high";
  return value[0]!.toUpperCase() + value.slice(1);
};

const control = (
  id: ModelExecutionControlId,
  label: string,
  values: readonly string[],
): ModelExecutionControl => ({
  id,
  label,
  defaultValue: "auto",
  options: [
    { value: "auto", label: "Provider default" },
    ...values.map((value) => ({ value, label: formatModelExecutionOptionLabel(value) })),
  ],
});

const reasoningProfile = (
  values: readonly string[],
  extraControls: readonly ModelExecutionControl[] = [],
): ModelExecutionProfile => ({
  controls: [control("reasoningEffort", "Effort", values), ...extraControls],
});

const thinkingProfile = (values: readonly string[]): ModelExecutionProfile => ({
  controls: [control("thinkingLevel", "Thinking", values)],
});

const codexFastControl = (): ModelExecutionControl => control("serviceTier", "Speed", ["fast"]);
const anthropicFastControl = (): ModelExecutionControl => control("speed", "Speed", ["standard", "fast"]);
const openAiServiceControl = (): ModelExecutionControl => control("serviceTier", "Service", ["default", "flex", "priority"]);

const normalizedModelId = (modelId: string): string => modelId.trim().toLowerCase();

const isSnapshotOrAlias = (modelId: string, baseId: string): boolean => {
  if (modelId === baseId || modelId === `${baseId}-latest`) return true;
  const suffix = modelId.slice(baseId.length);
  return modelId.startsWith(baseId) && (/^-\d{4}-\d{2}-\d{2}$/.test(suffix) || /^-\d{8}$/.test(suffix));
};

const matchesAny = (modelId: string, baseIds: readonly string[]): boolean =>
  baseIds.some((baseId) => isSnapshotOrAlias(modelId, baseId));

const knownCodexProfile = (modelId: string): ModelExecutionProfile => {
  if (matchesAny(modelId, ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra"])) {
    return reasoningProfile(["low", "medium", "high", "xhigh", "max", "ultra"], [codexFastControl()]);
  }
  if (matchesAny(modelId, ["gpt-5.6-luna"])) {
    return reasoningProfile(["low", "medium", "high", "xhigh", "max"], [codexFastControl()]);
  }
  if (matchesAny(modelId, ["gpt-5.5", "gpt-5.4"])) {
    return reasoningProfile(["low", "medium", "high", "xhigh"], [codexFastControl()]);
  }
  if (matchesAny(modelId, ["gpt-5.4-mini"])) {
    return reasoningProfile(["low", "medium", "high", "xhigh"]);
  }
  if (matchesAny(modelId, ["gpt-5.3-codex-spark"])) {
    return reasoningProfile(["low", "medium", "high", "xhigh"]);
  }
  return emptyProfile();
};

const knownClaudeEfforts = (modelId: string): readonly string[] | null => {
  if (matchesAny(modelId, [
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-mythos-preview",
  ])) {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  if (matchesAny(modelId, ["claude-opus-4-6", "claude-sonnet-4-6"])) {
    return ["low", "medium", "high", "max"];
  }
  if (matchesAny(modelId, ["claude-opus-4-5"])) {
    return ["low", "medium", "high"];
  }
  return null;
};

const knownClaudeProfile = (providerType: ProviderType, modelId: string): ModelExecutionProfile => {
  const isClaudeCodeEffortAlias = providerType === "claude-code" && matchesAny(modelId, [
    "best",
    "fable",
    "opus",
    "opus[1m]",
    "sonnet",
    "sonnet[1m]",
  ]);
  const efforts = isClaudeCodeEffortAlias
    ? ["low", "medium", "high", "xhigh", "max"]
    : knownClaudeEfforts(modelId);
  if (!efforts) return emptyProfile();
  const supportsFast = providerType === "claude-code"
    ? matchesAny(modelId, ["claude-opus-4-8"])
    : matchesAny(modelId, ["claude-opus-5", "claude-opus-4-8"]);
  return reasoningProfile(efforts, supportsFast ? [anthropicFastControl()] : []);
};

const knownOpenAiApiProfile = (modelId: string): ModelExecutionProfile => {
  if (matchesAny(modelId, ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])) {
    return reasoningProfile(["none", "low", "medium", "high", "xhigh", "max"], [openAiServiceControl()]);
  }
  if (matchesAny(modelId, ["gpt-5.5-pro"])) {
    return reasoningProfile(["medium", "high", "xhigh"], [openAiServiceControl()]);
  }
  if (matchesAny(modelId, ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"])) {
    return reasoningProfile(["none", "low", "medium", "high", "xhigh"], [openAiServiceControl()]);
  }
  if (matchesAny(modelId, ["gpt-5-mini"])) {
    return reasoningProfile(["minimal", "low", "medium", "high"], [openAiServiceControl()]);
  }
  if (matchesAny(modelId, ["gpt-5.3-codex"])) {
    return reasoningProfile(["low", "medium", "high", "xhigh"]);
  }
  return emptyProfile();
};

const knownGoogleProfile = (modelId: string): ModelExecutionProfile => {
  if (matchesAny(modelId, ["gemini-3.1-pro-preview"])) {
    return thinkingProfile(["low", "medium", "high"]);
  }
  if (matchesAny(modelId, [
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3-flash",
    "gemini-3-flash-preview",
  ])) {
    return thinkingProfile(["minimal", "low", "medium", "high"]);
  }
  if (matchesAny(modelId, ["gemini-3-pro-preview"])) {
    return thinkingProfile(["low", "high"]);
  }
  return emptyProfile();
};

const knownXaiProfile = (modelId: string): ModelExecutionProfile => {
  if (matchesAny(modelId, ["grok-4.5"])) {
    return reasoningProfile(["low", "medium", "high"]);
  }
  if (matchesAny(modelId, ["grok-4.20-multi-agent"])) {
    return reasoningProfile(["low", "medium", "high", "xhigh"]);
  }
  if (matchesAny(modelId, ["grok-4.3"])) {
    return reasoningProfile(["none", "low", "medium", "high"]);
  }
  return emptyProfile();
};

/**
 * Conservative fallback metadata for configured models that predate provider discovery.
 * Provider-advertised profiles always take precedence; unknown/custom models deliberately
 * expose no controls instead of treating an SDK's broad input type as a capability list.
 */
export const getKnownModelExecutionProfile = (
  providerType: ProviderType,
  providerFamily: UnifiedProviderFamily | null,
  modelId: string,
): ModelExecutionProfile => {
  if (providerType === "azure-legacy" || providerType === "cursor-agent") return emptyProfile();
  const normalized = normalizedModelId(modelId);
  if (!normalized) return emptyProfile();
  if (providerType === "codex-cli") return knownCodexProfile(normalized);
  if (providerType === "claude-code") return knownClaudeProfile(providerType, normalized);
  if (providerType !== "ai-sdk") return emptyProfile();
  if (providerFamily === "openai") return knownOpenAiApiProfile(normalized);
  if (providerFamily === "anthropic") return knownClaudeProfile(providerType, normalized);
  if (providerFamily === "google") return knownGoogleProfile(normalized);
  if (providerFamily === "xai") return knownXaiProfile(normalized);
  return emptyProfile();
};
