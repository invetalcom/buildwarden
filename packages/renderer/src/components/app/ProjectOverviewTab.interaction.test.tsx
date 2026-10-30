/** @vitest-environment happy-dom */

import type { RunOrganizationSnapshot, RunRecord } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunHistory } from "./ProjectOverviewTab";
import { buildRunHierarchyRows } from "./run-hierarchy";
import { buildRunHistoryCategories } from "./run-history-categories";

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

beforeEach(() => localStorage.clear());

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
});

describe("run history organization", () => {
  const organization: RunOrganizationSnapshot = {
    sections: [{ id: "bugs", name: "Bugs", position: 0, color: "#ff5268" }, { id: "features", name: "Features", position: 1 }],
    runs: [{ runId: "run-1", sectionId: "features", tags: ["frontend", "priority"] }, { runId: "child", sectionId: "bugs", tags: ["regression"] }],
  };
  const parent = runRecord();
  const child = runRecord({ id: "child", kind: "orchestration-task", parentRunId: parent.id, rootRunId: parent.id, prompt: "Fix regression" });
  const uncategorized = runRecord({ id: "other", prompt: "Inspect the code" });

  it("shows labels and categories, switches views, and reflects sidebar metadata updates", async () => {
    const runs = [parent, uncategorized];
    const onSelectRun = vi.fn();
    const props = {
      runs, orchestratedRuns: [child], treeRows: buildRunHierarchyRows(runs, [child], { expandedRunIds: new Set<string>() }),
      matchingRunCount: 3, searchQuery: "", onSearchChange: vi.fn(), onSelectRun,
      onSetRunForLater: vi.fn(), onToggleRun: vi.fn(), readOnly: true,
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<RunHistory {...props} organization={organization} />));
    expect(container.querySelector('[title="Category: Features"]')).not.toBeNull();
    expect(container.querySelector('[title="Label: frontend"]')?.textContent).toBe("#frontend");
    expect(container.querySelector('[title="Category: Uncategorized"]')).not.toBeNull();
    expect(container.querySelector('[data-run-hierarchy-run="child"]')).toBeNull();

    const categoryButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Categories");
    await act(async () => categoryButton?.click());
    expect(categoryButton?.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("buildwarden:run-history-view")).toBe("categories");
    expect([...container.querySelectorAll("[data-run-history-category]")].map((group) => group.getAttribute("data-run-history-category")))
      .toEqual(["bugs", "features", "uncategorized"]);
    expect(container.querySelector('[data-run-history-category="bugs"] [data-run-hierarchy-run="child"]')).not.toBeNull();
    expect(container.querySelector('[data-run-history-category="bugs"] [title="0 primary runs"]')?.textContent).toBe("0");
    expect(container.querySelector('[data-run-history-category="features"] [title="1 primary run"]')?.textContent).toBe("1");
    expect(container.querySelectorAll('[data-run-hierarchy-run="child"]')).toHaveLength(1);
    expect(container.querySelector('[title="Label: regression"]')).not.toBeNull();
    await act(async () => container?.querySelector<HTMLButtonElement>('[data-run-hierarchy-run="child"] button')?.click());
    expect(onSelectRun).toHaveBeenCalledWith("child");
    expect(container.querySelector('[aria-label="Run selection actions"]')).toBeNull();

    const updated: RunOrganizationSnapshot = { ...organization, sections: [{ id: "bugs", name: "Fixes", position: 0 }],
      runs: [{ runId: parent.id, sectionId: "bugs", tags: ["updated"] }] };
    await act(async () => root?.render(<RunHistory {...props} organization={updated} />));
    expect(container.querySelector('[aria-label="Fixes runs"] [data-run-hierarchy-run="run-1"]')).not.toBeNull();
    expect(container.querySelector('[title="Label: updated"]')).not.toBeNull();
    expect(container.querySelector('[title="Label: frontend"]')).toBeNull();
    await act(async () => root?.render(<RunHistory key="remounted" {...props} organization={updated} />));
    expect(container.querySelector('[data-run-history-category="bugs"]')).not.toBeNull();
  });

  it("selects category-visible children and preserves selection when switching to flat view", async () => {
    localStorage.setItem("buildwarden:run-history-view", "categories");
    const onDeleteRuns = vi.fn<(runs: RunRecord[]) => Promise<boolean>>().mockResolvedValue(true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<RunHistory runs={[parent]} orchestratedRuns={[child]} organization={organization}
      treeRows={buildRunHierarchyRows([parent], [child], { expandedRunIds: new Set() })}
      matchingRunCount={2} searchQuery="" onSearchChange={vi.fn()} onSelectRun={vi.fn()} onSetRunForLater={vi.fn()}
      onToggleRun={vi.fn()} onDeleteRuns={onDeleteRuns} readOnly={false} />));
    const click = async (label: string) => {
      const button = [...container!.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
      expect(button).toBeDefined();
      await act(async () => button?.click());
    };
    await click("Select");
    await click("Select all");
    expect(container.querySelectorAll('[data-run-selected="true"]')).toHaveLength(2);
    await click("Flat");
    expect(container.textContent).toContain("2 selected");
    await click("Delete");
    expect(onDeleteRuns.mock.calls[0]?.[0].map((run) => run.id).sort()).toEqual(["child", "run-1"]);
  });

  it("preserves same-category hierarchy and search ancestry without showing unrelated runs", () => {
    const sameCategory = { ...organization, runs: organization.runs.map((record) => ({ ...record, sectionId: "features" })) };
    const input = { runs: [parent, uncategorized], orchestratedRuns: [child], organization: sameCategory, expandedRunIds: new Set<string>() };
    const collapsed = buildRunHistoryCategories(input);
    expect(collapsed[0]?.count).toBe(1);
    expect(collapsed[0]?.rows.map((row) => row.run.id)).toEqual([parent.id]);
    expect(collapsed[0]?.rows[0]?.descendantCount).toBe(1);
    const expanded = buildRunHistoryCategories({ ...input, expandedRunIds: new Set([parent.id]) });
    expect(expanded[0]?.count).toBe(1);
    expect(expanded[0]?.rows.map((row) => [row.run.id, row.depth])).toEqual([[parent.id, 0], [child.id, 1]]);
    const searchRows = buildRunHierarchyRows(input.runs, [child], { expandedRunIds: new Set(), matches: (run) => run.id === child.id });
    const searched = buildRunHistoryCategories({ ...input, searchRows });
    expect(searched).toHaveLength(1);
    expect(searched[0]?.rows.map((row) => row.run.id)).toEqual([parent.id, child.id]);
    expect(buildRunHistoryCategories({ ...input, searchRows: [] })).toEqual([]);
  });

  it("keeps For later descendants hidden and recovers orphaned and deleted-category runs", () => {
    const hidden = runRecord({ id: "hidden", listVisibility: "for-later" });
    const hiddenChild = runRecord({ ...child, id: "hidden-child", parentRunId: hidden.id, rootRunId: hidden.id });
    const orphan = runRecord({ ...child, id: "orphan", parentRunId: "missing", rootRunId: "missing" });
    const groups = buildRunHistoryCategories({ runs: [parent], knownPrimaryRuns: [parent, hidden], orchestratedRuns: [hiddenChild, orphan],
      organization: { sections: [], runs: [{ runId: parent.id, sectionId: "deleted", tags: [] }] }, expandedRunIds: new Set() });
    expect(groups.map((group) => group.id)).toEqual(["uncategorized"]);
    expect(groups[0]?.rows.map((row) => row.run.id).sort()).toEqual(["orphan", "run-1"]);
  });
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
