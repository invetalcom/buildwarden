import type { ReactNode } from "react";
import type { ChangeTypes } from "@pierre/diffs";
import { ChevronRight, FileText } from "lucide-react";
import { cn } from "../../lib/cn";

type DiffChangeKind = { letter: string; label: string; toneClass: string };

const DIFF_CHANGE_KINDS: Record<ChangeTypes, DiffChangeKind> = {
  change: { letter: "M", label: "Modified", toneClass: "bg-[var(--ec-warning-soft)] text-[var(--ec-warning)] ring-[var(--ec-warning-ring)]" },
  new: { letter: "A", label: "Added", toneClass: "bg-[var(--ec-success-soft)] text-[var(--ec-success)] ring-[var(--ec-success-ring)]" },
  deleted: { letter: "D", label: "Deleted", toneClass: "bg-[var(--ec-danger-soft)] text-[var(--ec-danger)] ring-[var(--ec-danger-ring)]" },
  "rename-pure": { letter: "R", label: "Renamed", toneClass: "bg-[var(--ec-info-soft)] text-[var(--ec-info)] ring-[var(--ec-info-ring)]" },
  "rename-changed": { letter: "R", label: "Renamed and modified", toneClass: "bg-[var(--ec-info-soft)] text-[var(--ec-info)] ring-[var(--ec-info-ring)]" },
};

/** Splits a repo-relative path into its file name and parent directory for two-tone rendering. */
const splitDiffPath = (path: string): { name: string; dir: string } => {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? { name: normalized, dir: "" } : { name: normalized.slice(slash + 1), dir: normalized.slice(0, slash) };
};

/** Git-style single-letter status chip (M/A/D/R). A null type renders a neutral placeholder of the same size. */
export const DiffFileStatusBadge = ({ type, className }: { type: ChangeTypes | null; className?: string }) => {
  const kind = type ? DIFF_CHANGE_KINDS[type] : null;
  return (
    <span
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[9px] font-bold leading-none ring-1 ring-inset",
        kind?.toneClass ?? "bg-[var(--ec-muted-soft)] text-[var(--ec-faint)] ring-[var(--ec-border)]",
        className,
      )}
      title={kind?.label}
      aria-label={kind?.label}
    >
      {kind?.letter ?? "·"}
    </span>
  );
};

/** Compact `+12 −3` counts; null counts mean a binary or otherwise non-text change. */
export const DiffLineCounts = ({ additions, deletions, className }: { additions: number | null; deletions: number | null; className?: string }) => (
  <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums", className)}>
    {additions === null || deletions === null ? (
      <span className="text-[var(--ec-faint)]">binary</span>
    ) : (
      <>
        <span className={additions > 0 ? "text-[var(--ec-success)]" : "text-[var(--ec-faint)]"}>+{additions}</span>
        <span className={deletions > 0 ? "text-[var(--ec-danger)]" : "text-[var(--ec-faint)]"}>−{deletions}</span>
      </>
    )}
  </span>
);

const STAT_BAR_SEGMENTS = 5;

/** GitHub-style five-block ratio bar of additions vs deletions. */
export const DiffStatBar = ({ additions, deletions, className }: { additions: number | null; deletions: number | null; className?: string }) => {
  const total = (additions ?? 0) + (deletions ?? 0);
  let added = total > 0 ? Math.round((STAT_BAR_SEGMENTS * (additions ?? 0)) / total) : 0;
  if (total > 0 && (additions ?? 0) > 0) added = Math.max(1, added);
  if (total > 0 && (deletions ?? 0) > 0) added = Math.min(STAT_BAR_SEGMENTS - 1, added);
  const deleted = total > 0 ? STAT_BAR_SEGMENTS - added : 0;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-px", className)} aria-hidden>
      {Array.from({ length: STAT_BAR_SEGMENTS }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-2 w-1.5 rounded-[1px]",
            index < added ? "bg-[var(--ec-success)]" : index < added + deleted ? "bg-[var(--ec-danger)]" : "bg-[var(--ec-border)]",
          )}
        />
      ))}
    </span>
  );
};

type DiffFileHeaderRowProps = {
  path: string;
  previousPath?: string | null;
  type: ChangeTypes | null;
  additions: number | null;
  deletions: number | null;
  expanded: boolean;
  /** Pins the row to the top of the scroll container while its diff body is visible. */
  sticky?: boolean;
  onToggle: () => void;
  onOpenFile?: () => void;
  trailing?: ReactNode;
};

/** One changed-file row: chevron, status chip, file name + dimmed directory, line counts, and a hover open action. */
export const DiffFileHeaderRow = ({
  path,
  previousPath = null,
  type,
  additions,
  deletions,
  expanded,
  sticky = false,
  onToggle,
  onOpenFile,
  trailing,
}: DiffFileHeaderRowProps) => {
  const { name, dir } = splitDiffPath(path);
  const renamedFrom = previousPath && previousPath !== path ? previousPath : null;
  return (
    <div
      className={cn(
        "group/diff-file relative flex h-8 w-full items-center gap-2 pl-1.5 pr-2 text-left transition-colors",
        expanded
          ? "border-b border-[var(--ec-border)] bg-[var(--ec-panel-strong)] backdrop-blur-sm before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-[var(--ec-accent)]"
          : "hover:bg-[var(--ec-hover)]",
        sticky && expanded && "sticky top-0 z-10",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]"
        onClick={onToggle}
        title={path}
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-[var(--ec-faint)] transition-transform group-hover/diff-file:text-[var(--ec-muted)]", expanded && "rotate-90 text-[var(--ec-muted)]")}
          aria-hidden
        />
        <DiffFileStatusBadge type={type} />
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={cn("min-w-0 truncate text-xs font-medium", type === "deleted" ? "text-[var(--ec-muted)] line-through decoration-[var(--ec-faint)]" : "text-[var(--ec-text)]")}>
            {name}
          </span>
          {dir ? <span className="min-w-0 shrink-[100] truncate text-[10px] text-[var(--ec-faint)]">{dir}</span> : null}
          {renamedFrom ? <span className="min-w-0 shrink-[50] truncate text-[10px] text-[var(--ec-info)]" title={`Renamed from ${renamedFrom}`}>← {splitDiffPath(renamedFrom).name}</span> : null}
        </span>
      </button>
      <DiffLineCounts additions={additions} deletions={deletions} />
      <DiffStatBar additions={additions} deletions={deletions} className="max-[420px]:hidden" />
      {trailing}
      {onOpenFile ? (
        <button
          type="button"
          className="-mr-1 rounded p-1 text-[var(--ec-faint)] opacity-0 transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-accent-strong)] focus-visible:opacity-100 group-hover/diff-file:opacity-100"
          onClick={onOpenFile}
          aria-label={`Open file ${path}`}
          title={`Open file ${path}`}
        >
          <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </button>
      ) : null}
    </div>
  );
};
