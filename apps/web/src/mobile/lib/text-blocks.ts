export type TextBlock =
  | { kind: "text"; content: string }
  | { kind: "code"; language: string; content: string };

/**
 * Splits agent output into prose and fenced code blocks.
 *
 * The mobile UI does not ship a markdown pipeline (see `components/RichText.tsx`), so this is the
 * only structure it extracts. Unterminated fences are left as prose rather than swallowing the
 * rest of the message.
 */
export const splitFencedBlocks = (source: string): TextBlock[] => {
  const blocks: TextBlock[] = [];
  const pattern = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ kind: "text", content: source.slice(lastIndex, match.index) });
    }
    blocks.push({ kind: "code", language: match[1] ?? "", content: match[2] ?? "" });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < source.length) {
    blocks.push({ kind: "text", content: source.slice(lastIndex) });
  }
  return blocks.filter((block) => block.content.trim().length > 0);
};

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
