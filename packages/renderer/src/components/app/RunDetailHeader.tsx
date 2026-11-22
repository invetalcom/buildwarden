import { RunWorkspaceSummary } from "./RunWorkspaceSummary";
import { RunWorkspaceActions, type RunWorkspaceActionsProps } from "./RunWorkspaceActions";
import { RunPanelsMenu, type RunPanelsMenuProps } from "./RunPanelsMenu";
import { RunChangesMenu, type RunChangesMenuProps } from "./RunChangesMenu";
import {
  canReviewRunChanges,
  type DesignRunHeaderItem,
  type DesignRunHeaderStyle,
  type RunTokenUsage,
} from "@buildwarden/shared";
import { resolveRunDisplayStatus, runThemeState } from "./run-display-status";
import { cn } from "../../lib/cn";
import { ForgeIssueBackLink } from "../../lib/forge-issue-links-context";
import { PanelRight } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { useBuildWardenClient } from "../../lib/buildwarden-client";

export type { RunPanelToggleItem } from "./RunPanelsMenu";

interface RunDetailHeaderProps extends RunPanelsMenuProps, RunChangesMenuProps, RunWorkspaceActionsProps {
  tokenUsage: Partial<RunTokenUsage> | null;
  paneLabel?: string;
  onFocusSubagent?: (subagentId: string) => void;
  /** Hides every side panel of the run, or brings back the ones that were open. */
  onToggleSidePanels?: () => void;
  sidePanelsOpen?: boolean;
  /** False where the window title bar already carries the toggle. */
  showSidePanelToggle?: boolean;
  /** Look of the header, from the theme: a colored chip with facts, or one quiet line. */
  headerStyle?: DesignRunHeaderStyle;
  /** What the left side shows, in order. Undefined uses the default list. */
  headerItems?: readonly DesignRunHeaderItem[];
  /** Display name of a model, for the model fact. */
  modelLabelFor?: (modelId: string) => string | undefined;
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
      <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-[var(--ec-accent-ring)] bg-[var(--ec-bg-elevated)] px-3 py-1 text-[11px] font-semibold text-[var(--ec-accent)] shadow-xl shadow-black/20">
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
  onToggleSidePanels,
  sidePanelsOpen = false,
  showSidePanelToggle = false,
  headerStyle = "chips",
  headerItems,
  modelLabelFor,
}: RunDetailHeaderProps) => {
  const buildwarden = useBuildWardenClient();
  const stackedHeader = splitView && focused;
  const canManageChanges = buildwarden.capabilities.gitMutations && run.workspaceVcs === "git" && canReviewRunChanges(run) && runDetail?.worktreeUnavailable !== true;

  return (
    <Card
      data-ui="run-header"
      data-style={headerStyle}
      data-state={runThemeState(resolveRunDisplayStatus(run.status, run.orchestrationStatus), run.pendingUserInputRequest === true || run.pendingUserInputRequest === 1)}
      className={cn("relative z-30 shrink-0 bg-transparent", splitView ? "px-2 py-1" : "px-1.5 py-0.5")}
    >
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
          headerStyle={headerStyle}
          headerItems={headerItems}
          modelLabel={modelLabelFor?.(run.modelId)}
        />
        <div
          className={cn(
            "flex max-w-full shrink-0 items-center gap-1.5",
            stackedHeader ? "w-full flex-wrap justify-end" : "flex-nowrap",
          )}
        >
          <ForgeIssueBackLink kind="run" targetId={run.id} />
          <div data-ui="run-actions" className="flex shrink-0 items-center gap-0.5">
          {focused && runDetail?.run ? (
            <RunPanelsMenu
              compact={headerStyle === "line"}
              runTimelineDensity={runTimelineDensity}
              onRunTimelineDensityChange={onRunTimelineDensityChange}
              runPanelToggleItems={runPanelToggleItems}
              runWorkspaceVisiblePanelCount={runWorkspaceVisiblePanelCount}
              runPanelsMenuOpen={runPanelsMenuOpen}
              setRunPanelsMenuOpen={setRunPanelsMenuOpen}
              runPanelsMenuAnchorRef={runPanelsMenuAnchorRef}
            />
          ) : null}
          {focused && canManageChanges ? (
            <RunChangesMenu
              compact={headerStyle === "line"}
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
          {focused && showSidePanelToggle && onToggleSidePanels && runDetail?.run ? (
            <Button variant="ghost" size="icon" aria-pressed={sidePanelsOpen} onClick={onToggleSidePanels}
              aria-label={sidePanelsOpen ? "Hide side panels" : "Show side panels"} title={sidePanelsOpen ? "Hide side panels" : "Show side panels"}>
              <PanelRight className="size-4" aria-hidden />
            </Button>
          ) : null}
          <RunWorkspaceActions
            key={run.id}
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
      </div>
    </Card>
  );
};
