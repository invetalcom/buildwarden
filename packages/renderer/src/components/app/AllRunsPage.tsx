import type { AppSnapshot, RunListItem } from "@buildwarden/shared";
import { useCallback, useMemo, useState } from "react";
import { parseSearchTerms, runMatchesSearch } from "../../lib/run-search";
import { useRunUserInputSearch } from "../../lib/use-run-user-input-search";
import { Badge } from "../ui/badge";
import { CardDescription, CardHeader, CardTitle } from "../ui/card";
import { SegmentedControl } from "../ui/segmented-control";
import { isRunDisplayStatusActive, resolveRunDisplayStatus } from "./run-display-status";
import { appendUnreachableSubagentRoots, buildRunHierarchyRows, findSubagentHierarchyRoots } from "./run-hierarchy";
import { RunHistory } from "./RunHistory";

interface AllRunsPageProps {
  projects: AppSnapshot["projects"];
  providerAccounts?: AppSnapshot["providerAccounts"];
  runOrganization?: AppSnapshot["runOrganization"];
  onSelectRun: (projectId: string, runId: string) => void;
  onDeleteRuns?: (runs: RunListItem[]) => Promise<boolean>;
}

type RunScope = "runs" | "orchestrated";

export const AllRunsPage = ({ projects, providerAccounts = [], runOrganization, onSelectRun, onDeleteRuns }: AllRunsPageProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [scope, setScope] = useState<RunScope>("runs");
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const projectNameById = useMemo(() => new Map(projects.map((entry) => [entry.project.id, entry.project.name])), [projects]);
  const providerTypeByAccountId = useMemo(
    () => new Map(providerAccounts.map((provider) => [provider.id, provider.providerType])),
    [providerAccounts],
  );
  // All Runs includes archived primary runs as well as their subagents.
  const primaryRuns = useMemo(
    () => projects.flatMap((entry) => [...new Map([...entry.runs, ...entry.forLaterRuns].map((run) => [run.id, run])).values()]),
    [projects],
  );
  const subagentRuns = useMemo(() => projects.flatMap((entry) => entry.orchestratedRuns), [projects]);
  const scopedPrimaryRuns = useMemo(() => scope === "runs" ? primaryRuns : [], [primaryRuns, scope]);
  const sourceRuns = useMemo(() => [...scopedPrimaryRuns, ...subagentRuns], [scopedPrimaryRuns, subagentRuns]);
  const sourceRunById = useMemo(() => new Map(sourceRuns.map((run) => [run.id, run])), [sourceRuns]);
  const hierarchyRoots = useMemo(
    () => scope === "orchestrated" ? findSubagentHierarchyRoots(subagentRuns) : appendUnreachableSubagentRoots(primaryRuns, subagentRuns),
    [primaryRuns, subagentRuns, scope],
  );
  const activeCount = sourceRuns.filter((run) => isRunDisplayStatusActive(resolveRunDisplayStatus(run.status, run.orchestrationStatus))).length;
  const searchTerms = useMemo(() => parseSearchTerms(searchQuery), [searchQuery]);
  const hasSearch = searchTerms.length > 0;
  const userInputMatches = useRunUserInputSearch(searchTerms, sourceRuns);
  const visibleRows = useMemo(
    () => buildRunHierarchyRows(hierarchyRoots, subagentRuns, {
      expandedRunIds,
      matches: hasSearch ? (run) => runMatchesSearch(run, searchTerms, userInputMatches) : undefined,
    }).filter((row) => projectNameById.has(row.run.projectId)),
    [expandedRunIds, hasSearch, hierarchyRoots, projectNameById, searchTerms, subagentRuns, userInputMatches],
  );
  const matchingRunCount = hasSearch ? sourceRuns.filter((run) => runMatchesSearch(run, searchTerms, userInputMatches)).length : sourceRuns.length;
  const subagentDescription = `${subagentRuns.length} subagent ${subagentRuns.length === 1 ? "run" : "runs"}`;
  const toggleRunHierarchy = useCallback((runId: string) => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  return (
    <div className="mx-auto flex min-h-0 min-w-0 w-full max-w-7xl flex-1 flex-col gap-3">
      <CardHeader className="shrink-0 flex-row items-center justify-between gap-3 px-1 py-1">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ec-accent)]">Workspace</p>
          <CardTitle className="mt-0.5 text-xl">All Runs</CardTitle>
          <CardDescription>{primaryRuns.length + subagentRuns.length} total runs across {projects.length} projects.</CardDescription>
        </div>
        <Badge dot tone={activeCount > 0 ? "running" : "neutral"}>{activeCount} active</Badge>
      </CardHeader>
      <RunHistory
        key={scope}
        runs={scopedPrimaryRuns}
        orchestratedRuns={subagentRuns}
        organization={runOrganization}
        expandedRunIds={expandedRunIds}
        treeRows={visibleRows}
        matchingRunCount={matchingRunCount}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSelectRun={(runId) => {
          const run = sourceRunById.get(runId);
          if (run) onSelectRun(run.projectId, runId);
        }}
        onDeleteRuns={onDeleteRuns}
        onToggleRun={toggleRunHierarchy}
        providerTypeByAccountId={providerTypeByAccountId}
        projectNameById={projectNameById}
        readOnly={!onDeleteRuns}
        description={hasSearch
          ? `${matchingRunCount} matching of ${sourceRuns.length} runs.`
          : scope === "orchestrated" ? `${subagentDescription}.` : `${primaryRuns.length} primary, ${subagentDescription}.`}
        emptyTitle="No agent runs yet"
        emptyDescription="Start a run from a project and it will appear here with cross-project history."
        scopeControl={<SegmentedControl<RunScope>
          label="Run scope"
          value={scope}
          onChange={setScope}
          options={[{ value: "runs", label: "Runs" }, { value: "orchestrated", label: "Orchestrated" }]}
          className="shrink-0"
        />}
      />
    </div>
  );
};
