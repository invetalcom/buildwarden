import type { FileDiffMetadata, Hunk } from "@pierre/diffs";

const normalizeWhitespaceForCompare = (value: string) => value.replace(/\s+/g, "");

const countHunkRows = (hunk: Hunk) =>
  hunk.hunkContent.reduce(
    (counts, content) => {
      if (content.type === "context") {
        counts.split += content.lines;
        counts.unified += content.lines;
      } else {
        counts.split += Math.max(content.additions, content.deletions);
        counts.unified += content.additions + content.deletions;
      }
      return counts;
    },
    { split: 0, unified: 0 },
  );

const rebuildDiffLayoutMetadata = (file: FileDiffMetadata, hunks: Hunk[]): FileDiffMetadata => {
  let lastHunkEnd = 0;
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  const rebuiltHunks = hunks.map((hunk) => {
    const collapsedBefore = Math.max(hunk.additionStart - 1 - lastHunkEnd, 0);
    const rows = countHunkRows(hunk);
    const rebuilt = {
      ...hunk,
      collapsedBefore,
      splitLineStart: splitLineCount + collapsedBefore,
      splitLineCount: rows.split,
      unifiedLineStart: unifiedLineCount + collapsedBefore,
      unifiedLineCount: rows.unified,
    };
    splitLineCount += collapsedBefore + rows.split;
    unifiedLineCount += collapsedBefore + rows.unified;
    lastHunkEnd = hunk.additionStart + hunk.additionCount - 1;
    return rebuilt;
  });

  if (!file.isPartial && rebuiltHunks.length > 0) {
    const collapsedAfter = Math.max(file.additionLines.length - lastHunkEnd, 0);
    splitLineCount += collapsedAfter;
    unifiedLineCount += collapsedAfter;
  }

  return {
    ...file,
    hunks: rebuiltHunks,
    splitLineCount,
    unifiedLineCount,
    cacheKey: undefined,
  };
};

export const filterWhitespaceOnlyChanges = (file: FileDiffMetadata): FileDiffMetadata | null => {
  const hunks = file.hunks
    .map((hunk) => {
      let hiddenAdditions = 0;
      let hiddenDeletions = 0;
      const hunkContent = hunk.hunkContent.map((content) => {
        if (content.type !== "change" || content.additions === 0 || content.additions !== content.deletions) {
          return content;
        }
        const deletedLines = file.deletionLines.slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions);
        const addedLines = file.additionLines.slice(content.additionLineIndex, content.additionLineIndex + content.additions);
        const whitespaceOnly = deletedLines.every(
          (line, index) => line !== addedLines[index] && normalizeWhitespaceForCompare(line) === normalizeWhitespaceForCompare(addedLines[index] ?? ""),
        );
        if (!whitespaceOnly) {
          return content;
        }
        hiddenAdditions += content.additions;
        hiddenDeletions += content.deletions;
        return {
          type: "context" as const,
          lines: content.additions,
          additionLineIndex: content.additionLineIndex,
          deletionLineIndex: content.deletionLineIndex,
        };
      });
      const hasVisibleChanges = hunkContent.some((content) => content.type === "change");
      if (!hasVisibleChanges) {
        return null;
      }
      return {
        ...hunk,
        hunkContent,
        additionLines: hunk.additionLines - hiddenAdditions,
        deletionLines: hunk.deletionLines - hiddenDeletions,
      };
    })
    .filter((hunk): hunk is Hunk => hunk !== null);

  return hunks.length > 0 ? rebuildDiffLayoutMetadata(file, hunks) : null;
};
