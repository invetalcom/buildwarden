import type {
  ModelExecutionControl,
  ModelExecutionProfile,
  ProviderExecutionOptions,
  ProviderType,
  UnifiedProviderFamily,
} from "@buildwarden/shared";
import { buildRunReasoningInput } from "./app-model";

export type AutomationModelOption = {
  id: string;
  label: string;
  modelId: string;
  providerType: ProviderType;
  providerFamily: UnifiedProviderFamily | null;
  executionProfile?: ModelExecutionProfile;
};

export const automationEffortControl = (
  model: AutomationModelOption | undefined,
): ModelExecutionControl | undefined => model?.executionProfile?.controls.find(
  (control) => control.id === "reasoningEffort" || control.id === "thinkingLevel",
);

export const normalizeAutomationEffort = (
  model: AutomationModelOption | undefined,
  effort: string,
): string => {
  const control = automationEffortControl(model);
  if (!control || control.options.length === 0) return "auto";
  if (control.options.some((option) => option.value === effort)) return effort;
  if (control.defaultValue && control.options.some((option) => option.value === control.defaultValue)) {
    return control.defaultValue;
  }
  return control.options[0]!.value;
};

export const automationExecutionOptions = (
  model: AutomationModelOption | undefined,
  effort: string,
): ProviderExecutionOptions => {
  if (!model || !automationEffortControl(model)) return {};
  const normalizedEffort = normalizeAutomationEffort(model, effort);
  return buildRunReasoningInput(
    model.providerType,
    model.providerFamily,
    normalizedEffort,
    normalizedEffort,
    model.executionProfile,
  ).executionOptions ?? {};
};
