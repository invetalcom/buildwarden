/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { nextTabForKey } from "./tab-keys";
import { TabList } from "./tabs";

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

describe("nextTabForKey", () => {
  const tabs = ["diff", "terminal", "notes"] as const;

  it("moves with the arrow keys and wraps at both ends", () => {
    expect(nextTabForKey("ArrowRight", tabs, "diff")).toBe("terminal");
    expect(nextTabForKey("ArrowRight", tabs, "notes")).toBe("diff");
    expect(nextTabForKey("ArrowLeft", tabs, "diff")).toBe("notes");
  });

  it("jumps to the first and last tab with Home and End", () => {
    expect(nextTabForKey("Home", tabs, "notes")).toBe("diff");
    expect(nextTabForKey("End", tabs, "diff")).toBe("notes");
  });

  it("ignores other keys and an empty tab list, and starts at the first tab when none is active", () => {
    expect(nextTabForKey("Enter", tabs, "diff")).toBeUndefined();
    expect(nextTabForKey("ArrowRight", [], null)).toBeUndefined();
    expect(nextTabForKey("ArrowRight", tabs, null)).toBe("diff");
  });
});

describe("TabList", () => {
  it("selects the next enabled tab on ArrowRight and keeps only the active tab in the Tab order", async () => {
    const onChange = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <TabList label="Views" value="one" onChange={onChange} items={[{ value: "one", label: "One" }, { value: "two", label: "Two", disabled: true }, { value: "three", label: "Three" }]} />,
    ));
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

    await act(async () => { tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith("three");
  });
});
