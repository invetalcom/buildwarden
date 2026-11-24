import type { OrchestrationTaskRecord, ProviderAccountRecord, ProviderExecutionOptions } from "@buildwarden/shared";

export interface StoredRunExecutionSettings {
  yoloMode?: boolean;
  reasoningEffort?: string;
  anthropicEffort?: string;
  executionOptions?: ProviderExecutionOptions;
}

const latestStoredRunExecutionSettings = (
  steps: ReadonlyArray<{ metadataJson: string }>,
  acceptedSources: ReadonlySet<string>,
): StoredRunExecutionSettings | null => {
  for (const step of [...steps].reverse()) {
    try {
      const metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
      if (
        acceptedSources.has(String(metadata.source ?? "")) &&
        (metadata.commandType === "initial" || metadata.commandType === "follow-up")
      ) {
        const stored = metadata.executionOptions;
        const executionOptions = stored && typeof stored === "object" && !Array.isArray(stored)
          ? (stored as ProviderExecutionOptions)
          : undefined;
        const legacyOrchestrationEffort = metadata.source === "orchestration" && typeof metadata.effort === "string"
          ? metadata.effort
          : undefined;
        const reasoningEffort = typeof metadata.reasoningEffort === "string"
          ? metadata.reasoningEffort
          : legacyOrchestrationEffort;
        const anthropicEffort = typeof metadata.anthropicEffort === "string"
          ? metadata.anthropicEffort
          : legacyOrchestrationEffort;
        return {
          ...(typeof metadata.yoloMode === "boolean" ? { yoloMode: metadata.yoloMode } : {}),
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          ...(anthropicEffort !== undefined ? { anthropicEffort } : {}),
          ...(executionOptions ? { executionOptions } : {}),
        };
      }
    } catch {
      // Ignore malformed historical metadata and keep looking for the latest turn.
    }
  }
  return null;
};

export const latestRunExecutionSettings = (
  steps: ReadonlyArray<{ metadataJson: string }>,
): StoredRunExecutionSettings | null => latestStoredRunExecutionSettings(steps, new Set(["user", "orchestration", "council"]));

export const mergeOrchestrationExecutionOptions = (
  inherited: ProviderExecutionOptions | undefined,
  effortOverride: string | undefined,
): ProviderExecutionOptions | undefined => {
  const merged: ProviderExecutionOptions = {
    ...(inherited ?? {}),
    ...(effortOverride
      ? { reasoningEffort: effortOverride, anthropicEffort: effortOverride }
      : {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
};

/**
 * A delegated task's own settings win over the role's. Effort is stored once and sent in both
 * forms, because providers read either `reasoningEffort` or `anthropicEffort`.
 */
export const applyTaskExecutionOptions = (
  base: ProviderExecutionOptions | undefined,
  task: ProviderExecutionOptions | null | undefined,
): ProviderExecutionOptions | undefined => {
  if (!task || Object.keys(task).length === 0) return base;
  const merged: ProviderExecutionOptions = {
    ...(base ?? {}),
    ...task,
    ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort, anthropicEffort: task.reasoningEffort } : {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
};

export const latestUserTurnUsedFullAccess = (
  steps: ReadonlyArray<{ metadataJson: string }>,
): boolean => latestStoredRunExecutionSettings(steps, new Set(["user"]))?.yoloMode === true;

export const resolveOrchestrationChildFullAccess = (
  taskIntent: OrchestrationTaskRecord["intent"],
  childSteps: ReadonlyArray<{ metadataJson: string }>,
  coordinatorSteps: ReadonlyArray<{ metadataJson: string }>,
): boolean => {
  const persistedChildSetting = latestRunExecutionSettings(childSteps)?.yoloMode;
  if (persistedChildSetting !== undefined) return persistedChildSetting;
  // Before child settings were persisted, only implementation tasks inherited Full Access.
  return taskIntent === "implement" && latestUserTurnUsedFullAccess(coordinatorSteps);
};

type ExecutionOptionsInput = {
  reasoningEffort?: string;
  anthropicEffort?: string;
  executionOptions?: ProviderExecutionOptions;
};

export const resolveProviderExecutionOptions = (
  provider: ProviderAccountRecord,
  input: ExecutionOptionsInput | undefined,
): ProviderExecutionOptions | undefined => {
  // Azure Legacy is intentionally frozen on its established request contract.
  if (provider.providerType === "azure-legacy" || !input) return undefined;
  const resolved: ProviderExecutionOptions = {
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.anthropicEffort !== undefined ? { anthropicEffort: input.anthropicEffort } : {}),
    ...(input.executionOptions ?? {}),
  };
  return Object.keys(resolved).length > 0 ? resolved : undefined;
};

/** Execution settings (beyond model and mode) that a steered message cannot change mid-turn. */
export const steerKeepsExecutionSettings = (
  requested: ProviderExecutionOptions | undefined,
  current: ProviderExecutionOptions | undefined,
): boolean => Object.entries(requested ?? {}).some(([key, value]) =>
  value !== undefined && value !== "" && value !== "auto" &&
  JSON.stringify(value) !== JSON.stringify((current as Record<string, unknown> | undefined)?.[key]));
