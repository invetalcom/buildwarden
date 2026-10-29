/** @vitest-environment happy-dom */
import { act, startTransition, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useLatestRef } from "./use-latest-ref";

it("keeps event handlers on the committed value while a new render is suspended", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const onRead = vi.fn();
  const pending = new Promise<void>(() => {});
  const Reader = ({ value, suspend = false }: { value: string; suspend?: boolean }) => {
    const latest = useLatestRef(value);
    if (suspend) throw pending;
    return <button onClick={() => onRead(latest.current)}>{value}</button>;
  };
  try {
    await act(() => root.render(<Suspense fallback="Loading"><Reader value="committed" /></Suspense>));
    await act(() => startTransition(() => {
      root.render(<Suspense fallback="Loading"><Reader value="uncommitted" suspend /></Suspense>);
    }));
    expect(container.textContent).toBe("committed");
    container.querySelector("button")!.click();
    expect(onRead).toHaveBeenLastCalledWith("committed");

    await act(() => root.render(<Suspense fallback="Loading"><Reader value="next" /></Suspense>));
    container.querySelector("button")!.click();
    expect(onRead).toHaveBeenLastCalledWith("next");
  } finally {
    await act(() => root.unmount());
  }
});
