import { useCallback, useEffect, useState } from "react";
import type { ProjectBranchDeleteImpact, ProjectGitBranchInfo, ProjectGitBranchOverview } from "@buildwarden/shared";
import { branchRefName, formatBranchAge } from "@buildwarden/renderer/project-branches-model";
import { Bot, Check, Cloud, GitBranch, GitBranchPlus, Loader2, Trash2 } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { errorMessage } from "../../lib/format";
import { ActionSheet, Sheet, type SheetAction } from "../../components/Sheet";
import { SelectRow, SettingGroup, ToggleRow } from "../../components/SettingControls";
import { Badge, Button, CenteredSpinner, InlineError, Input, ListRow, SectionAction, SectionLabel } from "../../components/primitives";

type BranchSheet =
  | { kind: "actions"; branch: ProjectGitBranchInfo }
  | { kind: "create"; source: string }
  | { kind: "delete"; branch: ProjectGitBranchInfo };

const BranchLeading = ({ branch }: { branch: ProjectGitBranchInfo }) => {
  if (branch.isCurrent) return <Check className="size-4 text-[var(--ec-success)]" />;
  if ((branch.linkedRunCount ?? 0) > 0) return <Bot className="size-4" />;
  if (!branch.hasLocal) return <Cloud className="size-4" />;
  return <GitBranch className="size-4" />;
};

const branchSubtitle = (branch: ProjectGitBranchInfo) => {
  const age = formatBranchAge(branch.updatedAt, Date.now());
  return [branch.subject, age].filter(Boolean).join(" · ") || branch.upstream || undefined;
};

const CreateBranchSheet = ({
  projectId,
  initialSource,
  sourceOptions,
  onClose,
  onCreated,
}: {
  projectId: string;
  initialSource: string;
  sourceOptions: ReadonlyArray<{ value: string; label: string }>;
  onClose: () => void;
  onCreated: (overview: ProjectGitBranchOverview) => void;
}) => {
  const { client } = useMobileApp();
  const action = useAction();
  const [name, setName] = useState("");
  const [source, setSource] = useState(initialSource);
  const [checkout, setCheckout] = useState(true);

  const create = async () => {
    const overview = await action.run(
      () => client.createProjectBranch(projectId, { branchName: name.trim(), startPoint: source, checkout }),
      "Could not create the branch.",
    );
    if (overview) onCreated(overview);
  };

  return (
    <Sheet
      open
      onClose={onClose}
      dismissable={!action.busy}
      title="New branch"
      footer={
        <div className="flex gap-2">
          <Button tone="neutral" block disabled={action.busy} onClick={onClose}>Cancel</Button>
          <Button block busy={action.busy} disabled={!name.trim() || !source} onClick={() => void create()}>Create branch</Button>
        </div>
      }
    >
      {action.error ? <InlineError message={action.error} /> : null}
      <div className="px-4 pt-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--ec-muted)]">Branch name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value.replace(/\s/g, "-"))}
            placeholder="feature/my-change"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="m-mono"
            aria-label="Branch name"
            autoFocus
          />
        </label>
      </div>
      <SettingGroup title="Options">
        <SelectRow title="Start from" value={source} options={sourceOptions} disabled={action.busy} onChange={setSource} />
        <ToggleRow title="Check out after creating" checked={checkout} disabled={action.busy} onChange={setCheckout} />
      </SettingGroup>
    </Sheet>
  );
};

const DeleteBranchSheet = ({
  projectId,
  branch,
  baseLabel,
  onClose,
  onDeleted,
}: {
  projectId: string;
  branch: ProjectGitBranchInfo;
  baseLabel: string;
  onClose: () => void;
  onDeleted: (overview: ProjectGitBranchOverview) => void;
}) => {
  const { client } = useMobileApp();
  const action = useAction();
  const [force, setForce] = useState(false);
  const [impact, setImpact] = useState<ProjectBranchDeleteImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    client.getProjectBranchDeleteImpact(projectId, { branchName: branch.name }).then(
      (next) => { if (active) setImpact(next); },
      (caught: unknown) => { if (active) setImpactError(errorMessage(caught, "Could not check linked agent runs.")); },
    );
    return () => { active = false; };
  }, [branch.name, client, projectId]);

  const remove = async () => {
    const overview = await action.run(() => client.deleteProjectBranch(projectId, { branchName: branch.name, force }), "Could not delete the branch.");
    if (overview) onDeleted(overview);
  };

  const runCount = impact?.linkedRuns.length ?? 0;
  return (
    <Sheet
      open
      onClose={onClose}
      dismissable={!action.busy}
      title={`Delete ${branch.name}?`}
      footer={
        <div className="flex gap-2">
          <Button tone="neutral" block disabled={action.busy} onClick={onClose}>Cancel</Button>
          <Button tone="danger" block busy={action.busy} disabled={!impact && !impactError} onClick={() => void remove()}>Delete branch</Button>
        </div>
      }
    >
      {action.error ? <InlineError message={action.error} /> : null}
      {impactError ? <InlineError message={impactError} /> : null}
      <div className="space-y-2 px-4 pt-4 text-sm leading-6 text-[var(--ec-muted)]">
        <p>Deletes the local branch. {branch.hasRemote ? "The remote branch is kept." : null}</p>
        {!impact && !impactError ? (
          <p className="flex items-center gap-2 text-xs"><Loader2 className="size-3.5 animate-spin" />Checking linked agent runs…</p>
        ) : null}
        {runCount > 0 ? (
          <p className="rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-3 py-2 text-xs text-[var(--ec-danger)]">
            Also deletes {runCount} linked agent run{runCount === 1 ? "" : "s"} and their BuildWarden worktrees.
          </p>
        ) : null}
        {branch.mergedIntoBase === true ? null : (
          <p className="text-xs">Not merged into <span className="m-mono">{baseLabel}</span>; Git refuses to delete unmerged work unless you force it.</p>
        )}
      </div>
      <SettingGroup title="Options">
        <ToggleRow title="Force delete" description="Discard commits that are not merged anywhere." checked={force} disabled={action.busy} onChange={setForce} />
      </SettingGroup>
    </Sheet>
  );
};

export const ProjectBranchesPanel = ({ projectId }: { projectId: string }) => {
  const { client } = useMobileApp();
  const [overview, setOverview] = useState<ProjectGitBranchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<BranchSheet | null>(null);
  const action = useAction();
  const canMutate = client.capabilities.gitMutations;

  const load = useCallback(async () => {
    try {
      setOverview(await client.getProjectBranchOverview(projectId));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load branches."));
    }
  }, [client, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <InlineError message={error} onRetry={() => void load()} />;
  if (!overview) return <CenteredSpinner label="Loading branches" />;

  const remoteName = overview.remoteName ?? "origin";
  const baseLabel = overview.baseCompareRef ?? overview.baseBranch;
  const current = overview.currentBranch;
  const sourceOptions = overview.branches.map((branch) => {
    const ref = branchRefName(branch, remoteName);
    return { value: ref, label: ref };
  });

  const runAndReload = async (work: () => Promise<unknown>, success: string) => {
    setNotice(null);
    if (await action.ok(work)) {
      setNotice(success);
      await load();
    }
  };

  const finish = (next: ProjectGitBranchOverview, success: string) => {
    setOverview(next);
    setSheet(null);
    setNotice(success);
  };

  const checkout = (branch: ProjectGitBranchInfo) =>
    void runAndReload(() => client.checkoutProjectBranch(projectId, branch.name), `Checked out ${branch.name}.`);

  const branchActions = (branch: ProjectGitBranchInfo): SheetAction[] => {
    const inWorktree = Boolean(branch.worktreePath);
    const actions: SheetAction[] = [];
    if (!branch.isCurrent) {
      actions.push({
        label: branch.hasLocal ? "Check out" : `Check out tracking ${remoteName}/${branch.name}`,
        icon: <Check className="size-4" />,
        disabled: inWorktree,
        hint: inWorktree ? "Checked out in a worktree" : undefined,
        onSelect: () => checkout(branch),
      });
    }
    actions.push({
      label: "New branch from here",
      icon: <GitBranchPlus className="size-4" />,
      onSelect: () => setSheet({ kind: "create", source: branchRefName(branch, remoteName) }),
    });
    if (branch.hasLocal && !branch.isBase) {
      let hint: string | undefined;
      if (branch.isCurrent) hint = "Check out another branch first";
      else if (inWorktree) hint = "Checked out in a worktree";
      actions.push({
        label: "Delete branch",
        icon: <Trash2 className="size-4" />,
        danger: true,
        disabled: branch.isCurrent || inWorktree,
        hint,
        onSelect: () => setSheet({ kind: "delete", branch }),
      });
    }
    return actions;
  };

  return (
    <div className="m-scroll m-screen-enter flex-1">
      {action.error ? <InlineError message={action.error} /> : null}
      {notice ? (
        <p role="status" className="mx-4 mt-3 rounded-md border border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] px-3 py-2 text-xs text-[var(--ec-success)]">
          {notice}
        </p>
      ) : null}
      <div className="flex gap-2 border-b border-[var(--ec-border)] px-4 py-2.5">
        <Button
          tone="neutral"
          size="sm"
          className="flex-1"
          busy={action.busy}
          disabled={!canMutate}
          onClick={() => void runAndReload(() => client.fetchProjectBranches(projectId), "Fetched remotes.")}
        >
          Fetch
        </Button>
        <Button
          tone="neutral"
          size="sm"
          className="flex-1"
          busy={action.busy}
          disabled={!canMutate}
          onClick={() => void runAndReload(() => client.pullProjectBranch(projectId), `Pulled ${current || "the current branch"}.`)}
        >
          Pull
        </Button>
      </div>
      <SectionLabel
        action={canMutate ? <SectionAction onClick={() => setSheet({ kind: "create", source: current || overview.baseBranch })}>New branch</SectionAction> : undefined}
      >
        Branches · {overview.branches.length}
      </SectionLabel>
      {overview.branches.map((branch) => (
        <ListRow
          key={branch.name}
          leading={<BranchLeading branch={branch} />}
          title={<span className="m-mono text-[12.5px]">{branch.name}</span>}
          subtitle={branchSubtitle(branch)}
          trailing={
            <>
              {branch.isCurrent ? <Badge tone="accent">current</Badge> : null}
              {branch.isBase ? <Badge>base</Badge> : null}
              {!branch.hasLocal ? <Badge tone="info">remote</Badge> : null}
            </>
          }
          onClick={canMutate ? () => setSheet({ kind: "actions", branch }) : undefined}
          className="border-b border-[var(--ec-border)]"
        />
      ))}
      <div className="h-24" />

      <ActionSheet
        open={sheet?.kind === "actions"}
        onClose={() => setSheet(null)}
        title={sheet?.kind === "actions" ? sheet.branch.name : undefined}
        actions={sheet?.kind === "actions" ? branchActions(sheet.branch) : []}
      />
      {sheet?.kind === "create" ? (
        <CreateBranchSheet
          projectId={projectId}
          initialSource={sheet.source}
          sourceOptions={sourceOptions}
          onClose={() => setSheet(null)}
          onCreated={(next) => finish(next, `Created ${next.currentBranch && next.currentBranch !== current ? `and checked out ${next.currentBranch}` : "the branch"}.`)}
        />
      ) : null}
      {sheet?.kind === "delete" ? (
        <DeleteBranchSheet
          projectId={projectId}
          branch={sheet.branch}
          baseLabel={baseLabel}
          onClose={() => setSheet(null)}
          onDeleted={(next) => finish(next, `Deleted ${sheet.branch.name}.`)}
        />
      ) : null}
    </div>
  );
};
