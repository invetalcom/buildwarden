import type { RunRecord } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import {
  appendUnreachableSubagentRoots,
  buildRunHierarchyRows,
  findSubagentHierarchyRoots,
  findRunHierarchyScopeRoots,
  runHierarchyLabel,
} from "./run-hierarchy";

const runRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: "root-run",
  projectId: "project-1",
  providerAccountId: "provider-1",
  modelId: "model-1",
  harnessType: "codex-app-server",
  mode: "code",
  workspaceType: "worktree",
  workspaceVcs: "git",
  prompt: "Coordinate the implementation",
  goalText: null,
  status: "completed",
  branchName: "feat/hierarchy",
  worktreePath: "C:/repo/worktree",
  summary: null,
  errorMessage: null,
  lastProviderResponseId: null,
  inputTokens: 0,
  outputTokens: 0,
  listVisibility: "default",
  kind: "standard",
  labThreadId: null,
  parentRunId: null,
  rootRunId: null,
  lineageTitle: null,
  projectTaskId: null,
  delegationEnabled: true,
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-09T10:00:00.000Z",
  startedAt: "2026-08-09T10:00:00.000Z",
  finishedAt: "2026-08-09T10:01:00.000Z",
  ...overrides,
});

const childRun = (id: string, title: string, updatedAt: string) => runRecord({
  id,
  prompt: `${title} full prompt`,
  kind: "orchestration-task",
  parentRunId: "root-run",
  rootRunId: "root-run",
  lineageTitle: title,
  delegationEnabled: false,
  updatedAt,
});

describe("run hierarchy", () => {
  it("keeps descendants collapsed until their parent is expanded", () => {
    const children = [
      childRun("child-1", "Implement the UI", "2026-08-09T10:02:00.000Z"),
      childRun("child-2", "Review the UI", "2026-08-09T10:03:00.000Z"),
    ];

    const collapsed = buildRunHierarchyRows([runRecord()], children, { expandedRunIds: new Set() });
    expect(collapsed.map(({ run }) => run.id)).toEqual(["root-run"]);
    expect(collapsed[0]).toMatchObject({ depth: 0, directChildCount: 2, descendantCount: 2, expanded: false });

    const expanded = buildRunHierarchyRows([runRecord()], children, { expandedRunIds: new Set(["root-run"]) });
    expect(expanded.map(({ run, depth }) => [run.id, depth])).toEqual([
      ["root-run", 0],
      ["child-2", 1],
      ["child-1", 1],
    ]);
    expect(expanded[0]?.expanded).toBe(true);
  });

  it("reveals matching descendants and their ancestry while searching", () => {
    const children = [
      childRun("child-1", "Implement the UI", "2026-08-09T10:02:00.000Z"),
      childRun("child-2", "Review the UI", "2026-08-09T10:03:00.000Z"),
    ];
    const rows = buildRunHierarchyRows([runRecord()], children, {
      expandedRunIds: new Set(),
      matches: (run) => run.prompt.includes("Review"),
    });

    expect(rows.map(({ run, depth }) => [run.id, depth])).toEqual([
      ["root-run", 0],
      ["child-2", 1],
    ]);
    expect(rows[0]?.expanded).toBe(true);
  });

  it("uses lineage titles and identifies roots in a nested subagent set", () => {
    const parent = childRun("child-1", "Implement the UI", "2026-08-09T10:02:00.000Z");
    const nested = childRun("child-2", "Review the UI", "2026-08-09T10:03:00.000Z");
    nested.parentRunId = parent.id;

    expect(runHierarchyLabel(parent)).toBe("Implement the UI");
    expect(findSubagentHierarchyRoots([parent, nested]).map((run) => run.id)).toEqual([parent.id]);
  });

  it("recovers a disconnected subagent hierarchy exactly once", () => {
    const orphan = childRun("orphan", "Recover durable work", "2026-08-09T10:02:00.000Z");
    orphan.parentRunId = "missing-parent";
    orphan.rootRunId = "missing-root";
    const nested = childRun("nested", "Keep nested work", "2026-08-09T10:03:00.000Z");
    nested.parentRunId = orphan.id;
    nested.rootRunId = "missing-root";

    const roots = appendUnreachableSubagentRoots([runRecord()], [orphan, nested]);
    expect(roots.map((run) => run.id)).toEqual(["root-run", "orphan"]);
    expect(buildRunHierarchyRows(roots, [orphan, nested], {
      expandedRunIds: new Set([orphan.id]),
    }).map(({ run, depth }) => [run.id, depth])).toEqual([
      ["orphan", 0],
      ["nested", 1],
      ["root-run", 0],
    ]);
  });

  it("does not recover a subagent whose primary ancestor is intentionally hidden", () => {
    const hiddenParent = runRecord({ id: "for-later-parent" });
    const child = childRun("hidden-child", "Stay with hidden parent", "2026-08-09T10:02:00.000Z");
    child.parentRunId = hiddenParent.id;
    child.rootRunId = hiddenParent.id;

    expect(appendUnreachableSubagentRoots([], [child], [hiddenParent])).toEqual([]);
  });

  it("includes an older primary ancestor when its child is in the recent scope", () => {
    const olderParent = runRecord({ updatedAt: "2026-08-01T10:00:00.000Z" });
    const recentChild = childRun("recent-child", "Recent delegated work", "2026-08-09T10:02:00.000Z");

    expect(findRunHierarchyScopeRoots(
      [recentChild],
      [olderParent],
      [recentChild],
    ).map((run) => run.id)).toEqual([olderParent.id]);
  });
});
