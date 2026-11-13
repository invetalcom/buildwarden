import {
  buildForgeIssueRunPrompt,
  PROJECT_FORGE_ISSUE_AUTOMATION_MIN_INTERVAL_MINUTES,
  type CreateProjectForgeIssueInput,
  type ForgeIssueRunIntent,
  type ProjectForgeIssueAutomationSettings,
  type ProjectForgeIssueMetadataResult,
  type ProjectForgeIssueSummary,
  type ProjectForgeProvider,
} from "@buildwarden/shared";
import { Loader2, Milestone, Tag, UserRound } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ModalDialog } from "../ui/modal-dialog";
import { SegmentedControl } from "../ui/segmented-control";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { IssueAvatar, IssueLabelChip, IssueLabelSwatch, IssuePickerPopover } from "./project-issue-parts";

type ModelOption = { id: string; label: string };

const FieldLabel = ({ children }: Readonly<{ children: ReactNode }>) => (
  <span className="text-[9px] font-medium uppercase tracking-wide text-[var(--ec-muted)]">{children}</span>
);

const DialogActions = ({
  busy,
  confirmLabel,
  confirmDisabled,
  onConfirm,
  onClose,
  error,
}: Readonly<{ busy: boolean; confirmLabel: string; confirmDisabled?: boolean; onConfirm: () => void; onClose: () => void; error: string | null }>) => (
  <>
    {error ? <p className="mt-2 text-[11px] leading-snug text-[var(--ec-danger)]">{error}</p> : null}
    <div className="mt-3 flex justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button type="button" size="sm" onClick={onConfirm} disabled={busy || confirmDisabled}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
        {confirmLabel}
      </Button>
    </div>
  </>
);

const ModelField = ({ modelOptions, value, onChange }: Readonly<{ modelOptions: readonly ModelOption[]; value: string; onChange: (value: string) => void }>) => (
  <label className="block space-y-0.5">
    <FieldLabel>Model</FieldLabel>
    <Select
      value={value}
      onValueChange={onChange}
      options={modelOptions.map((option) => ({ value: option.id, label: option.label }))}
      placeholder="Select a model"
      emptyMessage="Add a model in Settings first."
      ariaLabel="Model"
      triggerClassName="h-8 rounded-md px-2 text-xs"
      searchable={modelOptions.length > 8}
    />
  </label>
);

export interface StartIssueRunsInput {
  modelId: string;
  intent: ForgeIssueRunIntent;
  /** Only for a single issue: the edited prompt. */
  prompt?: string;
}

/** Starts one agent run per issue. A single issue's prompt can be edited; a batch uses the default prompt. */
export const StartIssueRunDialog = ({
  issues,
  modelOptions,
  defaultModelId,
  defaultIntent = "implement",
  baseBranch,
  busy,
  error,
  onStart,
  onClose,
}: Readonly<{
  issues: readonly ProjectForgeIssueSummary[];
  modelOptions: readonly ModelOption[];
  defaultModelId: string;
  /** The goal the dialog opens with. A retry passes the goal that was chosen before. */
  defaultIntent?: ForgeIssueRunIntent;
  baseBranch: string;
  busy: boolean;
  error: string | null;
  onStart: (input: StartIssueRunsInput) => void;
  onClose: () => void;
}>) => {
  const single = issues.length === 1 ? issues[0] : undefined;
  const [modelId, setModelId] = useState(defaultModelId);
  const [intent, setIntent] = useState<ForgeIssueRunIntent>(defaultIntent);
  const [prompt, setPrompt] = useState(() => (single ? buildForgeIssueRunPrompt(single, defaultIntent) : ""));
  const [promptEdited, setPromptEdited] = useState(false);

  const changeIntent = (next: ForgeIssueRunIntent) => {
    setIntent(next);
    if (single && !promptEdited) setPrompt(buildForgeIssueRunPrompt(single, next));
  };

  return (
    <ModalDialog
      title={single ? `Start a run for #${String(single.number)}` : `Start ${String(issues.length)} runs`}
      description={single ? single.title : "One run per selected issue. Each run gets its own worktree and its issue as context."}
      onClose={onClose}
      className="w-[min(36rem,95vw)]"
    >
      <div className="space-y-2.5">
        <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <ModelField modelOptions={modelOptions} value={modelId} onChange={setModelId} />
          <div className="space-y-0.5">
            <FieldLabel>Goal</FieldLabel>
            <SegmentedControl
              label="Goal of the run"
              value={intent}
              onChange={changeIntent}
              options={[
                { value: "implement", label: "Implement fix" },
                { value: "investigate", label: "Investigate only" },
              ]}
            />
          </div>
        </div>
        {single ? (
          <label className="block space-y-0.5">
            <FieldLabel>Prompt</FieldLabel>
            <Textarea
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setPromptEdited(true);
              }}
              className="min-h-32 px-2.5 py-2 font-mono text-[11px] leading-relaxed"
              aria-label="Run prompt"
            />
          </label>
        ) : (
          <ul className="app-scrollbar max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-[var(--ec-border)] p-1.5">
            {issues.map((issue) => (
              <li key={issue.number} className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--ec-text)]">
                <span className="shrink-0 font-mono text-[10px] text-[var(--ec-muted)]">#{String(issue.number)}</span>
                <span className="truncate">{issue.title}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[10px] leading-relaxed text-[var(--ec-muted)]">
          {intent === "investigate" ? "Runs in plan mode: the agent finds the cause and proposes a plan without changing code. " : ""}
          Works in a new worktree off <span className="font-mono text-[var(--ec-text)]">{baseBranch || "the base branch"}</span>. The issue and its comments are attached as a quoted
          Markdown file; they are written by other people, so the agent is told not to follow instructions inside them. Your current approval settings apply.
        </p>
      </div>
      <DialogActions
        busy={busy}
        error={error}
        confirmLabel={single ? "Start run" : `Start ${String(issues.length)} runs`}
        confirmDisabled={!modelId || (single !== undefined && !prompt.trim())}
        onConfirm={() => onStart({ modelId, intent, prompt: single ? prompt : undefined })}
        onClose={onClose}
      />
    </ModalDialog>
  );
};

export const AskIssueDialog = ({
  issue,
  modelOptions,
  defaultModelId,
  busy,
  error,
  onAsk,
  onClose,
}: Readonly<{
  issue: ProjectForgeIssueSummary;
  modelOptions: readonly ModelOption[];
  defaultModelId: string;
  busy: boolean;
  error: string | null;
  onAsk: (input: { modelId: string; question: string }) => void;
  onClose: () => void;
}>) => {
  const [modelId, setModelId] = useState(defaultModelId);
  const [question, setQuestion] = useState("");
  return (
    <ModalDialog title={`Ask about #${String(issue.number)}`} description={issue.title} onClose={onClose} className="w-[min(32rem,95vw)]">
      <div className="space-y-2.5">
        <label className="block space-y-0.5">
          <FieldLabel>Question</FieldLabel>
          <Textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && modelId && !busy) {
                event.preventDefault();
                onAsk({ modelId, question });
              }
            }}
            placeholder="Summarize this issue and suggest how to approach it."
            className="min-h-24 px-2.5 py-2 text-xs leading-relaxed"
            aria-label="Question"
            autoFocus
          />
        </label>
        <ModelField modelOptions={modelOptions} value={modelId} onChange={setModelId} />
        <p className="text-[10px] leading-relaxed text-[var(--ec-muted)]">Opens a new chat with the issue and its comments attached. Leave the question empty for a summary.</p>
      </div>
      <DialogActions busy={busy} error={error} confirmLabel="Open chat" confirmDisabled={!modelId} onConfirm={() => onAsk({ modelId, question })} onClose={onClose} />
    </ModalDialog>
  );
};

export const CreateIssueDialog = ({
  provider,
  metadata,
  metadataBusy,
  canTriage,
  busy,
  error,
  onCreate,
  onClose,
}: Readonly<{
  provider: ProjectForgeProvider;
  metadata: ProjectForgeIssueMetadataResult | null;
  metadataBusy: boolean;
  /** Labels, assignees, and the milestone need triage rights; without them only title and text are sent. */
  canTriage: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (input: CreateProjectForgeIssueInput) => void;
  onClose: () => void;
}>) => {
  const [templateName, setTemplateName] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [milestone, setMilestone] = useState("");
  const [confidential, setConfidential] = useState(false);
  const [openPicker, setOpenPicker] = useState<"labels" | "assignees" | null>(null);
  const labelsRef = useRef<HTMLButtonElement>(null);
  const assigneesRef = useRef<HTMLButtonElement>(null);
  const templates = metadata?.templates ?? [];

  const applyTemplate = (name: string) => {
    setTemplateName(name);
    const template = templates.find((entry) => entry.name === name);
    if (!template) return;
    setTitle(template.title);
    setBody(template.body);
    const known = new Set((metadata?.labels ?? []).map((label) => label.name));
    setLabels(template.labels.filter((label) => known.has(label)));
  };

  const labelOptions = useMemo(
    () => (metadata?.labels ?? []).map((label) => ({ value: label.name, label: label.name, description: label.description, leading: <IssueLabelSwatch color={label.color} /> })),
    [metadata?.labels],
  );
  const assigneeOptions = useMemo(
    () => (metadata?.assignees ?? []).map((user) => ({ value: user.username, label: user.username, description: user.name, leading: <IssueAvatar user={user} size="sm" /> })),
    [metadata?.assignees],
  );
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);

  const submit = () =>
    onCreate({
      title,
      body,
      ...(canTriage && labels.length > 0 ? { labels } : {}),
      ...(canTriage && assignees.length > 0 ? { assignees } : {}),
      ...(canTriage && milestone ? { milestone: Number.parseInt(milestone, 10) } : {}),
      ...(provider === "gitlab" && confidential ? { confidential: true } : {}),
    });

  return (
    <ModalDialog title="New issue" description={`Creates the issue on ${provider === "gitlab" ? "GitLab" : "GitHub"} with the saved token's account.`} onClose={onClose} className="w-[min(40rem,95vw)]">
      <div className="space-y-2.5">
        {templates.length > 0 ? (
          <label className="block space-y-0.5">
            <FieldLabel>Template</FieldLabel>
            <Select
              value={templateName}
              onValueChange={applyTemplate}
              options={templates.map((template) => ({ value: template.name, label: template.name, description: template.description ?? undefined }))}
              placeholder="Start from a template"
              ariaLabel="Issue template"
              triggerClassName="h-8 rounded-md px-2 text-xs"
            />
          </label>
        ) : null}
        <label className="block space-y-0.5">
          <FieldLabel>Title</FieldLabel>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} className="h-8 text-xs" aria-label="Issue title" autoFocus />
        </label>
        <label className="block space-y-0.5">
          <FieldLabel>Description (Markdown)</FieldLabel>
          <Textarea value={body} onChange={(event) => setBody(event.target.value)} className="min-h-40 px-2.5 py-2 text-xs leading-relaxed" aria-label="Issue description" />
        </label>
        {canTriage ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button ref={labelsRef} type="button" size="xs" variant="secondary" className="h-7 max-w-full px-2 text-[10px]" onClick={() => setOpenPicker((value) => (value === "labels" ? null : "labels"))}>
              <Tag className="mr-1 h-3 w-3 shrink-0" aria-hidden />
              {labels.length > 0 ? (
                <span className="flex min-w-0 flex-wrap gap-1">
                  {labels.map((name) => (
                    <IssueLabelChip key={name} label={metadata?.labels.find((label) => label.name === name) ?? { name, color: null, description: null }} />
                  ))}
                </span>
              ) : (
                "Labels"
              )}
            </Button>
            <Button ref={assigneesRef} type="button" size="xs" variant="secondary" className="h-7 max-w-full px-2 text-[10px]" onClick={() => setOpenPicker((value) => (value === "assignees" ? null : "assignees"))}>
              <UserRound className="mr-1 h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{assignees.length > 0 ? assignees.join(", ") : "Assignees"}</span>
            </Button>
            {(metadata?.milestones.length ?? 0) > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Milestone className="h-3 w-3 text-[var(--ec-muted)]" aria-hidden />
                <Select
                  value={milestone}
                  onValueChange={setMilestone}
                  options={[{ value: "", label: "No milestone" }, ...(metadata?.milestones ?? []).map((entry) => ({ value: String(entry.number), label: entry.title }))]}
                  ariaLabel="Milestone"
                  className="w-40"
                  triggerClassName="h-7 rounded-md px-2 text-[10px]"
                />
              </span>
            ) : null}
            {provider === "gitlab" ? (
              <label className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-[var(--ec-muted)]">
                <Switch checked={confidential} onCheckedChange={setConfidential} aria-label="Confidential issue" />
                Confidential
              </label>
            ) : null}
            {metadataBusy ? <span className="text-[10px] text-[var(--ec-faint)]">Loading labels…</span> : null}
          </div>
        ) : (
          <p className="text-[10px] leading-relaxed text-[var(--ec-muted)]">The saved token may open issues here, but may not set labels, assignees, or a milestone.</p>
        )}
      </div>
      <IssuePickerPopover open={openPicker === "labels"} anchorRef={labelsRef} onClose={() => setOpenPicker(null)} title="Labels" options={labelOptions} selected={labels} onToggle={(value) => setLabels((list) => toggle(list, value))} busy={metadataBusy} emptyMessage="This repository has no labels." />
      <IssuePickerPopover open={openPicker === "assignees"} anchorRef={assigneesRef} onClose={() => setOpenPicker(null)} title="Assignees" options={assigneeOptions} selected={assignees} onToggle={(value) => setAssignees((list) => toggle(list, value))} busy={metadataBusy} emptyMessage="No assignable users were found." />
      <DialogActions busy={busy} error={error} confirmLabel="Create issue" confirmDisabled={!title.trim()} onConfirm={submit} onClose={onClose} />
    </ModalDialog>
  );
};

const INTERVAL_OPTIONS = [5, 15, 30, 60, 180].filter((minutes) => minutes >= PROJECT_FORGE_ISSUE_AUTOMATION_MIN_INTERVAL_MINUTES);

/** Settings for starting runs automatically when an open issue carries a chosen label. */
export const IssueAutomationDialog = ({
  settings,
  metadata,
  modelOptions,
  defaultModelId,
  hasToken,
  busy,
  error,
  onSave,
  onClose,
}: Readonly<{
  settings: ProjectForgeIssueAutomationSettings | null;
  metadata: ProjectForgeIssueMetadataResult | null;
  modelOptions: readonly ModelOption[];
  defaultModelId: string;
  hasToken: boolean;
  busy: boolean;
  error: string | null;
  onSave: (settings: ProjectForgeIssueAutomationSettings) => void;
  onClose: () => void;
}>) => {
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [label, setLabel] = useState(settings?.label ?? "");
  const [modelId, setModelId] = useState(settings?.modelId || defaultModelId);
  const [mode, setMode] = useState<ProjectForgeIssueAutomationSettings["mode"]>(settings?.mode ?? "plan");
  const [intervalMinutes, setIntervalMinutes] = useState(settings?.intervalMinutes ?? 15);
  const knownLabels = metadata?.labels ?? [];
  const intervals = INTERVAL_OPTIONS.includes(intervalMinutes) ? INTERVAL_OPTIONS : [...INTERVAL_OPTIONS, intervalMinutes].sort((left, right) => left - right);

  return (
    <ModalDialog
      title="Start runs from a label"
      description="While this is on, BuildWarden checks the open issues and starts one run for each issue that carries the label. To run an issue again, remove the label and add it back."
      onClose={onClose}
      className="w-[min(32rem,95vw)]"
    >
      <div className="space-y-2.5">
        <label className="flex items-center justify-between gap-3 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2.5 py-2">
          <span className="text-xs font-medium text-[var(--ec-text)]">Start runs automatically</span>
          {/* Without a token the trigger cannot be switched on, but one that is still on can be switched off. */}
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!hasToken && !enabled} aria-label="Start runs automatically" />
        </label>
        {!hasToken ? <p className="text-[10px] leading-relaxed text-[var(--ec-warning)]">This needs a Git hosting access token: unattended runs never use the public API.</p> : null}
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="block space-y-0.5">
            <FieldLabel>Trigger label</FieldLabel>
            {knownLabels.length > 0 ? (
              <Select
                value={label}
                onValueChange={setLabel}
                options={[...new Set([...(label ? [label] : []), ...knownLabels.map((entry) => entry.name)])].map((name) => ({ value: name, label: name }))}
                placeholder="Choose a label"
                ariaLabel="Trigger label"
                triggerClassName="h-8 rounded-md px-2 text-xs"
                searchable={knownLabels.length > 8}
              />
            ) : (
              <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="agent-ready" className="h-8 text-xs" aria-label="Trigger label" />
            )}
          </label>
          <label className="block space-y-0.5">
            <FieldLabel>Check every</FieldLabel>
            <Select
              value={String(intervalMinutes)}
              onValueChange={(value) => setIntervalMinutes(Number.parseInt(value, 10))}
              options={intervals.map((minutes) => ({ value: String(minutes), label: minutes < 60 ? `${String(minutes)} minutes` : `${String(minutes / 60)} hour${minutes === 60 ? "" : "s"}` }))}
              ariaLabel="Check interval"
              triggerClassName="h-8 rounded-md px-2 text-xs"
            />
          </label>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <ModelField modelOptions={modelOptions} value={modelId} onChange={setModelId} />
          <div className="space-y-0.5">
            <FieldLabel>Goal</FieldLabel>
            <SegmentedControl
              label="Goal of the runs"
              value={mode}
              onChange={setMode}
              options={[
                { value: "plan", label: "Investigate only" },
                { value: "code", label: "Implement fix" },
              ]}
            />
          </div>
        </div>
        <p className="text-[10px] leading-relaxed text-[var(--ec-muted)]">
          At most three runs start per check, each in its own worktree. They never run with full access: issue text is written by other people, so shell commands still wait for your approval.
          Nothing is posted to the issue.
        </p>
      </div>
      <DialogActions
        busy={busy}
        error={error}
        confirmLabel="Save"
        confirmDisabled={enabled && (!label.trim() || !modelId)}
        onConfirm={() => onSave({ enabled, label: label.trim(), modelId, mode, intervalMinutes })}
        onClose={onClose}
      />
    </ModalDialog>
  );
};
