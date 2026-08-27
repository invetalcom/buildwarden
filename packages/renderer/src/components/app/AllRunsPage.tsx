import type { AppSnapshot, RunRecord } from "@buildwarden/shared";
import { Clock3, FolderGit2, PlayCircle, Search, UsersRound, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { parseSearchTerms, runMatchesSearch } from "../../lib/run-search";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ProviderBrandIcon } from "./provider-brand-icons";
import {
  isRunDisplayStatusActive,
  resolveRunDisplayStatus,
  RUN_DISPLAY_STATUS_LABELS,
  runDisplayStatusTone,
} from "./run-display-status";
import { formatRunDuration, formatRunRelativeTime } from "./run-summary-format";
import {
  appendUnreachableSubagentRoots,
  buildRunHierarchyRows,
  findSubagentHierarchyRoots,
  runHierarchyLabel,
  type RunHierarchyRow,
} from "./run-hierarchy";
import { RunHierarchyIndent, RunHierarchyToggle } from "./RunHierarchy";
import { RunListSelectionToolbar } from "./RunListSelectionToolbar";

interface AllRunsPageProps {
  projects: AppSnapshot["projects"];
  providerAccounts?: AppSnapshot["providerAccounts"];
  onSelectRun: (projectId: string, runId: string) => void;
  onDeleteRuns?: (runs: RunRecord[]) => Promise<boolean>;
}

const formatRunWorkspaceLabel = (run: RunRecord) => {
  if (run.workspaceVcs !== "folder") {
    return run.branchName;
  }
  return run.workspaceType === "copy" ? "Folder copy" : "Project folder";
};

type AllRunRow = {
  project: AppSnapshot["projects"][number]["project"];
} & RunHierarchyRow;

const AllRunsContent = ({
  rows,
  allRowsCount,
  hasSearch,
  onSelectRun,
  onToggleRun,
  selectionMode,
  selectedRunIds,
  selectionBusy,
  onToggleSelection,
  providerTypeByAccountId,
}: {
  rows: AllRunRow[];
  allRowsCount: number;
  hasSearch: boolean;
  onSelectRun: (projectId: string, runId: string) => void;
  onToggleRun: (runId: string) => void;
  selectionMode: boolean;
  selectedRunIds: ReadonlySet<string>;
  selectionBusy: boolean;
  onToggleSelection: (runId: string) => void;
  providerTypeByAccountId: ReadonlyMap<string, AppSnapshot["providerAccounts"][number]["providerType"]>;
}) => {
  if (rows.length === 0) {
    const searchIsEmpty = hasSearch && allRowsCount > 0;
    return (
      <Empty>
        <EmptyHeader>
          {searchIsEmpty ? <Search className="size-10 text-[var(--ec-muted)]" /> : <PlayCircle className="size-10 text-[var(--ec-muted)]" />}
          <EmptyTitle>{searchIsEmpty ? "No matching runs" : "No agent runs yet"}</EmptyTitle>
          <EmptyDescription>
            {searchIsEmpty
              ? "Search checks only user prompts, follow-ups, run goals, and submitted answers."
              : "Start a run from a project and it will appear here with cross-project history."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="divide-y divide-[var(--ec-border)]">
      {rows.map(({ project, run, depth, descendantCount, expanded }) => {
        const displayStatus = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
        const selected = selectedRunIds.has(run.id);
        return (
          <RunHierarchyIndent
            key={run.id}
            depth={depth}
            indentPx={18}
            className={depth > 0 ? "bg-[var(--ec-panel-soft)]" : undefined}
          >
            <div
              data-run-hierarchy-run={run.id}
              data-run-selected={selected ? "true" : undefined}
              className={`flex w-full min-w-0 items-center gap-3 px-4 py-3 transition hover:bg-[var(--ec-hover)] ${selected ? "bg-[var(--ec-accent-soft)]" : ""}`}
            >
              {selectionMode ? (
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={selectionBusy}
                  onChange={() => onToggleSelection(run.id)}
                  aria-label={`Select ${runHierarchyLabel(run)}`}
                  className="size-4 shrink-0 cursor-pointer rounded border border-[var(--ec-border)] accent-[var(--ec-accent)] disabled:cursor-not-allowed"
                />
              ) : (
                <span className={depth > 0 ? "size-2 shrink-0 rounded-full bg-[var(--ec-faint)]" : "size-2 shrink-0 rounded-full bg-[var(--ec-accent)]"} aria-hidden />
              )}
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                disabled={selectionBusy}
                onClick={() => selectionMode ? onToggleSelection(run.id) : onSelectRun(project.id, run.id)}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-[var(--ec-text)]">{runHierarchyLabel(run)}</span>
                  {depth > 0 ? <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--ec-accent)]">Subagent</span> : null}
                </span>
                <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--ec-muted)]">
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <FolderGit2 className="size-3 shrink-0" />
                    <span className="truncate">{project.name}</span>
                    <ProviderBrandIcon harnessType={run.harnessType} providerType={providerTypeByAccountId.get(run.providerAccountId)} className="size-3 shrink-0" />
                  </span>
                  <span className="inline-flex items-center gap-1 font-mono">
                    <Clock3 className="size-3" />
                    {formatRunRelativeTime(run.finishedAt ?? run.updatedAt)} - {formatRunDuration(run)}
                  </span>
                  <span className="truncate font-mono">{formatRunWorkspaceLabel(run)}</span>
                </span>
              </button>
              {descendantCount > 0 ? (
                <RunHierarchyToggle
                  runId={run.id}
                  runLabel={runHierarchyLabel(run)}
                  descendantCount={descendantCount}
                  expanded={expanded}
                  onToggle={onToggleRun}
                />
              ) : null}
              <Badge dot tone={runDisplayStatusTone(displayStatus)}>{RUN_DISPLAY_STATUS_LABELS[displayStatus]}</Badge>
            </div>
          </RunHierarchyIndent>
        );
      })}
    </div>
  );
};

export const AllRunsPage = ({ projects, providerAccounts = [], onSelectRun, onDeleteRuns }: AllRunsPageProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [view, setView] = useState<"runs" | "orchestrated">("runs");
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());
  const [selectionBusy, setSelectionBusy] = useState(false);
  const projectById = useMemo(
    () => new Map(projects.map((entry) => [entry.project.id, entry.project])),
    [projects],
  );
  const providerTypeByAccountId = useMemo(
    () => new Map(providerAccounts.map((provider) => [provider.id, provider.providerType])),
    [providerAccounts],
  );
  const primaryRuns = useMemo(
    () => projects.flatMap((entry) => [...new Map([...entry.runs, ...entry.forLaterRuns].map((run) => [run.id, run])).values()]),
    [projects],
  );
  const subagentRuns = useMemo(() => projects.flatMap((entry) => entry.orchestratedRuns), [projects]);
  const sourceRuns = useMemo(
    () => view === "orchestrated" ? subagentRuns : [...primaryRuns, ...subagentRuns],
    [primaryRuns, subagentRuns, view],
  );
  const sourceRunById = useMemo(() => new Map(sourceRuns.map((run) => [run.id, run])), [sourceRuns]);
  const hierarchyRoots = useMemo(
    () => view === "orchestrated"
      ? findSubagentHierarchyRoots(subagentRuns)
      : appendUnreachableSubagentRoots(primaryRuns, subagentRuns),
    [primaryRuns, subagentRuns, view],
  );
  const activeCount = sourceRuns.filter((run) =>
    isRunDisplayStatusActive(resolveRunDisplayStatus(run.status, run.orchestrationStatus))).length;
  const searchTerms = useMemo(() => parseSearchTerms(searchQuery), [searchQuery]);
  const hasSearch = searchTerms.length > 0;
  const visibleRows = useMemo(
    () => buildRunHierarchyRows(hierarchyRoots, subagentRuns, {
      expandedRunIds,
      matches: hasSearch ? (run) => runMatchesSearch(run, searchTerms) : undefined,
    }).flatMap((row) => {
      const project = projectById.get(row.run.projectId);
      return project ? [{ ...row, project }] : [];
    }),
    [expandedRunIds, hasSearch, hierarchyRoots, projectById, searchTerms, subagentRuns],
  );
  const matchingRunCount = hasSearch
    ? sourceRuns.filter((run) => runMatchesSearch(run, searchTerms)).length
    : sourceRuns.length;
  const visibleRunIds = useMemo(() => visibleRows.map((row) => row.run.id), [visibleRows]);
  const allVisibleSelected = visibleRunIds.length > 0 && visibleRunIds.every((runId) => selectedRunIds.has(runId));
  const selectedRuns = useMemo(
    () => [...selectedRunIds].flatMap((runId) => {
      const run = sourceRunById.get(runId);
      return run ? [run] : [];
    }),
    [selectedRunIds, sourceRunById],
  );
  const toggleRunHierarchy = useCallback((runId: string) => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);
  const cancelSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedRunIds(new Set());
  }, []);
  const toggleRunSelection = useCallback((runId: string) => {
    setSelectedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);
  const toggleAllVisible = useCallback(() => {
    setSelectedRunIds((current) => {
      const next = new Set(current);
      const clearVisible = visibleRunIds.length > 0 && visibleRunIds.every((runId) => next.has(runId));
      for (const runId of visibleRunIds) {
        if (clearVisible) next.delete(runId);
        else next.add(runId);
      }
      return next;
    });
  }, [visibleRunIds]);
  const changeView = useCallback((nextView: "runs" | "orchestrated") => {
    setView(nextView);
    setSelectionMode(false);
    setSelectedRunIds(new Set());
  }, []);
  const deleteSelectedRuns = useCallback(async () => {
    if (!onDeleteRuns || selectedRuns.length === 0) return;
    setSelectionBusy(true);
    try {
      if (await onDeleteRuns(selectedRuns)) cancelSelection();
    } finally {
      setSelectionBusy(false);
    }
  }, [cancelSelection, onDeleteRuns, selectedRuns]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
      <Card>
        <CardHeader className="min-h-[6.5rem] flex-row flex-wrap items-end justify-between gap-3 xl:h-[6.5rem]">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ec-accent)]">Workspace</p>
            <CardTitle className="mt-1 text-2xl">All Runs</CardTitle>
            <CardDescription>
              {hasSearch ? `${matchingRunCount} matching of ${sourceRuns.length}` : `${sourceRuns.length} total`} runs across {projects.length} projects.
            </CardDescription>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-end justify-end gap-2">
            <div className="flex h-8 items-center rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-0.5">
              <button type="button" aria-pressed={view === "runs"} className={`h-7 rounded px-2.5 text-xs ${view === "runs" ? "bg-[var(--ec-control)] text-[var(--ec-text)]" : "text-[var(--ec-muted)]"}`} onClick={() => changeView("runs")}>
                Runs
              </button>
              <button type="button" aria-pressed={view === "orchestrated"} className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-xs ${view === "orchestrated" ? "bg-[var(--ec-control)] text-[var(--ec-text)]" : "text-[var(--ec-muted)]"}`} onClick={() => changeView("orchestrated")}>
                <UsersRound className="size-3" /> Orchestrated
              </button>
            </div>
            <label className="min-w-[16rem] max-w-md flex-1 space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-faint)]">Search user input</span>
              <span className="relative block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--ec-faint)]" />
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Multiple keywords match all terms"
                  className="h-8 pr-8 pl-8 text-xs"
                />
                {searchQuery ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2 text-[var(--ec-muted)]"
                    onClick={() => setSearchQuery("")}
                    aria-label="Clear run search"
                    title="Clear search"
                  >
                    <X className="size-3.5" />
                  </Button>
                ) : null}
              </span>
            </label>
            {onDeleteRuns ? (
              <RunListSelectionToolbar
                selectionMode={selectionMode}
                selectedCount={selectedRuns.length}
                visibleCount={visibleRunIds.length}
                allVisibleSelected={allVisibleSelected}
                busy={selectionBusy}
                onBegin={() => setSelectionMode(true)}
                onToggleAllVisible={toggleAllVisible}
                onDelete={() => void deleteSelectedRuns()}
                onCancel={cancelSelection}
              />
            ) : null}
            <div className="min-w-20 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2 text-right">
              <p className="font-mono text-lg font-semibold text-[var(--ec-text)]">{activeCount}</p>
              <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--ec-faint)]">active</p>
            </div>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardContent className="p-0">
          <AllRunsContent
            rows={visibleRows}
            allRowsCount={sourceRuns.length}
            hasSearch={hasSearch}
            onSelectRun={onSelectRun}
            onToggleRun={toggleRunHierarchy}
            selectionMode={selectionMode}
            selectedRunIds={selectedRunIds}
            selectionBusy={selectionBusy}
            onToggleSelection={toggleRunSelection}
            providerTypeByAccountId={providerTypeByAccountId}
          />
        </CardContent>
      </Card>
    </div>
  );
};
