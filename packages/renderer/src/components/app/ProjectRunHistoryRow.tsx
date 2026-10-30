import type { ProviderType } from "@buildwarden/shared";
import { Archive, GitBranch, Folder } from "lucide-react";
import { formatCompactTokens } from "../../lib/context-window-estimate";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { resolveRunDisplayStatus, RUN_DISPLAY_STATUS_LABELS, runDisplayStatusTone } from "./run-display-status";
import { runHierarchyLabel, type RunHierarchyRow } from "./run-hierarchy";
import { RunHierarchyIndent, RunHierarchyToggle } from "./RunHierarchy";

interface ProjectRunHistoryRowProps {
  row: RunHierarchyRow;
  providerType?: ProviderType;
  tags?: string[];
  category?: { name: string; color: string };
  selected: boolean;
  selectionMode: boolean;
  busy: boolean;
  readOnly: boolean;
  onSelect: (runId: string) => void;
  onToggleSelection: (runId: string) => void;
  onToggleHierarchy: (runId: string) => void;
  onSetForLater: (runId: string) => void | Promise<void>;
}

export const ProjectRunHistoryRow = ({
  row: { run, depth, descendantCount, expanded }, providerType, tags = [], category, selected, selectionMode,
  busy, readOnly, onSelect, onToggleSelection, onToggleHierarchy, onSetForLater,
}: ProjectRunHistoryRowProps) => {
  const displayStatus = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
  const label = runHierarchyLabel(run);
  const isFolder = run.workspaceVcs === "folder";
  const workspaceLabel = isFolder ? (run.workspaceType === "copy" ? "Folder copy" : "Project folder") : run.branchName;
  const WorkspaceIcon = isFolder ? Folder : GitBranch;
  const createdAt = new Date(run.createdAt);
  const tokenCount = run.inputTokens + run.outputTokens;

  return (
    <RunHierarchyIndent depth={depth} indentPx={18}>
      <div
        data-run-hierarchy-run={run.id}
        data-run-selected={selected ? "true" : undefined}
        className={`group flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2.5 transition-colors ${selected
          ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)]"
          : "border-transparent hover:border-[var(--ec-border)] hover:bg-[var(--ec-hover)]"} ${depth > 0 && !selected ? "bg-[var(--ec-panel-soft)]" : ""}`}
      >
        {selectionMode ? (
          <input
            type="checkbox"
            checked={selected}
            disabled={busy}
            onChange={() => onToggleSelection(run.id)}
            aria-label={`Select ${label}`}
            className="size-4 shrink-0 cursor-pointer rounded border border-[var(--ec-border)] accent-[var(--ec-accent)] disabled:cursor-not-allowed"
          />
        ) : null}
        <Button
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start gap-3 p-0 text-left hover:bg-transparent"
          disabled={busy}
          onClick={() => selectionMode ? onToggleSelection(run.id) : onSelect(run.id)}
          type="button"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)]">
            <ProviderBrandIcon harnessType={run.harnessType} providerType={providerType} className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-[var(--ec-text)]" title={label}>{label}</span>
              {depth > 0 ? <span className="shrink-0 text-[10px] text-[var(--ec-accent)]">Subagent</span> : null}
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-normal text-[var(--ec-muted)]">
              <span className="inline-flex min-w-0 max-w-48 items-center gap-1" title={workspaceLabel}>
                <WorkspaceIcon className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{workspaceLabel}</span>
              </span>
              <time dateTime={run.createdAt} title={createdAt.toLocaleString()} className="shrink-0 tabular-nums">
                {createdAt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                {" · "}{createdAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </time>
              {category ? (
                <Badge tone="neutral" className="max-w-40 gap-1 px-1.5 py-0.5 text-[10px]" title={`Category: ${category.name}`}>
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: category.color }} />
                  <span className="truncate">{category.name}</span>
                </Badge>
              ) : null}
              {tags.map((tag) => (
                <Badge key={tag} tone="neutral" className="max-w-40 px-1.5 py-0.5 text-[10px] text-[var(--ec-accent)]" title={`Label: ${tag}`}>
                  <span className="truncate">#{tag}</span>
                </Badge>
              ))}
            </span>
          </span>
        </Button>
        <div className="flex shrink-0 items-center gap-2">
          {descendantCount > 0 ? (
            <RunHierarchyToggle runId={run.id} runLabel={label} descendantCount={descendantCount} expanded={expanded} onToggle={onToggleHierarchy} compact />
          ) : null}
          <div className="flex min-w-20 flex-col items-end gap-1">
            <Badge dot tone={runDisplayStatusTone(displayStatus)}>{RUN_DISPLAY_STATUS_LABELS[displayStatus]}</Badge>
            <span className="text-[10px] tabular-nums text-[var(--ec-muted)]" title={`${tokenCount.toLocaleString()} tokens`}>
              {formatCompactTokens(tokenCount)} tokens
            </span>
          </div>
          {!selectionMode && !readOnly && run.kind !== "orchestration-task" ? (
            <Button type="button" size="icon" variant="ghost" className="size-7" title="Move to For later" aria-label={`Move ${label} to For later`} onClick={() => void onSetForLater(run.id)}>
              <Archive className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </RunHierarchyIndent>
  );
};
