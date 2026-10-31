import type { MergeProjectBranchMode, ProjectBranchDeleteImpact, ProjectGitBranchInfo } from "@buildwarden/shared";
import { Info, Loader2, TriangleAlert } from "lucide-react";
import { useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ModalDialog } from "../ui/modal-dialog";
import { SegmentedControl } from "../ui/segmented-control";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";

export type BranchDialogState =
  | { kind: "create"; source: string }
  | { kind: "rename"; branch: ProjectGitBranchInfo }
  | { kind: "delete"; branch: ProjectGitBranchInfo }
  | { kind: "delete-remote"; branch: ProjectGitBranchInfo }
  | { kind: "merge"; branch: ProjectGitBranchInfo; source: string }
  | { kind: "rebase"; branch: ProjectGitBranchInfo; onto: string }
  | { kind: "cleanup" };

export interface ProjectBranchDialogProps {
  state: BranchDialogState;
  busy: boolean;
  error: string | null;
  currentBranch: string;
  baseLabel: string;
  remoteName: string;
  changedFileCount: number;
  sourceOptions: Array<{ value: string; label: string }>;
  cleanupCandidates: ProjectGitBranchInfo[];
  deleteImpact: ProjectBranchDeleteImpact | null;
  deleteImpactChecking: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; source: string; checkout: boolean }) => void;
  onRename: (branch: ProjectGitBranchInfo, newName: string) => void;
  onDelete: (branch: ProjectGitBranchInfo, options: { force: boolean; deleteRemote: boolean }) => void;
  onDeleteRemote: (branch: ProjectGitBranchInfo) => void;
  onMerge: (source: string, mode: MergeProjectBranchMode) => void;
  onRebase: (onto: string) => void;
  onCleanup: (branchNames: string[]) => void;
  /** Receives focus on close when the element that opened the dialog is gone, such as a renamed row. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono font-medium text-[var(--ec-text)]">{children}</span>;

const Notice = ({ tone = "info", children }: { tone?: "info" | "warning" | "danger"; children: ReactNode }) => {
  const Icon = tone === "info" ? Info : TriangleAlert;
  return (
    <div
      className={cn(
        "flex gap-2 rounded-md border px-2.5 py-2 text-[11px] leading-4",
        tone === "info" && "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]",
        tone === "warning" && "border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] text-[var(--ec-text)]",
        tone === "danger" && "border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-text)]",
      )}
    >
      <Icon
        className={cn(
          "mt-px size-3.5 shrink-0",
          tone === "info" && "text-[var(--ec-muted)]",
          tone === "warning" && "text-[var(--ec-warning)]",
          tone === "danger" && "text-[var(--ec-danger)]",
        )}
        aria-hidden
      />
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
};

const ToggleRow = ({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (value: boolean) => void }) => (
  <label className="flex cursor-pointer items-start justify-between gap-3 text-xs">
    <span className="min-w-0">
      <span className="block text-[var(--ec-text)]">{label}</span>
      {description ? <span className="block text-[11px] text-[var(--ec-muted)]">{description}</span> : null}
    </span>
    <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
  </label>
);

const DialogFooter = ({
  busy,
  error,
  confirmLabel,
  confirmDisabled = false,
  danger = false,
  onClose,
}: {
  busy: boolean;
  error: string | null;
  confirmLabel: string;
  confirmDisabled?: boolean;
  danger?: boolean;
  onClose: () => void;
}) => (
  <>
    {error ? (
      <p role="alert" className="text-xs leading-5 text-[var(--ec-danger)]">
        {error}
      </p>
    ) : null}
    <div className="flex justify-end gap-2 pt-1">
      <Button type="button" size="sm" variant="secondary" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" size="sm" variant={danger ? "danger" : "default"} disabled={busy || confirmDisabled}>
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
        {confirmLabel}
      </Button>
    </div>
  </>
);

const submitWith = (action: () => void) => (event: FormEvent) => {
  event.preventDefault();
  action();
};

const UncommittedNotice = ({ count }: { count: number }) =>
  count > 0 ? (
    <Notice tone="warning">
      <p>
        {count} uncommitted file{count === 1 ? "" : "s"} in the project repository. Git stops if the operation would overwrite them.
      </p>
    </Notice>
  ) : null;

const CreateBranchForm = ({ initialSource, props }: { initialSource: string; props: ProjectBranchDialogProps }) => {
  const [name, setName] = useState("");
  const [source, setSource] = useState(initialSource);
  const [checkout, setCheckout] = useState(true);
  return (
    <form className="space-y-3" onSubmit={submitWith(() => props.onCreate({ name: name.trim(), source, checkout }))}>
      <label className="block space-y-1 text-xs text-[var(--ec-muted)]">
        Branch name
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value.replace(/\s/g, "-"))}
          placeholder="feature/my-change"
          className="h-8 font-mono text-xs"
          aria-label="Branch name"
        />
      </label>
      <label className="block space-y-1 text-xs text-[var(--ec-muted)]">
        Start from
        <Select
          value={source}
          onValueChange={setSource}
          options={props.sourceOptions}
          searchable
          searchPlaceholder="Filter branches"
          ariaLabel="Start from"
          triggerClassName="h-8 font-mono text-xs"
          maxMenuHeightPx={280}
        />
      </label>
      <ToggleRow label="Check out after creating" checked={checkout} onChange={setCheckout} />
      {checkout ? <UncommittedNotice count={props.changedFileCount} /> : null}
      <DialogFooter busy={props.busy} error={props.error} confirmLabel="Create branch" confirmDisabled={!name.trim() || !source} onClose={props.onClose} />
    </form>
  );
};

const RenameBranchForm = ({ branch, props }: { branch: ProjectGitBranchInfo; props: ProjectBranchDialogProps }) => {
  const [name, setName] = useState(branch.name);
  const unchanged = name.trim() === branch.name;
  return (
    <form className="space-y-3" onSubmit={submitWith(() => props.onRename(branch, name.trim()))}>
      <Input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value.replace(/\s/g, "-"))}
        onFocus={(event) => event.currentTarget.select()}
        className="h-8 font-mono text-xs"
        aria-label="New branch name"
      />
      {branch.hasRemote ? (
        <Notice>
          <p>
            Only the local branch is renamed. <Mono>{props.remoteName}/{branch.name}</Mono> keeps its name until you push the renamed branch and delete the old one.
          </p>
        </Notice>
      ) : null}
      <DialogFooter busy={props.busy} error={props.error} confirmLabel="Rename" confirmDisabled={!name.trim() || unchanged} onClose={props.onClose} />
    </form>
  );
};

const DeleteImpact = ({ impact, checking }: { impact: ProjectBranchDeleteImpact | null; checking: boolean }) => {
  if (checking) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-[var(--ec-muted)]">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Checking linked agent runs…
      </p>
    );
  }
  if (!impact || impact.linkedRuns.length === 0) {
    return null;
  }
  const count = impact.linkedRuns.length;
  return (
    <Notice tone="danger">
      <p>
        Also deletes {count} linked agent run{count === 1 ? "" : "s"} and their BuildWarden worktrees.
      </p>
      <ul className="max-h-24 space-y-0.5 overflow-auto">
        {impact.linkedRuns.slice(0, 5).map((run) => (
          <li key={run.id} className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[var(--ec-muted)]">{run.prompt.replace(/\s+/g, " ").trim() || "Untitled run"}</span>
            <span className="shrink-0 text-[10px] uppercase text-[var(--ec-faint)]">{run.status}</span>
          </li>
        ))}
        {count > 5 ? <li className="text-[var(--ec-faint)]">+{count - 5} more</li> : null}
      </ul>
    </Notice>
  );
};

const DeleteBranchForm = ({ branch, props }: { branch: ProjectGitBranchInfo; props: ProjectBranchDialogProps }) => {
  const [force, setForce] = useState(false);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const linkedImpact = props.deleteImpact?.branchName === branch.name ? props.deleteImpact : null;
  return (
    <form className="space-y-3" onSubmit={submitWith(() => props.onDelete(branch, { force, deleteRemote }))}>
      <DeleteImpact impact={linkedImpact} checking={props.deleteImpactChecking} />
      {branch.mergedIntoBase ? null : (
        <Notice tone="warning">
          <p>
            This branch is not merged into <Mono>{props.baseLabel}</Mono>. Git refuses to delete unmerged work unless you force it.
          </p>
        </Notice>
      )}
      <div className="space-y-2.5 rounded-md border border-[var(--ec-border)] p-2.5">
        <ToggleRow label="Force delete" description="Discard commits that are not merged anywhere." checked={force} onChange={setForce} />
        {branch.hasRemote ? (
          <ToggleRow
            label={`Also delete ${props.remoteName}/${branch.name}`}
            description="Removes the branch on the remote for everyone."
            checked={deleteRemote}
            onChange={setDeleteRemote}
          />
        ) : null}
      </div>
      <DialogFooter busy={props.busy} error={props.error} confirmLabel="Delete branch" confirmDisabled={props.deleteImpactChecking || !linkedImpact} danger onClose={props.onClose} />
    </form>
  );
};

const DeleteRemoteBranchForm = ({ branch, props }: { branch: ProjectGitBranchInfo; props: ProjectBranchDialogProps }) => (
  <form className="space-y-3" onSubmit={submitWith(() => props.onDeleteRemote(branch))}>
    <Notice tone="danger">
      <p>
        Deletes <Mono>{branch.name}</Mono> on <Mono>{props.remoteName}</Mono> for everyone who uses the repository. Open pull requests from this branch are closed.
      </p>
    </Notice>
    <DialogFooter busy={props.busy} error={props.error} confirmLabel="Delete remote branch" danger onClose={props.onClose} />
  </form>
);

const MERGE_MODE_HINTS: Record<MergeProjectBranchMode, string> = {
  default: "Fast-forwards when possible, otherwise creates a merge commit.",
  "no-ff": "Always records a merge commit, keeping the branch visible in history.",
  "ff-only": "Only moves the branch pointer; stops if a merge commit would be needed.",
};

const MergeBranchForm = ({ source, branch, props }: { source: string; branch: ProjectGitBranchInfo; props: ProjectBranchDialogProps }) => {
  const [mode, setMode] = useState<MergeProjectBranchMode>("default");
  return (
    <form className="space-y-3" onSubmit={submitWith(() => props.onMerge(source, mode))}>
      <SegmentedControl
        label="Merge strategy"
        value={mode}
        onChange={setMode}
        options={[
          { value: "default", label: "Default" },
          { value: "no-ff", label: "Merge commit" },
          { value: "ff-only", label: "Fast-forward only" },
        ]}
        className="w-fit"
      />
      <p className="text-[11px] text-[var(--ec-muted)]">{MERGE_MODE_HINTS[mode]}</p>
      {branch.baseAhead === 0 && branch.mergedIntoBase ? (
        <Notice>
          <p>This branch has no commits beyond {props.baseLabel}; the merge may be a no-op.</p>
        </Notice>
      ) : null}
      <UncommittedNotice count={props.changedFileCount} />
      <Notice>
        <p>If the merge hits conflicts, BuildWarden aborts it and nothing changes. Resolve conflicts in your editor or terminal.</p>
      </Notice>
      <DialogFooter busy={props.busy} error={props.error} confirmLabel="Merge" onClose={props.onClose} />
    </form>
  );
};

const RebaseBranchForm = ({ onto, props }: { onto: string; props: ProjectBranchDialogProps }) => (
  <form className="space-y-3" onSubmit={submitWith(() => props.onRebase(onto))}>
    <Notice tone="warning">
      <p>
        Rebasing rewrites the commits of <Mono>{props.currentBranch}</Mono>. If they were already pushed, the next push needs a force push from your terminal.
      </p>
    </Notice>
    <Notice>
      <p>Uncommitted changes are stashed and restored automatically. On conflicts the rebase is aborted and the branch stays as it was.</p>
    </Notice>
    <DialogFooter busy={props.busy} error={props.error} confirmLabel="Rebase" onClose={props.onClose} />
  </form>
);

const CleanupForm = ({ props }: { props: ProjectBranchDialogProps }) => {
  const [selectedNames, setSelected] = useState(() => new Set(props.cleanupCandidates.map((branch) => branch.name)));
  // A partly failed cleanup refreshes the candidates; branches it already deleted drop out of the selection.
  const selected = new Set(props.cleanupCandidates.filter((branch) => selectedNames.has(branch.name)).map((branch) => branch.name));
  const allSelected = selected.size === props.cleanupCandidates.length;
  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  return (
    <form className="space-y-3" onSubmit={submitWith(() => props.onCleanup([...selected]))}>
      <div className="overflow-hidden rounded-md border border-[var(--ec-border)]">
        <label className="flex cursor-pointer items-center gap-2 border-b border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2.5 py-1.5 text-[11px] text-[var(--ec-muted)]">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(props.cleanupCandidates.map((branch) => branch.name)))}
            className="accent-[var(--ec-accent)]"
          />
          {selected.size} of {props.cleanupCandidates.length} selected
        </label>
        <ul className="max-h-56 overflow-auto py-1">
          {props.cleanupCandidates.map((branch) => (
            <li key={branch.name}>
              <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1 text-xs hover:bg-[var(--ec-hover)]">
                <input type="checkbox" checked={selected.has(branch.name)} onChange={() => toggle(branch.name)} className="accent-[var(--ec-accent)]" />
                <span className="min-w-0 truncate font-mono">{branch.name}</span>
                {branch.hasRemote ? <span className="ml-auto shrink-0 text-[10px] text-[var(--ec-faint)]">also on {props.remoteName}</span> : null}
              </label>
            </li>
          ))}
        </ul>
      </div>
      <Notice>
        <p>Only local branches are deleted; remote branches stay. Branches used by agent runs or checked out in a worktree are not listed.</p>
      </Notice>
      <DialogFooter
        busy={props.busy}
        error={props.error}
        confirmLabel={`Delete ${String(selected.size)} branch${selected.size === 1 ? "" : "es"}`}
        confirmDisabled={selected.size === 0}
        danger
        onClose={props.onClose}
      />
    </form>
  );
};

const dialogHeading = (props: ProjectBranchDialogProps): { title: ReactNode; description?: ReactNode } => {
  const { state } = props;
  switch (state.kind) {
    case "create":
      return { title: "New branch" };
    case "rename":
      return { title: <>Rename <Mono>{state.branch.name}</Mono></> };
    case "delete":
      return { title: <>Delete <Mono>{state.branch.name}</Mono>?</>, description: "Deletes the local branch." };
    case "delete-remote":
      return { title: <>Delete <Mono>{props.remoteName}/{state.branch.name}</Mono>?</> };
    case "merge":
      return { title: <>Merge <Mono>{state.source}</Mono> into <Mono>{props.currentBranch}</Mono></> };
    case "rebase":
      return { title: <>Rebase <Mono>{props.currentBranch}</Mono> onto <Mono>{state.onto}</Mono></> };
    case "cleanup":
      return { title: "Clean up merged branches", description: <>Local branches already contained in <Mono>{props.baseLabel}</Mono>.</> };
  }
};

export const ProjectBranchDialog = (props: ProjectBranchDialogProps) => {
  const { state } = props;
  const heading = dialogHeading(props);
  const close = () => {
    if (!props.busy) props.onClose();
  };
  let body: ReactNode;
  switch (state.kind) {
    case "create":
      body = <CreateBranchForm initialSource={state.source} props={props} />;
      break;
    case "rename":
      body = <RenameBranchForm branch={state.branch} props={props} />;
      break;
    case "delete":
      body = <DeleteBranchForm branch={state.branch} props={props} />;
      break;
    case "delete-remote":
      body = <DeleteRemoteBranchForm branch={state.branch} props={props} />;
      break;
    case "merge":
      body = <MergeBranchForm source={state.source} branch={state.branch} props={props} />;
      break;
    case "rebase":
      body = <RebaseBranchForm onto={state.onto} props={props} />;
      break;
    case "cleanup":
      body = <CleanupForm props={props} />;
      break;
  }
  return (
    <ModalDialog
      title={heading.title}
      description={heading.description}
      onClose={close}
      fallbackFocusRef={props.fallbackFocusRef}
      className="w-[min(28rem,95vw)]"
    >
      {body}
    </ModalDialog>
  );
};
