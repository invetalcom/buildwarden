/** @vitest-environment happy-dom */

import { APP_SETTING_KEYS, parseSidebarRunSectionsSetting, type AppSnapshot, type DesktopApi, type RunRecord } from "@buildwarden/shared";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { Sidebar } from "./Sidebar";
import { SIDEBAR_SECTION_RUN_DRAG_MIME_TYPE } from "./sidebar-run-sections";

const recentAt = new Date().toISOString();
const oldAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

const runRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: "recent-run",
  projectId: "project-1",
  providerAccountId: "provider-1",
  modelId: "model-1",
  harnessType: "codex-app-server",
  mode: "code",
  workspaceType: "worktree",
  workspaceVcs: "git",
  prompt: "Review retry behavior",
  goalText: null,
  status: "completed",
  branchName: "feat/retry",
  worktreePath: "C:/repo/worktree",
  summary: null,
  errorMessage: null,
  lastProviderResponseId: null,
  inputTokens: 0,
  outputTokens: 0,
  listVisibility: "default",
  sidebarSectionId: null,
  kind: "standard",
  labThreadId: null,
  parentRunId: null,
  rootRunId: null,
  lineageTitle: null,
  projectTaskId: null,
  delegationEnabled: false,
  createdAt: recentAt,
  updatedAt: recentAt,
  startedAt: recentAt,
  finishedAt: recentAt,
  ...overrides,
});

const recentRun = runRecord();
const sectionedOldRun = runRecord({
  id: "old-run",
  prompt: "Windows distribution",
  status: "failed",
  sidebarSectionId: "release",
  createdAt: oldAt,
  updatedAt: oldAt,
  startedAt: oldAt,
  finishedAt: oldAt,
});
const agedOutRun = runRecord({ id: "aged-run", prompt: "Forgotten experiment", createdAt: oldAt, updatedAt: oldAt, startedAt: oldAt, finishedAt: oldAt });

const projects = [{
  project: {
    id: "project-1",
    name: "BuildWarden",
    repoPath: "C:/repo",
    baseBranch: "main",
    kind: "git",
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    createdAt: recentAt,
    updatedAt: recentAt,
    lastOpenedAt: recentAt,
  },
  runs: [recentRun, sectionedOldRun, agedOutRun],
  forLaterRuns: [],
  orchestratedRuns: [],
  activeRuns: [],
  recentRuns: [],
  tasks: [],
  insights: [],
  labThreads: [],
  loops: [],
}] as AppSnapshot["projects"];

const sectionsSetting = JSON.stringify({
  sections: [{ id: "release", name: "Release 0.7", color: "warning", collapsed: false }],
  uncategorizedCollapsed: false,
});

class FakeDataTransfer {
  private readonly data = new Map<string, string>();
  effectAllowed = "all";
  dropEffect = "none";
  get types() {
    return [...this.data.keys()];
  }
  setData(type: string, value: string) {
    this.data.set(type, value);
  }
  getData(type: string) {
    return this.data.get(type) ?? "";
  }
}

const dragEvent = (type: string, dataTransfer: FakeDataTransfer) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

const renderSidebar = async (overrides: Partial<ComponentProps<typeof Sidebar>> = {}) => {
  const props: ComponentProps<typeof Sidebar> = {
    projects,
    landingSelected: false,
    allRunsSelected: false,
    bookmarksSelected: false,
    chatsSelected: false,
    settingsSelected: false,
    selectedProjectId: "project-1",
    currentProjectBranch: "main",
    currentProjectBranchStatus: "attached",
    projectView: "overview",
    highlightedRunId: null,
    collapsed: false,
    width: 312,
    recentRunDays: 7,
    runEntrySize: "medium",
    runSectionsSetting: sectionsSetting,
    attentionInboxSetting: JSON.stringify({ enabled: false }),
    runView: "all",
    runProjectScope: "",
    bookmarksCount: 0,
    chatsCount: 0,
    bookmarkedRunIds: new Set<string>(),
    onSelectLanding: vi.fn(),
    onSelectAllRuns: vi.fn(),
    onSelectBookmarks: vi.fn(),
    onSelectChats: vi.fn(),
    onSelectProject: vi.fn(),
    onSelectProjectFeature: vi.fn(),
    onSelectRun: vi.fn(),
    onRunDragStart: vi.fn(),
    onReorderProjects: vi.fn(),
    onAddRunToBookmarks: vi.fn(),
    onRemoveRunFromBookmarks: vi.fn(),
    onContinueRun: vi.fn(),
    onDeleteRun: vi.fn(),
    onSetRunForLater: vi.fn(),
    onMoveRunToSection: vi.fn(async () => {}),
    onSidebarSettingChange: vi.fn(async () => {}),
    pendingDeleteRunIds: {},
    onOpenSettings: vi.fn(),
    onWidthCommit: vi.fn(),
    onToggleCollapsed: vi.fn(),
    loopEnabledProjectIds: new Set<string>(),
    ...overrides,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(
    <BuildWardenClientProvider client={createElectronBuildWardenClient({} as DesktopApi)}>
      <Sidebar {...props} />
    </BuildWardenClientProvider>,
  ));
  return props;
};

const section = (key: string) => container!.querySelector<HTMLElement>(`[data-sidebar-run-section="${key}"]`)!;
const runRow = (runId: string) => container!.querySelector<HTMLElement>(`[data-run-hierarchy-run="${runId}"]`);

describe("Sidebar run sections", () => {
  it("keeps sectioned runs past the recent window and ages out Uncategorized runs", async () => {
    await renderSidebar();

    expect(section("uncategorized").contains(runRow("recent-run"))).toBe(true);
    expect(section("release").contains(runRow("old-run"))).toBe(true);
    expect(runRow("aged-run")).toBeNull();
    expect(section("uncategorized").textContent).toContain("last 7 days");
  });

  it("moves a run into a section by drag and drop before the save settles", async () => {
    let finishSave: () => void = () => {};
    const onMoveRunToSection = vi.fn(() => new Promise<void>((resolve) => {
      finishSave = resolve;
    }));
    const props = await renderSidebar({ onMoveRunToSection });
    const dataTransfer = new FakeDataTransfer();

    await act(async () => {
      runRow("recent-run")!.querySelector("button[draggable]")!.dispatchEvent(dragEvent("dragstart", dataTransfer));
    });
    expect(props.onRunDragStart).toHaveBeenCalledWith(expect.anything(), "project-1", "recent-run");
    expect(dataTransfer.getData(SIDEBAR_SECTION_RUN_DRAG_MIME_TYPE)).toBe("recent-run");

    await act(async () => {
      section("release").dispatchEvent(dragEvent("dragover", dataTransfer));
    });
    expect(section("release").className).toContain("border-[var(--ec-accent)]");

    await act(async () => {
      section("release").dispatchEvent(dragEvent("drop", dataTransfer));
    });
    expect(onMoveRunToSection).toHaveBeenCalledWith("recent-run", "release");
    expect(section("release").contains(runRow("recent-run"))).toBe(true);
    expect(section("uncategorized").textContent).toContain("New runs land here");

    // Without a refreshed snapshot the optimistic move is rolled back once the save settles.
    await act(async () => finishSave());
    expect(section("uncategorized").contains(runRow("recent-run"))).toBe(true);
  });

  it("ignores drops into the run's current section", async () => {
    const props = await renderSidebar();
    const dataTransfer = new FakeDataTransfer();
    await act(async () => {
      runRow("old-run")!.querySelector("button[draggable]")!.dispatchEvent(dragEvent("dragstart", dataTransfer));
      section("release").dispatchEvent(dragEvent("drop", dataTransfer));
    });
    expect(props.onMoveRunToSection).not.toHaveBeenCalled();
  });

  it("moves runs from the context menu", async () => {
    const props = await renderSidebar();
    await act(async () => {
      runRow("old-run")!.querySelector("button[draggable]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const target = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Uncategorized");
    await act(async () => target?.click());
    expect(props.onMoveRunToSection).toHaveBeenCalledWith("old-run", null);
  });

  it("filters by status view and hides empty sections outside All", async () => {
    const props = await renderSidebar({ runView: "failed" });

    expect(runRow("old-run")).not.toBeNull();
    expect(runRow("recent-run")).toBeNull();
    expect(container!.querySelector('[data-sidebar-run-section="uncategorized"]')).toBeNull();
    expect(container!.querySelector('[data-sidebar-run-view="failed"]')?.textContent).toBe("Failed1");
    expect(container!.querySelector('[data-sidebar-run-view="all"]')?.textContent).toBe("All2");

    await act(async () => container!.querySelector<HTMLButtonElement>('[data-sidebar-run-view="done"]')?.click());
    expect(props.onSidebarSettingChange).toHaveBeenCalledWith(APP_SETTING_KEYS.sidebarRunView, "done");
  });

  it("creates, renames, and deletes sections through the sections setting", async () => {
    // Saves stay pending, so the sidebar keeps rendering its optimistic draft.
    const onSidebarSettingChange = vi.fn<(key: string, value: string) => Promise<void>>(() => new Promise<void>(() => {}));
    await renderSidebar({ onSidebarSettingChange });
    const lastSections = () => parseSidebarRunSectionsSetting(onSidebarSettingChange.mock.lastCall?.[1]).sections;

    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="New section"]')?.click());
    const input = container!.querySelector<HTMLInputElement>('input[aria-label="New section name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Performance");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSidebarSettingChange.mock.lastCall?.[0]).toBe(APP_SETTING_KEYS.sidebarRunSections);
    expect(lastSections().map((entry) => entry.name)).toEqual(["Release 0.7", "Performance"]);
    expect(section(lastSections()[1]!.id).textContent).toContain("Drag runs here");
    expect(container!.textContent).toContain("Performance");

    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Section options for Release 0.7"]')?.click());
    const renameButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Rename");
    await act(async () => renameButton?.click());
    const renameInput = container!.querySelector<HTMLInputElement>('input[aria-label="Section name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(renameInput, "Release 0.8");
      renameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => renameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(lastSections().map((entry) => entry.name)).toEqual(["Release 0.8", "Performance"]);

    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Section options for Release 0.8"]')?.click());
    const deleteButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Delete section");
    await act(async () => deleteButton?.click());
    expect(lastSections().map((entry) => entry.name)).toEqual(["Performance"]);
  });

  it("limits runs to the selected project scope", async () => {
    const otherProject = {
      ...projects[0]!,
      project: { ...projects[0]!.project, id: "project-2", name: "Client Portal" },
      runs: [runRecord({ id: "portal-run", projectId: "project-2", prompt: "Portal login" })],
    };
    await renderSidebar({ projects: [...projects, otherProject] });
    expect(runRow("portal-run")?.textContent).toContain("Client Portal");

    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    await renderSidebar({ projects: [...projects, otherProject], runProjectScope: "project-2" });
    expect(runRow("portal-run")).not.toBeNull();
    expect(runRow("recent-run")).toBeNull();
    expect(runRow("portal-run")?.querySelector("[data-sidebar-run-project]")).toBeNull();
  });
});
