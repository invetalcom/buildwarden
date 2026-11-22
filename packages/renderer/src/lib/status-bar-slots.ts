import { createContext, useContext } from "react";

/**
 * The status bar is one line at the bottom of the window. Its left half describes the workspace of
 * the open run, its right half the session and the app. The data for the run-scoped segments lives
 * deep inside the run page and the composer, so those components render their segment into a slot
 * of the bar through a portal instead of passing state up through the app.
 */
export type StatusBarSlot = "workspace" | "session";

export type StatusBarSlots = Record<StatusBarSlot, HTMLElement | null>;

export const StatusBarSlotsContext = createContext<StatusBarSlots | null>(null);

/** Whether a status bar is mounted, for components that only change shape when it is. */
export const useHasStatusBar = (): boolean => useContext(StatusBarSlotsContext) !== null;
