import type { ModelExecutionControl, ModelExecutionProfile } from "@buildwarden/shared";

export type ModelChipSection = "model" | "effort" | "secondary";

/** Chooses the next useful row after replacing a model without closing its configuration menu. */
export const nextModelChipSection = (executionProfile: ModelExecutionProfile | undefined): ModelChipSection => {
  if (executionProfile?.controls.some((entry) => entry.id === "reasoningEffort" || entry.id === "thinkingLevel")) return "effort";
  if (executionProfile?.controls.some((entry) => entry.id !== "reasoningEffort" && entry.id !== "thinkingLevel")) return "secondary";
  return "model";
};

/** Returns only values accepted by every supplied model control. */
export const intersectModelExecutionControls = (
  controls: readonly ModelExecutionControl[],
): ModelExecutionControl | undefined => {
  if (controls.length === 0) return undefined;
  const first = controls[0]!;
  const commonValues = new Set(first.options.map((entry) => entry.value));
  for (const entry of controls.slice(1)) {
    const values = new Set(entry.options.map((candidate) => candidate.value));
    for (const value of commonValues) {
      if (!values.has(value)) commonValues.delete(value);
    }
  }
  const options = first.options.filter((entry) => commonValues.has(entry.value));
  return options.length > 0 ? { ...first, options } : undefined;
};
