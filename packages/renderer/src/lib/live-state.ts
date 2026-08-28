import type {
  AppSnapshot,
  ChatDetail,
  ChatEvent,
  ChatRecord,
  RunDetail,
  RunEvent,
  RunRecord,
} from "@buildwarden/shared";

const upsertOrderedRecord = <RecordType extends { id: string; createdAt: string }>(
  records: readonly RecordType[],
  record: RecordType,
): RecordType[] => {
  const index = records.findIndex((entry) => entry.id === record.id);
  if (index >= 0) {
    const next = [...records];
    next[index] = record;
    return next;
  }
  return [...records, record].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
};

const activeOrchestrationStatuses = new Set(["active", "waiting", "paused", "attention"]);

const isActiveRun = (run: RunRecord): boolean =>
  ["queued", "preparing", "running"].includes(run.status) ||
  (typeof run.orchestrationStatus === "string" && activeOrchestrationStatuses.has(run.orchestrationStatus));

/** Applies one authoritative run row to every denormalized list in the app snapshot. */
export const applyLiveRunToSnapshot = (snapshot: AppSnapshot, run: RunRecord): AppSnapshot => ({
  ...snapshot,
  projects: snapshot.projects.map((entry) => {
    if (entry.project.id !== run.projectId) return entry;
    const standardRuns = [...entry.runs, ...entry.forLaterRuns];
    const existingStandardIndex = standardRuns.findIndex((candidate) => candidate.id === run.id);
    if (run.kind === "standard" && existingStandardIndex >= 0) standardRuns[existingStandardIndex] = run;
    const runs = standardRuns.filter((candidate) => candidate.listVisibility !== "for-later");
    const forLaterRuns = standardRuns.filter((candidate) => candidate.listVisibility === "for-later");
    const orchestratedRuns = entry.orchestratedRuns.map((candidate) => candidate.id === run.id ? run : candidate);
    return {
      ...entry,
      runs,
      forLaterRuns,
      orchestratedRuns,
      activeRuns: runs.filter(isActiveRun),
      recentRuns: runs.slice(0, 12),
    };
  }),
});

/** Applies one authoritative chat row to the lightweight chat list. */
export const applyLiveChatToSnapshot = (snapshot: AppSnapshot, chat: ChatRecord): AppSnapshot => {
  const index = snapshot.chats.findIndex((candidate) => candidate.id === chat.id);
  if (index < 0) return snapshot;
  const chats = [...snapshot.chats];
  chats[index] = {
    id: chat.id,
    prompt: chat.prompt,
    status: chat.status,
    createdAt: chat.createdAt,
    runId: chat.runId,
  };
  return { ...snapshot, chats };
};

export const applyLiveRunEventToDetail = (detail: RunDetail, event: RunEvent): RunDetail => ({
  ...detail,
  run: event.run ?? detail.run,
  steps: event.step ? upsertOrderedRecord(detail.steps, event.step) : detail.steps,
});

export const applyLiveChatEventToDetail = (detail: ChatDetail, event: ChatEvent): ChatDetail => ({
  ...detail,
  chat: event.chat ?? detail.chat,
  steps: event.step ? upsertOrderedRecord(detail.steps, event.step) : detail.steps,
});
