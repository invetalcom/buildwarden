import type {
  ModelExecutionControl,
  ModelExecutionControlId,
  ModelExecutionProfile,
  ProviderType,
} from "./index";
import type { UnifiedProviderFamily } from "./provider-metadata";

/** Model config key holding the execution controls a provider advertised for the model. */
export const MODEL_CONFIG_EXECUTION_PROFILE_KEY = "buildwardenExecutionProfile";

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

const discoveredOption = (value: string, label: string, description?: string) => ({ value, label, description });
const autoOption = discoveredOption("auto", "Provider default", "Let the selected provider and model choose its default.");

const discoveredControl = (
  id: ModelExecutionControlId,
  label: string,
  options: ModelExecutionControl["options"],
  defaultValue = "auto",
): ModelExecutionControl => ({ id, label, options: [autoOption, ...options.filter((entry) => entry.value !== "auto")], defaultValue });

const normalizeExecutionProfile = (value: unknown): ModelExecutionProfile | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawControls = (value as { controls?: unknown }).controls;
  if (!Array.isArray(rawControls)) return null;
  const validIds = new Set<ModelExecutionControlId>([
    "reasoningEffort",
    "serviceTier",
    "speed",
    "thinkingLevel",
    "contextMode",
    "workflowMode",
  ]);
  const controls = rawControls.flatMap((candidate): ModelExecutionControl[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const entry = candidate as Record<string, unknown>;
    if (!validIds.has(entry.id as ModelExecutionControlId) || typeof entry.label !== "string" || !Array.isArray(entry.options)) return [];
    const options = entry.options.flatMap((candidateOption) => {
      if (!candidateOption || typeof candidateOption !== "object" || Array.isArray(candidateOption)) return [];
      const rawOption = candidateOption as Record<string, unknown>;
      if (typeof rawOption.value !== "string" || typeof rawOption.label !== "string") return [];
      return [{
        value: rawOption.value,
        label: rawOption.label,
        ...(typeof rawOption.description === "string" ? { description: rawOption.description } : {}),
      }];
    });
    if (options.length === 0) return [];
    return [{
      id: entry.id as ModelExecutionControlId,
      label: entry.label,
      options: options.some((entryOption) => entryOption.value === "auto") ? options : [autoOption, ...options],
      ...(typeof entry.defaultValue === "string" ? { defaultValue: entry.defaultValue } : {}),
    }];
  });
  const source = (value as { source?: unknown }).source;
  return {
    controls,
    ...(source === "provider" || source === "catalog" ? { source } : {}),
  };
};

const parseModelConfig = (config: string | Record<string, unknown> | null | undefined) => {
  if (!config) return {} as Record<string, unknown>;
  if (typeof config !== "string") return config;
  try {
    const parsed = JSON.parse(config) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const cursorControlId = (id: string, category: string): ModelExecutionControl["id"] | null => {
  if (/thought|reason|effort/i.test(`${id} ${category}`)) return "reasoningEffort";
  if (/context/i.test(id)) return "contextMode";
  if (/speed|fast/i.test(id)) return "speed";
  return null;
};

const cursorControlLabel = (id: ModelExecutionControl["id"]): string => {
  if (id === "reasoningEffort") return "Effort";
  if (id === "contextMode") return "Context";
  return "Speed";
};

const cursorProfileFromConfig = (config: Record<string, unknown>): ModelExecutionProfile | null => {
  const rawOptions = config.cursorAcpConfigOptions;
  if (!Array.isArray(rawOptions)) return null;
  const controls = rawOptions.flatMap((candidate): ModelExecutionControl[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const entry = candidate as Record<string, unknown>;
    if (entry.type !== "select" || typeof entry.id !== "string" || !Array.isArray(entry.options)) return [];
    const category = typeof entry.category === "string" ? entry.category : "";
    const id = cursorControlId(entry.id, category);
    if (!id) return [];
    const options = entry.options.flatMap((candidateOption) => {
      if (!candidateOption || typeof candidateOption !== "object" || Array.isArray(candidateOption)) return [];
      const rawOption = candidateOption as Record<string, unknown>;
      let value: string | null = null;
      if (typeof rawOption.value === "string") value = rawOption.value;
      else if (typeof rawOption.id === "string") value = rawOption.id;
      if (!value) return [];
      let label = value;
      if (typeof rawOption.name === "string") label = rawOption.name;
      else if (typeof rawOption.label === "string") label = rawOption.label;
      return [discoveredOption(value, label, typeof rawOption.description === "string" ? rawOption.description : undefined)];
    });
    return options.length > 0 ? [discoveredControl(id, cursorControlLabel(id), options)] : [];
  });
  return controls.length > 0 ? { controls } : null;
};

/** Returns the controls a configured model actually supports, using discovery metadata when available. */
export const resolveModelExecutionProfile = (
  providerType: ProviderType,
  providerFamily: UnifiedProviderFamily | null,
  modelId: string,
  modelConfig?: string | Record<string, unknown> | null,
): ModelExecutionProfile => {
  if (providerType === "azure-legacy") return { controls: [] };
  const config = parseModelConfig(modelConfig);
  const discovered = normalizeExecutionProfile(config[MODEL_CONFIG_EXECUTION_PROFILE_KEY]);
  if (discovered?.source === "provider") return discovered;
  if (providerType === "cursor-agent") {
    return discovered ?? cursorProfileFromConfig(config) ?? { controls: [] };
  }
  const known = getKnownModelExecutionProfile(providerType, providerFamily, modelId);
  if (known.controls.length > 0 || discovered?.source === "catalog") return known;
  // Older Codex discovery rows had no provenance. An unknown model could only
  // receive such a profile from app-server, so it remains safe to trust.
  if (providerType === "codex-cli" && discovered) return discovered;
  return { controls: [] };
};

