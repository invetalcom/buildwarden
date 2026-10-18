/** Text consumers must not copy, search or replay display-only image bytes. */
export const getResponseSourceText = (
  step: { content: string; metadataJson?: string },
  metadata?: Record<string, unknown>,
): string => {
  if (!metadata) {
    try {
      const parsed: unknown = JSON.parse(step.metadataJson || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch { /* Older history can have malformed metadata. */ }
  }
  const source = typeof metadata?.responseSourceText === "string" ? metadata.responseSourceText : step.content;
  // Older history and providers returning inline images may have no source copy.
  return source.replace(/data:image\/[a-z\d.+-]+;base64,[a-z\d+/=]+/gi, "[embedded image]");
};
