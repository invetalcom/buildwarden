/** @vitest-environment happy-dom */
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useJsonStableValue, useShallowStableValue, useStableFunctionProps } from "./use-stable-function-props";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
});

const mount = () => {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  return mounted;
};

describe("useStableFunctionProps", () => {
  it("lets a memoized child skip renders caused by new inline handlers and calls the latest handler", async () => {
    const childRender = vi.fn();
    let latestOnPick: ((value: string) => void) | undefined;
    const Child = memo((props: { label: string; onPick: (value: string) => void }) => {
      childRender(props.label);
      latestOnPick = props.onPick;
      return null;
    });
    const Parent = ({ label, onPick }: { label: string; onPick: (value: string) => void }) => {
      const stable = useStableFunctionProps({ label, onPick });
      return <Child {...stable} />;
    };
    const mounted = mount();
    const first = vi.fn();
    const second = vi.fn();

    await act(async () => mounted.render(<Parent label="a" onPick={first} />));
    await act(async () => mounted.render(<Parent label="a" onPick={second} />));
    expect(childRender).toHaveBeenCalledTimes(1);

    latestOnPick?.("x");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("x");

    await act(async () => mounted.render(<Parent label="b" onPick={second} />));
    expect(childRender).toHaveBeenCalledTimes(2);
  });
});

describe("value stabilizers", () => {
  it("keep the previous identity for equal values", async () => {
    const seen: unknown[] = [];
    const Probe = ({ usage, options }: { usage: { input: number }; options: { id: string }[] }) => {
      seen.push(useShallowStableValue(usage), useJsonStableValue(options));
      return null;
    };
    const mounted = mount();

    await act(async () => mounted.render(<Probe usage={{ input: 1 }} options={[{ id: "m" }]} />));
    await act(async () => mounted.render(<Probe usage={{ input: 1 }} options={[{ id: "m" }]} />));
    expect(seen[2]).toBe(seen[0]);
    expect(seen[3]).toBe(seen[1]);

    await act(async () => mounted.render(<Probe usage={{ input: 2 }} options={[{ id: "n" }]} />));
    expect(seen[4]).toEqual({ input: 2 });
    expect(seen[5]).toEqual([{ id: "n" }]);
  });
});
