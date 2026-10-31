/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { buildDefaultProjectLabSettings, type ProjectSnapshot, type RunRecord } from "@buildwarden/shared";
import { ProjectLabTab } from "./ProjectLabTab";

const mocks = vi.hoisted(() => ({ getProjectLabThreadDetail: vi.fn() }));
vi.mock("../../lib/buildwarden-client", () => ({ useBuildWardenClient: () => client }));
const client = { capabilities: { projectLabMutations: false }, ...mocks };

it("uses refreshed snapshot run data while retaining the cached conversation", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const cachedRun = { id: "old-run", status: "running", branchName: "old-branch" } as RunRecord;
  const thread = { id: "thread", title: "Lab task", summary: "Summary", mode: "new-feature", status: "running",
    createdAt: "2026-10-31", updatedAt: "unchanged" };
  mocks.getProjectLabThreadDetail.mockResolvedValue({ thread, implementationRun: cachedRun,
    events: [{ id: "event", role: "implementation", label: "Implementation", content: "Cached conversation", createdAt: "2026-10-31" }] });
  const container = document.createElement("div");
  const root = createRoot(container);
  const openRun = vi.fn();
  const render = (implementationRun: RunRecord | null) => root.render(<ProjectLabTab
    project={{ project: { id: "project", kind: "git" }, labThreads: [{ thread, eventCount: 1, implementationRun }] } as unknown as ProjectSnapshot}
    modelOptions={[]} settings={buildDefaultProjectLabSettings()} busy={false} branchOptions={[]} selectedBaseBranch="main"
    onBaseBranchChange={vi.fn()} onSettingsChange={vi.fn()} onRunProjectLab={vi.fn()} onDeleteThread={vi.fn()} onOpenImplementationRun={openRun}
  />);
  const toggle = () => (container.querySelector('[role="button"]') as HTMLElement).click();
  try {
    await act(() => render(cachedRun));
    await act(toggle);
    expect(container.textContent).toContain("Cached conversation");
    await act(() => render({ ...cachedRun, id: "current-run", status: "failed", branchName: "current-branch", errorMessage: "Current failure" }));
    expect(mocks.getProjectLabThreadDetail).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Implementation failed");
    expect(container.textContent).toContain("Current failure");
    expect(container.textContent).toContain("current-branch");
    expect(container.textContent).toContain("Cached conversation");
    await act(() => (container.querySelector('[aria-label="Open implementation run"]') as HTMLButtonElement).click());
    expect(openRun).toHaveBeenLastCalledWith("current-run");
    await act(() => render(null));
    expect(container.textContent).toContain("Implementation running");
    await act(toggle);
    expect(container.querySelector('[aria-label="Open implementation run"]')).toBeNull();
  } finally { await act(() => root.unmount()); }
});
