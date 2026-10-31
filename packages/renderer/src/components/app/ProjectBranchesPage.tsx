import type {
  MergeProjectBranchMode,
  ProjectBranchDeleteImpact,
  ProjectForgeAuthStatus,
  ProjectGitBranchInfo,
  ProjectGitBranchOverview,
} from "@buildwarden/shared";
import {
  ArrowDown,
  ArrowUp,
  BrushCleaning,
  CircleCheck,
  Cloud,
  CloudCheck,
  CloudDownload,
  CloudUpload,
  ExternalLink,
  GitBranch,
  Laptop,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented-control";
import { Select } from "../ui/select";
import { ProjectBranchDialog, type BranchDialogState } from "./ProjectBranchDialogs";
import { ProjectBranchRow, type ProjectBranchRowActions } from "./ProjectBranchRow";
import {
  BRANCH_FILTER_LABELS,
  branchCompareUrl,
  branchRefName,
  branchWebUrl,
  countBranchFilters,
  forgeLabel,
  selectMergedCleanupCandidates,
  selectVisibleBranches,
  type BranchFilter,
  type BranchSort,
} from "./project-branches-model";

export interface ProjectBranchesPageProps {
  projectId: string;
  repoPath: string;
  baseBranch: string;
  currentBranch: string;
  branches: string[];
  busy: boolean;
  onBranchesChanged: () => void | Promise<void>;
  onProjectBaseBranchChange?: (branchName: string) => void | Promise<void>;
}

type PageNotice = { tone: "success" | "error"; text: string };

const SUCCESS_NOTICE_MS = 5_000;
/** Filters that stay visible even when empty, so the control does not jump around. */
const ALWAYS_SHOWN_FILTERS: ReadonlySet<BranchFilter> = new Set(["all", "local"]);

const errorText = (caught: unknown, fallback: string) => (caught instanceof Error ? caught.message : fallback);

const operationLabel = (operation: NonNullable<ProjectGitBranchOverview["operation"]>) =>
  operation === "cherry-pick" ? "Cherry-pick" : `${operation[0]!.toUpperCase()}${operation.slice(1)}`;

const fallbackBranchInfo = (name: string, currentBranch: string, baseBranch: string): ProjectGitBranchInfo => ({
  name,
  isCurrent: name === currentBranch,
  isBase: name === baseBranch,
  hasLocal: true,
  hasRemote: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  commitSha: null,
  updatedAt: null,
  subject: null,
});

const HeaderChip = ({ tone = "neutral", title, children }: { tone?: "neutral" | "success" | "warning" | "accent"; title?: string; children: ReactNode }) => (
  <span
    title={title}
    className={cn(
      "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4",
      tone === "neutral" && "border-[var(--ec-border)] text-[var(--ec-muted)]",
      tone === "success" && "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]",
      tone === "warning" && "border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] text-[var(--ec-warning)]",
      tone === "accent" && "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]",
    )}
  >
    {children}
  </span>
);

const CurrentSyncChip = ({ branch, remoteName }: { branch: ProjectGitBranchInfo | null; remoteName: string }) => {
  if (!branch) {
    return null;
  }
  if (!branch.upstream) {
    return (
      <HeaderChip title={`Publish to create ${remoteName}/${branch.name}`}>
        <Laptop className="size-3" aria-hidden />
        Not published
      </HeaderChip>
    );
  }
  if (branch.ahead === 0 && branch.behind === 0) {
    return (
      <HeaderChip tone="success">
        <CloudCheck className="size-3" aria-hidden />
        Up to date with <span className="font-mono">{branch.upstream}</span>
      </HeaderChip>
    );
  }
  return (
    <HeaderChip tone="accent" title={`Compared with ${branch.upstream}`}>
      {branch.ahead > 0 ? (
        <span className="inline-flex items-center">
          <ArrowUp className="size-3" aria-hidden />
          {branch.ahead} to push
        </span>
      ) : null}
      {branch.ahead > 0 && branch.behind > 0 ? <span aria-hidden>·</span> : null}
      {branch.behind > 0 ? (
        <span className="inline-flex items-center">
          <ArrowDown className="size-3" aria-hidden />
          {branch.behind} to pull
        </span>
      ) : null}
    </HeaderChip>
  );
};

const CountBadge = ({ value }: { value: number }) =>
  value > 0 ? (
    <span className="rounded-full bg-[var(--ec-accent-soft)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--ec-accent)]">{value}</span>
  ) : null;

export const ProjectBranchesPage = ({
  projectId,
  repoPath,
  baseBranch,
  currentBranch,
  branches,
  busy,
  onBranchesChanged,
  onProjectBaseBranchChange,
}: ProjectBranchesPageProps) => {
  const buildwarden = useBuildWardenClient();
  const [overview, setOverview] = useState<ProjectGitBranchOverview | null>(null);
  const [authStatus, setAuthStatus] = useState<ProjectForgeAuthStatus | null>(null);
  const [notice, setNotice] = useState<PageNotice | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<BranchDialogState | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<ProjectBranchDeleteImpact | null>(null);
  const [deleteImpactChecking, setDeleteImpactChecking] = useState(false);
  const [filter, setFilter] = useState<BranchFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BranchSort>("recent");
  const [now, setNow] = useState(() => Date.now());
  const deleteImpactRequestRef = useRef(0);
  const newBranchButtonRef = useRef<HTMLButtonElement>(null);

  const applyOverview = useCallback((next: ProjectGitBranchOverview) => {
    setOverview(next);
    setNow(Date.now());
  }, []);

  const loadOverview = useCallback(async () => {
    setActionBusy((current) => current ?? "refresh");
    try {
      const [nextOverview, nextAuthStatus] = await Promise.all([
        buildwarden.getProjectBranchOverview(projectId),
        buildwarden.getProjectForgeAuthStatus(projectId).catch(() => null),
      ]);
      applyOverview(nextOverview);
      setAuthStatus(nextAuthStatus);
    } catch (caught) {
      setNotice({ tone: "error", text: errorText(caught, "Could not load branch information.") });
    } finally {
      setActionBusy((current) => (current === "refresh" ? null : current));
    }
  }, [applyOverview, buildwarden, projectId]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, baseBranch]);

  useEffect(() => {
    if (notice?.tone !== "success") return;
    const timer = window.setTimeout(() => setNotice(null), SUCCESS_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const fallbackBranches = useMemo(
    () => [...new Set(branches.filter(Boolean))].map((name) => fallbackBranchInfo(name, currentBranch, baseBranch)),
    [baseBranch, branches, currentBranch],
  );
  const branchRows = overview?.branches.length ? overview.branches : fallbackBranches;
  const current = overview?.currentBranch ?? currentBranch;
  const currentInfo = branchRows.find((branch) => branch.isCurrent) ?? null;
  const remoteName = overview?.remoteName ?? "origin";
  const baseLabel = overview?.baseCompareRef ?? baseBranch;
  const forge = forgeLabel(overview?.provider);
  const changedFileCount = overview?.changedFileCount ?? 0;
  const operation = overview?.operation ?? null;
  const controlsDisabled = busy || actionBusy !== null;

  const filterCounts = useMemo(() => countBranchFilters(branchRows, now), [branchRows, now]);
  const visibleBranches = useMemo(() => selectVisibleBranches(branchRows, { filter, query, sort, now }), [branchRows, filter, query, sort, now]);
  const cleanupCandidates = useMemo(() => selectMergedCleanupCandidates(branchRows), [branchRows]);
  const divergenceMax = useMemo(
    () => visibleBranches.reduce((max, branch) => Math.max(max, branch.baseAhead ?? 0, branch.baseBehind ?? 0), 0),
    [visibleBranches],
  );
  const sourceOptions = useMemo(
    () =>
      branchRows.map((branch) => {
        const ref = branchRefName(branch, remoteName);
        return { value: ref, label: ref };
      }),
    [branchRows, remoteName],
  );
  const filterOptions = (Object.keys(BRANCH_FILTER_LABELS) as BranchFilter[])
    .filter((value) => ALWAYS_SHOWN_FILTERS.has(value) || filterCounts[value] > 0 || value === filter)
    .map((value) => ({ value, label: `${BRANCH_FILTER_LABELS[value]} ${String(filterCounts[value])}` }));

  let hostingTitle: string | undefined;
  if (authStatus) {
    hostingTitle = authStatus.hasToken ? `${authStatus.repoLabel}: access token saved` : `${authStatus.repoLabel}: no access token saved`;
  }

  const closeDialog = () => {
    deleteImpactRequestRef.current += 1;
    setDialog(null);
    setDialogError(null);
    setDeleteImpact(null);
    setDeleteImpactChecking(false);
  };

  /** Runs one Git action; errors land in the open dialog, or in the page notice without one. */
  const runAction = async (
    key: string,
    action: () => Promise<ProjectGitBranchOverview | void>,
    success: string,
    options: { fromDialog?: boolean } = {},
  ): Promise<boolean> => {
    setActionBusy(key);
    setDialogError(null);
    setNotice(null);
    try {
      const result = await action();
      if (result) {
        applyOverview(result);
      } else {
        const next = await buildwarden.getProjectBranchOverview(projectId);
        applyOverview(next);
      }
      await onBranchesChanged();
      if (options.fromDialog) closeDialog();
      setNotice({ tone: "success", text: success });
      return true;
    } catch (caught) {
      const text = errorText(caught, "Git action failed.");
      if (options.fromDialog) setDialogError(text);
      else setNotice({ tone: "error", text });
      // A failed action can still change the repository, for example a cleanup that stopped halfway.
      void buildwarden.getProjectBranchOverview(projectId).then(applyOverview, () => undefined);
      return false;
    } finally {
      setActionBusy(null);
    }
  };

  const openUrl = async (url: string | null, failure: string) => {
    if (!url) return;
    const result = await buildwarden.openExternalUrl(url);
    if (!result.ok) setNotice({ tone: "error", text: result.error ?? failure });
  };

  const openDeleteDialog = (branch: ProjectGitBranchInfo) => {
    const requestId = deleteImpactRequestRef.current + 1;
    deleteImpactRequestRef.current = requestId;
    setDialogError(null);
    setDialog({ kind: "delete", branch });
    setDeleteImpact(null);
    setDeleteImpactChecking(true);
    void buildwarden
      .getProjectBranchDeleteImpact(projectId, { branchName: branch.name })
      .then((impact) => {
        if (deleteImpactRequestRef.current === requestId) setDeleteImpact(impact);
      })
      .catch((caught: unknown) => {
        if (deleteImpactRequestRef.current === requestId) setDialogError(`${errorText(caught, "Could not check linked agent runs.")} Reopen this dialog to try again.`);
      })
      .finally(() => {
        if (deleteImpactRequestRef.current === requestId) setDeleteImpactChecking(false);
      });
  };

  const openDialog = (next: BranchDialogState) => {
    setDialogError(null);
    setDialog(next);
  };

  const rowActions: ProjectBranchRowActions = {
    onCheckout: (branch) =>
      void runAction(
        `checkout:${branch.name}`,
        async () => {
          await buildwarden.checkoutProjectBranch(projectId, branch.name);
        },
        branch.hasLocal ? `Checked out ${branch.name}.` : `Checked out ${branch.name} tracking ${remoteName}/${branch.name}.`,
      ),
    onCreateFrom: (branch) => openDialog({ kind: "create", source: branchRefName(branch, remoteName) }),
    onMerge: (branch) => openDialog({ kind: "merge", branch, source: branchRefName(branch, remoteName) }),
    onRebase: (branch) => openDialog({ kind: "rebase", branch, onto: branchRefName(branch, remoteName) }),
    onPull: (branch) =>
      void runAction(
        `pull:${branch.name}`,
        () => buildwarden.pullProjectBranch(projectId, { branchName: branch.name }),
        `Fast-forwarded ${branch.name} from ${branch.upstream ?? "its upstream"}.`,
      ),
    onPush: (branch) =>
      void runAction(
        `push:${branch.name}`,
        () => buildwarden.pushProjectBranch(projectId, { branchName: branch.name, setUpstream: true }),
        branch.upstream ? `Pushed ${branch.name}.` : `Published ${branch.name} to ${remoteName}.`,
      ),
    onOpenRemote: (branch) => void openUrl(branchWebUrl(overview, branch.name), "Could not open the remote branch."),
    onCompare: (branch) => void openUrl(branchCompareUrl(overview, branch.name), "Could not open the compare page."),
    onCopyName: (branch) => {
      void navigator.clipboard.writeText(branch.name).then(
        () => setNotice({ tone: "success", text: `Copied ${branch.name}.` }),
        () => setNotice({ tone: "error", text: "Could not copy to the clipboard." }),
      );
    },
    onSetBase: (branch) => {
      if (!onProjectBaseBranchChange) return;
      void Promise.resolve(onProjectBaseBranchChange(branch.name)).then(
        () => setNotice({ tone: "success", text: `${branch.name} is now the project base branch.` }),
        // App reports the failure in its error banner before rethrowing; only the success notice is skipped here.
        () => undefined,
      );
    },
    onRename: (branch) => openDialog({ kind: "rename", branch }),
    onDelete: openDeleteDialog,
    onDeleteRemote: (branch) => openDialog({ kind: "delete-remote", branch }),
  };

  const cleanupMergedBranches = async (names: string[]) => {
    await runAction(
      "cleanup",
      async () => {
        let latest: ProjectGitBranchOverview | undefined;
        const failures: string[] = [];
        for (const name of names) {
          try {
            latest = await buildwarden.deleteProjectBranch(projectId, { branchName: name });
          } catch (caught) {
            failures.push(`${name}: ${errorText(caught, "deletion failed")}`);
          }
        }
        if (failures.length > 0) {
          throw new Error(`Deleted ${String(names.length - failures.length)} of ${String(names.length)} branches. ${failures.join(" ")}`);
        }
        return latest;
      },
      `Deleted ${String(names.length)} merged branch${names.length === 1 ? "" : "es"}.`,
      { fromDialog: true },
    );
  };

  const isBusy = (key: string) => actionBusy === key;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]">
            <GitBranch className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h2 className="truncate font-mono text-[15px] font-semibold text-[var(--ec-text)]" title={current || undefined}>
                {current || "Detached HEAD"}
              </h2>
              {!current ? (
                <HeaderChip tone="warning">
                  <TriangleAlert className="size-3" aria-hidden />
                  No branch checked out
                </HeaderChip>
              ) : null}
              <CurrentSyncChip branch={currentInfo} remoteName={remoteName} />
              {changedFileCount > 0 ? (
                <HeaderChip tone="warning" title="Uncommitted files in the project repository, including untracked files">
                  {changedFileCount} uncommitted
                </HeaderChip>
              ) : overview ? (
                <HeaderChip>
                  <CircleCheck className="size-3" aria-hidden />
                  Clean
                </HeaderChip>
              ) : null}
            </div>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--ec-faint)]">
              <span className="min-w-0 truncate" title={repoPath}>
                {repoPath}
              </span>
              <span className="shrink-0">·</span>
              <span className="shrink-0">
                {branchRows.length} branch{branchRows.length === 1 ? "" : "es"}
              </span>
              {forge ? (
                <>
                  <span className="shrink-0">·</span>
                  <span className="inline-flex shrink-0 items-center gap-1" title={hostingTitle}>
                    <Cloud className="size-3" aria-hidden />
                    {forge}
                    {authStatus && !authStatus.hasToken ? " (no token)" : ""}
                  </span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 px-2.5 text-xs"
              disabled={controlsDisabled || !currentInfo?.upstream}
              title={currentInfo?.upstream ? `Fast-forward ${current} from ${currentInfo.upstream}` : "The current branch has no upstream."}
              onClick={() =>
                void runAction("pull", () => buildwarden.pullProjectBranch(projectId), `Pulled ${current} from ${currentInfo?.upstream ?? "upstream"}.`)
              }
            >
              {isBusy("pull") ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CloudDownload className="size-3.5" aria-hidden />}
              Pull
              <CountBadge value={currentInfo?.behind ?? 0} />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 px-2.5 text-xs"
              disabled={controlsDisabled || !currentInfo?.hasLocal}
              onClick={() => currentInfo && rowActions.onPush(currentInfo)}
            >
              {isBusy(`push:${current}`) ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CloudUpload className="size-3.5" aria-hidden />}
              {currentInfo && !currentInfo.upstream ? "Publish" : "Push"}
              <CountBadge value={currentInfo?.ahead ?? 0} />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 px-2.5 text-xs"
              disabled={controlsDisabled || overview?.remoteName === null}
              title="Fetch all remotes and prune deleted branches"
              onClick={() => void runAction("fetch", () => buildwarden.fetchProjectBranches(projectId), "Fetched remotes and pruned deleted branches.")}
            >
              {isBusy("fetch") ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Cloud className="size-3.5" aria-hidden />}
              Fetch
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              disabled={controlsDisabled}
              title="Reload branches from the local repository"
              aria-label="Reload branches"
              onClick={() => void loadOverview()}
            >
              {isBusy("refresh") ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
            </Button>
            {overview?.webBaseUrl && forge ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8"
                title={`Open repository on ${forge}`}
                aria-label={`Open repository on ${forge}`}
                onClick={() => void openUrl(overview.webBaseUrl, "Could not open the repository.")}
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </Button>
            ) : null}
            <Button
              ref={newBranchButtonRef}
              type="button"
              size="sm"
              className="h-8 px-2.5 text-xs"
              disabled={controlsDisabled}
              onClick={() => openDialog({ kind: "create", source: current || baseBranch })}
            >
              <Plus className="size-3.5" aria-hidden />
              New branch
            </Button>
          </div>
        </div>
        {operation ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] px-3 py-2 text-xs">
            <TriangleAlert className="size-4 shrink-0 text-[var(--ec-warning)]" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-[var(--ec-text)]">{operationLabel(operation)} in progress</p>
              <p className="truncate text-[11px] text-[var(--ec-muted)]" title={overview?.conflictedFiles?.join("\n")}>
                {overview?.conflictedFiles?.length
                  ? `Conflicts in ${overview.conflictedFiles.join(", ")}. Resolve them in your editor or terminal, or abort.`
                  : "Finish it in your editor or terminal, or abort to return to the previous state."}
              </p>
            </div>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={controlsDisabled}
              onClick={() => void runAction("abort", () => buildwarden.abortProjectGitOperation(projectId), `Aborted the ${operation}.`)}
            >
              {isBusy("abort") ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
              Abort {operation}
            </Button>
          </div>
        ) : null}
      </Card>

      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            notice.tone === "success"
              ? "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-text)]"
              : "border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-text)]",
          )}
        >
          {notice.tone === "success" ? (
            <CircleCheck className="mt-px size-3.5 shrink-0 text-[var(--ec-success)]" aria-hidden />
          ) : (
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-[var(--ec-danger)]" aria-hidden />
          )}
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-5">{notice.text}</p>
          <button type="button" className="shrink-0 text-[var(--ec-muted)] hover:text-[var(--ec-text)]" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--ec-faint)]" aria-hidden />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, commit, author"
            aria-label="Filter branches"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <SegmentedControl label="Branch filter" value={filter} onChange={setFilter} options={filterOptions} className="overflow-x-auto" />
        <div className="ml-auto flex items-center gap-2">
          {cleanupCandidates.length > 0 ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-8"
              disabled={controlsDisabled}
              title="Delete local branches that are already merged into the base branch"
              onClick={() => openDialog({ kind: "cleanup" })}
            >
              <BrushCleaning className="size-3.5" aria-hidden />
              Clean up merged ({cleanupCandidates.length})
            </Button>
          ) : null}
          <Select
            value={sort}
            onValueChange={(value) => setSort(value === "name" ? "name" : "recent")}
            options={[
              { value: "recent", label: "Recently updated" },
              { value: "name", label: "Name" },
            ]}
            ariaLabel="Sort branches"
            align="end"
            className="w-40"
            triggerClassName="h-8 text-xs"
          />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--ec-faint)]">
          <span className="w-7 shrink-0" aria-hidden />
          <span className="flex-1">
            {visibleBranches.length === branchRows.length
              ? `${String(branchRows.length)} branch${branchRows.length === 1 ? "" : "es"}`
              : `${String(visibleBranches.length)} of ${String(branchRows.length)}`}
          </span>
          <span className="hidden w-20 shrink-0 text-right md:block">Upstream</span>
          <span className="hidden w-32 shrink-0 text-center normal-case tracking-normal lg:block" title={`Commits behind | ahead of ${baseLabel}`}>
            behind | ahead <span className="font-mono">{baseLabel}</span>
          </span>
          <span className="w-[5.5rem] shrink-0" aria-hidden />
          <span className="w-7 shrink-0" aria-hidden />
        </div>
        {visibleBranches.length > 0 ? (
          <div className="divide-y divide-[var(--ec-border)]">
            {visibleBranches.map((branch) => (
              <ProjectBranchRow
                key={branch.name}
                branch={branch}
                currentBranch={current}
                remoteName={remoteName}
                forge={forge && overview?.webBaseUrl ? forge : null}
                baseLabel={baseLabel}
                divergenceMax={divergenceMax}
                now={now}
                busyKey={actionBusy}
                disabled={controlsDisabled}
                actions={rowActions}
              />
            ))}
          </div>
        ) : (
          <Empty className="py-8">
            <EmptyHeader>
              <GitBranch className="size-8 text-[var(--ec-muted)]" aria-hidden />
              <EmptyTitle>{branchRows.length > 0 ? "No matching branches" : "No branches"}</EmptyTitle>
              <EmptyDescription>
                {branchRows.length > 0 ? "Change the filter or search to see more branches." : "No local or remote branches were found for this project."}
              </EmptyDescription>
              {branchRows.length > 0 ? (
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    setFilter("all");
                    setQuery("");
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </EmptyHeader>
          </Empty>
        )}
      </Card>

      {dialog ? (
        <ProjectBranchDialog
          key={dialog.kind === "cleanup" || dialog.kind === "create" ? dialog.kind : `${dialog.kind}:${dialog.branch.name}`}
          state={dialog}
          busy={actionBusy !== null}
          error={dialogError}
          currentBranch={current}
          baseLabel={baseLabel}
          remoteName={remoteName}
          changedFileCount={changedFileCount}
          sourceOptions={sourceOptions}
          cleanupCandidates={cleanupCandidates}
          deleteImpact={deleteImpact}
          deleteImpactChecking={deleteImpactChecking}
          onClose={closeDialog}
          onCreate={({ name, source, checkout }) =>
            void runAction(
              "create",
              () => buildwarden.createProjectBranch(projectId, { branchName: name, startPoint: source, checkout }),
              checkout ? `Created and checked out ${name}.` : `Created ${name} from ${source}.`,
              { fromDialog: true },
            )
          }
          onRename={(branch, newName) =>
            void runAction(
              `rename:${branch.name}`,
              () => buildwarden.renameProjectBranch(projectId, { oldName: branch.name, newName }),
              `Renamed ${branch.name} to ${newName}.`,
              { fromDialog: true },
            )
          }
          onDelete={(branch, { force, deleteRemote }) => {
            const runCount = deleteImpact?.branchName === branch.name ? deleteImpact.linkedRuns.length : 0;
            const runSuffix = runCount > 0 ? ` and ${String(runCount)} linked agent run${runCount === 1 ? "" : "s"}` : "";
            void runAction(
              `delete:${branch.name}`,
              async () => {
                const result = await buildwarden.deleteProjectBranch(projectId, { branchName: branch.name, force });
                if (!deleteRemote) return result;
                try {
                  return await buildwarden.deleteProjectRemoteBranch(projectId, { branchName: branch.name });
                } catch (caught) {
                  // Retrying here skips the missing local branch and only repeats the remote deletion.
                  throw new Error(`Deleted ${branch.name} locally, but not on ${remoteName}. ${errorText(caught, "The remote deletion failed.")}`);
                }
              },
              `Deleted ${branch.name}${deleteRemote ? ` locally and on ${remoteName}` : ""}${runSuffix}.`,
              { fromDialog: true },
            );
          }}
          onDeleteRemote={(branch) =>
            void runAction(
              `delete-remote:${branch.name}`,
              () => buildwarden.deleteProjectRemoteBranch(projectId, { branchName: branch.name }),
              `Deleted ${branch.name} on ${remoteName}.`,
              { fromDialog: true },
            )
          }
          onMerge={(source, mode: MergeProjectBranchMode) =>
            void runAction(
              `merge:${dialog.kind === "merge" ? dialog.branch.name : source}`,
              () => buildwarden.mergeProjectBranch(projectId, { branchName: source, mode }),
              `Merged ${source} into ${current}.`,
              { fromDialog: true },
            )
          }
          onRebase={(onto) =>
            void runAction(
              `rebase:${dialog.kind === "rebase" ? dialog.branch.name : onto}`,
              () => buildwarden.rebaseProjectBranch(projectId, { onto }),
              `Rebased ${current} onto ${onto}.`,
              { fromDialog: true },
            )
          }
          onCleanup={(names) => void cleanupMergedBranches(names)}
          fallbackFocusRef={newBranchButtonRef}
        />
      ) : null}
    </div>
  );
};
