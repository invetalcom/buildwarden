import type {
  AppSnapshot,
  ChatDetail,
  ChatEvent,
  ChatRecord,
  QueuedFollowUpRecord,
  RunDetail,
  RunEvent,
  RunListItem,
} from "@buildwarden/shared";

/** Queue events carry the owner's whole follow-up queue. */
export const readQueuedFollowUpsFromEvent = (event: Pick<RunEvent, "metadata">): QueuedFollowUpRecord[] | null =>
  event.metadata?.followUpQueue === true && Array.isArray(event.metadata.queuedFollowUps)
    ? event.metadata.queuedFollowUps as QueuedFollowUpRecord[]
    : null;

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

/** The first collection wins ID conflicts and must contain the freshest records. */
export const mergeOrderedRecords = <RecordType extends { id: string; createdAt: string }>(
  older: readonly RecordType[],
  current: readonly RecordType[],
): RecordType[] => {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of older) byId.set(record.id, record);
  // Array.sort is stable: equal timestamps retain the DB page/insertion order.
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
};

const activeOrchestrationStatuses = new Set(["active", "waiting", "paused", "attention"]);

const isActiveRun = (run: RunListItem): boolean =>
  ["queued", "preparing", "running"].includes(run.status) ||
  (typeof run.orchestrationStatus === "string" && activeOrchestrationStatuses.has(run.orchestrationStatus));

/** Applies one authoritative run row to every denormalized list in the app snapshot. */
export const applyLiveRunToSnapshot = (snapshot: AppSnapshot, run: RunListItem): AppSnapshot => ({
  ...snapshot,
  projects: snapshot.projects.map((entry) => {
    if (entry.project.id !== run.projectId) return entry;
    const standardRuns = [...entry.runs, ...entry.forLaterRuns];
    const existingStandardIndex = standardRuns.findIndex((candidate) => candidate.id === run.id);
    if (run.kind === "standard") {
      if (existingStandardIndex >= 0) standardRuns[existingStandardIndex] = run;
      else standardRuns.unshift(run);
    }
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
  if (chat.runId !== null) return snapshot;
  const summary = {
    id: chat.id,
    prompt: chat.prompt,
    status: chat.status,
    createdAt: chat.createdAt,
    runId: chat.runId,
  };
  const index = snapshot.chats.findIndex((candidate) => candidate.id === chat.id);
  if (index < 0) return { ...snapshot, chats: [summary, ...snapshot.chats] };
  const chats = [...snapshot.chats];
  chats[index] = summary;
  return { ...snapshot, chats };
};

export const isTerminalRunEvent = (event: Pick<RunEvent, "title">): boolean =>
  event.title === "Run completed" || event.title === "Run failed" || event.title === "Run cancelled";

/** Most steps merge into the open detail, but validation rounds live outside the steps. */
export const runEventNeedsDetailRefresh = (event: Pick<RunEvent, "type" | "title" | "step" | "metadata">): boolean =>
  !event.step || event.type === "diff-updated" || isTerminalRunEvent(event) || Boolean(event.metadata?.councilRoundId);

export const applyLiveRunEventToDetail = (detail: RunDetail, event: RunEvent): RunDetail => ({
  ...(detail.workspaceSetup ? { workspaceSetup: detail.workspaceSetup } : {}),
  ...detail,
  run: event.run ?? detail.run,
  ...(detail.workspaceSetup && event.metadata?.workspaceSetup === true && ["running", "completed", "failed"].includes(String(event.metadata.setupStatus)) ? { workspaceSetup: { ...detail.workspaceSetup, status: event.metadata.setupStatus as "running" | "completed" | "failed" } } : {}),
  steps: event.step ? upsertOrderedRecord(detail.steps, event.step) : detail.steps,
  queuedFollowUps: readQueuedFollowUpsFromEvent(event) ?? detail.queuedFollowUps,
});

export const applyLiveChatEventToDetail = (detail: ChatDetail, event: ChatEvent): ChatDetail => ({
  ...detail,
  chat: event.chat ?? detail.chat,
  steps: event.step ? upsertOrderedRecord(detail.steps, event.step) : detail.steps,
  queuedFollowUps: readQueuedFollowUpsFromEvent(event) ?? detail.queuedFollowUps,
});
