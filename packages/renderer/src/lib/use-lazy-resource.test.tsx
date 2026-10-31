/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useLazyResource } from "./use-lazy-resource";

it("defers closed surfaces, rejects stale responses, and retries failures", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  let finishOld!: (value: string) => void;
  const load = vi.fn<() => Promise<string>>()
    .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce("new details");
  let current!: ReturnType<typeof useLazyResource<string>>;
  const Probe = ({ resourceKey, enabled }: { resourceKey: string; enabled: boolean }) => {
    current = useLazyResource(resourceKey, load, enabled);
    return <div>{current.data ?? current.error ?? "Loading"}</div>;
  };
  try {
    await act(() => root.render(<Probe resourceKey="old" enabled={false} />));
    expect(load).not.toHaveBeenCalled();
    await act(() => root.render(<Probe resourceKey="old" enabled />));
    expect(load).toHaveBeenCalledTimes(1);
    await act(() => root.render(<Probe resourceKey="new" enabled />));
    expect(container.textContent).toBe("Offline");
    await act(() => finishOld("stale old details"));
    expect(container.textContent).toBe("Offline");
    await act(() => current.retry());
    expect(container.textContent).toBe("new details");
    await act(() => root.render(<Probe resourceKey="new" enabled />));
    expect(load).toHaveBeenCalledTimes(3);
  } finally {
    await act(() => root.unmount());
  }
});
