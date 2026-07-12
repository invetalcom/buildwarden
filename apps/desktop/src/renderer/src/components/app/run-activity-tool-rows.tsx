import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { RunTimelineDensity } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { ActivityMarkdownOrGitDiff } from "./activity-message-body";
import { GitDiffPreview } from "./git-diff-preview";
import { looksLikeGitDiff } from "./git-diff-utils";
import {
  isOpenableToolPath,
  type ToolBatchSummarizedRow,
} from "./run-activity-tool-model";
import {
  type RunActivityRun,
} from "./run-activity-model";
const ActivityFilePathButton = ({
  path,
  onOpenWorkspaceFile,
  className,
}: {
  path: string;
  onOpenWorkspaceFile?: (path: string) => void;
  className?: string;
}) => {
  if (!onOpenWorkspaceFile) {
    return <span className={className}>{path}</span>;
  }
  return (
    <button
      type="button"
      className={cn("min-w-0 truncate text-left font-mono text-[color:var(--ec-muted)] hover:text-[color:var(--ec-accent)]", className)}
      title={`Open ${path}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenWorkspaceFile(path);
      }}
    >
      {path}
    </button>
  );
};

const toolStatusColor = (failed: boolean | undefined, streaming: boolean | undefined): string => {
  if (failed) {
    return "var(--ec-danger)";
  }
  if (streaming) {
    return "var(--ec-accent)";
  }
  return "var(--ec-faint)";
};

const toolStatusLabel = (failed: boolean | undefined, streaming: boolean | undefined): string => {
  if (failed) {
    return "failed";
  }
  if (streaming) {
    return "running";
  }
  return "finished";
};

const ToolDetailCell = ({
  item,
  canOpenDetailPath,
  onOpenWorkspaceFile,
  fallback,
}: Readonly<{
  item: ToolBatchSummarizedRow;
  canOpenDetailPath: boolean;
  onOpenWorkspaceFile?: (path: string) => void;
  fallback: string;
}>) => {
  if (item.command) {
    return <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--ec-muted)]">{item.command}</span>;
  }
  if (canOpenDetailPath && item.detail) {
    return <ActivityFilePathButton path={item.detail} onOpenWorkspaceFile={onOpenWorkspaceFile} className="flex-1" />;
  }
  return <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--ec-muted)]">{fallback}</span>;
};

type ActivityToolBatchRowProps = {
  item: ToolBatchSummarizedRow;
  itemIndex: number;
  run: RunActivityRun;
  density: RunTimelineDensity;
  busy: boolean;
  readOnly: boolean;
  onCancelRunShell?: (run: RunActivityRun, toolCallId: string) => void;
  onOpenWorkspaceFile?: (path: string) => void;
};

const ToolBatchMeta = ({ item }: Readonly<{ item: ToolBatchSummarizedRow }>) => (
  <div className="agent-tool-meta">
    <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
    <span>{toolStatusLabel(item.failed, item.shellStreaming)}</span>
    {item.toolCallId ? <span className="truncate">call {item.toolCallId}</span> : null}
  </div>
);

const ToolBatchPaths = ({
  paths,
  onOpenWorkspaceFile,
}: Readonly<{ paths: string[] | undefined; onOpenWorkspaceFile?: (path: string) => void }>) => {
  if (!paths?.length) return null;
  return (
    <ul className="app-scrollbar mt-1 grid max-h-40 list-none grid-cols-1 gap-x-4 gap-y-0.5 overflow-y-auto border-l border-[color:var(--ec-border)] py-0.5 pl-3 font-mono text-[10px] leading-snug text-[color:var(--ec-muted)] sm:max-h-48 sm:grid-cols-2 xl:grid-cols-3">
      {paths.map((path, index) => (
        <li key={`${String(index)}-${path.slice(0, 80)}`} className="min-w-0 break-words" title={path}>
          <ActivityFilePathButton path={path} onOpenWorkspaceFile={onOpenWorkspaceFile} className="max-w-full break-words" />
        </li>
      ))}
    </ul>
  );
};

const ToolBatchTriggerContent = ({
  item,
  density,
  fallback,
  showChevron,
  onOpenWorkspaceFile,
}: Readonly<{
  item: ToolBatchSummarizedRow;
  density: RunTimelineDensity;
  fallback: string;
  showChevron: boolean;
  onOpenWorkspaceFile?: (path: string) => void;
}>) => {
  const shellLineCount = item.toolName === "run_shell" && item.preview ? item.preview.split(/\r?\n/).length : 0;
  return (
    <>
      {showChevron ? <ChevronDown className="h-3 w-3 shrink-0 text-[color:var(--ec-faint)] transition group-open:rotate-180" /> : <span className="h-3 w-3 shrink-0" aria-hidden />}
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: toolStatusColor(item.failed, item.shellStreaming) }} />
      <span className="shrink-0 font-semibold text-[color:var(--ec-text)]">{item.toolName}</span>
      <ToolDetailCell
        item={item}
        canOpenDetailPath={isOpenableToolPath(item.toolName, item.detail)}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        fallback={fallback}
      />
      {item.count > 1 ? <span className="shrink-0 text-[10px] text-[color:var(--ec-faint)]">x{item.count}</span> : null}
      {item.toolName === "run_shell" && item.preview && density !== "compact" ? (
        <span className="agent-tool-extra shrink-0 text-[10px] text-[color:var(--ec-faint)]">
          {item.shellStreaming ? "live" : "output"} - {shellLineCount} line{shellLineCount === 1 ? "" : "s"}
        </span>
      ) : null}
      {item.shellStreaming ? <span className="agent-tool-live-dots" aria-hidden /> : null}
    </>
  );
};

const ToolBatchBody = ({
  item,
  density,
  onOpenWorkspaceFile,
}: Pick<ActivityToolBatchRowProps, "item" | "density" | "onOpenWorkspaceFile">) => {
  const hasExpandableContent = Boolean(item.preview) || Boolean(item.paths?.length);
  let fallback = item.detail ?? "";
  if (!fallback && item.paths?.length) fallback = `${item.paths.length} files`;

  if (!hasExpandableContent) {
    return (
      <>
        <div className={cn("agent-tool-trigger agent-tool-trigger--static", item.shellStreaming && "agent-tool-trigger--live")}>
          <ToolBatchTriggerContent item={item} density={density} fallback={fallback} showChevron={false} onOpenWorkspaceFile={onOpenWorkspaceFile} />
        </div>
        {density === "detailed" ? <ToolBatchMeta item={item} /> : null}
      </>
    );
  }

  return (
    <details className="agent-tool-details group w-full max-w-full">
      <summary className={cn("agent-tool-trigger", item.shellStreaming && "agent-tool-trigger--live")}>
        <ToolBatchTriggerContent item={item} density={density} fallback={fallback} showChevron onOpenWorkspaceFile={onOpenWorkspaceFile} />
      </summary>
      <ToolBatchPaths paths={item.paths} onOpenWorkspaceFile={onOpenWorkspaceFile} />
      {item.preview ? (
        <pre className={cn("agent-pre app-scrollbar mt-1 max-h-[min(70vh,36rem)] overflow-auto whitespace-pre-wrap break-words text-[10px] leading-snug", item.failed ? "border-[color:var(--ec-danger-ring)]" : null)}>
          {item.preview}
        </pre>
      ) : null}
      {density === "detailed" ? <ToolBatchMeta item={item} /> : null}
    </details>
  );
};

const canCancelToolBatchShell = (
  item: ToolBatchSummarizedRow,
  run: RunActivityRun,
  readOnly: boolean,
  onCancelRunShell: ActivityToolBatchRowProps["onCancelRunShell"],
) =>
  !readOnly &&
  item.toolName === "run_shell" &&
  item.shellStreaming === true &&
  typeof item.toolCallId === "string" &&
  ["queued", "preparing", "running"].includes(run.status) &&
  Boolean(onCancelRunShell);

const hasToolBatchInlineDiff = (item: ToolBatchSummarizedRow) =>
  !item.failed && Boolean(item.writeFileDiff) && looksLikeGitDiff(item.writeFileDiff ?? "");

const ToolBatchActions = ({
  canCancelShell,
  hasInlineDiff,
  busy,
  expanded,
  onCancel,
  onToggleDiff,
}: Readonly<{
  canCancelShell: boolean;
  hasInlineDiff: boolean;
  busy: boolean;
  expanded: boolean;
  onCancel: () => void;
  onToggleDiff: () => void;
}>) => {
  if (!canCancelShell && !hasInlineDiff) return null;
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      {canCancelShell ? (
        <Button type="button" variant="ghost" size="sm" className="h-6 border-[color:var(--ec-danger-ring)] bg-[color:var(--ec-danger-soft)] px-2 text-[10px] text-[color:var(--ec-danger)] hover:bg-[color:var(--ec-danger-soft)]" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      {hasInlineDiff ? (
        <button type="button" className="rounded px-0.5 py-0.5 text-[color:var(--ec-muted)] transition hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]" onClick={onToggleDiff} aria-label={expanded ? "Collapse diff" : "Expand diff"} title={expanded ? "Collapse diff" : "Expand diff"}>
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      ) : null}
    </div>
  );
};

const ToolBatchInlineDiff = ({
  visible,
  item,
  density,
  onOpenWorkspaceFile,
}: Readonly<{ visible: boolean; item: ToolBatchSummarizedRow; density: RunTimelineDensity; onOpenWorkspaceFile?: (path: string) => void }>) => {
  if (!visible || !item.writeFileDiff) return null;
  return (
    <div className="mt-1.5 min-w-0 w-full">
      <GitDiffPreview diffText={item.writeFileDiff} emptyMessage="Could not parse file diff." compact={density !== "detailed"} viewType="unified" activityEmphasis hideFileHeader alwaysExpandedFileSections onOpenFile={onOpenWorkspaceFile} />
    </div>
  );
};

export const ActivityToolBatchRow = ({
  item,
  itemIndex,
  run,
  density,
  busy,
  readOnly,
  onCancelRunShell,
  onOpenWorkspaceFile,
}: ActivityToolBatchRowProps) => {
  const [writeFileDiffExpanded, setWriteFileDiffExpanded] = useState(false);
  const hasInlineDiff = hasToolBatchInlineDiff(item);
  const canCancelShell = canCancelToolBatchShell(item, run, readOnly, onCancelRunShell);

  return (
    <div
      key={`${item.toolName}-${item.detail ?? "detail"}-${itemIndex}`}
      className={cn("agent-tool-row min-w-0 w-full", item.failed ? "agent-tool-row--failed" : null)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <ToolBatchBody item={item} density={density} onOpenWorkspaceFile={onOpenWorkspaceFile} />
        </div>
        <ToolBatchActions
          canCancelShell={canCancelShell}
          hasInlineDiff={hasInlineDiff}
          busy={busy}
          expanded={writeFileDiffExpanded}
          onCancel={() => item.toolCallId && onCancelRunShell?.(run, item.toolCallId)}
          onToggleDiff={() => setWriteFileDiffExpanded((current) => !current)}
        />
      </div>
      <ToolBatchInlineDiff visible={hasInlineDiff && writeFileDiffExpanded} item={item} density={density} onOpenWorkspaceFile={onOpenWorkspaceFile} />
    </div>
  );
};

export type DiffBatchSummarizedRow = {
  id: string;
  title: string;
  toolName: string;
  path: string | null;
  content: string;
  createdAt: string;
};

export const ActivityDiffBatchRow = ({
  item,
  density,
  onOpenWorkspaceFile,
}: {
  item: DiffBatchSummarizedRow;
  density: RunTimelineDensity;
  onOpenWorkspaceFile?: (path: string) => void;
}) => {
  const hasContent = item.content.trim().length > 0;
  const detail = item.path ?? item.title.replace(/^Diff updated:\s*/i, "");

  return (
    <div className="agent-tool-row min-w-0 w-full">
      {hasContent ? (
        <details className="agent-tool-details group w-full max-w-full">
          <summary className="agent-tool-trigger">
            <ChevronDown className="h-3 w-3 shrink-0 text-[color:var(--ec-faint)] transition group-open:rotate-180" />
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--ec-info)]" />
            <span className="shrink-0 font-semibold text-[color:var(--ec-text)]">{item.toolName}</span>
            {item.path ? (
              <ActivityFilePathButton path={item.path} onOpenWorkspaceFile={onOpenWorkspaceFile} className="flex-1" />
            ) : (
              <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--ec-muted)]">{detail}</span>
            )}
          </summary>
          <div className="mt-1.5 rounded-md border border-[color:var(--ec-border)] bg-[color:var(--ec-panel-muted)] px-2 py-1.5">
            {looksLikeGitDiff(item.content) ? (
              <GitDiffPreview
                diffText={item.content}
                emptyMessage="Could not parse file diff."
                compact={density !== "detailed"}
                viewType="unified"
                activityEmphasis
                hideFileHeader
                alwaysExpandedFileSections
                onOpenFile={onOpenWorkspaceFile}
              />
            ) : (
              <ActivityMarkdownOrGitDiff
                content={item.content}
                compact={density !== "detailed"}
                className="text-[color:var(--ec-text)]"
                onOpenWorkspaceFile={onOpenWorkspaceFile}
              />
            )}
          </div>
        </details>
      ) : (
        <div className="agent-tool-trigger agent-tool-trigger--static">
          <span className="h-3 w-3 shrink-0" aria-hidden />
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--ec-info)]" />
          <span className="shrink-0 font-semibold text-[color:var(--ec-text)]">{item.toolName}</span>
          {item.path ? (
            <ActivityFilePathButton path={item.path} onOpenWorkspaceFile={onOpenWorkspaceFile} className="flex-1" />
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--ec-muted)]">{detail}</span>
          )}
        </div>
      )}
    </div>
  );
};

