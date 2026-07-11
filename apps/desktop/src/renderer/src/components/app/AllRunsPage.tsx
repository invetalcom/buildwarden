import type { AppSnapshot, RunRecord } from "@buildwarden/shared";
import { Clock3, FolderGit2, PlayCircle, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { parseSearchTerms, runMatchesSearch } from "../../lib/run-search";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";

interface AllRunsPageProps {
  projects: AppSnapshot["projects"];
  onSelectRun: (projectId: string, runId: string) => void;
}

const formatRelativeTime = (value: string | null) => {
  if (!value) return "just now";
  const diffMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
};

const formatRunDuration = (run: RunRecord) => {
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = new Date(run.finishedAt ?? run.updatedAt).getTime();
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  if (totalSeconds < 5) return "< 5s";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const formatRunWorkspaceLabel = (run: RunRecord) => {
  if (run.workspaceVcs !== "folder") {
    return run.branchName;
  }
  return run.workspaceType === "copy" ? "Folder copy" : "Project folder";
};

type AllRunRow = {
  project: AppSnapshot["projects"][number]["project"];
  run: RunRecord;
};

const AllRunsContent = ({
  rows,
  allRowsCount,
  hasSearch,
  onSelectRun,
}: {
  rows: AllRunRow[];
  allRowsCount: number;
  hasSearch: boolean;
  onSelectRun: (projectId: string, runId: string) => void;
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
      {rows.map(({ project, run }) => (
        <button
          key={run.id}
          type="button"
          className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--ec-hover)]"
          onClick={() => onSelectRun(project.id, run.id)}
        >
          <span className="size-2 shrink-0 rounded-full bg-[var(--ec-accent)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--ec-text)]">{run.prompt}</p>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--ec-muted)]">
              <span className="inline-flex min-w-0 items-center gap-1">
                <FolderGit2 className="size-3 shrink-0" />
                <span className="truncate">{project.name}</span>
              </span>
              <span className="inline-flex items-center gap-1 font-mono">
                <Clock3 className="size-3" />
                {formatRelativeTime(run.finishedAt ?? run.updatedAt)} - {formatRunDuration(run)}
              </span>
              <span className="truncate font-mono">{formatRunWorkspaceLabel(run)}</span>
            </div>
          </div>
          <Badge dot tone={run.status}>{run.status}</Badge>
        </button>
      ))}
    </div>
  );
};

export const AllRunsPage = ({ projects, onSelectRun }: AllRunsPageProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const rows = useMemo(
    () =>
      projects
        .flatMap((entry) => {
          const runsById = new Map<string, RunRecord>();
          for (const run of [...entry.runs, ...entry.forLaterRuns]) {
            runsById.set(run.id, run);
          }
          return [...runsById.values()].map((run) => ({ project: entry.project, run }));
        })
        .sort((a, b) => new Date(b.run.updatedAt).getTime() - new Date(a.run.updatedAt).getTime()),
    [projects],
  );

  const activeCount = rows.filter(({ run }) => ["queued", "preparing", "running"].includes(run.status)).length;
  const searchTerms = useMemo(() => parseSearchTerms(searchQuery), [searchQuery]);
  const visibleRows = useMemo(() => rows.filter(({ run }) => runMatchesSearch(run, searchTerms)), [rows, searchTerms]);
  const hasSearch = searchTerms.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
      <Card>
        <CardHeader className="min-h-[6.5rem] flex-row flex-wrap items-end justify-between gap-3 xl:h-[6.5rem]">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ec-accent)]">Workspace</p>
            <CardTitle className="mt-1 text-2xl">All Runs</CardTitle>
            <CardDescription>
              {hasSearch ? `${visibleRows.length} matching of ${rows.length}` : `${rows.length} total`} runs across {projects.length} projects.
            </CardDescription>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-end justify-end gap-2">
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
            allRowsCount={rows.length}
            hasSearch={hasSearch}
            onSelectRun={onSelectRun}
          />
        </CardContent>
      </Card>
    </div>
  );
};
