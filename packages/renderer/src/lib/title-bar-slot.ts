import { createContext, useContext } from "react";

/**
 * Element in the window title bar, right after the page title, that the open run renders its title
 * actions into. It is only set while the title bar names that run: on platforms without the custom
 * title bar, on other pages and in tests it is null, and the run page then keeps its own title.
 */
export const TitleBarSlotContext = createContext<HTMLElement | null>(null);

export const useTitleBarSlot = (): HTMLElement | null => useContext(TitleBarSlotContext);
