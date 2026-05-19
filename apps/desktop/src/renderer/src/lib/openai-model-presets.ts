export {
  AI_SDK_RECOMMENDED_MODEL_IDS,
  connectionKindForProviderType,
  DEFAULT_ADD_MODEL_DRAFT,
  DEFAULT_ADD_MODEL_DRAFT_PRESET_ID,
  emptyModelPresetsByGroup,
  getAiSdkProviderFamilyFromConfigJson,
  getCodexCliRecommendedModelIds,
  getModelPresetsByGroupForProvider,
  getModelPresetsForProvider,
  modelPresetAppliesToProvider,
  PROVIDER_CONNECTION_KIND_LABELS,
  PROVIDER_TYPES_BY_CONNECTION_KIND,
  UNIFIED_MODEL_PRESET_GROUP_LABELS,
  UNIFIED_MODEL_PRESETS,
  unifiedModelPresetGroupsInOrder,
  unifiedModelPresetsByGroup,
  type ModelPresetTag,
  type ProviderConnectionKind,
  type UnifiedModelPreset,
  type UnifiedModelPresetGroup,
} from "@easycode/shared";

export const MODEL_PRESET_CUSTOM = "__custom__" as const;
