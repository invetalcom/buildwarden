import {
  AUTOMATION_TRIGGER_KINDS,
  AUTOMATION_TRIGGER_LABELS,
  isUntrustedAutomationTrigger,
  type AutomationTrigger,
  type AutomationTriggerKind,
  type ProjectKind,
} from "@buildwarden/shared";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

interface AutomationTriggerFieldsProps {
  value: AutomationTrigger;
  onChange: (trigger: AutomationTrigger) => void;
  projectKind: ProjectKind;
  /** Other automations of the project, for "after another automation". */
  otherAutomations: Array<{ id: string; name: string }>;
  branches: string[];
}

const GIT_TRIGGERS = new Set<AutomationTriggerKind>(["issue-labelled", "pr-opened"]);

const OUTCOME_OPTIONS = [
  { value: "any", label: "Finished in any way" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed or stopped" },
];

const TRIGGER_HINTS: Record<AutomationTriggerKind, string> = {
  schedule: "Starts at the times below.",
  manual: "Starts only with Run now.",
  "issue-labelled": "Starts once for each issue that gets this label after you save. Checked every two minutes.",
  "pr-opened": "Starts once for each pull request opened after you save. Checked every two minutes.",
  "automation-finished": "Starts when the chosen automation ends. Its final answer is passed on.",
};

const defaultAutomationTrigger = (kind: AutomationTriggerKind, otherAutomations: Array<{ id: string }>): AutomationTrigger => {
  switch (kind) {
    case "schedule": return { kind };
    case "manual": return { kind };
    case "issue-labelled": return { kind, label: "" };
    case "pr-opened": return { kind, targetBranch: null };
    case "automation-finished": return { kind, automationId: otherAutomations[0]?.id ?? "", outcome: "completed" };
  }
};

/** How an automation starts: on its schedule, by hand, or when something happens. */
export const AutomationTriggerFields = ({ value, onChange, projectKind, otherAutomations, branches }: AutomationTriggerFieldsProps) => {
  const options = AUTOMATION_TRIGGER_KINDS
    .filter((kind) => projectKind === "git" || !GIT_TRIGGERS.has(kind))
    .filter((kind) => kind !== "automation-finished" || otherAutomations.length > 0 || value.kind === kind)
    .map((kind) => ({ value: kind, label: AUTOMATION_TRIGGER_LABELS[kind] }));
  return (
    <div className="md:col-span-2 grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-end">
      <label className="text-xs text-[var(--ec-muted)]">Starts
        <Select ariaLabel="When the automation starts" className="mt-1" value={value.kind} options={options}
          onValueChange={(kind) => onChange(defaultAutomationTrigger(kind as AutomationTriggerKind, otherAutomations))} />
      </label>
      {value.kind === "issue-labelled" ? (
        <label className="text-xs text-[var(--ec-muted)]">Label
          <Input className="mt-1 h-9" value={value.label} placeholder="ready-for-agent" onChange={(event) => onChange({ ...value, label: event.target.value })} />
        </label>
      ) : value.kind === "pr-opened" ? (
        <label className="text-xs text-[var(--ec-muted)]">Target branch
          <Select ariaLabel="Pull request target branch" className="mt-1" value={value.targetBranch ?? ""} searchable
            options={[{ value: "", label: "Any branch" }, ...branches.map((branch) => ({ value: branch, label: branch }))]}
            onValueChange={(targetBranch) => onChange({ ...value, targetBranch: targetBranch || null })} />
        </label>
      ) : value.kind === "automation-finished" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-[var(--ec-muted)]">After
            <Select ariaLabel="Automation to follow" className="mt-1" value={value.automationId} searchable
              options={otherAutomations.map((automation) => ({ value: automation.id, label: automation.name }))}
              onValueChange={(automationId) => onChange({ ...value, automationId })} />
          </label>
          <label className="text-xs text-[var(--ec-muted)]">When it
            <Select ariaLabel="Outcome to follow" className="mt-1" value={value.outcome} options={OUTCOME_OPTIONS}
              onValueChange={(outcome) => onChange({ ...value, outcome: outcome as typeof value.outcome })} />
          </label>
        </div>
      ) : <span aria-hidden />}
      <p className="sm:col-span-2 text-[10px] leading-4 text-[var(--ec-faint)]">
        {TRIGGER_HINTS[value.kind]}
        {isUntrustedAutomationTrigger(value.kind) ? " Other people write issues and pull requests, so these runs ask before running shell commands." : ""}
      </p>
    </div>
  );
};
