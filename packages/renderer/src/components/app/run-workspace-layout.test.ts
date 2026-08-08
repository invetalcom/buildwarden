import { describe, expect, it } from "vitest";
import { parseRunWorkspaceLayoutsSetting } from "@buildwarden/shared";
import {
  DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE,
  DEFAULT_TILE_LAYOUT,
  DEFAULT_TILE_ORDER,
  resolveRunWorkspacePanelVisibility,
  shouldAutoOpenAgentsPanel,
} from "./run-workspace-layout";

describe("run workspace layout defaults", () => {
  it("covers every panel including agents and the run chat", () => {
    expect(DEFAULT_TILE_ORDER).toContain("agents");
    expect(DEFAULT_TILE_LAYOUT.agents).toBeDefined();
    expect(DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.visiblePanels.agents).toBe(false);
    expect(DEFAULT_TILE_ORDER).toContain("chat");
    expect(DEFAULT_TILE_LAYOUT.chat).toBeDefined();
    expect(DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.visiblePanels.chat).toBe(false);
  });

  it("excludes unavailable panels and falls back to activity", () => {
    expect(resolveRunWorkspacePanelVisibility({
      activity: false,
      agents: false,
      diff: false,
      terminal: true,
      browser: true,
      notes: true,
      chat: true,
      "pull-request": false,
    }, {
      platform: "web",
      embeddedTerminal: false,
      chatMutations: false,
    })).toEqual({
      activity: true,
      agents: false,
      diff: false,
      terminal: false,
      browser: false,
      notes: false,
      chat: false,
      "pull-request": false,
    });
  });

  it("preserves available panel selections without forcing activity", () => {
    expect(resolveRunWorkspacePanelVisibility({
      activity: false,
      agents: false,
      diff: true,
      terminal: false,
      browser: false,
      notes: false,
      chat: false,
      "pull-request": false,
    }, {
      platform: "web",
      embeddedTerminal: false,
      chatMutations: false,
    }).activity).toBe(false);
  });

  it("opens Agents only when the first durable task appears in the same run", () => {
    const empty = { runId: "run-1", taskCount: 0 };
    expect(shouldAutoOpenAgentsPanel(empty, {
      runId: "run-1",
      taskCount: 1,
      visible: false,
    })).toBe(true);
    expect(shouldAutoOpenAgentsPanel({ runId: "run-1", taskCount: 1 }, {
      runId: "run-1",
      taskCount: 2,
      visible: false,
    })).toBe(false);
    expect(shouldAutoOpenAgentsPanel(empty, {
      runId: "run-2",
      taskCount: 1,
      visible: false,
    })).toBe(false);
    expect(shouldAutoOpenAgentsPanel(empty, {
      runId: "run-1",
      taskCount: 1,
      visible: true,
    })).toBe(false);
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
    expect(layout!.visiblePanels.agents).toBe(false);
    expect(layout!.visiblePanels.chat).toBe(false);
    expect(layout!.tileOrder).toContain("agents");
    expect(layout!.tileOrder).toContain("chat");
    expect(layout!.tileLayout.agents).toEqual({ colSpan: 5, rowSpan: 4 });
    expect(layout!.tileLayout.chat).toEqual({ colSpan: 5, rowSpan: 3 });
  });
});
