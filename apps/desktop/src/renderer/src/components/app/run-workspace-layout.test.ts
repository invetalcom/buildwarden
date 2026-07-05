import { describe, expect, it } from "vitest";
import { parseRunWorkspaceLayoutsSetting } from "@buildwarden/shared";
import { DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE, DEFAULT_TILE_LAYOUT, DEFAULT_TILE_ORDER } from "./run-workspace-layout";

describe("run workspace layout defaults", () => {
  it("covers every panel including the run chat", () => {
    expect(DEFAULT_TILE_ORDER).toContain("chat");
    expect(DEFAULT_TILE_LAYOUT.chat).toBeDefined();
    expect(DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.visiblePanels.chat).toBe(false);
  });
});

describe("parseRunWorkspaceLayoutsSetting back-compat", () => {
  it("accepts layouts persisted before the chat panel existed", () => {
    // Shape written by versions where panels were activity/diff/terminal/browser/notes only.
    const legacy = JSON.stringify({
      "run-1": {
        visiblePanels: { activity: true, diff: true, terminal: false, browser: false, notes: false },
        tileOrder: ["activity", "diff", "terminal", "browser", "notes"],
        tileLayout: {
          activity: { colSpan: 7, rowSpan: 4 },
          diff: { colSpan: 5, rowSpan: 4 },
          terminal: { colSpan: 5, rowSpan: 3 },
          browser: { colSpan: 7, rowSpan: 3 },
          notes: { colSpan: 5, rowSpan: 3 },
        },
        secondaryPanelPosition: "right",
      },
    });

    const parsed = parseRunWorkspaceLayoutsSetting(legacy);
    const layout = parsed["run-1"];
    expect(layout).toBeDefined();
    expect(layout!.visiblePanels.diff).toBe(true);
    expect(layout!.visiblePanels.chat).toBe(false);
    expect(layout!.tileOrder).toContain("chat");
    expect(layout!.tileLayout.chat).toEqual({ colSpan: 5, rowSpan: 3 });
  });
});
