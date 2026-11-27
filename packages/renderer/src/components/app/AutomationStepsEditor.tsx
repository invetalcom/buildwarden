import {
  AUTOMATION_GIT_STEP_KINDS,
  AUTOMATION_MAX_CHOICES,
  AUTOMATION_MAX_STEPS,
  AUTOMATION_PROMPT_STEP_ID,
  AUTOMATION_STEP_KINDS,
  AUTOMATION_STEP_LABELS,
  automationStepValueLabel,
  automationStepValues,
  createAutomationStepId,
  type AutomationStepDefinition,
  type AutomationStepKind,
  type AutomationWorkflowDefinition,
  type ProjectKind,
} from "@buildwarden/shared";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

interface AutomationStepsEditorProps {
  value: AutomationWorkflowDefinition;
  onChange: (definition: AutomationWorkflowDefinition) => void;
  projectKind: ProjectKind;
}

const STEP_HINTS: Record<AutomationStepKind, string> = {
  agent: "Sends another prompt to the agent.",
  ask: "Waits for your answer in the inbox.",
  council: "Runs a council review of the latest agent run.",
  verify: "Runs the project's verification commands.",
  "open-pr": "Commits and opens a pull request from the latest agent run.",
  "wait-pr": "Waits until the checks finish or the request is merged.",
  "merge-pr": "Merges the pull request once it is ready.",
  wait: "Waits before the next step.",
};

const CONDITION_SEPARATOR = "\u0000";

const createAutomationStep = (kind: AutomationStepKind): AutomationStepDefinition => {
  const base = { id: createAutomationStepId(), when: null };
  switch (kind) {
    case "agent": return { ...base, kind, prompt: "", workspace: "continue", check: null };
    case "ask": return { ...base, kind, title: "", detail: "", choices: ["Continue", "Stop"], requireReason: false, timeoutHours: null, timeoutChoice: null };
    case "council": return { ...base, kind, fixFindings: false };
    case "verify": return { ...base, kind };
    case "open-pr": return { ...base, kind, title: "" };
    case "wait-pr": return { ...base, kind, until: "checks", timeoutHours: 24 };
    case "merge-pr": return { ...base, kind, method: "squash" };
    case "wait": return { ...base, kind, minutes: 60 };
  }
};

const numberOrNull = (value: string): number | null => {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const StepFields = ({ step, onChange }: { step: AutomationStepDefinition; onChange: (step: AutomationStepDefinition) => void }) => {
  switch (step.kind) {
    case "agent":
      return (
        <div className="grid gap-2">
          <Textarea aria-label="Step prompt" className="min-h-16 text-xs" value={step.prompt} placeholder="Upgrade the dependencies you listed and run the tests."
            onChange={(event) => onChange({ ...step, prompt: event.target.value })} />
          <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
            <Select ariaLabel="Agent workspace" value={step.workspace} onValueChange={(workspace) => onChange({ ...step, workspace: workspace === "new" ? "new" : "continue" })}
              options={[{ value: "continue", label: "Continue the latest run" }, { value: "new", label: "Start a new run" }]} />
            <Input aria-label="Yes or no question for this step" className="h-8 text-xs" value={step.check ?? ""} placeholder="Yes/no question it answers (optional)"
              onChange={(event) => onChange({ ...step, check: event.target.value || null })} />
          </div>
        </div>
      );
    case "ask":
      return (
        <div className="grid gap-2">
          <Input aria-label="Question" className="h-8 text-xs" value={step.title} placeholder="Upgrade the outdated dependencies?" onChange={(event) => onChange({ ...step, title: event.target.value })} />
          <Input aria-label="Answers" className="h-8 text-xs" value={step.choices.join(", ")} placeholder="Upgrade, Skip"
            onChange={(event) => {
              const choices = event.target.value.split(",").map((choice) => choice.trimStart()).slice(0, AUTOMATION_MAX_CHOICES);
              onChange({ ...step, choices, timeoutChoice: step.timeoutChoice && choices.includes(step.timeoutChoice) ? step.timeoutChoice : null });
            }} />
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--ec-muted)]">
            <label className="flex items-center gap-1.5"><Switch checked={step.requireReason} onCheckedChange={(requireReason) => onChange({ ...step, requireReason })} />Ask for a reason</label>
            <label className="flex items-center gap-1.5">Time limit
              <Input aria-label="Hours to wait for an answer" className="h-7 w-16 text-xs" inputMode="decimal" value={step.timeoutHours === null ? "" : String(step.timeoutHours)} placeholder="none"
                onChange={(event) => onChange({ ...step, timeoutHours: numberOrNull(event.target.value) })} />h
            </label>
            {step.timeoutHours !== null ? (
              <Select ariaLabel="Answer when time runs out" className="min-w-36" value={step.timeoutChoice ?? ""}
                options={[{ value: "", label: "Then stop" }, ...step.choices.filter((choice) => choice.trim()).map((choice) => ({ value: choice.trim(), label: `Then answer ${choice.trim()}` }))]}
                onValueChange={(timeoutChoice) => onChange({ ...step, timeoutChoice: timeoutChoice || null })} />
            ) : null}
          </div>
        </div>
      );
    case "council":
      return <label className="flex items-center gap-1.5 text-[11px] text-[var(--ec-muted)]"><Switch checked={step.fixFindings} onCheckedChange={(fixFindings) => onChange({ ...step, fixFindings })} />Fix the recommended findings</label>;
    case "open-pr":
      return <Input aria-label="Pull request title" className="h-8 text-xs" value={step.title} placeholder="Title (defaults to the automation's name)" onChange={(event) => onChange({ ...step, title: event.target.value })} />;
    case "wait-pr":
      return (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--ec-muted)]">
          <Select ariaLabel="Wait until" className="min-w-40" value={step.until} onValueChange={(until) => onChange({ ...step, until: until === "merged" ? "merged" : "checks" })}
            options={[{ value: "checks", label: "Until checks finish" }, { value: "merged", label: "Until merged or closed" }]} />
          <label className="flex items-center gap-1.5">At most
            <Input aria-label="Hours to wait for the pull request" className="h-7 w-16 text-xs" inputMode="decimal" value={String(step.timeoutHours)}
              onChange={(event) => onChange({ ...step, timeoutHours: numberOrNull(event.target.value) ?? 24 })} />h
          </label>
        </div>
      );
    case "merge-pr":
      return <Select ariaLabel="Merge method" className="max-w-48" value={step.method} onValueChange={(method) => onChange({ ...step, method: method as typeof step.method })}
        options={[{ value: "squash", label: "Squash and merge" }, { value: "merge", label: "Merge commit" }, { value: "rebase", label: "Rebase and merge" }]} />;
    case "wait":
      return (
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--ec-muted)]">Wait
          <Input aria-label="Minutes to wait" className="h-7 w-20 text-xs" inputMode="numeric" value={String(step.minutes)}
            onChange={(event) => onChange({ ...step, minutes: Math.round(numberOrNull(event.target.value) ?? 60) })} />minutes
        </label>
      );
    case "verify":
      return null;
  }
};

/** The steps that run after an automation's prompt, each optionally limited to an earlier step's answer. */
export const AutomationStepsEditor = ({ value, onChange, projectKind }: AutomationStepsEditorProps) => {
  const setSteps = (steps: AutomationStepDefinition[]) => onChange({ ...value, steps });
  const updateStep = (index: number, step: AutomationStepDefinition) => setSteps(value.steps.map((current, position) => (position === index ? step : current)));
  const moveStep = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= value.steps.length) return;
    const steps = [...value.steps];
    const [moved] = steps.splice(index, 1);
    if (moved) steps.splice(target, 0, moved);
    setSteps(steps);
  };
  const addOptions = AUTOMATION_STEP_KINDS
    .filter((kind) => projectKind === "git" || !AUTOMATION_GIT_STEP_KINDS.has(kind))
    .map((kind) => ({ value: kind, label: AUTOMATION_STEP_LABELS[kind] }));

  const conditionOptions = (index: number) => {
    const earlier = [
      { id: AUTOMATION_PROMPT_STEP_ID, label: "1. Prompt", values: automationStepValues({ kind: "agent", check: value.check }) },
      ...value.steps.slice(0, index).map((step, position) => ({
        id: step.id,
        label: `${String(position + 2)}. ${step.kind === "ask" && step.title ? step.title : AUTOMATION_STEP_LABELS[step.kind]}`,
        values: automationStepValues(step).map((entry) => entry.trim()).filter(Boolean),
      })),
    ];
    return [
      { value: "", label: "Always" },
      ...earlier.flatMap((step) => step.values.length > 1
        ? step.values.map((entry) => ({ value: `${step.id}${CONDITION_SEPARATOR}${entry}`, label: `If ${step.label} is ${automationStepValueLabel(entry)}` }))
        : []),
    ];
  };

  return (
    <div className="md:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--ec-muted)]">Steps</span>
        {value.steps.length < AUTOMATION_MAX_STEPS ? (
          <Select ariaLabel="Add a step" className="min-w-40" value="" placeholder="Add step…" options={addOptions}
            onValueChange={(kind) => setSteps([...value.steps, createAutomationStep(kind as AutomationStepKind)])} />
        ) : null}
      </div>
      <ol className="mt-1 divide-y divide-[var(--ec-border)] rounded-md bg-[var(--ec-panel)]">
        <li className="grid gap-1.5 p-2">
          <div className="flex items-center gap-2 text-xs"><span className="w-4 text-right font-mono text-[10px] text-[var(--ec-faint)]">1</span><span className="font-medium text-[var(--ec-text)]">Agent</span><span className="truncate text-[10px] text-[var(--ec-muted)]">Runs the prompt above</span></div>
          <Input aria-label="Yes or no question for the prompt" className="ml-6 h-8 w-[calc(100%-1.5rem)] text-xs" value={value.check ?? ""} placeholder="Yes/no question it answers, for later steps (optional)"
            onChange={(event) => onChange({ ...value, check: event.target.value || null })} />
        </li>
        {value.steps.map((step, index) => {
          const condition = step.when ? `${step.when.stepId}${CONDITION_SEPARATOR}${step.when.equals}` : "";
          const options = conditionOptions(index);
          return (
            <li key={step.id} className="grid gap-1.5 p-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="w-4 text-right font-mono text-[10px] text-[var(--ec-faint)]">{index + 2}</span>
                <span className="font-medium text-[var(--ec-text)]">{AUTOMATION_STEP_LABELS[step.kind]}</span>
                <span className="hidden min-w-0 flex-1 truncate text-[10px] text-[var(--ec-muted)] sm:block">{STEP_HINTS[step.kind]}</span>
                <Select ariaLabel={`Condition of step ${String(index + 2)}`} className="ml-auto min-w-36 max-w-64" value={options.some((option) => option.value === condition) ? condition : ""} options={options}
                  onValueChange={(selected) => {
                    const [stepId, equals] = selected.split(CONDITION_SEPARATOR);
                    updateStep(index, { ...step, when: stepId && equals ? { stepId, equals } : null });
                  }} />
                <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Move step ${String(index + 2)} up`} disabled={index === 0} onClick={() => moveStep(index, -1)}><ArrowUp className="size-3.5" /></Button>
                <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Move step ${String(index + 2)} down`} disabled={index === value.steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown className="size-3.5" /></Button>
                <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Remove step ${String(index + 2)}`} onClick={() => setSteps(value.steps.filter((_, position) => position !== index))}><X className="size-3.5" /></Button>
              </div>
              <div className="ml-6"><StepFields step={step} onChange={(next) => updateStep(index, next)} /></div>
            </li>
          );
        })}
      </ol>
      {value.steps.length === 0 ? (
        <p className="mt-1 flex items-center gap-1 text-[10px] text-[var(--ec-faint)]"><Plus className="size-3" />Add steps to ask you, review, open a pull request or wait after the prompt.</p>
      ) : null}
    </div>
  );
};
