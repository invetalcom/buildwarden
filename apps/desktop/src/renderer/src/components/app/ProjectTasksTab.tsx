import type { ProjectTaskRecord, ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { Check, ListTodo, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";

interface ProjectTasksTabProps {
  projectId: string;
  tasks: ProjectTaskRecord[];
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultTaskModelId: string;
  busy: boolean;
  onCreateTask: (input: { title: string; prompt: string }) => void | Promise<void>;
  onUpdateTask: (taskId: string, input: { title: string; prompt: string }) => void | Promise<void>;
  onDeleteTask: (taskId: string) => void | Promise<void>;
  onStartTask: (prompt: string, modelId: string) => void | Promise<void>;
}

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
  const [taskTitle, setTaskTitle] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [taskBusy, setTaskBusy] = useState(false);
  const [savedTaskBusyId, setSavedTaskBusyId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [taskEditTitle, setTaskEditTitle] = useState("");
  const [taskEditPrompt, setTaskEditPrompt] = useState("");
  const [taskModelById, setTaskModelById] = useState<Record<string, string>>({});
  const [launchTaskId, setLaunchTaskId] = useState<string | null>(null);
  const [launchPromptDraft, setLaunchPromptDraft] = useState("");
  const [launchGenerateBusy, setLaunchGenerateBusy] = useState(false);
  const [launchStartBusy, setLaunchStartBusy] = useState(false);
  const taskCountLabel = useMemo(() => `${tasks.length} task${tasks.length === 1 ? "" : "s"}`, [tasks.length]);
  const launchTask = useMemo(() => tasks.find((task) => task.id === launchTaskId) ?? null, [launchTaskId, tasks]);

  useEffect(() => {
    setSavedTaskBusyId(null);
    setEditingTaskId(null);
    setTaskEditTitle("");
    setTaskEditPrompt("");
  }, [projectId]);

  useEffect(() => {
    if (editingTaskId && !tasks.some((task) => task.id === editingTaskId)) {
      setEditingTaskId(null);
      setTaskEditTitle("");
      setTaskEditPrompt("");
    }
  }, [editingTaskId, tasks]);

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
    const trimmedTitle = taskTitle.trim();
    const trimmedPrompt = taskPrompt.trim();
    if (!trimmedTitle || !trimmedPrompt) {
      window.alert("Enter both a task title and a prompt.");
      return;
    }
    setTaskBusy(true);
    try {
      await onCreateTask({ title: trimmedTitle, prompt: trimmedPrompt });
      setTaskTitle("");
      setTaskPrompt("");
    } finally {
      setTaskBusy(false);
    }
  };

  const startEditingTask = (task: ProjectTaskRecord) => {
    setEditingTaskId(task.id);
    setTaskEditTitle(task.title);
    setTaskEditPrompt(task.prompt);
  };

  const cancelEditingTask = () => {
    setEditingTaskId(null);
    setTaskEditTitle("");
    setTaskEditPrompt("");
  };

  const handleUpdateTask = async (task: ProjectTaskRecord) => {
    const trimmedTitle = taskEditTitle.trim();
    const trimmedPrompt = taskEditPrompt.trim();
    if (!trimmedTitle || !trimmedPrompt) {
      window.alert("Enter both a task title and a prompt.");
      return;
    }
    if (trimmedTitle === task.title && trimmedPrompt === task.prompt) {
      cancelEditingTask();
      return;
    }
    setSavedTaskBusyId(task.id);
    try {
      await onUpdateTask(task.id, { title: trimmedTitle, prompt: trimmedPrompt });
      cancelEditingTask();
    } finally {
      setSavedTaskBusyId(null);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    setSavedTaskBusyId(taskId);
    try {
      await onDeleteTask(taskId);
      if (editingTaskId === taskId) {
        cancelEditingTask();
      }
    } finally {
      setSavedTaskBusyId(null);
    }
  };

  const openLaunchDialog = (task: ProjectTaskRecord) => {
    setLaunchTaskId(task.id);
    setLaunchPromptDraft(task.prompt);
  };

  const closeLaunchDialog = () => {
    if (launchGenerateBusy || launchStartBusy) {
      return;
    }
    setLaunchTaskId(null);
    setLaunchPromptDraft("");
  };

  const handleGeneratePrompt = async () => {
    if (!launchTask) {
      return;
    }
    const modelId = taskModelById[launchTask.id] ?? defaultTaskModelId;
    if (!modelId) {
      window.alert("Select a model for this task first.");
      return;
    }
    setLaunchGenerateBusy(true);
    try {
      const nextPrompt = await window.buildwarden.generateProjectTaskRunPrompt({
        projectId,
        title: launchTask.title,
        notes: launchPromptDraft.trim() || launchTask.prompt,
        modelId,
      });
      setLaunchPromptDraft(nextPrompt);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not generate a prompt.");
    } finally {
      setLaunchGenerateBusy(false);
    }
  };

  const handleStartTask = async (prompt: string, modelId: string) => {
    if (!modelId) {
      window.alert("Select a model for this task first.");
      return;
    }
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      window.alert("Enter a prompt before starting the run.");
      return;
    }
    setLaunchStartBusy(true);
    try {
      await onStartTask(trimmedPrompt, modelId);
      setLaunchTaskId(null);
      setLaunchPromptDraft("");
    } finally {
      setLaunchStartBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <ListTodo className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-medium text-zinc-200">New task/story</h3>
        </div>
        <div className="space-y-3">
          <Input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="Task title" />
          <Textarea
            value={taskPrompt}
            onChange={(event) => setTaskPrompt(event.target.value)}
            placeholder="Describe the task prompt that should be used later when starting an agent run."
            className="min-h-[180px]"
          />
          <Button type="button" onClick={() => void handleCreateTask()} disabled={taskBusy || busy || !taskTitle.trim() || !taskPrompt.trim()}>
            {taskBusy ? "Saving..." : "Save task"}
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-cyan-400" />
            <h3 className="text-sm font-medium text-zinc-200">Saved tasks</h3>
          </div>
          <span className="text-xs text-zinc-500">{taskCountLabel}</span>
        </div>
        <div className="app-scrollbar max-h-[520px] space-y-3 overflow-y-auto pr-1">
          {tasks.length > 0 ? (
            tasks.map((task) => {
              const isEditing = editingTaskId === task.id;
              const isSavedTaskBusy = savedTaskBusyId === task.id;
              return (
              <div key={task.id} className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <Input
                        value={taskEditTitle}
                        onChange={(event) => setTaskEditTitle(event.target.value)}
                        placeholder="Task title"
                        autoFocus
                      />
                    ) : (
                      <p className="text-sm font-medium text-zinc-100">{task.title}</p>
                    )}
                    <p className="mt-1 text-[11px] text-zinc-500">{new Date(task.updatedAt).toLocaleString()}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {isEditing ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="h-8 px-2 text-xs"
                          disabled={isSavedTaskBusy || busy || !taskEditTitle.trim() || !taskEditPrompt.trim()}
                          onClick={() => void handleUpdateTask(task)}
                        >
                          {isSavedTaskBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden />
                          )}
                          Save
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2 text-xs text-zinc-500 hover:text-zinc-100"
                          disabled={isSavedTaskBusy}
                          onClick={cancelEditingTask}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Select
                          value={taskModelById[task.id] ?? defaultTaskModelId}
                          onValueChange={(value) =>
                            setTaskModelById((current) => ({
                              ...current,
                              [task.id]: value,
                            }))
                          }
                          options={modelOptions.map((option) => ({ value: option.id, label: option.label }))}
                          ariaLabel="Select model for this task"
                          className="min-w-[14rem] max-w-full"
                          triggerClassName="h-8 text-xs"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="h-8 px-2 text-xs"
                          disabled={busy || isSavedTaskBusy}
                          onClick={() => openLaunchDialog(task)}
                        >
                          Start run
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-zinc-500 hover:text-zinc-100"
                          title="Edit task"
                          aria-label="Edit task"
                          disabled={busy || isSavedTaskBusy}
                          onClick={() => startEditingTask(task)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-zinc-500 hover:text-rose-300"
                          title="Delete task"
                          aria-label="Delete task"
                          disabled={isSavedTaskBusy}
                          onClick={() => void handleDeleteTask(task.id)}
                        >
                          {isSavedTaskBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {isEditing ? (
                  <Textarea
                    value={taskEditPrompt}
                    onChange={(event) => setTaskEditPrompt(event.target.value)}
                    placeholder="Describe the task prompt that should be used later when starting an agent run."
                    className="mt-3 min-h-32"
                  />
                ) : (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{task.prompt}</p>
                )}
              </div>
              );
            })
          ) : (
            <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-zinc-800/80 bg-zinc-950/40 px-4 text-center text-sm text-zinc-500">
              No saved tasks yet. Add a task/story on the left, then start a run from it later.
            </div>
          )}
        </div>
      </Card>

      {launchTask ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/70 p-6 backdrop-blur-sm">
          <Card className="w-full max-w-3xl p-5">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Start task run</p>
            <h3 className="mt-2 text-xl font-semibold text-zinc-100">{launchTask.title}</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Refine the prompt before launching. You can edit it directly or generate a cleaner prompt from the saved notes.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <label className="flex min-w-[16rem] flex-1 items-center gap-2 text-xs text-zinc-400">
                <span className="shrink-0">Model</span>
                <Select
                  value={taskModelById[launchTask.id] ?? defaultTaskModelId}
                  onValueChange={(value) =>
                    setTaskModelById((current) => ({
                      ...current,
                      [launchTask.id]: value,
                    }))
                  }
                  options={modelOptions.map((option) => ({ value: option.id, label: option.label }))}
                  className="min-w-0 flex-1"
                />
              </label>
              <Button type="button" variant="secondary" onClick={() => void handleGeneratePrompt()} disabled={launchGenerateBusy || launchStartBusy}>
                {launchGenerateBusy ? "Generating..." : "Generate prompt"}
              </Button>
            </div>
            <Textarea
              className="mt-4 min-h-[240px] resize-y"
              value={launchPromptDraft}
              onChange={(event) => setLaunchPromptDraft(event.target.value)}
              placeholder="Enter or generate the prompt for this run."
              autoFocus
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeLaunchDialog} disabled={launchGenerateBusy || launchStartBusy}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handleStartTask(launchPromptDraft, taskModelById[launchTask.id] ?? defaultTaskModelId)}
                disabled={launchGenerateBusy || launchStartBusy || !launchPromptDraft.trim()}
              >
                {launchStartBusy ? "Starting..." : "Start run"}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
};
