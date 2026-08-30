export const parseStepMetadata = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};
