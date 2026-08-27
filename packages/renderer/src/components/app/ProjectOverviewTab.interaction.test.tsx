/** @vitest-environment happy-dom */

import type { RunRecord } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RunHistory } from "./ProjectOverviewTab";
import { buildRunHierarchyRows } from "./run-hierarchy";

const runRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  projectId: "project-1",
  providerAccountId: "provider-1",
  modelId: "model-1",
  harnessType: "codex-app-server",
  mode: "code",
  workspaceType: "worktree",
  workspaceVcs: "git",
  prompt: "Improve the project",
  goalText: null,
  status: "completed",
  branchName: "feat/run-1",
  worktreePath: "C:/repo/run-1",
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
  delegationEnabled: false,
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-09T10:01:00.000Z",
  startedAt: "2026-08-09T10:00:00.000Z",
  finishedAt: "2026-08-09T10:01:00.000Z",
  ...overrides,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("project run history selection", () => {
  it("shows the OpenRouter mark for runs using the shared AI SDK harness", async () => {
    const run = runRecord({ harnessType: "ai-sdk" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <RunHistory
        runs={[run]}
        orchestratedRuns={[]}
        treeRows={buildRunHierarchyRows([run], [], { expandedRunIds: new Set() })}
        matchingRunCount={1}
        searchQuery=""
        onSearchChange={vi.fn()}
        onSelectRun={vi.fn()}
        onSetRunForLater={vi.fn()}
        onToggleRun={vi.fn()}
        providerTypeByModelId={new Map([[run.modelId, "openrouter"]])}
        readOnly
      />,
    ));

    expect(container.querySelector("svg title")?.textContent).toBe("OpenRouter");
  });

  it("selects a row without navigating and uses the shared deletion callback", async () => {
    const runs = [runRecord(), runRecord({ id: "run-2", branchName: "feat/run-2", worktreePath: "C:/repo/run-2" })];
    const onSelectRun = vi.fn();
    const onDeleteRuns = vi.fn<(runs: RunRecord[]) => Promise<boolean>>().mockResolvedValue(true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <RunHistory
        runs={runs}
        orchestratedRuns={[]}
        treeRows={buildRunHierarchyRows(runs, [], { expandedRunIds: new Set() })}
        matchingRunCount={runs.length}
        searchQuery=""
        onSearchChange={vi.fn()}
        onSelectRun={onSelectRun}
        onSetRunForLater={vi.fn()}
        onDeleteRuns={onDeleteRuns}
        onToggleRun={vi.fn()}
        readOnly={false}
      />,
    ));

    const historyHeading = [...container.querySelectorAll("h3")]
      .find((heading) => heading.textContent === "Run History");
    expect(historyHeading?.parentElement?.previousElementSibling?.getAttribute("class")).toContain("lucide-clock-3");
    const searchInput = container.querySelector<HTMLInputElement>('input[aria-label="Search runs"]');
    expect(searchInput?.parentElement?.parentElement?.querySelector(".lucide-clock-3")).toBeNull();

    const selectButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Select");
    await act(async () => selectButton?.click());
    const firstRow = container.querySelector<HTMLElement>('[data-run-hierarchy-run="run-1"]');
    await act(async () => firstRow?.querySelector<HTMLButtonElement>("button")?.click());

    expect(firstRow?.getAttribute("data-run-selected")).toBe("true");
    expect(onSelectRun).not.toHaveBeenCalled();
    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Delete");
    await act(async () => deleteButton?.click());

    expect(onDeleteRuns).toHaveBeenCalledTimes(1);
    expect(onDeleteRuns.mock.calls[0]?.[0].map((run) => run.id)).toEqual(["run-1"]);
    expect(container.querySelector('[role="toolbar"][aria-label="Run selection actions"]')).toBeNull();
  });
});
