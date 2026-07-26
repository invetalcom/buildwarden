import { useMemo, useState } from "react";
import { summarizeDiffStats, type GitDiffFileStat } from "@buildwarden/renderer/logic";
import { ChevronLeft, FileDiff } from "lucide-react";
import { cn } from "../lib/cn";
import { splitDiffByFile } from "../lib/text-blocks";
import { EmptyState, ListRow } from "./primitives";

/**
 * Unified diff viewer for phones.
 *
 * File statistics come from the shared `summarizeDiffStats`, so counts always agree with the
 * desktop UI. Rendering is deliberately unified-only and file-at-a-time: side-by-side needs two
 * columns of code, which does not exist on a 360px screen.
 */

const MAX_RENDERED_LINES = 1200;

const lineTone = (line: string): string => {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) {
    return "text-[var(--ec-faint)]";
  }
  if (line.startsWith("@@")) return "bg-[var(--ec-info-soft)] text-[var(--ec-info)]";
  if (line.startsWith("+")) return "bg-[var(--ec-success-soft)] text-[var(--ec-success)]";
  if (line.startsWith("-")) return "bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]";
  return "text-[var(--ec-muted)]";
};

const FileDiffBody = ({ diff }: { diff: string }) => {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  const [limit, setLimit] = useState(MAX_RENDERED_LINES);
  const visible = lines.slice(0, limit);

  return (
    <div className="m-scroll flex-1">
      <div className="m-scroll-x m-mono min-w-full text-[11.5px] leading-[1.55]">
        {visible.map((line, index) => (
          <div key={index} className={cn("whitespace-pre px-3", lineTone(line))}>
            {line || " "}
          </div>
        ))}
      </div>
      {lines.length > limit ? (
        <button
          type="button"
          onClick={() => setLimit((current) => current + MAX_RENDERED_LINES)}
          className="m-tap m-4 rounded-md border border-[var(--ec-border)] px-4 text-xs font-medium text-[var(--ec-muted)]"
        >
          Show {Math.min(lines.length - limit, MAX_RENDERED_LINES)} more lines
        </button>
      ) : null}
    </div>
  );
};

const StatBadges = ({ file }: { file: GitDiffFileStat }) => (
  <>
    {file.additions ? <span className="text-[var(--ec-success)]">+{file.additions}</span> : null}
    {file.deletions ? <span className="text-[var(--ec-danger)]">−{file.deletions}</span> : null}
  </>
);

export const DiffViewer = ({ diff }: { diff: string }) => {
  const [selected, setSelected] = useState<string | null>(null);
  const stats = useMemo(() => summarizeDiffStats(diff), [diff]);
  const chunks = useMemo(() => splitDiffByFile(diff), [diff]);

  if (stats.totalFiles === 0) {
    return diff.trim() ? (
      <FileDiffBody diff={diff} />
    ) : (
      <EmptyState icon={<FileDiff className="size-7" />} title="No changes" message="This run has not modified any files yet." />
    );
  }

  if (selected) {
    const body = chunks.get(selected);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--ec-border)] px-1 py-1">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="m-tap inline-flex items-center gap-1 px-2 text-xs font-medium text-[var(--ec-accent)]"
          >
            <ChevronLeft className="size-4" />
            Files
          </button>
          <p className="m-mono min-w-0 flex-1 truncate text-[11px] text-[var(--ec-muted)]" dir="rtl">
            {selected}
          </p>
        </div>
        {body ? <FileDiffBody diff={body} /> : <EmptyState title="File not found in the diff" />}
      </div>
    );
  }

  return (
    <div className="m-scroll flex-1">
      <div className="flex items-center gap-3 border-b border-[var(--ec-border)] px-4 py-2.5 text-xs text-[var(--ec-muted)]">
        <span>{stats.totalFiles} {stats.totalFiles === 1 ? "file" : "files"}</span>
        <span className="text-[var(--ec-success)]">+{stats.totalAdditions}</span>
        <span className="text-[var(--ec-danger)]">−{stats.totalDeletions}</span>
      </div>
      {stats.files.map((file) => (
        <ListRow
          key={file.path}
          title={<span className="m-mono text-[12.5px]">{file.path.split("/").pop()}</span>}
          subtitle={file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : undefined}
          trailing={<StatBadges file={file} />}
          onClick={() => setSelected(file.path)}
        />
      ))}
    </div>
  );
};
