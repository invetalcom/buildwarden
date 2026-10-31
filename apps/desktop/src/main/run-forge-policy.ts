import type { ProjectForgeRequestSummary, RunForgeRequestSummary, RunListItem } from "@buildwarden/shared";

export function eligibleForgeDiscoveryRuns(runs: RunListItem[], includeOlder: boolean, recentDays: number, now = Date.now()): RunListItem[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const hidden = (run: RunListItem) => {
    const visited = new Set<string>();
    let current: RunListItem | undefined = run;
    while (current && !visited.has(current.id)) {
      if (current.listVisibility === "for-later") return true;
      visited.add(current.id);
      current = current.parentRunId ? byId.get(current.parentRunId) : undefined;
    }
    return run.rootRunId ? byId.get(run.rootRunId)?.listVisibility === "for-later" : false;
  };
  return runs.filter((run) => run.workspaceVcs === "git" && run.branchName.trim() &&
    (run.kind === "standard" || run.kind === "orchestration-task") && !hidden(run) &&
    (includeOlder || run.forgeRequest?.state === "open" ||
      Date.parse(run.lastUserInputAt ?? run.createdAt) >= now - recentDays * 86_400_000));
}

export function lightweightForgeSummary(request: ProjectForgeRequestSummary, previous: RunForgeRequestSummary | null, now: string): RunForgeRequestSummary {
  const existing = previous?.url === request.url ? previous : null;
  const state = request.state === "merged" ? "merged" : request.state === "closed" ? "closed" : "open";
  // A draft transition invalidates readiness and the available write actions,
  // even though discovery deliberately does not fetch CI/review details.
  const draftChanged = existing !== null && existing.draft !== request.draft;
  return {
    ...request, state,
    readiness: state === "open" ? draftChanged ? "unavailable" : existing?.readiness ?? "unavailable" : state,
    mergeability: existing?.mergeability ?? "unknown", reviewDecision: existing?.reviewDecision ?? "none",
    headSha: existing?.headSha ?? null,
    checks: existing?.checks ?? { completed: 0, total: 0, successful: 0, failed: 0, running: 0 },
    unresolvedThreadCount: existing?.unresolvedThreadCount ?? 0,
    supportedActions: state === "open" && !draftChanged ? existing?.supportedActions ?? ["refresh", "open"] : ["refresh", "open"],
    supportedMergeMethods: state === "open" && !draftChanged ? existing?.supportedMergeMethods ?? [] : [],
    lastSyncedAt: now,
    statusLastSyncedAt: existing && !draftChanged ? existing.statusLastSyncedAt === undefined ? existing.lastSyncedAt : existing.statusLastSyncedAt : null,
    stale: false, syncError: null,
  };
}
