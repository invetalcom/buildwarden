import { parseDiff } from "react-diff-view";

export const looksLikeGitDiff = (value: string) => {
  const trimmed = value.trimStart();
  return trimmed.startsWith("diff --git ") || trimmed.startsWith("--- ") || trimmed.startsWith("@@ ");
};

/** Number of distinct files in a unified/git diff (0 if empty or unparseable). */
export const countChangedFilesInDiff = (diffText: string): number => {
  const trimmed = diffText.trim();
  if (!trimmed) {
    return 0;
  }
  if (looksLikeGitDiff(trimmed)) {
    try {
      return parseDiff(trimmed, { nearbySequences: "zip" }).length;
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

const formatDiffPath = (oldPath?: string, newPath?: string) => {
  if (newPath && newPath !== "/dev/null") {
    return newPath;
  }

  if (oldPath && oldPath !== "/dev/null") {
    return oldPath;
  }

  return "Unknown file";
};

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
    const parsedFiles = parseDiff(trimmed, { nearbySequences: "zip" });
    const files = parsedFiles.map((file) => {
      let additions = 0;
      let deletions = 0;
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          if (change.type === "insert") {
            additions += 1;
          } else if (change.type === "delete") {
            deletions += 1;
          }
        }
      }
      return {
        path: formatDiffPath(file.oldPath, file.newPath),
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
