import {
  normalizeRunPlanProgressPayload,
  parseRunPlanProgressStepsFromMarkdown,
  type RunEventType,
  type RunMode,
  type RunPlanProgressPayload,
  type RunPlanProgressSource,
  type RunStatus,
} from "@buildwarden/shared";

export type RunPlanProgressStepLike = {
  id: string;
  eventType: RunEventType;
  content: string;
  metadataJson: string;
  createdAt: string;
};

export type DerivedRunPlanProgress = RunPlanProgressPayload & {
  stepId: string;
  createdAt: string;
  fallback: boolean;
  /** The plan is an unfinished checklist from the prompt before the latest one. */
  previousTurn: boolean;
};

const safeParseMetadata = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const sourceFromProvider = (provider: unknown): RunPlanProgressSource | undefined => {
  if (provider === "codex-cli") return "codex";
  if (provider === "claude-code") return "claude";
  if (provider === "cursor-agent") return "cursor-acp";
  if (provider === "ai-sdk") return "ai-sdk";
  return undefined;
};

const readStructuredProgress = (
  step: RunPlanProgressStepLike,
  metadata: Record<string, unknown>,
): DerivedRunPlanProgress | null => {
  const progress =
    normalizeRunPlanProgressPayload(metadata.planProgress, sourceFromProvider(metadata.provider)) ??
    normalizeRunPlanProgressPayload(
      {
        steps: parseRunPlanProgressStepsFromMarkdown(step.content, { inferStatus: true }),
        source: sourceFromProvider(metadata.provider),
      },
      sourceFromProvider(metadata.provider),
    );
  if (!progress) {
    return null;
  }
  return {
    ...progress,
    stepId: step.id,
    createdAt: step.createdAt,
    fallback: false,
    previousTurn: false,
  };
};

const readFallbackProgress = (
  step: RunPlanProgressStepLike,
  metadata: Record<string, unknown>,
  fallbackMode: RunMode,
): DerivedRunPlanProgress | null => {
  const isProposedPlanEvent = step.eventType === "plan" || step.eventType === "plan-updated";
  const mode = (metadata.mode as RunMode | undefined) ?? fallbackMode;
  const isPlanModeAssistantOutput =
    step.eventType === "output" && mode === "plan" && metadata.assistantKind !== "reasoning" && metadata.source !== "user";
  if (!isProposedPlanEvent && !isPlanModeAssistantOutput) {
    return null;
  }
  const steps = parseRunPlanProgressStepsFromMarkdown(step.content, { maxSteps: 24 });
  if (steps.length < 2) {
    return null;
  }
  return {
    steps,
    source: sourceFromProvider(metadata.provider),
    stepId: step.id,
    createdAt: step.createdAt,
    fallback: true,
    previousTurn: false,
  };
};

/**
 * True for the log step that starts a new prompt turn. Steered messages, goal edits and
 * automatic continuations (coordinator wakes, deferred task resumes, auto-recovery) keep
 * working on the same plan. Orchestration turns that carry new instructions, a user waking
 * the coordinator or messages delivered to a delegated task, start a new prompt.
 */
const startsNewPromptTurn = (step: RunPlanProgressStepLike, metadata: Record<string, unknown>) =>
  step.eventType === "log" &&
  metadata.commandType === "follow-up" &&
  metadata.autoRecoveryKind === undefined &&
  (metadata.orchestrationResume !== true || metadata.userWake === true || Array.isArray(metadata.orchestrationMessageIds));

// Providers may finish successfully without sending a final checklist update.
// Reconcile only code runs; planning can report proposed implementation work.
const completeStaleFinalStep = (progress: DerivedRunPlanProgress, fallbackMode: RunMode): DerivedRunPlanProgress =>
  fallbackMode === "code" &&
  progress.steps.at(-1)?.status === "inProgress" &&
  progress.steps.slice(0, -1).every((planStep) => planStep.status === "completed")
    ? { ...progress, steps: progress.steps.map((planStep) => ({ ...planStep, status: "completed" })) }
    : progress;

/**
 * The plan shown for a run: the latest plan of the current prompt turn. A follow-up prompt
 * hides earlier plans, except an unfinished checklist from the turn right before it, which
 * stays visible as `previousTurn` until the agent reports a plan of its own.
 */
export const deriveLatestRunPlanProgress = (
  steps: readonly RunPlanProgressStepLike[],
  fallbackMode: RunMode,
  runStatus?: RunStatus,
): DerivedRunPlanProgress | null => {
  let previousTurn = false;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step) {
      continue;
    }
    const metadata = safeParseMetadata(step.metadataJson);
    if (startsNewPromptTurn(step, metadata)) {
      if (previousTurn) {
        return null;
      }
      previousTurn = true;
      continue;
    }
    const progress = step.eventType === "plan-progress"
      ? readStructuredProgress(step, metadata)
      : readFallbackProgress(step, metadata, fallbackMode);
    if (!progress) {
      continue;
    }
    if (!previousTurn) {
      return runStatus === "completed" && !progress.fallback ? completeStaleFinalStep(progress, fallbackMode) : progress;
    }
    // A proposed plan is not unfinished work, and a finished checklist says nothing about
    // the current prompt.
    if (progress.fallback) {
      return null;
    }
    const ended = completeStaleFinalStep(progress, fallbackMode);
    return ended.steps.every((planStep) => planStep.status === "completed") ? null : { ...ended, previousTurn: true };
  }
  return null;
};
