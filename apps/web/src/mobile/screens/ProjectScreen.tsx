import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatAttachmentPayload, ProjectGitBranchOverview, ProjectTaskRecord, ProjectTaskSummary } from "@buildwarden/shared";
import { GitBranch, Paperclip, Pencil, Play, Plus } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { filterRuns, flattenRuns } from "../data/selectors";
import { useAction } from "../data/use-action";
import { absoluteTime, compactNumber, errorMessage, relativeTime } from "../lib/format";
import type { ProjectTab } from "../nav/mobile-router";
import { AppBar } from "../components/AppBar";
import { RunListRow } from "../components/RunListRow";
import { Badge, Button, CenteredSpinner, EmptyState, InlineError, Input, ListRow, SectionAction, SectionLabel, SegmentedTabs, Textarea, type SegmentOption } from "../components/primitives";
import { Sheet } from "../components/Sheet";
import { MobileStoredAttachments, MobileTaskAttachmentField } from "../components/TaskAttachments";
import { mergeMobileTaskAttachments, readMobileAttachmentFiles } from "../lib/task-attachments";
import { ProjectSettingsPanel } from "./project/ProjectSettingsPanel";

const TASK_TONES = { open: "neutral", in_progress: "accent", in_review: "warning", done: "success" } as const;

const TaskList = ({ tasks, onSelect }: { tasks: readonly ProjectTaskSummary[]; onSelect: (task: ProjectTaskSummary) => void }) =>
  tasks.length === 0 ? (
    <EmptyState title="No tasks" message="Tasks created on the board appear here." />
  ) : (
    <>
      {tasks.map((task) => (
        <ListRow
          key={task.id}
          title={task.title}
          subtitle={task.prompt || undefined}
          trailing={<>{task.attachmentCount > 0 ? <span className="inline-flex items-center gap-1"><Paperclip className="size-3.5" />{task.attachmentCount}</span> : null}<Badge tone={TASK_TONES[task.status]}>{task.status.replace("_", " ")}</Badge></>}
          onClick={() => onSelect(task)}
          className="border-b border-[var(--ec-border)]"
        />
      ))}
    </>
  );

const TaskEditorSheet = ({
  projectId,
  task,
  open,
  onClose,
}: {
  projectId: string;
  task: ProjectTaskRecord | null;
  open: boolean;
  onClose: () => void;
}) => {
  const { client, snapshotStore } = useMobileApp();
  const action = useAction();
  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [storedAttachments, setStoredAttachments] = useState<ChatAttachmentPayload[]>(task?.attachments ?? []);
  const [files, setFiles] = useState<File[]>([]);

  const save = async () => {
    if (!title.trim() || !prompt.trim()) return;
    const result = await action.run(async () => {
      const attachments = mergeMobileTaskAttachments(storedAttachments, await readMobileAttachmentFiles(files));
      if (task) {
        await client.updateProjectTask(task.id, { title: title.trim(), prompt: prompt.trim(), attachments });
      } else {
        await client.createProjectTask(projectId, { title: title.trim(), prompt: prompt.trim(), attachments });
      }
      await snapshotStore.refresh();
      return true;
    }, "Could not save the task.");
    if (result) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dismissable={!action.busy}
      full
      title={task ? "Edit task" : "New task"}
      footer={<div className="flex gap-2"><Button tone="neutral" block disabled={action.busy} onClick={onClose}>Cancel</Button><Button block busy={action.busy} disabled={!title.trim() || !prompt.trim()} onClick={() => void save()}>Save task</Button></div>}
    >
      {action.error ? <InlineError message={action.error} /> : null}
      <div className="space-y-4 px-4 py-4">
        <label className="block"><span className="mb-1.5 block text-xs font-medium text-[var(--ec-muted)]">Title</span><Input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label>
        <label className="block"><span className="mb-1.5 block text-xs font-medium text-[var(--ec-muted)]">Agent prompt</span><Textarea rows={9} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <div><span className="mb-1.5 block text-xs font-medium text-[var(--ec-muted)]">Attachments</span><MobileTaskAttachmentField stored={storedAttachments} onStoredChange={setStoredAttachments} files={files} onFilesChange={setFiles} disabled={action.busy} /></div>
      </div>
    </Sheet>
  );
};

const TaskDetailSheet = ({
  task,
  onClose,
  onEdit,
  onStart,
}: {
  task: ProjectTaskRecord | null;
  onClose: () => void;
  onEdit: (task: ProjectTaskRecord) => void;
  onStart: (task: ProjectTaskRecord) => void;
}) => {
  const { client } = useMobileApp();
  return (
    <Sheet
      open={Boolean(task)}
      onClose={onClose}
      title={task?.title}
      footer={task ? <div className="flex gap-2">{client.capabilities.taskMutations ? <Button tone="neutral" block onClick={() => onEdit(task)}><Pencil className="size-4" />Edit</Button> : null}{client.capabilities.runMutations ? <Button block onClick={() => onStart(task)}><Play className="size-4" />{task.status === "open" ? "Start run" : "Re-run"}</Button> : null}</div> : null}
    >
      {task ? <div className="space-y-4 px-4 py-4"><Badge tone={TASK_TONES[task.status]}>{task.status.replace("_", " ")}</Badge><p className="m-wrap-anywhere whitespace-pre-wrap text-sm leading-6 text-[var(--ec-muted)]">{task.prompt}</p>{task.attachments.length > 0 ? <div><SectionLabel>Attachments</SectionLabel><MobileStoredAttachments attachments={task.attachments} /></div> : null}</div> : null}
    </Sheet>
  );
};

const BranchesTab = ({ projectId }: { projectId: string }) => {
  const { client } = useMobileApp();
  const [overview, setOverview] = useState<ProjectGitBranchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const action = useAction();

  const load = useCallback(async () => {
    try {
      setOverview(await client.getProjectBranchOverview(projectId));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load branches."));
    }
  }, [client, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <InlineError message={error} onRetry={() => void load()} />;
  if (!overview) return <CenteredSpinner label="Loading branches" />;

  return (
    <div className="m-scroll flex-1">
      {action.error ? <InlineError message={action.error} /> : null}
      <div className="flex gap-2 border-b border-[var(--ec-border)] px-4 py-2.5">
        <Button
          tone="neutral"
          size="sm"
          className="flex-1"
          busy={action.busy}
          disabled={!client.capabilities.gitMutations}
          onClick={() => void action.run(() => client.fetchProjectBranches(projectId)).then(load)}
        >
          Fetch
        </Button>
        <Button
          tone="neutral"
          size="sm"
          className="flex-1"
          busy={action.busy}
          disabled={!client.capabilities.gitMutations}
          onClick={() => void action.run(() => client.pullProjectBranch(projectId)).then(load)}
        >
          Pull
        </Button>
      </div>
      <SectionLabel>Local branches</SectionLabel>
      {overview.branches.map((branch) => (
        <ListRow
          key={branch.name}
          leading={<GitBranch className="size-4" />}
          title={<span className="m-mono text-[12.5px]">{branch.name}</span>}
          subtitle={branch.upstream ?? undefined}
          trailing={branch.isCurrent ? <Badge tone="accent">current</Badge> : undefined}
          className="border-b border-[var(--ec-border)]"
        />
      ))}
      <div className="h-6" />
    </div>
  );
};

export const ProjectScreen = ({ projectId, tab }: { projectId: string; tab: ProjectTab }) => {
  const { snapshot, router, client, selectProject } = useMobileApp();
  const project = snapshot.projects.find((entry) => entry.project.id === projectId) ?? null;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<ProjectTaskRecord | null>(null);
  const [taskEditor, setTaskEditor] = useState<{ key: string; task: ProjectTaskRecord | null } | null>(null);

  const runs = useMemo(
    () => (project ? filterRuns(flattenRuns([project]), "all", "") : []),
    [project],
  );
  const forLater = useMemo(
    () => (project ? filterRuns(flattenRuns([project]), "for-later", "") : []),
    [project],
  );

  useEffect(() => {
    if (project) selectProject(project.project.id);
  }, [project, selectProject]);

  useEffect(() => {
    if (selectedTaskId && !project?.tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(null);
      setSelectedTask(null);
    }
  }, [project?.tasks, selectedTaskId]);

  const openTaskDetail = async (task: ProjectTaskSummary) => {
    try {
      const detail = await client.getProjectTask(task.id);
      setSelectedTask(detail);
      setSelectedTaskId(detail.id);
    } catch (caught) {
      window.alert(errorMessage(caught, "Could not load task attachments."));
    }
  };

  const options = useMemo<SegmentOption<ProjectTab>[]>(() => {
    const base: SegmentOption<ProjectTab>[] = [
      { value: "overview", label: "Overview" },
      { value: "runs", label: "Runs", ...(runs.length ? { badge: runs.length } : {}) },
      { value: "tasks", label: "Tasks", ...(project?.tasks.length ? { badge: project.tasks.length } : {}) },
    ];
    if (project?.project.kind === "git") base.push({ value: "branches", label: "Branches" });
    base.push({ value: "for-later", label: "For later", ...(forLater.length ? { badge: forLater.length } : {}) });
    base.push({ value: "settings", label: "Settings" });
    return base;
  }, [forLater.length, project?.project.kind, project?.tasks.length, runs.length]);

  const activeTab = options.some((option) => option.value === tab) ? tab : "overview";

  if (!project) {
    return (
      <>
        <AppBar title="Project" onBack={router.back} />
        <EmptyState title="Project unavailable" message="It may have been removed on the host." />
      </>
    );
  }

  const openRun = (runId: string) => router.push({ name: "run", runId, segment: "activity" });

  return (
    <>
      <AppBar title={project.project.name} subtitle={project.project.repoPath} onBack={router.back} />

      <SegmentedTabs
        options={options}
        value={activeTab}
        onChange={(next) => router.replace({ name: "project", projectId, tab: next })}
      />

      {activeTab === "overview" ? (
        <div className="m-scroll m-screen-enter flex-1">
          <div className="grid grid-cols-2 gap-2 px-4 py-3">
            {[
              { label: "Runs", value: String(runs.length) },
              { label: "Tasks", value: String(project.tasks.length) },
              { label: "Tokens in", value: compactNumber(project.project.cumulativeInputTokens) },
              { label: "Tokens out", value: compactNumber(project.project.cumulativeOutputTokens) },
            ].map((stat) => (
              <div key={stat.label} className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2.5">
                <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--ec-faint)]">{stat.label}</p>
                <p className="mt-0.5 text-lg font-semibold">{stat.value}</p>
              </div>
            ))}
          </div>

          <SectionLabel>Details</SectionLabel>
          <ListRow title="Base branch" trailing={<span className="m-mono">{project.project.baseBranch}</span>} />
          <ListRow title="Kind" trailing={project.project.kind} />
          <ListRow title="Last opened" trailing={absoluteTime(project.project.lastOpenedAt)} />

          {project.insights.length > 0 ? (
            <>
              <SectionLabel>Latest insights</SectionLabel>
              {project.insights.slice(0, 5).map((insight) => (
                <ListRow
                  key={insight.id}
                  title={insight.title}
                  subtitle={insight.summary}
                  trailing={relativeTime(insight.generatedAt)}
                  className="border-b border-[var(--ec-border)]"
                />
              ))}
            </>
          ) : null}
          <div className="h-6" />
        </div>
      ) : null}

      {activeTab === "runs" ? (
        <div className="m-scroll m-screen-enter flex-1">
          {runs.length === 0 ? (
            <EmptyState title="No runs yet" />
          ) : (
            runs.map((item) => <RunListRow key={item.run.id} item={item} showProject={false} onOpen={openRun} />)
          )}
          <div className="h-20" />
        </div>
      ) : null}

      {activeTab === "tasks" ? (
        <div className="m-scroll m-screen-enter flex-1">
          <SectionLabel action={client.capabilities.taskMutations ? <SectionAction onClick={() => setTaskEditor({ key: `new-${Date.now().toString()}`, task: null })}>Add task</SectionAction> : undefined}>Task board</SectionLabel>
          <TaskList tasks={project.tasks} onSelect={(task) => void openTaskDetail(task)} />
          <div className="h-6" />
        </div>
      ) : null}

      {activeTab === "branches" ? <BranchesTab projectId={projectId} /> : null}

      {activeTab === "settings" ? <ProjectSettingsPanel project={project} /> : null}

      {activeTab === "for-later" ? (
        <div className="m-scroll m-screen-enter flex-1">
          {forLater.length === 0 ? (
            <EmptyState title="Nothing saved for later" message="Park a run from its actions menu." />
          ) : (
            forLater.map((item) => <RunListRow key={item.run.id} item={item} showProject={false} onOpen={openRun} />)
          )}
          <div className="h-6" />
        </div>
      ) : null}

      {/* The settings tab is a form; a floating action button would sit on top of its controls. */}
      {client.capabilities.runMutations && activeTab !== "settings" && activeTab !== "tasks" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <Button
            className="pointer-events-auto h-12 rounded-full px-5 shadow-[var(--ec-action-shadow)]"
            onClick={() => router.push({ name: "new-run", projectId })}
          >
            <Plus className="size-5" />
            New run
          </Button>
        </div>
      ) : null}

      <TaskDetailSheet
        task={selectedTask}
        onClose={() => { setSelectedTaskId(null); setSelectedTask(null); }}
        onEdit={(task) => { setSelectedTaskId(null); setSelectedTask(null); setTaskEditor({ key: task.id, task }); }}
        onStart={(task) => { setSelectedTaskId(null); setSelectedTask(null); router.push({ name: "new-run", projectId, taskId: task.id }); }}
      />
      {taskEditor ? <TaskEditorSheet key={taskEditor.key} projectId={projectId} task={taskEditor.task} open onClose={() => setTaskEditor(null)} /> : null}
    </>
  );
};
