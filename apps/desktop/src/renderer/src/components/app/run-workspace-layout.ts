import type { RunWorkspaceLayoutPreference, RunWorkspacePanelId, RunWorkspaceTileSize } from "@buildwarden/shared";

type TilePanelId = RunWorkspacePanelId;

type TileLayoutState = Record<TilePanelId, RunWorkspaceTileSize>;

export interface RunWorkspacePanelCapabilities {
  embeddedTerminal: boolean;
  chatMutations: boolean;
  platform: "electron" | "web";
}

export const DEFAULT_TILE_ORDER: TilePanelId[] = ["activity", "diff", "terminal", "browser", "notes", "chat"];

export const DEFAULT_TILE_LAYOUT: TileLayoutState = {
  activity: { colSpan: 7, rowSpan: 4 },
  diff: { colSpan: 5, rowSpan: 4 },
  terminal: { colSpan: 5, rowSpan: 3 },
  browser: { colSpan: 7, rowSpan: 3 },
  notes: { colSpan: 5, rowSpan: 3 },
  chat: { colSpan: 5, rowSpan: 3 },
};

export const DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE: RunWorkspaceLayoutPreference = {
  visiblePanels: {
    activity: true,
    diff: false,
    terminal: false,
    browser: false,
    notes: false,
    chat: false,
  },
  tileOrder: DEFAULT_TILE_ORDER,
  tileLayout: DEFAULT_TILE_LAYOUT,
  secondaryPanelPosition: "right",
};

export const isRunWorkspacePanelAvailable = (
  panelId: RunWorkspacePanelId,
  capabilities: RunWorkspacePanelCapabilities,
): boolean => {
  if (panelId === "terminal") return capabilities.embeddedTerminal;
  if (panelId === "browser" || panelId === "notes") return capabilities.platform === "electron";
  if (panelId === "chat") return capabilities.chatMutations;
  return true;
};

export const resolveRunWorkspacePanelVisibility = (
  visibility: Record<RunWorkspacePanelId, boolean>,
  capabilities: RunWorkspacePanelCapabilities,
): Record<RunWorkspacePanelId, boolean> => {
  const resolved = Object.fromEntries(
    DEFAULT_TILE_ORDER.map((panelId) => [panelId, visibility[panelId] && isRunWorkspacePanelAvailable(panelId, capabilities)]),
  ) as Record<RunWorkspacePanelId, boolean>;

  if (!Object.values(resolved).some(Boolean)) resolved.activity = true;
  return resolved;
};
