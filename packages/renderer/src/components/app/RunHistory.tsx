import { useInstanceContext } from "../../lib/instance-context";
import { UNCATEGORIZED_RUN_SECTION_ID, type RunOrganizationSnapshot, type RunListItem, type ProviderType } from "@buildwarden/shared";
import { Clock3, PlayCircle, Search, X } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented-control";
import { RunHistoryRow } from "./RunHistoryRow";
import type { RunHierarchyRow } from "./run-hierarchy";
import { RunListSelectionToolbar } from "./RunListSelectionToolbar";
import { EMPTY_RUN_ORGANIZATION } from "./sidebar-run-sections";
import { buildRunHistoryCategories, runHistoryCategories } from "./run-history-categories";

const HISTORY_VIEW_KEY = "buildwarden:run-history-view";
type HistoryView = "flat" | "categories";
const readHistoryView = (): HistoryView => {
  try { return localStorage.getItem(HISTORY_VIEW_KEY) === "categories" ? "categories" : "flat"; }
  catch { return "flat"; }
};

const EmptyRunList = ({ hasRunSearch, hasRuns, readOnly, title, description }: Readonly<{ hasRunSearch: boolean; hasRuns: boolean; readOnly: boolean; title?: string; description?: string }>) => (
  <Empty>
    <EmptyHeader>
      {hasRunSearch && hasRuns ? <Search className="size-10 text-[var(--ec-muted)]" /> : <PlayCircle className="size-10 text-[var(--ec-muted)]" />}
      <EmptyTitle>{hasRunSearch && hasRuns ? "No matching runs" : title ?? "No visible runs yet"}</EmptyTitle>
      <EmptyDescription>
        {hasRunSearch && hasRuns
          ? "Search checks only user prompts, follow-ups, run goals, and submitted answers."
          : description ?? (readOnly ? "No runs are available on the BuildWarden host." : "Start one above or move a run back from For later.")}
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
);

export const RunHistory = ({ runs, orchestratedRuns, knownPrimaryRuns = runs, organization = EMPTY_RUN_ORGANIZATION, expandedRunIds, treeRows, matchingRunCount, searchQuery, onSearchChange, onSelectRun, onSetRunForLater, onDeleteRuns, onToggleRun, providerTypeByModelId = new Map(), providerTypeByAccountId, projectNameById, scopeControl, description, emptyTitle, emptyDescription, readOnly }: {
  runs: RunListItem[];
  orchestratedRuns: RunListItem[];
  knownPrimaryRuns?: RunListItem[];
  organization?: RunOrganizationSnapshot;
  expandedRunIds?: ReadonlySet<string>;
  treeRows: RunHierarchyRow[];
  matchingRunCount: number;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onSelectRun: (runId: string) => void;
  onSetRunForLater?: (runId: string) => void | Promise<void>;
  onDeleteRuns?: (runs: RunListItem[]) => Promise<boolean>;
  onToggleRun: (runId: string) => void;
  providerTypeByModelId?: ReadonlyMap<string, ProviderType>;
  providerTypeByAccountId?: ReadonlyMap<string, ProviderType>;
  projectNameById?: ReadonlyMap<string, string>;
  scopeControl?: ReactNode;
  description?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  readOnly: boolean;
}) => {
  const instances = useInstanceContext();
  const [view, setView] = useState(readHistoryView);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());
  const [selectionBusy, setSelectionBusy] = useState(false);
  const hasRunSearch = searchQuery.trim().length > 0;
  const metadataByRunId = useMemo(() => new Map(organization.runs.map((record) => [record.runId, record])), [organization]);
  const categoryById = useMemo(() => new Map(runHistoryCategories(organization).map((category) => [category.id, category])), [organization]);
  const categoryGroups = useMemo(() => view === "categories" ? buildRunHistoryCategories({
    runs, orchestratedRuns, knownPrimaryRuns, organization,
    expandedRunIds: expandedRunIds ?? new Set(treeRows.filter((row) => row.expanded).map((row) => row.run.id)),
    searchRows: hasRunSearch ? treeRows : undefined,
  }) : [], [view, runs, orchestratedRuns, knownPrimaryRuns, organization, expandedRunIds, hasRunSearch, treeRows]);
  const totalRunCount = runs.length + orchestratedRuns.length;
  const runById = useMemo(() => new Map([...runs, ...orchestratedRuns].map((run) => [run.id, run])), [orchestratedRuns, runs]);
  const visibleRunIds = useMemo(() => (view === "categories" ? categoryGroups.flatMap((group) => group.rows) : treeRows).map((row) => row.run.id).filter((id) => !instances || instances.clientForEntity(id).capabilities.runMutations), [view, categoryGroups, treeRows, instances]);
  const selectedRuns = useMemo(
    () => [...selectedRunIds].flatMap((runId) => {
      const run = runById.get(runId);
      return run ? [run] : [];
    }),
    [runById, selectedRunIds],
  );
  const allVisibleSelected = visibleRunIds.length > 0 && visibleRunIds.every((runId) => selectedRunIds.has(runId));
  const runCountDescription = hasRunSearch
    ? `${String(matchingRunCount)} matching of ${String(totalRunCount)}`
    : orchestratedRuns.length > 0
      ? `${String(runs.length)} primary, ${String(orchestratedRuns.length)} subagent ${orchestratedRuns.length === 1 ? "run" : "runs"}`
      : `${String(runs.length)} visible runs in this project`;
  const cancelSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedRunIds(new Set());
  }, []);
  const toggleRunSelection = useCallback((runId: string) => {
    if (instances && !instances.clientForEntity(runId).capabilities.runMutations) return;
    setSelectedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, [instances]);
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
  const deleteSelectedRuns = useCallback(async () => {
    if (!onDeleteRuns || selectedRuns.length === 0) return;
    setSelectionBusy(true);
    try {
      if (await onDeleteRuns(selectedRuns)) cancelSelection();
    } finally {
      setSelectionBusy(false);
    }
  }, [cancelSelection, onDeleteRuns, selectedRuns]);
  const changeView = (next: HistoryView) => {
    setView(next);
    try { localStorage.setItem(HISTORY_VIEW_KEY, next); } catch { /* Storage may be disabled. */ }
  };
  const renderRow = (row: RunHierarchyRow) => {
    const metadata = metadataByRunId.get(row.run.id);
    const category = categoryById.get(metadata?.sectionId ?? "") ?? categoryById.get(UNCATEGORIZED_RUN_SECTION_ID);
    return <RunHistoryRow
      key={row.run.id}
      row={row}
      projectName={projectNameById?.get(row.run.projectId)}
      tags={metadata?.tags}
      category={view === "flat" && organization !== EMPTY_RUN_ORGANIZATION ? category : undefined}
      providerType={providerTypeByAccountId?.get(row.run.providerAccountId) ?? providerTypeByModelId.get(row.run.modelId)}
      selected={selectedRunIds.has(row.run.id)}
      selectionMode={selectionMode}
      busy={selectionBusy}
      readOnly={readOnly}
      onSelect={onSelectRun}
      onToggleSelection={toggleRunSelection}
      onToggleHierarchy={onToggleRun}
      onSetForLater={onSetRunForLater}
    />;
  };
  return (
    <Card className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl shadow-none">
      <CardHeader className="shrink-0 flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--ec-border)] px-4 py-3">
        <div className="flex items-start gap-2">
          <Clock3 className="mt-0.5 size-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />
          <div>
            <CardTitle>Run History</CardTitle>
            <CardDescription>{description ?? `${runCountDescription}.`}</CardDescription>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          {scopeControl}
          <span className="relative block min-w-40 max-w-72 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--ec-faint)]" />
            <Input value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search past runs" aria-label="Search runs" className="h-8 pr-8 pl-8 text-xs" />
            {searchQuery && (
              <Button type="button" variant="ghost" size="icon" className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2 text-[var(--ec-muted)]" onClick={() => onSearchChange("")} aria-label="Clear run search" title="Clear search">
                <X className="size-3.5" />
              </Button>
            )}
          </span>
          <SegmentedControl<HistoryView>
            label="Run history view"
            options={[{ value: "flat", label: "Flat" }, { value: "categories", label: "Categories" }]}
            value={view}
            onChange={changeView}
            className="shrink-0"
          />
          {!readOnly && onDeleteRuns ? (
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
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-xl p-0">
        {treeRows.length === 0 ? <EmptyRunList hasRunSearch={hasRunSearch} hasRuns={totalRunCount > 0} readOnly={readOnly} title={emptyTitle} description={emptyDescription} /> : (
          <div className="app-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
            {view === "flat" ? treeRows.map(renderRow) : categoryGroups.map((group) => (
              <section key={group.id} aria-label={`${group.name} runs`} data-run-history-category={group.id}>
                <div className="flex min-w-0 items-center gap-2 px-3 pt-3 pb-1.5 text-xs text-[var(--ec-muted)]">
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
                  <h4 className="min-w-0 truncate font-medium text-[var(--ec-text)]" title={group.name}>{group.name}</h4>
                  <span className="tabular-nums" title={`${group.count} primary ${group.count === 1 ? "run" : "runs"}`}>{group.count}</span>
                  <span aria-hidden className="h-px flex-1 bg-[var(--ec-border)]" />
                </div>
                {group.rows.map(renderRow)}
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

