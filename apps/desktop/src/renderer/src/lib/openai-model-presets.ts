export {
  connectionKindForProviderType,
  DEFAULT_ADD_MODEL_DRAFT,
  emptyModelPresetsByGroup,
  getAiSdkProviderFamilyFromConfigJson,
  getModelPresetsByGroupForProvider,
  getModelPresetsForProvider,
  PROVIDER_CONNECTION_KIND_LABELS,
  PROVIDER_TYPES_BY_CONNECTION_KIND,
  UNIFIED_MODEL_PRESET_GROUP_LABELS,
  unifiedModelPresetGroupsInOrder,
} from "@buildwarden/shared";

export const MODEL_PRESET_CUSTOM = "__custom__" as const;
