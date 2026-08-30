/** @vitest-environment happy-dom */

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Slider } from "./slider";

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

const mount = async (element: ReactNode) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
};

describe("Slider", () => {
  it("optionally exposes a manual value input and clamps commits to its explicit bounds", async () => {
    const onCommit = vi.fn();
    const Harness = () => {
      const [value, setValue] = useState(20);
      return <Slider value={value} min={10} max={80} step={5} allowManualInput valueSuffix="%" onValueChange={setValue} onValueCommit={onCommit} aria-label="Strength" />;
    };
    await mount(<Harness />);

    const range = container!.querySelector<HTMLInputElement>('input[type="range"]')!;
    const manual = container!.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(range.min).toBe("10");
    expect(range.max).toBe("80");
    expect(manual.min).toBe("10");
    expect(manual.max).toBe("80");

    await act(async () => {
      manual.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(manual, "99");
      manual.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      manual.blur();
    });

    expect(onCommit).toHaveBeenLastCalledWith(80);
    expect(manual.value).toBe("80");
  });

  it("renders a read-only value by default", async () => {
    await mount(<Slider value={25} valueSuffix="%" onValueChange={() => undefined} />);
    expect(container!.querySelector('input[type="number"]')).toBeNull();
    expect(container!.querySelector("output")?.textContent).toBe("25%");
  });
});
