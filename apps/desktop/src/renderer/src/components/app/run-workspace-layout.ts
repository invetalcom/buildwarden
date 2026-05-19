import type { RunWorkspaceLayoutPreference, RunWorkspacePanelId, RunWorkspaceTileSize } from "@easycode/shared";

type TilePanelId = RunWorkspacePanelId;

type TileLayoutState = Record<TilePanelId, RunWorkspaceTileSize>;

export const DEFAULT_TILE_ORDER: TilePanelId[] = ["activity", "diff", "terminal", "browser"];

export const DEFAULT_TILE_LAYOUT: TileLayoutState = {
  activity: { colSpan: 7, rowSpan: 4 },
  diff: { colSpan: 5, rowSpan: 4 },
  terminal: { colSpan: 5, rowSpan: 3 },
  browser: { colSpan: 7, rowSpan: 3 },
};

export const DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE: RunWorkspaceLayoutPreference = {
  visiblePanels: {
    activity: true,
    diff: false,
    terminal: false,
    browser: false,
  },
  tileOrder: DEFAULT_TILE_ORDER,
  tileLayout: DEFAULT_TILE_LAYOUT,
  secondaryPanelPosition: "right",
};
