import type { ProjectTaskRecord, ProjectTaskStatus, ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { Check, ExternalLink, Eye, GripVertical, ListTodo, Loader2, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { cn } from "../../lib/cn";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { BetaBadge } from "./BetaBadge";

interface ProjectTasksTabProps {
  projectId: string;
  tasks: ProjectTaskRecord[];
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultTaskModelId: string;
  busy: boolean;
  onCreateTask: (input: { title: string; prompt: string }) => void | Promise<void>;
  onUpdateTask: (taskId: string, input: { title?: string; prompt?: string; status?: ProjectTaskStatus }) => void | Promise<void>;
  onDeleteTask: (taskId: string) => void | Promise<void>;
  onStartTask: (taskId: string, prompt: string, modelId: string) => void | Promise<void>;
}

const LANES: Array<{ status: ProjectTaskStatus; label: string; dot: string }> = [
  { status: "open", label: "Open", dot: "bg-zinc-500" },
  { status: "in_progress", label: "In Progress", dot: "bg-cyan-400" },
  { status: "in_review", label: "In Review", dot: "bg-amber-400" },
  { status: "done", label: "Done", dot: "bg-emerald-400" },
];

const statusOptions = LANES.map((lane) => ({ value: lane.status, label: lane.label }));

const buildTaskModelSelections = (
  tasks: ProjectTaskRecord[],
  current: Record<string, string>,
  validModelIds: Set<string>,
  defaultTaskModelId: string,
): Record<string, string> => Object.fromEntries(tasks.map((task) => {
  const candidate = current[task.id];
  return [task.id, candidate && validModelIds.has(candidate) ? candidate : defaultTaskModelId];
}));

const isTaskPending = (task: ProjectTaskRecord | null, pendingTaskIds: Set<string>) =>
  task ? pendingTaskIds.has(task.id) : false;

const useTaskModelSelections = (
  tasks: ProjectTaskRecord[],
  modelOptions: ProjectTasksTabProps["modelOptions"],
  defaultTaskModelId: string,
) => {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const validModelIds = useMemo(() => new Set(modelOptions.map((option) => option.id)), [modelOptions]);
  useEffect(() => {
    setSelections((current) => buildTaskModelSelections(tasks, current, validModelIds, defaultTaskModelId));
  }, [defaultTaskModelId, tasks, validModelIds]);
  return [selections, setSelections] as const;
};

interface TaskBoardCardProps {
  task: ProjectTaskRecord;
  busy: boolean;
  isTaskBusy: boolean;
  hasModels: boolean;
  canManageTasks: boolean;
  canStartRuns: boolean;
  isDragged: boolean;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onLaunch: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

const TaskBoardCard = ({
  task, busy, isTaskBusy, hasModels, isDragged,
  canManageTasks, canStartRuns,
  onView, onEdit, onDelete, onLaunch, onDragStart, onDragEnd,
}: TaskBoardCardProps) => {
  const buildwarden = useBuildWardenClient();
  return (
    <article draggable={canManageTasks && !isTaskBusy} onDragStart={onDragStart} onDragEnd={onDragEnd} className={cn("task-board-card group rounded-md border p-2.5 transition", isDragged && "opacity-45")}>
      <div className="flex items-start gap-1.5">
        {canManageTasks ? <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-grab text-zinc-700 group-hover:text-zinc-500" /> : null}
        <div className="min-w-0 flex-1 overflow-hidden">
          <h5 className="max-h-10 overflow-hidden break-words text-xs font-semibold leading-5 text-zinc-100">{task.title}</h5>
          <p className="mt-1 max-h-12 overflow-hidden break-words whitespace-pre-wrap text-[11px] leading-4 text-zinc-400">{task.prompt}</p>
        </div>
        {isTaskBusy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" /> : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-1 border-t border-zinc-800/80 pt-2">
        <div className="flex items-center gap-0.5">
          <Button type="button" size="sm" variant="ghost" className="task-card-action h-7 w-7 p-0" title="View task" aria-label={`View ${task.title}`} onClick={onView}><Eye className="h-3.5 w-3.5" /></Button>
          {task.pullRequestUrl ? <Button type="button" size="sm" variant="ghost" className="task-card-action h-7 w-7 p-0" title="Open linked PR/MR" onClick={() => void buildwarden.openExternalUrl(task.pullRequestUrl!)}><ExternalLink className="h-3.5 w-3.5" /></Button> : null}
          {canManageTasks ? <>
            <Button type="button" size="sm" variant="ghost" className="task-card-action h-7 w-7 p-0" title="Edit task" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button type="button" size="sm" variant="ghost" className="task-card-action task-card-action--danger h-7 w-7 p-0" title="Delete task" disabled={isTaskBusy} onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></Button>
          </> : null}
        </div>
        {canStartRuns ? <Button type="button" size="sm" variant="secondary" className="h-7 px-2 text-[11px]" disabled={busy || isTaskBusy || !hasModels} onClick={onLaunch}><Play className="h-3 w-3" />Start run</Button> : null}
      </div>
    </article>
  );
};

interface TaskBoardProps {
  tasks: ProjectTaskRecord[];
  pendingTaskIds: Set<string>;
  busy: boolean;
  hasModels: boolean;
  canManageTasks: boolean;
  canStartRuns: boolean;
  draggedTaskId: string | null;
  dragOverStatus: ProjectTaskStatus | null;
  onView: (taskId: string) => void;
  onEdit: (task: ProjectTaskRecord) => void;
  onDelete: (taskId: string) => void | Promise<void>;
  onLaunch: (task: ProjectTaskRecord) => void;
  onDraggedTaskChange: (taskId: string | null) => void;
  onDragOverStatusChange: (status: ProjectTaskStatus | null) => void;
  onDrop: (event: DragEvent<HTMLDivElement>, status: ProjectTaskStatus) => void;
}

const confirmTaskDeletion = (task: ProjectTaskRecord, onDelete: TaskBoardProps["onDelete"]) => {
  if (window.confirm(`Delete “${task.title}”?`)) {
    void onDelete(task.id);
  }
};

const handleTaskLaneDragLeave = (
  event: DragEvent<HTMLDivElement>,
  onDragOverStatusChange: TaskBoardProps["onDragOverStatusChange"],
) => {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
    onDragOverStatusChange(null);
  }
};

const getEmptyTaskLaneText = (draggedTaskId: string | null, laneLabel: string) =>
  draggedTaskId ? `Move to ${laneLabel}` : "No tasks";

interface TaskBoardLaneProps extends Omit<TaskBoardProps, "tasks"> {
  lane: (typeof LANES)[number];
  tasks: ProjectTaskRecord[];
}

interface ConnectedTaskBoardCardProps extends Omit<TaskBoardLaneProps, "lane" | "tasks" | "dragOverStatus" | "onDrop"> {
  task: ProjectTaskRecord;
}

const ConnectedTaskBoardCard = ({
  task, pendingTaskIds, busy, hasModels, draggedTaskId,
  canManageTasks, canStartRuns,
  onView, onEdit, onDelete, onLaunch, onDraggedTaskChange, onDragOverStatusChange,
}: ConnectedTaskBoardCardProps) => {
  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/buildwarden-project-task", task.id);
    onDraggedTaskChange(task.id);
  };
  const handleDragEnd = () => {
    onDraggedTaskChange(null);
    onDragOverStatusChange(null);
  };
  return <TaskBoardCard task={task} busy={busy} isTaskBusy={pendingTaskIds.has(task.id)} hasModels={hasModels} canManageTasks={canManageTasks} canStartRuns={canStartRuns} isDragged={draggedTaskId === task.id} onView={() => onView(task.id)} onEdit={() => onEdit(task)} onDelete={() => confirmTaskDeletion(task, onDelete)} onLaunch={() => onLaunch(task)} onDragStart={handleDragStart} onDragEnd={handleDragEnd} />;
};

const TaskBoardLane = ({
  lane, tasks, pendingTaskIds, busy, hasModels, draggedTaskId, dragOverStatus,
  canManageTasks, canStartRuns,
  onView, onEdit, onDelete, onLaunch, onDraggedTaskChange, onDragOverStatusChange, onDrop,
}: TaskBoardLaneProps) => {
  const laneTasks = tasks.filter((task) => task.status === lane.status);
  const isDropTarget = dragOverStatus === lane.status;
  return (
    <div key={lane.status} className={cn("task-board-lane flex min-h-[360px] min-w-0 flex-col rounded-lg transition-colors", isDropTarget && "task-board-lane--drop ring-1 ring-cyan-500/40")} onDragOver={(event) => { if (canManageTasks) { event.preventDefault(); onDragOverStatusChange(lane.status); } }} onDragLeave={(event) => { if (canManageTasks) handleTaskLaneDragLeave(event, onDragOverStatusChange); }} onDrop={(event) => { if (canManageTasks) onDrop(event, lane.status); }}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-zinc-800/80 px-3">
        <div className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", lane.dot)} /><h4 className="text-xs font-semibold text-zinc-300">{lane.label}</h4></div>
        <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">{laneTasks.length}</span>
      </div>
      <div className="space-y-2 p-2">
        {laneTasks.map((task) => <ConnectedTaskBoardCard key={task.id} task={task} pendingTaskIds={pendingTaskIds} busy={busy} hasModels={hasModels} canManageTasks={canManageTasks} canStartRuns={canStartRuns} draggedTaskId={draggedTaskId} onView={onView} onEdit={onEdit} onDelete={onDelete} onLaunch={onLaunch} onDraggedTaskChange={onDraggedTaskChange} onDragOverStatusChange={onDragOverStatusChange} />)}
        {laneTasks.length === 0 ? <div className={cn("flex min-h-24 items-center justify-center rounded-md border border-dashed border-zinc-800 px-3 text-center text-[11px] text-zinc-600", isDropTarget && "border-cyan-500/50 text-cyan-400/70")}>{getEmptyTaskLaneText(draggedTaskId, lane.label)}</div> : null}
      </div>
    </div>
  );
};

const TaskBoard = ({
  tasks, pendingTaskIds, busy, hasModels, draggedTaskId, dragOverStatus,
  canManageTasks, canStartRuns,
  onView, onEdit, onDelete, onLaunch, onDraggedTaskChange, onDragOverStatusChange, onDrop,
}: TaskBoardProps) => (
  <div className="app-scrollbar min-h-0 flex-1 overflow-auto pb-1">
    <div className="grid min-h-full min-w-[1080px] grid-cols-4 gap-3">
      {LANES.map((lane) => <TaskBoardLane key={lane.status} lane={lane} tasks={tasks} pendingTaskIds={pendingTaskIds} busy={busy} hasModels={hasModels} canManageTasks={canManageTasks} canStartRuns={canStartRuns} draggedTaskId={draggedTaskId} dragOverStatus={dragOverStatus} onView={onView} onEdit={onEdit} onDelete={onDelete} onLaunch={onLaunch} onDraggedTaskChange={onDraggedTaskChange} onDragOverStatusChange={onDragOverStatusChange} onDrop={onDrop} />)}
    </div>
  </div>
);

interface TaskViewDialogProps {
  task: ProjectTaskRecord | null;
  busy: boolean;
  hasModels: boolean;
  canManageTasks: boolean;
  canStartRuns: boolean;
  onClose: () => void;
  onEdit: (task: ProjectTaskRecord) => void;
  onLaunch: (task: ProjectTaskRecord) => void;
}

const TaskViewDialog = ({ task, busy, hasModels, canManageTasks, canStartRuns, onClose, onEdit, onLaunch }: TaskViewDialogProps) => {
  const buildwarden = useBuildWardenClient();
  if (!task) return null;
  const lane = LANES.find((candidate) => candidate.status === task.status);
  return (
    <div className="task-modal-backdrop absolute inset-0 z-50 flex items-center justify-center p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <Card className="task-modal-surface flex max-h-[calc(100vh-3rem)] w-full max-w-3xl flex-col overflow-hidden p-0" role="dialog" aria-modal="true" aria-labelledby="view-task-title">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("h-2 w-2 rounded-full", lane?.dot)} />
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">{lane?.label}</p>
            </div>
            <h3 id="view-task-title" className="mt-2 break-words text-lg font-semibold leading-7 text-zinc-100">{task.title}</h3>
            <p className="mt-1 text-[11px] text-zinc-500">Updated {new Date(task.updatedAt).toLocaleString()}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" title="Close" aria-label="Close task details" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">Agent prompt</p>
          <div className="break-words whitespace-pre-wrap text-sm leading-6 text-zinc-300">{task.prompt}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
          <div>{task.pullRequestUrl ? <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs text-zinc-400" onClick={() => void buildwarden.openExternalUrl(task.pullRequestUrl!)}><ExternalLink className="h-3.5 w-3.5" />Open linked PR/MR</Button> : null}</div>
          <div className="flex items-center gap-2">
            {canManageTasks ? <Button type="button" variant="secondary" size="sm" className="h-8 px-3 text-xs" onClick={() => onEdit(task)}><Pencil className="h-3.5 w-3.5" />Edit</Button> : null}
            {canStartRuns ? <Button type="button" size="sm" className="h-8 px-3 text-xs" disabled={busy || !hasModels} onClick={() => onLaunch(task)}><Play className="h-3.5 w-3.5" />Start run</Button> : null}
          </div>
        </div>
      </Card>
    </div>
  );
};

export const ProjectTasksTab = ({
  projectId,
  tasks,
  modelOptions,
  defaultTaskModelId,
  busy,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onStartTask,
}: ProjectTasksTabProps) => {
  const buildwarden = useBuildWardenClient();
  const canManageTasks = buildwarden.capabilities.platform === "electron";
  const canStartRuns = buildwarden.capabilities.runMutations;
  const [createOpen, setCreateOpen] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(() => new Set());
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [taskEditTitle, setTaskEditTitle] = useState("");
  const [taskEditPrompt, setTaskEditPrompt] = useState("");
  const [taskEditStatus, setTaskEditStatus] = useState<ProjectTaskStatus>("open");
  const [taskModelById, setTaskModelById] = useTaskModelSelections(tasks, modelOptions, defaultTaskModelId);
  const [launchTaskId, setLaunchTaskId] = useState<string | null>(null);
  const [launchPromptDraft, setLaunchPromptDraft] = useState("");
  const [launchGenerateBusy, setLaunchGenerateBusy] = useState(false);
  const [launchStartBusy, setLaunchStartBusy] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<ProjectTaskStatus | null>(null);
  const [statusOverrides, setStatusOverrides] = useState<Record<string, ProjectTaskStatus>>({});

  const launchTask = useMemo(() => tasks.find((task) => task.id === launchTaskId) ?? null, [launchTaskId, tasks]);
  const viewingTask = useMemo(() => tasks.find((task) => task.id === viewingTaskId) ?? null, [tasks, viewingTaskId]);
  const editingTask = useMemo(() => tasks.find((task) => task.id === editingTaskId) ?? null, [editingTaskId, tasks]);
  const visibleTasks = useMemo(
    () => tasks.map((task) => ({ ...task, status: statusOverrides[task.id] ?? task.status })),
    [statusOverrides, tasks],
  );
  const editingTaskBusy = isTaskPending(editingTask, pendingTaskIds);
  const taskFormBusy = taskBusy || editingTaskBusy;
  const closeLaunchDialog = useCallback(() => {
    if (launchGenerateBusy || launchStartBusy) return;
    setLaunchTaskId(null);
    setLaunchPromptDraft("");
  }, [launchGenerateBusy, launchStartBusy]);

  useEffect(() => {
    setPendingTaskIds(new Set());
    setTaskBusy(false);
    setViewingTaskId(null);
    setEditingTaskId(null);
    setCreateOpen(false);
    setTaskEditTitle("");
    setTaskEditPrompt("");
    setTaskEditStatus("open");
    setLaunchTaskId(null);
    setLaunchPromptDraft("");
    setLaunchGenerateBusy(false);
    setLaunchStartBusy(false);
    setDraggedTaskId(null);
    setDragOverStatus(null);
    setStatusOverrides({});
  }, [projectId]);

  useEffect(() => {
    setStatusOverrides((current) => {
      const next = { ...current };
      for (const task of tasks) {
        if (next[task.id] === task.status) delete next[task.id];
      }
      return next;
    });
    if (viewingTaskId && !tasks.some((task) => task.id === viewingTaskId)) setViewingTaskId(null);
    if (editingTaskId && !tasks.some((task) => task.id === editingTaskId)) setEditingTaskId(null);
  }, [editingTaskId, tasks, viewingTaskId]);

  useEffect(() => {
    if (!viewingTask && !editingTask && !createOpen && !launchTask) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || taskFormBusy || launchGenerateBusy || launchStartBusy) return;
      setViewingTaskId(null);
      setCreateOpen(false);
      setEditingTaskId(null);
      setTaskEditTitle("");
      setTaskEditPrompt("");
      closeLaunchDialog();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeLaunchDialog, createOpen, editingTask, launchGenerateBusy, launchStartBusy, launchTask, taskFormBusy, viewingTask]);

  const handleCreateTask = async () => {
    const title = taskEditTitle.trim();
    const prompt = taskEditPrompt.trim();
    if (!title || !prompt) return;
    setTaskBusy(true);
    try {
      await onCreateTask({ title, prompt });
      setCreateOpen(false);
      setTaskEditTitle("");
      setTaskEditPrompt("");
    } finally {
      setTaskBusy(false);
    }
  };

  const openCreateTask = () => {
    setViewingTaskId(null);
    setEditingTaskId(null);
    setTaskEditTitle("");
    setTaskEditPrompt("");
    setTaskEditStatus("open");
    setCreateOpen(true);
  };

  const startEditingTask = (task: ProjectTaskRecord) => {
    setViewingTaskId(null);
    setCreateOpen(false);
    setEditingTaskId(task.id);
    setTaskEditTitle(task.title);
    setTaskEditPrompt(task.prompt);
    setTaskEditStatus(task.status);
  };

  const cancelEditingTask = () => {
    setEditingTaskId(null);
    setTaskEditTitle("");
    setTaskEditPrompt("");
  };

  const closeTaskForm = () => {
    if (taskFormBusy) return;
    setCreateOpen(false);
    cancelEditingTask();
  };

  const handleUpdateTask = async (task: ProjectTaskRecord) => {
    const title = taskEditTitle.trim();
    const prompt = taskEditPrompt.trim();
    if (!title || !prompt) return;
    setPendingTaskIds((current) => new Set(current).add(task.id));
    try {
      await onUpdateTask(task.id, { title, prompt, status: taskEditStatus });
      cancelEditingTask();
    } catch {
      // App already surfaces the bridge error. Keep the form open for retry and
      // consume the propagated rejection so the click handler stays handled.
    } finally {
      setPendingTaskIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  };

  const handleSubmitTaskForm = async () => {
    if (createOpen) {
      await handleCreateTask();
    } else if (editingTask) {
      await handleUpdateTask(editingTask);
    }
  };

  const moveTask = async (task: ProjectTaskRecord, status: ProjectTaskStatus) => {
    if (task.status === status || pendingTaskIds.has(task.id)) return;
    setStatusOverrides((current) => ({ ...current, [task.id]: status }));
    setPendingTaskIds((current) => new Set(current).add(task.id));
    try {
      await onUpdateTask(task.id, { status });
    } catch {
      // App reports the rejection through its existing error banner before
      // rethrowing; the board owns restoring the optimistic lane locally.
      setStatusOverrides((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    } finally {
      setPendingTaskIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, status: ProjectTaskStatus) => {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("text/buildwarden-project-task") || draggedTaskId;
    const task = visibleTasks.find((candidate) => candidate.id === taskId);
    setDraggedTaskId(null);
    setDragOverStatus(null);
    if (task) void moveTask(task, status);
  };

  const openLaunchDialog = (task: ProjectTaskRecord) => {
    setLaunchTaskId(task.id);
    setLaunchPromptDraft(task.prompt);
  };

  const handleGeneratePrompt = async () => {
    if (!launchTask) return;
    const modelId = taskModelById[launchTask.id] ?? defaultTaskModelId;
    if (!modelId) return;
    setLaunchGenerateBusy(true);
    try {
      setLaunchPromptDraft(await buildwarden.generateProjectTaskRunPrompt({
        projectId,
        title: launchTask.title,
        notes: launchPromptDraft.trim() || launchTask.prompt,
        modelId,
      }));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not generate a prompt.");
    } finally {
      setLaunchGenerateBusy(false);
    }
  };

  const handleStartTask = async () => {
    if (!launchTask) return;
    const modelId = taskModelById[launchTask.id] ?? defaultTaskModelId;
    const prompt = launchPromptDraft.trim();
    if (!modelId || !prompt) return;
    setLaunchStartBusy(true);
    try {
      await onStartTask(launchTask.id, prompt, modelId);
      setLaunchTaskId(null);
      setLaunchPromptDraft("");
    } finally {
      setLaunchStartBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <ListTodo className="h-4 w-4 text-cyan-400" />
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-100">Task board</h3>
              <BetaBadge />
            </div>
            <p className="text-[11px] text-zinc-500">{tasks.length} task{tasks.length === 1 ? "" : "s"} · linked PRs move to Done when merge monitoring is enabled</p>
          </div>
        </div>
        {canManageTasks ? <Button type="button" size="sm" className="h-8 px-2.5 text-xs" onClick={openCreateTask}>
          <Plus className="h-3.5 w-3.5" />
          Add task
        </Button> : null}
      </div>

      <TaskBoard
        tasks={visibleTasks}
        pendingTaskIds={pendingTaskIds}
        busy={busy}
        hasModels={modelOptions.length > 0}
        canManageTasks={canManageTasks}
        canStartRuns={canStartRuns}
        draggedTaskId={draggedTaskId}
        dragOverStatus={dragOverStatus}
        onView={setViewingTaskId}
        onEdit={startEditingTask}
        onDelete={onDeleteTask}
        onLaunch={openLaunchDialog}
        onDraggedTaskChange={setDraggedTaskId}
        onDragOverStatusChange={setDragOverStatus}
        onDrop={handleDrop}
      />

      <TaskViewDialog
        task={viewingTask}
        busy={busy}
        hasModels={modelOptions.length > 0}
        canManageTasks={canManageTasks}
        canStartRuns={canStartRuns}
        onClose={() => setViewingTaskId(null)}
        onEdit={startEditingTask}
        onLaunch={(task) => { setViewingTaskId(null); openLaunchDialog(task); }}
      />

      {createOpen || editingTask ? (
        <div
          className="task-modal-backdrop absolute inset-0 z-50 flex items-center justify-center p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeTaskForm();
          }}
        >
          <Card className="task-modal-surface flex max-h-[calc(100vh-3rem)] w-full max-w-3xl flex-col overflow-hidden p-0" role="dialog" aria-modal="true" aria-labelledby="task-form-title">
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-800 px-5 py-4">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">{createOpen ? "New task" : "Edit task"}</p>
                <h3 id="task-form-title" className="mt-1 text-lg font-semibold text-zinc-100">Task details</h3>
              </div>
              <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" title="Close" aria-label="Close task form" disabled={taskFormBusy} onClick={closeTaskForm}><X className="h-4 w-4" /></Button>
            </div>
            <div className="app-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-400">Title</span>
                <Input value={taskEditTitle} onChange={(event) => setTaskEditTitle(event.target.value)} className="h-10 text-sm" placeholder="Task title" autoFocus />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-400">Agent prompt</span>
                <Textarea value={taskEditPrompt} onChange={(event) => setTaskEditPrompt(event.target.value)} className="min-h-[320px] max-h-[55vh] resize-y text-sm leading-6" placeholder="Prompt for the agent run" />
              </label>
              {editingTask ? (
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-zinc-400">Status</span>
                  <Select value={taskEditStatus} onValueChange={(value) => setTaskEditStatus(value as ProjectTaskStatus)} options={statusOptions} triggerClassName="h-10 text-sm" />
                </label>
              ) : null}
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-zinc-800 px-5 py-3">
              <Button type="button" size="sm" variant="ghost" className="h-8 px-3 text-xs" disabled={taskFormBusy} onClick={closeTaskForm}>Cancel</Button>
              <Button type="button" size="sm" className="h-8 px-3 text-xs" disabled={taskFormBusy || !taskEditTitle.trim() || !taskEditPrompt.trim()} onClick={() => void handleSubmitTaskForm()}>
                {taskFormBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{createOpen ? "Save task" : "Save changes"}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {launchTask ? (
        <div
          className="task-modal-backdrop absolute inset-0 z-50 flex items-center justify-center p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeLaunchDialog();
          }}
        >
          <Card className="task-modal-surface w-full max-w-2xl p-4" role="dialog" aria-modal="true" aria-labelledby="launch-task-title">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Start task run</p><h3 id="launch-task-title" className="mt-1 text-base font-semibold text-zinc-100">{launchTask.title}</h3></div>
              <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" title="Close" aria-label="Close task run dialog" disabled={launchGenerateBusy || launchStartBusy} onClick={closeLaunchDialog}><X className="h-4 w-4" /></Button>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Select value={taskModelById[launchTask.id] ?? defaultTaskModelId} onValueChange={(value) => setTaskModelById((current) => ({ ...current, [launchTask.id]: value }))} options={modelOptions.map((option) => ({ value: option.id, label: option.label }))} className="min-w-0 flex-1" />
              {canManageTasks ? <Button type="button" variant="secondary" size="sm" disabled={launchGenerateBusy || launchStartBusy} onClick={() => void handleGeneratePrompt()}>{launchGenerateBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Generate prompt</Button> : null}
            </div>
            <Textarea className="mt-3 min-h-52 resize-y" value={launchPromptDraft} onChange={(event) => setLaunchPromptDraft(event.target.value)} autoFocus />
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={launchGenerateBusy || launchStartBusy} onClick={closeLaunchDialog}>Cancel</Button>
              <Button type="button" size="sm" disabled={launchGenerateBusy || launchStartBusy || !launchPromptDraft.trim()} onClick={() => void handleStartTask()}>{launchStartBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}Start run</Button>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
};
