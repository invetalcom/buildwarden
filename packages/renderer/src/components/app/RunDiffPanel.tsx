import { useRef, useState, type ReactNode } from "react";
import { Bot, ChevronsDownUp, ChevronsUpDown, ListFilter, Loader2, ScanSearch, Search, Space, X } from "lucide-react";
import type { RunWorktreeDiffSummary } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DiffReviewPanel, type DiffReviewPanelState } from "./diff-review-panel";
import { DiffLineCounts, DiffStatBar } from "./git-diff-file-meta";
import { GitDiffPreview, type GitDiffPreviewHandle } from "./git-diff-preview";
import { RunDiffLoadError } from "./RunDiffLoadError";
import { ComposerSelect, type ComposerSelectOption } from "./RunComposer";

const ToolbarToggle = ({ active = false, label, disabled = false, onClick, children }: {
  active?: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Button
    type="button"
    variant="ghost"
    size="icon"
    className={cn("h-7 w-7", active && "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)] hover:bg-[var(--ec-accent-soft)] hover:text-[var(--ec-accent-strong)]")}
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={label}
    aria-pressed={active}
  >
    {children}
  </Button>
);

type RunDiffPanelProps = {
  runId: string;
  diffText: string;
  diffStats: RunWorktreeDiffSummary;
  diffLoaded: boolean;
  diffPending: boolean;
  diffLoadError?: string | null;
  onRequestDiff: (runId: string) => void;
  onOpenFile: (path: string) => void;
  /** Reviewer controls are omitted when null (e.g. hosted web renderer). */
  review: {
    state: DiffReviewPanelState;
    canRun: boolean;
    modelId: string;
    modelOptions: ComposerSelectOption[];
    onModelChange: (modelId: string) => void;
    onRun: () => void;
  } | null;
};

/** Run detail "Git Diff" side panel: a flat summary toolbar above a single card of collapsible file diffs. */
export const RunDiffPanel = ({
  runId,
  diffText,
  diffStats,
  diffLoaded,
  diffPending,
  diffLoadError = null,
  onRequestDiff,
  onOpenFile,
  review,
}: RunDiffPanelProps) => {
  const gitDiffRef = useRef<GitDiffPreviewHandle>(null);
  const [allFilesExpanded, setAllFilesExpanded] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [hideWhitespace, setHideWhitespace] = useState(false);

  const hasPatch = Boolean(diffText.trim());
  const loading = !diffLoaded || diffPending;
  let statusText: string | null = null;
  if (loading && !(diffLoadError && !diffPending)) {
    statusText = hasPatch ? "Refreshing changes…" : "Loading file diffs…";
  }
  const reviewBusy = review?.state.busy ?? false;
  const showReviewPanel = review && (review.state.busy || review.state.error || review.state.result);

  const closeFilter = () => {
    setFilterOpen(false);
    setFilterQuery("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="relative shrink-0 border-b border-[var(--ec-border)]">
        <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {diffStats.totalFiles > 0 ? (
              <>
                <span className="shrink-0 text-xs text-[var(--ec-muted)]">
                  <span className="font-semibold tabular-nums text-[var(--ec-text)]">{diffStats.totalFiles}</span>
                  {diffStats.totalFiles === 1 ? " file" : " files"}
                </span>
                <DiffLineCounts additions={diffStats.totalAdditions} deletions={diffStats.totalDeletions} className="text-[11px]" />
                <DiffStatBar additions={diffStats.totalAdditions} deletions={diffStats.totalDeletions} />
              </>
            ) : (
              <span className="shrink-0 text-xs text-[var(--ec-muted)]">{loading ? "Changes" : "No changes"}</span>
            )}
            {statusText ? (
              <span role="status" className="flex min-w-0 items-center gap-1 text-[10px] text-[var(--ec-faint)]">
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
                <span className="truncate">{statusText}</span>
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <ToolbarToggle
              active={filterOpen}
              label={filterOpen ? "Hide file filter" : "Filter files"}
              disabled={!hasPatch}
              onClick={() => (filterOpen ? closeFilter() : setFilterOpen(true))}
            >
              <ListFilter className="h-3.5 w-3.5" aria-hidden />
            </ToolbarToggle>
            <ToolbarToggle
              active={hideWhitespace}
              label={hideWhitespace ? "Show whitespace changes" : "Ignore whitespace changes"}
              disabled={!hasPatch}
              onClick={() => setHideWhitespace((current) => !current)}
            >
              <Space className="h-3.5 w-3.5" aria-hidden />
            </ToolbarToggle>
            <ToolbarToggle
              label={allFilesExpanded ? "Collapse all files" : "Expand all files"}
              disabled={diffStats.totalFiles === 0 && !hasPatch}
              onClick={() => gitDiffRef.current?.toggleExpandAllFiles()}
            >
              {allFilesExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden />}
            </ToolbarToggle>
            {review ? (
              <>
                <span className="mx-1 h-4 w-px bg-[var(--ec-border)]" aria-hidden />
                <ComposerSelect
                  value={review.modelId}
                  onChange={review.onModelChange}
                  disabled={reviewBusy || review.modelOptions.length === 0}
                  icon={Bot}
                  iconClassName="text-[var(--ec-accent)]"
                  buttonClassName="h-7 max-w-[10rem] rounded-md border-transparent bg-transparent px-1.5 text-[11px] hover:border-[var(--ec-border)] hover:bg-[var(--ec-hover)]"
                  options={review.modelOptions}
                  menuWidthPx={352}
                  menuSide="bottom"
                />
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  className="h-7 shrink-0 gap-1.5 px-2 text-[11px]"
                  onClick={review.onRun}
                  disabled={reviewBusy || !review.canRun}
                  title="Run reviewer simulator"
                >
                  {reviewBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ScanSearch className="h-3.5 w-3.5" aria-hidden />}
                  {review.state.result ? "Review again" : "Review"}
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {filterOpen ? (
          <div className="px-2.5 pb-1.5"><div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--ec-faint)]" aria-hidden />
            <Input
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeFilter();
              }}
              placeholder="Filter changed files"
              aria-label="Filter changed files"
              className="h-7 pl-7 pr-7 text-[11px]"
              autoFocus
            />
            {filterQuery ? (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--ec-faint)] hover:text-[var(--ec-text)]"
                onClick={() => setFilterQuery("")}
                aria-label="Clear file filter"
                title="Clear file filter"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            ) : null}
          </div></div>
        ) : null}
        {statusText ? <div className="run-activity-loading-bar absolute inset-x-0 -bottom-px" aria-hidden /> : null}
      </div>
      <RunDiffLoadError error={diffLoadError} hasPatch={hasPatch} pending={diffPending} onRetry={() => onRequestDiff(runId)} />
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
        {review && showReviewPanel ? (
          <div className="mb-2">
            <DiffReviewPanel state={review.state} onRun={review.onRun} disabled={!review.canRun} defaultExpanded compact hideRunButton />
          </div>
        ) : null}
        <GitDiffPreview
          ref={gitDiffRef}
          diffText={diffText}
          pendingFiles={diffStats.files}
          loading={loading}
          className="max-h-none overflow-visible"
          emptyMessage={
            diffLoadError ? "Changes unavailable. Retry to load the diff."
              : "No diff generated yet. This can happen if the run completed without repository changes or git has not refreshed yet."
          }
          activityEmphasis
          defaultCollapsedFileSections
          filePathQuery={filterQuery}
          hideWhitespaceChanges={hideWhitespace}
          onAllFilesExpandedChange={setAllFilesExpanded}
          onOpenFile={onOpenFile}
        />
      </div>
    </div>
  );
};
