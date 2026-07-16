import type { ProjectBranchDeleteImpact, ProjectForgeAuthStatus, ProjectGitBranchInfo, ProjectGitBranchOverview } from "@buildwarden/shared";
import {
  AlertTriangle,
  Check,
  Cloud,
  ExternalLink,
  GitBranch,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

export interface ProjectBranchesPageProps {
  projectId: string;
  repoPath: string;
  baseBranch: string;
  currentBranch: string;
  branches: string[];
  busy: boolean;
  onBranchesChanged: () => void | Promise<void>;
}

const checkoutButtonLabel = (branch: ProjectGitBranchInfo): string => {
  if (branch.isCurrent) {
    return "Checked out";
  }
  return branch.hasLocal ? "Checkout" : "Track";
};

const BranchDeleteImpactNotice = ({
  branchName,
  checking,
  impact,
}: Readonly<{
  branchName: string;
  checking: boolean;
  impact: ProjectBranchDeleteImpact | null;
}>) => {
  if (checking) {
    return <p className="mt-1 text-[11px] text-[var(--ec-muted)]">Checking linked agent runs...</p>;
  }
  if (impact?.branchName !== branchName) {
    return null;
  }
  if (impact.linkedRuns.length === 0) {
    return (
      <p className="mt-1 text-[11px] text-[var(--ec-muted)]">No linked agent runs were found. Confirm to delete only the local branch.</p>
    );
  }
  return (
    <div className="mt-1.5 space-y-1 text-[11px] text-[var(--ec-muted)]">
      <p>
        This will also delete {impact.linkedRuns.length} linked agent run
        {impact.linkedRuns.length === 1 ? "" : "s"} and any BuildWarden worktrees for them.
      </p>
      <div className="max-h-20 overflow-auto rounded border border-[var(--ec-danger-ring)] bg-black/10">
        {impact.linkedRuns.slice(0, 4).map((run) => (
          <div key={run.id} className="flex min-w-0 items-center justify-between gap-2 px-2 py-1">
            <span className="min-w-0 truncate text-[var(--ec-text)]">{compactRunPrompt(run.prompt)}</span>
            <span className="shrink-0 rounded-full border border-[var(--ec-border)] px-1.5 py-px text-[9px] uppercase text-[var(--ec-muted)]">
              {run.status}
            </span>
          </div>
        ))}
        {impact.linkedRuns.length > 4 ? (
          <div className="px-2 py-1 text-[var(--ec-faint)]">+{impact.linkedRuns.length - 4} more</div>
        ) : null}
      </div>
    </div>
  );
};

const resolveHostingLabel = (authProvider: string | null, overviewProvider: string | null): string => {
  if (authProvider) {
    return authProvider === "gitlab" ? "GitLab" : "GitHub";
  }
  if (overviewProvider === "gitlab") {
    return "GitLab";
  }
  if (overviewProvider === "github") {
    return "GitHub";
  }
  return "Remote";
};

const formatBranchDate = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const branchWebUrl = (overview: ProjectGitBranchOverview | null, branch: string) => {
  if (!overview?.webBaseUrl || overview.provider === "unknown") return null;
  const encoded = encodeURIComponent(branch);
  return overview.provider === "gitlab" ? `${overview.webBaseUrl}/-/tree/${encoded}` : `${overview.webBaseUrl}/tree/${encoded}`;
};

const branchStatusText = (branch: ProjectGitBranchInfo) => {
  if (branch.isCurrent) return "Current checkout";
  if (branch.hasLocal && branch.hasRemote) return "Local and remote";
  if (branch.hasLocal) return "Local only";
  return "Remote only";
};

const branchSourceLabel = (branch: ProjectGitBranchInfo) => (branch.hasLocal ? branch.name : `origin/${branch.name}`);

const compactRunPrompt = (value: string) => {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 74 ? `${trimmed.slice(0, 71)}...` : trimmed || "Untitled run";
};

export const ProjectBranchesPage = ({
  projectId,
  repoPath,
  baseBranch,
  currentBranch,
  branches,
  busy,
  onBranchesChanged,
}: ProjectBranchesPageProps) => {
  const buildwarden = useBuildWardenClient();
  const [overview, setOverview] = useState<ProjectGitBranchOverview | null>(null);
  const [authStatus, setAuthStatus] = useState<ProjectForgeAuthStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchSource, setNewBranchSource] = useState("");
  const [renameBranch, setRenameBranch] = useState<string | null>(null);
  const [renameBranchName, setRenameBranchName] = useState("");
  const [deleteBranch, setDeleteBranch] = useState<string | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<ProjectBranchDeleteImpact | null>(null);
  const [deleteImpactBusy, setDeleteImpactBusy] = useState<string | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const deleteImpactRequestRef = useRef(0);

  const loadOverview = useCallback(async () => {
    setActionBusy((current) => current ?? "refresh");
    setError(null);
    try {
      const [nextOverview, nextAuthStatus] = await Promise.all([
        buildwarden.getProjectBranchOverview(projectId),
        buildwarden.getProjectForgeAuthStatus(projectId).catch(() => null),
      ]);
      setOverview(nextOverview);
      setAuthStatus(nextAuthStatus);
      setNewBranchSource((current) => current || nextOverview.currentBranch || nextOverview.baseBranch || nextOverview.branches[0]?.name || "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load branch information.");
    } finally {
      setActionBusy((current) => (current === "refresh" ? null : current));
    }
  }, [buildwarden, projectId]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const fallbackBranches = useMemo<ProjectGitBranchInfo[]>(
    () =>
      [...new Set(branches.filter(Boolean))].map((branch) => ({
        name: branch,
        isCurrent: branch === currentBranch,
        isBase: branch === baseBranch,
        hasLocal: true,
        hasRemote: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        commitSha: null,
        updatedAt: null,
        subject: null,
      })),
    [baseBranch, branches, currentBranch],
  );
  const branchRows = overview?.branches.length ? overview.branches : fallbackBranches;
  const current = overview?.currentBranch ?? currentBranch;
  const sourceOptions = useMemo(() => branchRows.map(branchSourceLabel), [branchRows]);
  const currentBranchInfo = branchRows.find((branch) => branch.name === current) ?? null;
  const hasHostingToken = authStatus?.hasToken === true;
  const hostingLabel = resolveHostingLabel(authStatus?.provider ?? null, overview?.provider ?? null);
  let hostingTokenSuffix = "";
  if (authStatus) {
    hostingTokenSuffix = hasHostingToken ? " token" : " no token";
  }

  const runBranchAction = async (key: string, action: () => Promise<ProjectGitBranchOverview | void>, success: string): Promise<boolean> => {
    setActionBusy(key);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      if (result) {
        setOverview(result);
        setNewBranchSource((currentSource) => currentSource || result.currentBranch || result.baseBranch || result.branches[0]?.name || "");
      } else {
        await loadOverview();
      }
      await onBranchesChanged();
      setMessage(success);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Branch action failed.");
      return false;
    } finally {
      setActionBusy(null);
    }
  };

  const checkoutBranch = (branch: ProjectGitBranchInfo) =>
    runBranchAction(
      `checkout:${branch.name}`,
      async () => {
        await buildwarden.checkoutProjectBranch(projectId, branch.name);
        return buildwarden.getProjectBranchOverview(projectId);
      },
      branch.hasLocal ? `Checked out ${branch.name}.` : `Created a tracking checkout for ${branch.name}.`,
    );

  const createBranch = () =>
    runBranchAction(
      "create",
      () =>
        buildwarden.createProjectBranch(projectId, {
          branchName: newBranchName,
          startPoint: newBranchSource || current || baseBranch,
          checkout: true,
        }),
      `Created and checked out ${newBranchName.trim()}.`,
    ).then((ok) => {
      if (ok) {
        setNewBranchName("");
      }
    });

  const renameSelectedBranch = (branch: string) =>
    runBranchAction(
      `rename:${branch}`,
      () => buildwarden.renameProjectBranch(projectId, { oldName: branch, newName: renameBranchName }),
      `Renamed ${branch} to ${renameBranchName.trim()}.`,
    ).then((ok) => {
      if (ok) {
        setRenameBranch(null);
        setRenameBranchName("");
      }
    });

  const prepareDeleteBranch = (branch: string) => {
    const requestId = deleteImpactRequestRef.current + 1;
    deleteImpactRequestRef.current = requestId;
    setRenameBranch(null);
    setDeleteBranch(branch);
    setDeleteImpact(null);
    setForceDelete(false);
    setDeleteImpactBusy(branch);
    setError(null);
    void buildwarden
      .getProjectBranchDeleteImpact(projectId, { branchName: branch })
      .then((impact) => {
        if (deleteImpactRequestRef.current === requestId) {
          setDeleteImpact(impact);
        }
      })
      .catch((caught: unknown) => {
        if (deleteImpactRequestRef.current !== requestId) {
          return;
        }
        setError(caught instanceof Error ? caught.message : "Could not check linked agent runs.");
        setDeleteBranch(null);
      })
      .finally(() => {
        if (deleteImpactRequestRef.current === requestId) {
          setDeleteImpactBusy(null);
        }
      });
  };

  const describeBranchDeletion = (branch: string): string => {
    if (deleteImpact?.branchName === branch && deleteImpact.linkedRuns.length > 0) {
      const runCount = deleteImpact.linkedRuns.length;
      return `Deleted local branch ${branch} and ${runCount} linked agent run${runCount === 1 ? "" : "s"}.`;
    }
    return `Deleted local branch ${branch}.`;
  };

  const deleteSelectedBranch = (branch: string) =>
    runBranchAction(
      `delete:${branch}`,
      () => buildwarden.deleteProjectBranch(projectId, { branchName: branch, force: forceDelete }),
      describeBranchDeletion(branch),
    ).then((ok) => {
      if (ok) {
        setDeleteBranch(null);
        setDeleteImpact(null);
        setForceDelete(false);
      }
    });

  const openBranch = async (branch: string) => {
    const url = branchWebUrl(overview, branch);
    if (!url) return;
    const result = await buildwarden.openExternalUrl(url);
    if (!result.ok) {
      setError(result.error ?? "Could not open remote branch.");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
      <Card>
        <CardContent className="p-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <GitBranch className="mt-0.5 size-4 shrink-0 text-[var(--ec-accent)]" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-[var(--ec-text)]">Branches</p>
                  <span className="rounded-full border border-[var(--ec-border)] px-2 py-0.5 text-[10px] text-[var(--ec-muted)]">
                    {hostingLabel}
                    {hostingTokenSuffix}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-[var(--ec-muted)]" title={repoPath}>
                  {repoPath}
                </p>
                <p className="mt-1 text-xs text-[var(--ec-muted)]">
                  Current: <span className="font-mono text-[var(--ec-text)]">{current || "detached HEAD"}</span>
                  {currentBranchInfo?.upstream ? (
                    <span className="ml-2 font-mono text-[var(--ec-faint)]">{currentBranchInfo.upstream}</span>
                  ) : null}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
              {overview?.webBaseUrl ? (
                <Button type="button" size="sm" variant="secondary" className="h-8 px-2.5 text-xs" onClick={() => void buildwarden.openExternalUrl(overview.webBaseUrl!)}>
                  <ExternalLink className="mr-1.5 size-3.5" />
                  Open remote
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="secondary" className="h-8 px-2.5 text-xs" disabled={busy || actionBusy !== null} onClick={() => void loadOverview()}>
                {actionBusy === "refresh" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
                Refresh
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={busy || actionBusy !== null}
                onClick={() => void runBranchAction("fetch", () => buildwarden.fetchProjectBranches(projectId), "Fetched remotes and pruned stale refs.")}
              >
                {actionBusy === "fetch" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Cloud className="mr-1.5 size-3.5" />}
                Fetch
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-8 px-2.5 text-xs"
                disabled={busy || actionBusy !== null || !current || !currentBranchInfo?.upstream}
                onClick={() => void runBranchAction("pull", () => buildwarden.pullProjectBranch(projectId), "Pulled current branch with fast-forward only.")}
              >
                {actionBusy === "pull" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
                Pull
              </Button>
            </div>
          </div>
          {error ? <p className="mt-3 text-xs text-[var(--ec-danger)]">{error}</p> : null}
          {message ? <p className="mt-3 text-xs text-[var(--ec-success)]">{message}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-2 p-3 lg:grid-cols-[minmax(12rem,1fr)_minmax(10rem,0.7fr)_auto] lg:items-end">
          <label className="min-w-0 space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-faint)]">New branch</span>
            <Input value={newBranchName} onChange={(event) => setNewBranchName(event.target.value)} placeholder="feature/my-change" className="h-8 font-mono text-xs" />
          </label>
          <label className="min-w-0 space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-faint)]">From</span>
            <Select
              value={newBranchSource}
              onValueChange={setNewBranchSource}
              options={sourceOptions.map((source) => ({ value: source, label: source }))}
              triggerClassName="h-8 font-mono text-xs"
            />
          </label>
          <Button type="button" size="sm" className="h-8 px-3 text-xs" disabled={busy || actionBusy !== null || !newBranchName.trim()} onClick={() => void createBranch()}>
            {actionBusy === "create" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Plus className="mr-1.5 size-3.5" />}
            Create branch
          </Button>
        </CardContent>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--ec-border)] px-3 py-2 text-xs">
          <span className="font-medium text-[var(--ec-muted)]">
            {branchRows.length} branch{branchRows.length === 1 ? "" : "es"}
          </span>
          <span className="text-[10px] text-[var(--ec-faint)]">Local actions use Git credentials configured for this repository.</span>
        </div>
        {branchRows.length > 0 ? (
          <div className="divide-y divide-[var(--ec-border)]">
            {branchRows.map((branch) => {
              const isBusy = actionBusy?.endsWith(`:${branch.name}`) ?? false;
              const canRename = branch.hasLocal && !branch.isBase;
              const canDelete = branch.hasLocal && !branch.isCurrent && !branch.isBase;
              const canPush = branch.hasLocal;
              const canOpenRemote = Boolean(branchWebUrl(overview, branch.name)) && branch.hasRemote;
              return (
                <div key={branch.name} className="px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]">
                      {branch.isCurrent ? <Check className="size-3.5 text-[var(--ec-success)]" /> : <GitBranch className="size-3.5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <p className="truncate font-mono text-sm font-semibold text-[var(--ec-text)]">{branch.name}</p>
                        {branch.isBase ? <span className="rounded-full border border-[var(--ec-border)] px-1.5 py-px text-[9px] text-[var(--ec-muted)]">base</span> : null}
                        {branch.hasLocal ? <span className="rounded-full border border-emerald-500/25 bg-emerald-500/[0.08] px-1.5 py-px text-[9px] text-emerald-200">local</span> : null}
                        {branch.hasRemote ? <span className="rounded-full border border-cyan-500/25 bg-cyan-500/[0.08] px-1.5 py-px text-[9px] text-cyan-100">remote</span> : null}
                        {branch.ahead > 0 ? <span className="rounded-full border border-amber-500/25 px-1.5 py-px text-[9px] text-amber-200">ahead {branch.ahead}</span> : null}
                        {branch.behind > 0 ? <span className="rounded-full border border-violet-500/25 px-1.5 py-px text-[9px] text-violet-200">behind {branch.behind}</span> : null}
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-[var(--ec-muted)]">
                        {branchStatusText(branch)}
                        {branch.upstream ? <span className="ml-1 font-mono text-[var(--ec-faint)]">{branch.upstream}</span> : null}
                        {branch.subject ? <span className="ml-2">{branch.subject}</span> : null}
                        {branch.updatedAt ? <span className="ml-2 text-[var(--ec-faint)]">{formatBranchDate(branch.updatedAt)}</span> : null}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      {canOpenRemote ? (
                        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => void openBranch(branch.name)}>
                          <ExternalLink className="mr-1 size-3" />
                          Open
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant={branch.isCurrent ? "ghost" : "secondary"}
                        className="h-7 px-2 text-[11px]"
                        disabled={busy || actionBusy !== null || branch.isCurrent}
                        onClick={() => void checkoutBranch(branch)}
                      >
                        {actionBusy === `checkout:${branch.name}` ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                        {checkoutButtonLabel(branch)}
                      </Button>
                      {canPush ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="h-7 px-2 text-[11px]"
                          disabled={busy || actionBusy !== null}
                          onClick={() =>
                            void runBranchAction(
                              `push:${branch.name}`,
                              () => buildwarden.pushProjectBranch(projectId, { branchName: branch.name, setUpstream: true }),
                              `Pushed ${branch.name} to origin.`,
                            )
                          }
                        >
                          {actionBusy === `push:${branch.name}` ? <Loader2 className="mr-1 size-3 animate-spin" /> : <UploadCloud className="mr-1 size-3" />}
                          Push
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={cn("h-7 px-2 text-[11px]", !canRename && "opacity-50")}
                        disabled={busy || actionBusy !== null || !canRename}
                        onClick={() => {
                          setDeleteBranch(null);
                          setRenameBranch(branch.name);
                          setRenameBranchName(branch.name);
                        }}
                      >
                        <Pencil className="mr-1 size-3" />
                        Rename
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={cn("h-7 px-2 text-[11px] text-[var(--ec-danger)]", !canDelete && "opacity-50")}
                        disabled={busy || actionBusy !== null || !canDelete}
                        onClick={() => prepareDeleteBranch(branch.name)}
                      >
                        <Trash2 className="mr-1 size-3" />
                        Delete
                      </Button>
                    </div>
                  </div>

                  {renameBranch === branch.name ? (
                    <div className="ml-10 mt-2 flex flex-wrap items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-2">
                      <Input value={renameBranchName} onChange={(event) => setRenameBranchName(event.target.value)} className="h-8 min-w-64 flex-1 font-mono text-xs" />
                      <Button type="button" size="sm" className="h-8 px-3 text-xs" disabled={!renameBranchName.trim() || actionBusy !== null} onClick={() => void renameSelectedBranch(branch.name)}>
                        {isBusy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                        Save
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="h-8 px-3 text-xs" onClick={() => setRenameBranch(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : null}

                  {deleteBranch === branch.name ? (
                    <div className="ml-10 mt-2 rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] p-2">
                      <div className="flex flex-wrap items-start gap-2">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--ec-danger)]" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-[var(--ec-text)]">
                            Delete local branch <span className="font-mono font-semibold">{branch.name}</span>?
                          </p>
                          <BranchDeleteImpactNotice
                            branchName={branch.name}
                            checking={deleteImpactBusy === branch.name}
                            impact={deleteImpact}
                          />
                        </div>
                        <label className="flex items-center gap-1.5 text-xs text-[var(--ec-muted)]">
                          <input type="checkbox" checked={forceDelete} onChange={(event) => setForceDelete(event.target.checked)} />
                          Force if unmerged
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          className="h-8 px-3 text-xs"
                          disabled={actionBusy !== null || deleteImpactBusy === branch.name}
                          onClick={() => void deleteSelectedBranch(branch.name)}
                        >
                          {isBusy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                          Confirm delete
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8 px-3 text-xs"
                          onClick={() => {
                            deleteImpactRequestRef.current += 1;
                            setDeleteBranch(null);
                            setDeleteImpact(null);
                            setDeleteImpactBusy(null);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <GitBranch className="size-10 text-[var(--ec-muted)]" />
              <EmptyTitle>No branches</EmptyTitle>
              <EmptyDescription>No local or remote branches were found for this project.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </Card>
    </div>
  );
};
