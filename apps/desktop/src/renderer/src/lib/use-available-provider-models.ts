import type { DesktopApi } from "@buildwarden/shared";
import { useCallback, useRef, useState } from "react";
import type { AvailableProviderModelsState } from "./available-provider-models";
import { reportRendererError } from "./report-renderer-error";

interface UseAvailableProviderModelsInput {
  buildwarden: DesktopApi | undefined;
}

export const useAvailableProviderModels = ({ buildwarden }: UseAvailableProviderModelsInput) => {
  const [availableModelsByProviderId, setAvailableModelsByProviderId] = useState<
    Record<string, AvailableProviderModelsState>
  >({});
  const availableModelsByProviderIdRef = useRef<Record<string, AvailableProviderModelsState>>({});
  const requestsInFlightRef = useRef<Set<string>>(new Set());
  availableModelsByProviderIdRef.current = availableModelsByProviderId;

  const ensureAvailableModels = useCallback(
    (providerAccountId: string) => {
      if (!providerAccountId) {
        return;
      }
      const current = availableModelsByProviderIdRef.current[providerAccountId];
      if (current?.status === "loading" || current?.status === "loaded" || requestsInFlightRef.current.has(providerAccountId)) {
        return;
      }
      if (!buildwarden) {
        setAvailableModelsByProviderId((previous) => ({
          ...previous,
          [providerAccountId]: {
            status: "error",
            models: [],
            errorMessage: "The Electron desktop bridge is unavailable.",
          },
        }));
        return;
      }

      requestsInFlightRef.current.add(providerAccountId);
      setAvailableModelsByProviderId((previous) => ({
        ...previous,
        [providerAccountId]: {
          status: "loading",
          models: previous[providerAccountId]?.models ?? [],
          errorMessage: null,
        },
      }));

      void buildwarden
        .listAvailableProviderModels({ providerAccountId })
        .then((result) => {
          setAvailableModelsByProviderId((previous) => ({
            ...previous,
            [providerAccountId]: {
              status: result.errorMessage ? "error" : "loaded",
              models: result.models,
              errorMessage: result.errorMessage ?? null,
            },
          }));
        })
        .catch((caught) => {
          reportRendererError("renderer.provider-models.available-models", caught, { providerAccountId });
          setAvailableModelsByProviderId((previous) => ({
            ...previous,
            [providerAccountId]: {
              status: "error",
              models: [],
              errorMessage: caught instanceof Error ? caught.message : "Available models could not be loaded.",
            },
          }));
        })
        .finally(() => {
          requestsInFlightRef.current.delete(providerAccountId);
        });
    },
    [buildwarden],
  );

  return {
    availableModelsByProviderId,
    availableModelsByProviderIdRef,
    ensureAvailableModels,
  };
};
