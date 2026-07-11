import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export const looksLikeGitDiff = (value: string) => {
  const trimmed = value.trimStart();
  return trimmed.startsWith("diff --git ") || trimmed.startsWith("--- ") || trimmed.startsWith("@@ ");
};

export const parseGitDiffFiles = (diffText: string): FileDiffMetadata[] => {
  const trimmed = diffText.trim();
  if (!trimmed || !looksLikeGitDiff(trimmed)) {
    return [];
  }
  const patchText = trimmed.startsWith("@@ ") ? `--- a/changes.diff\n+++ b/changes.diff\n${trimmed}\n` : trimmed;
  return parsePatchFiles(patchText, undefined, true).flatMap((patch) => patch.files);
};

/** Number of distinct files in a unified/git diff (0 if empty or unparseable). */
export const countChangedFilesInDiff = (diffText: string): number => {
  const trimmed = diffText.trim();
  if (!trimmed) {
    return 0;
  }
  if (looksLikeGitDiff(trimmed)) {
    try {
      return parseGitDiffFiles(trimmed).length;
    } catch {
      /* fall through */
    }
  }
  const matches = trimmed.match(/^diff --git /gm);
  return matches?.length ?? 0;
};

export type GitDiffFileStat = {
  path: string;
  additions: number;
  deletions: number;
};

const formatDiffPath = (file: FileDiffMetadata) => file.name || "Unknown file";

export const summarizeDiffStats = (
  diffText: string,
): {
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: GitDiffFileStat[];
} => {
  const trimmed = diffText.trim();
  if (!trimmed || !looksLikeGitDiff(trimmed)) {
    return { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, files: [] };
  }

  try {
    const parsedFiles = parseGitDiffFiles(trimmed);
    const files = parsedFiles.map((file) => {
      const additions = file.hunks.reduce((count, hunk) => count + hunk.additionLines, 0);
      const deletions = file.hunks.reduce((count, hunk) => count + hunk.deletionLines, 0);
      return {
        path: formatDiffPath(file),
        additions,
        deletions,
      };
    });

    return {
      totalFiles: files.length,
      totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
      files,
    };
  } catch {
    return { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, files: [] };
  }
};
