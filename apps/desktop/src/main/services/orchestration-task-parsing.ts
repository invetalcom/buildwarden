import {
  OrchestrationToolError,
  type OrchestrationRecord,
  type OrchestrationTaskRecord,
  type OrchestrationTaskRemote,
  type ProviderExecutionOptions,
  type RunRecord,
} from "@buildwarden/shared";

/** The checks a delegated task needs that read the database or other services. */
export interface DelegatedTaskParseOptions {
  orchestration: OrchestrationRecord;
  coordinator: RunRecord;
  clientTaskIdExists(clientTaskId: string): boolean;
  modelReportsNoUsage(modelId: string): boolean;
  validateExecutionOptions(modelId: string, raw: unknown, index: number): ProviderExecutionOptions | null;
  /** Where the task runs: null on this host, else a linked host. */
  readRemotePlacement(entry: Record<string, unknown>, index: number): OrchestrationTaskRemote | null;
}

/** The tasks of one buildwarden_tasks_delegate call, validated, before any of them is stored. */
export const parseDelegatedTasks = (rawTasks: unknown[], options: DelegatedTaskParseOptions): Array<{
  clientTaskId: string;
  title: string;
  prompt: string;
  roleId: string;
  modelId: string;
  intent: OrchestrationTaskRecord["intent"];
  permissionMode: "inherit" | "supervised";
  executionOptions: ProviderExecutionOptions | null;
  remote: OrchestrationTaskRemote | null;
}> => {
  const parsed = rawTasks.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new OrchestrationToolError("invalid_arguments", `Task ${index + 1} must be an object.`);
    }
    const entry = value as Record<string, unknown>;
    const clientTaskId = String(entry.clientTaskId ?? "").trim();
    const title = String(entry.title ?? "").trim();
    const prompt = String(entry.prompt ?? "").trim();
    const roleId = String(entry.roleId ?? "").trim();
    let intent: OrchestrationTaskRecord["intent"] | null = null;
    if (entry.intent === "implement" || entry.intent === "inspect") intent = entry.intent;
    if (!clientTaskId || !title || !prompt || !roleId || !intent) {
      throw new OrchestrationToolError("invalid_arguments", `Task ${index + 1} is missing clientTaskId, title, prompt, roleId, or intent.`);
    }
    // The tool schema states these limits, but transports do not all enforce schemas.
    for (const [field, value, limit] of [
      ["clientTaskId", clientTaskId, 80], ["title", title, 160], ["roleId", roleId, 80], ["prompt", prompt, 65_536],
    ] as const) {
      if (value.length > limit) {
        throw new OrchestrationToolError("invalid_arguments", `Task ${index + 1} ${field} is longer than ${String(limit)} characters.`);
      }
    }
    if (options.clientTaskIdExists(clientTaskId)) {
      throw new OrchestrationToolError("invalid_arguments", `clientTaskId "${clientTaskId}" already exists in this orchestration.`);
    }
    const role = options.orchestration.teamSnapshot.roles.find((entryRole) => entryRole.id === roleId);
    if (!role) throw new OrchestrationToolError("role_unknown", `Unknown orchestration role: ${roleId}`);
    const remote = options.readRemotePlacement(entry, index);
    const requestedModelId = typeof entry.modelId === "string" && entry.modelId.trim()
      ? entry.modelId.trim()
      : role.preferredModelId;
    const placeholderModelId = remote ? role.preferredModelId : requestedModelId;
    // A remote task's model is the host's; it keeps the role's own model only as a placeholder.
    if (!remote && !role.eligibleModelIds.includes(requestedModelId)) {
      throw new OrchestrationToolError("model_not_eligible", `Model "${requestedModelId}" is not eligible for role "${role.name}".`);
    }
    if (!remote && options.orchestration.teamSnapshot.maxTotalTokens && options.modelReportsNoUsage(requestedModelId)) {
      throw new OrchestrationToolError(
        "model_unavailable",
        `Model "${requestedModelId}" reports no token usage, so this orchestration's token budget cannot limit it. Choose another model.`,
      );
    }
    if (intent === "implement" && options.coordinator.mode !== "code") {
      throw new OrchestrationToolError("not_authorized", "Only a coordinator running in code mode may delegate implementation tasks.");
    }
    const permissionMode = entry.permissionMode ?? "inherit";
    if (permissionMode !== "inherit" && permissionMode !== "supervised") {
      throw new OrchestrationToolError("invalid_arguments", "Invalid child permission mode.");
    }
    // A host's models have their own options; the host applies its defaults.
    const executionOptions = remote ? null : options.validateExecutionOptions(requestedModelId, entry.executionOptions, index);
    return {
      clientTaskId, title, prompt, roleId, modelId: placeholderModelId, intent,
      permissionMode: permissionMode as "inherit" | "supervised", executionOptions, remote,
    };
  });
  const clientIds = new Set<string>();
  for (const task of parsed) {
    if (clientIds.has(task.clientTaskId)) throw new OrchestrationToolError("invalid_arguments", `Duplicate clientTaskId: ${task.clientTaskId}`);
    clientIds.add(task.clientTaskId);
  }
  return parsed;
};
