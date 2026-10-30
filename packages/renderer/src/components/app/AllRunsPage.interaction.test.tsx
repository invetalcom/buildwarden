/** @vitest-environment happy-dom */

import type { AppSnapshot, RunRecord } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AllRunsPage } from "./AllRunsPage";

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

const child = runRecord({
  id: "child-run",
  prompt: "Implement the shared hierarchy",
  kind: "orchestration-task",
  parentRunId: "root-run",
  rootRunId: "root-run",
  lineageTitle: "Implement hierarchy",
  delegationEnabled: false,
  updatedAt: "2026-08-09T10:02:00.000Z",
});

const projects = [{
  project: {
    id: "project-1",
    name: "BuildWarden",
    repoPath: "C:/repo",
    baseBranch: "main",
    kind: "git",
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:02:00.000Z",
    lastOpenedAt: "2026-08-09T10:02:00.000Z",
  },
  runs: [runRecord()],
  forLaterRuns: [],
  orchestratedRuns: [child],
  activeRuns: [],
  recentRuns: [runRecord()],
  tasks: [],
  insights: [],
  labThreads: [],
  loops: [],
}] as AppSnapshot["projects"];

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

describe("AllRunsPage hierarchy", () => {
  it("groups runs across projects with labels, primary-only counts, and archived runs", async () => {
    const otherRun = runRecord({ id: "other-run", projectId: "project-2", prompt: "Improve Kanban" });
    const archived = runRecord({ id: "archived", projectId: "project-2", prompt: "Archived investigation", listVisibility: "for-later" });
    const entries = [...projects, { ...projects[0]!, project: { ...projects[0]!.project, id: "project-2", name: "Kanban" },
      runs: [otherRun], forLaterRuns: [archived], orchestratedRuns: [] }];
    const organization = { sections: [{ id: "features", name: "Features", position: 0, color: "#55a8ff" }],
      runs: ["root-run", "child-run", "other-run", "archived"].map((runId) => ({ runId, sectionId: "features", tags: ["frontend"] })) };
    const onSelectRun = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<AllRunsPage projects={entries} runOrganization={organization} onSelectRun={onSelectRun} />));
    expect(container.querySelector('[title="Category: Features"]')).not.toBeNull();
    expect(container.querySelector('[title="Label: frontend"]')).not.toBeNull();
    expect(container.querySelector('[title="Project: BuildWarden"]')).not.toBeNull();
    expect(container.querySelector('[title="Project: Kanban"]')).not.toBeNull();
    expect(container.querySelector('[data-run-hierarchy-run="archived"]')).not.toBeNull();
    const categories = [...container.querySelectorAll("button")].find((button) => button.textContent === "Categories");
    await act(async () => categories?.click());
    expect(container.querySelector('[data-run-history-category="features"] [title="3 primary runs"]')?.textContent).toBe("3");
    await act(async () => container?.querySelector<HTMLButtonElement>('[data-run-hierarchy-toggle="root-run"]')?.click());
    expect(container.querySelectorAll("[data-run-hierarchy-run]")).toHaveLength(4);
    expect(container.querySelector('[title="3 primary runs"]')?.textContent).toBe("3");
    await act(async () => container?.querySelector<HTMLButtonElement>('[data-run-hierarchy-run="other-run"] button')?.click());
    expect(onSelectRun).toHaveBeenCalledWith("project-2", "other-run");
    expect(container.querySelector('[title="Move to For later"]')).toBeNull();
  });

  it("keeps category view while switching to subagents and clears the old selection", async () => {
    localStorage.setItem("buildwarden:run-history-view", "categories");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<AllRunsPage projects={projects} onSelectRun={vi.fn()} onDeleteRuns={vi.fn()} />));
    const click = async (label: string) => {
      const button = [...container!.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
      expect(button).toBeDefined();
      await act(async () => button?.click());
    };
    await click("Select");
    await click("Select all");
    expect(container.textContent).toContain("1 selected");
    await click("Orchestrated");
    expect(container.querySelector('[aria-label="Run selection actions"]')).toBeNull();
    expect(container.querySelector('[data-run-hierarchy-run="root-run"]')).toBeNull();
    expect(container.querySelector('[data-run-hierarchy-run="child-run"]')).not.toBeNull();
    expect(container.querySelector('[data-run-history-category="uncategorized"] [title="0 primary runs"]')).not.toBeNull();
    await click("Flat");
    expect(container.querySelectorAll("[data-run-hierarchy-run]")).toHaveLength(1);
    expect(container.textContent).toContain("Implement hierarchy");
  });

  it("searches subagent prompts in category view and clears back to the complete history", async () => {
    localStorage.setItem("buildwarden:run-history-view", "categories");
    const unrelated = runRecord({ id: "unrelated", prompt: "Update dependencies" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<AllRunsPage projects={[{ ...projects[0]!, runs: [runRecord(), unrelated] }]} onSelectRun={vi.fn()} />));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search runs"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "shared hierarchy");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-run-hierarchy-run="unrelated"]')).toBeNull();
    expect(container.querySelector('[data-run-hierarchy-run="root-run"]')).not.toBeNull();
    expect(container.querySelector('[data-run-hierarchy-run="child-run"]')).not.toBeNull();
    expect(container.textContent).toContain("1 matching of 3 runs");
    await act(async () => container?.querySelector<HTMLButtonElement>('[aria-label="Clear run search"]')?.click());
    expect(container.querySelector('[data-run-hierarchy-run="unrelated"]')).not.toBeNull();
  });

  it("expands subagents without selecting the parent and navigates from child rows", async () => {
    const onSelectRun = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<AllRunsPage projects={projects} onSelectRun={onSelectRun} />));

    const toggle = container.querySelector<HTMLButtonElement>('[data-run-hierarchy-toggle="root-run"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Implement hierarchy");

    await act(async () => toggle.click());

    expect(onSelectRun).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const childRow = container.querySelector<HTMLElement>('[data-run-hierarchy-run="child-run"]');
    expect(childRow?.closest('[data-run-hierarchy-depth="1"]')).not.toBeNull();
    expect(childRow?.textContent).toContain("Implement hierarchy");

    await act(async () => childRow?.querySelector<HTMLButtonElement>("button")?.click());
    expect(onSelectRun).toHaveBeenCalledWith("project-1", "child-run");

    await act(async () => toggle.click());
    expect(container.querySelector('[data-run-hierarchy-run="child-run"]')).toBeNull();
  });

  it("selects visible runs and sends one batch to the deletion flow", async () => {
    const onSelectRun = vi.fn();
    const onDeleteRuns = vi.fn<(runs: RunRecord[]) => Promise<boolean>>().mockResolvedValue(true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <AllRunsPage projects={projects} onSelectRun={onSelectRun} onDeleteRuns={onDeleteRuns} />,
    ));

    await act(async () => container?.querySelector<HTMLButtonElement>('[data-run-hierarchy-toggle="root-run"]')?.click());
    const selectButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Select");
    await act(async () => selectButton?.click());

    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    const selectAllButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Select all");
    await act(async () => selectAllButton?.click());
    expect(container.textContent).toContain("2 selected");

    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Delete");
    await act(async () => deleteButton?.click());

    expect(onDeleteRuns).toHaveBeenCalledTimes(1);
    expect(onDeleteRuns.mock.calls[0]?.[0].map((run) => run.id)).toEqual(["root-run", "child-run"]);
    expect(onSelectRun).not.toHaveBeenCalled();
    expect(container.querySelector('[role="toolbar"][aria-label="Run selection actions"]')).toBeNull();
  });
});
