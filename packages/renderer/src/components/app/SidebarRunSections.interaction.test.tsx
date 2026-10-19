/** @vitest-environment happy-dom */
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot, RunOrganizationSnapshot, RunRecord, UpdateRunOrganizationInput } from "@buildwarden/shared";
import { SidebarRunSections } from "./SidebarRunSections";
import { Sidebar } from "./Sidebar";
import { RUN_DRAG_MIME_TYPE } from "./app-model";
import { buildSidebarRunSections } from "./sidebar-run-sections";

const client = { capabilities: { runListVisibilityMutations: true }, updateRunOrganization: vi.fn(), createRunSection: vi.fn(),
  renameRunSection: vi.fn(), deleteRunSection: vi.fn(), reorderRunSections: vi.fn(), setRunSectionColor: vi.fn() };
vi.mock("../../lib/buildwarden-client", () => ({ useBuildWardenClient: () => client }));

const run = (id: string, status: RunRecord["status"], extra: Partial<RunRecord> = {}) => ({ id, status, projectId: "p1", prompt: id,
  kind: "standard", listVisibility: "default", parentRunId: null, rootRunId: null,
  createdAt: "2026-01-01T00:00:00.000Z", ...extra }) as RunRecord;
const running = run("running-run", "running");
const failed = run("failed-run", "failed");
const old = run("old-run", "completed");
const projects = [{ project: { id: "p1", name: "Project" }, runs: [running, failed, old], orchestratedRuns: [], forLaterRuns: [] }] as unknown as AppSnapshot["projects"];
const initial: RunOrganizationSnapshot = { sections: [{ id: "work", name: "This week", position: 0 }, { id: "later", name: "Experiments", position: 1 }],
  runs: [{ runId: failed.id, sectionId: "work", tags: ["bug"] }] };
let state: RunOrganizationSnapshot;
let root: Root;
let container: HTMLDivElement;
const paneDrop = vi.fn();
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); state = structuredClone(initial);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T00:00:00.000Z"));
  client.capabilities.runListVisibilityMutations = true;
  client.createRunSection.mockImplementation(async (name: string, color?: string) => {
    state = { ...state, sections: [...state.sections, { id: "created", name, color, position: state.sections.length }] };
    return state;
  });
  client.setRunSectionColor.mockImplementation(async (id: string, color: string) => {
    state = id === "uncategorized" ? { ...state, uncategorizedColor: color }
      : { ...state, sections: state.sections.map((section) => section.id === id ? { ...section, color } : section) };
    return state;
  });
  client.renameRunSection.mockImplementation(async (id: string, name: string) => {
    state = { ...state, sections: state.sections.map((section) => section.id === id ? { ...section, name } : section) };
    return state;
  });
  client.reorderRunSections.mockImplementation(async (ids: string[]) => {
    state = { ...state, sections: ids.map((id, position) => ({ ...state.sections.find((section) => section.id === id)!, position })) };
    return state;
  });
  client.deleteRunSection.mockImplementation(async (id: string) => {
    state = { sections: state.sections.filter((section) => section.id !== id),
      runs: state.runs.map((run) => run.sectionId === id ? { ...run, sectionId: null } : run) };
    return state;
  });
  client.updateRunOrganization.mockImplementation(async (id: string, input: UpdateRunOrganizationInput) => {
    const record = state.runs.find((item) => item.runId === id) ?? { runId: id, sectionId: null, tags: [] };
    state = { ...state, runs: [...state.runs.filter((item) => item.runId !== id), { ...record, ...input }] };
    return state;
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

const mount = async (organizeRunId: string | null = null, entries = projects, grouped = false, highlightedRunId: string | null = null, recentRunDays = 2,
  options: { uncategorizedSection?: boolean; uncategorizedFirst?: boolean } = {}) => {
  let setHighlightedRun!: (id: string | null) => void;
  const Harness = () => {
    const [organization, setOrganization] = useState(state);
    const [editor, setEditor] = useState(organizeRunId);
    const [highlighted, setHighlighted] = useState(highlightedRunId);
    setHighlightedRun = setHighlighted;
    return <div onDrop={paneDrop}><SidebarRunSections {...options} projects={entries} organization={organization} onOrganizationChange={setOrganization}
      recentRunDays={recentRunDays} hideActiveRuns={false} groupRunsByProject={grouped} expandedRunIds={new Set()} highlightedRunId={highlighted}
      organizeRunId={editor} onCloseOrganizer={() => setEditor(null)} renderRun={(_, row) => <button key={row.run.id} data-test-run={row.run.id}>{row.run.prompt}</button>} /></div>;
  };
  await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
  return async (id: string | null) => { await act(async () => setHighlightedRun(id)); };
};
const section = (id: string) => container.querySelector<HTMLElement>(`[data-run-section="${id}"]`)!;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const drop = async (id: string, runId: string, mime = RUN_DRAG_MIME_TYPE, projectId = "p1") => {
  const transfer = { types: [mime], dropEffect: "none", getData: () => JSON.stringify({ type: "buildwarden/run", runId, projectId }) };
  const over = new Event("dragover", { bubbles: true, cancelable: true }); Object.defineProperty(over, "dataTransfer", { value: transfer });
  const event = new Event("drop", { bubbles: true, cancelable: true }); Object.defineProperty(event, "dataTransfer", { value: transfer });
  await act(async () => { section(id).dispatchEvent(over); section(id).dispatchEvent(event); });
  return { over, event, transfer };
};

describe("sidebar run sections", () => {
  it.each([false, true])("shows uncategorized runs without a section header while preserving saved collapse and position (grouped: %s)", async (grouped) => {
    const key = "buildwarden:sidebar-run-sections";
    const stored = JSON.stringify({ collapsed: ["uncategorized"] });
    localStorage.setItem(key, stored);
    await mount(null, projects, grouped, null, 2, { uncategorizedSection: false, uncategorizedFirst: true });
    expect(section("uncategorized").getAttribute("aria-label")).toBe("Uncategorized runs");
    expect(button("Manage Uncategorized section")).toBeUndefined();
    expect(section("uncategorized").querySelector("[data-section-color]")).toBeNull();
    expect(section("uncategorized").querySelectorAll("[data-test-run]")).toHaveLength(2);
    expect(Boolean(section("uncategorized").querySelector("[data-sidebar-run-group]"))).toBe(grouped);
    expect(container.querySelector("[data-run-section]")?.getAttribute("data-run-section")).toBe("uncategorized");
    expect(button("Manage This week section")).toBeDefined();
    expect(localStorage.getItem(key)).toBe(stored);
    await mount(null, projects, grouped);
    expect(section("uncategorized").querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    expect(section("uncategorized").querySelectorAll("[data-test-run]")).toHaveLength(0);
    expect(button("Manage Uncategorized section")).toBeDefined();
  });

  it("retains the age window and older-run filter without the Uncategorized header", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-02-01T00:00:00.000Z"));
    await mount(null, projects, false, null, 20, { uncategorizedSection: false });
    expect(section("uncategorized").textContent).toContain(running.id);
    expect(section("uncategorized").textContent).not.toContain(old.id);
    await click(button("Show older runs"));
    expect(section("uncategorized").textContent).toContain(old.id);
    await click(button("Filter runs")); await click(button("Done1"));
    expect(section("uncategorized").querySelectorAll("[data-test-run]")).toHaveLength(1);
    expect(section("uncategorized").textContent).toContain(old.id);
  });

  it("accepts a drop into the empty uncategorized area without a section header", async () => {
    state = { ...state, runs: projects[0]!.runs.map((run) => ({ runId: run.id, sectionId: "work", tags: [] })) };
    await mount(null, projects, false, null, 2, { uncategorizedSection: false });
    expect(section("uncategorized").textContent).toContain("Drop runs here to uncategorize");
    await drop("uncategorized", running.id);
    expect(client.updateRunOrganization).toHaveBeenCalledWith(running.id, { sectionId: null });
    expect(section("uncategorized").textContent).toContain(running.id);
    await drop("later", running.id);
    expect(section("uncategorized").querySelectorAll("[data-test-run]")).toHaveLength(0);
    expect(section("later").textContent).toContain(running.id);
  });
  it("persists manual preferences once in StrictMode without saving automatic highlighted-run expansion", async () => {
    const key = "buildwarden:sidebar-run-sections";
    await mount();
    const save = vi.spyOn(localStorage, "setItem");
    await click(section("work").querySelector("button")!);
    expect(save).toHaveBeenCalledTimes(1);
    const stored = localStorage.getItem(key);
    expect(JSON.parse(stored!).collapsed).toContain("work");
    save.mockClear();
    await mount(null, projects, false, failed.id);
    expect(section("work").querySelector(`[data-test-run="${failed.id}"]`)).not.toBeNull();
    expect(localStorage.getItem(key)).toBe(stored);
    expect(save).not.toHaveBeenCalled();
  });

  it("persists expansion and filter clearing together when dropping into a collapsed section", async () => {
    const key = "buildwarden:sidebar-run-sections";
    localStorage.setItem(key, JSON.stringify({ view: "failed", tag: "bug", projectId: "p1", collapsed: ["later"] }));
    await mount();
    const save = vi.spyOn(localStorage, "setItem");
    await drop("later", failed.id);
    expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ view: "all", tag: "", projectId: "p1", collapsed: [], includeOlderRuns: false });
    await mount();
    expect(section("later").querySelector(`[data-test-run="${failed.id}"]`)).not.toBeNull();
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(3);
  });

  it.each([true, false])("does not save transient highlight expansion during a pending drop (success: %s)", async (succeeds) => {
    const key = "buildwarden:sidebar-run-sections";
    const stored = JSON.stringify({ collapsed: ["work", "later"] });
    localStorage.setItem(key, stored);
    let resolve!: (value: RunOrganizationSnapshot) => void;
    let reject!: (reason: Error) => void;
    client.updateRunOrganization.mockImplementationOnce(() => new Promise<RunOrganizationSnapshot>((done, fail) => {
      resolve = done; reject = fail;
    }));
    const highlight = await mount();
    const save = vi.spyOn(localStorage, "setItem");
    await drop("later", running.id);
    await highlight(failed.id);
    expect(section("work").querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem(key)).toBe(stored);
    await act(async () => {
      if (succeeds) resolve({ ...state, runs: [...state.runs, { runId: running.id, sectionId: "later", tags: [] }] });
      else reject(new Error("Move failed"));
    });
    expect(save).toHaveBeenCalledTimes(succeeds ? 1 : 0);
    expect(JSON.parse(localStorage.getItem(key)!).collapsed).toEqual(succeeds ? ["work"] : ["work", "later"]);
    expect(section("work").querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    expect(section("later").querySelector("button")!.getAttribute("aria-expanded")).toBe(String(succeeds));
    await mount();
    expect(section("work").querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not save transient expansion through unrelated manual preference changes", async () => {
    const key = "buildwarden:sidebar-run-sections";
    localStorage.setItem(key, JSON.stringify({ collapsed: ["work"] }));
    await mount(null, projects, false, failed.id);
    await click(button("Filter runs")); await click(button("Include older runs"));
    await click(section("later").querySelector("button")!);
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ collapsed: ["work", "later"], includeOlderRuns: true });
    expect(section("work").querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    // An explicit collapse/reopen of the highlighted section must still persist.
    await click(section("work").querySelector("button")!);
    expect(section("work").querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    await click(section("work").querySelector("button")!);
    expect(JSON.parse(localStorage.getItem(key)!).collapsed).toEqual(["later"]);
  });

  it.each([true, false])("respects a manually collapsed transient destination during a pending drop (manual collapse: %s)", async (manualCollapse) => {
    const key = "buildwarden:sidebar-run-sections";
    localStorage.setItem(key, JSON.stringify({ collapsed: ["work"] }));
    let resolve!: (value: RunOrganizationSnapshot) => void;
    client.updateRunOrganization.mockImplementationOnce(() => new Promise<RunOrganizationSnapshot>((done) => { resolve = done; }));
    const highlight = await mount();
    await drop("work", running.id);
    await highlight(failed.id);
    expect(section("work").querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    if (manualCollapse) await click(section("work").querySelector("button")!);
    await act(async () => resolve({ ...state, runs: [...state.runs, { runId: running.id, sectionId: "work", tags: [] }] }));
    expect(section("work").querySelector("button")!.getAttribute("aria-expanded")).toBe(String(!manualCollapse));
    expect(JSON.parse(localStorage.getItem(key)!).collapsed).toEqual(manualCollapse ? ["work"] : []);
    await mount();
    expect(section("work").querySelector("button")!.getAttribute("aria-expanded")).toBe(String(!manualCollapse));
  });

  it.each([true, false])("changes view preferences only when a pending drop succeeds (success: %s)", async (succeeds) => {
    const key = "buildwarden:sidebar-run-sections";
    const stored = JSON.stringify({ view: "failed", tag: "bug", projectId: "p1", collapsed: ["later"] });
    localStorage.setItem(key, stored);
    let resolve!: (value: RunOrganizationSnapshot) => void;
    let reject!: (reason: Error) => void;
    client.updateRunOrganization.mockImplementationOnce(() => new Promise<RunOrganizationSnapshot>((done, fail) => {
      resolve = done; reject = fail;
    }));
    await mount();
    const save = vi.spyOn(localStorage, "setItem");
    const expectOriginalView = () => {
      expect(localStorage.getItem(key)).toBe(stored);
      expect(save).not.toHaveBeenCalled();
      expect(button("Filter runs").title).toBe("Filter runs: Failed");
      expect(button("Filter runs by tag").title).toContain("#bug");
      expect(button("Filter runs by project").textContent).toBe("Project");
      expect(section("later").querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
      expect(section("work").querySelector(`[data-test-run="${failed.id}"]`)).not.toBeNull();
    };
    await drop("later", failed.id);
    expectOriginalView();
    await act(async () => {
      if (succeeds) resolve({ ...state, runs: state.runs.map((entry) => ({ ...entry, sectionId: "later" })) });
      else reject(new Error("Move failed"));
    });
    if (succeeds) {
      expect(save).toHaveBeenCalledTimes(1);
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ view: "all", tag: "", projectId: "p1", collapsed: [], includeOlderRuns: false });
      expect(section("later").querySelector(`[data-test-run="${failed.id}"]`)).not.toBeNull();
    } else {
      expectOriginalView();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Move failed");
    }
  });

  it("preserves filters and unrelated section changes made while a drop is pending", async () => {
    const key = "buildwarden:sidebar-run-sections";
    localStorage.setItem(key, JSON.stringify({ view: "failed", tag: "bug", projectId: "p1", collapsed: ["later"] }));
    const other = run("other-run", "completed", { projectId: "p2" });
    const entries = [...projects, { ...projects[0]!, project: { ...projects[0]!.project, id: "p2", name: "Other project" }, runs: [other] }];
    state = { ...state, runs: [...state.runs, { runId: other.id, sectionId: null, tags: ["feature"] }] };
    let resolve!: (value: RunOrganizationSnapshot) => void;
    client.updateRunOrganization.mockImplementationOnce(() => new Promise<RunOrganizationSnapshot>((done) => { resolve = done; }));
    await mount(null, entries);
    await drop("later", failed.id);
    await click(button("Filter runs by project")); await click(button("Other project"));
    await click(button("Filter runs by tag")); await click(button("#feature"));
    await click(button("Filter runs")); await click(button("Done1"));
    await click(section("work").querySelector("button")!);
    const save = vi.spyOn(localStorage, "setItem");
    await act(async () => resolve({ ...state, runs: state.runs.map((entry) => entry.runId === failed.id ? { ...entry, sectionId: "later" } : entry) }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ view: "done", tag: "feature", projectId: "p2", collapsed: ["work"], includeOlderRuns: false });
    expect(button("Filter runs by project").textContent).toBe("Other project");
    expect(button("Filter runs by tag").title).toContain("#feature");
    expect(button("Filter runs").title).toBe("Filter runs: Done");
    expect(section("work").querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    expect(section("later").querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(1);
  });

  it("keeps a destination collapsed if the user collapses it during a pending drop", async () => {
    let resolve!: (value: RunOrganizationSnapshot) => void;
    client.updateRunOrganization.mockImplementationOnce(() => new Promise<RunOrganizationSnapshot>((done) => { resolve = done; }));
    await mount();
    await drop("later", failed.id);
    await click(section("later").querySelector("button")!);
    await act(async () => resolve({ ...state, runs: state.runs.map((entry) => ({ ...entry, sectionId: "later" })) }));
    expect(section("later").querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem("buildwarden:sidebar-run-sections")!).collapsed).toContain("later");
  });

  it("restores focus after cancelling or escaping a dialog opened from the add button", async () => {
    await mount();
    const trigger = button("New run section");
    for (const dismiss of ["cancel", "escape"]) {
      trigger.focus(); await click(trigger);
      button("Cancel").focus();
      if (dismiss === "cancel") await click(button("Cancel"));
      else await act(async () => { document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })); });
      expect(document.querySelector("dialog")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }
  });

  it.each(["Rename section", "Change color", "Remove section"])("returns focus to the section trigger after %s, not the removed menu item", async (action) => {
    await mount();
    const trigger = button("Manage This week section");
    trigger.focus(); await click(trigger);
    const menuItem = button(action); menuItem.focus(); await click(menuItem);
    expect(menuItem.isConnected).toBe(false);
    button("Cancel").focus(); await click(button("Cancel"));
    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus after saving and falls back to the add button when the section is deleted", async () => {
    await mount();
    const trigger = button("Manage This week section");
    await click(trigger); button("Rename section").focus(); await click(button("Rename section"));
    await click(button("Save section"));
    expect(document.activeElement).toBe(trigger);
    await click(trigger); button("Remove section").focus(); await click(button("Remove section"));
    await click(button("Remove section"));
    expect(trigger.isConnected).toBe(false);
    expect(document.activeElement).toBe(button("New run section"));
  });

  it.each([
    { x: 100, y: 100, left: 100, top: 100 },
    { x: 790, y: 590, left: 552, top: 392 },
    { x: 0, y: 0, left: 8, top: 8 },
  ])("keeps the run context menu in the viewport at ($x, $y) and restores editor focus", async ({ x, y, left, top }) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    const viewportHeight = vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    const getRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this === button("Move to section / edit tags")?.parentElement
        ? new DOMRect(0, 0, 240, 200) : getRect.call(this);
    });
    const entries = projects.map((entry) => ({ ...entry, activeRuns: [], tasks: [], labThreads: [], loops: [] }));
    await act(async () => root.render(<Sidebar projects={entries} runOrganization={state}
      landingSelected={false} allRunsSelected={false} bookmarksSelected={false} chatsSelected={false} settingsSelected={false}
      selectedProjectId="p1" currentProjectBranch="main" currentProjectBranchStatus="attached" projectView="overview"
      highlightedRunId={null} collapsed={false} width={312} recentRunDays={2} runEntrySize="medium" groupRunsByProject={false}
      bookmarksCount={0} chatsCount={0} bookmarkedRunIds={new Set()} pendingDeleteRunIds={{}} loopEnabledProjectIds={new Set()}
      attentionInboxSetting={'{"enabled":false}'}
      onSelectLanding={vi.fn()} onSelectAllRuns={vi.fn()} onSelectBookmarks={vi.fn()} onSelectChats={vi.fn()}
      onSelectProject={vi.fn()} onSelectProjectFeature={vi.fn()} onSelectRun={vi.fn()} onRunDragStart={vi.fn()} onReorderProjects={vi.fn()}
      onAddRunToBookmarks={vi.fn()} onRemoveRunFromBookmarks={vi.fn()} onContinueRun={vi.fn()} onDeleteRun={vi.fn()}
      onSetRunForLater={vi.fn()} onOpenSettings={vi.fn()} onWidthCommit={vi.fn()} onToggleCollapsed={vi.fn()} />));
    const trigger = container.querySelector<HTMLButtonElement>(`[data-run-hierarchy-run="${failed.id}"] button[draggable]`)!;
    trigger.focus();
    await act(async () => { trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y })); });
    const menu = button("Move to section / edit tags").parentElement!;
    expect(menu.style.left).toBe(`${left}px`);
    expect(menu.style.top).toBe(`${top}px`);
    viewportHeight.mockReturnValue(250);
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(menu.style.top).toBe(`${Math.max(8, Math.min(y, 42))}px`);
    const menuItem = button("Move to section / edit tags"); menuItem.focus(); await click(menuItem);
    expect(menuItem.isConnected).toBe(false);
    button("Cancel").focus(); await click(button("Cancel"));
    expect(document.activeElement).toBe(trigger);
  });

  it.each([false, true])("filters projects together with status and remembers the selection (grouped: %s)", async (grouped) => {
    const other = run("other-run", "failed", { projectId: "p2" });
    const entries = [...projects, { ...projects[0]!, project: { ...projects[0]!.project, id: "p2", name: "Other project" }, runs: [other] }];
    await mount(null, entries, grouped);
    await click(button("Filter runs by project")); await click(button("Other project"));
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(1);
    expect(section("uncategorized").textContent).toContain(other.id);
    await click(button("Filter runs"));
    expect(button("All statuses1")).toBeDefined();
    await click(button("Active0"));
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(0);
    await click(button("Filter runs")); await click(button("Failed1"));
    await mount(null, entries, grouped);
    expect(button("Filter runs by project").textContent).toBe("Other project");
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(1);
    await click(button("Filter runs by project")); await click(button("All projects"));
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(2);
    expect(client.updateRunOrganization).not.toHaveBeenCalled();
  });

  it("falls back to all projects when the saved project no longer exists", async () => {
    localStorage.setItem("buildwarden:sidebar-run-sections", JSON.stringify({ projectId: "deleted-project" }));
    await mount();
    expect(button("Filter runs by project").textContent).toBe("All projects");
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(3);
  });

  it("applies the default age window only to Uncategorized and remembers the independent older-run toggle", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-02-01T00:00:00.000Z"));
    await mount(null, projects, false, null, 20);
    expect(section("uncategorized").querySelector("button")?.textContent).toBe("Uncategorized (20 days)");
    expect(section("uncategorized").querySelectorAll("[data-test-run]")).toHaveLength(1);
    expect(section("uncategorized").textContent).toContain(running.id);
    expect(section("uncategorized").textContent).not.toContain(old.id);
    expect(section("work").textContent).toContain(failed.id);
    await click(button("Show older runs"));
    expect(section("uncategorized").textContent).toContain(old.id);
    await mount(null, projects, false, null, 20);
    expect(section("uncategorized").textContent).toContain(old.id);
    await click(button("Filter runs"));
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(4);
    const toggle = button("Include older runs");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => { button("All statuses3").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    expect(document.activeElement).toBe(toggle);
    await click(toggle);
    expect(document.activeElement).toBe(button("Filter runs"));
    expect(section("uncategorized").textContent).not.toContain(old.id);
    expect(client.updateRunOrganization).not.toHaveBeenCalled();
  });

  it("offers older runs in an empty section without clearing status, tag, or project filters", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-02-01T00:00:00.000Z"));
    state = { ...state, runs: [{ runId: failed.id, sectionId: null, tags: ["bug"] },
      { runId: old.id, sectionId: null, tags: ["bug"] }] };
    const other = run("other-project-failed", "failed", { projectId: "p2" });
    state.runs.push({ runId: other.id, sectionId: null, tags: ["bug"] });
    const entries = [...projects, { ...projects[0]!, project: { ...projects[0]!.project, id: "p2" }, runs: [other] }];
    localStorage.setItem("buildwarden:sidebar-run-sections", JSON.stringify({ view: "failed", tag: "bug", projectId: "p1" }));
    await mount(null, entries);
    expect(section("uncategorized").querySelectorAll("[data-test-run]")).toHaveLength(0);
    await click(button("Show older runs"));
    expect([...container.querySelectorAll("[data-test-run]")].map((entry) => entry.getAttribute("data-test-run"))).toEqual([failed.id]);
    expect(button("Filter runs").title).toBe("Filter runs: Failed");
    expect(button("Filter runs by tag").title).toBe("Filter runs by tag: #bug");
    expect(button("Filter runs by project").textContent).toBe("Project");
    await click(button("Hide older runs"));
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(0);
  });

  it("uses the configured day count and migrates the old Recent view to the default status filter", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-01-10T00:00:00.000Z"));
    localStorage.setItem("buildwarden:sidebar-run-sections", JSON.stringify({ view: "recent" }));
    await mount();
    expect(button("Filter runs").title).toBe("Filter runs: All statuses");
    expect(section("uncategorized").textContent).not.toContain(old.id);
    await mount(null, projects, false, null, 20);
    expect(section("uncategorized").textContent).toContain("Uncategorized (20 days)");
    expect(section("uncategorized").textContent).toContain(old.id);
  });

  it("ages out inactive runs while the sidebar stays open", async () => {
    const timer = vi.spyOn(window, "setInterval");
    await mount();
    expect(section("uncategorized").textContent).toContain(old.id);
    const tick = timer.mock.calls.find(([, interval]) => interval === 60_000)?.[0];
    expect(typeof tick).toBe("function");
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-01-10T00:00:00.000Z"));
    await act(async () => { if (typeof tick === "function") tick(); });
    expect(section("uncategorized").textContent).not.toContain(old.id);
    expect(section("uncategorized").textContent).toContain(running.id);
    expect(section("work").textContent).toContain(failed.id);
  });

  it("keeps recent unassigned runs in Uncategorized and preserves assignments on rerender", async () => {
    await mount();
    expect(section("uncategorized").textContent).toContain(old.id);
    expect(section("work").textContent).toContain(failed.id);
    expect(section("uncategorized").textContent).not.toContain(failed.id);
    await click(button("Manage Uncategorized section"));
    expect(button("Change color")).toBeDefined();
    expect(button("Remove section")).toBeUndefined();
    expect(button("Move up")).toBeUndefined();
  });

  it("moves a run onto a collapsed empty section and back without invoking pane drops", async () => {
    await mount();
    await click(section("later").querySelector("button")!);
    const { event, transfer } = await drop("later", running.id);
    expect(event.defaultPrevented).toBe(true); expect(transfer.dropEffect).toBe("move");
    expect(client.updateRunOrganization).toHaveBeenCalledWith(running.id, { sectionId: "later" });
    expect(section("later").querySelector(`[data-test-run="${running.id}"]`)).not.toBeNull();
    expect(section("uncategorized").querySelector(`[data-test-run="${running.id}"]`)).toBeNull();
    expect(paneDrop).not.toHaveBeenCalled();
    await drop("uncategorized", running.id);
    expect(client.updateRunOrganization).toHaveBeenLastCalledWith(running.id, { sectionId: null });
    expect(section("uncategorized").textContent).toContain(running.id);
  });

  it("rejects foreign/malformed drags and read-only changes", async () => {
    await mount();
    await drop("work", running.id, "text/plain");
    await drop("work", running.id, RUN_DRAG_MIME_TYPE, "other-project");
    await drop("work", "deleted-run");
    expect(client.updateRunOrganization).not.toHaveBeenCalled();
    client.capabilities.runListVisibilityMutations = false;
    await mount();
    await drop("work", running.id);
    expect(client.updateRunOrganization).not.toHaveBeenCalled();
    expect(button("New run section")).toBeUndefined();
  });

  it("leaves a run in its original section and reports failed persistence", async () => {
    client.updateRunOrganization.mockRejectedValue(new Error("Could not save section"));
    await mount(); await drop("later", failed.id);
    expect(section("work").textContent).toContain(failed.id);
    expect(section("later").textContent).not.toContain(failed.id);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not save section");
  });

  it("filters across sections by execution state and tags without changing assignments", async () => {
    await mount();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await click(button("Filter runs"));
    await click(button("Active1"));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button("Filter runs"));
    expect(button("Filter runs").title).toBe("Filter runs: Active");
    expect(container.querySelector(`[data-test-run="${running.id}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-test-run="${failed.id}"]`)).toBeNull();
    await click(button("Filter runs"));
    expect(button("Active1").getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      button("Active1").focus();
      button("Active1").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(button("Done1"));
    await act(async () => { button("Done1").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button("Filter runs"));
    await click(button("Filter runs"));
    await click(button("Failed1"));
    expect(section("work").textContent).toContain(failed.id);
    await click(button("Filter runs")); await click(button("Done1"));
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(1);
    expect(section("uncategorized").textContent).toContain(old.id);
    await click(button("Filter runs"));
    await click(button("All statuses3"));
    expect(button("#bug")).toBeUndefined();
    await click(button("Filter runs by tag")); await click(button("#bug"));
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button("Filter runs by tag"));
    expect(button("Filter runs by tag").title).toBe("Filter runs by tag: #bug");
    await click(button("Filter runs by tag"));
    expect(button("#bug").getAttribute("aria-checked")).toBe("true");
    await click(button("All tags"));
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(3);
    expect(button("Filter runs by tag").title).toBe("Filter runs by tag: All tags");
    expect(client.updateRunOrganization).not.toHaveBeenCalled();
  });

  it("provides keyboard-accessible move and tag editing without dragging", async () => {
    await mount(failed.id);
    const combo = document.querySelector<HTMLButtonElement>('[aria-label="Run section"]')!;
    await click(combo);
    await click([...document.querySelectorAll<HTMLButtonElement>('dialog [role="option"]')].find((option) => option.textContent?.trim() === "Uncategorized")!);
    const form = document.querySelector<HTMLFormElement>("dialog form")!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(client.updateRunOrganization).toHaveBeenCalledWith(failed.id, { sectionId: null, tags: ["bug"] });
    expect(section("uncategorized").textContent).toContain(failed.id);
  });

  it("blocks saving more than five tags and accepts the five-tag boundary", async () => {
    await mount(failed.id);
    const input = document.querySelector<HTMLInputElement>('[aria-label="Run tags"]')!;
    const enterTags = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await enterTags("one, two, three, four, five, six");
    expect(button("Save run metadata").disabled).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector("dialog [role=alert]")?.textContent).toBe("Use at most 5 tags per run.");
    await act(async () => { document.querySelector("dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(client.updateRunOrganization).not.toHaveBeenCalled();
    await enterTags("one, two, three, four, five");
    await click(button("Save run metadata"));
    expect(client.updateRunOrganization).toHaveBeenCalledWith(failed.id, { sectionId: "work", tags: ["one", "two", "three", "four", "five"] });
  });

  it("creates, renames, reorders and removes sections through their controls", async () => {
    const submitName = async (name: string) => {
      await act(async () => {
        const input = document.querySelector<HTMLInputElement>('[aria-label="Section name"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click(button("Save section"));
    };
    await mount();
    await click(button("New run section")); await click(button("Purple section color")); await submitName("Release");
    expect(client.createRunSection).toHaveBeenCalledWith("Release", "#a78bfa");
    expect(section("created").querySelector("[data-section-color]")?.getAttribute("data-section-color")).toBe("#a78bfa");
    expect(section("created").textContent).toContain("Release");
    await click(button("Manage This week section")); await click(button("Rename section")); await submitName("Current");
    expect(section("work").textContent).toContain("Current");
    await click(button("Manage Current section")); await click(button("Move down"));
    expect([...container.querySelectorAll("[data-run-section]")].map((item) => item.getAttribute("data-run-section")))
      .toEqual(["later", "work", "created", "uncategorized"]);
    await click(button("Manage Current section")); await click(button("Remove section")); await click(button("Remove section"));
    expect(section("work")).toBeNull();
    expect(section("uncategorized").textContent).toContain(failed.id);
    expect(state.runs.find((run) => run.runId === failed.id)?.tags).toEqual(["bug"]);
  });

  it("changes section colors from the options menu and validates custom colors", async () => {
    await mount();
    await click(button("Manage This week section")); await click(button("Change color"));
    await click(button("Yellow section color")); await click(button("Save color"));
    expect(client.setRunSectionColor).toHaveBeenCalledWith("work", "#facc15");
    expect(section("work").querySelector("[data-section-color]")?.getAttribute("data-section-color")).toBe("#facc15");
    await click(button("Manage Uncategorized section")); await click(button("Change color"));
    const enterColor = async (value: string) => act(async () => {
      const input = document.querySelector<HTMLInputElement>('[aria-label="Custom section color"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await enterColor("#123");
    expect(button("Save color").disabled).toBe(true);
    await enterColor("#123456"); await click(button("Save color"));
    expect(client.setRunSectionColor).toHaveBeenLastCalledWith("uncategorized", "#123456");
    expect(section("uncategorized").querySelector("[data-section-color]")?.getAttribute("data-section-color")).toBe("#123456");
  });

  it("keeps the previous color and the picker open when saving fails", async () => {
    client.setRunSectionColor.mockRejectedValueOnce(new Error("Save failed"));
    await mount();
    await click(button("Manage This week section")); await click(button("Change color"));
    await click(button("Red section color")); await click(button("Save color"));
    expect(document.querySelector("dialog [role=alert]")?.textContent).toBe("Save failed");
    expect(section("work").querySelector("[data-section-color]")?.getAttribute("data-section-color")).toBe("#60a5fa");
  });
});

describe("section hierarchy", () => {
  it("uses last user input or creation time, includes the exact cutoff, and ignores completion activity", () => {
    const cutoff = run("cutoff", "completed", { createdAt: "2026-01-12T00:00:00.000Z" });
    const expired = run("expired", "completed", { createdAt: "2026-01-11T23:59:59.999Z", finishedAt: "2026-01-31T00:00:00.000Z" });
    const followedUp = run("followed-up", "completed", { lastUserInputAt: "2026-01-31T00:00:00.000Z" });
    const options = { projects: [{ ...projects[0]!, runs: [cutoff, expired, followedUp, failed] }], organization: initial,
      view: "all" as const, tag: "", hideActiveRuns: false, recentDays: 20, expandedRunIds: new Set<string>(),
      now: Date.parse("2026-02-01T00:00:00.000Z") };
    const sections = buildSidebarRunSections(options);
    const uncategorized = sections.find((section) => section.id === "uncategorized")!;
    expect(uncategorized.flatRows.map(({ row }) => row.run.id)).toEqual([followedUp.id, cutoff.id]);
    expect(uncategorized.hiddenOlderRunCount).toBe(1);
    expect(sections.find((section) => section.id === "work")?.flatRows.map(({ row }) => row.run.id)).toEqual([failed.id]);
    expect(buildSidebarRunSections({ ...options, includeOlderRuns: true }).find((section) => section.id === "uncategorized")?.count).toBe(3);
  });

  it("keeps old active runs visible while respecting Hide active runs and the explicit Active view", () => {
    const options = { projects, organization: initial, view: "all" as const, tag: "", hideActiveRuns: false,
      recentDays: 2, expandedRunIds: new Set<string>(), now: Date.parse("2026-02-01T00:00:00.000Z") };
    const ids = (sections: ReturnType<typeof buildSidebarRunSections>) => sections.flatMap((section) => section.flatRows.map(({ row }) => row.run.id));
    expect(ids(buildSidebarRunSections(options))).toContain(running.id);
    expect(ids(buildSidebarRunSections({ ...options, hideActiveRuns: true }))).not.toContain(running.id);
    expect(ids(buildSidebarRunSections({ ...options, hideActiveRuns: true, view: "active" }))).toEqual([running.id]);
  });

  it("retains an older ancestor for a recent subagent without revealing unrelated old siblings", () => {
    const parent = run("parent", "completed");
    const middle = run("middle", "completed", { kind: "orchestration-task", parentRunId: parent.id, rootRunId: parent.id });
    const child = run("child", "completed", { kind: "orchestration-task", parentRunId: middle.id, rootRunId: parent.id,
      lastUserInputAt: "2026-01-31T00:00:00.000Z" });
    const sibling = run("sibling", "completed", { kind: "orchestration-task", parentRunId: parent.id, rootRunId: parent.id });
    const sections = buildSidebarRunSections({ projects: [{ ...projects[0]!, runs: [parent], orchestratedRuns: [middle, child, sibling] }],
      organization: initial, view: "all", tag: "", hideActiveRuns: false, recentDays: 2,
      expandedRunIds: new Set([parent.id, middle.id]), now: Date.parse("2026-02-01T00:00:00.000Z") });
    const uncategorized = sections.find((section) => section.id === "uncategorized")!;
    expect(uncategorized.flatRows.map(({ row }) => [row.run.id, row.depth])).toEqual([[parent.id, 0], [middle.id, 1], [child.id, 2]]);
    expect(uncategorized.count).toBe(3);
    expect(uncategorized.hiddenOlderRunCount).toBe(1);
  });

  it("places Uncategorized above or below custom sections without changing their order or run assignments", () => {
    const options = { projects, organization: initial, view: "all" as const, tag: "", hideActiveRuns: false,
      recentDays: 2, expandedRunIds: new Set<string>() };
    const below = buildSidebarRunSections(options);
    const above = buildSidebarRunSections({ ...options, uncategorizedFirst: true });
    expect(below.map((section) => section.id)).toEqual([...initial.sections.map((section) => section.id), "uncategorized"]);
    expect(above).toEqual([below.at(-1), ...below.slice(0, -1)]);
    expect(buildSidebarRunSections({ ...options, uncategorizedFirst: false })).toEqual(below);
  });
  const build = (entries: AppSnapshot["projects"], organization = initial) => buildSidebarRunSections({ projects: entries, organization, view: "all", tag: "",
    hideActiveRuns: false, recentDays: 2, expandedRunIds: new Set([running.id]) });
  it("keeps a moved subagent reachable without duplicating it or altering its lineage", () => {
    const child = run("child", "failed", { kind: "orchestration-task", parentRunId: running.id, rootRunId: running.id });
    const grouped = build([{ ...projects[0]!, orchestratedRuns: [child] }], { ...initial, runs: [...initial.runs, { runId: child.id, sectionId: "later", tags: [] }] });
    const rows = grouped.flatMap((item) => item.groups.flatMap((group) => group.rows));
    expect(rows.filter((row) => row.run.id === child.id)).toHaveLength(1);
    expect(grouped.find((item) => item.id === "later")?.groups[0]?.rows[0]?.depth).toBe(0);
    expect(child.parentRunId).toBe(running.id);
  });
  it("keeps For Later runs and their unassigned subagents out of sidebar sections", () => {
    const hidden = { ...running, listVisibility: "for-later" as const };
    const child = run("child", "running", { kind: "orchestration-task", parentRunId: running.id, rootRunId: running.id });
    const grouped = build([{ ...projects[0]!, runs: [failed], forLaterRuns: [hidden], orchestratedRuns: [child] }]);
    expect(grouped.flatMap((item) => item.groups.flatMap((group) => group.rows)).map((row) => row.run.id)).toEqual([failed.id]);
    expect(grouped.reduce((sum, section) => sum + section.count, 0)).toBe(1);
  });

  it("sorts flat sections across projects while keeping expanded children with their parent", () => {
    const child = run("child", "completed", { kind: "orchestration-task", parentRunId: running.id, rootRunId: running.id });
    const newer = run("newer", "completed", { createdAt: "2026-02-01T00:00:00.000Z", projectId: "p2" });
    const grouped = build([{ ...projects[0]!, runs: [running], orchestratedRuns: [child] },
      { ...projects[0]!, project: { ...projects[0]!.project, id: "p2" }, runs: [newer] }]);
    expect(grouped.find((section) => section.id === "uncategorized")?.flatRows.map(({ row }) => row.run.id))
      .toEqual([newer.id, running.id, child.id]);
  });
});
