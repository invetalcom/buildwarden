import { useEffect, useMemo, useState } from "react";
import { parseUiTheme } from "@buildwarden/shared";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { FolderGit2, Plus, Settings } from "lucide-react";
import { MobileAppProvider, useMobileApp, type MobileAppValue } from "./data/mobile-app-context";
import { countRunsNeedingAttention, defaultProjectId, flattenRuns, isActiveRun } from "./data/selectors";
import { useApprovalQueue } from "./data/use-approval-queue";
import { useSnapshot } from "./data/use-snapshot";
import { useMobileRouter } from "./nav/mobile-router";
import { ApprovalSheet } from "./components/ApprovalSheet";
import { Drawer } from "./components/Drawer";
import { TabBar } from "./components/TabBar";
import { Badge, ListRow, SectionLabel } from "./components/primitives";
import { BookmarksScreen } from "./screens/BookmarksScreen";
import { ChatDetailScreen } from "./screens/ChatDetailScreen";
import { ChatsScreen } from "./screens/ChatsScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { MoreScreen } from "./screens/MoreScreen";
import { NewRunScreen } from "./screens/NewRunScreen";
import { ProjectScreen } from "./screens/ProjectScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { RunDetailScreen } from "./screens/RunDetailScreen";
import { RunsScreen } from "./screens/RunsScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

const ProjectDrawerContent = ({ onClose }: { onClose: () => void }) => {
  const { snapshot, activeProjectId, selectProject, router, client } = useMobileApp();

  return (
    <>
      <div className="m-scroll flex-1">
        <SectionLabel>Projects</SectionLabel>
        {snapshot.projects.map((entry) => {
          const active = flattenRuns([entry]).filter((item) => isActiveRun(item.run)).length;
          return (
            <ListRow
              key={entry.project.id}
              leading={<FolderGit2 className="size-5" />}
              title={entry.project.name}
              subtitle={entry.project.baseBranch}
              trailing={
                <>
                  {active > 0 ? <Badge tone="accent">{active}</Badge> : null}
                  {entry.project.id === activeProjectId ? <Badge tone="success">current</Badge> : null}
                </>
              }
              onClick={() => {
                selectProject(entry.project.id);
                onClose();
                router.push({ name: "project", projectId: entry.project.id, tab: "overview" });
              }}
            />
          );
        })}
      </div>
      <div className="shrink-0 border-t border-[var(--ec-border)]">
        {client.capabilities.runMutations ? (
          <ListRow
            leading={<Plus className="size-5" />}
            title="New run"
            onClick={() => {
              onClose();
              router.push({ name: "new-run", ...(activeProjectId ? { projectId: activeProjectId } : {}) });
            }}
          />
        ) : null}
        <ListRow
          leading={<Settings className="size-5" />}
          title="Settings"
          onClick={() => {
            onClose();
            router.push({ name: "settings" });
          }}
        />
      </div>
    </>
  );
};

const CurrentScreen = () => {
  const { router } = useMobileApp();
  const route = router.route;
  switch (route.name) {
    case "home":
      return <HomeScreen />;
    case "runs":
      return <RunsScreen />;
    case "chats":
      return <ChatsScreen />;
    case "more":
      return <MoreScreen />;
    case "run":
      return <RunDetailScreen runId={route.runId} segment={route.segment} />;
    case "chat":
      return <ChatDetailScreen chatId={route.chatId} />;
    case "projects":
      return <ProjectsScreen />;
    case "project":
      return <ProjectScreen projectId={route.projectId} tab={route.tab} />;
    case "bookmarks":
      return <BookmarksScreen />;
    case "search":
      return <SearchScreen />;
    case "new-run":
      return <NewRunScreen projectId={route.projectId} />;
    case "settings":
      return <SettingsScreen section={route.section} />;
  }
};

export const MobileShell = ({
  client,
  disconnect,
}: {
  client: BuildWardenClient;
  disconnect: (changeHost?: boolean) => Promise<void>;
}) => {
  const snapshotStore = useSnapshot(client);
  const approvals = useApprovalQueue(client);
  const router = useMobileRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const snapshot = snapshotStore.snapshot;
  const theme = parseUiTheme(snapshot.settings);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
  }, [theme]);

  // Adopt the host's selected project until the user picks one here.
  useEffect(() => {
    setActiveProjectId((current) => (current && snapshot.projects.some((entry) => entry.project.id === current) ? current : defaultProjectId(snapshot)));
  }, [snapshot]);

  const value = useMemo<MobileAppValue>(
    () => ({
      client,
      snapshot,
      snapshotStore,
      approvals,
      router,
      theme,
      activeProjectId,
      selectProject: (projectId: string) => {
        setActiveProjectId(projectId);
        void client.selectProject(projectId).catch(() => undefined);
      },
      openProjectDrawer: () => setDrawerOpen(true),
      disconnect,
    }),
    [activeProjectId, approvals, client, disconnect, router, snapshot, snapshotStore, theme],
  );

  const attentionCount = useMemo(() => countRunsNeedingAttention(snapshot.projects), [snapshot.projects]);

  return (
    <MobileAppProvider value={value}>
      <div className="m-shell">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <CurrentScreen />
        </div>
        <TabBar
          active={router.activeTab}
          onSelect={router.selectTab}
          badges={{ home: attentionCount + approvals.pending.length }}
        />
      </div>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <ProjectDrawerContent onClose={() => setDrawerOpen(false)} />
      </Drawer>

      <ApprovalSheet />
    </MobileAppProvider>
  );
};
