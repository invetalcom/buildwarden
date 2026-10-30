import type { RunDetail, RunRecord, SupportedIdeKind } from "@buildwarden/shared";
import { FolderOpen, GitBranch, Loader2, Trash2, X } from "lucide-react";
import { Button } from "../ui/button";
import { OpenInIdeControl } from "./open-in-ide-control";
import { useBuildWardenClient } from "../../lib/buildwarden-client";

export interface RunWorkspaceActionsProps {
  run: RunRecord;
  runDetail: RunDetail | null;
  configuredIdeKinds: SupportedIdeKind[];
  canContinueRun: boolean;
  busy: boolean;
  pendingDelete: boolean;
  focused?: boolean;
  splitView?: boolean;
  onOpenInIde: (runDetail: RunDetail, ideKind: SupportedIdeKind) => void;
  onOpenContinueRunDialog: (run: RunRecord) => void;
  onOpenFileManager: (runDetail: RunDetail) => void;
  onDeleteRun: (run: RunRecord) => void | Promise<void>;
  onClosePane?: () => void;
}

export const RunWorkspaceActions = ({
  run,
  runDetail,
  configuredIdeKinds,
  canContinueRun,
  busy,
  pendingDelete,
  focused = true,
  splitView = false,
  onOpenInIde,
  onOpenContinueRunDialog,
  onOpenFileManager,
  onDeleteRun,
  onClosePane,
}: RunWorkspaceActionsProps) => {
  const buildwarden = useBuildWardenClient();
  const isGitRun = run.workspaceVcs === "git";
  return <>
    {focused && buildwarden.capabilities.ideIntegration && runDetail && runDetail.worktreeUnavailable !== true && configuredIdeKinds.length > 0 ? (
      <OpenInIdeControl
        compact
        configuredIdeKinds={configuredIdeKinds}
        onOpen={(ideKind) => onOpenInIde(runDetail, ideKind)}
      />
    ) : null}
    {focused && buildwarden.capabilities.runMutations && canContinueRun ? (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy}
        className="h-8 shrink-0 border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-2 text-xs text-[var(--ec-accent)] hover:bg-[var(--ec-hover)]"
        title={
          isGitRun
            ? "Continue as new run. Start a fresh worktree and branch from this run's current state."
            : "Continue as new run. Start a fresh copied workspace from this run's current state."
        }
        aria-label="Continue as new run"
        onClick={() => onOpenContinueRunDialog(run)}
      >
        <GitBranch className="h-4 w-4 shrink-0" aria-hidden />
        <span className="sr-only">Continue as new run</span>
      </Button>
    ) : null}
    {focused && buildwarden.capabilities.fileManager && runDetail && runDetail.worktreeUnavailable !== true ? (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-8 shrink-0 border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-2 text-xs text-[var(--ec-accent)] hover:bg-[var(--ec-hover)]"
        title="Open current workspace in file explorer"
        aria-label="Open current workspace in file explorer"
        onClick={() => onOpenFileManager(runDetail)}
      >
        <FolderOpen className="h-4 w-4 shrink-0" />
        <span className="sr-only">Open in file explorer</span>
      </Button>
    ) : null}
    {focused && buildwarden.capabilities.runMutations ? (
      <Button
        variant="secondary"
        size="sm"
        className="border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 text-[var(--ec-danger)] hover:border-[var(--ec-danger-ring)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-danger-strong)]"
        disabled={pendingDelete}
        onClick={() => void onDeleteRun(run)}
        title="Delete run"
        aria-label="Delete run"
      >
        {pendingDelete ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
        )}
      </Button>
    ) : null}
    {splitView && onClosePane ? (
      <Button
        data-run-pane-ignore-focus="true"
        variant="secondary"
        size="sm"
        className="h-8 shrink-0 border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 text-[var(--ec-muted)] hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
        onClick={onClosePane}
        title="Close pane"
        aria-label="Close pane"
      >
        <X className="h-4 w-4 shrink-0" aria-hidden />
      </Button>
    ) : null}
  </>;
};
