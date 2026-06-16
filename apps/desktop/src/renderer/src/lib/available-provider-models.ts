import type { ProviderAvailableModel } from "@buildwarden/shared";
import type { ProviderModelsOpenPanel } from "../components/app/settings-provider-models-tab";

export type AvailableProviderModelsStatus = "idle" | "loading" | "loaded" | "error";

export interface AvailableProviderModelsState {
  status: AvailableProviderModelsStatus;
  models: readonly ProviderAvailableModel[];
  errorMessage: string | null;
}

export const EMPTY_AVAILABLE_PROVIDER_MODELS_STATE: AvailableProviderModelsState = {
  status: "idle",
  models: [],
  errorMessage: null,
};

export const shouldRequestAvailableProviderModels = (
  openPanel: ProviderModelsOpenPanel,
  selectedProviderId: string,
  state: AvailableProviderModelsState | undefined,
): boolean => {
  if (openPanel !== "model" || !selectedProviderId) {
    return false;
  }
  return !state || state.status === "idle";
};
