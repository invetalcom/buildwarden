import type { ModelExecutionControl } from "@buildwarden/shared";

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
