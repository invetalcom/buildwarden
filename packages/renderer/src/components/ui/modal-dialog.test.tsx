/** @vitest-environment happy-dom */

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModalDialog } from "./modal-dialog";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ModalDialog", () => {
  it("returns focus to the fallback when the opener is gone and focus sits on the body", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const fallbackRef = createRef<HTMLButtonElement>();
    const renderWithDialog = (open: boolean) =>
      root?.render(
        <>
          <button ref={fallbackRef} type="button">New branch</button>
          {open ? (
            <ModalDialog title="Rename" onClose={vi.fn()} fallbackFocusRef={fallbackRef}>
              <p>Body</p>
            </ModalDialog>
          ) : null}
        </>,
      );
    await act(async () => renderWithDialog(false));
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    await act(async () => renderWithDialog(true));
    await act(async () => renderWithDialog(false));

    expect(document.activeElement).toBe(fallbackRef.current);
  });
});
