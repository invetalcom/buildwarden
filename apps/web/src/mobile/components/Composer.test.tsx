/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("mobile composer attachments", () => {
  it("submits an attachment-only prompt as a base64 payload", async () => {
    let resolveSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => { resolveSubmitted = resolve; });
    const onSubmit = vi.fn(async () => resolveSubmitted());
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });

    await act(async () => root.render(<Composer placeholder="Message" onSubmit={onSubmit} />));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    expect(container.textContent).toContain("hello.txt");
    const send = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.click();
      await submitted;
    });

    expect(onSubmit).toHaveBeenCalledWith("", [{ fileName: "hello.txt", mimeType: "text/plain", dataBase64: "aGVsbG8=" }]);
    expect(container.textContent).not.toContain("hello.txt");
  });
});
