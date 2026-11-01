const PREFIX = "bw-instance:";

/** Transport IDs stay local to each host; renderer IDs include their owner. */
export const scopedId = (instanceId: string, id: string): string => `${PREFIX}${encodeURIComponent(instanceId)}:${encodeURIComponent(id)}`;
export const parseScopedId = (value: string | null | undefined): { instanceId: string; id: string } | null => {
  if (!value?.startsWith(PREFIX)) return null;
  const separator = value.indexOf(":", PREFIX.length);
  if (separator < 0) return null;
  try { return { instanceId: decodeURIComponent(value.slice(PREFIX.length, separator)), id: decodeURIComponent(value.slice(separator + 1)) }; }
  catch { return null; }
};

/** Domain references only. Prompts, paths, URLs, provider model names and JSON stay untouched. */
const ID_FIELDS = new Set([
  "id", "projectId", "runId", "chatId", "providerAccountId", "modelId", "taskId", "automationId", "loopId", "reviewId", "threadId",
  "bookmarkId", "originalRunId", "originalChatId", "parentRunId", "rootRunId", "coordinatorRunId", "sourceRunId", "targetRunId",
  "originRunId", "continuedFromRunId", "sectionId", "noteId", "sessionId", "stepId", "parentTaskId", "dependsOnTaskId",
  "selectedProjectId", "selectedRunId", "selectedChatId", "approvalRequestId", "requestId", "toolCallId",
  "childRunId", "implementationModelId", "implementationRunId", "iterationId", "labThreadId", "orchestrationId", "projectTaskId",
  "preferredModelId", "reviewModelId", "runnerModelId", "retryOfTaskId", "waveId",
  "userInputRequestId", "browserRunId", "subagentId", "callId",
]);
const ID_ARRAY_FIELDS = new Set(["runIds", "projectIds", "chatIds", "modelIds", "sectionIds", "taskIds", "childRunIds", "ancestorRunIds", "dependencyTaskIds", "deletedRunIds", "eligibleModelIds", "worktreeModelIds", "runningRunIds", "projectLabThreadIds", "projectLoopIds", "wakeTaskIds"]);
const OPAQUE_FIELDS = new Set(["config", "settings", "answers", "questions", "options", "attachments", "executionOptions", "input", "environment", "headers", "arguments", "mcpServers", "forgeRequest"]);

export const mapEntityIds = <Value>(value: Value, map: (id: string) => string): Value => {
  const visit = (entry: unknown, key = ""): unknown => {
    if (key === "metadataJson" && typeof entry === "string") {
      try { return JSON.stringify(visit(JSON.parse(entry) as unknown)); } catch { return entry; }
    }
    if (typeof entry === "string") return ID_FIELDS.has(key) ? map(entry) : entry;
    if (Array.isArray(entry)) return entry.map((item) => ID_ARRAY_FIELDS.has(key) && typeof item === "string" ? map(item) : visit(item));
    if (!entry || typeof entry !== "object") return entry;
    const record = entry as Record<string, unknown>;
    // ModelRecord.modelId is a provider's external model name, unlike RunRecord.modelId.
    const modelRecord = "displayName" in record && "providerAccountId" in record && "modelId" in record;
    if (key === "modelConfigurations") return Object.fromEntries(Object.entries(record).map(([id, item]) => [map(id), item]));
    return Object.fromEntries(Object.entries(record).map(([field, item]) => [field,
      OPAQUE_FIELDS.has(field) || (modelRecord && field === "modelId") ? item : visit(item, field),
    ]));
  };
  return visit(value) as Value;
};
