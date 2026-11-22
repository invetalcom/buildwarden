import { SessionTitleActions } from "./SessionTitleActions";
import { parseAttentionInboxSettings } from "@buildwarden/shared";
import { AttentionInbox } from "./AttentionInbox";
import { SidebarUtilityButton } from "./SidebarUtilityButton";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { AppSnapshot, RunListItem, SidebarRunEntrySize } from "@buildwarden/shared";
import {
  Archive,
  Bookmark,
  Bot,
  BrainCircuit,
  CalendarClock,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Clock3,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  PanelLeft,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import { StatusDot } from "../ui/motion";
import type { ProjectPageTab } from "./project-page-tabs";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { projectSidebarContext } from "./sidebar-project-context";
import { clampSidebarWidth } from "./sidebar-width";
import {
  resolveRunDisplayStatus,
  runStatusDotClassName,
  runThemeState,
  RUN_DISPLAY_STATUS_LABELS,
} from "./run-display-status";
import type { CurrentProjectBranchStatus } from "./use-project-branches";
import { Separator } from "../ui/separator";
import { cn } from "../../lib/cn";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { InstanceBadge, useInstanceContext } from "../../lib/instance-context";
import { RunForgeBadge } from "./RunForgeBadge";
import { AgentRunHoverCard } from "./AgentRunHoverCard";
import { HoverCard } from "../ui/hover-card";
import { formatRunDuration, formatRunRelativeTime } from "./run-summary-format";
import { runHierarchyLabel, type RunHierarchyRow } from "./run-hierarchy";
import { SidebarRunSections } from "./SidebarRunSections";
import { RunHierarchyIndent, RunHierarchyToggle } from "./RunHierarchy";

const ACTIVE_RUN_STATUSES = new Set(["queued", "preparing", "running"]);

type SidebarRun = RunListItem;
type RunContextMenuState = {
  projectId: string;
  runId: string;
  runStatus: SidebarRun["status"];
  trigger: HTMLButtonElement;
  x: number;
  y: number;
};

interface SidebarProps {
  projects: AppSnapshot["projects"];
  runOrganization?: AppSnapshot["runOrganization"];
  onRunOrganizationChange?: (organization: NonNullable<AppSnapshot["runOrganization"]>) => void;
  providerAccounts?: AppSnapshot["providerAccounts"];
  landingSelected: boolean;
  allRunsSelected: boolean;
  bookmarksSelected: boolean;
  chatsSelected: boolean;
  settingsSelected: boolean;
  attentionInboxSetting?: string;
  /** False when the inbox trigger lives in the custom window title bar instead. */
  showAttentionInbox?: boolean;
  /** Hidden where the title bar already carries the sidebar toggle, so the toggle never moves. */
  showCollapseToggle?: boolean;
  /** The sidebar ends beside the status bar: its bottom row of icons takes the bar's height so the two line up. */
  footerAlignsWithStatusBar?: boolean;
  selectedProjectId: string | null;
  currentProjectBranch: string;
  currentProjectBranchStatus: CurrentProjectBranchStatus;
  projectView: ProjectPageTab;
  highlightedRunId: string | null;
  collapsed: boolean;
  width: number;
  recentRunDays: number;
  runEntrySize: SidebarRunEntrySize;
  groupRunsByProject: boolean;
  hideActiveRuns?: boolean;
  uncategorizedFirst?: boolean;
  uncategorizedSection?: boolean;
  bookmarksCount: number;
  chatsCount: number;
  bookmarkedRunIds: Set<string>;
  onSelectLanding: () => void;
  onSelectAllRuns: () => void;
  onSelectBookmarks: () => void;
  onSelectChats: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectProjectFeature: (projectId: string, tab: ProjectPageTab) => void;
  onSelectRun: (projectId: string, runId: string) => void;
  onRunDragStart: (event: ReactDragEvent<HTMLButtonElement>, projectId: string, runId: string) => void;
  onReorderProjects: (projectIds: string[]) => void;
  onAddRunToBookmarks: (projectId: string, runId: string) => void;
  onRemoveRunFromBookmarks: (runId: string) => void;
  onContinueRun: (projectId: string, runId: string) => void;
  onDeleteRun: (projectId: string, runId: string) => void;
  onSetRunForLater: (projectId: string, runId: string) => void;
  pendingDeleteRunIds: Record<string, boolean>;
  onOpenSettings: () => void;
  onWidthCommit: (width: number) => void;
  onToggleCollapsed: () => void;
  /** Project ids where Loops are available (Git project + saved forge token). Controls the Loops nav entry. */
  loopEnabledProjectIds: ReadonlySet<string>;
}

const projectTools: Array<{ tab: ProjectPageTab; label: string; icon: typeof Bot; count?: (project: AppSnapshot["projects"][number]) => number }> = [
  { tab: "overview", label: "Agent Runs", icon: Bot, count: (project) => project.runs.length },
  { tab: "branches", label: "Branches", icon: GitBranch },
  { tab: "reviews", label: "PRs & Issues", icon: GitPullRequest },
  { tab: "ai-insights-history", label: "AI Insights", icon: BrainCircuit },
  { tab: "tasks", label: "Task Board", icon: ListChecks, count: (project) => project.tasks.length },
  { tab: "automations", label: "Automations", icon: CalendarClock, count: (project) => project.automations?.length ?? 0 },
  { tab: "lab", label: "Project Lab", icon: Sparkles, count: (project) => project.labThreads.length },
  { tab: "loops", label: "Loops", icon: RefreshCw, count: (project) => project.loops.length },
  { tab: "for-later", label: "For Later", icon: Archive, count: (project) => project.forLaterRuns.length },
];

const REMOTE_WEB_PROJECT_TABS = new Set<ProjectPageTab>([
  "overview",
  "ai-insights-history",
  "tasks",
  "automations",
  "lab",
  "for-later",
]);

const projectToolVisible = (
  project: AppSnapshot["projects"][number] | null | undefined,
  tab: ProjectPageTab,
  loopEnabledProjectIds: ReadonlySet<string>,
): boolean => {
  if (tab === "loops") {
    // Loops need a Git project with a saved GitHub/GitLab access token.
    return Boolean(project && project.project.kind === "git" && loopEnabledProjectIds.has(project.project.id));
  }
  if (!project || project.project.kind === "git") {
    return true;
  }
  return tab !== "branches" && tab !== "reviews";
};



const SIDEBAR_RUN_ENTRY_SIZE_STYLES: Record<
  SidebarRunEntrySize,
  {
    button: string;
    indicator: string;
    title: string;
    meta: string;
    alert: string;
    groupGap: string;
    rowGap: string;
  }
> = {
  small: {
    button: "px-2 py-1",
    indicator: "bottom-1.5 top-1.5",
    title: "text-[11px] leading-[0.875rem]",
    meta: "mt-0.5 text-[9px] leading-3",
    alert: "size-3",
    groupGap: "space-y-1",
    rowGap: "space-y-px",
  },
  medium: {
    button: "px-2 py-1.5",
    indicator: "bottom-2 top-2",
    title: "text-[12px] leading-4",
    meta: "mt-1 text-[10px] leading-3",
    alert: "size-3.5",
    groupGap: "space-y-1.5",
    rowGap: "space-y-px",
  },
  large: {
    button: "px-2.5 py-2",
    indicator: "bottom-2.5 top-2.5",
    title: "text-[13px] leading-[1.125rem]",
    meta: "mt-1.5 text-[10px] leading-[0.875rem]",
    alert: "size-4",
    groupGap: "space-y-2",
    rowGap: "space-y-0.5",
  },
};

/** One borderless navigation row. The selected row is a neutral fill, never an accent pill. */
const SidebarNavRow = ({ label, icon: Icon, count, active, onClick }: {
  label: string;
  icon: typeof Bot;
  count?: string | number;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    data-ui="sidebar-item"
    data-active={active}
    aria-label={label}
    aria-current={active ? "page" : undefined}
    aria-description={count ? `${String(count)} items` : undefined}
    className={cn(
      "flex h-[26px] w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ec-ring)]",
      active ? "bg-[var(--ec-control)] text-[var(--ec-text)]" : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
    )}
    onClick={onClick}
  >
    <Icon className={cn("size-3.5 shrink-0", active ? "text-[var(--ec-text)]" : "text-[var(--ec-faint)]")} aria-hidden />
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {count ? <span aria-hidden data-ui="count" className="rounded-full px-1 font-mono text-[10px] tabular-nums text-[var(--ec-faint)]">{count}</span> : null}
  </button>
);

const sidebarIconButtonClassName = "flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--ec-muted)] transition-colors hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]";

const SidebarComponent = ({
  projects,
  runOrganization,
  onRunOrganizationChange,
  providerAccounts = [],
  landingSelected,
  allRunsSelected,
  bookmarksSelected,
  chatsSelected,
  settingsSelected,
  attentionInboxSetting,
  showAttentionInbox = true,
  showCollapseToggle = true,
  footerAlignsWithStatusBar = false,
  selectedProjectId,
  currentProjectBranch,
  currentProjectBranchStatus,
  projectView,
  highlightedRunId,
  collapsed,
  width,
  recentRunDays,
  runEntrySize,
  groupRunsByProject,
  uncategorizedFirst = false,
  uncategorizedSection = true,
  hideActiveRuns = false,
  bookmarksCount,
  chatsCount,
  bookmarkedRunIds,
  onSelectLanding,
  onSelectAllRuns,
  onSelectBookmarks,
  onSelectChats,
  onSelectProject,
  onSelectProjectFeature,
  onSelectRun,
  onRunDragStart,
  onAddRunToBookmarks,
  onRemoveRunFromBookmarks,
  onContinueRun,
  onDeleteRun,
  onSetRunForLater,
  pendingDeleteRunIds,
  onOpenSettings,
  onWidthCommit,
  onToggleCollapsed,
  loopEnabledProjectIds,
}: SidebarProps) => {
  const buildwarden = useBuildWardenClient();
  const isWeb = buildwarden.capabilities.platform === "web";
  const canStartRuns = buildwarden.capabilities.runMutations;
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectToolsExpanded, setProjectToolsExpanded] = useState(true);
  const instanceContext = useInstanceContext();
  const [organizeRun, setOrganizeRun] = useState<{ id: string; trigger: HTMLButtonElement } | null>(null);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<RunContextMenuState | null>(null);
  const menuCapabilities = contextMenu && instanceContext ? instanceContext.clientForEntity(contextMenu.runId).capabilities : buildwarden.capabilities;
  const menuCanStartRuns = menuCapabilities.runMutations;
  const canManageRunBookmarks = menuCapabilities.runMutations;
  const canMoveRunsForLater = menuCapabilities.runListVisibilityMutations;
  const canOpenRunContextMenu = menuCanStartRuns || canManageRunBookmarks || canMoveRunsForLater;
  const contextMenuRun = contextMenu ? projects.flatMap((entry) => [...entry.runs, ...entry.forLaterRuns, ...entry.orchestratedRuns]).find((run) => run.id === contextMenu.runId) : undefined;
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const resizeWidthRef = useRef(width);
  const resizePendingWidthRef = useRef(width);
  const resizeFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!contextMenu || !canOpenRunContextMenu) return;
    const updatePosition = () => {
      const menu = contextMenuRef.current;
      if (!menu) return;
      const { width, height } = menu.getBoundingClientRect();
      const padding = 8;
      menu.style.left = `${Math.max(padding, Math.min(contextMenu.x, window.innerWidth - width - padding))}px`;
      menu.style.top = `${Math.max(padding, Math.min(contextMenu.y, window.innerHeight - height - padding))}px`;
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [contextMenu, canOpenRunContextMenu, menuCanStartRuns, canManageRunBookmarks, canMoveRunsForLater, runOrganization, bookmarkedRunIds]);

  const selectedProject = projects.find((entry) => entry.project.id === selectedProjectId) ?? projects[0] ?? null;
  const selectedProjectContext = projectSidebarContext(
    selectedProject?.project ?? null,
    currentProjectBranch,
    currentProjectBranchStatus,
  );
  const totalActiveRuns = projects.reduce((sum, project) => sum + project.activeRuns.length, 0);
  const sortedProjectsForDropdown = useMemo(
    () =>
      [...projects].sort((left, right) =>
        left.project.name.localeCompare(right.project.name, undefined, { numeric: true, sensitivity: "base" }),
      ),
    [projects],
  );
  const providerTypeByAccountId = useMemo(
    () => new Map(providerAccounts.map((provider) => [provider.id, provider.providerType])),
    [providerAccounts],
  );
  const tagsByRunId = useMemo(() => new Map(runOrganization?.runs.map((run) => [run.runId, run.tags])), [runOrganization]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(event.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    resizeWidthRef.current = width;
    resizePendingWidthRef.current = width;
  }, [width]);

  const scheduleSidebarWidthUpdate = useCallback((nextWidth: number) => {
    const clampedWidth = clampSidebarWidth(nextWidth);
    resizePendingWidthRef.current = clampedWidth;
    resizeWidthRef.current = clampedWidth;

    if (resizeFrameRef.current !== null) return;

    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      if (sidebarRef.current) {
        sidebarRef.current.style.width = `${String(resizePendingWidthRef.current)}px`;
      }
    });
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (event: MouseEvent) => {
      const start = resizeStartRef.current;
      if (!start) return;
      // With the sidebar on the right its inner edge is the left one, so dragging left widens it.
      const direction = document.documentElement.dataset.sidebarSide === "right" ? -1 : 1;
      scheduleSidebarWidthUpdate(start.width + direction * (event.clientX - start.x));
    };

    const stopResizing = () => {
      const nextWidth = resizeWidthRef.current;
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (sidebarRef.current) {
        sidebarRef.current.style.width = `${String(nextWidth)}px`;
      }
      setIsResizing(false);
      resizeStartRef.current = null;
      onWidthCommit(nextWidth);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopResizing);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopResizing);
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, onWidthCommit, scheduleSidebarWidthUpdate]);

  const startResizing = (event: ReactMouseEvent<HTMLDivElement>) => {
    resizeStartRef.current = { x: event.clientX, width };
    resizeWidthRef.current = width;
    setIsResizing(true);
  };

  const toggleRunHierarchy = useCallback((runId: string) => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  const selectProjectFeature = (projectId: string, tab: ProjectPageTab) => {
    onSelectProjectFeature(projectId, tab);
  };

  const workspaceLinks = [
    { label: "Home", icon: LayoutGrid, selected: landingSelected, onClick: onSelectLanding, count: projects.length ? `${projects.length}` : "" },
    { label: "All Runs", icon: Clock3, selected: allRunsSelected, onClick: onSelectAllRuns, count: totalActiveRuns > 0 ? `${totalActiveRuns}` : "" },
    { label: "Chats", icon: MessageSquare, selected: chatsSelected, onClick: onSelectChats, count: chatsCount ? `${chatsCount}` : "" },
    { label: "Bookmarks", icon: Bookmark, selected: bookmarksSelected, onClick: onSelectBookmarks, count: bookmarksCount ? `${bookmarksCount}` : "" },
  ];
  const visibleProjectTools = projectTools.filter((tool) => {
    if (isWeb) {
      const remoteTabAvailable = REMOTE_WEB_PROJECT_TABS.has(tool.tab) ||
        (tool.tab === "branches" && buildwarden.capabilities.gitMutations) ||
        (tool.tab === "reviews" && buildwarden.capabilities.prReview) ||
        (tool.tab === "loops" && buildwarden.capabilities.projectLoopMutations);
      if (!remoteTabAvailable) return false;
    }
    return projectToolVisible(selectedProject, tool.tab, loopEnabledProjectIds);
  });
  const runEntryStyles = SIDEBAR_RUN_ENTRY_SIZE_STYLES[runEntrySize];
  const renderRecentRunEntry = (
    project: AppSnapshot["projects"][number],
    row: RunHierarchyRow,
    showProjectName: boolean,
  ) => {
    const { run, depth, descendantCount, expanded } = row;
    const runTags = tagsByRunId.get(run.id) ?? [];
    const highlighted = highlightedRunId === run.id;
    const waitingForInput = run.pendingUserInputRequest === true || run.pendingUserInputRequest === 1;
    const displayStatus = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
    const showProjectLabel = showProjectName && depth === 0;
    const trigger = (
      <button
        type="button"
        draggable
        data-sidebar-run-entry-size={runEntrySize}
        className={cn("group relative flex w-full min-w-0 items-center gap-1 overflow-hidden text-left", runEntryStyles.button)}
        onDragStart={(event) => {
          onRunDragStart(event, project.project.id, run.id);
        }}
        onClick={() => onSelectRun(project.project.id, run.id)}
        onContextMenu={(event) => {
          const capabilities = instanceContext?.clientForEntity(run.id).capabilities ?? buildwarden.capabilities;
          if (!capabilities.runMutations && !capabilities.runListVisibilityMutations) return;
          event.preventDefault();
          setContextMenu({
            projectId: project.project.id,
            runId: run.id,
            runStatus: run.status,
            trigger: event.currentTarget,
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <StatusDot state={runThemeState(displayStatus, waitingForInput)} className={cn("size-1.5 shrink-0 rounded-full", runStatusDotClassName(displayStatus))} />
            <span className={cn("min-w-0 flex-1 truncate font-medium text-[var(--ec-text)]", runEntryStyles.title)}>{runHierarchyLabel(run)}</span>
            {waitingForInput ? (
              <span className="shrink-0" title="Waiting for user feedback" aria-label="Waiting for user feedback">
                <CircleAlert className={cn(runEntryStyles.alert, "text-[var(--ec-warning)]")} />
              </span>
            ) : null}
          </span>
          <span className={cn("flex min-w-0 items-center gap-1.5 pl-3.5 font-mono text-[var(--ec-faint)]", runEntryStyles.meta)}>
          <InstanceBadge entityId={run.id} />
          {showProjectLabel ? (
            <>
              <span
                className="max-w-[45%] truncate font-sans text-[var(--ec-muted)]"
                data-sidebar-run-project
                title={project.project.name}
              >
                {project.project.name}
              </span>
              <span className="size-1 shrink-0 rounded-full bg-[var(--ec-faint)]" />
            </>
          ) : null}
          {/* The provider mark matches the line box, so it adds no row height. */}
          <ProviderBrandIcon harnessType={run.harnessType} providerType={providerTypeByAccountId.get(run.providerAccountId)} className="size-3 shrink-0" />
          <span className="truncate">{formatRunRelativeTime(run.finishedAt ?? run.updatedAt)}</span>
          <span className="size-1 shrink-0 rounded-full bg-[var(--ec-faint)]" />
          <span className="shrink-0">{formatRunDuration(run)}</span>
          {runTags.length > 0 ? <span className="min-w-0 truncate font-sans text-[var(--ec-accent)]" title={runTags.join(", ")}>
            {runTags.map((tag) => "#" + tag).join(" ")}
          </span> : null}
          </span>
        </span>
        <span className="sr-only">Status: {RUN_DISPLAY_STATUS_LABELS[displayStatus]}</span>
      </button>
    );
    return (
      <RunHierarchyIndent key={run.id} depth={depth} indentPx={10}>
        <div
          data-run-hierarchy-run={run.id}
          data-ui="sidebar-item"
          data-active={highlighted}
          className={cn(
            "relative flex w-full min-w-0 items-center overflow-hidden rounded-md transition-colors",
            highlighted
              ? "bg-[var(--ec-control)]"
              : "hover:bg-[var(--ec-hover)]",
          )}
        >
          <div className="min-w-0 flex-1">
            <HoverCard content={<AgentRunHoverCard projectName={project.project.name} run={run} providerType={providerTypeByAccountId.get(run.providerAccountId)} tags={runTags} />}>
              {trigger}
            </HoverCard>
          </div>
          <RunForgeBadge request={run.forgeRequest} watch={run.prWatch} onOpen={(url) => buildwarden.openExternalUrl(url)} />
          {descendantCount > 0 ? (
            <RunHierarchyToggle
              runId={run.id}
              runLabel={runHierarchyLabel(run)}
              descendantCount={descendantCount}
              expanded={expanded}
              compact
              className="mr-1"
              onToggle={toggleRunHierarchy}
            />
          ) : null}
        </div>
      </RunHierarchyIndent>
    );
  };

  if (collapsed) {
    return (
      <aside data-ui="sidebar" className="flex min-h-0 w-[46px] shrink-0 flex-col transition-colors duration-150">
        {showCollapseToggle ? (
          <div className="flex h-10 items-center justify-center">
            <button className={sidebarIconButtonClassName} onClick={onToggleCollapsed} type="button" aria-label="Expand sidebar" title="Expand sidebar">
              <PanelLeft className="size-4" />
            </button>
          </div>
        ) : null}
        <div className="app-scrollbar flex flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
          {selectedProject ? (
            <button
              type="button"
              className="mb-1 flex size-8 items-center justify-center rounded-md bg-[var(--ec-accent)] text-xs font-semibold text-[var(--ec-accent-foreground)]"
              title={selectedProject.project.name}
              onClick={() => onSelectProject(selectedProject.project.id)}
            >
              {selectedProject.project.name.slice(0, 1).toUpperCase()}
            </button>
          ) : null}
          {visibleProjectTools.map((tool) => {
            const Icon = tool.icon;
            const active = Boolean(selectedProjectId) && !landingSelected && !allRunsSelected && !bookmarksSelected && !chatsSelected && !settingsSelected && projectView === tool.tab;
            return (
              <button
                key={tool.tab}
                type="button"
                className={cn(
                  "flex size-8 items-center justify-center rounded-md transition",
                  active ? "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]" : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
                )}
                title={tool.label}
                onClick={() => selectedProject && selectProjectFeature(selectedProject.project.id, tool.tab)}
              >
                <Icon className="size-4" />
              </button>
            );
          })}
        </div>
        <div className="flex flex-col items-center gap-1 py-2">
          {workspaceLinks.map((link) => (
            <SidebarUtilityButton key={link.label} {...link} collapsed={collapsed} />
          ))}
          {showAttentionInbox && parseAttentionInboxSettings(attentionInboxSetting).enabled && <AttentionInbox key={attentionInboxSetting} client={buildwarden} compact={collapsed} triggerVariant="sidebar" onOpenRun={onSelectRun} />}
          {(buildwarden.capabilities.settings || instanceContext) && (
            <SidebarUtilityButton label="Settings" icon={Settings} selected={settingsSelected} onClick={onOpenSettings} collapsed={collapsed} />
          )}
        </div>
      </aside>
    );
  }

  return (
    <>
    {isWeb ? (
      <button
        type="button"
        className="fixed inset-0 z-40 hidden bg-black/45 backdrop-blur-[1px] max-[899px]:block"
        onClick={onToggleCollapsed}
        aria-label="Close navigation"
      />
    ) : null}
    <aside
      ref={sidebarRef}
      data-ui="sidebar"
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col text-[var(--ec-text)] transition-colors duration-150",
        isWeb && "max-[899px]:fixed max-[899px]:inset-y-0 max-[899px]:left-0 max-[899px]:z-50 max-[899px]:max-w-[calc(100vw-3rem)] max-[899px]:shadow-2xl",
      )}
      style={{ width }}
    >
      <div ref={projectMenuRef} className="relative shrink-0 px-1.5 pb-1 pt-1.5">
        <div className="flex items-center gap-0.5">
          {showCollapseToggle ? (
            <button className={sidebarIconButtonClassName} onClick={onToggleCollapsed} type="button" aria-label="Collapse sidebar" title="Collapse sidebar">
              <PanelLeft className="size-4" />
            </button>
          ) : null}
          <button
            type="button"
            className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-[var(--ec-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ec-ring)]"
            onClick={() => setProjectMenuOpen((current) => !current)}
            aria-expanded={projectMenuOpen}
            aria-label="Select project"
          >
            <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[var(--ec-accent)] text-[10px] font-bold text-[var(--ec-accent-foreground)]">
              {(selectedProject?.project.name ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold leading-4 text-[var(--ec-text)]">{selectedProject?.project.name ?? "Select project"}</span>
              <span className="block truncate font-mono text-[10px] leading-3 text-[var(--ec-faint)]">
                <InstanceBadge entityId={selectedProject?.project.id} /> {selectedProjectContext}
              </span>
            </span>
            <ChevronDown className={cn("size-3 shrink-0 text-[var(--ec-faint)] transition", projectMenuOpen && "rotate-180")} />
          </button>
          {selectedProject && canStartRuns ? (
            <button
              type="button"
              className={sidebarIconButtonClassName}
              onClick={() => selectProjectFeature(selectedProject.project.id, "overview")}
              aria-label="Start new agent run"
              title="New agent run"
            >
              <Plus className="size-4" />
            </button>
          ) : null}
          {selectedProject ? (
            <button
              type="button"
              className={sidebarIconButtonClassName}
              onClick={() => selectProjectFeature(selectedProject.project.id, "settings")}
              aria-label="Open project settings"
              title={isWeb && !buildwarden.capabilities.projectSettingsMutations ? "Project settings (limited remote access)" : "Project settings"}
            >
              <Settings className="size-3.5" />
            </button>
          ) : null}
          {selectedProject ? (
            <button
              type="button"
              className={sidebarIconButtonClassName}
              onClick={() => setProjectToolsExpanded((current) => !current)}
              aria-expanded={projectToolsExpanded}
              aria-controls="sidebar-project-tools"
              aria-label={projectToolsExpanded ? "Collapse project navigation" : "Expand project navigation"}
              title={projectToolsExpanded ? "Hide project tools" : "Show project tools"}
            >
              {projectToolsExpanded ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
            </button>
          ) : null}
        </div>
        {projectMenuOpen ? (
          <div className="absolute left-1.5 right-1.5 top-full z-50 glass-popover overflow-hidden py-1">
            <div className="max-h-[60vh] overflow-y-auto">
            {projects.length > 0 ? (
              sortedProjectsForDropdown.map((entry) => {
                const selected = entry.project.id === selectedProject?.project.id;
                return (
                  <button
                    key={entry.project.id}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left transition hover:bg-[var(--ec-hover)]"
                    onClick={() => {
                      setProjectMenuOpen(false);
                      onSelectProject(entry.project.id);
                    }}
                  >
                    <span className={cn("size-2 shrink-0 rounded-full", entry.activeRuns.length > 0 ? "bg-[var(--ec-accent)]" : "bg-[var(--ec-faint)]")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-[var(--ec-text)]">{entry.project.name}</span>
                      <span className="block truncate font-mono text-[10px] text-[var(--ec-muted)]">
                        <InstanceBadge entityId={entry.project.id} /> {selected ? selectedProjectContext : entry.project.kind === "folder" ? "Folder" : "Git repository"}
                      </span>
                    </span>
                    {selected ? <span className="text-[10px] font-semibold text-[var(--ec-accent)]">Active</span> : null}
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-3 text-xs text-[var(--ec-muted)]">No projects yet.</div>
            )}
            </div>
            {instanceContext && <div className="border-t border-[var(--ec-border)] p-1">
              <button type="button" className="w-full px-2 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)]" onClick={() => { setProjectMenuOpen(false); instanceContext.manageInstances(); }}>Manage instances · {instanceContext.instances.length}</button>
              <button type="button" disabled={!buildwarden.capabilities.hostDirectoryBrowser} className="w-full px-2 py-1.5 text-left text-xs text-[var(--ec-text)] disabled:opacity-50 hover:bg-[var(--ec-hover)]" onClick={() => { setProjectMenuOpen(false); instanceContext.addProject(); }}>Add project to {instanceContext.instances.find((entry) => entry.id === instanceContext.activeInstanceId)?.label ?? "instance"}</button>
            </div>}
          </div>
        ) : null}
      </div>

      {selectedProject && projectToolsExpanded ? (
        <nav id="sidebar-project-tools" aria-label="Project" className="shrink-0 px-1.5">
          {visibleProjectTools.map((tool) => {
            const active =
              selectedProjectId === selectedProject.project.id &&
              !landingSelected &&
              !allRunsSelected &&
              !bookmarksSelected &&
              !chatsSelected &&
              !settingsSelected &&
              projectView === tool.tab;
            const count = tool.count?.(selectedProject);
            return (
              <SidebarNavRow
                key={tool.tab}
                label={tool.label}
                icon={tool.icon}
                count={typeof count === "number" && count > 0 ? (count > 99 ? "99+" : count) : undefined}
                active={active}
                onClick={() => selectProjectFeature(selectedProject.project.id, tool.tab)}
              />
            );
          })}
        </nav>
      ) : null}

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto pb-1.5 pt-2">
        <SidebarRunSections projects={projects} organization={runOrganization} onOrganizationChange={onRunOrganizationChange}
          recentRunDays={recentRunDays} hideActiveRuns={hideActiveRuns} groupRunsByProject={groupRunsByProject}
          uncategorizedFirst={uncategorizedFirst}
          uncategorizedSection={uncategorizedSection}
          runEntrySize={runEntrySize}
          runRowGapClassName={runEntryStyles.rowGap} onSelectProject={(projectId) => selectProjectFeature(projectId, "overview")}
          expandedRunIds={expandedRunIds} highlightedRunId={highlightedRunId} organizeRunId={organizeRun?.id ?? null}
          organizerReturnFocusTo={organizeRun?.trigger} onCloseOrganizer={() => setOrganizeRun(null)} renderRun={renderRecentRunEntry} />
      </div>

      <nav aria-label="Workspace" data-ui="sidebar-footer" data-align={footerAlignsWithStatusBar ? "statusbar" : undefined} className="flex min-w-0 shrink-0 flex-nowrap items-center gap-0.5 px-1.5 pb-1 pt-1">
        {workspaceLinks.map((link) => (
          <SidebarUtilityButton key={link.label} {...link} collapsed={collapsed} />
        ))}
        {showAttentionInbox && parseAttentionInboxSettings(attentionInboxSetting).enabled && <AttentionInbox key={attentionInboxSetting} client={buildwarden} compact={collapsed} triggerVariant="sidebar" onOpenRun={onSelectRun} />}
        {(buildwarden.capabilities.settings || instanceContext) && (
          <SidebarUtilityButton label="Settings" icon={Settings} selected={settingsSelected} onClick={onOpenSettings} collapsed={collapsed} />
        )}
      </nav>

      {contextMenu && canOpenRunContextMenu
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-[30000]"
                onClick={() => setContextMenu(null)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu(null);
                }}
                role="presentation"
              />
              <div
                ref={contextMenuRef}
                className="fixed z-[30001] w-max min-w-[min(11rem,calc(100vw-16px))] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-y-auto glass-popover py-1"
                style={{ left: contextMenu.x, top: contextMenu.y }}
              >
                {contextMenuRun ? <SessionTitleActions kind="run" session={contextMenuRun} menu onClose={() => setContextMenu(null)} /> : null}
                {canMoveRunsForLater && runOrganization !== undefined ? (
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)]"
                    onClick={() => { setOrganizeRun({ id: contextMenu.runId, trigger: contextMenu.trigger }); setContextMenu(null); }}>
                    <FolderGit2 className="size-3.5" />Move to section / edit tags
                  </button>
                ) : null}
                {menuCanStartRuns ? (
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)]",
                      ACTIVE_RUN_STATUSES.has(contextMenu.runStatus) && "cursor-not-allowed opacity-50 hover:bg-transparent",
                    )}
                    disabled={ACTIVE_RUN_STATUSES.has(contextMenu.runStatus)}
                    onClick={() => {
                      onContinueRun(contextMenu.projectId, contextMenu.runId);
                      setContextMenu(null);
                    }}
                    type="button"
                  >
                    <Bot className="size-3.5" />
                    Fork (fresh context)
                  </button>
                ) : null}
                {canManageRunBookmarks && bookmarkedRunIds.has(contextMenu.runId) ? (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)]"
                    onClick={() => {
                      onRemoveRunFromBookmarks(contextMenu.runId);
                      setContextMenu(null);
                    }}
                    type="button"
                  >
                    <Bookmark className="size-3.5" />
                    Remove bookmark
                  </button>
                ) : canManageRunBookmarks ? (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)]"
                    onClick={() => {
                      onAddRunToBookmarks(contextMenu.projectId, contextMenu.runId);
                      setContextMenu(null);
                    }}
                    type="button"
                  >
                    <Bookmark className="size-3.5" />
                    Add bookmark
                  </button>
                ) : null}
                {canMoveRunsForLater ? (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)]"
                    onClick={() => {
                      onSetRunForLater(contextMenu.projectId, contextMenu.runId);
                      setContextMenu(null);
                    }}
                    type="button"
                  >
                    <Archive className="size-3.5" />
                    Move for later
                  </button>
                ) : null}
                {menuCanStartRuns ? (
                  <>
                    <Separator className="my-1" />
                    <button
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-danger)] hover:bg-[var(--ec-danger-soft)]"
                      disabled={pendingDeleteRunIds[contextMenu.runId]}
                      onClick={() => {
                        onDeleteRun(contextMenu.projectId, contextMenu.runId);
                        setContextMenu(null);
                      }}
                      type="button"
                    >
                      <Trash2 className="size-3.5" />
                      Delete run
                    </button>
                  </>
                ) : null}
              </div>
            </>,
            document.body,
          )
        : null}

      <div
        className="sidebar-resize-handle absolute right-0 top-0 h-full w-1 cursor-col-resize"
        onMouseDown={startResizing}
        role="separator"
        aria-orientation="vertical"
      />
    </aside>
    </>
  );
};

/**
 * The sidebar is always mounted and fairly large; memoizing it keeps composer
 * keystrokes and other App-level state changes from re-rendering it. All
 * callback props must keep stable identities (see useStableCallback in App).
 */
export const Sidebar = memo(SidebarComponent);
