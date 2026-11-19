/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopApi, RunWorkspaceLayoutPreference, RunWorkspaceLayoutPreferencesByRunId } from "@buildwarden/shared";
import { cloneDefaultRunWorkspaceLayoutPreference } from "./app-model";
import { useRunWorkspaceLayouts } from "./use-run-workspace-layouts";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
});

const savedLayout = (): RunWorkspaceLayoutPreference => {
  const layout = cloneDefaultRunWorkspaceLayoutPreference();
  return {
    ...layout,
    visiblePanels: { ...layout.visiblePanels, terminal: true },
    tileOrder: [...layout.tileOrder].reverse(),
    tileLayout: { ...layout.tileLayout, activity: { colSpan: 12, rowSpan: 6 } },
    secondaryPanelPosition: "bottom",
  };
};

const renderHook = async (api: Pick<DesktopApi, "listRunWorkspaceLayouts" | "setRunWorkspaceLayout">) => {
  let hook: ReturnType<typeof useRunWorkspaceLayouts> | undefined;
  const Probe = () => {
    hook = useRunWorkspaceLayouts({ buildwarden: api as DesktopApi, selectedRunId: "run-1", setError: vi.fn() });
    return null;
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Probe />));
  return () => hook!;
};

const showDiff = (current: RunWorkspaceLayoutPreference): RunWorkspaceLayoutPreference =>
  ({ ...current, visiblePanels: { ...current.visiblePanels, diff: true } });

describe("useRunWorkspaceLayouts", () => {
  it("applies an edit made before the saved layouts load to the saved layout, not to defaults", async () => {
    let resolveList: (layouts: RunWorkspaceLayoutPreferencesByRunId) => void = () => {};
    const setRunWorkspaceLayout = vi.fn(async () => undefined);
    const hook = await renderHook({
      listRunWorkspaceLayouts: () => new Promise((resolve) => { resolveList = resolve; }),
      setRunWorkspaceLayout,
    });

    await act(async () => hook().updateRunWorkspaceLayout("run-1", showDiff));
    expect(setRunWorkspaceLayout).not.toHaveBeenCalled();
    expect(hook().selectedRunWorkspaceLayout.visiblePanels.diff).toBe(true);

    await act(async () => resolveList({ "run-1": savedLayout() }));

    const expected = showDiff(savedLayout());
    expect(setRunWorkspaceLayout).toHaveBeenCalledExactlyOnceWith("run-1", expected);
    expect(hook().selectedRunWorkspaceLayout).toEqual(expected);
    expect(hook().runWorkspaceShowTerminal).toBe(true);
    expect(hook().runWorkspaceShowDiff).toBe(true);
  });

  it("saves edits immediately once the layouts have loaded", async () => {
    const setRunWorkspaceLayout = vi.fn(async () => undefined);
    const hook = await renderHook({
      listRunWorkspaceLayouts: async () => ({ "run-1": savedLayout() }),
      setRunWorkspaceLayout,
    });

    await act(async () => hook().updateRunWorkspaceLayout("run-1", showDiff));

    expect(setRunWorkspaceLayout).toHaveBeenCalledExactlyOnceWith("run-1", showDiff(savedLayout()));
  });

  it("does not restore or save layouts of runs deleted before the saved layouts load", async () => {
    let resolveList: (layouts: RunWorkspaceLayoutPreferencesByRunId) => void = () => {};
    const setRunWorkspaceLayout = vi.fn(async () => undefined);
    const hook = await renderHook({
      listRunWorkspaceLayouts: () => new Promise((resolve) => { resolveList = resolve; }),
      setRunWorkspaceLayout,
    });

    await act(async () => {
      hook().updateRunWorkspaceLayout("run-1", showDiff);
      hook().updateRunWorkspaceLayout("run-2", showDiff);
      hook().removeRunWorkspaceLayoutsForRuns(["run-1", "run-3"]);
    });
    // Unknown stored layouts are removed too, so remote browsers drop them from storage.
    expect(setRunWorkspaceLayout.mock.calls).toEqual([["run-1", null], ["run-3", null]]);

    await act(async () => resolveList({ "run-1": savedLayout(), "run-2": savedLayout(), "run-3": savedLayout() }));

    expect(Object.keys(hook().runWorkspaceLayoutsByRunId)).toEqual(["run-2"]);
    expect(hook().runWorkspaceLayoutsByRunId["run-2"]).toEqual(showDiff(savedLayout()));
    expect(setRunWorkspaceLayout.mock.calls.slice(2)).toEqual([["run-2", showDiff(savedLayout())]]);
  });

  it("keeps and saves early edits when the saved layouts cannot be loaded", async () => {
    const setRunWorkspaceLayout = vi.fn(async () => undefined);
    let rejectList: (error: Error) => void = () => {};
    const hook = await renderHook({
      listRunWorkspaceLayouts: () => new Promise((_, reject) => { rejectList = reject; }),
      setRunWorkspaceLayout,
    });

    await act(async () => hook().updateRunWorkspaceLayout("run-1", showDiff));
    await act(async () => rejectList(new Error("offline")));

    expect(setRunWorkspaceLayout).toHaveBeenCalledExactlyOnceWith("run-1", showDiff(cloneDefaultRunWorkspaceLayoutPreference()));
  });
});
