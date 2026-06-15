import {
  normalizeRunPlanProgressPayload,
  parseRunPlanProgressStepsFromMarkdown,
  type RunEventType,
  type RunMode,
  type RunPlanProgressPayload,
  type RunPlanProgressSource,
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
  };
};

export const deriveLatestRunPlanProgress = (
  steps: readonly RunPlanProgressStepLike[],
  fallbackMode: RunMode,
): DerivedRunPlanProgress | null => {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step) {
      continue;
    }
    const metadata = safeParseMetadata(step.metadataJson);
    if (step.eventType === "plan-progress") {
      const progress = readStructuredProgress(step, metadata);
      if (progress) {
        return progress;
      }
      continue;
    }
    const fallback = readFallbackProgress(step, metadata, fallbackMode);
    if (fallback) {
      return fallback;
    }
  }
  return null;
};
