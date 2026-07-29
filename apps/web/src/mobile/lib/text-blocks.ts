/**
 * Splits a git diff into per-file chunks, keyed by the same path `summarizeDiffStats` reports so
 * the file list and the file body always agree.
 */
export const splitDiffByFile = (diffText: string): Map<string, string> => {
  const chunks = new Map<string, string>();
  let currentPath: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentPath) chunks.set(currentPath, buffer.join("\n"));
    buffer = [];
  };

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      // `diff --git a/x b/x` — prefer the b-side, falling back to the a-side for deletions.
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      currentPath = match?.[2] ?? match?.[1] ?? null;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
};
