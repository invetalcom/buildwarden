export const MIN_SIDEBAR_WIDTH = 228;
export const MAX_SIDEBAR_WIDTH = 380;
export const DEFAULT_SIDEBAR_WIDTH = 320;

export const clampSidebarWidth = (width: number) =>
  Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));

export const parseSidebarWidthSetting = (raw: string | undefined): number | null => {
  if (!raw?.trim()) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return clampSidebarWidth(parsed);
};
