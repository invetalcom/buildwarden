import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type Ref,
} from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import type { RunDiffReviewFinding } from "@easycode/shared";
import type { HunkTokens } from "react-diff-view";
import { Diff, Hunk, findChangeByNewLineNumber, findChangeByOldLineNumber, getChangeKey, markEdits, parseDiff, tokenize } from "react-diff-view";
import type { ChangeData, HunkData } from "react-diff-view";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { looksLikeGitDiff } from "./git-diff-utils";

const formatDiffPath = (oldPath?: string, newPath?: string) => {
  if (newPath && newPath !== "/dev/null") {
    return newPath;
  }

  if (oldPath && oldPath !== "/dev/null") {
    return oldPath;
  }

  return "Unknown file";
};

const diffFileKey = (file: { oldPath?: string; newPath?: string }, index: number) =>
  `${file.oldPath ?? "old"}-${file.newPath ?? "new"}-${index}`;

const normalizeDiffPathSegment = (value: string) => value.replace(/\\/g, "/").replace(/^a\//, "").replace(/^b\//, "").trim();

/** Whether a review finding applies to this diff file path. */
const findingMatchesDiffFile = (filePath: string, findingPath: string | null | undefined): boolean => {
  const raw = findingPath?.trim();
  if (!raw) {
    return false;
  }
  const fp = normalizeDiffPathSegment(filePath);
  const cf = normalizeDiffPathSegment(raw);
  return fp === cf || fp.endsWith(`/${cf}`) || cf.endsWith(`/${fp}`);
};

const FINDING_PRIORITY_BORDER: Record<RunDiffReviewFinding["priority"], string> = {
  high: "border-l-rose-400",
  medium: "border-l-amber-400",
  low: "border-l-emerald-500/70",
};

type ReviewNavEntry = { finding: RunDiffReviewFinding; fileKey: string | null; globalIndex: number };

const findDiffChangeForFinding = (hunks: HunkData[], finding: RunDiffReviewFinding): ChangeData | null => {
  if (!finding.lineNumber) {
    return null;
  }
  return findChangeByNewLineNumber(hunks, finding.lineNumber) ?? findChangeByOldLineNumber(hunks, finding.lineNumber) ?? null;
};

const ReviewFindingCard = ({
  finding,
  globalIndex,
  active,
}: {
  finding: RunDiffReviewFinding;
  globalIndex: number;
  active: boolean;
}) => (
  <div
    id={`easycode-review-finding-${String(globalIndex)}`}
    className={cn(
      "rounded-md border border-zinc-700/70 border-l-[3px] bg-zinc-950/80 px-2.5 py-1.5 text-[11px] text-zinc-300 transition-shadow",
      FINDING_PRIORITY_BORDER[finding.priority],
      active && "ring-2 ring-cyan-400/75 ring-offset-1 ring-offset-zinc-950",
    )}
  >
    <p className="font-medium text-zinc-100">{finding.title}</p>
    {finding.lineReference || finding.lineNumber ? (
      <p className="mt-0.5 font-mono text-[10px] text-zinc-500">{finding.lineReference ?? `line ${String(finding.lineNumber)}`}</p>
    ) : null}
    <p className="mt-1 leading-snug text-zinc-400">{finding.detail}</p>
    {finding.recommendation ? <p className="mt-1 text-[10px] text-cyan-200/90">Suggestion: {finding.recommendation}</p> : null}
  </div>
);

export type GitDiffPreviewHandle = {
  /** If every file section is expanded, collapse all; otherwise expand all. */
  toggleExpandAllFiles: () => void;
};

type GitDiffPreviewProps = {
  diffText: string;
  emptyMessage: string;
  className?: string;
  compact?: boolean;
  /** @default "unified" (single column, old/new line gutters — like GitHub unified). */
  viewType?: "split" | "unified";
  /** Highlight intra-line edits via `react-diff-view` `tokenize` + `markEdits` (unified view only). @default true */
  wordDiff?: boolean;
  /** Optional review findings to show as inline comment rows (e.g. PR/MR reviewer output). */
  reviewFindings?: RunDiffReviewFinding[] | null;
  activityEmphasis?: boolean;
  hideFileHeader?: boolean;
  hideFileHeaderInlineToggle?: boolean;
  /** When true, render parsed file sections fully expanded without per-file toggle controls. */
  alwaysExpandedFileSections?: boolean;
  /** When true, each file section starts collapsed. */
  defaultCollapsedFileSections?: boolean;
  /** Fired when expanded/collapsed state changes (only when diff parses into file sections). */
  onAllFilesExpandedChange?: (allExpanded: boolean) => void;
  /**
   * Grow to fill a flex parent (e.g. run detail “Changes” beside activity). Skips fixed max-height so the panel
   * matches the activity column height; parent should use `flex flex-col` and `min-h-0` on this subtree.
   */
  fillContainer?: boolean;
};

export const GitDiffPreview = forwardRef(function GitDiffPreview(
  {
    diffText,
    emptyMessage,
    className,
    compact = false,
    viewType = "unified" as "split" | "unified",
    wordDiff = true,
    reviewFindings = null,
    activityEmphasis = false,
    hideFileHeader = false,
    hideFileHeaderInlineToggle = false,
    alwaysExpandedFileSections = false,
    defaultCollapsedFileSections = true,
    onAllFilesExpandedChange,
    fillContainer = false,
  }: GitDiffPreviewProps,
  ref: Ref<GitDiffPreviewHandle>,
) {
  const trimmedDiff = diffText.trim();
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const files = useMemo(() => {
    if (!trimmedDiff || !looksLikeGitDiff(trimmedDiff)) {
      return [];
    }

    try {
      return parseDiff(trimmedDiff, { nearbySequences: "zip" });
    } catch {
      return [];
    }
  }, [trimmedDiff]);

  useEffect(() => {
    setCollapsedFiles({});
  }, [trimmedDiff]);

  const toggleExpandAllFiles = useCallback(() => {
    setCollapsedFiles((current) => {
      if (files.length === 0) {
        return current;
      }
      if (alwaysExpandedFileSections) {
        return Object.fromEntries(files.map((file, index) => [diffFileKey(file, index), false]));
      }
      const keys = files.map((file, index) => diffFileKey(file, index));
      const allExpanded = keys.every((key) => !(current[key] ?? defaultCollapsedFileSections));
      const targetCollapsed = allExpanded;
      return Object.fromEntries(keys.map((key) => [key, targetCollapsed]));
    });
  }, [alwaysExpandedFileSections, files, defaultCollapsedFileSections]);

  useImperativeHandle(
    ref,
    () => ({
      toggleExpandAllFiles,
    }),
    [toggleExpandAllFiles],
  );

  const allFilesExpanded = useMemo(() => {
    if (files.length === 0) {
      return false;
    }
    if (alwaysExpandedFileSections) {
      return true;
    }
    return files.every((file, index) => !(collapsedFiles[diffFileKey(file, index)] ?? defaultCollapsedFileSections));
  }, [alwaysExpandedFileSections, collapsedFiles, defaultCollapsedFileSections, files]);
  const anyFilesExpanded = useMemo(() => {
    if (files.length === 0) {
      return false;
    }
    if (alwaysExpandedFileSections) {
      return true;
    }
    return files.some((file, index) => !(collapsedFiles[diffFileKey(file, index)] ?? defaultCollapsedFileSections));
  }, [alwaysExpandedFileSections, collapsedFiles, defaultCollapsedFileSections, files]);

  useEffect(() => {
    onAllFilesExpandedChange?.(allFilesExpanded);
  }, [allFilesExpanded, onAllFilesExpandedChange]);

  const reviewFindingBuckets = useMemo(() => {
    const list = reviewFindings?.filter(Boolean) ?? [];
    const general = list.filter((f) => !f.filePath?.trim());
    return { list, general };
  }, [reviewFindings]);

  /** Single top-to-bottom order for review nav: general first, then per file in diff order. */
  const reviewNavEntries = useMemo(() => {
    const entries: ReviewNavEntry[] = [];
    let i = 0;
    for (const finding of reviewFindingBuckets.general) {
      entries.push({ finding, fileKey: null, globalIndex: i });
      i += 1;
    }
    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx];
      const fk = diffFileKey(file, fileIdx);
      const filePathLabel = formatDiffPath(file.oldPath, file.newPath);
      const scoped = reviewFindingBuckets.list.filter(
        (f) => f.filePath?.trim() && findingMatchesDiffFile(filePathLabel, f.filePath),
      );
      for (const finding of scoped) {
        entries.push({ finding, fileKey: fk, globalIndex: i });
        i += 1;
      }
    }
    return entries;
  }, [reviewFindingBuckets, files]);

  const [activeReviewNavIndex, setActiveReviewNavIndex] = useState(0);

  const reviewFindingsFingerprint = useMemo(
    () => (reviewFindings ?? []).map((f) => `${f.title}\0${f.detail.slice(0, 64)}`).join("|"),
    [reviewFindings],
  );

  useEffect(() => {
    setActiveReviewNavIndex(0);
  }, [trimmedDiff, reviewFindingsFingerprint]);

  const reviewNavTotal = reviewNavEntries.length;

  const expandFileForNavIndex = useCallback(
    (globalIndex: number) => {
      const entry = reviewNavEntries[globalIndex];
      const fileKey = entry?.fileKey;
      if (!fileKey) {
        return;
      }
      setCollapsedFiles((current) => ({ ...current, [fileKey]: false }));
    },
    [reviewNavEntries],
  );

  const goToReviewNavIndex = useCallback(
    (nextIndex: number) => {
      if (reviewNavTotal === 0) {
        return;
      }
      const clamped = Math.max(0, Math.min(reviewNavTotal - 1, nextIndex));
      expandFileForNavIndex(clamped);
      setActiveReviewNavIndex(clamped);
    },
    [expandFileForNavIndex, reviewNavTotal],
  );

  useEffect(() => {
    if (reviewNavTotal === 0) {
      return;
    }
    setActiveReviewNavIndex((index) => Math.min(index, reviewNavTotal - 1));
  }, [reviewNavTotal]);

  useEffect(() => {
    if (reviewNavTotal === 0) {
      return;
    }
    const safe = Math.min(activeReviewNavIndex, reviewNavTotal - 1);
    const id = `easycode-review-finding-${String(safe)}`;
    const el = typeof document !== "undefined" ? document.getElementById(id) : null;
    if (el) {
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }, [activeReviewNavIndex, reviewNavTotal]);

  const safeReviewNavIndex = useMemo(
    () => (reviewNavTotal === 0 ? 0 : Math.min(activeReviewNavIndex, reviewNavTotal - 1)),
    [activeReviewNavIndex, reviewNavTotal],
  );

  const generalNavEntries = useMemo(
    () => reviewNavEntries.filter((e) => e.fileKey === null),
    [reviewNavEntries],
  );

  const scrollAreaHeightClass = compact
    ? "max-h-72"
    : fillContainer
      ? "min-h-0 flex-1 max-h-none"
      : "max-h-[520px]";

  if (!trimmedDiff) {
    return (
      <div
        className={cn(
          "rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-xs text-zinc-500",
          className,
          fillContainer && "flex min-h-[10rem] flex-1 items-center justify-center",
        )}
      >
        {emptyMessage}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <pre
        className={cn(
          "app-scrollbar overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-xs text-zinc-300",
          className,
          compact ? "max-h-64" : fillContainer ? "min-h-0 flex-1 max-h-none" : "max-h-[520px]",
        )}
      >
        {diffText}
      </pre>
    );
  }

  const viewerClass = activityEmphasis ? "diff-viewer diff-viewer--activity" : "diff-viewer";

  return (
    <div
      className={cn(
        "app-scrollbar overflow-auto rounded-lg border bg-zinc-950/80",
        className,
        activityEmphasis ? "border-emerald-500/15 ring-1 ring-rose-500/10" : "border-zinc-800",
        hideFileHeaderInlineToggle && !anyFilesExpanded && "relative mt-0 h-0 overflow-visible border-transparent bg-transparent ring-0",
        scrollAreaHeightClass,
      )}
    >
      {reviewNavTotal > 0 ? (
        <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2 py-1.5 backdrop-blur-md">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Comment navigation</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular-nums text-[11px] text-zinc-500">
              {safeReviewNavIndex + 1} / {reviewNavTotal}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={safeReviewNavIndex <= 0}
              onClick={() => goToReviewNavIndex(safeReviewNavIndex - 1)}
              aria-label="Previous review comment"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
              Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={safeReviewNavIndex >= reviewNavTotal - 1}
              onClick={() => goToReviewNavIndex(safeReviewNavIndex + 1)}
              aria-label="Next review comment"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
      <div className={cn(viewerClass, hideFileHeaderInlineToggle && anyFilesExpanded && "relative pt-5")}>
        {generalNavEntries.length > 0 ? (
          <div className="border-b border-zinc-800 bg-zinc-900/35 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">General</p>
            <div className="mt-2 space-y-2">
              {generalNavEntries.map(({ finding, globalIndex }) => (
                <ReviewFindingCard
                  key={`review-general-${String(globalIndex)}`}
                  finding={finding}
                  globalIndex={globalIndex}
                  active={safeReviewNavIndex === globalIndex}
                />
              ))}
            </div>
          </div>
        ) : null}
        {files.map((file, index) => {
          const fileKey = diffFileKey(file, index);
          const isCollapsed = alwaysExpandedFileSections ? false : (collapsedFiles[fileKey] ?? defaultCollapsedFileSections);
          const filePathLabel = formatDiffPath(file.oldPath, file.newPath);
          const fileNavEntries = reviewNavEntries.filter((e) => e.fileKey === fileKey);
          const anchoredEntryGroups = new Map<string, ReviewNavEntry[]>();
          const fallbackFileNavEntries: ReviewNavEntry[] = [];
          for (const entry of fileNavEntries) {
            const change = findDiffChangeForFinding(file.hunks, entry.finding);
            if (!change) {
              fallbackFileNavEntries.push(entry);
              continue;
            }
            const changeKey = getChangeKey(change);
            anchoredEntryGroups.set(changeKey, [...(anchoredEntryGroups.get(changeKey) ?? []), entry]);
          }
          const reviewWidgets = Object.fromEntries(
            [...anchoredEntryGroups.entries()].map(([changeKey, entries]) => [
              changeKey,
              <div className="space-y-2 px-3 py-2" key={`${fileKey}-widget-${changeKey}`}>
                {entries.map(({ finding, globalIndex }) => (
                  <ReviewFindingCard
                    key={`${fileKey}-inline-review-${String(globalIndex)}`}
                    finding={finding}
                    globalIndex={globalIndex}
                    active={safeReviewNavIndex === globalIndex}
                  />
                ))}
              </div>,
            ]),
          );
          const wordTokens: HunkTokens | null =
            viewType === "unified" && wordDiff
              ? tokenize(file.hunks, { enhancers: [markEdits(file.hunks, { type: "line" })] })
              : null;

          return (
            <div key={fileKey} className="border-b border-zinc-800 last:border-b-0">
              {alwaysExpandedFileSections ? null : hideFileHeader ? (
                hideFileHeaderInlineToggle ? (
                  <button
                    type="button"
                    className={cn(
                      "z-10 rounded px-1 py-0.5 text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-300",
                      anyFilesExpanded ? "absolute right-2 top-1" : "absolute right-0 top-[-1.55rem]",
                    )}
                    onClick={() => setCollapsedFiles((current) => ({ ...current, [fileKey]: !isCollapsed }))}
                    aria-label={isCollapsed ? "Expand diff" : "Collapse diff"}
                    title={isCollapsed ? "Expand diff" : "Collapse diff"}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="sticky top-0 z-10 flex w-full items-center justify-end border-b border-zinc-800 bg-zinc-900/95 px-2 py-1 text-zinc-500 backdrop-blur-sm hover:text-zinc-300"
                    onClick={() => setCollapsedFiles((current) => ({ ...current, [fileKey]: !isCollapsed }))}
                    aria-label={isCollapsed ? "Expand diff" : "Collapse diff"}
                    title={isCollapsed ? "Expand diff" : "Collapse diff"}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-4 w-4 shrink-0" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0" />
                    )}
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="sticky top-0 z-10 flex w-full items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/95 px-3 py-1.5 text-left backdrop-blur-sm"
                  onClick={() => setCollapsedFiles((current) => ({ ...current, [fileKey]: !isCollapsed }))}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <p className="truncate text-xs font-medium text-zinc-100">{formatDiffPath(file.oldPath, file.newPath)}</p>
                    <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-zinc-500">{file.type}</span>
                  </div>
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  )}
                </button>
              )}
              {!isCollapsed ? (
                <>
                  <Diff viewType={viewType} diffType={file.type} hunks={file.hunks} tokens={wordTokens} widgets={reviewWidgets} className="text-xs">
                    {(hunks) => hunks.map((hunk, hunkIndex) => <Hunk key={`${fileKey}-hunk-${String(hunkIndex)}`} hunk={hunk} />)}
                  </Diff>
                  {fallbackFileNavEntries.length > 0 ? (
                    <div className="border-t border-cyan-500/10 bg-zinc-900/30 px-2 py-2">
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                        Comments on this file
                        <span className="ml-1 font-mono font-normal text-zinc-600">{filePathLabel}</span>
                      </p>
                      <div className="space-y-2">
                        {fallbackFileNavEntries.map(({ finding, globalIndex }) => (
                          <ReviewFindingCard
                            key={`${fileKey}-review-${String(globalIndex)}`}
                            finding={finding}
                            globalIndex={globalIndex}
                            active={safeReviewNavIndex === globalIndex}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
});
