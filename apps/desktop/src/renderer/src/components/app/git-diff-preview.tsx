import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronDown, ChevronLeft, ChevronRight, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import type { RunDiffReviewFinding } from "@buildwarden/shared";
import type { HunkTokens } from "react-diff-view";
import { Diff, Hunk, findChangeByNewLineNumber, findChangeByOldLineNumber, getChangeKey, markEdits, parseDiff, tokenize } from "react-diff-view";
import type { ChangeData, EventMap, FileData, GutterOptions, HunkData } from "react-diff-view";
import { cn } from "../../lib/cn";
import { ActivityRichText } from "../ui/activity-rich-text";
import { Button } from "../ui/button";
import {
  buildDiffCommentIndex,
  diffLineCommentTargetKey,
  findCommentsForDiffTargets,
  type DiffCommentIndex,
  type DiffLineCommentTarget,
  type DiffPreviewManualComment,
} from "./git-diff-preview-comment-index";
import { looksLikeGitDiff } from "./git-diff-utils";

export type { DiffLineCommentTarget, DiffPreviewManualComment } from "./git-diff-preview-comment-index";

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

export type DiffPreviewFileSummary = {
  key: string;
  path: string;
  oldPath: string | null;
  type: string;
  additions: number;
  deletions: number;
};

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

const reviewFindingDraftKey = (finding: RunDiffReviewFinding, globalIndex: number) =>
  [globalIndex, finding.filePath ?? "", finding.lineNumber ?? "", finding.title, finding.detail.slice(0, 80)].join("\0");

const normalizeWhitespaceForCompare = (value: string) => value.replace(/\s+/g, "");

const isWhitespaceOnlyReplacement = (deletedChanges: ChangeData[], insertedChanges: ChangeData[]) =>
  deletedChanges.length > 0 &&
  deletedChanges.length === insertedChanges.length &&
  deletedChanges.every((deletedChange, index) => {
    const insertedChange = insertedChanges[index];
    return (
      insertedChange &&
      normalizeWhitespaceForCompare(deletedChange.content) === normalizeWhitespaceForCompare(insertedChange.content) &&
      deletedChange.content !== insertedChange.content
    );
  });

const filterWhitespaceOnlyChanges = (changes: ChangeData[]) => {
  const nextChanges: ChangeData[] = [];

  for (let index = 0; index < changes.length; ) {
    const current = changes[index]!;
    if (current.type !== "delete") {
      nextChanges.push(current);
      index += 1;
      continue;
    }

    const deletedChanges: ChangeData[] = [];
    while (changes[index]?.type === "delete") {
      deletedChanges.push(changes[index]!);
      index += 1;
    }

    const insertedChanges: ChangeData[] = [];
    while (changes[index]?.type === "insert") {
      insertedChanges.push(changes[index]!);
      index += 1;
    }

    if (isWhitespaceOnlyReplacement(deletedChanges, insertedChanges)) {
      continue;
    }

    nextChanges.push(...deletedChanges, ...insertedChanges);
  }

  return nextChanges;
};

const filePathForComment = (path?: string) => (path && path !== "/dev/null" ? path : "");

const getChangeLineNumbers = (change: ChangeData): { oldLineNumber: number | null; newLineNumber: number | null } => {
  if (change.type === "normal") {
    return {
      oldLineNumber: change.oldLineNumber,
      newLineNumber: change.newLineNumber,
    };
  }
  if (change.type === "delete") {
    return {
      oldLineNumber: change.lineNumber,
      newLineNumber: null,
    };
  }
  return {
    oldLineNumber: null,
    newLineNumber: change.lineNumber,
  };
};

const buildDiffLineCommentTarget = (
  file: { oldPath?: string; newPath?: string },
  change: ChangeData,
  side: "old" | "new" | undefined,
): DiffLineCommentTarget | null => {
  const targetSide = side ?? (change.type === "delete" ? "old" : "new");
  if ((change.type === "insert" && targetSide === "old") || (change.type === "delete" && targetSide === "new")) {
    return null;
  }
  const oldPath = filePathForComment(file.oldPath) || filePathForComment(file.newPath);
  const newPath = filePathForComment(file.newPath) || filePathForComment(file.oldPath);
  if (!oldPath || !newPath) {
    return null;
  }
  const { oldLineNumber, newLineNumber } = getChangeLineNumbers(change);
  const lineNumber = targetSide === "old" ? oldLineNumber : newLineNumber;
  if (!lineNumber) {
    return null;
  }
  const displayPath = formatDiffPath(file.oldPath, file.newPath);
  return {
    oldPath,
    newPath,
    side: targetSide,
    oldLineNumber,
    newLineNumber,
    changeType: change.type,
    displayPath,
    changeKey: getChangeKey(change),
    lineLabel: `${displayPath}:${String(lineNumber)} ${targetSide === "old" ? "old" : "new"}`,
  };
};

const buildDiffLineCommentTargets = (file: { oldPath?: string; newPath?: string }, change: ChangeData): DiffLineCommentTarget[] =>
  [buildDiffLineCommentTarget(file, change, "old"), buildDiffLineCommentTarget(file, change, "new")].filter(
    (target): target is DiffLineCommentTarget => Boolean(target),
  );

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
  onDraft,
  draftDisabled = false,
}: {
  finding: RunDiffReviewFinding;
  globalIndex: number;
  active: boolean;
  onDraft?: () => void;
  draftDisabled?: boolean;
}) => (
  <div
    id={`buildwarden-review-finding-${String(globalIndex)}`}
    className={cn(
      "rounded-md border border-zinc-700/70 border-l-[3px] bg-zinc-950/80 px-2.5 py-1.5 text-[11px] text-zinc-300 transition-shadow",
      FINDING_PRIORITY_BORDER[finding.priority],
      active && "ring-2 ring-cyan-400/75 ring-offset-1 ring-offset-zinc-950",
    )}
  >
    <div className="flex min-w-0 items-start justify-between gap-2">
      <p className="min-w-0 font-medium text-zinc-100">{finding.title}</p>
      {onDraft ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-6 shrink-0 gap-1 px-1.5 text-[9px]"
          onClick={(event) => {
            event.stopPropagation();
            onDraft();
          }}
          disabled={draftDisabled}
        >
          {draftDisabled ? <Check className="h-3 w-3" aria-hidden /> : <MessageSquarePlus className="h-3 w-3" aria-hidden />}
          {draftDisabled ? "Drafted" : "Draft"}
        </Button>
      ) : null}
    </div>
    {finding.lineReference || finding.lineNumber ? (
      <p className="mt-0.5 font-mono text-[10px] text-zinc-500">{finding.lineReference ?? `line ${String(finding.lineNumber)}`}</p>
    ) : null}
    <p className="mt-1 leading-snug text-zinc-400">{finding.detail}</p>
    {finding.recommendation ? <p className="mt-1 text-[10px] text-cyan-200/90">Suggestion: {finding.recommendation}</p> : null}
  </div>
);

const DraftCommentCard = ({
  comment,
  editing,
  highlighted,
  onEdit,
  onRemove,
}: {
  comment: DiffPreviewManualComment;
  editing?: boolean;
  highlighted?: boolean;
  onEdit?: (id: string) => void;
  onRemove?: (id: string) => void;
}) => {
  const showDraftActions = !comment.remote;
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-1.5 text-[11px] text-zinc-300",
        comment.remote ? "border-zinc-700/80 bg-zinc-900/55" : "border-cyan-500/20 bg-cyan-500/[0.055]",
        editing && "border-cyan-400/60 ring-1 ring-cyan-400/40",
        highlighted && "border-cyan-300/80 ring-2 ring-cyan-300/40",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("text-[11px] font-semibold", comment.remote ? "text-zinc-100" : "text-cyan-100")}>
              {comment.remote ? (comment.author ?? "Reviewer") : "Draft comment"}
            </span>
            {comment.remote && comment.resolved ? (
              <span className="rounded-full border border-emerald-500/25 bg-emerald-500/[0.08] px-1.5 py-px text-[8px] font-semibold uppercase text-emerald-200">
                Resolved
              </span>
            ) : null}
            {comment.createdAt ? <span className="text-[9px] text-zinc-600">{new Date(comment.createdAt).toLocaleString()}</span> : null}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">
            {comment.lineLabel ?? `${comment.newPath || comment.oldPath}:${String(comment.newLineNumber ?? comment.oldLineNumber ?? "")}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showDraftActions && onEdit ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-5 w-5 text-zinc-400"
              title="Edit draft"
              aria-label="Edit draft"
              onClick={(event) => {
                event.stopPropagation();
                onEdit(comment.id);
              }}
              disabled={editing}
            >
              <Pencil className="h-3 w-3" aria-hidden />
            </Button>
          ) : null}
          {showDraftActions && onRemove ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-5 w-5 text-zinc-400"
              title="Remove draft"
              aria-label="Remove draft"
              onClick={(event) => {
                event.stopPropagation();
                onRemove(comment.id);
              }}
            >
              <Trash2 className="h-3 w-3" aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>
      {comment.title ? <p className="mt-1 text-[10px] font-medium text-zinc-400">{comment.title}</p> : null}
      <ActivityRichText content={comment.body} compact className="mt-1 break-words text-zinc-200" />
    </div>
  );
};

const InlineDraftCommentEditor = ({
  target,
  initialValue,
  editorKey,
  onSave,
  onSaveSingle,
  onCancel,
  saveLabel = "Add draft",
  singleSaveLabel = "Add single comment",
  singleSaveBusy = false,
}: {
  target: DiffLineCommentTarget;
  initialValue: string;
  editorKey: string;
  onSave: (value: string) => void;
  onSaveSingle?: (value: string) => void;
  onCancel: () => void;
  saveLabel?: string;
  singleSaveLabel?: string;
  singleSaveBusy?: boolean;
}) => {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    setValue(initialValue);
  }, [editorKey, initialValue]);

  return (
    <div
      className="rounded-md border border-cyan-500/30 bg-cyan-500/[0.075] px-2.5 py-2 text-[11px]"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 truncate font-mono text-[10px] text-cyan-100">{target.lineLabel}</p>
        <Button type="button" size="sm" variant="ghost" className="h-5 shrink-0 px-1.5 text-[9px] text-zinc-400" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="mt-1.5 h-16 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950/80 px-2 py-1.5 text-[11px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-500/70"
        placeholder="Write a diff comment..."
        autoFocus
      />
      <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
        {onSaveSingle ? (
          <Button type="button" size="sm" variant="secondary" className="h-7 px-2 text-[10px]" onClick={() => onSaveSingle(value)} disabled={!value.trim() || singleSaveBusy}>
            {singleSaveBusy ? "Posting..." : singleSaveLabel}
          </Button>
        ) : null}
        <Button type="button" size="sm" className="h-7 px-2 text-[10px]" onClick={() => onSave(value)} disabled={!value.trim()}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
};

type DiffFileSectionProps = {
  file: FileData;
  fileKey: string;
  filePathLabel: string;
  isLastFile: boolean;
  isCollapsed: boolean;
  anyFilesExpanded: boolean;
  alwaysExpandedFileSections: boolean;
  hideFileHeader: boolean;
  hideFileHeaderInlineToggle: boolean;
  viewType: "split" | "unified";
  wordDiff: boolean;
  fileNavEntries: ReviewNavEntry[];
  manualCommentIndex: DiffCommentIndex;
  manualCommentCountByTarget: Map<string, number>;
  activeCommentTarget: DiffLineCommentTarget | null;
  draftCommentText: string;
  draftCommentSaveLabel: string;
  singleCommentSaveLabel: string;
  singleCommentBusy: boolean;
  editingDraftCommentId: string | null;
  highlightedCommentId: string | null;
  safeReviewNavIndex: number;
  draftedReviewFindingKeys: Set<string> | null;
  onToggleCollapsed: (fileKey: string) => void;
  onOpenFile?: (path: string) => void;
  onAddDiffComment?: (target: DiffLineCommentTarget) => void;
  onSaveDraftComment?: (value: string) => void;
  onSaveSingleComment?: (value: string) => void;
  onCancelDraftComment?: () => void;
  onEditDraftComment?: (id: string) => void;
  onRemoveDraftComment?: (id: string) => void;
  onDraftReviewFinding?: (target: DiffLineCommentTarget, finding: RunDiffReviewFinding, findingKey: string) => void;
};

const DiffFileSection = memo(function DiffFileSection({
  file,
  fileKey,
  filePathLabel,
  isLastFile,
  isCollapsed,
  anyFilesExpanded,
  alwaysExpandedFileSections,
  hideFileHeader,
  hideFileHeaderInlineToggle,
  viewType,
  wordDiff,
  fileNavEntries,
  manualCommentIndex,
  manualCommentCountByTarget,
  activeCommentTarget,
  draftCommentText,
  draftCommentSaveLabel,
  singleCommentSaveLabel,
  singleCommentBusy,
  editingDraftCommentId,
  highlightedCommentId,
  safeReviewNavIndex,
  draftedReviewFindingKeys,
  onToggleCollapsed,
  onOpenFile,
  onAddDiffComment,
  onSaveDraftComment,
  onSaveSingleComment,
  onCancelDraftComment,
  onEditDraftComment,
  onRemoveDraftComment,
  onDraftReviewFinding,
}: DiffFileSectionProps) {
  const wordTokens = useMemo<HunkTokens | null>(() => {
    if (isCollapsed || viewType !== "unified" || !wordDiff) {
      return null;
    }
    return tokenize(file.hunks, { enhancers: [markEdits(file.hunks, { type: "line" })] });
  }, [file.hunks, isCollapsed, viewType, wordDiff]);

  const { diffWidgets, fallbackFileNavEntries } = useMemo(() => {
    const anchoredEntryGroups = new Map<string, { change: ChangeData; entries: ReviewNavEntry[] }>();
    const fallbackEntries: ReviewNavEntry[] = [];

    if (isCollapsed) {
      return { diffWidgets: {}, fallbackFileNavEntries: fallbackEntries };
    }

    for (const entry of fileNavEntries) {
      const change = findDiffChangeForFinding(file.hunks, entry.finding);
      if (!change) {
        fallbackEntries.push(entry);
        continue;
      }
      const changeKey = getChangeKey(change);
      const currentGroup = anchoredEntryGroups.get(changeKey);
      anchoredEntryGroups.set(changeKey, {
        change,
        entries: [...(currentGroup?.entries ?? []), entry],
      });
    }

    const widgetGroups = new Map<string, ReactNode[]>();
    const addInlineWidget = (changeKey: string, node: ReactNode) => {
      widgetGroups.set(changeKey, [...(widgetGroups.get(changeKey) ?? []), node]);
    };

    for (const [changeKey, { change, entries }] of anchoredEntryGroups.entries()) {
      const draftTarget = buildDiffLineCommentTarget(file, change, undefined);
      addInlineWidget(
        changeKey,
        <div className="space-y-2" key={`${fileKey}-review-widget-${changeKey}`}>
          {entries.map(({ finding, globalIndex }) => {
            const findingKey = reviewFindingDraftKey(finding, globalIndex);
            return (
              <ReviewFindingCard
                key={`${fileKey}-inline-review-${String(globalIndex)}`}
                finding={finding}
                globalIndex={globalIndex}
                active={safeReviewNavIndex === globalIndex}
                onDraft={draftTarget && onDraftReviewFinding ? () => onDraftReviewFinding(draftTarget, finding, findingKey) : undefined}
                draftDisabled={draftedReviewFindingKeys?.has(findingKey) ?? false}
              />
            );
          })}
        </div>,
      );
    }

    const activeCommentTargetKey = activeCommentTarget ? diffLineCommentTargetKey(activeCommentTarget) : null;
    const canRenderActiveCommentEditor = Boolean(activeCommentTarget) && Boolean(onSaveDraftComment) && Boolean(onCancelDraftComment);
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        const changeTargets = buildDiffLineCommentTargets(file, change);
        if (changeTargets.length === 0) {
          continue;
        }
        const changeTargetKeys = new Set(changeTargets.map(diffLineCommentTargetKey));
        const changeKey = getChangeKey(change);
        const commentsForChange = findCommentsForDiffTargets(manualCommentIndex, changeTargets);
        const visibleCommentsForChange = commentsForChange.filter((comment) => comment.id !== editingDraftCommentId);
        if (visibleCommentsForChange.length > 0) {
          addInlineWidget(
            changeKey,
            <div className="space-y-2" key={`${fileKey}-manual-comments-${changeKey}`}>
              {visibleCommentsForChange.map((comment) => (
                <DraftCommentCard
                  key={comment.id}
                  comment={comment}
                  editing={comment.id === editingDraftCommentId}
                  highlighted={comment.id === highlightedCommentId}
                  onEdit={onEditDraftComment}
                  onRemove={onRemoveDraftComment}
                />
              ))}
            </div>,
          );
        }
        if (activeCommentTargetKey && canRenderActiveCommentEditor && changeTargetKeys.has(activeCommentTargetKey) && activeCommentTarget) {
          addInlineWidget(
            changeKey,
            <InlineDraftCommentEditor
              key={`${fileKey}-manual-editor-${changeKey}`}
              target={activeCommentTarget}
              initialValue={draftCommentText}
              editorKey={editingDraftCommentId ?? activeCommentTargetKey}
              onSave={onSaveDraftComment as (value: string) => void}
              onSaveSingle={editingDraftCommentId ? undefined : onSaveSingleComment}
              onCancel={onCancelDraftComment as () => void}
              saveLabel={draftCommentSaveLabel}
              singleSaveLabel={singleCommentSaveLabel}
              singleSaveBusy={singleCommentBusy}
            />,
          );
        }
      }
    }

    return {
      diffWidgets: Object.fromEntries(
        [...widgetGroups.entries()].map(([changeKey, nodes]) => [
          changeKey,
          <div className="space-y-2 px-3 py-2" key={`${fileKey}-widget-${changeKey}`}>
            {nodes}
          </div>,
        ]),
      ),
      fallbackFileNavEntries: fallbackEntries,
    };
  }, [
    activeCommentTarget,
    draftedReviewFindingKeys,
    draftCommentSaveLabel,
    draftCommentText,
    editingDraftCommentId,
    file,
    fileKey,
    fileNavEntries,
    highlightedCommentId,
    isCollapsed,
    manualCommentIndex,
    onCancelDraftComment,
    onDraftReviewFinding,
    onEditDraftComment,
    onRemoveDraftComment,
    onSaveDraftComment,
    onSaveSingleComment,
    safeReviewNavIndex,
    singleCommentBusy,
    singleCommentSaveLabel,
  ]);

  const renderManualCommentGutter = useMemo(
    () =>
      onAddDiffComment
        ? (options: GutterOptions) => {
            const target = buildDiffLineCommentTarget(file, options.change, options.side);
            const count = target ? (manualCommentCountByTarget.get(diffLineCommentTargetKey(target)) ?? 0) : 0;
            return (
              <span className={cn("inline-flex min-w-full items-center justify-end gap-1", target && "group/diff-comment")}>
                <span>{options.renderDefault()}</span>
                {target ? (
                  <span
                    className={cn(
                      "rounded px-1 text-[9px] font-semibold transition",
                      count > 0 ? "bg-cyan-500/20 text-cyan-100" : "text-zinc-600 opacity-50 group-hover/diff-comment:opacity-100",
                    )}
                  >
                    {count > 0 ? String(count) : "+"}
                  </span>
                ) : null}
              </span>
            );
          }
        : undefined,
    [file, manualCommentCountByTarget, onAddDiffComment],
  );

  const manualCommentGutterEvents = useMemo<EventMap | undefined>(
    () =>
      onAddDiffComment
        ? {
            onClick: (args, event) => {
              const target = args.change ? buildDiffLineCommentTarget(file, args.change, args.side) : null;
              if (!target) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              onAddDiffComment(target);
            },
          }
        : undefined,
    [file, onAddDiffComment],
  );

  const manualCommentCodeEvents = useMemo<EventMap | undefined>(
    () =>
      onAddDiffComment
        ? {
            onClick: (args, event) => {
              const target = args.change ? buildDiffLineCommentTarget(file, args.change, args.side) : null;
              if (!target) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              onAddDiffComment(target);
            },
          }
        : undefined,
    [file, onAddDiffComment],
  );

  return (
    <div className={cn("border-b border-zinc-800", isLastFile && "border-b-0")}>
      {alwaysExpandedFileSections ? null : hideFileHeader ? (
        hideFileHeaderInlineToggle ? (
          <button
            type="button"
            className={cn(
              "z-10 rounded px-1 py-0.5 text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-300",
              anyFilesExpanded ? "absolute right-2 top-1" : "absolute right-0 top-[-1.55rem]",
            )}
            onClick={() => onToggleCollapsed(fileKey)}
            aria-label={isCollapsed ? "Expand diff" : "Collapse diff"}
            title={isCollapsed ? "Expand diff" : "Collapse diff"}
          >
            {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
          </button>
        ) : (
          <button
            type="button"
            className="sticky top-0 z-10 flex w-full items-center justify-end border-b border-zinc-800 bg-zinc-900/95 px-2 py-1 text-zinc-500 backdrop-blur-sm hover:text-zinc-300"
            onClick={() => onToggleCollapsed(fileKey)}
            aria-label={isCollapsed ? "Expand diff" : "Collapse diff"}
            title={isCollapsed ? "Expand diff" : "Collapse diff"}
          >
            {isCollapsed ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
          </button>
        )
      ) : onOpenFile ? (
        <div className="sticky top-0 z-10 flex w-full items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/95 px-3 py-1.5 text-left backdrop-blur-sm">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left transition hover:text-cyan-200"
            onClick={() => onOpenFile(filePathLabel)}
            title={`Open ${filePathLabel}`}
          >
            <p className="truncate text-xs font-medium text-zinc-100">{filePathLabel}</p>
            <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-zinc-500">{file.type}</span>
          </button>
          <button
            type="button"
            className="rounded px-1 py-0.5 text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-300"
            onClick={() => onToggleCollapsed(fileKey)}
            aria-label={isCollapsed ? "Expand diff" : "Collapse diff"}
            title={isCollapsed ? "Expand diff" : "Collapse diff"}
          >
            {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="sticky top-0 z-10 flex w-full items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/95 px-3 py-1.5 text-left backdrop-blur-sm"
          onClick={() => onToggleCollapsed(fileKey)}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <p className="truncate text-xs font-medium text-zinc-100">{filePathLabel}</p>
            <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-zinc-500">{file.type}</span>
          </div>
          {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
        </button>
      )}
      {!isCollapsed ? (
        <>
          <Diff
            viewType={viewType}
            diffType={file.type}
            hunks={file.hunks}
            tokens={wordTokens}
            widgets={diffWidgets}
            className="text-xs"
            codeClassName={onAddDiffComment ? "cursor-pointer transition hover:bg-cyan-500/[0.08]!" : undefined}
            renderGutter={renderManualCommentGutter}
            gutterEvents={manualCommentGutterEvents}
            codeEvents={manualCommentCodeEvents}
          >
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
                  <ReviewFindingCard key={`${fileKey}-review-${String(globalIndex)}`} finding={finding} globalIndex={globalIndex} active={safeReviewNavIndex === globalIndex} />
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
});

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
  manualCommentTargets?: DiffPreviewManualComment[] | null;
  activeCommentTarget?: DiffLineCommentTarget | null;
  draftCommentText?: string;
  draftCommentSaveLabel?: string;
  singleCommentSaveLabel?: string;
  singleCommentBusy?: boolean;
  editingDraftCommentId?: string | null;
  draftedReviewFindingKeys?: Set<string> | null;
  filePathQuery?: string;
  activeFilePath?: string | null;
  hideWhitespaceChanges?: boolean;
  highlightedCommentId?: string | null;
  onAddDiffComment?: (target: DiffLineCommentTarget) => void;
  onSaveDraftComment?: (value: string) => void;
  onSaveSingleComment?: (value: string) => void;
  onCancelDraftComment?: () => void;
  onEditDraftComment?: (id: string) => void;
  onRemoveDraftComment?: (id: string) => void;
  onDraftReviewFinding?: (target: DiffLineCommentTarget, finding: RunDiffReviewFinding, findingKey: string) => void;
  onParsedFilesChange?: (files: DiffPreviewFileSummary[]) => void;
  onOpenFile?: (path: string) => void;
  activityEmphasis?: boolean;
  hideFileHeader?: boolean;
  hideFileHeaderInlineToggle?: boolean;
  /** When true, render parsed file sections fully expanded without per-file toggle controls. */
  alwaysExpandedFileSections?: boolean;
  /** When true, each file section starts collapsed. */
  defaultCollapsedFileSections?: boolean;
  /** Virtualizes file sections for large PR/MR diffs. @default false */
  virtualizeFileSections?: boolean;
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
    manualCommentTargets = null,
    activeCommentTarget = null,
    draftCommentText = "",
    draftCommentSaveLabel = "Add draft",
    singleCommentSaveLabel = "Add single comment",
    singleCommentBusy = false,
    editingDraftCommentId = null,
    draftedReviewFindingKeys = null,
    filePathQuery = "",
    activeFilePath = null,
    hideWhitespaceChanges = false,
    highlightedCommentId = null,
    onAddDiffComment,
    onSaveDraftComment,
    onSaveSingleComment,
    onCancelDraftComment,
    onEditDraftComment,
    onRemoveDraftComment,
    onDraftReviewFinding,
    onParsedFilesChange,
    onOpenFile,
    activityEmphasis = false,
    hideFileHeader = false,
    hideFileHeaderInlineToggle = false,
    alwaysExpandedFileSections = false,
    defaultCollapsedFileSections = true,
    virtualizeFileSections = false,
    onAllFilesExpandedChange,
    fillContainer = false,
  }: GitDiffPreviewProps,
  ref: Ref<GitDiffPreviewHandle>,
) {
  const trimmedDiff = diffText.trim();
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const parsedFiles = useMemo(() => {
    if (!trimmedDiff || !looksLikeGitDiff(trimmedDiff)) {
      return [];
    }

    try {
      return parseDiff(trimmedDiff, { nearbySequences: "zip" });
    } catch {
      return [];
    }
  }, [trimmedDiff]);

  const whitespaceFilteredFiles = useMemo(() => {
    if (!hideWhitespaceChanges) {
      return parsedFiles;
    }
    return parsedFiles
      .map((file) => ({
        ...file,
        hunks: file.hunks
          .map((hunk) => ({ ...hunk, changes: filterWhitespaceOnlyChanges(hunk.changes) }))
          .filter((hunk) => hunk.changes.length > 0),
      }))
      .filter((file) => file.hunks.length > 0);
  }, [hideWhitespaceChanges, parsedFiles]);

  const fileSummaries = useMemo<DiffPreviewFileSummary[]>(
    () =>
      whitespaceFilteredFiles.map((file, index) => ({
        key: diffFileKey(file, index),
        path: formatDiffPath(file.oldPath, file.newPath),
        oldPath: file.oldPath && file.oldPath !== file.newPath ? file.oldPath : null,
        type: file.type,
        additions: file.hunks.reduce((sum, hunk) => sum + hunk.changes.filter((change) => change.type === "insert").length, 0),
        deletions: file.hunks.reduce((sum, hunk) => sum + hunk.changes.filter((change) => change.type === "delete").length, 0),
      })),
    [whitespaceFilteredFiles],
  );

  useEffect(() => {
    onParsedFilesChange?.(fileSummaries);
  }, [fileSummaries, onParsedFilesChange]);

  const files = useMemo(() => {
    const active = normalizeDiffPathSegment(activeFilePath ?? "");
    const query = normalizeDiffPathSegment(filePathQuery).toLowerCase();
    if (!active && !query) {
      return whitespaceFilteredFiles;
    }
    return whitespaceFilteredFiles.filter((file) => {
      const label = normalizeDiffPathSegment(formatDiffPath(file.oldPath, file.newPath));
      if (active) {
        return label === active || label.endsWith(`/${active}`) || active.endsWith(`/${label}`);
      }
      return label.toLowerCase().includes(query);
    });
  }, [activeFilePath, filePathQuery, whitespaceFilteredFiles]);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const fileIndexByKey = useMemo(() => new Map(files.map((file, index) => [diffFileKey(file, index), index])), [files]);
  const estimatedFileSectionSizes = useMemo(
    () =>
      files.map((file, index) => {
        const fileKey = diffFileKey(file, index);
        const isCollapsed = alwaysExpandedFileSections ? false : (collapsedFiles[fileKey] ?? defaultCollapsedFileSections);
        if (isCollapsed) {
          return hideFileHeader ? 28 : 34;
        }
        const lineCount = file.hunks.reduce((sum, hunk) => sum + hunk.changes.length, 0);
        const inlineDensity = reviewFindings?.length || manualCommentTargets?.length || activeCommentTarget ? 96 : 0;
        return Math.min(1200, Math.max(96, 36 + lineCount * 21 + inlineDensity));
      }),
    [
      activeCommentTarget,
      alwaysExpandedFileSections,
      collapsedFiles,
      defaultCollapsedFileSections,
      files,
      hideFileHeader,
      manualCommentTargets,
      reviewFindings,
    ],
  );
  const fileVirtualizer = useVirtualizer({
    count: virtualizeFileSections ? files.length : 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => estimatedFileSectionSizes[index] ?? 96,
    getItemKey: (index) => {
      const file = files[index];
      return file ? diffFileKey(file, index) : index;
    },
    measureElement: (element) => (element instanceof HTMLElement ? element.getBoundingClientRect().height : 1),
    useAnimationFrameWithResizeObserver: true,
    overscan: 4,
  });

  useEffect(() => {
    setCollapsedFiles({});
  }, [activeFilePath, filePathQuery, trimmedDiff]);

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

  const toggleFileCollapsed = useCallback(
    (fileKey: string) => {
      setCollapsedFiles((current) => ({ ...current, [fileKey]: !(current[fileKey] ?? defaultCollapsedFileSections) }));
    },
    [defaultCollapsedFileSections],
  );

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

  useLayoutEffect(() => {
    if (!virtualizeFileSections) {
      return;
    }
    fileVirtualizer.measure();
  }, [collapsedFiles, files, fileVirtualizer, hideWhitespaceChanges, reviewFindingsFingerprint, virtualizeFileSections, viewType]);

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
      const fileKey = reviewNavEntries[clamped]?.fileKey;
      const fileIndex = fileKey ? fileIndexByKey.get(fileKey) : undefined;
      if (virtualizeFileSections && fileIndex !== undefined) {
        fileVirtualizer.scrollToIndex(fileIndex, { align: "start" });
      }
      setActiveReviewNavIndex(clamped);
    },
    [expandFileForNavIndex, fileIndexByKey, fileVirtualizer, reviewNavEntries, reviewNavTotal, virtualizeFileSections],
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
    const fileKey = reviewNavEntries[safe]?.fileKey;
    const fileIndex = fileKey ? fileIndexByKey.get(fileKey) : undefined;
    if (virtualizeFileSections && fileIndex !== undefined) {
      fileVirtualizer.scrollToIndex(fileIndex, { align: "start" });
    }
    const id = `buildwarden-review-finding-${String(safe)}`;
    requestAnimationFrame(() => {
      const el = typeof document !== "undefined" ? document.getElementById(id) : null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }, [activeReviewNavIndex, fileIndexByKey, fileVirtualizer, reviewNavEntries, reviewNavTotal, virtualizeFileSections]);

  const safeReviewNavIndex = useMemo(
    () => (reviewNavTotal === 0 ? 0 : Math.min(activeReviewNavIndex, reviewNavTotal - 1)),
    [activeReviewNavIndex, reviewNavTotal],
  );

  const manualCommentCountByTarget = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of manualCommentTargets ?? []) {
      const key = diffLineCommentTargetKey(comment);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [manualCommentTargets]);

  const manualCommentIndex = useMemo(() => buildDiffCommentIndex(manualCommentTargets), [manualCommentTargets]);

  const { generalNavEntries, reviewEntriesByFileKey } = useMemo(() => {
    const general: ReviewNavEntry[] = [];
    const byFileKey = new Map<string, ReviewNavEntry[]>();

    for (const entry of reviewNavEntries) {
      if (!entry.fileKey) {
        general.push(entry);
        continue;
      }
      const current = byFileKey.get(entry.fileKey);
      if (current) {
        current.push(entry);
      } else {
        byFileKey.set(entry.fileKey, [entry]);
      }
    }

    return { generalNavEntries: general, reviewEntriesByFileKey: byFileKey };
  }, [reviewNavEntries]);

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

  if (parsedFiles.length > 0 && files.length === 0) {
    return (
      <div
        className={cn(
          "rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-xs text-zinc-500",
          className,
          fillContainer && "flex min-h-[10rem] flex-1 items-center justify-center",
        )}
      >
        No files match the current filter.
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
  const renderFileSection = (file: FileData, index: number) => {
    const fileKey = diffFileKey(file, index);
    const isCollapsed = alwaysExpandedFileSections ? false : (collapsedFiles[fileKey] ?? defaultCollapsedFileSections);
    const filePathLabel = formatDiffPath(file.oldPath, file.newPath);
    return (
      <DiffFileSection
        key={fileKey}
        file={file}
        fileKey={fileKey}
        filePathLabel={filePathLabel}
        isLastFile={index === files.length - 1}
        isCollapsed={isCollapsed}
        anyFilesExpanded={anyFilesExpanded}
        alwaysExpandedFileSections={alwaysExpandedFileSections}
        hideFileHeader={hideFileHeader}
        hideFileHeaderInlineToggle={hideFileHeaderInlineToggle}
        viewType={viewType}
        wordDiff={wordDiff}
        fileNavEntries={reviewEntriesByFileKey.get(fileKey) ?? []}
        manualCommentIndex={manualCommentIndex}
        manualCommentCountByTarget={manualCommentCountByTarget}
        activeCommentTarget={activeCommentTarget}
        draftCommentText={draftCommentText}
        draftCommentSaveLabel={draftCommentSaveLabel}
        singleCommentSaveLabel={singleCommentSaveLabel}
        singleCommentBusy={singleCommentBusy}
        editingDraftCommentId={editingDraftCommentId}
        highlightedCommentId={highlightedCommentId}
        safeReviewNavIndex={safeReviewNavIndex}
        draftedReviewFindingKeys={draftedReviewFindingKeys}
        onToggleCollapsed={toggleFileCollapsed}
        onOpenFile={onOpenFile}
        onAddDiffComment={onAddDiffComment}
        onSaveDraftComment={onSaveDraftComment}
        onSaveSingleComment={onSaveSingleComment}
        onCancelDraftComment={onCancelDraftComment}
        onEditDraftComment={onEditDraftComment}
        onRemoveDraftComment={onRemoveDraftComment}
        onDraftReviewFinding={onDraftReviewFinding}
      />
    );
  };
  const virtualFileItems = virtualizeFileSections ? fileVirtualizer.getVirtualItems() : [];

  return (
    <div
      ref={scrollContainerRef}
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
        {virtualizeFileSections ? (
          <div className="relative" style={{ height: `${String(fileVirtualizer.getTotalSize())}px` }}>
            {virtualFileItems.map((virtualFile) => {
              const file = files[virtualFile.index];
              if (!file) {
                return null;
              }
              const virtualStyle: CSSProperties = {
                position: "absolute",
                left: 0,
                top: 0,
                width: "100%",
                transform: `translateY(${String(virtualFile.start)}px)`,
              };
              return (
                <div
                  key={virtualFile.key}
                  ref={(node) => {
                    if (node) {
                      fileVirtualizer.measureElement(node);
                    }
                  }}
                  data-index={virtualFile.index}
                  style={virtualStyle}
                >
                  {renderFileSection(file, virtualFile.index)}
                </div>
              );
            })}
          </div>
        ) : (
          files.map((file, index) => renderFileSection(file, index))
        )}
      </div>
    </div>
  );
});
