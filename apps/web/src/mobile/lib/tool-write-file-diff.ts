import { looksLikeGitDiff } from "@buildwarden/renderer/logic";

/**
 * The unified diff a file-writing tool recorded, if any.
 *
 * The desktop run tools and codex-cli both store it as `writeFileUnifiedDiff`, but codex attaches
 * it to the tool call while everything else puts it on the tool result, so callers pass both sides
 * and the first usable diff wins. `looksLikeGitDiff` guards against rendering a stored value that
 * is not actually a diff through the diff colouring.
 */
export const toolWriteFileDiff = (...metadata: (Record<string, unknown> | undefined)[]): string | null => {
  for (const candidate of metadata) {
    const diff = candidate?.writeFileUnifiedDiff;
    if (typeof diff === "string" && looksLikeGitDiff(diff)) {
      return diff;
    }
  }
  return null;
};
