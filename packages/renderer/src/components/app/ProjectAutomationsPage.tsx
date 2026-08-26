import type {
  ChatAttachmentPayload,
  ProjectAutomationInput,
  ProjectAutomationListItem,
  ProjectAutomationRecord,
  ProjectKind,
  RunRecord,
} from "@buildwarden/shared";
import { Activity, Bot, CalendarClock, Clock3, ExternalLink, Loader2, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { StoredChatAttachments } from "./StoredChatAttachments";
import {
  automationEffortControl,
  automationExecutionOptions,
  normalizeAutomationEffort,
  type AutomationModelOption,
} from "./automation-model-effort";
import { formatRunDuration, formatRunRelativeTime } from "./run-summary-format";

interface ProjectAutomationsPageProps {
  projectId: string;
  projectKind: ProjectKind;
  automations: ProjectAutomationListItem[];
  modelOptions: AutomationModelOption[];
  defaultModelId: string;
  availableBranches: string[];
  projectBaseBranch: string;
  onOpenRun: (runId: string) => void;
  onChanged: () => void | Promise<void>;
}

type EditorDraft = {
  name: string;
  prompt: string;
  cronExpression: string;
  timeZone: string;
  modelId: string;
  effort: string;
  baseBranch: string;
  onlyIfPreviousFinished: boolean;
  enabled: boolean;
};

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const emptyDraft = (
  projectKind: ProjectKind,
  modelId: string,
  modelOptions: AutomationModelOption[],
  projectBaseBranch: string,
): EditorDraft => ({
  name: "",
  prompt: "",
  cronExpression: "0 9 * * 1-5",
  timeZone: localTimeZone(),
  modelId,
  effort: normalizeAutomationEffort(modelOptions.find((model) => model.id === modelId), "auto"),
  baseBranch: projectKind === "git" ? projectBaseBranch : "",
  onlyIfPreviousFinished: true,
  enabled: true,
});

const recordToDraft = (record: ProjectAutomationRecord, projectBaseBranch: string): EditorDraft => ({
  name: record.name,
  prompt: record.prompt,
  cronExpression: record.cronExpression,
  timeZone: record.timeZone,
  modelId: record.modelId,
  effort: record.effort,
  baseBranch: record.baseBranch ?? projectBaseBranch,
  onlyIfPreviousFinished: Boolean(record.onlyIfPreviousFinished),
  enabled: Boolean(record.enabled),
});

const durationMs = (run: RunRecord) => {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = Date.parse(run.finishedAt ?? run.updatedAt);
  return Math.max(0, end - start);
};

const formatAverageDuration = (milliseconds: number) => {
  if (!milliseconds) return "—";
  const minutes = Math.round(milliseconds / 60_000);
  return minutes < 1 ? "<1m" : minutes < 60 ? `${String(minutes)}m` : `${(minutes / 60).toFixed(1)}h`;
};

const formatScheduledTime = (value: string, timeZone: string): string =>
  `${new Date(value).toLocaleString(undefined, { timeZone })} (${timeZone})`;

const statusTone = (status: RunRecord["status"]) => status;

const MetricCard = ({ label, value, detail }: { label: string; value: string; detail: string }) => (
  <Card className="min-w-0 p-3">
    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-faint)]">{label}</p>
    <p className="mt-1 text-xl font-semibold tabular-nums text-[var(--ec-text)]">{value}</p>
    <p className="mt-0.5 truncate text-[11px] text-[var(--ec-muted)]">{detail}</p>
  </Card>
);

export const ProjectAutomationsPage = ({
  projectId,
  projectKind,
  automations,
  modelOptions,
  defaultModelId,
  availableBranches,
  projectBaseBranch,
  onOpenRun,
  onChanged,
}: ProjectAutomationsPageProps) => {
  const buildwarden = useBuildWardenClient();
  const [selectedId, setSelectedId] = useState<string | null>(automations[0]?.automation.id ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditorDraft>(() => emptyDraft(projectKind, defaultModelId, modelOptions, projectBaseBranch));
  const [storedAttachments, setStoredAttachments] = useState<ChatAttachmentPayload[]>([]);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editRequestIdRef = useRef(0);

  const selectedItem = automations.find((item) => item.automation.id === selectedId) ?? null;
  const selectedModel = modelOptions.find((model) => model.id === draft.modelId);
  const effortControl = automationEffortControl(selectedModel);
  useEffect(() => {
    if (editing) return;
    if (selectedId && automations.some((item) => item.automation.id === selectedId)) return;
    setSelectedId(automations[0]?.automation.id ?? null);
  }, [automations, editing, selectedId]);

  const allRuns = useMemo(() => automations.flatMap((item) => item.runs), [automations]);
  const completedRuns = allRuns.filter((run) => run.status === "completed");
  const terminalRuns = allRuns.filter((run) => ["completed", "failed", "cancelled"].includes(run.status));
  const averageDuration = terminalRuns.length
    ? terminalRuns.reduce((total, run) => total + durationMs(run), 0) / terminalRuns.length
    : 0;
  const last30Days = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  const recentRuns = allRuns.filter((run) => Date.parse(run.createdAt) >= last30Days);
  const totalTokens = allRuns.reduce((total, run) => total + run.inputTokens + run.outputTokens, 0);
  const maxRunCount = Math.max(1, ...automations.map((item) => item.runs.length));

  const startNew = () => {
    editRequestIdRef.current += 1;
    setSelectedId(null);
    setDraft(emptyDraft(projectKind, defaultModelId, modelOptions, projectBaseBranch));
    setStoredAttachments([]);
    setNewFiles([]);
    setEditing(true);
    setError(null);
  };

  const editSelected = async () => {
    if (!selectedItem) return;
    const automationId = selectedItem.automation.id;
    const requestId = editRequestIdRef.current + 1;
    editRequestIdRef.current = requestId;
    setBusy(true);
    setError(null);
    try {
      const record = await buildwarden.getProjectAutomation(automationId);
      if (editRequestIdRef.current !== requestId || record.id !== automationId) return;
      const nextDraft = recordToDraft(record, projectBaseBranch);
      const model = modelOptions.find((option) => option.id === nextDraft.modelId);
      setDraft({ ...nextDraft, effort: normalizeAutomationEffort(model, nextDraft.effort) });
      setStoredAttachments(record.attachments);
      setNewFiles([]);
      setEditing(true);
    } catch (caught) {
      if (editRequestIdRef.current !== requestId) return;
      setError(caught instanceof Error ? caught.message : "Could not load this automation.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const automationId = selectedId;
    const requestId = editRequestIdRef.current + 1;
    editRequestIdRef.current = requestId;
    setBusy(true);
    setError(null);
    try {
      const attachments = [...storedAttachments, ...(await readFilesAsChatPayloads(newFiles))];
      const effort = normalizeAutomationEffort(selectedModel, draft.effort);
      const input: ProjectAutomationInput = {
        ...draft,
        workspaceType: projectKind === "git" ? "worktree" : "copy",
        effort,
        executionOptions: automationExecutionOptions(selectedModel, effort),
        attachments,
      };
      const saved = automationId
        ? await buildwarden.updateProjectAutomation(automationId, input)
        : await buildwarden.createProjectAutomation(projectId, input);
      if (editRequestIdRef.current === requestId) {
        setSelectedId(saved.id);
        setEditing(false);
      }
      await onChanged();
    } catch (caught) {
      if (editRequestIdRef.current !== requestId) return;
      setError(caught instanceof Error ? caught.message : "Could not save this automation.");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (!selectedItem) return;
    setBusy(true);
    setError(null);
    try {
      await buildwarden.runProjectAutomationNow(selectedItem.automation.id);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start this automation.");
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    if (!selectedItem) return;
    setBusy(true);
    setError(null);
    try {
      await buildwarden.updateProjectAutomation(selectedItem.automation.id, {
        enabled: !selectedItem.automation.enabled,
      });
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change this automation's schedule state.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selectedItem || !window.confirm(`Delete “${selectedItem.automation.name}” and all of its run history?`)) return;
    const automationId = selectedItem.automation.id;
    setBusy(true);
    setError(null);
    try {
      await buildwarden.deleteProjectAutomation(automationId);
      setSelectedId((currentId) => currentId === automationId ? null : currentId);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete this automation.");
    } finally {
      setBusy(false);
    }
  };

  const branchOptions = [...new Set([...availableBranches, projectBaseBranch].filter(Boolean))]
    .map((branch) => ({ value: branch, label: branch }));

  return (
    <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--ec-text)]"><CalendarClock className="size-4 text-[var(--ec-accent)]" />Automations</h2>
            <p className="mt-0.5 text-xs text-[var(--ec-muted)]">Run saved prompts on a cron schedule. Times use each automation’s configured time zone.</p>
          </div>
          <Button type="button" size="sm" onClick={startNew}><Plus className="size-3.5" />New automation</Button>
        </div>

        <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <MetricCard label="Runs" value={allRuns.length.toLocaleString()} detail={`${recentRuns.length.toLocaleString()} in the last 30 days`} />
          <MetricCard label="Success rate" value={terminalRuns.length ? `${String(Math.round(completedRuns.length / terminalRuns.length * 100))}%` : "—"} detail={`${completedRuns.length.toLocaleString()} completed`} />
          <MetricCard label="Average duration" value={formatAverageDuration(averageDuration)} detail={`${terminalRuns.length.toLocaleString()} finished runs`} />
          <MetricCard label="Token usage" value={totalTokens.toLocaleString()} detail="Input + output tokens" />
        </section>

        {automations.length > 0 ? (
          <Card className="p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--ec-text)]"><Activity className="size-3.5 text-[var(--ec-accent)]" />Runs by automation</div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {automations.map((item) => (
                <button key={item.automation.id} type="button" className="rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2 text-left hover:bg-[var(--ec-hover)]" onClick={() => { editRequestIdRef.current += 1; setSelectedId(item.automation.id); setEditing(false); }}>
                  <div className="flex items-center justify-between gap-2 text-[11px]"><span className="truncate font-medium text-[var(--ec-text)]">{item.automation.name}</span><span className="font-mono text-[var(--ec-muted)]">{item.runs.length}</span></div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--ec-control)]"><span className="block h-full rounded-full bg-[var(--ec-accent)]" style={{ width: `${String(item.runs.length / maxRunCount * 100)}%` }} /></div>
                </button>
              ))}
            </div>
          </Card>
        ) : null}

        <div className="grid min-h-[440px] gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
          <Card className="min-h-0 overflow-hidden p-0">
            <div className="border-b border-[var(--ec-border)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-faint)]">Schedules</div>
            {automations.length === 0 ? <div className="p-5 text-center text-xs text-[var(--ec-muted)]">No schedules yet.</div> : (
              <div className="divide-y divide-[var(--ec-border)]">
                {automations.map((item) => (
                  <button key={item.automation.id} type="button" onClick={() => { editRequestIdRef.current += 1; setSelectedId(item.automation.id); setEditing(false); setError(null); }} className={`w-full p-3 text-left transition ${selectedId === item.automation.id && !editing ? "bg-[var(--ec-accent-soft)]" : "hover:bg-[var(--ec-hover)]"}`}>
                    <div className="flex items-center gap-2"><span className={`size-2 rounded-full ${item.automation.enabled ? "bg-[var(--ec-success)]" : "bg-[var(--ec-faint)]"}`} /><span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--ec-text)]">{item.automation.name}</span></div>
                    <p className="mt-1 truncate font-mono text-[10px] text-[var(--ec-muted)]">{item.automation.cronExpression}</p>
                    <p className="mt-1 text-[10px] text-[var(--ec-faint)]">Next {formatScheduledTime(item.automation.nextRunAt, item.automation.timeZone)}</p>
                  </button>
                ))}
              </div>
            )}
          </Card>

          {editing ? (
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-[var(--ec-text)]">{selectedId ? "Edit automation" : "New automation"}</h3><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-xs text-[var(--ec-muted)]">Name<Input className="mt-1 h-9" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Daily dependency review" /></label>
                <label className="text-xs text-[var(--ec-muted)]">Model<Select className="mt-1" value={draft.modelId} options={modelOptions.map((model) => ({ value: model.id, label: model.label }))} onValueChange={(modelId) => {
                  const model = modelOptions.find((option) => option.id === modelId);
                  setDraft({ ...draft, modelId, effort: normalizeAutomationEffort(model, "auto") });
                }} searchable /></label>
                <label className="md:col-span-2 text-xs text-[var(--ec-muted)]">Prompt<Textarea className="mt-1 min-h-28" value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder="Inspect the project and…" /></label>
                <div className="md:col-span-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2">
                  {storedAttachments.length > 0 ? <><StoredChatAttachments attachments={storedAttachments} compact /><Button type="button" size="sm" variant="ghost" className="mt-1 h-7 text-[11px]" onClick={() => setStoredAttachments([])}>Remove saved attachments</Button></> : null}
                  <ChatAttachmentPicker files={newFiles} onChange={setNewFiles} disabled={busy} />
                </div>
                <label className="text-xs text-[var(--ec-muted)]">Cron schedule<Input className="mt-1 h-9 font-mono" value={draft.cronExpression} onChange={(event) => setDraft({ ...draft, cronExpression: event.target.value })} placeholder="0 9 * * 1-5" /><span className="mt-1 block text-[10px] text-[var(--ec-faint)]">minute hour day month weekday · e.g. <code>*/30 * * * *</code></span></label>
                <label className="text-xs text-[var(--ec-muted)]">Time zone<Input className="mt-1 h-9" value={draft.timeZone} onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })} /></label>
                {effortControl ? <label className="text-xs text-[var(--ec-muted)]">{effortControl.label}<Select className="mt-1" value={draft.effort} options={effortControl.options} onValueChange={(effort) => setDraft({ ...draft, effort })} /></label> : null}
                <div className="text-xs text-[var(--ec-muted)]">Workspace<div className="mt-1 flex h-9 items-center rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 text-xs font-medium text-[var(--ec-text)]">{projectKind === "git" ? "Isolated worktree" : "Isolated folder copy"}</div></div>
                {projectKind === "git" ? <label className="text-xs text-[var(--ec-muted)]">Worktree source branch<Select ariaLabel="Automation branch" className="mt-1" value={draft.baseBranch} options={branchOptions} onValueChange={(baseBranch) => setDraft({ ...draft, baseBranch })} searchable /></label> : null}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="flex items-center justify-between rounded-md border border-[var(--ec-border)] p-2 text-xs text-[var(--ec-text)]"><span><span className="block font-medium">Enabled</span><span className="text-[10px] text-[var(--ec-muted)]">Allow scheduled starts</span></span><Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} /></label>
                <label className="flex items-center justify-between rounded-md border border-[var(--ec-border)] p-2 text-xs text-[var(--ec-text)]"><span><span className="block font-medium">Wait for previous run</span><span className="text-[10px] text-[var(--ec-muted)]">Skip an occurrence while active</span></span><Switch checked={draft.onlyIfPreviousFinished} onCheckedChange={(onlyIfPreviousFinished) => setDraft({ ...draft, onlyIfPreviousFinished })} /></label>
              </div>
              {error ? <p className="mt-3 text-xs text-[var(--ec-danger)]">{error}</p> : null}
              <div className="mt-4 flex justify-end"><Button type="button" size="sm" disabled={busy || modelOptions.length === 0 || (projectKind === "git" && !draft.baseBranch)} onClick={() => void save()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}{busy ? "Saving…" : "Save automation"}</Button></div>
            </Card>
          ) : selectedItem ? (
            <Card className="min-w-0 p-0">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--ec-border)] p-4">
                <div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate text-sm font-semibold text-[var(--ec-text)]">{selectedItem.automation.name}</h3><Badge tone={selectedItem.automation.enabled ? "completed" : "neutral"} className="px-2 py-0.5 text-[10px]">{selectedItem.automation.enabled ? "Enabled" : "Paused"}</Badge></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--ec-muted)]">{selectedItem.automation.prompt}</p></div>
                <div className="flex flex-wrap justify-end gap-1"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void toggleEnabled()}>{selectedItem.automation.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}{selectedItem.automation.enabled ? "Pause schedule" : "Resume schedule"}</Button><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void runNow()}><Play className="size-3.5" />Run now</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void editSelected()}><Pencil className="size-3.5" /></Button><Button type="button" size="sm" variant="ghost" disabled={busy} className="text-[var(--ec-danger)]" onClick={() => void remove()}><Trash2 className="size-3.5" /></Button></div>
              </div>
              <div className={`grid gap-px border-b border-[var(--ec-border)] bg-[var(--ec-border)] ${projectKind === "git" ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
                {[{ label: "Schedule", value: selectedItem.automation.cronExpression }, { label: "Next run", value: formatScheduledTime(selectedItem.automation.nextRunAt, selectedItem.automation.timeZone) }, { label: "Workspace", value: projectKind === "git" ? "Isolated worktree" : "Isolated folder copy" }, ...(projectKind === "git" ? [{ label: "Branch", value: selectedItem.automation.baseBranch ?? projectBaseBranch }] : []), { label: "Runs", value: String(selectedItem.runs.length) }].map((item) => <div key={item.label} className="bg-[var(--ec-panel)] p-3"><p className="text-[9px] uppercase tracking-[0.14em] text-[var(--ec-faint)]">{item.label}</p><p className="mt-1 truncate text-xs font-medium text-[var(--ec-text)]">{item.value}</p></div>)}
              </div>
              {selectedItem.automation.lastError ? <p className="m-3 rounded-md bg-[var(--ec-danger-soft)] p-2 text-xs text-[var(--ec-danger)]">Last start failed: {selectedItem.automation.lastError}</p> : null}
              <div className="p-3"><h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--ec-text)]"><Clock3 className="size-3.5" />Run history</h4>{selectedItem.runs.length === 0 ? <p className="rounded-md border border-dashed border-[var(--ec-border)] p-6 text-center text-xs text-[var(--ec-muted)]">This automation has not run yet.</p> : <div className="divide-y divide-[var(--ec-border)] overflow-hidden rounded-md border border-[var(--ec-border)]">{selectedItem.runs.map((run) => <button key={run.id} type="button" className="flex w-full items-center gap-3 p-2.5 text-left hover:bg-[var(--ec-hover)]" onClick={() => onOpenRun(run.id)}><Bot className="size-4 shrink-0 text-[var(--ec-accent)]" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Badge tone={statusTone(run.status)} dot className="px-2 py-0.5 text-[10px]">{run.status}</Badge><span className="truncate text-[11px] text-[var(--ec-muted)]">{formatRunRelativeTime(run.createdAt)}</span></div><p className="mt-1 truncate text-[10px] text-[var(--ec-faint)]">{formatRunDuration(run)} · {(run.inputTokens + run.outputTokens).toLocaleString()} tokens · {run.branchName}</p></div><ExternalLink className="size-3.5 shrink-0 text-[var(--ec-faint)]" /></button>)}</div>}</div>
              {error ? <p className="px-3 pb-3 text-xs text-[var(--ec-danger)]">{error}</p> : null}
            </Card>
          ) : (
            <Card className="flex min-h-72 flex-col items-center justify-center p-8 text-center"><CalendarClock className="size-8 text-[var(--ec-faint)]" /><h3 className="mt-3 text-sm font-semibold text-[var(--ec-text)]">Schedule recurring agent work</h3><p className="mt-1 max-w-md text-xs leading-5 text-[var(--ec-muted)]">Save a prompt, attachments, model, effort, and cron schedule. Automation runs stay out of normal run lists while remaining fully inspectable here.</p><Button type="button" size="sm" className="mt-4" onClick={startNew}><Plus className="size-3.5" />Create automation</Button></Card>
          )}
        </div>
      </div>
    </div>
  );
};
