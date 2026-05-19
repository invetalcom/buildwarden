import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { AppSnapshot } from "@easycode/shared";
import {
  Archive,
  Bookmark,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock3,
  FolderGit2,
  Home,
  MessageSquare,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";
import { cn } from "../../lib/cn";

const MIN_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 800;
const ACTIVE_RUN_STATUSES = new Set(["queued", "preparing", "running"]);

type SidebarRun = AppSnapshot["projects"][number]["runs"][number];
type RunContextMenuState = {
  projectId: string;
  runId: string;
  runStatus: SidebarRun["status"];
  workspaceType: SidebarRun["workspaceType"];
  x: number;
  y: number;
};

interface SidebarProps {
  projects: AppSnapshot["projects"];
  landingSelected: boolean;
  bookmarksSelected: boolean;
  chatsSelected: boolean;
  settingsSelected: boolean;
  selectedProjectId: string | null;
  /** When set, the run row with this id is emphasized (agent run detail is open). */
  highlightedRunId: string | null;
  collapsed: boolean;
  width: number;
  bookmarksCount: number;
  chatsCount: number;
  bookmarkedRunIds: Set<string>;
  onSelectLanding: () => void;
  onSelectBookmarks: () => void;
  onSelectChats: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectRun: (projectId: string, runId: string) => void;
  onReorderProjects: (projectIds: string[]) => void;
  onAddRunToBookmarks: (projectId: string, runId: string) => void;
  onRemoveRunFromBookmarks: (runId: string) => void;
  onContinueRun: (projectId: string, runId: string) => void;
  onDeleteRun: (projectId: string, runId: string) => void;
  onSetRunForLater: (projectId: string, runId: string) => void;
  /** Run IDs currently being deleted in the background (disable duplicate deletes). */
  pendingDeleteRunIds: Record<string, boolean>;
  onOpenSettings: () => void;
  onWidthChange: (width: number) => void;
  onToggleCollapsed: () => void;
}

export const Sidebar = ({
  projects,
  landingSelected,
  bookmarksSelected,
  chatsSelected,
  settingsSelected,
  selectedProjectId,
  highlightedRunId,
  collapsed,
  width,
  bookmarksCount,
  chatsCount,
  bookmarkedRunIds,
  onSelectLanding,
  onSelectBookmarks,
  onSelectChats,
  onSelectProject,
  onSelectRun,
  onReorderProjects,
  onAddRunToBookmarks,
  onRemoveRunFromBookmarks,
  onContinueRun,
  onDeleteRun,
  onSetRunForLater,
  pendingDeleteRunIds,
  onOpenSettings,
  onWidthChange,
  onToggleCollapsed,
}: SidebarProps) => {
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<RunContextMenuState | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

  const expandedState = useMemo(() => {
    return Object.fromEntries(projects.map((project) => [project.project.id, expandedProjects[project.project.id] ?? true]));
  }, [expandedProjects, projects]);

  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjects((current) => ({
      ...current,
      [projectId]: !(current[projectId] ?? true),
    }));
  };

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const start = resizeStartRef.current;
      if (!start) {
        return;
      }

      const nextWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, start.width + event.clientX - start.x));
      onWidthChange(nextWidth);
    };

    const stopResizing = () => {
      setIsResizing(false);
      resizeStartRef.current = null;
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
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, onWidthChange]);

  const startResizing = (event: ReactMouseEvent<HTMLDivElement>) => {
    resizeStartRef.current = { x: event.clientX, width };
    setIsResizing(true);
  };

  const moveProject = (sourceProjectId: string, targetProjectId: string) => {
    if (sourceProjectId === targetProjectId) {
      return;
    }
    const sourceIndex = projects.findIndex((project) => project.project.id === sourceProjectId);
    const targetIndex = projects.findIndex((project) => project.project.id === targetProjectId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }
    const nextProjects = [...projects];
    const [moved] = nextProjects.splice(sourceIndex, 1);
    nextProjects.splice(targetIndex, 0, moved);
    onReorderProjects(nextProjects.map((project) => project.project.id));
  };

  const resetProjectDragState = () => {
    setDraggedProjectId(null);
    setDragOverProjectId(null);
  };

  const formatRelativeTime = (dateString: string | null) => {
    if (!dateString) {
      return "just now";
    }

    const diffMs = Date.now() - new Date(dateString).getTime();
    const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

    if (diffMinutes < 1) {
      return "just now";
    }

    if (diffMinutes < 60) {
      return `${diffMinutes}m ago`;
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  const formatRunDuration = (run: AppSnapshot["projects"][number]["runs"][number]) => {
    const start = new Date(run.startedAt ?? run.createdAt).getTime();
    const end = new Date(run.finishedAt ?? run.updatedAt).getTime();
    const diffMs = Math.max(0, end - start);
    const totalSeconds = Math.floor(diffMs / 1000);

    if (totalSeconds < 5) {
      return "< 5s";
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
  };

  const getRunDotClassName = (status: AppSnapshot["projects"][number]["runs"][number]["status"]) => {
    if (status === "completed") {
      return "run-status-dot run-status-dot--completed bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.14)]";
    }

    if (status === "failed") {
      return "run-status-dot run-status-dot--failed bg-rose-400 shadow-[0_0_0_3px_rgba(251,113,133,0.14)]";
    }

    if (status === "cancelled") {
      return "run-status-dot run-status-dot--cancelled bg-zinc-400 shadow-[0_0_0_3px_rgba(161,161,170,0.14)]";
    }

    if (status === "preparing") {
      return "run-status-dot run-status-dot--preparing bg-sky-400 shadow-[0_0_0_3px_rgba(56,189,248,0.14)]";
    }

    if (status === "running") {
      return "run-status-dot run-status-dot--running bg-cyan-400 shadow-[0_0_0_3px_rgba(34,211,238,0.14)]";
    }

    return "run-status-dot run-status-dot--queued bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.14)]";
  };

  const buildVisibleRunRows = (runs: SidebarRun[]) => {
    const runById = new Map(runs.map((run) => [run.id, run]));
    const childrenByParentId = new Map<string, SidebarRun[]>();

    for (const run of runs) {
      if (!run.parentRunId || !runById.has(run.parentRunId)) {
        continue;
      }
      const children = childrenByParentId.get(run.parentRunId) ?? [];
      children.push(run);
      childrenByParentId.set(run.parentRunId, children);
    }

    for (const children of childrenByParentId.values()) {
      children.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }

    const rows: Array<{ run: SidebarRun; depth: number; hasChildren: boolean; continuationIndex: number | null }> = [];
    const visit = (run: SidebarRun, depth: number, continuationIndex: number | null = null) => {
      const children = childrenByParentId.get(run.id) ?? [];
      rows.push({
        run,
        depth,
        hasChildren: children.length > 0,
        continuationIndex,
      });
      for (const [index, child] of children.entries()) {
        visit(child, depth + 1, index);
      }
    };

    runs
      .filter((run) => !run.parentRunId || !runById.has(run.parentRunId))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .forEach((run) => visit(run, 0));

    return rows;
  };

  const getDirectContinuationCount = (runs: SidebarRun[], parentRunId: string) => {
    return runs.filter((run) => run.parentRunId === parentRunId).length;
  };

  if (collapsed) {
    return (
      <aside className="glass-island flex min-h-0 w-[68px] shrink-0 flex-col items-center px-2 py-3">
        <button
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/80 text-zinc-300 transition hover:bg-zinc-800"
          onClick={onToggleCollapsed}
          type="button"
        >
          <ChevronsRight className="h-4 w-4" />
        </button>

        <div className="app-scrollbar mt-4 flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto">
          <button
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-xl border transition",
              landingSelected
                ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800",
            )}
            onClick={onSelectLanding}
            title="Starting page"
            type="button"
          >
            <Home className="h-4 w-4" />
          </button>

          <div className="h-1" />

          {projects.map((entry) => {
            const isSelected = !landingSelected && entry.project.id === selectedProjectId;
            const label = entry.project.name.slice(0, 1).toUpperCase() || "P";
            const hasActiveRuns = entry.activeRuns.length > 0;
            const hasHighlightedRun =
              highlightedRunId != null && entry.runs.some((r) => r.id === highlightedRunId);

            return (
              <button
                key={entry.project.id}
                className={cn(
                  "relative flex h-9 w-9 items-center justify-center rounded-xl border text-xs font-semibold transition",
                  draggedProjectId === entry.project.id ? "opacity-60" : undefined,
                  dragOverProjectId === entry.project.id ? "border-cyan-400/80 ring-2 ring-cyan-500/30" : undefined,
                  isSelected
                    ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                    : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800",
                )}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", entry.project.id);
                  setDraggedProjectId(entry.project.id);
                  setDragOverProjectId(entry.project.id);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (draggedProjectId && draggedProjectId !== entry.project.id) {
                    event.dataTransfer.dropEffect = "move";
                    setDragOverProjectId(entry.project.id);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceProjectId = event.dataTransfer.getData("text/plain") || draggedProjectId;
                  if (sourceProjectId) {
                    moveProject(sourceProjectId, entry.project.id);
                  }
                  resetProjectDragState();
                }}
                onDragEnd={resetProjectDragState}
                onClick={() => onSelectProject(entry.project.id)}
                title={entry.project.name}
                type="button"
              >
                {entry.runs.length > 0 ? (
                  <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full border border-zinc-800 bg-zinc-800 px-0.5 text-[9px] font-medium text-zinc-300">
                    {entry.runs.length > 99 ? "99+" : entry.runs.length}
                  </span>
                ) : null}
                {hasActiveRuns ? <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-cyan-400" /> : null}
                {hasHighlightedRun ? (
                  <span
                    className="absolute bottom-0 left-1/2 h-1.5 w-3 -translate-x-1/2 translate-y-px rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.5)]"
                    title="Agent run open"
                    aria-hidden
                  />
                ) : null}
                {label}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-col items-center gap-2">
          <button
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded-xl border transition",
              bookmarksSelected
                ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800",
            )}
            onClick={onSelectBookmarks}
            title="Bookmarks"
            type="button"
          >
            <Bookmark className="h-4 w-4" />
            {bookmarksCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full border border-zinc-800 bg-zinc-800 px-0.5 text-[9px] font-medium text-zinc-300">
                {bookmarksCount > 99 ? "99+" : bookmarksCount}
              </span>
            ) : null}
          </button>
          <button
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded-xl border transition",
              chatsSelected
                ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800",
            )}
            onClick={onSelectChats}
            title="Chat"
            type="button"
          >
            <MessageSquare className="h-4 w-4" />
            {chatsCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full border border-zinc-800 bg-zinc-800 px-0.5 text-[9px] font-medium text-zinc-300">
                {chatsCount > 99 ? "99+" : chatsCount}
              </span>
            ) : null}
          </button>
          <button
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-xl border transition",
              settingsSelected
                ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800",
            )}
            onClick={onOpenSettings}
            title="Settings"
            type="button"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="glass-island relative flex min-h-0 shrink-0 flex-col px-3 py-2.5" style={{ width }}>
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.28em] text-zinc-500">by invetalcom</p>
          <h1 className="mt-0.5 text-[1.0625rem] font-semibold leading-tight">EasyCode</h1>
        </div>
        <button
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/70 text-zinc-300 transition hover:bg-zinc-800"
          onClick={onToggleCollapsed}
          type="button"
        >
          <ChevronsLeft className="h-4 w-4" />
        </button>
      </div>

      <div className="app-scrollbar min-h-0 flex-1 space-y-[7px] overflow-y-auto pr-0.5">
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-2 rounded-xl border px-2.5 py-[7px] text-left text-xs transition",
            landingSelected
              ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-100"
              : "border-zinc-800 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800",
          )}
          onClick={onSelectLanding}
        >
          <Home className={cn("h-3.5 w-3.5 shrink-0", landingSelected ? "text-cyan-300" : "text-zinc-500")} />
          <div className="min-w-0 leading-tight">
            <p className="font-medium leading-tight">Starting page</p>
            <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">Overview across all projects</p>
          </div>
        </button>

        <div className="h-0.5" />

        {projects.map((entry) => (
          <Card
            key={entry.project.id}
            className={cn(
              "p-[7px]",
              draggedProjectId === entry.project.id ? "opacity-60" : undefined,
              dragOverProjectId === entry.project.id ? "border-cyan-400/70 ring-2 ring-cyan-500/20" : undefined,
              !landingSelected && entry.project.id === selectedProjectId ? "border-cyan-500/40 bg-cyan-500/5" : undefined,
            )}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", entry.project.id);
              setDraggedProjectId(entry.project.id);
              setDragOverProjectId(entry.project.id);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (draggedProjectId && draggedProjectId !== entry.project.id) {
                event.dataTransfer.dropEffect = "move";
                setDragOverProjectId(entry.project.id);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceProjectId = event.dataTransfer.getData("text/plain") || draggedProjectId;
              if (sourceProjectId) {
                moveProject(sourceProjectId, entry.project.id);
              }
              resetProjectDragState();
            }}
            onDragEnd={resetProjectDragState}
          >
            <div className="flex items-center justify-between gap-2">
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => onSelectProject(entry.project.id)}
                type="button"
              >
                <div>
                  <div className="flex items-center gap-1.5">
                    <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                    <p className="truncate text-sm font-medium leading-tight">{entry.project.name}</p>
                    <span className="flex h-3.5 min-w-[1rem] shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800/80 px-1 text-[10px] font-medium text-zinc-400 tabular-nums">
                      {entry.runs.length}
                    </span>
                  </div>
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <Badge
                  tone={entry.activeRuns[0]?.status ?? "running"}
                  className={cn(
                    "px-1.5 py-0 text-[10px]",
                    entry.activeRuns.length === 0 ? "bg-sky-500/10 text-sky-300 ring-sky-400/30" : undefined,
                  )}
                >
                  {entry.activeRuns.length > 0 ? `${entry.activeRuns.length} active` : "idle"}
                </Badge>
                <button
                  className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-900 hover:text-cyan-300"
                  onClick={() => void onSelectProject(entry.project.id)}
                  title="New agent run"
                  aria-label="New agent run"
                  type="button"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
                </button>
                <button
                  className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
                  onClick={() => toggleProjectExpanded(entry.project.id)}
                  title={expandedState[entry.project.id] ? "Collapse runs" : "Expand runs"}
                  aria-label={expandedState[entry.project.id] ? "Collapse runs" : "Expand runs"}
                  type="button"
                >
                  {expandedState[entry.project.id] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            {expandedState[entry.project.id] ? (
              <div className="mt-[7px] space-y-0.5">
                {buildVisibleRunRows(entry.runs).map(({ run, depth, hasChildren, continuationIndex }) => {
                  const isHighlightedRun = highlightedRunId != null && run.id === highlightedRunId;
                  const isActiveRun = ACTIVE_RUN_STATUSES.has(run.status);
                  const isContinuation = depth > 0 || Boolean(run.parentRunId);
                  const parentMissing = Boolean(run.parentRunId && !entry.runs.some((candidate) => candidate.id === run.parentRunId));
                  const continuationCount = hasChildren ? getDirectContinuationCount(entry.runs, run.id) : 0;
                  const continuationLabel =
                    depth > 0 && continuationIndex !== null
                      ? `Continuation ${continuationIndex + 1}`
                      : parentMissing
                        ? "Continued run"
                        : hasChildren
                          ? `${continuationCount} continuation${continuationCount === 1 ? "" : "s"}`
                          : null;
                  return (
                    <div key={run.id} className="relative min-w-0">
                      {depth > 0 ? (
                        <>
                          <span
                            className="pointer-events-none absolute bottom-0 top-0 w-px bg-zinc-700/70"
                            style={{ left: `${depth * 11 + 2}px` }}
                            aria-hidden
                          />
                          <span
                            className="pointer-events-none absolute h-px bg-zinc-700/70"
                            style={{ left: `${depth * 11 + 2}px`, top: "50%", width: "8px" }}
                            aria-hidden
                          />
                        </>
                      ) : null}
                      <button
                        className={cn(
                          "relative flex w-full min-w-0 items-center justify-between rounded-md py-[5px] pr-2 text-left transition",
                          isHighlightedRun
                            ? "border border-cyan-500/45 bg-cyan-500/10 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.12)] hover:bg-cyan-500/[0.14]"
                            : depth > 0
                              ? "border border-transparent bg-transparent text-zinc-300 hover:border-zinc-800/70 hover:bg-zinc-900/70"
                              : hasChildren
                                ? "border border-zinc-800/80 bg-zinc-900/70 shadow-[inset_2px_0_0_rgba(34,211,238,0.22)] hover:bg-zinc-900"
                              : "app-surface-sidebar-run",
                        )}
                        style={{ paddingLeft: `${7 + depth * 16}px` }}
                        onClick={() => onSelectRun(entry.project.id, run.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({
                            projectId: entry.project.id,
                            runId: run.id,
                            runStatus: run.status,
                            workspaceType: run.workspaceType,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                        type="button"
                        title={isHighlightedRun ? "Currently open run" : undefined}
                        aria-current={isHighlightedRun ? "true" : undefined}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <p className={cn("truncate text-xs leading-snug", isContinuation ? "font-normal" : "font-medium")}>
                              {run.prompt}
                            </p>
                          </div>
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-snug text-zinc-500">
                            {continuationLabel ? (
                              <>
                                <span className={cn("max-w-[45%] truncate", depth > 0 ? "text-cyan-300/75" : "text-zinc-400")}>
                                  {continuationLabel}
                                </span>
                                <span className="shrink-0 text-zinc-700">/</span>
                              </>
                            ) : null}
                            <Clock3 className="h-2.5 w-2.5 shrink-0 text-zinc-500" />
                            <span className="min-w-0 truncate tabular-nums">
                              {formatRunDuration(run)}
                              {isActiveRun ? " so far" : ""}
                              <span className="text-zinc-600">{" · "}</span>
                              {formatRelativeTime(run.finishedAt ?? run.updatedAt)}
                            </span>
                          </div>
                        </div>
                        <span className={cn("ml-2 h-[7.5px] w-[7.5px] shrink-0 rounded-full", getRunDotClassName(run.status))} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </Card>
        ))}
      </div>

      <div className="mt-2 flex gap-1">
        <button
          className={cn(
            "relative flex min-h-[34px] flex-1 items-center justify-center rounded-lg border py-2 text-xs transition",
            chatsSelected
              ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-100"
              : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800",
          )}
          onClick={onSelectChats}
          title="Chat"
          aria-label="Chat"
          type="button"
        >
          <MessageSquare className={cn("h-3.5 w-3.5 shrink-0", chatsSelected ? "text-cyan-300" : "text-zinc-300")} />
          {chatsCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full border border-zinc-800 bg-zinc-800 px-0.5 text-[9px] font-medium text-zinc-300 tabular-nums">
              {chatsCount > 99 ? "99+" : chatsCount}
            </span>
          ) : null}
        </button>
        <button
          className={cn(
            "relative flex min-h-[34px] flex-1 items-center justify-center rounded-lg border py-2 text-xs transition",
            bookmarksSelected
              ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-100"
              : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800",
          )}
          onClick={onSelectBookmarks}
          title="Bookmarks"
          aria-label="Bookmarks"
          type="button"
        >
          <Bookmark className={cn("h-3.5 w-3.5 shrink-0", bookmarksSelected ? "text-cyan-300" : "text-zinc-300")} />
          {bookmarksCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full border border-zinc-800 bg-zinc-800 px-0.5 text-[9px] font-medium text-zinc-300 tabular-nums">
              {bookmarksCount > 99 ? "99+" : bookmarksCount}
            </span>
          ) : null}
        </button>
        <button
          className={cn(
            "relative flex min-h-[34px] flex-1 items-center justify-center rounded-lg border py-2 text-xs transition",
            settingsSelected
              ? "border-cyan-500/60 bg-cyan-500/12 text-cyan-200"
              : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800",
          )}
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
          type="button"
        >
          <Settings className={cn("h-3.5 w-3.5 shrink-0", settingsSelected ? "text-cyan-300" : "text-zinc-300")} />
        </button>
      </div>

      {contextMenu ? createPortal(
        <>
          <div
            className="fixed inset-0 z-[30000]"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(null);
            }}
            role="presentation"
          />
          <div
            className="fixed z-[30001] min-w-[10rem] rounded-lg border border-zinc-800 bg-zinc-900 py-0.5 shadow-2xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800",
                ACTIVE_RUN_STATUSES.has(contextMenu.runStatus)
                  ? "cursor-not-allowed opacity-50 hover:bg-transparent"
                  : undefined,
              )}
              disabled={ACTIVE_RUN_STATUSES.has(contextMenu.runStatus)}
              onClick={() => {
                onContinueRun(contextMenu.projectId, contextMenu.runId);
                setContextMenu(null);
              }}
              type="button"
              title={
                ACTIVE_RUN_STATUSES.has(contextMenu.runStatus)
                    ? "Only available when the run is finished."
                    : undefined
              }
            >
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              Continue as new run
            </button>
            {bookmarkedRunIds.has(contextMenu.runId) ? (
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
                onClick={() => {
                  onRemoveRunFromBookmarks(contextMenu.runId);
                  setContextMenu(null);
                }}
                type="button"
              >
                <Bookmark className="h-3.5 w-3.5 fill-current" />
                Remove from bookmarks
              </button>
            ) : (
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
                onClick={() => {
                  onAddRunToBookmarks(contextMenu.projectId, contextMenu.runId);
                  setContextMenu(null);
                }}
                type="button"
              >
                <Bookmark className="h-3.5 w-3.5" />
                Add to bookmarks
              </button>
            )}
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
              onClick={() => {
                onSetRunForLater(contextMenu.projectId, contextMenu.runId);
                setContextMenu(null);
              }}
              type="button"
            >
              <Archive className="h-3.5 w-3.5 shrink-0" />
              Move to For later
            </button>
            <div className="my-0.5 border-t border-zinc-800" role="separator" />
            <button
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-rose-300 hover:bg-rose-500/10",
                pendingDeleteRunIds[contextMenu.runId] ? "opacity-60" : undefined,
              )}
              disabled={Boolean(pendingDeleteRunIds[contextMenu.runId])}
              onClick={() => {
                onDeleteRun(contextMenu.projectId, contextMenu.runId);
                setContextMenu(null);
              }}
              type="button"
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" />
              {pendingDeleteRunIds[contextMenu.runId] ? "Deleting…" : "Delete run"}
            </button>
          </div>
        </>
      , document.body) : null}

      <div
        className={cn(
          "absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 cursor-col-resize transition",
          isResizing ? "bg-cyan-500/20" : "hover:bg-cyan-500/10",
        )}
        onMouseDown={startResizing}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      />
    </aside>
  );
};
