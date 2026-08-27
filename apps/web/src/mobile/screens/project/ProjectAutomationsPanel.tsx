import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AppSnapshot,
  ChatAttachmentPayload,
  ProjectAutomationInput,
  ProjectAutomationListItem,
  ProjectAutomationRecord,
  ProjectKind,
} from "@buildwarden/shared";
import {
  automationEffortControl,
  automationExecutionOptions,
  normalizeAutomationEffort,
  type AutomationModelOption,
} from "@buildwarden/renderer/automation-model-effort";
import { Bot, CalendarClock, Paperclip, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { absoluteTime, relativeTime } from "../../lib/format";
import { mergeMobileTaskAttachments, readMobileAttachmentFiles } from "../../lib/task-attachments";
import { Badge, Button, EmptyState, InlineError, Input, ListRow, SectionAction, SectionLabel, Textarea, type Tone } from "../../components/primitives";
import { Sheet } from "../../components/Sheet";
import { ToggleRow } from "../../components/SettingControls";
import { MobileTaskAttachmentField } from "../../components/TaskAttachments";

type ProjectSnapshot = AppSnapshot["projects"][number];

const runTone = (status: ProjectAutomationListItem["runs"][number]["status"]): Tone => {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "running" || status === "preparing" || status === "queued") return "accent";
  return "neutral";
};

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

interface AutomationDraft {
  name: string;
  prompt: string;
  cronExpression: string;
  timeZone: string;
  modelId: string;
  effort: string;
  baseBranch: string;
  enabled: boolean;
  onlyIfPreviousFinished: boolean;
}

const automationDraft = (
  record: ProjectAutomationRecord | null,
  models: readonly AutomationModelOption[],
  baseBranch: string,
): AutomationDraft => {
  const modelId = record?.modelId ?? models[0]?.id ?? "";
  const model = models.find((option) => option.id === modelId);
  return {
    name: record?.name ?? "",
    prompt: record?.prompt ?? "",
    cronExpression: record?.cronExpression ?? "0 9 * * 1-5",
    timeZone: record?.timeZone ?? localTimeZone(),
    modelId,
    effort: model || !record ? normalizeAutomationEffort(model, record?.effort ?? "auto") : record.effort,
    baseBranch: record?.baseBranch ?? baseBranch,
    enabled: record ? Boolean(record.enabled) : true,
    onlyIfPreviousFinished: record ? Boolean(record.onlyIfPreviousFinished) : true,
  };
};

const FieldLabel = ({ children }: { children: ReactNode }) => (
  <span className="mb-1.5 block text-xs font-medium text-[var(--ec-muted)]">{children}</span>
);

const AutomationEditorSheet = ({
  projectId,
  projectKind,
  projectBaseBranch,
  models,
  record,
  onClose,
}: {
  projectId: string;
  projectKind: ProjectKind;
  projectBaseBranch: string;
  models: readonly AutomationModelOption[];
  record: ProjectAutomationRecord | null;
  onClose: () => void;
}) => {
  const { client, snapshotStore } = useMobileApp();
  const action = useAction();
  const [draft, setDraft] = useState(() => automationDraft(record, models, projectBaseBranch));
  const [storedAttachments, setStoredAttachments] = useState<ChatAttachmentPayload[]>(record?.attachments ?? []);
  const [files, setFiles] = useState<File[]>([]);
  const [branches, setBranches] = useState<string[]>([projectBaseBranch]);
  const selectedModel = models.find((model) => model.id === draft.modelId);
  const effortControl = automationEffortControl(selectedModel);

  useEffect(() => {
    if (projectKind !== "git") return;
    let cancelled = false;
    void client.getProjectBranches(projectId).then((available) => {
      if (!cancelled) setBranches([...new Set([...available, projectBaseBranch, draft.baseBranch].filter(Boolean))]);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [client, draft.baseBranch, projectBaseBranch, projectId, projectKind]);

  const valid = Boolean(
    draft.name.trim() && draft.cronExpression.trim() && draft.timeZone.trim() && draft.modelId &&
    (draft.prompt.trim() || storedAttachments.length > 0 || files.length > 0) &&
    (projectKind !== "git" || draft.baseBranch),
  );

  const save = async () => {
    if (!valid) return;
    const saved = await action.run(async () => {
      const attachments = mergeMobileTaskAttachments(storedAttachments, await readMobileAttachmentFiles(files));
      const storedModelSettings = record && !selectedModel && draft.modelId === record.modelId ? record : null;
      const effort = storedModelSettings?.effort ?? normalizeAutomationEffort(selectedModel, draft.effort);
      const input: ProjectAutomationInput = {
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        attachments,
        cronExpression: draft.cronExpression.trim(),
        timeZone: draft.timeZone.trim(),
        modelId: draft.modelId,
        effort,
        executionOptions: storedModelSettings?.executionOptions ?? automationExecutionOptions(selectedModel, effort),
        workspaceType: projectKind === "git" ? "worktree" : "copy",
        baseBranch: projectKind === "git" ? draft.baseBranch : null,
        enabled: draft.enabled,
        onlyIfPreviousFinished: draft.onlyIfPreviousFinished,
      };
      if (record) await client.updateProjectAutomation(record.id, input);
      else await client.createProjectAutomation(projectId, input);
      await snapshotStore.refresh();
      return true;
    }, "Could not save the automation.");
    if (saved) onClose();
  };

  return (
    <Sheet
      open
      full
      dismissable={!action.busy}
      title={record ? "Edit automation" : "New automation"}
      onClose={onClose}
      footer={<div className="flex gap-2"><Button tone="neutral" block disabled={action.busy} onClick={onClose}>Cancel</Button><Button block busy={action.busy} disabled={!valid} onClick={() => void save()}>Save automation</Button></div>}
    >
      {action.error ? <InlineError message={action.error} /> : null}
      <div className="space-y-4 px-4 py-4">
        <label className="block"><FieldLabel>Name</FieldLabel><Input value={draft.name} autoFocus onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="block"><FieldLabel>Agent prompt</FieldLabel><Textarea rows={8} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} /></label>
        <div><FieldLabel>Attachments</FieldLabel><MobileTaskAttachmentField stored={storedAttachments} onStoredChange={setStoredAttachments} files={files} onFilesChange={setFiles} disabled={action.busy} /></div>
        <label className="block"><FieldLabel>Cron schedule</FieldLabel><Input className="m-mono" value={draft.cronExpression} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setDraft({ ...draft, cronExpression: event.target.value })} /><p className="mt-1 text-[11px] text-[var(--ec-faint)]">minute hour day month weekday</p></label>
        <label className="block"><FieldLabel>Time zone</FieldLabel><Input value={draft.timeZone} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })} /></label>
        <label className="block"><FieldLabel>Model</FieldLabel><select value={draft.modelId} onChange={(event) => {
          const modelId = event.target.value;
          setDraft({ ...draft, modelId, effort: normalizeAutomationEffort(models.find((model) => model.id === modelId), "auto") });
        }} className="m-tap w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-sm text-[var(--ec-text)]">{!selectedModel && draft.modelId ? <option value={draft.modelId}>{draft.modelId} (unavailable)</option> : null}{models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
        {effortControl ? <label className="block"><FieldLabel>{effortControl.label}</FieldLabel><select value={normalizeAutomationEffort(selectedModel, draft.effort)} onChange={(event) => setDraft({ ...draft, effort: event.target.value })} className="m-tap w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-sm text-[var(--ec-text)]">{effortControl.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null}
        {projectKind === "git" ? <label className="block"><FieldLabel>Worktree source branch</FieldLabel><select value={draft.baseBranch} onChange={(event) => setDraft({ ...draft, baseBranch: event.target.value })} className="m-tap w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-sm text-[var(--ec-text)]">{branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select></label> : null}
        <div className="overflow-hidden rounded-lg border border-[var(--ec-border)]">
          <ToggleRow title="Enabled" description="Allow scheduled starts" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
          <ToggleRow title="Wait for previous run" description="Skip an occurrence while a previous run is active" checked={draft.onlyIfPreviousFinished} onChange={(onlyIfPreviousFinished) => setDraft({ ...draft, onlyIfPreviousFinished })} />
        </div>
        <p className="rounded-lg bg-[var(--ec-accent-soft)] px-3 py-2 text-xs leading-5 text-[var(--ec-accent)]">Automation runs always use Full Access so scheduled work cannot stall on approval dialogs.</p>
      </div>
    </Sheet>
  );
};

export const ProjectAutomationsPanel = ({
  project,
  models,
  onOpenRun,
}: {
  project: ProjectSnapshot;
  models: readonly AutomationModelOption[];
  onOpenRun: (runId: string) => void;
}) => {
  const { client, snapshotStore } = useMobileApp();
  const canManage = client.capabilities.automationMutations;
  const automations = useMemo(() => project.automations ?? [], [project.automations]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ key: string; record: ProjectAutomationRecord | null } | null>(null);
  const action = useAction();
  const selected = automations.find((item) => item.automation.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !automations.some((item) => item.automation.id === selectedId)) setSelectedId(null);
  }, [automations, selectedId]);

  const modelNames = useMemo(() => new Map(models.map((model) => [model.id, model.label])), [models]);

  const edit = async () => {
    if (!canManage || !selected) return;
    const record = await action.run(
      () => client.getProjectAutomation(selected.automation.id),
      "Could not load the automation.",
    );
    if (record) setEditor({ key: record.id, record });
  };

  const mutate = async (operation: () => Promise<unknown>, fallback: string) => {
    const result = await action.run(async () => {
      await operation();
      await snapshotStore.refresh();
      return true;
    }, fallback);
    return Boolean(result);
  };

  const remove = async () => {
    if (!canManage || !selected || !window.confirm(`Delete “${selected.automation.name}” and all of its run history?`)) return;
    const removed = await mutate(() => client.deleteProjectAutomation(selected.automation.id), "Could not delete the automation.");
    if (removed) setSelectedId(null);
  };

  return (
    <div className="m-scroll m-screen-enter flex-1">
      {action.error ? <InlineError message={action.error} /> : null}
      <SectionLabel action={canManage ? <SectionAction onClick={() => setEditor({ key: `new-${Date.now().toString()}`, record: null })}>Add automation</SectionAction> : undefined}>Schedules</SectionLabel>
      {!canManage ? <p className="mx-4 mb-2 rounded-md bg-[var(--ec-muted-soft)] px-3 py-2 text-xs text-[var(--ec-muted)]">This remote session is read-only. You can inspect schedules and run history, but cannot change or start automations.</p> : null}
      {automations.length === 0 ? <EmptyState icon={<CalendarClock className="size-7" />} title="No automations" message={canManage ? "Schedule recurring agent work for this project." : "No schedules have been configured on the host."} action={canManage ? <Button onClick={() => setEditor({ key: `new-${Date.now().toString()}`, record: null })}><Plus className="size-4" />New automation</Button> : undefined} /> : automations.map((item) => (
        <ListRow
          key={item.automation.id}
          leading={<CalendarClock className="size-4" />}
          title={item.automation.name}
          subtitle={`${item.automation.cronExpression} · ${item.automation.timeZone}`}
          trailing={<><Badge tone={item.automation.enabled ? "success" : "neutral"}>{item.automation.enabled ? "enabled" : "paused"}</Badge>{item.runs.length}</>}
          onClick={() => setSelectedId(item.automation.id)}
          className="border-b border-[var(--ec-border)]"
        />
      ))}
      <div className="h-6" />

      <Sheet
        open={Boolean(selected)}
        title={selected?.automation.name}
        onClose={() => setSelectedId(null)}
        footer={selected && canManage ? <div className="grid grid-cols-2 gap-2"><Button tone="neutral" busy={action.busy} onClick={() => void mutate(() => client.updateProjectAutomation(selected.automation.id, { enabled: !selected.automation.enabled }), "Could not change the schedule.")}>{selected.automation.enabled ? "Pause" : "Resume"}</Button><Button busy={action.busy} onClick={() => void mutate(() => client.runProjectAutomationNow(selected.automation.id), "Could not start the automation.")}><Play className="size-4" />Run now</Button><Button tone="neutral" disabled={action.busy} onClick={() => void edit()}><Pencil className="size-4" />Edit</Button><Button tone="danger" disabled={action.busy} onClick={() => void remove()}><Trash2 className="size-4" />Delete</Button></div> : undefined}
      >
        {selected ? <div className="space-y-4 px-4 py-4">
          <div className="flex items-center gap-2"><Badge tone={selected.automation.enabled ? "success" : "neutral"}>{selected.automation.enabled ? "Enabled" : "Paused"}</Badge><span className="text-xs text-[var(--ec-muted)]">Full Access</span></div>
          <p className="m-wrap-anywhere whitespace-pre-wrap text-sm leading-6 text-[var(--ec-muted)]">{selected.automation.prompt || "Attachments only"}</p>
          <div className="overflow-hidden rounded-lg border border-[var(--ec-border)]">
            <ListRow title="Schedule" trailing={<span className="m-mono">{selected.automation.cronExpression}</span>} />
            <ListRow title="Time zone" trailing={selected.automation.timeZone} />
            <ListRow title="Next run" trailing={absoluteTime(selected.automation.nextRunAt)} />
            <ListRow title="Model" trailing={modelNames.get(selected.automation.modelId) ?? selected.automation.modelId} />
            {selected.automation.attachmentCount > 0 ? <ListRow title="Attachments" trailing={<span className="inline-flex items-center gap-1"><Paperclip className="size-3.5" />{selected.automation.attachmentCount}</span>} /> : null}
          </div>
          <div><SectionLabel>Run history</SectionLabel>{selected.runs.length === 0 ? <p className="px-4 py-5 text-center text-xs text-[var(--ec-muted)]">This automation has not run yet.</p> : selected.runs.map((run) => <ListRow key={run.id} leading={<Bot className="size-4" />} title={<span className="capitalize">{run.status}</span>} subtitle={relativeTime(run.createdAt)} trailing={<Badge tone={runTone(run.status)}>{run.status}</Badge>} onClick={() => onOpenRun(run.id)} className="border-b border-[var(--ec-border)]" />)}</div>
        </div> : null}
      </Sheet>

      {editor ? <AutomationEditorSheet key={editor.key} projectId={project.project.id} projectKind={project.project.kind} projectBaseBranch={project.project.baseBranch} models={models} record={editor.record} onClose={() => setEditor(null)} /> : null}
    </div>
  );
};
