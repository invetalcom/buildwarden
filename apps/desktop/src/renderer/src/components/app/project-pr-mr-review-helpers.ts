import type {
  ProjectForgeChangedFileSummary,
  ProjectForgeRequestDetailsResult,
  ProjectForgeReviewThread,
  ProjectPrMrDiffComment,
} from "@buildwarden/shared";
import type { DiffPreviewFileSummary, DiffPreviewManualComment } from "./git-diff-preview";

export type RequestDetailTab = "conversation" | "commits" | "files";

export type DraftDiffComment = ProjectPrMrDiffComment & {
  id: string;
  displayPath: string;
  lineLabel: string;
  aiFindingKey?: string;
};

export type ProjectPrMrFileNavItem = {
  key: string;
  path: string;
  oldPath: string | null;
  status: ProjectForgeChangedFileSummary["status"] | string;
  additions: number | null;
  deletions: number | null;
  patchAvailable: boolean;
  commentCount: number;
  draftCount: number;
  order: number;
};

export type ReviewThreadCodeLine = {
  key: string;
  type: "context" | "add" | "delete" | "hunk";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
  highlighted: boolean;
};

const normalizeReviewPath = (value: string | null | undefined) => (value ?? "").replace(/\\/g, "/").replace(/^a\//, "").replace(/^b\//, "").trim();

export const pathsMatch = (left: string | null | undefined, right: string | null | undefined) => {
  const a = normalizeReviewPath(left);
  const b = normalizeReviewPath(right);
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
};

export const normalizeRequestDetailTab = (value: unknown): RequestDetailTab => {
  if (value === "overview") return "conversation";
  if (value === "changes") return "files";
  return value === "conversation" || value === "commits" || value === "files" ? value : "conversation";
};

const parseHunkHeader = (line: string): { oldLine: number; newLine: number } | null => {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    oldLine: Number(match[1]),
    newLine: Number(match[2]),
  };
};

const codeLineMatchesThread = (line: ReviewThreadCodeLine, thread: ProjectForgeReviewThread) => {
  if (thread.side === "old") {
    return line.oldLineNumber != null && line.oldLineNumber === thread.oldLineNumber;
  }
  return line.newLineNumber != null && line.newLineNumber === thread.newLineNumber;
};

const parseHunkLines = (hunkText: string, thread: ProjectForgeReviewThread): ReviewThreadCodeLine[] => {
  const rawLines = hunkText.split(/\r?\n/).filter((line) => line.trimEnd().length > 0);
  let oldLine = 0;
  let newLine = 0;
  const parsed: ReviewThreadCodeLine[] = [];

  for (const [index, line] of rawLines.entries()) {
    const hunkHeader = parseHunkHeader(line);
    if (hunkHeader) {
      oldLine = hunkHeader.oldLine;
      newLine = hunkHeader.newLine;
      parsed.push({
        key: `hunk-${String(index)}`,
        type: "hunk",
        oldLineNumber: null,
        newLineNumber: null,
        content: line,
        highlighted: false,
      });
      continue;
    }

    if (!oldLine && !newLine) {
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === "+") {
      const next: ReviewThreadCodeLine = {
        key: `new-${String(newLine)}-${String(index)}`,
        type: "add",
        oldLineNumber: null,
        newLineNumber: newLine,
        content,
        highlighted: false,
      };
      next.highlighted = codeLineMatchesThread(next, thread);
      parsed.push(next);
      newLine += 1;
      continue;
    }
    if (prefix === "-") {
      const next: ReviewThreadCodeLine = {
        key: `old-${String(oldLine)}-${String(index)}`,
        type: "delete",
        oldLineNumber: oldLine,
        newLineNumber: null,
        content,
        highlighted: false,
      };
      next.highlighted = codeLineMatchesThread(next, thread);
      parsed.push(next);
      oldLine += 1;
      continue;
    }
    const next: ReviewThreadCodeLine = {
      key: `context-${String(oldLine)}-${String(newLine)}-${String(index)}`,
      type: "context",
      oldLineNumber: oldLine,
      newLineNumber: newLine,
      content: prefix === " " ? content : line,
      highlighted: false,
    };
    next.highlighted = codeLineMatchesThread(next, thread);
    parsed.push(next);
    oldLine += 1;
    newLine += 1;
  }

  return parsed;
};

const trimCodeContext = (lines: ReviewThreadCodeLine[], contextLines: number) => {
  const highlightedIndex = lines.findIndex((line) => line.highlighted);
  if (highlightedIndex < 0) {
    return lines.slice(0, Math.min(lines.length, contextLines * 2 + 3));
  }
  const start = Math.max(0, highlightedIndex - contextLines);
  const end = Math.min(lines.length, highlightedIndex + contextLines + 1);
  return lines.slice(start, end);
};

const fileSectionMatchesThread = (section: string[], thread: ProjectForgeReviewThread) => {
  const filePath = section.find((line) => line.startsWith("+++ "))?.replace(/^\+\+\+\s+b\//, "").replace(/^\+\+\+\s+/, "").trim();
  const oldPath = section.find((line) => line.startsWith("--- "))?.replace(/^---\s+a\//, "").replace(/^---\s+/, "").trim();
  return pathsMatch(filePath, thread.path) || pathsMatch(oldPath, thread.oldPath ?? thread.path);
};

export const buildReviewThreadCodeLines = (thread: ProjectForgeReviewThread, diffText: string, contextLines = 3): ReviewThreadCodeLine[] => {
  if (thread.diffHunk?.trim()) {
    return trimCodeContext(parseHunkLines(thread.diffHunk, thread), contextLines);
  }

  const sections = diffText
    .split(/\n(?=diff --git )/)
    .map((section) => section.split(/\r?\n/))
    .filter((section) => section.length > 0);

  for (const section of sections) {
    if (!fileSectionMatchesThread(section, thread)) {
      continue;
    }
    const hunks: string[][] = [];
    let current: string[] = [];
    for (const line of section) {
      if (line.startsWith("@@ ")) {
        if (current.length > 0) {
          hunks.push(current);
        }
        current = [line];
        continue;
      }
      if (current.length > 0) {
        current.push(line);
      }
    }
    if (current.length > 0) {
      hunks.push(current);
    }
    for (const hunk of hunks) {
      const parsed = parseHunkLines(hunk.join("\n"), thread);
      if (parsed.some((line) => line.highlighted)) {
        return trimCodeContext(parsed, contextLines);
      }
    }
  }

  return [];
};

export const buildRemoteDiffComments = (details: ProjectForgeRequestDetailsResult | null): DiffPreviewManualComment[] => {
  const threaded = (details?.reviewThreads ?? []).flatMap((thread) => {
    const oldPath = thread.oldPath || thread.path;
    const newPath = thread.path;
    const line = thread.side === "old" ? thread.oldLineNumber : thread.newLineNumber;
    const changeType = thread.oldLineNumber && thread.newLineNumber ? ("normal" as const) : thread.side === "old" ? ("delete" as const) : ("insert" as const);
    return thread.comments.map((comment) => ({
      id: comment.id,
      oldPath,
      newPath,
      side: thread.side,
      oldLineNumber: thread.oldLineNumber,
      newLineNumber: thread.newLineNumber,
      changeType,
      body: comment.body,
      displayPath: newPath,
      lineLabel: `${newPath}:${String(line ?? "")} ${thread.side}`,
      author: comment.author?.username ?? null,
      createdAt: comment.createdAt,
      title: thread.resolved ? "Resolved review thread" : "Review thread",
      remote: true,
      resolved: thread.resolved ?? undefined,
    }));
  });

  if (threaded.length > 0) {
    return threaded;
  }

  return (details?.activity ?? [])
    .filter((item) => item.kind === "diff-comment" && item.path?.trim() && item.line && (item.body?.trim() || item.title.trim()))
    .map((item) => {
      const path = item.path ?? "";
      const line = item.line ?? null;
      const body = item.body?.trim() || item.title;
      return {
        id: item.id,
        oldPath: path,
        newPath: path,
        side: "new" as const,
        oldLineNumber: null,
        newLineNumber: line,
        changeType: "insert" as const,
        body,
        displayPath: path,
        lineLabel: `${path}:${String(line)} new`,
        author: item.author?.username ?? null,
        createdAt: item.createdAt,
        title: item.title,
        remote: true,
        resolved: item.resolved,
      };
    });
};

export const buildPrMrFileNavItems = (
  details: ProjectForgeRequestDetailsResult | null,
  parsedDiffFiles: DiffPreviewFileSummary[],
  draftComments: DraftDiffComment[],
): ProjectPrMrFileNavItem[] => {
  const items = new Map<string, ProjectPrMrFileNavItem>();
  const upsert = (input: Omit<ProjectPrMrFileNavItem, "key" | "draftCount">) => {
    const key = normalizeReviewPath(input.path);
    if (!key) return;
    const current = items.get(key);
    items.set(key, {
      key,
      path: input.path,
      oldPath: input.oldPath ?? current?.oldPath ?? null,
      status: input.status || current?.status || "modified",
      additions: input.additions ?? current?.additions ?? null,
      deletions: input.deletions ?? current?.deletions ?? null,
      patchAvailable: input.patchAvailable || current?.patchAvailable || false,
      commentCount: Math.max(input.commentCount, current?.commentCount ?? 0),
      draftCount: current?.draftCount ?? 0,
      order: Math.min(input.order, current?.order ?? input.order),
    });
  };

  (details?.files ?? []).forEach((file, index) => {
    upsert({
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patchAvailable: file.patchAvailable,
      commentCount: file.commentCount,
      order: index,
    });
  });

  parsedDiffFiles.forEach((file, index) => {
    upsert({
      path: file.path,
      oldPath: file.oldPath,
      status: file.type,
      additions: file.additions,
      deletions: file.deletions,
      patchAvailable: true,
      commentCount: 0,
      order: 1000 + index,
    });
  });

  const threadCountsByPath = new Map<string, { path: string; oldPath: string | null; count: number }>();
  for (const thread of details?.reviewThreads ?? []) {
    const key = normalizeReviewPath(thread.path);
    if (!key) continue;
    const current = threadCountsByPath.get(key);
    threadCountsByPath.set(key, {
      path: thread.path,
      oldPath: thread.oldPath,
      count: (current?.count ?? 0) + thread.comments.length,
    });
  }

  for (const [key, value] of threadCountsByPath.entries()) {
    const existing = items.get(key);
    if (existing) {
      existing.commentCount = Math.max(existing.commentCount, value.count);
    } else {
      items.set(key, {
        key,
        path: value.path,
        oldPath: value.oldPath,
        status: "modified",
        additions: null,
        deletions: null,
        patchAvailable: true,
        commentCount: value.count,
        draftCount: 0,
        order: 2000 + items.size,
      });
    }
  }

  for (const draft of draftComments) {
    const key = normalizeReviewPath(draft.newPath || draft.oldPath);
    const existing = items.get(key);
    if (existing) {
      existing.draftCount += 1;
    } else if (key) {
      items.set(key, {
        key,
        path: draft.newPath || draft.oldPath,
        oldPath: draft.oldPath || null,
        status: "modified",
        additions: null,
        deletions: null,
        patchAvailable: true,
        commentCount: 0,
        draftCount: 1,
        order: 3000 + items.size,
      });
    }
  }

  return [...items.values()].sort((left, right) => left.order - right.order || left.path.localeCompare(right.path));
};
