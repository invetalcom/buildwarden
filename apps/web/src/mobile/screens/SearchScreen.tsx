import { useDeferredValue, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { filterRuns, flattenRuns } from "../data/selectors";
import { firstLine } from "../lib/format";
import { AppBar } from "../components/AppBar";
import { RunListRow } from "../components/RunListRow";
import { EmptyState, Input, ListRow, SectionLabel } from "../components/primitives";

/**
 * Replaces the desktop command palette. A phone has no keyboard shortcut to summon a palette, so
 * search is a destination reachable from the app bar instead.
 */
export const SearchScreen = () => {
  const { snapshot, router } = useMobileApp();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);

  const runs = useMemo(
    () => (deferred.trim() ? filterRuns(flattenRuns(snapshot.projects), "all", deferred).slice(0, 40) : []),
    [deferred, snapshot.projects],
  );

  const chats = useMemo(() => {
    const term = deferred.trim().toLowerCase();
    if (!term) return [];
    return snapshot.chats.filter((chat) => chat.prompt.toLowerCase().includes(term)).slice(0, 20);
  }, [deferred, snapshot.chats]);

  const projects = useMemo(() => {
    const term = deferred.trim().toLowerCase();
    if (!term) return [];
    return snapshot.projects.filter((entry) => entry.project.name.toLowerCase().includes(term));
  }, [deferred, snapshot.projects]);

  const empty = runs.length === 0 && chats.length === 0 && projects.length === 0;

  return (
    <>
      <AppBar title="Search" onBack={router.back} />

      <div className="shrink-0 px-4 py-2.5">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Runs, chats, projects"
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      <div className="m-scroll m-screen-enter flex-1">
        {!deferred.trim() ? (
          <EmptyState icon={<Search className="size-7" />} title="Search everything" message="Prompts, goals, branch names, chats and projects." />
        ) : empty ? (
          <EmptyState title="No matches" message={`Nothing matched “${deferred.trim()}”.`} />
        ) : (
          <>
            {projects.length > 0 ? (
              <>
                <SectionLabel>Projects</SectionLabel>
                {projects.map((entry) => (
                  <ListRow
                    key={entry.project.id}
                    title={entry.project.name}
                    subtitle={entry.project.repoPath}
                    onClick={() => router.push({ name: "project", projectId: entry.project.id, tab: "overview" })}
                  />
                ))}
              </>
            ) : null}

            {runs.length > 0 ? (
              <>
                <SectionLabel>Runs</SectionLabel>
                {runs.map((item) => (
                  <RunListRow key={item.run.id} item={item} onOpen={(runId) => router.push({ name: "run", runId, segment: "activity" })} />
                ))}
              </>
            ) : null}

            {chats.length > 0 ? (
              <>
                <SectionLabel>Chats</SectionLabel>
                {chats.map((chat) => (
                  <ListRow
                    key={chat.id}
                    title={firstLine(chat.prompt, "Untitled chat")}
                    onClick={() => router.push({ name: "chat", chatId: chat.id })}
                  />
                ))}
              </>
            ) : null}
            <div className="h-6" />
          </>
        )}
      </div>
    </>
  );
};
