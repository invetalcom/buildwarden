/** @vitest-environment happy-dom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot, RunOrganizationSnapshot, RunRecord, UpdateRunOrganizationInput } from "@buildwarden/shared";
import { SidebarRunSections } from "./SidebarRunSections";
import { RUN_DRAG_MIME_TYPE } from "./app-model";
import { buildSidebarRunSections } from "./sidebar-run-sections";

const client = { capabilities: { runListVisibilityMutations: true }, updateRunOrganization: vi.fn(), createRunSection: vi.fn(),
  renameRunSection: vi.fn(), deleteRunSection: vi.fn(), reorderRunSections: vi.fn() };
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
  client.capabilities.runListVisibilityMutations = true;
  client.createRunSection.mockImplementation(async (name: string) => {
    state = { ...state, sections: [...state.sections, { id: "created", name, position: state.sections.length }] };
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
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const mount = async (organizeRunId: string | null = null, entries = projects, grouped = false) => {
  const Harness = () => {
    const [organization, setOrganization] = useState(state);
    const [editor, setEditor] = useState(organizeRunId);
    return <div onDrop={paneDrop}><SidebarRunSections projects={entries} organization={organization} onOrganizationChange={setOrganization}
      recentRunDays={2} hideActiveRuns={false} groupRunsByProject={grouped} expandedRunIds={new Set()} highlightedRunId={null}
      organizeRunId={editor} onCloseOrganizer={() => setEditor(null)} renderRun={(_, row) => <button key={row.run.id} data-test-run={row.run.id}>{row.run.prompt}</button>} /></div>;
  };
  await act(async () => root.render(<Harness />));
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
  it.each([false, true])("filters projects together with status and remembers the selection (grouped: %s)", async (grouped) => {
    const other = run("other-run", "failed", { projectId: "p2" });
    const entries = [...projects, { ...projects[0]!, project: { ...projects[0]!.project, id: "p2", name: "Other project" }, runs: [other] }];
    await mount(null, entries, grouped);
    await click(button("Filter runs by project")); await click(button("Other project"));
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(1);
    expect(section("uncategorized").textContent).toContain(other.id);
    await click(button("Filter runs"));
    expect(button("All1")).toBeDefined();
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

  it("keeps old/new unassigned runs in Uncategorized and preserves assignments on rerender", async () => {
    await mount();
    expect(section("uncategorized").textContent).toContain(old.id);
    expect(section("work").textContent).toContain(failed.id);
    expect(section("uncategorized").textContent).not.toContain(failed.id);
    expect(button("Manage Uncategorized section")).toBeUndefined();
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
    await click(button("All3")); await click(button("#bug"));
    expect(container.querySelectorAll("[data-test-run]")).toHaveLength(1);
    expect(client.updateRunOrganization).not.toHaveBeenCalled();
  });

  it("provides keyboard-accessible move and tag editing without dragging", async () => {
    await mount(failed.id);
    const combo = document.querySelector<HTMLButtonElement>('[aria-label="Run section"]')!;
    await click(combo);
    await click(button("Uncategorized"));
    const form = document.querySelector<HTMLFormElement>("dialog form")!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(client.updateRunOrganization).toHaveBeenCalledWith(failed.id, { sectionId: null, tags: ["bug"] });
    expect(section("uncategorized").textContent).toContain(failed.id);
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
    await click(button("New run section")); await submitName("Release");
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
});

describe("section hierarchy", () => {
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
