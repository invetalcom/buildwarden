import type {
  AutomationActionType,
  AutomationInput,
  AutomationPrMrEvent,
  AutomationRecord,
  AutomationRunDetail,
  AutomationRunRecord,
  AutomationScheduleMode,
  AutomationTriggerType,
  ProjectLabMode,
  ProjectRecord,
  ProviderType,
  RunMode,
  RunWorkspaceType,
  UnifiedProviderFamily,
} from "@buildwarden/shared";
import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { cn } from "../../lib/cn";

type ModelOption = {
  id: string;
  label: string;
  modelId: string;
  providerType: ProviderType;
  providerFamily: UnifiedProviderFamily | null;
};

type AutomationDraft = {
  name: string;
  description: string;
  enabled: boolean;
  triggerType: AutomationTriggerType;
  scheduleMode: AutomationScheduleMode;
  intervalMinutes: string;
  dailyTime: string;
  prMrEvent: AutomationPrMrEvent;
  prMrIntervalMinutes: string;
  actionType: AutomationActionType;
  modelId: string;
  reviewModelId: string;
  runMode: RunMode;
  workspaceType: RunWorkspaceType;
  baseBranch: string;
  projectLabMode: ProjectLabMode;
  titleTemplate: string;
  promptTemplate: string;
  guardMaxConcurrent: string;
  guardDailyLimit: string;
  fullAccess: boolean;
};

interface ProjectAutomationsTabProps {
  project: ProjectRecord;
  automations: AutomationRecord[];
  modelOptions: ModelOption[];
  branchOptions: string[];
  defaultModelId: string;
  defaultBaseBranch: string;
  onSelectRun: (runId: string) => void;
  onChanged: () => void | Promise<void>;
}

const ACTION_LABELS: Record<AutomationActionType, string> = {
  notify: "Notify",
  "start-run": "Start run",
  "run-project-lab": "Project Lab",
  "create-task": "Create task",
  "analyze-pr-mr": "Analyze PR/MR",
};

const TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  manual: "Manual",
  schedule: "Schedule",
  "pr-mr": "PR/MR",
};

const STATUS_TONE: Record<string, string> = {
  succeeded: "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-200",
  failed: "border-rose-500/30 bg-rose-500/[0.08] text-rose-200",
  running: "border-cyan-500/30 bg-cyan-500/[0.08] text-cyan-100",
  queued: "border-blue-500/30 bg-blue-500/[0.08] text-blue-100",
  skipped: "border-zinc-700 bg-zinc-900 text-zinc-300",
};

const formatDateTime = (value: string | null) => {
  if (!value) return "None";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "None";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const toPositiveInt = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
};

const defaultDraft = (modelId: string, baseBranch: string): AutomationDraft => ({
  name: "New automation",
  description: "",
  enabled: true,
  triggerType: "manual",
  scheduleMode: "interval",
  intervalMinutes: "60",
  dailyTime: "09:00",
  prMrEvent: "opened",
  prMrIntervalMinutes: "15",
  actionType: "notify",
  modelId,
  reviewModelId: modelId,
  runMode: "code",
  workspaceType: "worktree",
  baseBranch,
  projectLabMode: "new-feature",
  titleTemplate: "{{automation.name}}",
  promptTemplate:
    "Automation {{automation.name}} fired for {{project.name}}.\n\nTrigger: {{trigger.reason}}\nPR/MR: {{pr.title}} {{pr.url}}",
  guardMaxConcurrent: "1",
  guardDailyLimit: "12",
  fullAccess: false,
});

const draftFromAutomation = (automation: AutomationRecord, fallbackModelId: string, fallbackBaseBranch: string): AutomationDraft => {
  const draft = defaultDraft(fallbackModelId, fallbackBaseBranch);
  draft.name = automation.name;
  draft.description = automation.description;
  draft.enabled = automation.enabled !== 0;
  draft.triggerType = automation.trigger.type;
  if (automation.trigger.type === "schedule") {
    draft.scheduleMode = automation.trigger.mode;
    draft.intervalMinutes = String(automation.trigger.intervalMinutes ?? 60);
    draft.dailyTime = automation.trigger.dailyTime ?? "09:00";
  }
  if (automation.trigger.type === "pr-mr") {
    draft.prMrEvent = automation.trigger.event;
    draft.prMrIntervalMinutes = String(automation.trigger.intervalMinutes);
  }
  draft.actionType = automation.action.type;
  if (automation.action.type === "notify") {
    draft.promptTemplate = automation.action.messageTemplate;
  } else if (automation.action.type === "start-run") {
    draft.modelId = automation.action.modelId || fallbackModelId;
    draft.runMode = automation.action.mode;
    draft.workspaceType = automation.action.workspaceType;
    draft.baseBranch = automation.action.baseBranch ?? fallbackBaseBranch;
    draft.promptTemplate = automation.action.promptTemplate;
  } else if (automation.action.type === "run-project-lab") {
    draft.modelId = automation.action.implementationModelId || fallbackModelId;
    draft.reviewModelId = automation.action.reviewModelId || fallbackModelId;
    draft.projectLabMode = automation.action.mode;
    draft.baseBranch = automation.action.baseBranch ?? fallbackBaseBranch;
    draft.promptTemplate = automation.action.topicTemplate;
  } else if (automation.action.type === "create-task") {
    draft.titleTemplate = automation.action.titleTemplate;
    draft.promptTemplate = automation.action.promptTemplate;
  } else {
    draft.modelId = automation.action.modelId || fallbackModelId;
    draft.promptTemplate = automation.action.promptTemplate;
  }
  draft.guardMaxConcurrent = String(automation.guardrails.maxConcurrentRuns);
  draft.guardDailyLimit = String(automation.guardrails.dailyRunLimit);
  draft.fullAccess = automation.guardrails.accessMode === "full-access";
  return draft;
};

const buildAutomationInput = (draft: AutomationDraft): AutomationInput => {
  const trigger =
    draft.triggerType === "schedule"
      ? draft.scheduleMode === "daily"
        ? { type: "schedule" as const, mode: "daily" as const, dailyTime: draft.dailyTime }
        : { type: "schedule" as const, mode: "interval" as const, intervalMinutes: toPositiveInt(draft.intervalMinutes, 60) }
      : draft.triggerType === "pr-mr"
        ? {
            type: "pr-mr" as const,
            event: draft.prMrEvent,
            intervalMinutes: toPositiveInt(draft.prMrIntervalMinutes, 15),
            state: "open" as const,
          }
        : { type: "manual" as const };

  const action =
    draft.actionType === "start-run"
      ? {
          type: "start-run" as const,
          modelId: draft.modelId,
          mode: draft.runMode,
          workspaceType: draft.workspaceType,
          baseBranch: draft.baseBranch,
          promptTemplate: draft.promptTemplate,
        }
      : draft.actionType === "run-project-lab"
        ? {
            type: "run-project-lab" as const,
            mode: draft.projectLabMode,
            baseBranch: draft.baseBranch,
            implementationModelId: draft.modelId,
            reviewModelId: draft.reviewModelId,
            topicTemplate: draft.promptTemplate,
          }
        : draft.actionType === "create-task"
          ? {
              type: "create-task" as const,
              titleTemplate: draft.titleTemplate,
              promptTemplate: draft.promptTemplate,
            }
          : draft.actionType === "analyze-pr-mr"
            ? {
                type: "analyze-pr-mr" as const,
                modelId: draft.modelId,
                promptTemplate: draft.promptTemplate,
              }
            : {
                type: "notify" as const,
                messageTemplate: draft.promptTemplate,
              };

  return {
    name: draft.name,
    description: draft.description,
    enabled: draft.enabled,
    trigger,
    action,
    guardrails: {
      maxConcurrentRuns: toPositiveInt(draft.guardMaxConcurrent, 1),
      dailyRunLimit: toPositiveInt(draft.guardDailyLimit, 12),
      accessMode: draft.fullAccess ? "full-access" : "supervised",
      requireExternalWriteConfirmation: true,
    },
  };
};

export const ProjectAutomationsTab = ({
  project,
  automations,
  modelOptions,
  branchOptions,
  defaultModelId,
  defaultBaseBranch,
  onSelectRun,
  onChanged,
}: ProjectAutomationsTabProps) => {
  const [items, setItems] = useState<AutomationRecord[]>(automations);
  const [selectedId, setSelectedId] = useState<string | null>(automations[0]?.id ?? null);
  const [draft, setDraft] = useState(() => defaultDraft(defaultModelId, defaultBaseBranch));
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [selectedRunDetail, setSelectedRunDetail] = useState<AutomationRunDetail | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const modelSelectOptions = useMemo(
    () => modelOptions.map((option) => ({ value: option.id, label: option.label })),
    [modelOptions],
  );
  const branchSelectOptions = useMemo(
    () => (branchOptions.length ? branchOptions : [defaultBaseBranch]).map((name) => ({ value: name, label: name })),
    [branchOptions, defaultBaseBranch],
  );

  useEffect(() => {
    setItems(automations);
    setSelectedId((current) => current && automations.some((item) => item.id === current) ? current : automations[0]?.id ?? null);
  }, [automations]);

  useEffect(() => {
    if (selected) {
      setDraft(draftFromAutomation(selected, defaultModelId, defaultBaseBranch));
      setPreview(null);
    }
  }, [defaultBaseBranch, defaultModelId, selected]);

  const refreshAutomations = async () => {
    const next = await window.buildwarden.listProjectAutomations(project.id);
    setItems(next);
    await onChanged();
  };

  const refreshRuns = async (automationId: string | null) => {
    if (!automationId) {
      setRuns([]);
      setSelectedRunDetail(null);
      return;
    }
    const nextRuns = await window.buildwarden.listAutomationRuns(automationId);
    setRuns(nextRuns);
    if (nextRuns[0]) {
      setSelectedRunDetail(await window.buildwarden.getAutomationRunDetail(nextRuns[0].id));
    } else {
      setSelectedRunDetail(null);
    }
  };

  useEffect(() => {
    void refreshRuns(selectedId).catch(() => {
      setRuns([]);
      setSelectedRunDetail(null);
    });
  }, [selectedId]);

  const saveAutomation = async () => {
    const input = buildAutomationInput(draft);
    if (!input.name.trim()) {
      window.alert("Enter an automation name.");
      return;
    }
    setBusy(true);
    try {
      const saved = selected
        ? await window.buildwarden.updateProjectAutomation(selected.id, input)
        : await window.buildwarden.createProjectAutomation(project.id, input);
      await refreshAutomations();
      setSelectedId(saved.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not save automation.");
    } finally {
      setBusy(false);
    }
  };

  const createNew = () => {
    setSelectedId(null);
    setDraft(defaultDraft(defaultModelId, defaultBaseBranch));
    setRuns([]);
    setSelectedRunDetail(null);
    setPreview(null);
  };

  const duplicateSelected = () => {
    if (!selected) return;
    setSelectedId(null);
    setDraft({ ...draftFromAutomation(selected, defaultModelId, defaultBaseBranch), name: `${selected.name} copy` });
    setRuns([]);
    setSelectedRunDetail(null);
    setPreview(null);
  };

  const deleteSelected = async () => {
    if (!selected) return;
    const ok = window.confirm(`Delete automation "${selected.name}" and its local run history?`);
    if (!ok) return;
    setBusy(true);
    try {
      await window.buildwarden.deleteProjectAutomation(selected.id);
      await refreshAutomations();
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (automation: AutomationRecord) => {
    setBusy(true);
    try {
      await window.buildwarden.runProjectAutomationNow(automation.id);
      await refreshAutomations();
      await refreshRuns(automation.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not run automation.");
    } finally {
      setBusy(false);
    }
  };

  const previewDraft = async () => {
    setBusy(true);
    try {
      const result = await window.buildwarden.previewProjectAutomation(project.id, buildAutomationInput(draft));
      setPreview([result.triggerSummary, result.actionSummary, "", result.renderedPrompt].join("\n"));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not preview automation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)] gap-3 p-3">
      <Card className="flex min-h-0 flex-col p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-[var(--ec-text)]">Automations</h3>
            <p className="text-[11px] text-[var(--ec-muted)]">{items.length} local automation{items.length === 1 ? "" : "s"}</p>
          </div>
          <Button type="button" size="sm" className="h-8 gap-1.5 px-2.5 text-xs" onClick={createNew}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New
          </Button>
        </div>
        <div className="app-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--ec-border)] p-3 text-xs text-[var(--ec-muted)]">
              No automations yet.
            </div>
          ) : (
            items.map((automation) => (
              <button
                key={automation.id}
                type="button"
                className={cn(
                  "w-full rounded-lg border p-2 text-left transition",
                  selectedId === automation.id
                    ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)]"
                    : "border-[var(--ec-border)] bg-[var(--ec-surface)] hover:border-[var(--ec-border-strong)]",
                )}
                onClick={() => setSelectedId(automation.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--ec-text)]">{automation.name}</p>
                    <p className="mt-0.5 truncate text-[11px] text-[var(--ec-muted)]">
                      {TRIGGER_LABELS[automation.trigger.type]} {"->"} {ACTION_LABELS[automation.action.type]}
                    </p>
                  </div>
                  <span className={cn("rounded-full border px-1.5 py-0.5 text-[10px]", automation.enabled ? "border-emerald-500/25 text-emerald-200" : "border-zinc-700 text-zinc-500")}>
                    {automation.enabled ? "On" : "Off"}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-[var(--ec-muted)]">
                  <span>Last: {formatDateTime(automation.lastRunAt)}</span>
                  <span>Next: {formatDateTime(automation.nextRunAt)}</span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-[var(--ec-muted)]">Failures: {automation.failureCount}</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    className="h-7 gap-1 px-2"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runNow(automation);
                    }}
                  >
                    <Play className="h-3 w-3" aria-hidden />
                    Run
                  </Button>
                </div>
              </button>
            ))
          )}
        </div>
      </Card>

      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] gap-3">
        <Card className="app-scrollbar min-h-0 overflow-y-auto p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-[var(--ec-text)]">{selected ? "Edit automation" : "New automation"}</h3>
              <p className="text-[11px] text-[var(--ec-muted)]">Project scoped, local while BuildWarden is open.</p>
            </div>
            <div className="flex items-center gap-1.5">
              <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} />
              <Button type="button" size="sm" variant="secondary" className="h-8 gap-1.5 px-2.5 text-xs" disabled={!selected || busy} onClick={duplicateSelected}>
                <Copy className="h-3.5 w-3.5" aria-hidden />
                Duplicate
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" disabled={!selected || busy} onClick={() => void deleteSelected()}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Delete
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Automation name" />
            <Input value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Description" />
            <Select
              value={draft.triggerType}
              onValueChange={(value) => setDraft((current) => ({ ...current, triggerType: value as AutomationTriggerType }))}
              options={[
                { value: "manual", label: "Manual" },
                { value: "schedule", label: "Schedule" },
                { value: "pr-mr", label: "PR/MR" },
              ]}
            />
            <Select
              value={draft.actionType}
              onValueChange={(value) => setDraft((current) => ({ ...current, actionType: value as AutomationActionType }))}
              options={[
                { value: "notify", label: "Notify" },
                { value: "start-run", label: "Start run" },
                { value: "run-project-lab", label: "Project Lab" },
                { value: "create-task", label: "Create task" },
                { value: "analyze-pr-mr", label: "Analyze PR/MR" },
              ]}
            />
          </div>

          {draft.triggerType === "schedule" ? (
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Select
                value={draft.scheduleMode}
                onValueChange={(value) => setDraft((current) => ({ ...current, scheduleMode: value as AutomationScheduleMode }))}
                options={[
                  { value: "interval", label: "Interval" },
                  { value: "daily", label: "Daily" },
                ]}
              />
              {draft.scheduleMode === "daily" ? (
                <Input type="time" value={draft.dailyTime} onChange={(event) => setDraft((current) => ({ ...current, dailyTime: event.target.value }))} />
              ) : (
                <Input value={draft.intervalMinutes} onChange={(event) => setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))} placeholder="Minutes" />
              )}
            </div>
          ) : null}

          {draft.triggerType === "pr-mr" ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Select
                value={draft.prMrEvent}
                onValueChange={(value) => setDraft((current) => ({ ...current, prMrEvent: value as AutomationPrMrEvent }))}
                options={[
                  { value: "opened", label: "Opened" },
                  { value: "updated", label: "Updated" },
                  { value: "review-activity", label: "Review activity" },
                ]}
              />
              <Input value={draft.prMrIntervalMinutes} onChange={(event) => setDraft((current) => ({ ...current, prMrIntervalMinutes: event.target.value }))} placeholder="Poll minutes" />
            </div>
          ) : null}

          {draft.actionType === "create-task" ? (
            <Input className="mt-3" value={draft.titleTemplate} onChange={(event) => setDraft((current) => ({ ...current, titleTemplate: event.target.value }))} placeholder="Task title template" />
          ) : null}

          {draft.actionType === "start-run" || draft.actionType === "analyze-pr-mr" || draft.actionType === "run-project-lab" ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Select value={draft.modelId} onValueChange={(value) => setDraft((current) => ({ ...current, modelId: value }))} options={modelSelectOptions} placeholder="Model" />
              {draft.actionType === "run-project-lab" ? (
                <Select value={draft.reviewModelId} onValueChange={(value) => setDraft((current) => ({ ...current, reviewModelId: value }))} options={modelSelectOptions} placeholder="Review model" />
              ) : (
                <Select
                  value={draft.runMode}
                  onValueChange={(value) => setDraft((current) => ({ ...current, runMode: value as RunMode }))}
                  options={[
                    { value: "code", label: "Code" },
                    { value: "plan", label: "Plan" },
                    { value: "ask", label: "Ask" },
                  ]}
                />
              )}
              {draft.actionType === "start-run" ? (
                <Select
                  value={draft.workspaceType}
                  onValueChange={(value) => setDraft((current) => ({ ...current, workspaceType: value as RunWorkspaceType }))}
                  options={[
                    { value: "worktree", label: "Worktree" },
                    { value: "local", label: "Local repo" },
                    { value: "copy", label: "Folder copy" },
                  ]}
                />
              ) : null}
              {draft.actionType === "run-project-lab" ? (
                <Select
                  value={draft.projectLabMode}
                  onValueChange={(value) => setDraft((current) => ({ ...current, projectLabMode: value as ProjectLabMode }))}
                  options={[
                    { value: "new-feature", label: "New feature" },
                    { value: "bugfix", label: "Bugfix" },
                    { value: "refactoring", label: "Refactoring" },
                    { value: "rfc-only", label: "RFC only" },
                  ]}
                />
              ) : null}
              {project.kind === "git" ? (
                <Select value={draft.baseBranch} onValueChange={(value) => setDraft((current) => ({ ...current, baseBranch: value }))} options={branchSelectOptions} />
              ) : null}
            </div>
          ) : null}

          <Textarea
            className="mt-3 min-h-[180px]"
            value={draft.promptTemplate}
            onChange={(event) => setDraft((current) => ({ ...current, promptTemplate: event.target.value }))}
            placeholder="Prompt/message template"
          />

          <div className="mt-3 grid grid-cols-4 gap-2">
            <label className="space-y-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--ec-muted)]">
              Max active
              <Input
                value={draft.guardMaxConcurrent}
                onChange={(event) => setDraft((current) => ({ ...current, guardMaxConcurrent: event.target.value }))}
                placeholder="1"
              />
            </label>
            <label className="space-y-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--ec-muted)]">
              Daily cap
              <Input
                value={draft.guardDailyLimit}
                onChange={(event) => setDraft((current) => ({ ...current, guardDailyLimit: event.target.value }))}
                placeholder="12"
              />
            </label>
            <label className="flex items-center gap-2 self-end rounded-md border border-[var(--ec-border)] px-2 py-2 text-xs text-[var(--ec-muted)]">
              <Switch checked={draft.fullAccess} onCheckedChange={(fullAccess) => setDraft((current) => ({ ...current, fullAccess }))} />
              Full access
            </label>
            <Button type="button" variant="secondary" className="self-end gap-1.5" disabled={busy} onClick={() => void previewDraft()}>
              <WandSparkles className="h-3.5 w-3.5" aria-hidden />
              Preview
            </Button>
          </div>

          {preview ? (
            <pre className="app-scrollbar mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--ec-border)] bg-[var(--ec-elevated)] p-3 text-xs text-[var(--ec-text)]">
              {preview}
            </pre>
          ) : null}

          <div className="mt-3 flex justify-end gap-2">
            {selected ? (
              <Button type="button" variant="secondary" className="gap-1.5" disabled={busy} onClick={() => void runNow(selected)}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                Run now
              </Button>
            ) : null}
            <Button type="button" className="gap-1.5" disabled={busy || !draft.name.trim()} onClick={() => void saveAutomation()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />}
              Save
            </Button>
          </div>
        </Card>

        <Card className="flex min-h-0 flex-col p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-[var(--ec-text)]">Output</h3>
              <p className="text-[11px] text-[var(--ec-muted)]">{runs.length} recent run{runs.length === 1 ? "" : "s"}</p>
            </div>
            <Button type="button" size="sm" variant="secondary" className="h-8 px-2" disabled={!selectedId} onClick={() => void refreshRuns(selectedId)}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
          <div className="app-scrollbar max-h-56 space-y-2 overflow-y-auto pr-1">
            {runs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--ec-border)] p-3 text-xs text-[var(--ec-muted)]">
                No output yet.
              </div>
            ) : (
              runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className="w-full rounded-lg border border-[var(--ec-border)] bg-[var(--ec-surface)] p-2 text-left hover:border-[var(--ec-border-strong)]"
                  onClick={() => void window.buildwarden.getAutomationRunDetail(run.id).then(setSelectedRunDetail)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn("rounded-full border px-1.5 py-0.5 text-[10px]", STATUS_TONE[run.status] ?? STATUS_TONE.skipped)}>
                      {run.status}
                    </span>
                    <span className="text-[10px] text-[var(--ec-muted)]">{formatDateTime(run.createdAt)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--ec-text)]">{run.errorMessage ?? run.triggerEvent.reason}</p>
                </button>
              ))
            )}
          </div>

          {selectedRunDetail ? (
            <div className="app-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--ec-border)] bg-[var(--ec-elevated)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className={cn("rounded-full border px-1.5 py-0.5 text-[10px]", STATUS_TONE[selectedRunDetail.run.status] ?? STATUS_TONE.skipped)}>
                  {selectedRunDetail.run.status}
                </span>
                {selectedRunDetail.run.linkedRunId ? (
                  <Button type="button" size="xs" onClick={() => onSelectRun(selectedRunDetail.run.linkedRunId!)}>
                    Open run
                  </Button>
                ) : null}
              </div>
              <p className="text-xs font-medium text-[var(--ec-text)]">{selectedRunDetail.run.triggerEvent.reason}</p>
              {selectedRunDetail.run.linkedPrUrl ? (
                <p className="mt-1 truncate text-[11px] text-[var(--ec-muted)]">{selectedRunDetail.run.linkedPrUrl}</p>
              ) : null}
              <pre className="app-scrollbar mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--ec-border)] bg-[var(--ec-surface)] p-2 text-[11px] text-[var(--ec-text)]">
                {selectedRunDetail.run.renderedPrompt || "(no prompt)"}
              </pre>
              <div className="mt-3 space-y-2">
                {selectedRunDetail.events.map((event) => (
                  <div key={event.id} className="rounded-md border border-[var(--ec-border)] bg-[var(--ec-surface)] p-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-[var(--ec-text)]">{event.title}</p>
                      <span className="text-[10px] text-[var(--ec-muted)]">{event.kind}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-[11px] text-[var(--ec-muted)]">{event.content}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
};
