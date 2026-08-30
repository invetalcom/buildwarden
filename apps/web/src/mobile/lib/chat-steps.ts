export const parseStepMetadata = (value: string): Record<string, unknown> => {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};
