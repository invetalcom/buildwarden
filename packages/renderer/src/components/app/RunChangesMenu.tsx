import type { Dispatch, RefObject, SetStateAction } from "react";
import type { RunDetail, RunListItem } from "@buildwarden/shared";
import { ChevronDown, GitBranch, Loader2 } from "lucide-react";
import { deriveRunChangeActionAvailability, resolveRunWorkspaceChangeState, type RunWorkspaceChangeState } from "./run-change-actions";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";

const safeParseMetadata = (value: string) => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const changeActionTitles = (state: RunWorkspaceChangeState, canCreateLocalBranch: boolean, checking: boolean) => {
  if (state === "unknown") {
    const message = checking ? "Checking workspace changes." : "Workspace changes are unavailable.";
    return { localBranchTitle: message, publishRequestTitle: message, publishBranchTitle: message };
  }
  return {
    localBranchTitle: canCreateLocalBranch ? undefined : "Create changes before creating a local branch.",
    publishRequestTitle: state === "dirty" ? "Open changes will be committed when the merge request or pull request is created." : undefined,
    publishBranchTitle: state === "dirty" ? "Create a commit before publishing the branch." : undefined,
  };
};

export interface RunChangesMenuProps {
  run: RunListItem;
  runDetail: RunDetail | null;
  busy: boolean;
  publishMenuOpen: boolean;
  setPublishMenuOpen: Dispatch<SetStateAction<boolean>>;
  publishMenuAnchorRef: RefObject<HTMLDivElement | null>;
  onCommitRun: (run: RunListItem) => void | Promise<void>;
  onRequestDiffSummary?: (runId: string) => void | Promise<void>;
  onOpenPublishDialog: (run: RunListItem) => void | Promise<void>;
  onOpenBranchPublishDialog: (run: RunListItem, mode: "publish" | "local") => void;
  /** Icon-only trigger, for the one-line run header. */
  compact?: boolean;
}

export const RunChangesMenu = ({
  run,
  runDetail,
  busy,
  publishMenuOpen,
  setPublishMenuOpen,
  publishMenuAnchorRef,
  onCommitRun,
  onRequestDiffSummary,
  onOpenPublishDialog,
  onOpenBranchPublishDialog,
  compact = false,
}: RunChangesMenuProps) => {
  const hasCommit = runDetail?.steps.some((step) => Boolean(safeParseMetadata(step.metadataJson).commitHash)) ?? false;
  const changeState = resolveRunWorkspaceChangeState(runDetail);
  const { canCommit, canPublishRequest, canPublishBranch, canCreateLocalBranch } = deriveRunChangeActionAvailability({
    changeState,
    hasCommit,
    canManageChanges: true,
  });
  const changeStateMessage = runDetail?.diffSummaryPending === true
    ? "Checking workspace changes."
    : "Workspace changes are unavailable.";
  const { localBranchTitle, publishRequestTitle, publishBranchTitle } = changeActionTitles(
    changeState, canCreateLocalBranch, runDetail?.diffSummaryPending === true,
  );
  return (
    <div ref={publishMenuAnchorRef} className="relative shrink-0">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        className={compact ? "size-8 p-0" : "h-8 shrink-0 gap-1.5 px-2.5 text-xs"}
        aria-haspopup="menu"
        aria-label={compact ? "Changes" : undefined}
        aria-expanded={publishMenuOpen}
        title="Commit, publish branch, or open a merge request"
        onClick={() => {
          const opening = !publishMenuOpen;
          setPublishMenuOpen(opening);
          if (opening && changeState === "unknown" && runDetail?.diffSummaryPending !== true) {
            void onRequestDiffSummary?.(run.id);
          }
        }}
      >
        {compact ? <GitBranch className="size-4 shrink-0" aria-hidden /> : <>
          <GitBranch className="size-3.5 shrink-0" aria-hidden />
          Changes
          <ChevronDown className={cn("size-3 shrink-0 opacity-70 transition", publishMenuOpen && "rotate-180")} aria-hidden />
        </>}
      </Button>
      <AnchorDropdownPortal
        open={publishMenuOpen}
        anchorRef={publishMenuAnchorRef}
        onClose={() => setPublishMenuOpen(false)}
        align="end"
        widthPx={192}
        className="glass-popover p-1"
      >
        {canCommit ? (
          <button
            type="button"
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-[var(--ec-text)] hover:bg-[var(--ec-hover)]"
            onClick={() => {
              setPublishMenuOpen(false);
              void onCommitRun(run);
            }}
          >
            Create commit
          </button>
        ) : null}
        {changeState === "unknown" ? (
          <button
            type="button"
            className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--ec-faint)]"
            disabled
            title={changeStateMessage}
          >
            {runDetail?.diffSummaryPending === true ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {runDetail?.diffSummaryPending === true ? "Checking changes" : "Changes unavailable"}
          </button>
        ) : null}
        <button
          type="button"
          className={cn(
            "block w-full rounded-lg px-3 py-2 text-left text-sm",
            canCreateLocalBranch ? "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]" : "cursor-not-allowed text-[var(--ec-faint)]",
          )}
          disabled={!canCreateLocalBranch}
          title={localBranchTitle}
          onClick={() => {
            if (!canCreateLocalBranch) return;
            setPublishMenuOpen(false);
            onOpenBranchPublishDialog(run, "local");
          }}
        >
          Create local branch
        </button>
        <button
          type="button"
          className={cn(
            "block w-full rounded-lg px-3 py-2 text-left text-sm",
            canPublishRequest ? "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]" : "cursor-not-allowed text-[var(--ec-faint)]",
          )}
          disabled={!canPublishRequest}
          title={publishRequestTitle}
          onClick={() => {
            if (!canPublishRequest) return;
            setPublishMenuOpen(false);
            void onOpenPublishDialog(run);
          }}
        >
          Create MR / PR
        </button>
        <button
          type="button"
          className={cn(
            "block w-full rounded-lg px-3 py-2 text-left text-sm",
            canPublishBranch ? "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]" : "cursor-not-allowed text-[var(--ec-faint)]",
          )}
          disabled={!canPublishBranch}
          title={publishBranchTitle}
          onClick={() => {
            if (!canPublishBranch) return;
            setPublishMenuOpen(false);
            onOpenBranchPublishDialog(run, "publish");
          }}
        >
          Publish branch
        </button>
      </AnchorDropdownPortal>
    </div>
  );
};
