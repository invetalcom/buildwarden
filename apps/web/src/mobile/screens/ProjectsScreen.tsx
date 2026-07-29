import { FolderGit2 } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { flattenRuns, isActiveRun } from "../data/selectors";
import { AppBar } from "../components/AppBar";
import { Badge, EmptyState, ListRow } from "../components/primitives";

export const ProjectsScreen = () => {
  const { snapshot, router, selectProject } = useMobileApp();

  return (
    <>
      <AppBar title="Projects" onBack={router.canGoBack ? router.back : undefined} />

      <div className="m-scroll m-screen-enter flex-1">
        {snapshot.projects.length === 0 ? (
          <EmptyState
            icon={<FolderGit2 className="size-7" />}
            title="No projects"
            message="Add a project in the BuildWarden desktop app and it will appear here."
          />
        ) : (
          snapshot.projects.map((entry) => {
            const active = flattenRuns([entry]).filter((item) => isActiveRun(item.run)).length;
            return (
              <ListRow
                key={entry.project.id}
                leading={<FolderGit2 className="size-5" />}
                title={entry.project.name}
                subtitle={entry.project.repoPath}
                trailing={active > 0 ? <Badge tone="accent">{active} active</Badge> : undefined}
                className="border-b border-[var(--ec-border)]"
                onClick={() => {
                  selectProject(entry.project.id);
                  router.push({ name: "project", projectId: entry.project.id, tab: "overview" });
                }}
              />
            );
          })
        )}
        <div className="h-6" />
      </div>
    </>
  );
};
