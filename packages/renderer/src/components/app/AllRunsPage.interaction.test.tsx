/** @vitest-environment happy-dom */

import type { AppSnapshot, RunRecord } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("AllRunsPage hierarchy", () => {
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
});
