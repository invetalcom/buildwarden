import { useState } from "react";
import {
  AUTOMATION_PROMPT_STEP_ID,
  AUTOMATION_STEP_LABELS,
  AUTOMATION_WORKFLOW_RUN_STATUS_LABELS,
  automationStepValueLabel,
  isAutomationWorkflowRunActive,
  type AutomationWorkflowRun,
  type AutomationWorkflowRunStatus,
  type AutomationWorkflowStepState,
} from "@buildwarden/shared";
import { ExternalLink, RotateCcw, Square } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { formatAppErrorMessage } from "../../lib/app-error-message";
import { cn } from "../../lib/cn";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { formatRunRelativeTime } from "./run-summary-format";

const STATUS_TONES: Record<AutomationWorkflowRunStatus, string> = {
  running: "running",
  waiting: "queued",
  paused: "failed",
  completed: "completed",
  cancelled: "cancelled",
};

const stepTitle = (workflow: AutomationWorkflowRun, state: AutomationWorkflowStepState): string => {
  if (state.stepId === AUTOMATION_PROMPT_STEP_ID) return "Prompt";
  const step = workflow.definition.steps.find((entry) => entry.id === state.stepId);
  return step?.kind === "ask" && step.title ? step.title : AUTOMATION_STEP_LABELS[state.kind];
};

const stepResult = (state: AutomationWorkflowStepState): string => {
  if (state.status === "skipped") return "skipped";
  if (state.status === "failed") return "failed";
  if (state.status === "done") return state.value && state.value !== "done" ? automationStepValueLabel(state.value) : "done";
  if (state.status === "waiting" || state.status === "running") return "…";
  return "";
};

/** One answerable question, with an optional or required reason. */
const QuestionAnswer = ({ workflow, state, disabled, onAnswer }: {
  workflow: AutomationWorkflowRun;
  state: AutomationWorkflowStepState;
  disabled: boolean;
  onAnswer: (choice: string, reason: string) => void;
}) => {
  const [reason, setReason] = useState("");
  const question = state.question;
  if (!question || question.answer) return null;
  return (
    <div className="mt-2 rounded-md bg-[var(--ec-control)] p-2">
      <p className="text-xs font-medium text-[var(--ec-text)]">{question.title}</p>
      {question.detail ? <p className="mt-0.5 whitespace-pre-wrap text-[11px] text-[var(--ec-muted)]">{question.detail}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Input aria-label={`Reason for ${workflow.automationName}`} className="h-7 min-w-40 flex-1 text-xs" value={reason}
          placeholder={question.requireReason ? "Reason (required)" : "Reason (optional)"} onChange={(event) => setReason(event.target.value)} />
        {question.choices.map((choice, index) => (
          <Button key={choice} type="button" size="xs" variant={index === 0 ? "default" : "secondary"} disabled={disabled || (question.requireReason && !reason.trim())}
            onClick={() => onAnswer(choice, reason)}>{choice}</Button>
        ))}
      </div>
      {question.expiresAt ? <p className="mt-1 text-[10px] text-[var(--ec-faint)]">Open until {new Date(question.expiresAt).toLocaleString()}</p> : null}
    </div>
  );
};

/** Workflow runs of one automation: progress per step, open questions, and paused runs to retry. */
export const AutomationWorkflowRuns = ({ workflowRuns, onOpenRun, onChanged }: {
  workflowRuns: AutomationWorkflowRun[];
  onOpenRun: (runId: string) => void;
  onChanged: () => void | Promise<void>;
}) => {
  const buildwarden = useBuildWardenClient();
  const canManage = buildwarden.capabilities.automationMutations;
  const canAnswer = buildwarden.capabilities.approvalResponses;
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (workflowRunId: string, action: () => Promise<unknown>, failure: string) => {
    setPendingId(workflowRunId);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (caught) {
      setError(formatAppErrorMessage(caught, failure));
    } finally {
      setPendingId(null);
    }
  };

  if (!workflowRuns.length) return null;
  return (
    <div className="px-3 pt-3">
      <h4 className="mb-2 text-xs font-semibold text-[var(--ec-text)]">Workflow runs</h4>
      <ul className="divide-y divide-[var(--ec-border)] rounded-md bg-[var(--ec-panel)]">
        {workflowRuns.map((workflow) => {
          const current = workflow.steps[workflow.currentIndex];
          const runIds = [...new Set(workflow.steps.flatMap((state) => (state.runId ? [state.runId] : [])))];
          const busy = pendingId === workflow.id;
          return (
            <li key={workflow.id} className="p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONES[workflow.status]} dot className="px-2 py-0.5 text-[10px]">{AUTOMATION_WORKFLOW_RUN_STATUS_LABELS[workflow.status]}</Badge>
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--ec-muted)]">{workflow.trigger.label} · {formatRunRelativeTime(workflow.createdAt)}</span>
                {runIds.map((runId, index) => (
                  <Button key={runId} type="button" size="xs" variant="ghost" onClick={() => onOpenRun(runId)}>
                    <ExternalLink className="size-3" />{runIds.length > 1 ? `Run ${String(index + 1)}` : "Run"}
                  </Button>
                ))}
                {canManage && workflow.status === "paused" ? (
                  <Button type="button" size="xs" variant="secondary" disabled={busy}
                    onClick={() => void act(workflow.id, () => buildwarden.retryAutomationWorkflowRun(workflow.id), "Could not retry this step.")}>
                    <RotateCcw className="size-3" />Retry step
                  </Button>
                ) : null}
                {canManage && (isAutomationWorkflowRunActive(workflow.status) || workflow.status === "paused") ? (
                  <Button type="button" size="xs" variant="ghost" disabled={busy}
                    onClick={() => void act(workflow.id, () => buildwarden.cancelAutomationWorkflowRun(workflow.id), "Could not stop this workflow.")}>
                    <Square className="size-3" />Stop
                  </Button>
                ) : null}
              </div>
              <ol className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
                {workflow.steps.map((state, index) => (
                  <li key={state.stepId} title={state.error ?? state.note ?? undefined}
                    className={cn("flex min-w-0 max-w-64 items-center gap-1", state.status === "skipped" ? "text-[var(--ec-faint)] line-through" : "text-[var(--ec-muted)]",
                      index === workflow.currentIndex && isAutomationWorkflowRunActive(workflow.status) && "font-medium text-[var(--ec-text)]",
                      state.status === "failed" && "text-[var(--ec-danger)]")}>
                    <span className="font-mono text-[var(--ec-faint)]">{index + 1}</span>
                    <span className="truncate">{stepTitle(workflow, state)}</span>
                    {stepResult(state) ? <span className="shrink-0 text-[var(--ec-faint)]">· {stepResult(state)}</span> : null}
                  </li>
                ))}
              </ol>
              {workflow.error ? <p className={cn("mt-1.5 text-[11px]", workflow.status === "paused" ? "text-[var(--ec-danger)]" : "text-[var(--ec-muted)]")}>{workflow.error}</p> : null}
              {canAnswer && workflow.status === "waiting" && current?.question ? (
                <QuestionAnswer workflow={workflow} state={current} disabled={busy}
                  onAnswer={(choice, reason) => void act(workflow.id, () => buildwarden.answerAutomationQuestion({
                    workflowRunId: workflow.id, stepId: current.stepId, choice, reason: reason.trim() || null,
                  }), "Could not send the answer.")} />
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <p className="mt-2 text-xs text-[var(--ec-danger)]">{error}</p> : null}
    </div>
  );
};
