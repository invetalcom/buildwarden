/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DesignColorField } from "./DesignColorField";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const render = async (props: Partial<Parameters<typeof DesignColorField>[0]> = {}) => {
  const onChange = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<DesignColorField label="Card text" value="#112233" disabled={false} fallbackNote="default" onChange={onChange} {...props} />));
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Card text"]')!;
  return { input, onChange };
};

const type = async (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const leave = (input: HTMLInputElement) => act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });

describe("DesignColorField", () => {
  it("passes a complete color on and keeps an unfinished one to itself", async () => {
    const { input, onChange } = await render();
    await type(input, "#11223");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();

    await type(input, "#AABBCC");
    expect(onChange).toHaveBeenCalledWith("#aabbcc");
  });

  it("takes eight-digit colors, except where a setting has no transparency", async () => {
    const translucent = await render();
    await type(translucent.input, "#112233cc");
    expect(translucent.onChange).toHaveBeenCalledWith("#112233cc");
    await act(async () => root?.unmount());
    container?.remove();

    const opaque = await render({ opaque: true });
    expect(opaque.input.maxLength).toBe(7);
    await type(opaque.input, "#112233cc");
    expect(opaque.input.getAttribute("aria-invalid")).toBe("true");
    expect(opaque.onChange).not.toHaveBeenCalled();
    await type(opaque.input, "#445566");
    expect(opaque.onChange).toHaveBeenCalledWith("#445566");
  });

  it("shows the color in effect again when the field is left with an unfinished color", async () => {
    const { input, onChange } = await render();
    await type(input, "#11223");
    await leave(input);
    expect(input.value).toBe("#112233");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  });
});
