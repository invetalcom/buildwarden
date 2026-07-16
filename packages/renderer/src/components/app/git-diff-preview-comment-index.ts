import type { ProjectPrMrDiffComment } from "@buildwarden/shared";

const normalizeDiffPathSegment = (value: string) => value.replace(/\\/g, "/").replace(/^a\//, "").replace(/^b\//, "").trim();

export type DiffLineCommentTarget = Omit<ProjectPrMrDiffComment, "body"> & {
  displayPath: string;
  changeKey: string;
  lineLabel: string;
};

export type DiffPreviewManualComment = ProjectPrMrDiffComment & {
  id: string;
  displayPath?: string;
  lineLabel?: string;
  author?: string | null;
  createdAt?: string | null;
  title?: string | null;
  remote?: boolean;
  resolved?: boolean;
};

export const diffLineCommentTargetKey = (target: Omit<ProjectPrMrDiffComment, "body">) =>
  [
    target.oldPath,
    target.newPath,
    target.side,
    target.oldLineNumber ?? "",
    target.newLineNumber ?? "",
    target.changeType,
  ].join("\0");

export type DiffCommentIndex = {
  exact: Map<string, DiffPreviewManualComment[]>;
  bySideAndLine: Map<string, DiffPreviewManualComment[]>;
};

const sideLineKey = (side: "old" | "new", line: number) => `${side}\0${String(line)}`;

const appendCommentIndexValue = <TKey,>(map: Map<TKey, DiffPreviewManualComment[]>, key: TKey, comment: DiffPreviewManualComment) => {
  const current = map.get(key);
  if (current) {
    current.push(comment);
    return;
  }
  map.set(key, [comment]);
};

export const buildDiffCommentIndex = (comments: readonly DiffPreviewManualComment[] | null | undefined): DiffCommentIndex => {
  const exact = new Map<string, DiffPreviewManualComment[]>();
  const bySideAndLine = new Map<string, DiffPreviewManualComment[]>();

  for (const comment of comments ?? []) {
    appendCommentIndexValue(exact, diffLineCommentTargetKey(comment), comment);
    const line = comment.side === "new" ? comment.newLineNumber : comment.oldLineNumber;
    if (line != null) {
      appendCommentIndexValue(bySideAndLine, sideLineKey(comment.side, line), comment);
    }
  }

  return { exact, bySideAndLine };
};

const diffCommentPathsMatch = (comment: DiffPreviewManualComment, target: DiffLineCommentTarget) => {
  const commentPath = normalizeDiffPathSegment(comment.newPath || comment.oldPath || comment.displayPath || "");
  const targetPath = normalizeDiffPathSegment(target.newPath || target.oldPath || target.displayPath);
  return Boolean(
    commentPath && targetPath && (commentPath === targetPath || commentPath.endsWith(`/${targetPath}`) || targetPath.endsWith(`/${commentPath}`)),
  );
};

export const findCommentsForDiffTargets = (
  commentIndex: DiffCommentIndex,
  targets: readonly DiffLineCommentTarget[],
): DiffPreviewManualComment[] => {
  const matches = new Map<string, DiffPreviewManualComment>();

  for (const target of targets) {
    for (const comment of commentIndex.exact.get(diffLineCommentTargetKey(target)) ?? []) {
      matches.set(comment.id, comment);
    }

    const targetLine = target.side === "new" ? target.newLineNumber : target.oldLineNumber;
    if (targetLine == null) {
      continue;
    }

    for (const comment of commentIndex.bySideAndLine.get(sideLineKey(target.side, targetLine)) ?? []) {
      if (diffCommentPathsMatch(comment, target)) {
        matches.set(comment.id, comment);
      }
    }
  }

  return [...matches.values()];
};
