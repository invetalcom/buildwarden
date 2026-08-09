import type { RunRecord } from "@buildwarden/shared";

export interface RunHierarchyRow {
  run: RunRecord;
  depth: number;
  directChildCount: number;
  descendantCount: number;
  expanded: boolean;
}

export interface BuildRunHierarchyOptions {
  expandedRunIds: ReadonlySet<string>;
  matches?: (run: RunRecord) => boolean;
  compareRuns?: (left: RunRecord, right: RunRecord) => number;
}

const compareNewestFirst = (left: RunRecord, right: RunRecord) =>
  new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();

export const runHierarchyLabel = (run: RunRecord) =>
  run.kind === "orchestration-task" && run.lineageTitle?.trim()
    ? run.lineageTitle.trim()
    : run.prompt;

export const findSubagentHierarchyRoots = (runs: readonly RunRecord[]) => {
  const runIds = new Set(runs.map((run) => run.id));
  return runs.filter((run) => !run.parentRunId || !runIds.has(run.parentRunId));
};

/**
 * Adds the first durable subagent in each disconnected hierarchy as a recovery
 * root. Primary runs that are intentionally hidden from a surface can still be
 * supplied through `knownPrimaryRuns` so their descendants stay hidden with
 * them instead of being mistaken for orphaned data.
 */
export const appendUnreachableSubagentRoots = (
  roots: readonly RunRecord[],
  subagentRuns: readonly RunRecord[],
  knownPrimaryRuns: readonly RunRecord[] = roots,
) => {
  const knownPrimaryIds = new Set(knownPrimaryRuns.map((run) => run.id));
  const knownRunIds = new Set([...knownPrimaryIds, ...subagentRuns.map((run) => run.id)]);
  const recoveryRoots = subagentRuns.filter((run) => {
    const parentIsKnown = Boolean(run.parentRunId && knownRunIds.has(run.parentRunId));
    const rootIsKnown = Boolean(run.rootRunId && knownPrimaryIds.has(run.rootRunId));
    return !parentIsKnown && !rootIsKnown;
  });
  return [...new Map([...roots, ...recoveryRoots].map((run) => [run.id, run])).values()];
};

/** Resolves a limited activity scope back to the visible roots needed to render it. */
export const findRunHierarchyScopeRoots = (
  scopedRuns: readonly RunRecord[],
  visiblePrimaryRuns: readonly RunRecord[],
  subagentRuns: readonly RunRecord[],
  knownPrimaryRuns: readonly RunRecord[] = visiblePrimaryRuns,
) => {
  const visiblePrimaryById = new Map(visiblePrimaryRuns.map((run) => [run.id, run]));
  const knownPrimaryIds = new Set(knownPrimaryRuns.map((run) => run.id));
  const subagentById = new Map(subagentRuns.map((run) => [run.id, run]));
  const roots = new Map<string, RunRecord>();

  for (const scopedRun of scopedRuns) {
    const primaryRun = visiblePrimaryById.get(scopedRun.id);
    if (primaryRun) {
      roots.set(primaryRun.id, primaryRun);
      continue;
    }
    if (scopedRun.kind !== "orchestration-task") continue;

    const durableRoot = scopedRun.rootRunId ? visiblePrimaryById.get(scopedRun.rootRunId) : undefined;
    if (durableRoot) {
      roots.set(durableRoot.id, durableRoot);
      continue;
    }
    if (scopedRun.rootRunId && knownPrimaryIds.has(scopedRun.rootRunId)) continue;

    let recoveryRoot = scopedRun;
    const path = new Set<string>();
    while (recoveryRoot.parentRunId && !path.has(recoveryRoot.id)) {
      path.add(recoveryRoot.id);
      const visibleParent = visiblePrimaryById.get(recoveryRoot.parentRunId);
      if (visibleParent) {
        roots.set(visibleParent.id, visibleParent);
        recoveryRoot = visibleParent;
        break;
      }
      if (knownPrimaryIds.has(recoveryRoot.parentRunId)) break;
      const parentSubagent = subagentById.get(recoveryRoot.parentRunId);
      if (!parentSubagent) {
        roots.set(recoveryRoot.id, recoveryRoot);
        break;
      }
      recoveryRoot = parentSubagent;
    }
    if (!recoveryRoot.parentRunId && recoveryRoot.kind === "orchestration-task") {
      roots.set(recoveryRoot.id, recoveryRoot);
    }
  }

  return [...roots.values()];
};

/**
 * Flattens primary runs and their durable orchestration-task descendants into
 * visible tree rows. During search, matching descendants reveal their ancestry
 * even when the branch was previously collapsed.
 */
export const buildRunHierarchyRows = (
  roots: readonly RunRecord[],
  subagentRuns: readonly RunRecord[],
  { expandedRunIds, matches, compareRuns = compareNewestFirst }: BuildRunHierarchyOptions,
): RunHierarchyRow[] => {
  const rootIds = new Set(roots.map((run) => run.id));
  const allRunsById = new Map<string, RunRecord>();
  for (const run of roots) allRunsById.set(run.id, run);
  for (const run of subagentRuns) allRunsById.set(run.id, run);

  const childrenByParentId = new Map<string, RunRecord[]>();
  for (const run of subagentRuns) {
    const parentId = run.parentRunId && allRunsById.has(run.parentRunId)
      ? run.parentRunId
      : run.rootRunId && rootIds.has(run.rootRunId)
        ? run.rootRunId
        : null;
    if (!parentId || parentId === run.id) continue;
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(run);
    childrenByParentId.set(parentId, children);
  }
  for (const children of childrenByParentId.values()) children.sort(compareRuns);

  const descendantCountByRunId = new Map<string, number>();
  const countDescendants = (runId: string, path: ReadonlySet<string>): number => {
    const cached = descendantCountByRunId.get(runId);
    if (cached !== undefined) return cached;
    if (path.has(runId)) return 0;
    const nextPath = new Set(path).add(runId);
    const count = (childrenByParentId.get(runId) ?? []).reduce(
      (total, child) => total + 1 + countDescendants(child.id, nextPath),
      0,
    );
    descendantCountByRunId.set(runId, count);
    return count;
  };

  const subtreeMatchesByRunId = new Map<string, boolean>();
  const subtreeMatches = (run: RunRecord, path: ReadonlySet<string>): boolean => {
    if (!matches) return true;
    const cached = subtreeMatchesByRunId.get(run.id);
    if (cached !== undefined) return cached;
    if (path.has(run.id)) return false;
    const nextPath = new Set(path).add(run.id);
    const result = matches(run) || (childrenByParentId.get(run.id) ?? []).some((child) => subtreeMatches(child, nextPath));
    subtreeMatchesByRunId.set(run.id, result);
    return result;
  };

  const rows: RunHierarchyRow[] = [];
  const visit = (run: RunRecord, depth: number, path: ReadonlySet<string>) => {
    if (path.has(run.id) || !subtreeMatches(run, path)) return;
    const children = childrenByParentId.get(run.id) ?? [];
    const expanded = children.length > 0 && (Boolean(matches) || expandedRunIds.has(run.id));
    rows.push({
      run,
      depth,
      directChildCount: children.length,
      descendantCount: countDescendants(run.id, new Set()),
      expanded,
    });
    if (!expanded) return;
    const nextPath = new Set(path).add(run.id);
    for (const child of children) visit(child, depth + 1, nextPath);
  };

  for (const root of [...new Map(roots.map((run) => [run.id, run])).values()].sort(compareRuns)) {
    visit(root, 0, new Set());
  }
  return rows;
};
