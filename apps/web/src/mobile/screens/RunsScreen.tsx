import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { RUN_FILTERS, RUN_FILTER_LABELS, filterRuns, flattenRuns, matchesRunFilter, type RunFilter } from "../data/selectors";
import { AppBar } from "../components/AppBar";
import { RunListRow } from "../components/RunListRow";
import { Button, CenteredSpinner, EmptyState, FilterChip, IconButton } from "../components/primitives";

export const RunsScreen = () => {
  const { snapshot, snapshotStore, router, activeProjectId, client } = useMobileApp();
  const [filter, setFilter] = useState<RunFilter>("all");
  const [scopeToProject, setScopeToProject] = useState(false);

  const items = useMemo(() => {
    const all = flattenRuns(snapshot.projects);
    return scopeToProject && activeProjectId ? all.filter((item) => item.project.project.id === activeProjectId) : all;
  }, [activeProjectId, scopeToProject, snapshot.projects]);

  const counts = useMemo(() => {
    const result = {} as Record<RunFilter, number>;
    for (const key of RUN_FILTERS) {
      result[key] = items.filter((item) => matchesRunFilter(item.run, key)).length;
    }
    return result;
  }, [items]);

  const visible = filterRuns(items, filter, "");
  const projectName = snapshot.projects.find((entry) => entry.project.id === activeProjectId)?.project.name;

  return (
    <>
      <AppBar
        title="Runs"
        subtitle={scopeToProject && projectName ? projectName : "All projects"}
        actions={
          <IconButton label="Search runs" onClick={() => router.push({ name: "search" })}>
            <Search className="size-5" />
          </IconButton>
        }
      />

      <div className="m-scroll-x flex shrink-0 items-center gap-1.5 border-b border-[var(--ec-border)] px-3 py-1.5">
        {RUN_FILTERS.map((key) => (
          <FilterChip key={key} active={filter === key} onClick={() => setFilter(key)}>
            {RUN_FILTER_LABELS[key]}
            {counts[key] ? <span className="ml-1 opacity-70">{counts[key]}</span> : null}
          </FilterChip>
        ))}
        {projectName ? (
          <FilterChip active={scopeToProject} onClick={() => setScopeToProject((current) => !current)}>
            Only {projectName}
          </FilterChip>
        ) : null}
      </div>

      <div className="m-scroll m-screen-enter flex-1">
        {!snapshotStore.loaded ? (
          <CenteredSpinner />
        ) : visible.length === 0 ? (
          <EmptyState
            title={`No ${RUN_FILTER_LABELS[filter].toLowerCase()} runs`}
            message={filter === "all" ? "Runs you start will appear here." : "Try another filter."}
          />
        ) : (
          <>
            {visible.map((item) => (
              <RunListRow
                key={item.run.id}
                item={item}
                showProject={!scopeToProject}
                onOpen={(runId) => router.push({ name: "run", runId, segment: "activity" })}
              />
            ))}
            <div className="h-20" />
          </>
        )}
      </div>

      {client.capabilities.runMutations && snapshot.projects.length > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <Button
            className="pointer-events-auto h-12 rounded-full px-5 shadow-[var(--ec-action-shadow)]"
            onClick={() => router.push({ name: "new-run", ...(activeProjectId ? { projectId: activeProjectId } : {}) })}
          >
            <Plus className="size-5" />
            New run
          </Button>
        </div>
      ) : null}
    </>
  );
};
