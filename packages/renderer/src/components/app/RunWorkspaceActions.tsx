import { useRef, useState } from "react";
import { IDE_KIND_LABELS, type RunDetail, type RunListItem, type SupportedIdeKind } from "@buildwarden/shared";
import { Ellipsis, FolderOpen, GitBranch, Loader2, Trash2, X } from "lucide-react";
import { Button } from "../ui/button";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { RunForgeRefreshButton } from "./RunForgeRefreshButton";
import { CopyDeepLinkButton } from "./CopyDeepLinkButton";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import { IdeBrandIcon } from "./ide-brand-icons";
import { cn } from "../../lib/cn";
import { RunHeaderMenu } from "./RunHeaderMenu";

export interface RunWorkspaceActionsProps {
  run: RunListItem;
  runDetail: RunDetail | null;
  configuredIdeKinds: SupportedIdeKind[];
  canContinueRun: boolean;
  busy: boolean;
  pendingDelete: boolean;
  focused?: boolean;
  splitView?: boolean;
  onOpenInIde: (runDetail: RunDetail, ideKind: SupportedIdeKind) => void;
  onOpenContinueRunDialog: (run: RunListItem) => void;
  onOpenFileManager: (runDetail: RunDetail) => void;
  onDeleteRun: (run: RunListItem) => void | Promise<void>;
  onClosePane?: () => void;
}

const menuItemClass = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-[var(--ec-text)] transition-colors hover:bg-[var(--ec-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ec-ring)] disabled:pointer-events-none disabled:opacity-50";

export const RunWorkspaceActions = ({
  run, runDetail, configuredIdeKinds, canContinueRun, busy, pendingDelete,
  focused = true, splitView = false,
  onOpenInIde, onOpenContinueRunDialog, onOpenFileManager, onDeleteRun, onClosePane,
}: RunWorkspaceActionsProps) => {
  const buildwarden = useBuildWardenClient();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const isGitRun = run.workspaceVcs === "git";
  const workspaceAvailable = runDetail && runDetail.worktreeUnavailable !== true;
  const close = () => {
    setOpen(false);
    anchorRef.current?.querySelector("button")?.focus();
  };

  return <>
    {focused ? (
      <div ref={anchorRef} className="relative shrink-0">
        <Button variant="ghost" size="icon" aria-label="More run actions" title="More run actions"
          aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((current) => !current)}>
          <Ellipsis className="size-4" aria-hidden />
        </Button>
        <AnchorDropdownPortal open={open} anchorRef={anchorRef} onClose={() => setOpen(false)}
          align="end" widthPx={248} className="glass-popover overflow-y-auto py-1">
          <RunHeaderMenu label="Run actions" onClose={close}>
            <CopyDeepLinkButton menu kind="run" id={run.id} className={menuItemClass} />
            {isGitRun && buildwarden.capabilities.prReview ? <RunForgeRefreshButton key={run.id} runId={run.id} menu /> : null}
            {workspaceAvailable && (buildwarden.capabilities.fileManager || (buildwarden.capabilities.ideIntegration && configuredIdeKinds.length > 0)) ? (
              <div role="group" aria-label="Open workspace" className="my-1 border-y border-[var(--ec-border)] py-1">
                {buildwarden.capabilities.ideIntegration ? configuredIdeKinds.map((kind) => (
                  <button key={kind} type="button" role="menuitem" className={menuItemClass}
                    onClick={() => { close(); onOpenInIde(runDetail, kind); }}>
                    <IdeBrandIcon kind={kind} className="size-4 shrink-0" />
                    Open in {IDE_KIND_LABELS[kind]}
                  </button>
                )) : null}
                {buildwarden.capabilities.fileManager ? (
                  <button type="button" role="menuitem" className={menuItemClass}
                    onClick={() => { close(); onOpenFileManager(runDetail); }}>
                    <FolderOpen className="size-4 shrink-0" aria-hidden />Open in file explorer
                  </button>
                ) : null}
              </div>
            ) : null}
            {buildwarden.capabilities.runMutations && canContinueRun ? (
              <button type="button" role="menuitem" className={menuItemClass} disabled={busy}
                title={isGitRun ? "Start a fresh worktree and branch from this run's current state" : "Start a fresh copied workspace from this run's current state"}
                onClick={() => { close(); onOpenContinueRunDialog(run); }}>
                <GitBranch className="size-4 shrink-0" aria-hidden />Continue as new run
              </button>
            ) : null}
            {buildwarden.capabilities.runMutations ? (
              <div className="mt-1 border-t border-[var(--ec-border)] pt-1">
                <button type="button" role="menuitem" className={cn(menuItemClass, "text-[var(--ec-danger)]")}
                  disabled={pendingDelete} onClick={() => { close(); void onDeleteRun(run); }}>
                  {pendingDelete ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : <Trash2 className="size-4 shrink-0" aria-hidden />}
                  Delete run
                </button>
              </div>
            ) : null}
          </RunHeaderMenu>
        </AnchorDropdownPortal>
      </div>
    ) : null}
    {splitView && onClosePane ? (
      <Button data-run-pane-ignore-focus="true" variant="ghost" size="icon" onClick={onClosePane} title="Close pane" aria-label="Close pane">
        <X className="size-4" aria-hidden />
      </Button>
    ) : null}
  </>;
};
