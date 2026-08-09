import { ChevronRight, Workflow } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn";

export const RunHierarchyToggle = ({
  runId,
  runLabel,
  descendantCount,
  expanded,
  compact = false,
  onToggle,
  className,
}: {
  runId: string;
  runLabel: string;
  descendantCount: number;
  expanded: boolean;
  compact?: boolean;
  onToggle: (runId: string) => void;
  className?: string;
}) => {
  const subagentLabel = `${String(descendantCount)} ${descendantCount === 1 ? "subagent" : "subagents"}`;
  return (
    <button
      type="button"
      data-run-hierarchy-toggle={runId}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${subagentLabel} for ${runLabel}`}
      title={`${expanded ? "Hide" : "Show"} ${subagentLabel}`}
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)] transition hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]",
        compact ? "h-5 gap-0.5 px-1" : "h-6 gap-1 px-1.5",
        className,
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(runId);
      }}
    >
      <Workflow className={compact ? "size-3" : "size-3.5"} aria-hidden />
      <span className="font-mono text-[9px] font-semibold tabular-nums">{descendantCount}</span>
      <ChevronRight
        className={cn("size-3 transition-transform duration-150", expanded && "rotate-90")}
        aria-hidden
      />
    </button>
  );
};

export const RunHierarchyIndent = ({
  depth,
  indentPx = 16,
  className,
  children,
}: {
  depth: number;
  indentPx?: number;
  className?: string;
  children: ReactNode;
}) => {
  const connectorLeft = Math.max(0, depth * indentPx - Math.round(indentPx / 2));
  return (
    <div
      data-run-hierarchy-depth={depth}
      className={cn("relative", depth > 0 && "run-tree-row-enter", className)}
      style={{ paddingLeft: depth * indentPx } as CSSProperties}
    >
      {depth > 0 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 h-1/2 rounded-bl border-b border-l border-[var(--ec-border-strong)]"
          style={{ left: connectorLeft, width: Math.max(6, Math.round(indentPx / 2)) }}
        />
      ) : null}
      {children}
    </div>
  );
};
