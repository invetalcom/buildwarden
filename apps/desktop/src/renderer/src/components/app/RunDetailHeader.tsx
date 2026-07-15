import { useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  RUN_TIMELINE_DENSITIES,
  type RunDetail,
  type RunRecord,
  type RunTimelineDensity,
  type RunTokenUsage,
  type RunWorkspacePanelId,
  type SupportedIdeKind,
} from "@buildwarden/shared";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  GitBranch,
  Loader2,
  SlidersHorizontal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import { OpenInIdeControl } from "./open-in-ide-control";
import { deriveLatestRunPlanProgress } from "../../lib/run-plan-progress";
import { deriveRunSubagents } from "./run-activity-model";
import { RunPlanProgressPill } from "./RunPlanProgressPill";
import { RunTokenBadge } from "./RunTokenBadge";
import { useBuildWardenClient } from "../../lib/buildwarden-client";

const RUN_TIMELINE_DENSITY_LABELS: Record<RunTimelineDensity, string> = {
  compact: "Compact",
  comfortable: "Comfort",
  detailed: "Detailed",
};

const safeParseMetadata = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export interface RunPanelToggleItem {
  key: RunWorkspacePanelId;
  label: string;
  icon: LucideIcon;
  active: boolean;
  disabled: boolean;
  subtitle: string;
  onClick: () => void;
}

interface RunDetailHeaderProps {
  run: RunRecord;
  runDetail: RunDetail | null;
  tokenUsage: Partial<RunTokenUsage> | null;
  busy: boolean;
  pendingDelete: boolean;
  configuredIdeKinds: SupportedIdeKind[];
  canContinueRun: boolean;
  focused?: boolean;
  splitView?: boolean;
  paneLabel?: string;
  runTimelineDensity: RunTimelineDensity;
  onRunTimelineDensityChange: (density: RunTimelineDensity) => void;
  runDensityMenuOpen: boolean;
  setRunDensityMenuOpen: Dispatch<SetStateAction<boolean>>;
  runDensityMenuAnchorRef: RefObject<HTMLDivElement | null>;
  runPanelToggleItems: readonly RunPanelToggleItem[];
  runWorkspaceVisiblePanelCount: number;
  runPanelsMenuOpen: boolean;
  setRunPanelsMenuOpen: Dispatch<SetStateAction<boolean>>;
  runPanelsMenuAnchorRef: RefObject<HTMLDivElement | null>;
  publishMenuOpen: boolean;
  setPublishMenuOpen: Dispatch<SetStateAction<boolean>>;
  publishMenuAnchorRef: RefObject<HTMLDivElement | null>;
  onCommitRun: (run: RunRecord) => void | Promise<void>;
  onOpenPublishDialog: (run: RunRecord) => void | Promise<void>;
  onOpenBranchPublishDialog: (run: RunRecord, mode: "publish" | "local") => void;
  onOpenInIde: (runDetail: RunDetail, ideKind: SupportedIdeKind) => void;
  onOpenFileManager: (runDetail: RunDetail) => void;
  onOpenContinueRunDialog: (run: RunRecord) => void;
  onDeleteRun: (run: RunRecord) => void | Promise<void>;
  onClosePane?: () => void;
  onFocusSubagent?: (subagentId: string) => void;
}

export const RunPaneDropPreviewOverlay = ({ paneId, mode }: { paneId: string; mode: "tile" | "replace" }) => (
  <div className="pointer-events-none absolute inset-0 z-50 rounded-lg p-2">
    <div
      className="relative h-full min-h-24 overflow-hidden rounded-lg border-2 border-[var(--ec-accent)] shadow-[inset_0_0_0_1px_var(--ec-accent-ring),0_0_28px_rgba(34,211,238,0.18)]"
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

type RunSubagent = ReturnType<typeof deriveRunSubagents>[number];

const subagentStatusDotClass = (subagent: RunSubagent) => {
  if (subagent.status === "running" || subagent.status === "pending") {
    return "animate-pulse bg-sky-400";
  }
  if (subagent.status === "completed") {
    return "bg-emerald-400";
  }
  return subagent.status === "failed" ? "bg-red-400" : "bg-amber-400";
};

const subagentMenuTitle = (runningCount: number, totalCount: number) => {
  const noun = totalCount === 1 ? "subagent" : "subagents";
  return runningCount > 0 ? `${String(runningCount)} of ${String(totalCount)} ${noun} running` : `${String(totalCount)} ${noun}`;
};

const RunSubagentMenu = ({
  subagents,
  onFocusSubagent,
}: {
  subagents: RunSubagent[];
  onFocusSubagent?: (subagentId: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  if (subagents.length === 0) {
    return null;
  }
  const runningCount = subagents.filter((subagent) => subagent.status === "running" || subagent.status === "pending").length;
  return (
    <span ref={anchorRef} className="relative shrink-0">
      <button
        type="button"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition hover:brightness-125",
          runningCount > 0
            ? "border-sky-400/30 bg-sky-500/10 text-sky-300"
            : "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]",
        )}
        title={subagentMenuTitle(runningCount, subagents.length)}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {runningCount > 0 ? <Loader2 className="size-3 animate-spin" /> : <Bot className="size-3" />}
        {subagents.length} subagent{subagents.length === 1 ? "" : "s"}
        <ChevronDown className="size-3" />
      </button>
      <AnchorDropdownPortal
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        widthPx={288}
        maxHeightPx={320}
        className="glass-popover overflow-hidden py-1"
      >
        <div role="menu" aria-label="Run subagents" className="app-scrollbar max-h-72 overflow-y-auto">
          {subagents.map((subagent) => {
            const label = subagent.name ?? subagent.description ?? subagent.prompt?.split("\n")[0] ?? subagent.id;
            const detail = subagent.name ? subagent.description ?? subagent.prompt?.split("\n")[0] : undefined;
            return (
              <button
                key={subagent.id}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] transition hover:bg-[var(--ec-hover)]"
                onClick={() => {
                  setOpen(false);
                  onFocusSubagent?.(subagent.id);
                }}
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", subagentStatusDotClass(subagent))} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{label}</span>
                  {detail ? <span className="block truncate text-[10px] text-[var(--ec-muted)]">{detail}</span> : null}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--ec-muted)]">{subagent.status}</span>
              </button>
            );
          })}
        </div>
      </AnchorDropdownPortal>
    </span>
  );
};

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
  const readOnly = !buildwarden.capabilities.mutations;
  const stackedHeader = splitView && focused;
  const isGitRun = run.workspaceVcs === "git";
  let workspaceLabel = run.branchName;
  if (!isGitRun) {
    workspaceLabel = run.workspaceType === "copy" ? "Folder copy" : "Project folder";
  }
  const workspaceCopyValue = isGitRun ? run.branchName : run.worktreePath;
  const hasCommit = runDetail?.steps.some((step) => Boolean(safeParseMetadata(step.metadataJson).commitHash)) ?? false;
  const hasOpenChanges = Boolean(runDetail?.diff.trim());
  const canManageChanges = !readOnly && isGitRun && run.status === "completed" && runDetail?.worktreeUnavailable !== true;
  const canCommit = !readOnly && run.status === "completed" && hasOpenChanges;
  const canPublish = canManageChanges && !hasOpenChanges && hasCommit;
  const canCreateLocalBranch = canManageChanges && (hasOpenChanges || hasCommit);
  const planProgress = useMemo(
    () => deriveLatestRunPlanProgress(runDetail?.steps ?? [], run.mode),
    [run.mode, runDetail?.steps],
  );
  const isRunActive = ["queued", "preparing", "running"].includes(run.status);
  const subagents = useMemo(
    () => deriveRunSubagents(runDetail?.steps ?? [], { runActive: isRunActive }),
    [isRunActive, runDetail?.steps],
  );

  return (
    <Card className={cn("relative z-30 shrink-0", splitView ? "px-3 py-2" : "px-4 py-3")}>
      <div className={cn("flex gap-3", stackedHeader ? "flex-col items-stretch" : "items-center justify-between")}>
        <div className={cn("flex min-w-0 items-center gap-2.5", stackedHeader ? "w-full flex-wrap" : "flex-1")}>
          {splitView && paneLabel ? (
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                focused
                  ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
                  : "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]",
              )}
            >
              {paneLabel}
            </span>
          ) : null}
          <Badge dot tone={run.status}>{run.status}</Badge>
          {runDetail ? (
            <>
              <button
                type="button"
                className={cn(
                  "inline-flex min-w-0 items-center gap-2 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-1 text-[11px] text-[var(--ec-muted)] transition hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)]",
                  stackedHeader ? "max-w-full flex-1 basis-44" : "max-w-[24rem]",
                )}
                onClick={() => void navigator.clipboard.writeText(workspaceCopyValue)}
                title={workspaceCopyValue}
              >
                {isGitRun ? (
                  <GitBranch className="size-3.5 shrink-0 text-[var(--ec-success)]" />
                ) : (
                  <FolderOpen className="size-3.5 shrink-0 text-[var(--ec-success)]" />
                )}
                <span className="truncate font-mono text-[11px] text-[var(--ec-text)]">{workspaceLabel}</span>
              </button>
              <RunTokenBadge
                inputTokens={runDetail.run.inputTokens}
                outputTokens={runDetail.run.outputTokens}
                usage={tokenUsage}
              />
              <RunPlanProgressPill progress={planProgress} />
              <RunSubagentMenu subagents={subagents} onFocusSubagent={onFocusSubagent} />
            </>
          ) : null}
        </div>
        <div
          className={cn(
            "flex max-w-full shrink-0 items-center gap-2",
            stackedHeader ? "w-full flex-wrap justify-end overflow-visible sm:gap-2" : "flex-nowrap overflow-x-auto sm:gap-3",
          )}
        >
          {focused && runDetail?.run ? (
            <div ref={runDensityMenuAnchorRef} className="relative shrink-0">
              <Button
                variant="secondary"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-[var(--ec-muted)] hover:text-[var(--ec-text)]"
                onClick={() => setRunDensityMenuOpen((current) => !current)}
                aria-expanded={runDensityMenuOpen}
                aria-haspopup="menu"
                aria-label={`Run timeline density: ${RUN_TIMELINE_DENSITY_LABELS[runTimelineDensity]}`}
                title={`Run timeline density: ${RUN_TIMELINE_DENSITY_LABELS[runTimelineDensity]}`}
              >
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
              </Button>
              <AnchorDropdownPortal
                open={runDensityMenuOpen}
                anchorRef={runDensityMenuAnchorRef}
                onClose={() => setRunDensityMenuOpen(false)}
                align="end"
                widthPx={180}
                className="glass-popover overflow-hidden py-1"
              >
                <div role="menu" aria-label="Run timeline density">
                  {RUN_TIMELINE_DENSITIES.map((density) => {
                    const selected = runTimelineDensity === density;
                    return (
                      <button
                        key={density}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className={cn(
                          "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition",
                          selected
                            ? "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
                            : "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]",
                        )}
                        onClick={() => {
                          onRunTimelineDensityChange(density);
                          setRunDensityMenuOpen(false);
                        }}
                      >
                        <span
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
                            selected
                              ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent)] text-[var(--ec-bg)]"
                              : "border-[var(--ec-border)] bg-[var(--ec-panel)] text-transparent",
                          )}
                        >
                          {selected ? <Check className="h-3 w-3" aria-hidden /> : null}
                        </span>
                        <span className="font-medium">{RUN_TIMELINE_DENSITY_LABELS[density]}</span>
                      </button>
                    );
                  })}
                </div>
              </AnchorDropdownPortal>
            </div>
          ) : null}
          {focused && runDetail?.run ? (
            <div ref={runPanelsMenuAnchorRef} className="relative shrink-0">
              <Button
                variant="secondary"
                size="sm"
                className="h-8 shrink-0 gap-2 border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-2 text-xs text-[var(--ec-accent)] hover:bg-[var(--ec-hover)]"
                onClick={() => setRunPanelsMenuOpen((current) => !current)}
                aria-expanded={runPanelsMenuOpen}
                aria-haspopup="menu"
                title="Choose visible run panels"
              >
                Panels
                <span className="rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] px-1.5 text-[10px] text-[var(--ec-text)]">
                  {runWorkspaceVisiblePanelCount}
                </span>
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition ${runPanelsMenuOpen ? "rotate-180" : ""}`} />
              </Button>
              <AnchorDropdownPortal
                open={runPanelsMenuOpen}
                anchorRef={runPanelsMenuAnchorRef}
                onClose={() => setRunPanelsMenuOpen(false)}
                align="start"
                widthPx={240}
                className="glass-popover overflow-hidden py-1"
              >
                <div role="menu">
                  {runPanelToggleItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={item.active}
                        disabled={item.disabled}
                        className={cn(
                          "flex w-full items-center gap-3 px-3 py-2 text-left transition",
                          item.disabled ? "cursor-not-allowed text-[var(--ec-faint)]" : "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]",
                        )}
                        onClick={() => {
                          item.onClick();
                        }}
                      >
                        <span
                          className={cn(
                            "flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px]",
                            item.active
                              ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
                              : "border-[var(--ec-border)] bg-[var(--ec-panel)] text-[var(--ec-faint)]",
                          )}
                        >
                          {item.active ? "ON" : ""}
                        </span>
                        <Icon className="h-4 w-4 shrink-0 text-[var(--ec-muted)]" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm">{item.label}</div>
                          <div className="text-[10px] text-[var(--ec-muted)]">{item.subtitle}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </AnchorDropdownPortal>
            </div>
          ) : null}
          {focused && canManageChanges ? (
            <div ref={publishMenuAnchorRef} className="relative shrink-0">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                className="border border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)] hover:border-[var(--ec-success-ring)] hover:bg-[var(--ec-hover)]"
                title="Commit, publish branch, or open a merge request"
                onClick={() => setPublishMenuOpen((current) => !current)}
              >
                <GitBranch className="mr-2 h-4 w-4 shrink-0 text-[var(--ec-success)]" aria-hidden />
                Changes
                {publishMenuOpen ? <ChevronDown className="ml-2 h-4 w-4 shrink-0" /> : <ChevronRight className="ml-2 h-4 w-4 shrink-0" />}
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
                <button
                  type="button"
                  className={cn(
                    "block w-full rounded-lg px-3 py-2 text-left text-sm",
                    canCreateLocalBranch ? "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]" : "cursor-not-allowed text-[var(--ec-faint)]",
                  )}
                  disabled={!canCreateLocalBranch}
                  title={!canCreateLocalBranch ? "Create changes before creating a local branch." : undefined}
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
                    canPublish ? "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]" : "cursor-not-allowed text-[var(--ec-faint)]",
                  )}
                  disabled={!canPublish}
                  title={hasOpenChanges ? "Create a commit before creating a merge request or pull request." : undefined}
                  onClick={() => {
                    if (!canPublish) return;
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
                    canPublish ? "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]" : "cursor-not-allowed text-[var(--ec-faint)]",
                  )}
                  disabled={!canPublish}
                  title={hasOpenChanges ? "Create a commit before publishing the branch." : undefined}
                  onClick={() => {
                    if (!canPublish) return;
                    setPublishMenuOpen(false);
                    onOpenBranchPublishDialog(run, "publish");
                  }}
                >
                  Publish branch
                </button>
              </AnchorDropdownPortal>
            </div>
          ) : null}
          {focused && buildwarden.capabilities.ideIntegration && runDetail && runDetail.worktreeUnavailable !== true && configuredIdeKinds.length > 0 ? (
            <OpenInIdeControl
              compact
              configuredIdeKinds={configuredIdeKinds}
              onOpen={(ideKind) => onOpenInIde(runDetail, ideKind)}
            />
          ) : null}
          {focused && !readOnly && canContinueRun ? (
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
          {focused && !readOnly ? (
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
        </div>
      </div>
    </Card>
  );
};
