/**
 * Automation workflows: an automation's prompt is its first step, and later steps (questions,
 * reviews, pull request work, waits) run after it in order. Each step can be limited to one
 * answer of an earlier step. The definition is copied into every workflow run when it starts,
 * so editing an automation never changes a run that is already going.
 */

/** How an automation starts besides "Run now", which every automation offers. */
export type AutomationTriggerKind = "schedule" | "manual" | "issue-labelled" | "pr-opened" | "automation-finished";

export type AutomationFinishedOutcome = "any" | "completed" | "failed";

export type AutomationTrigger =
  /** The cron or one-time schedule stored on the automation. */
  | { kind: "schedule" }
  | { kind: "manual" }
  /** An open issue of the project's Git host gets this label. */
  | { kind: "issue-labelled"; label: string }
  /** A pull or merge request is opened, optionally only against one target branch. */
  | { kind: "pr-opened"; targetBranch: string | null }
  /** Another automation of the same project finishes. */
  | { kind: "automation-finished"; automationId: string; outcome: AutomationFinishedOutcome };

export const AUTOMATION_TRIGGER_KINDS: readonly AutomationTriggerKind[] = ["schedule", "manual", "issue-labelled", "pr-opened", "automation-finished"];

export const AUTOMATION_TRIGGER_LABELS: Record<AutomationTriggerKind, string> = {
  schedule: "On a schedule",
  manual: "Only by hand",
  "issue-labelled": "When an issue gets a label",
  "pr-opened": "When a pull request is opened",
  "automation-finished": "After another automation",
};

export const DEFAULT_AUTOMATION_TRIGGER: AutomationTrigger = { kind: "schedule" };

/** Triggers whose prompt carries text written by other people; their runs keep shell approvals on. */
export const isUntrustedAutomationTrigger = (kind: AutomationTriggerKind): boolean =>
  kind === "issue-labelled" || kind === "pr-opened";

export const AUTOMATION_STEP_KINDS = ["agent", "ask", "council", "verify", "open-pr", "wait-pr", "merge-pr", "wait"] as const;
export type AutomationStepKind = typeof AUTOMATION_STEP_KINDS[number];

export const AUTOMATION_STEP_LABELS: Record<AutomationStepKind, string> = {
  agent: "Agent",
  ask: "Ask me",
  council: "Council review",
  verify: "Verification",
  "open-pr": "Open pull request",
  "wait-pr": "Wait for pull request",
  "merge-pr": "Merge pull request",
  wait: "Wait",
};

/** The automation's own prompt. Later steps refer to it by this id. */
export const AUTOMATION_PROMPT_STEP_ID = "prompt";

export interface AutomationStepCondition {
  stepId: string;
  /** One of the values {@link automationStepValues} lists for that step. */
  equals: string;
}

interface AutomationStepBase {
  id: string;
  /** Runs only when an earlier step ended with this value; otherwise it is skipped. */
  when: AutomationStepCondition | null;
}

export interface AutomationAgentStep extends AutomationStepBase {
  kind: "agent";
  prompt: string;
  /** `continue` sends the prompt to the latest agent run of this workflow, in its workspace. */
  workspace: "continue" | "new";
  /** A yes/no question the agent answers at the end, for later conditions. */
  check: string | null;
}

export interface AutomationAskStep extends AutomationStepBase {
  kind: "ask";
  title: string;
  detail: string;
  choices: string[];
  requireReason: boolean;
  /** Null waits until somebody answers. */
  timeoutHours: number | null;
  /** Answer used when the time runs out. Null stops the workflow instead. */
  timeoutChoice: string | null;
}

export interface AutomationCouncilStep extends AutomationStepBase {
  kind: "council";
  /** Sends the findings the run's model recommends back to the agent run to fix them. */
  fixFindings: boolean;
}

export interface AutomationVerifyStep extends AutomationStepBase {
  kind: "verify";
}

export interface AutomationOpenPrStep extends AutomationStepBase {
  kind: "open-pr";
  /** Empty uses the automation's name. */
  title: string;
}

export interface AutomationWaitPrStep extends AutomationStepBase {
  kind: "wait-pr";
  until: "checks" | "merged";
  timeoutHours: number;
}

export interface AutomationMergePrStep extends AutomationStepBase {
  kind: "merge-pr";
  method: "merge" | "squash" | "rebase";
}

export interface AutomationWaitStep extends AutomationStepBase {
  kind: "wait";
  minutes: number;
}

export type AutomationStepDefinition =
  | AutomationAgentStep
  | AutomationAskStep
  | AutomationCouncilStep
  | AutomationVerifyStep
  | AutomationOpenPrStep
  | AutomationWaitPrStep
  | AutomationMergePrStep
  | AutomationWaitStep;

export interface AutomationWorkflowDefinition {
  /** Yes/no question the prompt step's agent answers, for conditions of later steps. */
  check: string | null;
  steps: AutomationStepDefinition[];
}

export const EMPTY_AUTOMATION_WORKFLOW: AutomationWorkflowDefinition = { check: null, steps: [] };

export const AUTOMATION_MAX_STEPS = 20;
export const AUTOMATION_MAX_CHOICES = 4;
const MAX_TEXT = 20_000;
const MAX_SHORT_TEXT = 300;

export const AUTOMATION_STEP_VALUE_LABELS: Record<string, string> = {
  done: "Finished",
  yes: "Yes",
  no: "No",
  clean: "No findings",
  issues: "Findings",
  fixed: "Findings fixed",
  passed: "Passed",
  failed: "Failed",
  opened: "Opened",
  "no-changes": "No changes",
  passing: "Checks passed",
  failing: "Checks failed",
  merged: "Merged",
  closed: "Closed",
  timeout: "Timed out",
};

export const automationStepValueLabel = (value: string): string => AUTOMATION_STEP_VALUE_LABELS[value] ?? value;

/** The values a step can end with; conditions of later steps choose one of them. */
export const automationStepValues = (step: AutomationStepDefinition | { kind: "agent"; check: string | null }): string[] => {
  switch (step.kind) {
    case "agent": return step.check ? ["yes", "no"] : ["done"];
    case "ask": return [...step.choices];
    case "council": return step.fixFindings ? ["clean", "fixed"] : ["clean", "issues"];
    case "verify": return ["passed", "failed"];
    case "open-pr": return ["opened", "no-changes"];
    case "wait-pr": return step.until === "checks" ? ["passing", "failing", "merged", "closed", "timeout"] : ["merged", "closed", "timeout"];
    case "merge-pr": return ["merged"];
    case "wait": return ["done"];
  }
};

/** Steps that need a Git project with a hosted remote. */
export const AUTOMATION_GIT_STEP_KINDS: ReadonlySet<AutomationStepKind> = new Set(["open-pr", "wait-pr", "merge-pr"]);

export const isAutomationWorkflow = (definition: AutomationWorkflowDefinition): boolean => definition.steps.length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max = MAX_TEXT): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

const positiveNumber = (value: unknown, fallback: number, max: number): number => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
};

let generatedStepIds = 0;
/** Short ids are enough: they only have to be unique within one automation. */
export const createAutomationStepId = (): string => {
  generatedStepIds += 1;
  return `s${Date.now().toString(36)}${generatedStepIds.toString(36)}`;
};

export const parseAutomationTrigger = (value: unknown): AutomationTrigger => {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return DEFAULT_AUTOMATION_TRIGGER; }
  }
  if (!isRecord(parsed)) return DEFAULT_AUTOMATION_TRIGGER;
  switch (parsed.kind) {
    case "manual": return { kind: "manual" };
    case "issue-labelled": return { kind: "issue-labelled", label: text(parsed.label, MAX_SHORT_TEXT) };
    case "pr-opened": return { kind: "pr-opened", targetBranch: text(parsed.targetBranch, MAX_SHORT_TEXT) || null };
    case "automation-finished": {
      const outcome = parsed.outcome === "completed" || parsed.outcome === "failed" ? parsed.outcome : "any";
      return { kind: "automation-finished", automationId: text(parsed.automationId, MAX_SHORT_TEXT), outcome };
    }
    default: return DEFAULT_AUTOMATION_TRIGGER;
  }
};

const parseCondition = (value: unknown): AutomationStepCondition | null => {
  if (!isRecord(value)) return null;
  const stepId = text(value.stepId, MAX_SHORT_TEXT);
  const equals = text(value.equals, MAX_SHORT_TEXT);
  return stepId && equals ? { stepId, equals } : null;
};

const parseStep = (value: unknown, index: number): AutomationStepDefinition => {
  if (!isRecord(value)) throw new Error(`Step ${String(index + 2)} is not valid.`);
  const id = text(value.id, MAX_SHORT_TEXT) || createAutomationStepId();
  const when = parseCondition(value.when);
  switch (value.kind) {
    case "agent":
      return { id, when, kind: "agent", prompt: text(value.prompt), workspace: value.workspace === "new" ? "new" : "continue", check: text(value.check, MAX_SHORT_TEXT) || null };
    case "ask": {
      const choices = Array.isArray(value.choices)
        ? [...new Set(value.choices.map((choice) => text(choice, 60)).filter(Boolean))].slice(0, AUTOMATION_MAX_CHOICES)
        : [];
      const timeoutHours = value.timeoutHours === null || value.timeoutHours === undefined || value.timeoutHours === ""
        ? null
        : positiveNumber(value.timeoutHours, 24, 24 * 30);
      const timeoutChoice = text(value.timeoutChoice, 60);
      return {
        id, when, kind: "ask", title: text(value.title, MAX_SHORT_TEXT), detail: text(value.detail, 4_000), choices,
        requireReason: value.requireReason === true, timeoutHours,
        timeoutChoice: timeoutHours !== null && choices.includes(timeoutChoice) ? timeoutChoice : null,
      };
    }
    case "council": return { id, when, kind: "council", fixFindings: value.fixFindings === true };
    case "verify": return { id, when, kind: "verify" };
    case "open-pr": return { id, when, kind: "open-pr", title: text(value.title, MAX_SHORT_TEXT) };
    case "wait-pr":
      return { id, when, kind: "wait-pr", until: value.until === "merged" ? "merged" : "checks", timeoutHours: positiveNumber(value.timeoutHours, 24, 24 * 30) };
    case "merge-pr":
      return { id, when, kind: "merge-pr", method: value.method === "merge" || value.method === "rebase" ? value.method : "squash" };
    case "wait": return { id, when, kind: "wait", minutes: Math.round(positiveNumber(value.minutes, 60, 60 * 24 * 30)) };
    default: throw new Error(`Step ${String(index + 2)} has an unknown type.`);
  }
};

/** Reads a stored or submitted definition. Throws on a step whose type is unknown. */
export const parseAutomationWorkflow = (value: unknown): AutomationWorkflowDefinition => {
  let parsed = value;
  if (typeof value === "string") {
    if (!value.trim()) return EMPTY_AUTOMATION_WORKFLOW;
    try { parsed = JSON.parse(value); } catch { return EMPTY_AUTOMATION_WORKFLOW; }
  }
  if (!isRecord(parsed)) return EMPTY_AUTOMATION_WORKFLOW;
  const steps = Array.isArray(parsed.steps) ? parsed.steps.map(parseStep) : [];
  return { check: text(parsed.check, MAX_SHORT_TEXT) || null, steps };
};

/** Stored definitions are read leniently, so one bad row cannot hide the automation. */
export const readStoredAutomationWorkflow = (value: unknown): AutomationWorkflowDefinition => {
  try { return parseAutomationWorkflow(value); } catch { return EMPTY_AUTOMATION_WORKFLOW; }
};

/** Problems a person has to fix before the definition can be saved. */
export const validateAutomationWorkflow = (definition: AutomationWorkflowDefinition, options: { gitProject: boolean }): string | null => {
  if (definition.steps.length > AUTOMATION_MAX_STEPS) return `An automation can have at most ${String(AUTOMATION_MAX_STEPS)} steps after its prompt.`;
  const known = new Map<string, string[]>([[AUTOMATION_PROMPT_STEP_ID, automationStepValues({ kind: "agent", check: definition.check })]]);
  for (const [index, step] of definition.steps.entries()) {
    const position = `Step ${String(index + 2)}`;
    if (known.has(step.id)) return `${position} repeats the id of an earlier step.`;
    if (step.when) {
      const values = known.get(step.when.stepId);
      if (!values) return `${position} depends on a step that does not come before it.`;
      if (!values.includes(step.when.equals)) return `${position} waits for an answer its earlier step cannot give.`;
    }
    if (step.kind === "agent" && !step.prompt) return `${position} needs a prompt.`;
    if (step.kind === "ask") {
      if (!step.title) return `${position} needs a question.`;
      if (step.choices.length < 2) return `${position} needs at least two answers.`;
    }
    if (AUTOMATION_GIT_STEP_KINDS.has(step.kind) && !options.gitProject) return `${position} needs a Git project.`;
    if ((step.kind === "wait-pr" || step.kind === "merge-pr")
      && !definition.steps.slice(0, index).some((earlier) => earlier.kind === "open-pr")) {
      return `${position} needs an "Open pull request" step before it.`;
    }
    known.set(step.id, automationStepValues(step));
  }
  return null;
};

export type AutomationWorkflowRunStatus = "running" | "waiting" | "paused" | "completed" | "cancelled";
export type AutomationWorkflowStepStatus = "pending" | "running" | "waiting" | "done" | "skipped" | "failed";

export const ACTIVE_AUTOMATION_WORKFLOW_STATUSES: readonly AutomationWorkflowRunStatus[] = ["running", "waiting"];
export const isAutomationWorkflowRunActive = (status: AutomationWorkflowRunStatus): boolean =>
  ACTIVE_AUTOMATION_WORKFLOW_STATUSES.includes(status);
export const isAutomationWorkflowRunFinished = (status: AutomationWorkflowRunStatus): boolean =>
  status === "completed" || status === "cancelled";

export interface AutomationQuestionAnswer {
  choice: string;
  reason: string | null;
  answeredAt: string;
  /** The time ran out and the step's timeout answer was used. */
  timedOut: boolean;
}

export interface AutomationQuestionState {
  title: string;
  detail: string;
  choices: string[];
  requireReason: boolean;
  askedAt: string;
  expiresAt: string | null;
  answer: AutomationQuestionAnswer | null;
}

export interface AutomationWorkflowStepState {
  stepId: string;
  kind: AutomationStepKind;
  status: AutomationWorkflowStepStatus;
  /** What the step ended with, for conditions of later steps. */
  value: string | null;
  /** Short result shown in the run list: an answer's reason, a finding count, a link. */
  note: string | null;
  /** Agent run this step started or continued, or the run it worked on. */
  runId: string | null;
  councilRoundId: string | null;
  prUrl: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** End of a wait or of a pull request wait. */
  waitUntil: string | null;
  /** Last time a pull request wait read the request. */
  polledAt: string | null;
  /** The agent was reminded once to answer its check. */
  checkReminded: boolean;
  question: AutomationQuestionState | null;
  error: string | null;
}

export interface AutomationWorkflowTriggerInfo {
  kind: AutomationTriggerKind | "now";
  /** Shown in the run list, e.g. `Issue #12 got "ready"`. */
  label: string;
  /** Extra context the prompt step's agent receives. */
  context: string | null;
  issueNumber: number | null;
  prUrl: string | null;
  prNumber: number | null;
  upstreamAutomationId: string | null;
  upstreamRunId: string | null;
  /** The prompt includes text written by other people, so runs keep shell approvals on. */
  untrusted: boolean;
}

export interface AutomationWorkflowRun {
  id: string;
  automationId: string;
  projectId: string;
  automationName: string;
  status: AutomationWorkflowRunStatus;
  trigger: AutomationWorkflowTriggerInfo;
  /** The automation's steps as they were when this run started. */
  definition: AutomationWorkflowDefinition;
  /** Index 0 is the prompt step; the rest follow `definition.steps`. */
  steps: AutomationWorkflowStepState[];
  currentIndex: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface AutomationQuestionAttention {
  workflowRunId: string;
  automationId: string;
  stepId: string;
  choices: string[];
  requireReason: boolean;
}

export interface AnswerAutomationQuestionInput {
  workflowRunId: string;
  stepId: string;
  choice: string;
  reason?: string | null;
}

export const isAnswerAutomationQuestionInput = (value: unknown): value is AnswerAutomationQuestionInput =>
  isRecord(value) && typeof value.workflowRunId === "string" && typeof value.stepId === "string" && typeof value.choice === "string" &&
  (value.reason === undefined || value.reason === null || typeof value.reason === "string");

export interface AutomationWorkflowChangedPayload {
  projectId: string;
  automationId: string;
  workflowRunId: string;
}

export const AUTOMATION_WORKFLOW_RUN_STATUS_LABELS: Record<AutomationWorkflowRunStatus, string> = {
  running: "Running",
  waiting: "Waiting",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Stopped",
};

export const createAutomationStepState = (stepId: string, kind: AutomationStepKind): AutomationWorkflowStepState => ({
  stepId, kind, status: "pending", value: null, note: null, runId: null, councilRoundId: null, prUrl: null,
  startedAt: null, finishedAt: null, waitUntil: null, polledAt: null, checkReminded: false, question: null, error: null,
});

/** The step to run at `index`, counting the prompt step as 0. */
export const automationWorkflowStepAt = (
  definition: AutomationWorkflowDefinition,
  index: number,
): AutomationStepDefinition | { id: typeof AUTOMATION_PROMPT_STEP_ID; kind: "agent"; when: null; check: string | null } | null => {
  if (index === 0) return { id: AUTOMATION_PROMPT_STEP_ID, kind: "agent", when: null, check: definition.check };
  return definition.steps[index - 1] ?? null;
};

/** True when the step's condition holds, or it has none. A skipped earlier step never satisfies it. */
export const automationStepConditionHolds = (
  condition: AutomationStepCondition | null,
  states: readonly AutomationWorkflowStepState[],
): boolean => {
  if (!condition) return true;
  const earlier = states.find((state) => state.stepId === condition.stepId);
  return earlier?.status === "done" && earlier.value === condition.equals;
};

const ANSWER_LINE = /^\s*\**\s*ANSWER\s*:\s*\**\s*(yes|no)\b/im;

/** Reads the `ANSWER: yes|no` line an agent ends a checked step with; the last one counts. */
export const parseAutomationCheckAnswer = (answer: string): "yes" | "no" | null => {
  const lines = answer.split(/\r?\n/).reverse();
  for (const line of lines) {
    const match = ANSWER_LINE.exec(line);
    if (match?.[1]) return match[1].toLowerCase() === "yes" ? "yes" : "no";
  }
  return null;
};

export const automationCheckInstruction = (check: string): string => [
  "<automation_check>",
  "When you finish, end your final answer with exactly one line that answers this question:",
  check,
  "Write the line as `ANSWER: yes` or `ANSWER: no`.",
  "</automation_check>",
].join("\n");
