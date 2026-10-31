import type { ProjectGitBranchInfo } from "@buildwarden/shared";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  Cloud,
  CloudCheck,
  CloudDownload,
  CloudUpload,
  Copy,
  Ellipsis,
  ExternalLink,
  Flag,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequestArrow,
  Laptop,
  ListRestart,
  Loader2,
  Pencil,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { AnchorDropdownPortal } from "../ui/dropdown-portal";
import { divergenceBarPercent, formatBranchAge, isStaleBranch } from "./project-branches-model";

export interface ProjectBranchRowActions {
  onCheckout: (branch: ProjectGitBranchInfo) => void;
  onCreateFrom: (branch: ProjectGitBranchInfo) => void;
  onMerge: (branch: ProjectGitBranchInfo) => void;
  onRebase: (branch: ProjectGitBranchInfo) => void;
  onPull: (branch: ProjectGitBranchInfo) => void;
  onPush: (branch: ProjectGitBranchInfo) => void;
  onOpenRemote: (branch: ProjectGitBranchInfo) => void;
  onCompare: (branch: ProjectGitBranchInfo) => void;
  onCopyName: (branch: ProjectGitBranchInfo) => void;
  onSetBase: (branch: ProjectGitBranchInfo) => void;
  onRename: (branch: ProjectGitBranchInfo) => void;
  onDelete: (branch: ProjectGitBranchInfo) => void;
  onDeleteRemote: (branch: ProjectGitBranchInfo) => void;
}

export interface ProjectBranchRowProps {
  branch: ProjectGitBranchInfo;
  currentBranch: string;
  remoteName: string;
  /** Forge name such as GitHub; `null` hides forge links. */
  forge: string | null;
  baseLabel: string;
  divergenceMax: number;
  now: number;
  /** Key of the action that is running anywhere on the page. */
  busyKey: string | null;
  disabled: boolean;
  actions: ProjectBranchRowActions;
}

const Chip = ({ className, title, children }: { className?: string; title?: string; children: ReactNode }) => (
  <span
    title={title}
    className={cn(
      "inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ec-border)] px-1.5 py-px text-[10px] leading-4 text-[var(--ec-muted)]",
      className,
    )}
  >
    {children}
  </span>
);

const BranchIcon = ({ branch }: { branch: ProjectGitBranchInfo }) => {
  if (branch.isCurrent) {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]">
        <Check className="size-3.5" aria-hidden />
      </span>
    );
  }
  let Icon: LucideIcon = GitBranch;
  if ((branch.linkedRunCount ?? 0) > 0) Icon = Bot;
  else if (!branch.hasLocal) Icon = Cloud;
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]">
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
};

/** Push/pull state against the upstream branch, the way Git status reports it. */
const TrackingState = ({ branch, remoteName }: { branch: ProjectGitBranchInfo; remoteName: string }) => {
  if (!branch.hasLocal) {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--ec-faint)]" title={`Only on ${remoteName}`}>
        <Cloud className="size-3" aria-hidden />
        remote
      </span>
    );
  }
  if (!branch.upstream) {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--ec-faint)]" title="Not pushed yet">
        <Laptop className="size-3" aria-hidden />
        local
      </span>
    );
  }
  if (branch.ahead === 0 && branch.behind === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--ec-faint)]" title={`In sync with ${branch.upstream}`}>
        <CloudCheck className="size-3" aria-hidden />
        synced
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" title={`${String(branch.ahead)} to push, ${String(branch.behind)} to pull (${branch.upstream})`}>
      {branch.ahead > 0 ? (
        <span className="inline-flex items-center text-[var(--ec-accent)]">
          <ArrowUp className="size-3" aria-hidden />
          {branch.ahead}
        </span>
      ) : null}
      {branch.behind > 0 ? (
        <span className="inline-flex items-center text-[var(--ec-warning)]">
          <ArrowDown className="size-3" aria-hidden />
          {branch.behind}
        </span>
      ) : null}
    </span>
  );
};

/** GitHub-style split bar: commits behind the base grow left, commits ahead grow right. */
const BaseDivergence = ({ branch, baseLabel, max }: { branch: ProjectGitBranchInfo; baseLabel: string; max: number }) => {
  if (branch.isBase || branch.baseAhead == null || branch.baseBehind == null) {
    return <span className="hidden w-32 shrink-0 lg:block" aria-hidden />;
  }
  const behind = branch.baseBehind;
  const ahead = branch.baseAhead;
  return (
    <span
      className="hidden w-32 shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-[var(--ec-faint)] lg:flex"
      title={`${String(behind)} behind, ${String(ahead)} ahead of ${baseLabel}`}
    >
      <span className="w-7 text-right">{behind}</span>
      <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--ec-muted-soft)]">
        <span className="flex flex-1 justify-end border-r border-[var(--ec-border-strong)]">
          <span className="h-full rounded-l-full bg-[var(--ec-faint)]" style={{ width: `${String(divergenceBarPercent(behind, max))}%` }} />
        </span>
        <span className="flex flex-1">
          <span className="h-full rounded-r-full bg-[var(--ec-accent)]" style={{ width: `${String(divergenceBarPercent(ahead, max))}%` }} />
        </span>
      </span>
      <span className="w-7">{ahead}</span>
    </span>
  );
};

const MenuItem = ({
  icon: Icon,
  label,
  onSelect,
  disabled = false,
  title,
  danger = false,
}: {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) => (
  <button
    type="button"
    role="menuitem"
    tabIndex={-1}
    disabled={disabled}
    title={title}
    className={cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs focus-visible:outline-none",
      disabled ? "cursor-not-allowed text-[var(--ec-faint)] opacity-60" : "hover:bg-[var(--ec-hover)] focus-visible:bg-[var(--ec-hover)]",
      !disabled && (danger ? "text-[var(--ec-danger)]" : "text-[var(--ec-text)]"),
    )}
    onClick={onSelect}
  >
    <Icon className="size-3.5 shrink-0" aria-hidden />
    <span className="min-w-0 truncate">{label}</span>
  </button>
);

const MenuSeparator = () => <div role="separator" className="my-1 h-px bg-[var(--ec-border)]" />;

const ENABLED_MENU_ITEMS = '[role="menuitem"]:not(:disabled)';
const MENU_NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** The menu portals to the end of the body, out of the Tab order, so opening it moves focus inside. */
const focusFirstMenuItem = (menu: HTMLDivElement | null) => {
  menu?.querySelector<HTMLButtonElement>(ENABLED_MENU_ITEMS)?.focus();
};

const BranchActionsMenu = ({
  branch,
  currentBranch,
  remoteName,
  forge,
  disabled,
  actions,
}: Pick<ProjectBranchRowProps, "branch" | "currentBranch" | "remoteName" | "forge" | "disabled" | "actions">) => {
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const closeAndFocus = () => {
    close();
    triggerRef.current?.focus();
  };
  // Focus returns to the trigger before the action runs, so a dialog it opens restores focus there.
  const select = (action: (branch: ProjectGitBranchInfo) => void) => () => {
    closeAndFocus();
    action(branch);
  };
  const hasCurrent = Boolean(currentBranch);
  const notCurrent = !branch.isCurrent && hasCurrent;
  const checkedOutElsewhere = Boolean(branch.worktreePath);
  return (
    <div ref={anchorRef} className="shrink-0">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={`Actions for ${branch.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Ellipsis className="size-4" aria-hidden />
      </Button>
      <AnchorDropdownPortal open={open} anchorRef={anchorRef} onClose={close} align="end" widthPx={232} className="glass-popover p-1">
        <div
          ref={focusFirstMenuItem}
          role="menu"
          aria-label={`Actions for ${branch.name}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeAndFocus();
              return;
            }
            if (event.key === "Tab") {
              closeAndFocus();
              return;
            }
            if (!MENU_NAVIGATION_KEYS.has(event.key)) return;
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(ENABLED_MENU_ITEMS)];
            const index = items.findIndex((item) => item === document.activeElement);
            let next = index + (event.key === "ArrowDown" ? 1 : -1);
            if (event.key === "Home" || next >= items.length) next = 0;
            if (event.key === "End" || next < 0) next = items.length - 1;
            items[next]?.focus();
          }}
        >
          <MenuItem
            icon={GitBranchPlus}
            label="New branch from here…"
            disabled={disabled}
            onSelect={select(actions.onCreateFrom)}
          />
          {!branch.isCurrent ? (
            <>
              <MenuItem
                icon={GitMerge}
                label={hasCurrent ? `Merge into ${currentBranch}…` : "Merge into current branch…"}
                disabled={disabled || !notCurrent}
                title={hasCurrent ? undefined : "Check out a branch first."}
                onSelect={select(actions.onMerge)}
              />
              <MenuItem
                icon={ListRestart}
                label={hasCurrent ? `Rebase ${currentBranch} onto this…` : "Rebase current branch onto this…"}
                disabled={disabled || !notCurrent}
                title={hasCurrent ? undefined : "Check out a branch first."}
                onSelect={select(actions.onRebase)}
              />
            </>
          ) : null}
          {branch.hasLocal ? (
            <>
              <MenuSeparator />
              <MenuItem
                icon={CloudDownload}
                label={branch.isCurrent ? "Pull" : "Pull (fast-forward)"}
                disabled={disabled || !branch.upstream || (checkedOutElsewhere && !branch.isCurrent)}
                title={branch.upstream ? undefined : "This branch has no upstream yet."}
                onSelect={select(actions.onPull)}
              />
              <MenuItem
                icon={CloudUpload}
                label={branch.upstream ? "Push" : `Publish to ${remoteName}`}
                disabled={disabled}
                onSelect={select(actions.onPush)}
              />
            </>
          ) : null}
          <MenuSeparator />
          {forge && branch.hasRemote && !branch.isBase ? (
            <MenuItem icon={GitPullRequestArrow} label={`Compare / open PR on ${forge}`} onSelect={select(actions.onCompare)} />
          ) : null}
          {forge && branch.hasRemote ? <MenuItem icon={ExternalLink} label={`Open on ${forge}`} onSelect={select(actions.onOpenRemote)} /> : null}
          <MenuItem icon={Copy} label="Copy branch name" onSelect={select(actions.onCopyName)} />
          {!branch.isBase ? (
            <MenuItem icon={Flag} label="Use as project base branch" disabled={disabled} onSelect={select(actions.onSetBase)} />
          ) : null}
          {!branch.isBase ? (
            <>
              <MenuSeparator />
              {branch.hasLocal ? (
                <MenuItem icon={Pencil} label="Rename…" disabled={disabled} onSelect={select(actions.onRename)} />
              ) : null}
              {branch.hasLocal ? (
                <MenuItem
                  icon={Trash2}
                  label="Delete…"
                  danger
                  disabled={disabled || branch.isCurrent || checkedOutElsewhere}
                  title={branch.isCurrent ? "Check out another branch first." : checkedOutElsewhere ? "Checked out in a worktree." : undefined}
                  onSelect={select(actions.onDelete)}
                />
              ) : (
                <MenuItem icon={Trash2} label={`Delete on ${remoteName}…`} danger disabled={disabled} onSelect={select(actions.onDeleteRemote)} />
              )}
            </>
          ) : null}
        </div>
      </AnchorDropdownPortal>
    </div>
  );
};

export const ProjectBranchRow = ({
  branch,
  currentBranch,
  remoteName,
  forge,
  baseLabel,
  divergenceMax,
  now,
  busyKey,
  disabled,
  actions,
}: ProjectBranchRowProps) => {
  const age = formatBranchAge(branch.updatedAt, now);
  const runCount = branch.linkedRunCount ?? 0;
  const checkoutBusy = busyKey === `checkout:${branch.name}`;
  const rowBusy = busyKey?.endsWith(`:${branch.name}`) ?? false;
  const checkedOutElsewhere = Boolean(branch.worktreePath);
  return (
    <div
      className={cn(
        "group flex min-w-0 items-center gap-3 px-3 py-2 transition-colors hover:bg-[var(--ec-hover)]",
        branch.isCurrent && "shadow-[inset_2px_0_0_var(--ec-success)]",
      )}
      data-branch={branch.name}
    >
      <BranchIcon branch={branch} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[13px] font-medium text-[var(--ec-text)]" title={branch.name}>
            {branch.name}
          </span>
          {branch.isCurrent ? <Chip className="border-[var(--ec-success-ring)] text-[var(--ec-success)]">current</Chip> : null}
          {branch.isBase ? <Chip className="border-[var(--ec-accent-ring)] text-[var(--ec-accent)]">base</Chip> : null}
          {branch.mergedIntoBase ? (
            <Chip className="border-[var(--ec-secondary-ring)] text-[var(--ec-secondary)]" title={`Fully merged into ${baseLabel}`}>
              <GitMerge className="size-2.5" aria-hidden />
              merged
            </Chip>
          ) : null}
          {isStaleBranch(branch, now) ? <Chip title="No commits for 90 days">stale</Chip> : null}
          {runCount > 0 ? (
            <Chip title={`Used by ${String(runCount)} agent run${runCount === 1 ? "" : "s"}`}>
              <Bot className="size-2.5" aria-hidden />
              {runCount} run{runCount === 1 ? "" : "s"}
            </Chip>
          ) : null}
          {checkedOutElsewhere ? (
            <Chip title={`Checked out in ${branch.worktreePath ?? ""}`}>
              <FolderGit2 className="size-2.5" aria-hidden />
              worktree
            </Chip>
          ) : null}
        </div>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--ec-muted)]">
          <span className="min-w-0 truncate">{branch.subject || "No commit message"}</span>
          {branch.authorName ? <span className="shrink-0 text-[var(--ec-faint)]">· {branch.authorName}</span> : null}
          {age ? <span className="shrink-0 text-[var(--ec-faint)]">· {age}</span> : null}
          {branch.commitSha ? <span className="hidden shrink-0 font-mono text-[10px] text-[var(--ec-faint)] sm:inline">{branch.commitSha}</span> : null}
        </p>
      </div>
      <span className="hidden w-20 shrink-0 justify-end text-[11px] md:flex">
        <TrackingState branch={branch} remoteName={remoteName} />
      </span>
      <BaseDivergence branch={branch} baseLabel={baseLabel} max={divergenceMax} />
      <div className="flex w-[5.5rem] shrink-0 justify-end">
        {rowBusy && !checkoutBusy ? (
          <Loader2 className="size-3.5 animate-spin text-[var(--ec-muted)]" aria-label="Working" />
        ) : !branch.isCurrent ? (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            className={cn(
              "h-7 text-[11px] transition-opacity",
              !checkoutBusy && "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
            )}
            disabled={disabled || checkedOutElsewhere}
            title={checkedOutElsewhere ? `Checked out in ${branch.worktreePath ?? "another worktree"}` : undefined}
            onClick={() => actions.onCheckout(branch)}
          >
            {checkoutBusy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
            {branch.hasLocal ? "Checkout" : "Track"}
          </Button>
        ) : null}
      </div>
      <BranchActionsMenu
        branch={branch}
        currentBranch={currentBranch}
        remoteName={remoteName}
        forge={forge}
        disabled={disabled}
        actions={actions}
      />
    </div>
  );
};
