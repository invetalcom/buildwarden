import {
  APP_SETTING_KEYS,
  parseAttentionInboxSettings,
  parseSidebarRunSectionsSetting,
  serializeSidebarRunSectionsSetting,
  type SidebarRunSectionsConfig,
  type SidebarRunView,
} from "@buildwarden/shared";
import { AttentionInbox } from "./AttentionInbox";
import { SidebarUtilityButton } from "./SidebarUtilityButton";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { AppSnapshot, RunRecord, SidebarRunEntrySize } from "@buildwarden/shared";
import {
  Archive,
  Bookmark,
  Bot,
  BrainCircuit,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  FolderInput,
  Clock3,
  FolderGit2,
  GitBranch,
  GitGraph,
  GitPullRequest,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { ProjectPageTab } from "./project-page-tabs";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { projectSidebarContext } from "./sidebar-project-context";
import { recentRunOrderTimestamp } from "./sidebar-run-ordering";
import {
  collectSidebarSectionRuns,
  countSidebarRunViews,
  groupSidebarRunsBySection,
  resolveRunSidebarSectionId,
  SIDEBAR_RUN_SECTION_COLOR_CLASSES,
  SIDEBAR_SECTION_RUN_DRAG_MIME_TYPE,
  sidebarRunMatchesView,
} from "./sidebar-run-sections";
import { SidebarRunSections, type SidebarRunSectionGroup } from "./SidebarRunSections";
import { clampSidebarWidth } from "./sidebar-width";
import {
  resolveRunDisplayStatus,
  RUN_DISPLAY_STATUS_LABELS,
  type RunDisplayStatus,
} from "./run-display-status";
import type { CurrentProjectBranchStatus } from "./use-project-branches";
import { Separator } from "../ui/separator";
import { cn } from "../../lib/cn";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { runForgeReadinessColor, runForgeReadinessLabel } from "./run-forge-ui";
import { AgentRunHoverCard } from "./AgentRunHoverCard";
import { HoverCard } from "../ui/hover-card";
import { formatRunDuration, formatRunRelativeTime } from "./run-summary-format";
import { buildRunHierarchyRows, runHierarchyLabel, type RunHierarchyRow } from "./run-hierarchy";
import { RunHierarchyIndent, RunHierarchyToggle } from "./RunHierarchy";

const ACTIVE_RUN_STATUSES = new Set(["queued", "preparing", "running"]);

type SidebarRun = RunRecord;
type RunContextMenuState = {
  projectId: string;
  runId: string;
  runStatus: SidebarRun["status"];
  /** Top-level run that section moves apply to; subagent rows move with their root. */
  sectionRunId: string;
  x: number;
  y: number;
};

interface SidebarProps {
  projects: AppSnapshot["projects"];
  providerAccounts?: AppSnapshot["providerAccounts"];
  landingSelected: boolean;
  allRunsSelected: boolean;
  bookmarksSelected: boolean;
  chatsSelected: boolean;
  settingsSelected: boolean;
  attentionInboxSetting?: string;
  selectedProjectId: string | null;
  currentProjectBranch: string;
  currentProjectBranchStatus: CurrentProjectBranchStatus;
  projectView: ProjectPageTab;
  highlightedRunId: string | null;
  collapsed: boolean;
  width: number;
  recentRunDays: number;
  runEntrySize: SidebarRunEntrySize;
  /** Raw {@link APP_SETTING_KEYS.sidebarRunSections} value. */
  runSectionsSetting?: string;
  runView: SidebarRunView;
  /** Project id limiting the run list; empty or unknown ids show every project. */
  runProjectScope: string;
  hideActiveRuns?: boolean;
  /** Lists Uncategorized below the custom sections instead of above them. */
  uncategorizedLast?: boolean;
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
  onMoveRunToSection: (runId: string, sectionId: string | null) => Promise<void>;
  onSidebarSettingChange: (key: string, value: string) => Promise<void>;
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
  { tab: "reviews", label: "PR Review", icon: GitPullRequest },
  { tab: "graphs", label: "Graphs", icon: GitGraph },
  { tab: "ai-insights-history", label: "AI Insights", icon: BrainCircuit },
  { tab: "tasks", label: "Task Board", icon: ListChecks, count: (project) => project.tasks.length },
  { tab: "automations", label: "Automations", icon: CalendarClock, count: (project) => project.automations?.length ?? 0 },
  { tab: "lab", label: "Project Lab", icon: Sparkles, count: (project) => project.labThreads.length },
  { tab: "loops", label: "Loops", icon: RefreshCw, count: (project) => project.loops.length },
  { tab: "for-later", label: "For Later", icon: Archive, count: (project) => project.forLaterRuns.length },
];

const REMOTE_WEB_PROJECT_TABS = new Set<ProjectPageTab>([
  "overview",
  "graphs",
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

const formatRecentRunWindowLabel = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;
const compareRecentRuns = (left: SidebarRun, right: SidebarRun) => recentRunOrderTimestamp(right) - recentRunOrderTimestamp(left);

const runDotClassName = (status: RunDisplayStatus) => {
  if (status === "completed") return "bg-[var(--ec-success)]";
  if (status === "failed" || status === "attention" || status === "deletion-failed") return "bg-[var(--ec-danger)]";
  if (status === "cancelled") return "bg-[var(--ec-faint)]";
  if (status === "preparing" || status === "deleting") return "bg-[var(--ec-info)]";
  if (status === "running") return "bg-[var(--ec-accent)] shadow-[0_0_0_3px_var(--ec-accent-soft)]";
  return "bg-[var(--ec-warning)]";
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
    rowGap: "space-y-0.5",
  },
  large: {
    button: "px-2.5 py-2",
    indicator: "bottom-2.5 top-2.5",
    title: "text-[13px] leading-[1.125rem]",
    meta: "mt-1.5 text-[10px] leading-[0.875rem]",
    alert: "size-4",
    groupGap: "space-y-2",
    rowGap: "space-y-1",
  },
};

const SidebarComponent = ({
  projects,
  providerAccounts = [],
  landingSelected,
  allRunsSelected,
  bookmarksSelected,
  chatsSelected,
  settingsSelected,
  attentionInboxSetting,
  selectedProjectId,
  currentProjectBranch,
  currentProjectBranchStatus,
  projectView,
  highlightedRunId,
  collapsed,
  width,
  recentRunDays,
  runEntrySize,
  runSectionsSetting,
  runView,
  runProjectScope,
  hideActiveRuns = false,
  uncategorizedLast = false,
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
  onMoveRunToSection,
  onSidebarSettingChange,
  pendingDeleteRunIds,
  onOpenSettings,
  onWidthCommit,
  onToggleCollapsed,
  loopEnabledProjectIds,
}: SidebarProps) => {
  const buildwarden = useBuildWardenClient();
  const isWeb = buildwarden.capabilities.platform === "web";
  const canStartRuns = buildwarden.capabilities.runMutations;
  const canManageRunBookmarks = buildwarden.capabilities.runMutations;
  const canMoveRunsForLater = buildwarden.capabilities.runListVisibilityMutations;
  // Section moves share the run-organization scope with For later.
  const canMoveRunsToSections = canMoveRunsForLater;
  const canEditRunSections = buildwarden.capabilities.settings;
  const canOpenRunContextMenu = canStartRuns || canManageRunBookmarks || canMoveRunsForLater;
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectToolsExpanded, setProjectToolsExpanded] = useState(true);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const [pendingSectionMoves, setPendingSectionMoves] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  // Optimistic section edits, shown until the matching save settles.
  const [draftRunSections, setDraftRunSections] = useState<SidebarRunSectionsConfig | null>(null);
  const [contextMenu, setContextMenu] = useState<RunContextMenuState | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const resizeWidthRef = useRef(width);
  const resizePendingWidthRef = useRef(width);
  const resizeFrameRef = useRef<number | null>(null);

  const selectedProject = projects.find((entry) => entry.project.id === selectedProjectId) ?? projects[0] ?? null;
  const selectedProjectContext = projectSidebarContext(
    selectedProject?.project ?? null,
    currentProjectBranch,
    currentProjectBranchStatus,
  );
  const totalActiveRuns = projects.reduce((sum, project) => sum + project.activeRuns.length, 0);
  const recentRunWindowMs = recentRunDays * 24 * 60 * 60 * 1000;
  const recentRunWindowLabel = formatRecentRunWindowLabel(recentRunDays);
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

  // Filter only sidebar collections, retaining attention/paused states and the
  // original snapshot used by project navigation and the other run lists.
  const recentRunProjects = useMemo(() => {
    if (!hideActiveRuns) return projects;
    const visible = (run: SidebarRun) => !ACTIVE_RUN_STATUSES.has(resolveRunDisplayStatus(run.status, run.orchestrationStatus));
    return projects.map((entry) => ({
      ...entry,
      runs: entry.runs.filter(visible),
      orchestratedRuns: entry.orchestratedRuns.filter(visible),
    }));
  }, [hideActiveRuns, projects]);

  const persistedRunSections = useMemo(() => parseSidebarRunSectionsSetting(runSectionsSetting), [runSectionsSetting]);
  const runSections = draftRunSections ?? persistedRunSections;
  const runSectionIds = useMemo(() => new Set(runSections.sections.map((section) => section.id)), [runSections.sections]);
  const scopedProjectId = projects.some((entry) => entry.project.id === runProjectScope) ? runProjectScope : null;
  const scopedRunProjects = useMemo(
    () => (scopedProjectId ? recentRunProjects.filter((entry) => entry.project.id === scopedProjectId) : recentRunProjects),
    [recentRunProjects, scopedProjectId],
  );

  const sectionRunEntries = useMemo(
    () => collectSidebarSectionRuns(scopedRunProjects, {
      sectionIds: runSectionIds,
      pendingMoves: pendingSectionMoves,
      recentRunWindowMs,
      now: Date.now(),
    }),
    [pendingSectionMoves, recentRunWindowMs, runSectionIds, scopedRunProjects],
  );
  const runViewCounts = useMemo(() => countSidebarRunViews(sectionRunEntries), [sectionRunEntries]);

  const sectionRunRows = useMemo(() => {
    const projectById = new Map(projects.map((entry) => [entry.project.id, entry]));
    const orchestratedRuns = scopedRunProjects.flatMap((entry) => entry.orchestratedRuns);
    const groups = groupSidebarRunsBySection(
      sectionRunEntries.filter(({ run }) => sidebarRunMatchesView(run, runView)),
      runSections.sections,
      pendingSectionMoves,
    );
    return new Map(
      [...groups].map(([sectionId, entries]) => {
        let sectionRunId = "";
        const rows = buildRunHierarchyRows(entries.map(({ run }) => run), orchestratedRuns, {
          expandedRunIds,
          compareRuns: compareRecentRuns,
        }).flatMap((row) => {
          if (row.depth === 0) sectionRunId = row.run.id;
          const project = projectById.get(row.run.projectId);
          return project ? [{ project, row, sectionRunId }] : [];
        });
        return [sectionId, { rootCount: entries.length, rows }] as const;
      }),
    );
  }, [expandedRunIds, pendingSectionMoves, projects, runSections.sections, runView, scopedRunProjects, sectionRunEntries]);

  const updateRunSections = useCallback(
    (config: SidebarRunSectionsConfig) => {
      setDraftRunSections(config);
      void onSidebarSettingChange(APP_SETTING_KEYS.sidebarRunSections, serializeSidebarRunSectionsSetting(config)).finally(() => {
        setDraftRunSections((current) => (current === config ? null : current));
      });
    },
    [onSidebarSettingChange],
  );

  const moveRunToSection = useCallback(
    (runId: string, sectionId: string | null) => {
      const run = projects.flatMap((entry) => entry.runs).find((candidate) => candidate.id === runId);
      if (!run || resolveRunSidebarSectionId(run, runSectionIds, pendingSectionMoves) === sectionId) return;
      setPendingSectionMoves((current) => new Map(current).set(runId, sectionId));
      void onMoveRunToSection(runId, sectionId).finally(() => {
        setPendingSectionMoves((current) => {
          const next = new Map(current);
          next.delete(runId);
          return next;
        });
      });
    },
    [onMoveRunToSection, pendingSectionMoves, projects, runSectionIds],
  );

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
      scheduleSidebarWidthUpdate(start.width + event.clientX - start.x);
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
    sectionRunId: string,
  ) => {
    const { run, depth, descendantCount, expanded } = row;
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
          if (canMoveRunsToSections) {
            event.dataTransfer.effectAllowed = "copyMove";
            event.dataTransfer.setData(SIDEBAR_SECTION_RUN_DRAG_MIME_TYPE, sectionRunId);
          }
        }}
        onClick={() => onSelectRun(project.project.id, run.id)}
        onContextMenu={(event) => {
          if (!canOpenRunContextMenu) return;
          event.preventDefault();
          setContextMenu({
            projectId: project.project.id,
            runId: run.id,
            runStatus: run.status,
            sectionRunId,
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        {/* The colored left bar is the only visible status; the label stays available to assistive tech. */}
        <span className={cn("absolute left-0 w-0.5 rounded-r-full", runEntryStyles.indicator, runDotClassName(displayStatus))} />
        <span className="sr-only" data-sidebar-run-status>{RUN_DISPLAY_STATUS_LABELS[displayStatus]}</span>
        <span className="min-w-0 flex-1 pl-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className={cn("min-w-0 flex-1 truncate font-semibold text-[var(--ec-text)]", runEntryStyles.title)}>{runHierarchyLabel(run)}</span>
            {waitingForInput ? (
              <span className="shrink-0" title="Waiting for user feedback" aria-label="Waiting for user feedback">
                <CircleAlert className={cn(runEntryStyles.alert, "text-[var(--ec-warning)]")} />
              </span>
            ) : null}
          </span>
          <span className={cn("flex min-w-0 items-center gap-1.5 font-mono text-[var(--ec-muted)]", runEntryStyles.meta)}>
          {showProjectLabel ? (
            <>
              <span
                className="max-w-[45%] truncate font-sans font-medium text-[var(--ec-text)]"
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
          {run.forgeRequest ? (
            <span
              className={cn("inline-flex shrink-0", runForgeReadinessColor[run.forgeRequest.readiness])}
              title={`${run.forgeRequest.provider === "github" ? "PR" : "MR"} #${String(run.forgeRequest.number)} · ${runForgeReadinessLabel[run.forgeRequest.readiness]} · ${String(run.forgeRequest.checks.completed)}/${String(run.forgeRequest.checks.total)} checks · refreshed ${new Date(run.forgeRequest.lastSyncedAt).toLocaleString()}`}
            >
              <GitPullRequest className="size-3" aria-hidden />
            </span>
          ) : null}
          <span className="truncate">{formatRunRelativeTime(run.finishedAt ?? run.updatedAt)}</span>
          <span className="size-1 shrink-0 rounded-full bg-[var(--ec-faint)]" />
          <span className="shrink-0">{formatRunDuration(run)}</span>
          </span>
        </span>
      </button>
    );
    return (
      <RunHierarchyIndent key={run.id} depth={depth} indentPx={10}>
        <div
          data-run-hierarchy-run={run.id}
          className={cn(
            "relative flex w-full min-w-0 items-center overflow-hidden rounded-md border transition",
            // Rows always sit inside a section card, so they use the borderless grouped style.
            highlighted
              ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)]"
              : "border-transparent bg-[var(--ec-panel)] hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-control)]",
          )}
        >
          <div className="min-w-0 flex-1">
            <HoverCard content={<AgentRunHoverCard projectName={project.project.name} run={run} providerType={providerTypeByAccountId.get(run.providerAccountId)} />}>
              {trigger}
            </HoverCard>
          </div>
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

  const showRunProjectNames = !scopedProjectId && projects.length > 1;
  const orderedRunSections = uncategorizedLast ? [...runSections.sections, null] : [null, ...runSections.sections];
  const sidebarRunSectionGroups: SidebarRunSectionGroup[] = orderedRunSections.map((section) => {
    const group = sectionRunRows.get(section?.id ?? null);
    return {
      section,
      rootCount: group?.rootCount ?? 0,
      rows: (group?.rows ?? []).map(({ project, row, sectionRunId }) =>
        renderRecentRunEntry(project, row, showRunProjectNames, sectionRunId)),
    };
  });
  const contextMenuRun = contextMenu
    ? projects.flatMap((entry) => entry.runs).find((run) => run.id === contextMenu.sectionRunId) ?? null
    : null;
  const contextMenuSectionId = contextMenuRun ? resolveRunSidebarSectionId(contextMenuRun, runSectionIds, pendingSectionMoves) : null;
  const contextMenuSectionTargets = contextMenuRun && canMoveRunsToSections
    ? orderedRunSections.filter((section) => (section?.id ?? null) !== contextMenuSectionId)
    : [];

  if (collapsed) {
    return (
      <aside className="flex min-h-0 w-[46px] shrink-0 flex-col border-r border-[var(--ec-border)] bg-[var(--ec-sidebar)] transition-colors duration-150 sm:w-[50px]">
        <div className="flex h-12 items-center justify-center border-b border-[var(--ec-border)]">
          <button
            className="flex size-8 items-center justify-center rounded-md text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
            onClick={onToggleCollapsed}
            type="button"
            aria-label="Expand sidebar"
          >
            <ChevronsRight className="size-4" />
          </button>
        </div>
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
        <div className="flex flex-col items-center gap-1 border-t border-[var(--ec-border)] py-2">
          {workspaceLinks.map((link) => (
            <SidebarUtilityButton key={link.label} {...link} collapsed={collapsed} />
          ))}
          {parseAttentionInboxSettings(attentionInboxSetting).enabled && <AttentionInbox key={attentionInboxSetting} client={buildwarden} compact={collapsed} triggerVariant="sidebar" onOpenRun={onSelectRun} />}
          {buildwarden.capabilities.settings && (
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
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col border-r border-[var(--ec-border)] bg-[var(--ec-sidebar)] text-[var(--ec-text)] transition-colors duration-150",
        isWeb && "max-[899px]:fixed max-[899px]:inset-y-0 max-[899px]:left-0 max-[899px]:z-50 max-[899px]:max-w-[calc(100vw-3rem)] max-[899px]:shadow-2xl",
      )}
      style={{ width }}
    >
      <div ref={projectMenuRef} className="relative shrink-0 border-b border-[var(--ec-border)] p-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2.5 text-left transition hover:bg-[var(--ec-control)]"
            onClick={() => setProjectMenuOpen((current) => !current)}
            aria-expanded={projectMenuOpen}
          >
            <FolderGit2 className="size-4 shrink-0 text-[var(--ec-accent)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-[var(--ec-text)]">{selectedProject?.project.name ?? "Select project"}</span>
              <span className="block truncate font-mono text-[10px] text-[var(--ec-muted)]">
                {selectedProjectContext}
              </span>
            </span>
            <ChevronDown className={cn("size-3.5 shrink-0 text-[var(--ec-muted)] transition", projectMenuOpen && "rotate-180")} />
          </button>
          <button
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent text-[var(--ec-muted)] transition hover:border-[var(--ec-border)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
            onClick={onToggleCollapsed}
            type="button"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <ChevronsLeft className="size-4" />
          </button>
        </div>
        {projectMenuOpen ? (
          <div className="absolute left-2 right-12 top-[calc(100%-0.25rem)] z-50 glass-popover overflow-hidden py-1">
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
                        {selected ? selectedProjectContext : entry.project.kind === "folder" ? "Folder" : "Git repository"}
                      </span>
                    </span>
                    {selected ? <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ec-accent)]">Active</span> : null}
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-3 text-xs text-[var(--ec-muted)]">No projects yet.</div>
            )}
          </div>
        ) : null}
      </div>

      {selectedProject ? (
        <div className="shrink-0 px-2 py-1.5">
          <div className="flex h-6 min-w-0 items-center gap-1 px-1">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ec-faint)]">Project</span>
            <span className="min-w-0 flex-1" />
            {canStartRuns ? (
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
                onClick={() => selectProjectFeature(selectedProject.project.id, "overview")}
                aria-label="Start new agent run"
                title="New agent run"
              >
                <Plus className="size-3.5" />
              </button>
            ) : null}
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
              onClick={() => selectProjectFeature(selectedProject.project.id, "settings")}
              aria-label="Open project settings"
              title={isWeb && !buildwarden.capabilities.projectSettingsMutations ? "Project settings (limited remote access)" : "Project settings"}
            >
              <Settings className="size-3.5" />
            </button>
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
              onClick={() => setProjectToolsExpanded((current) => !current)}
              aria-expanded={projectToolsExpanded}
              aria-label={projectToolsExpanded ? "Collapse project navigation" : "Expand project navigation"}
              title={projectToolsExpanded ? "Collapse project navigation" : "Expand project navigation"}
            >
              {projectToolsExpanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
            </button>
          </div>
          {projectToolsExpanded ? (
            <div className="mt-1 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-1 shadow-[var(--ec-panel-shadow)]">
              <div className="space-y-0.5">
                {visibleProjectTools.map((tool) => {
                  const Icon = tool.icon;
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
                    <button
                      key={tool.tab}
                      type="button"
                      className={cn(
                        "flex h-[26px] w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] transition",
                        active
                          ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]"
                          : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
                      )}
                      onClick={() => selectProjectFeature(selectedProject.project.id, tool.tab)}
                    >
                      <Icon className={cn("size-3.5 shrink-0", active ? "text-[var(--ec-accent)]" : "text-[var(--ec-faint)]")} />
                      <span className="min-w-0 flex-1 truncate">{tool.label}</span>
                      {typeof count === "number" && count > 0 ? (
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-px font-mono text-[9px] leading-3 tabular-nums",
                            active ? "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]" : "bg-[var(--ec-control)] text-[var(--ec-muted)]",
                          )}
                        >
                          {count > 99 ? "99+" : count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <Separator />

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto py-1.5 [scrollbar-gutter:stable]">
        <SidebarRunSections
          projects={sortedProjectsForDropdown.map((entry) => ({ id: entry.project.id, name: entry.project.name }))}
          projectScopeId={scopedProjectId}
          view={runView}
          viewCounts={runViewCounts}
          config={runSections}
          groups={sidebarRunSectionGroups}
          recentRunWindowLabel={`last ${recentRunWindowLabel}`}
          emptyMessage={`${hideActiveRuns ? "No inactive runs" : "No runs"} in the last ${recentRunWindowLabel}.`}
          canEditSections={canEditRunSections}
          canMoveRuns={canMoveRunsToSections}
          groupGapClassName={runEntryStyles.groupGap}
          rowGapClassName={runEntryStyles.rowGap}
          onProjectScopeChange={(projectId) => void onSidebarSettingChange(APP_SETTING_KEYS.sidebarRunProjectScope, projectId ?? "")}
          onViewChange={(view) => void onSidebarSettingChange(APP_SETTING_KEYS.sidebarRunView, view)}
          onConfigChange={updateRunSections}
          onMoveRun={moveRunToSection}
        />
      </div>

      <div className="shrink-0 border-t border-[var(--ec-border)] px-2 py-1.5">
        <div className="flex min-w-0 flex-nowrap items-center gap-1">
          {workspaceLinks.map((link) => (
            <SidebarUtilityButton key={link.label} {...link} collapsed={collapsed} />
          ))}
          {parseAttentionInboxSettings(attentionInboxSetting).enabled && <AttentionInbox key={attentionInboxSetting} client={buildwarden} compact={collapsed} triggerVariant="sidebar" onOpenRun={onSelectRun} />}
          {buildwarden.capabilities.settings && (
            <SidebarUtilityButton label="Settings" icon={Settings} selected={settingsSelected} onClick={onOpenSettings} collapsed={collapsed} />
          )}
        </div>
      </div>

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
                className="fixed z-[30001] min-w-[11rem] glass-popover py-1"
                style={{ left: contextMenu.x, top: contextMenu.y }}
              >
                {canStartRuns ? (
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
                    Continue run
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
                {contextMenuSectionTargets.length > 0 ? (
                  <>
                    <Separator className="my-1" />
                    <div className="flex items-center gap-2 px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">
                      <FolderInput className="size-3" />
                      Move to section
                    </div>
                    <div className="app-scrollbar max-h-48 overflow-y-auto">
                      {contextMenuSectionTargets.map((section) => (
                        <button
                          key={section?.id ?? "uncategorized"}
                          className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)]"
                          onClick={() => {
                            moveRunToSection(contextMenu.sectionRunId, section?.id ?? null);
                            setContextMenu(null);
                          }}
                          type="button"
                        >
                          <span className={cn("size-2 shrink-0 rounded-sm", section ? SIDEBAR_RUN_SECTION_COLOR_CLASSES[section.color] : "bg-[var(--ec-faint)]")} />
                          <span className="min-w-0 flex-1 truncate">{section?.name ?? "Uncategorized"}</span>
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
                {canStartRuns ? (
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
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize"
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
