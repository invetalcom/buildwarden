import { RunWorkspaceSummary } from "./RunWorkspaceSummary";
import { RunWorkspaceActions, type RunWorkspaceActionsProps } from "./RunWorkspaceActions";
import { RunDensityMenu, type RunDensityMenuProps } from "./RunDensityMenu";
import { RunPanelsMenu, type RunPanelsMenuProps } from "./RunPanelsMenu";
import { RunChangesMenu, type RunChangesMenuProps } from "./RunChangesMenu";
import {
  canReviewRunChanges,
  type RunTokenUsage,
} from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { Card } from "../ui/card";
import { useBuildWardenClient } from "../../lib/buildwarden-client";

export type { RunPanelToggleItem } from "./RunPanelsMenu";

interface RunDetailHeaderProps extends RunDensityMenuProps, RunPanelsMenuProps, RunChangesMenuProps, RunWorkspaceActionsProps {
  tokenUsage: Partial<RunTokenUsage> | null;
  paneLabel?: string;
  onFocusSubagent?: (subagentId: string) => void;
}

export const RunPaneDropPreviewOverlay = ({ paneId, mode }: { paneId: string; mode: "tile" | "replace" }) => (
  <div className="pointer-events-none absolute inset-0 z-50 rounded-lg p-2">
    <div
      className="relative h-full min-h-24 overflow-hidden rounded-lg border-2 border-[var(--ec-accent)] shadow-[inset_0_0_0_1px_var(--ec-accent-ring),0_0_28px_var(--ec-accent-soft)]"
      style={{ background: "color-mix(in srgb, var(--ec-accent) 16%, transparent)" }}
    >
      <div
        className="absolute inset-3 rounded-md border border-[var(--ec-accent-ring)]"
        style={{ background: "color-mix(in srgb, var(--ec-accent) 10%, transparent)" }}
      />
      <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-[var(--ec-accent-ring)] bg-[var(--ec-bg-elevated)] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--ec-accent)] shadow-xl shadow-black/20">
        {mode === "tile" ? `Tile ${paneId}` : `Replace ${paneId}`}
      </div>
    </div>
  </div>
);

export const RunDetailHeader = ({
  run,
  runDetail,
  tokenUsage,
  busy,
  pendingDelete,
  configuredIdeKinds,
  canContinueRun,
  focused = true,
  splitView = false,
  paneLabel,
  runTimelineDensity,
  onRunTimelineDensityChange,
  runDensityMenuOpen,
  setRunDensityMenuOpen,
  runDensityMenuAnchorRef,
  runPanelToggleItems,
  runWorkspaceVisiblePanelCount,
  runPanelsMenuOpen,
  setRunPanelsMenuOpen,
  runPanelsMenuAnchorRef,
  publishMenuOpen,
  setPublishMenuOpen,
  publishMenuAnchorRef,
  onCommitRun,
  onRequestDiffSummary,
  onOpenPublishDialog,
  onOpenBranchPublishDialog,
  onOpenInIde,
  onOpenFileManager,
  onOpenContinueRunDialog,
  onDeleteRun,
  onClosePane,
  onFocusSubagent,
}: RunDetailHeaderProps) => {
  const buildwarden = useBuildWardenClient();
  const stackedHeader = splitView && focused;
  const canManageChanges = buildwarden.capabilities.gitMutations && run.workspaceVcs === "git" && canReviewRunChanges(run) && runDetail?.worktreeUnavailable !== true;

  return (
    <Card className={cn("relative z-30 shrink-0", splitView ? "px-3 py-2" : "px-4 py-3")}>
      <div className={cn("flex gap-3", stackedHeader ? "flex-col items-stretch" : "items-center justify-between")}>
        <RunWorkspaceSummary
          run={run}
          runDetail={runDetail}
          tokenUsage={tokenUsage}
          stackedHeader={stackedHeader}
          splitView={splitView}
          focused={focused}
          paneLabel={paneLabel}
          onFocusSubagent={onFocusSubagent}
        />
        <div
          className={cn(
            "flex max-w-full shrink-0 items-center gap-2",
            stackedHeader ? "w-full flex-wrap justify-end overflow-visible sm:gap-2" : "flex-nowrap overflow-x-auto sm:gap-3",
          )}
        >
          {focused && runDetail?.run ? (
            <RunDensityMenu
              runTimelineDensity={runTimelineDensity}
              onRunTimelineDensityChange={onRunTimelineDensityChange}
              runDensityMenuOpen={runDensityMenuOpen}
              setRunDensityMenuOpen={setRunDensityMenuOpen}
              runDensityMenuAnchorRef={runDensityMenuAnchorRef}
            />
          ) : null}
          {focused && runDetail?.run ? (
            <RunPanelsMenu
              runPanelToggleItems={runPanelToggleItems}
              runWorkspaceVisiblePanelCount={runWorkspaceVisiblePanelCount}
              runPanelsMenuOpen={runPanelsMenuOpen}
              setRunPanelsMenuOpen={setRunPanelsMenuOpen}
              runPanelsMenuAnchorRef={runPanelsMenuAnchorRef}
            />
          ) : null}
          {focused && canManageChanges ? (
            <RunChangesMenu
              run={run}
              runDetail={runDetail}
              busy={busy}
              publishMenuOpen={publishMenuOpen}
              setPublishMenuOpen={setPublishMenuOpen}
              publishMenuAnchorRef={publishMenuAnchorRef}
              onCommitRun={onCommitRun}
              onRequestDiffSummary={onRequestDiffSummary}
              onOpenPublishDialog={onOpenPublishDialog}
              onOpenBranchPublishDialog={onOpenBranchPublishDialog}
            />
          ) : null}
          <RunWorkspaceActions
            run={run}
            runDetail={runDetail}
            configuredIdeKinds={configuredIdeKinds}
            canContinueRun={canContinueRun}
            busy={busy}
            pendingDelete={pendingDelete}
            focused={focused}
            splitView={splitView}
            onOpenInIde={onOpenInIde}
            onOpenContinueRunDialog={onOpenContinueRunDialog}
            onOpenFileManager={onOpenFileManager}
            onDeleteRun={onDeleteRun}
            onClosePane={onClosePane}
          />
        </div>
      </div>
    </Card>
  );
};
