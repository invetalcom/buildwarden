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
  it("closes on a click beside it only when asked to, and never on a click inside", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const onClose = vi.fn();
    await act(async () => root?.render(<ModalDialog title="Form" onClose={onClose}><p>Body</p></ModalDialog>));
    await act(async () => document.querySelector("dialog")!.click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => root?.render(<ModalDialog title="Viewer" onClose={onClose} dismissOnBackdrop><p>Body</p></ModalDialog>));
    await act(async () => document.querySelector<HTMLElement>("dialog p")!.click());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => document.querySelector("dialog")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

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
