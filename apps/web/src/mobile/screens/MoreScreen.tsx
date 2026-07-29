import { APP_VERSION } from "@buildwarden/renderer/logic";
import { Bookmark, FolderGit2, LogOut, Monitor, RefreshCw, Settings, Wifi, WifiOff } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { switchShell } from "../../shell/select-shell";
import { HOSTED_MODE } from "../../session/use-remote-session";
import { AppBar } from "../components/AppBar";
import { Divider, ListRow, SectionLabel } from "../components/primitives";

export const MoreScreen = () => {
  const { snapshot, snapshotStore, router, client, disconnect } = useMobileApp();
  const bookmarkCount = snapshot.bookmarks.length + snapshot.chatBookmarks.length;

  return (
    <>
      <AppBar title="More" />

      <div className="m-scroll m-screen-enter flex-1">
        <SectionLabel>Workspace</SectionLabel>
        <ListRow
          leading={<FolderGit2 className="size-5" />}
          title="Projects"
          subtitle={`${snapshot.projects.length} connected`}
          onClick={() => router.push({ name: "projects" })}
        />
        <Divider />
        <ListRow
          leading={<Bookmark className="size-5" />}
          title="Bookmarks"
          subtitle={bookmarkCount === 0 ? "None yet" : `${bookmarkCount} saved`}
          onClick={() => router.push({ name: "bookmarks" })}
        />
        <Divider />
        <ListRow leading={<Settings className="size-5" />} title="Settings" onClick={() => router.push({ name: "settings" })} />

        <SectionLabel>Connection</SectionLabel>
        <ListRow
          leading={client.capabilities.liveEvents ? <Wifi className="size-5 text-[var(--ec-success)]" /> : <WifiOff className="size-5" />}
          title={client.capabilities.liveEvents ? "Live updates" : "Polling"}
          subtitle={client.capabilities.mutations ? "Remote control" : "Read-only session"}
        />
        <Divider />
        <ListRow
          leading={<RefreshCw className={snapshotStore.refreshing ? "size-5 animate-spin" : "size-5"} />}
          title="Refresh now"
          onClick={() => void snapshotStore.refresh()}
        />
        <Divider />
        <ListRow
          leading={<Monitor className="size-5" />}
          title="Use the desktop layout"
          subtitle="Reloads this browser with the full desktop UI"
          onClick={() => switchShell(window, "desktop")}
        />
        {HOSTED_MODE ? (
          <>
            <Divider />
            <ListRow
              leading={<RefreshCw className="size-5" />}
              title="Change host"
              subtitle="Pair with a different desktop app"
              onClick={() => void disconnect(true)}
            />
          </>
        ) : null}
        <Divider />
        <ListRow leading={<LogOut className="size-5" />} title="Disconnect" danger onClick={() => void disconnect()} />

        <p className="px-4 py-6 text-center text-[11px] text-[var(--ec-faint)]">BuildWarden {APP_VERSION}</p>
      </div>
    </>
  );
};
