import { useMemo } from "react";
import { Plus, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { findProject, flattenRuns, needsAttention, isActiveRun } from "../data/selectors";
import { AppBar } from "../components/AppBar";
import { RunListRow } from "../components/RunListRow";
import { Button, CenteredSpinner, EmptyState, IconButton, InlineError, SectionAction, SectionLabel } from "../components/primitives";

const MAX_PER_SECTION = 8;

export const HomeScreen = () => {
  const { snapshot, snapshotStore, router, approvals, activeProjectId, openProjectDrawer, client } = useMobileApp();
  const project = findProject(snapshot, activeProjectId);

  const { attention, active, recent } = useMemo(() => {
    const all = flattenRuns(snapshot.projects).filter((item) => item.run.listVisibility !== "for-later");
    return {
      // The three sections are mutually exclusive: a finished run can still need attention (a
      // pending input request, an orchestration flag), and it belongs under "Needs you" only.
      attention: all.filter((item) => needsAttention(item.run)).slice(0, MAX_PER_SECTION),
      active: all.filter((item) => isActiveRun(item.run) && !needsAttention(item.run)).slice(0, MAX_PER_SECTION),
      recent: all.filter((item) => !isActiveRun(item.run) && !needsAttention(item.run)).slice(0, MAX_PER_SECTION),
    };
  }, [snapshot.projects]);

  const openRun = (runId: string) => router.push({ name: "run", runId, segment: "activity" });

  return (
    <>
      <AppBar
        title={project?.project.name ?? "BuildWarden"}
        subtitle={project ? project.project.baseBranch : "No project selected"}
        onTitlePress={openProjectDrawer}
        actions={
          <>
            <IconButton label="Search" onClick={() => router.push({ name: "search" })}>
              <Search className="size-5" />
            </IconButton>
            <IconButton label="Refresh" onClick={() => void snapshotStore.refresh()}>
              <RefreshCw className={snapshotStore.refreshing ? "size-5 animate-spin" : "size-5"} />
            </IconButton>
          </>
        }
      />

      <div className="m-scroll m-screen-enter flex-1">
        {snapshotStore.error ? <InlineError message={snapshotStore.error} onRetry={() => void snapshotStore.refresh()} /> : null}

        {!snapshotStore.loaded ? (
          <CenteredSpinner label="Loading your projects" />
        ) : snapshot.projects.length === 0 ? (
          <EmptyState
            title="No projects yet"
            message={
              client.capabilities.projectCreation
                ? "Add a project from the desktop app, or from More → Projects."
                : "Add a project in the BuildWarden desktop app; it will appear here."
            }
          />
        ) : (
          <>
            {approvals.pending.length > 0 ? (
              <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] px-3 py-2.5">
                <ShieldAlert className="size-4 shrink-0 text-[var(--ec-warning)]" />
                <p className="flex-1 text-xs text-[var(--ec-text)]">
                  {approvals.pending.length} command {approvals.pending.length === 1 ? "is" : "are"} waiting for approval.
                </p>
              </div>
            ) : null}

            {attention.length > 0 ? (
              <>
                <SectionLabel>Needs you</SectionLabel>
                {attention.map((item) => (
                  <RunListRow key={item.run.id} item={item} onOpen={openRun} />
                ))}
              </>
            ) : null}

            {active.length > 0 ? (
              <>
                <SectionLabel>Running</SectionLabel>
                {active.map((item) => (
                  <RunListRow key={item.run.id} item={item} onOpen={openRun} />
                ))}
              </>
            ) : null}

            <SectionLabel
              action={recent.length > 0 ? <SectionAction onClick={() => router.selectTab("runs")}>See all</SectionAction> : null}
            >
              Recent
            </SectionLabel>
            {recent.length > 0 ? (
              recent.map((item) => <RunListRow key={item.run.id} item={item} onOpen={openRun} />)
            ) : attention.length === 0 && active.length === 0 ? (
              <EmptyState title="Nothing running" message="Start a run and it will show up here." />
            ) : null}

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
