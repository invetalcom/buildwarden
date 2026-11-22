/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DialogOverlay, DialogSurface } from "./dialog-surface";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  document.querySelector("#opener")?.remove();
  root = null;
  container = null;
});

const open = async (dialog: React.ReactNode) => {
  const opener = document.createElement("button");
  opener.id = "opener";
  document.body.append(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(dialog));
  return opener;
};

const press = (target: Element, shiftKey = false) => act(async () => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
});

describe("DialogOverlay", () => {
  it("moves focus into the dialog, keeps Tab inside it and gives focus back on close", async () => {
    const opener = await open(
      <DialogOverlay>
        <DialogSurface title="Create commit" footer={<><button type="button">Cancel</button><button type="button">Commit</button></>}>
          <input aria-label="Message" />
        </DialogSurface>
      </DialogOverlay>,
    );
    const message = container!.querySelector<HTMLInputElement>('input[aria-label="Message"]')!;
    const commit = [...container!.querySelectorAll("button")].find((button) => button.textContent === "Commit")!;
    expect(document.activeElement).toBe(message);

    commit.focus();
    await press(commit);
    expect(document.activeElement).toBe(message);
    await press(message, true);
    expect(document.activeElement).toBe(commit);

    await act(async () => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
  });

  it("names the dialog by its heading and focuses the dialog itself when it has no controls", async () => {
    await open(<DialogOverlay><DialogSurface title="Working" /></DialogOverlay>);
    const dialog = container!.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Working");
    expect(document.activeElement).toBe(dialog);
  });
});
