/** @vitest-environment happy-dom */
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AnchorDropdownPortal } from "./dropdown-portal";

it("resolves a newly mounted anchor's dialog and focus scope before showing the menu", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const anchorRef = createRef<HTMLButtonElement>();
  const onClose = vi.fn();
  const renderMenu = (open: boolean, scope: string) => (
    <dialog open data-focus-scope-id={scope}>
      <button ref={anchorRef}>Anchor</button>
      <AnchorDropdownPortal open={open} anchorRef={anchorRef} onClose={onClose}>
        <button>Menu item</button>
      </AnchorDropdownPortal>
    </dialog>
  );
  try {
    await act(() => root.render(renderMenu(true, "initial-scope")));
    const dialog = container.querySelector("dialog")!;
    const menu = dialog.querySelector('[data-focus-scope-portal-id="initial-scope"]')!;
    expect(menu.textContent).toBe("Menu item");
    await act(() => menu.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    await act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();

    await act(() => root.render(renderMenu(false, "new-scope")));
    expect(dialog.querySelector("[data-focus-scope-portal-id]")).toBeNull();
    await act(() => root.render(renderMenu(true, "new-scope")));
    expect(dialog.querySelector('[data-focus-scope-portal-id="new-scope"]')?.textContent).toBe("Menu item");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
