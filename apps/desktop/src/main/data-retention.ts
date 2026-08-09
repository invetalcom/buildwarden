import type {
  ChatBookmarkSummary,
  ChatRecord,
  DataRetentionCleanupImpact,
  ProjectLabThreadRecord,
  ProjectLoopRecord,
  RunRecord,
  BookmarkSummary,
} from "@buildwarden/shared";

export interface DataRetentionLoopInput {
  loop: ProjectLoopRecord;
  runIds: string[];
}

export interface DataRetentionCleanupPlan extends DataRetentionCleanupImpact {
  deletionRootRunIds: string[];
}

export interface BuildDataRetentionCleanupPlanInput {
  dayCount: number;
  cutoffAt: string;
  runs: RunRecord[];
  chats: ChatRecord[];
  bookmarks: BookmarkSummary[];
  chatBookmarks: ChatBookmarkSummary[];
  projectLabThreads: ProjectLabThreadRecord[];
  projectLoops: DataRetentionLoopInput[];
  rootRunIdByRunId: ReadonlyMap<string, string>;
}

const isOlderThan = (updatedAt: string, cutoffMs: number): boolean => {
  const updatedAtMs = Date.parse(updatedAt);
  return Number.isFinite(updatedAtMs) && updatedAtMs < cutoffMs;
};

const addOwner = (ownersByRootRunId: Map<string, Set<string>>, rootRunId: string, ownerKey: string) => {
  const owners = ownersByRootRunId.get(rootRunId) ?? new Set<string>();
  owners.add(ownerKey);
  ownersByRootRunId.set(rootRunId, owners);
};

export const buildDataRetentionCleanupPlan = ({
  dayCount,
  cutoffAt,
  runs,
  chats,
  bookmarks,
  chatBookmarks,
  projectLabThreads,
  projectLoops,
  rootRunIdByRunId,
}: BuildDataRetentionCleanupPlanInput): DataRetentionCleanupPlan => {
  const cutoffMs = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoffMs)) throw new Error("The data-retention cutoff is invalid.");

  const runsById = new Map(runs.map((run) => [run.id, run]));
  const groupsByRootRunId = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const configuredRootRunId = rootRunIdByRunId.get(run.id) ?? run.id;
    const rootRunId = runsById.has(configuredRootRunId) ? configuredRootRunId : run.id;
    const group = groupsByRootRunId.get(rootRunId) ?? [];
    group.push(run);
    groupsByRootRunId.set(rootRunId, group);
  }

  const bookmarkedRunIds = new Set(bookmarks.map((bookmark) => bookmark.originalRunId));
  const bookmarkedChatIds = new Set(chatBookmarks.map((bookmark) => bookmark.originalChatId));
  const protectedRunIds = new Set(
    runs
      .filter((run) => run.listVisibility === "for-later" || bookmarkedRunIds.has(run.id))
      .map((run) => run.id),
  );
  const protectedRootRunIds = new Set(
    [...protectedRunIds].map((runId) => rootRunIdByRunId.get(runId) ?? runId),
  );
  const chatsByRunId = new Map<string, ChatRecord[]>();
  for (const chat of chats) {
    if (!chat.runId) continue;
    const runChats = chatsByRunId.get(chat.runId) ?? [];
    runChats.push(chat);
    chatsByRunId.set(chat.runId, runChats);
  }

  const ownersByRootRunId = new Map<string, Set<string>>();
  for (const thread of projectLabThreads) {
    if (!thread.implementationRunId || !runsById.has(thread.implementationRunId)) continue;
    addOwner(ownersByRootRunId, rootRunIdByRunId.get(thread.implementationRunId) ?? thread.implementationRunId, `lab:${thread.id}`);
  }
  for (const { loop, runIds } of projectLoops) {
    for (const runId of runIds) {
      if (!runsById.has(runId)) continue;
      addOwner(ownersByRootRunId, rootRunIdByRunId.get(runId) ?? runId, `loop:${loop.id}`);
    }
  }

  const baseEligibleRootRunIds = new Set<string>();
  for (const [rootRunId, groupRuns] of groupsByRootRunId) {
    const groupChats = groupRuns.flatMap((run) => chatsByRunId.get(run.id) ?? []);
    const allRunsEligible = groupRuns.every(
      (run) => isOlderThan(run.updatedAt, cutoffMs) && !protectedRunIds.has(run.id),
    );
    const allChatsEligible = groupChats.every(
      (chat) => isOlderThan(chat.updatedAt, cutoffMs) && !bookmarkedChatIds.has(chat.id),
    );
    if (allRunsEligible && allChatsEligible) baseEligibleRootRunIds.add(rootRunId);
  }

  const ownerCanDeleteRoot = (ownerKey: string, runId: string): boolean => {
    if (!runsById.has(runId)) return true;
    const rootRunId = rootRunIdByRunId.get(runId) ?? runId;
    const owners = ownersByRootRunId.get(rootRunId) ?? new Set<string>();
    return baseEligibleRootRunIds.has(rootRunId) && owners.size === 1 && owners.has(ownerKey);
  };

  const projectLabThreadIds = projectLabThreads
    .filter((thread) => isOlderThan(thread.updatedAt, cutoffMs))
    .filter((thread) => !thread.implementationRunId || ownerCanDeleteRoot(`lab:${thread.id}`, thread.implementationRunId))
    .map((thread) => thread.id);
  const projectLoopIds = projectLoops
    .filter(({ loop }) => isOlderThan(loop.updatedAt, cutoffMs))
    .filter(({ loop, runIds }) => runIds.every((runId) => ownerCanDeleteRoot(`loop:${loop.id}`, runId)))
    .map(({ loop }) => loop.id);

  const selectedOwnerKeys = new Set([
    ...projectLabThreadIds.map((threadId) => `lab:${threadId}`),
    ...projectLoopIds.map((loopId) => `loop:${loopId}`),
  ]);
  const affectedRootRunIds = [...groupsByRootRunId.keys()].filter((rootRunId) => {
    if (!baseEligibleRootRunIds.has(rootRunId)) return false;
    const owners = ownersByRootRunId.get(rootRunId) ?? new Set<string>();
    return owners.size === 0 || (owners.size === 1 && selectedOwnerKeys.has([...owners][0]!));
  });
  const deletionRootRunIds = affectedRootRunIds.filter(
    (rootRunId) => (ownersByRootRunId.get(rootRunId)?.size ?? 0) === 0,
  );
  const runIds = affectedRootRunIds.flatMap((rootRunId) => groupsByRootRunId.get(rootRunId)?.map((run) => run.id) ?? []);
  const chatIds = chats
    .filter((chat) => isOlderThan(chat.updatedAt, cutoffMs) && !bookmarkedChatIds.has(chat.id))
    .filter((chat) => !chat.runId || !protectedRootRunIds.has(rootRunIdByRunId.get(chat.runId) ?? chat.runId))
    .map((chat) => chat.id);

  return {
    dayCount,
    cutoffAt,
    deletionRootRunIds,
    runIds,
    chatIds,
    projectLabThreadIds,
    projectLoopIds,
    runCount: runIds.length,
    chatCount: chatIds.length,
    projectLabThreadCount: projectLabThreadIds.length,
    projectLoopCount: projectLoopIds.length,
  };
};
