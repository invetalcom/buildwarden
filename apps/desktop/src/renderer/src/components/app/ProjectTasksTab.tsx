import type { ProjectTaskRecord, ProjectTaskStatus, ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { Check, ExternalLink, Eye, GripVertical, ListTodo, Loader2, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { cn } from "../../lib/cn";
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
  const [createOpen, setCreateOpen] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(() => new Set());
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [taskEditTitle, setTaskEditTitle] = useState("");
  const [taskEditPrompt, setTaskEditPrompt] = useState("");
  const [taskEditStatus, setTaskEditStatus] = useState<ProjectTaskStatus>("open");
  const [taskModelById, setTaskModelById] = useState<Record<string, string>>({});
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
  const editingTaskBusy = editingTask ? pendingTaskIds.has(editingTask.id) : false;
  const taskFormBusy = taskBusy || editingTaskBusy;

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
    if (!viewingTask && !editingTask && !createOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || taskFormBusy) return;
      setViewingTaskId(null);
      setCreateOpen(false);
      setEditingTaskId(null);
      setTaskEditTitle("");
      setTaskEditPrompt("");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createOpen, editingTask, taskFormBusy, viewingTask]);

  useEffect(() => {
    setTaskModelById((current) => {
      const next: Record<string, string> = {};
      for (const task of tasks) {
        const candidate = current[task.id];
        next[task.id] = modelOptions.some((option) => option.id === candidate) ? candidate : defaultTaskModelId;
      }
      return next;
    });
  }, [defaultTaskModelId, modelOptions, tasks]);

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
      setLaunchPromptDraft(await window.buildwarden.generateProjectTaskRunPrompt({
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
        <Button type="button" size="sm" className="h-8 px-2.5 text-xs" onClick={openCreateTask}>
          <Plus className="h-3.5 w-3.5" />
          Add task
        </Button>
      </div>

      <div className="app-scrollbar min-h-0 flex-1 overflow-auto pb-1">
        <div className="grid min-h-full min-w-[1080px] grid-cols-4 gap-3">
          {LANES.map((lane) => {
            const laneTasks = visibleTasks.filter((task) => task.status === lane.status);
            const isDropTarget = dragOverStatus === lane.status;
            return (
              <div
                key={lane.status}
                className={cn("task-board-lane flex min-h-[360px] min-w-0 flex-col rounded-lg transition-colors", isDropTarget && "task-board-lane--drop ring-1 ring-cyan-500/40")}
                onDragOver={(event) => { event.preventDefault(); setDragOverStatus(lane.status); }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverStatus(null); }}
                onDrop={(event) => handleDrop(event, lane.status)}
              >
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-zinc-800/80 px-3">
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 rounded-full", lane.dot)} />
                    <h4 className="text-xs font-semibold text-zinc-300">{lane.label}</h4>
                  </div>
                  <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">{laneTasks.length}</span>
                </div>
                <div className="space-y-2 p-2">
                  {laneTasks.map((task) => {
                    const isTaskBusy = pendingTaskIds.has(task.id);
                    return (
                      <article
                        key={task.id}
                        draggable={!isTaskBusy}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/buildwarden-project-task", task.id);
                          setDraggedTaskId(task.id);
                        }}
                        onDragEnd={() => { setDraggedTaskId(null); setDragOverStatus(null); }}
                        className={cn("task-board-card group rounded-md border p-2.5 transition", draggedTaskId === task.id && "opacity-45")}
                      >
                        <div className="flex items-start gap-1.5">
                          <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-grab text-zinc-700 group-hover:text-zinc-500" />
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <h5 className="max-h-10 overflow-hidden break-words text-xs font-semibold leading-5 text-zinc-100">{task.title}</h5>
                            <p className="mt-1 max-h-12 overflow-hidden break-words whitespace-pre-wrap text-[11px] leading-4 text-zinc-400">{task.prompt}</p>
                          </div>
                          {isTaskBusy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" /> : null}
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-1 border-t border-zinc-800/80 pt-2">
                          <div className="flex items-center gap-0.5">
                            <Button type="button" size="sm" variant="ghost" className="task-card-action h-7 w-7 p-0" title="View task" aria-label={`View ${task.title}`} onClick={() => setViewingTaskId(task.id)}><Eye className="h-3.5 w-3.5" /></Button>
                            {task.pullRequestUrl ? (
                              <Button type="button" size="sm" variant="ghost" className="task-card-action h-7 w-7 p-0" title="Open linked PR/MR" onClick={() => void window.buildwarden.openExternalUrl(task.pullRequestUrl!)}>
                                <ExternalLink className="h-3.5 w-3.5" />
                              </Button>
                            ) : null}
                            <Button type="button" size="sm" variant="ghost" className="task-card-action h-7 w-7 p-0" title="Edit task" onClick={() => startEditingTask(task)}><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button type="button" size="sm" variant="ghost" className="task-card-action task-card-action--danger h-7 w-7 p-0" title="Delete task" disabled={isTaskBusy} onClick={() => { if (window.confirm(`Delete “${task.title}”?`)) void onDeleteTask(task.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                          </div>
                          <Button type="button" size="sm" variant="secondary" className="h-7 px-2 text-[11px]" disabled={busy || isTaskBusy || modelOptions.length === 0} onClick={() => openLaunchDialog(task)}><Play className="h-3 w-3" />Start run</Button>
                        </div>
                      </article>
                    );
                  })}
                  {laneTasks.length === 0 ? (
                    <div className={cn("flex min-h-24 items-center justify-center rounded-md border border-dashed border-zinc-800 px-3 text-center text-[11px] text-zinc-600", isDropTarget && "border-cyan-500/50 text-cyan-400/70")}>
                      {draggedTaskId ? `Move to ${lane.label}` : "No tasks"}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {viewingTask ? (
        <div
          className="task-modal-backdrop absolute inset-0 z-50 flex items-center justify-center p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setViewingTaskId(null);
          }}
        >
          <Card className="task-modal-surface flex max-h-[calc(100vh-3rem)] w-full max-w-3xl flex-col overflow-hidden p-0" role="dialog" aria-modal="true" aria-labelledby="view-task-title">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full", LANES.find((lane) => lane.status === viewingTask.status)?.dot)} />
                  <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                    {LANES.find((lane) => lane.status === viewingTask.status)?.label}
                  </p>
                </div>
                <h3 id="view-task-title" className="mt-2 break-words text-lg font-semibold leading-7 text-zinc-100">{viewingTask.title}</h3>
                <p className="mt-1 text-[11px] text-zinc-500">Updated {new Date(viewingTask.updatedAt).toLocaleString()}</p>
              </div>
              <Button type="button" variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" title="Close" aria-label="Close task details" onClick={() => setViewingTaskId(null)}><X className="h-4 w-4" /></Button>
            </div>
            <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">Agent prompt</p>
              <div className="break-words whitespace-pre-wrap text-sm leading-6 text-zinc-300">{viewingTask.prompt}</div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
              <div>
                {viewingTask.pullRequestUrl ? (
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs text-zinc-400" onClick={() => void window.buildwarden.openExternalUrl(viewingTask.pullRequestUrl!)}><ExternalLink className="h-3.5 w-3.5" />Open linked PR/MR</Button>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="secondary" size="sm" className="h-8 px-3 text-xs" onClick={() => startEditingTask(viewingTask)}><Pencil className="h-3.5 w-3.5" />Edit</Button>
                <Button type="button" size="sm" className="h-8 px-3 text-xs" disabled={busy || modelOptions.length === 0} onClick={() => { setViewingTaskId(null); openLaunchDialog(viewingTask); }}><Play className="h-3.5 w-3.5" />Start run</Button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

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
        <div className="task-modal-backdrop absolute inset-0 z-50 flex items-center justify-center p-6">
          <Card className="task-modal-surface w-full max-w-2xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Start task run</p><h3 className="mt-1 text-base font-semibold text-zinc-100">{launchTask.title}</h3></div>
              <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={launchGenerateBusy || launchStartBusy} onClick={() => setLaunchTaskId(null)}><X className="h-4 w-4" /></Button>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Select value={taskModelById[launchTask.id] ?? defaultTaskModelId} onValueChange={(value) => setTaskModelById((current) => ({ ...current, [launchTask.id]: value }))} options={modelOptions.map((option) => ({ value: option.id, label: option.label }))} className="min-w-0 flex-1" />
              <Button type="button" variant="secondary" size="sm" disabled={launchGenerateBusy || launchStartBusy} onClick={() => void handleGeneratePrompt()}>{launchGenerateBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Generate prompt</Button>
            </div>
            <Textarea className="mt-3 min-h-52 resize-y" value={launchPromptDraft} onChange={(event) => setLaunchPromptDraft(event.target.value)} autoFocus />
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={launchGenerateBusy || launchStartBusy} onClick={() => setLaunchTaskId(null)}>Cancel</Button>
              <Button type="button" size="sm" disabled={launchGenerateBusy || launchStartBusy || !launchPromptDraft.trim()} onClick={() => void handleStartTask()}>{launchStartBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}Start run</Button>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
};
