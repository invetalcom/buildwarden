/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunBrowserEvent, RunBrowserPreview, RunEvent } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { RunBrowserPreviewTile } from "./RunBrowserPreviewTile";

const sample: RunBrowserPreview = {
  state: { runId: "r", previewSessionActive: true, activeAction: { callId: "c", action: "click" }, owner: "agent", currentUrl: "http://localhost:4200/", title: "Angular board", loading: false, canGoBack: false, canGoForward: false, inspecting: false, viewport: { width: 1000, height: 700 } },
  thumbnail: { mimeType: "image/jpeg", dataBase64: "cGFnZQ==" },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("browser preview tile", () => {
  it.each(["electron", "web"] as const)("keeps the session between actions on %s and hides on finish or turn completion", async (platform) => {
    const browserListeners = new Set<(event: RunBrowserEvent) => void>();
    const runListeners = new Set<(event: RunEvent) => void>();
    const getPreview = vi.fn<() => Promise<RunBrowserPreview | null>>().mockResolvedValue(null);
    const onOpen = vi.fn();
    const client = {
      capabilities: { platform, browserControl: true }, getRunBrowserPreview: getPreview,
      onRunBrowserEvent: vi.fn((listener) => { browserListeners.add(listener); return () => browserListeners.delete(listener); }),
      onRunEvent: vi.fn((listener) => { runListeners.add(listener); return () => runListeners.delete(listener); }),
    } as unknown as BuildWardenClient;
    const render = (active = true, runId = "r") => root.render(<BuildWardenClientProvider client={client}><RunBrowserPreviewTile runId={runId} active={active} onOpen={onOpen} /></BuildWardenClientProvider>);
    await act(async () => render());
    expect(container.textContent).toBe("");
    getPreview.mockResolvedValue(sample);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(container.textContent).toContain("Browser in use");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,cGFnZQ==");
    await act(async () => container.querySelector("button")!.click());
    expect(onOpen).toHaveBeenCalledOnce();
    getPreview.mockResolvedValue({ ...sample, state: { ...sample.state, activeAction: null } });
    await act(async () => runListeners.forEach((listener) => listener({ runId: "r", type: "tool-result", title: "Browser result", content: "done", createdAt: "now", metadata: { toolName: "buildwarden_browser" } })));
    expect(container.textContent).toContain("Browser session");
    expect(container.querySelector('[class*="animate-pulse"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(container.textContent).toContain("Browser session");
    getPreview.mockResolvedValue(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(container.textContent).toBe("");
    getPreview.mockResolvedValue(sample);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await act(async () => render(false));
    expect(container.textContent).toBe("");
    const callsAtCompletion = getPreview.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(getPreview).toHaveBeenCalledTimes(callsAtCompletion);
    getPreview.mockResolvedValue(null);
    await act(async () => render(true, "other-run"));
    expect(container.textContent).toBe("");
    if (platform === "web") expect(client.onRunBrowserEvent).not.toHaveBeenCalled();
  });

  it("does not restore an in-flight thumbnail after the desktop session ended", async () => {
    let listener!: (event: RunBrowserEvent) => void;
    let resolve!: (value: RunBrowserPreview) => void;
    const client = {
      capabilities: { platform: "electron", browserControl: true },
      getRunBrowserPreview: vi.fn(() => new Promise<RunBrowserPreview>((done) => { resolve = done; })),
      onRunBrowserEvent: (next: typeof listener) => { listener = next; return () => undefined; },
      onRunEvent: () => () => undefined,
    } as unknown as BuildWardenClient;
    await act(async () => root.render(<BuildWardenClientProvider client={client}><RunBrowserPreviewTile runId="r" active onOpen={() => undefined} /></BuildWardenClientProvider>));
    await act(async () => listener({ type: "state", runId: "r", state: sample.state }));
    expect(container.textContent).toContain("Browser in use");
    await act(async () => listener({ type: "state", runId: "r", state: { ...sample.state, activeAction: null, previewSessionActive: false } }));
    await act(async () => resolve(sample));
    expect(container.textContent).toBe("");
  });

  it("keeps the decoded thumbnail until the replacement loads, including through navigation and connection errors", async () => {
    // Happy DOM immediately emits load for data URLs; hold it to exercise a slow decoder.
    let allowImageLoad = false;
    const dispatchEvent = HTMLImageElement.prototype.dispatchEvent;
    vi.spyOn(HTMLImageElement.prototype, "dispatchEvent").mockImplementation(function (this: HTMLImageElement, event) {
      return event.type === "load" && !allowImageLoad ? true : dispatchEvent.call(this, event);
    });
    const getPreview = vi.fn<() => Promise<RunBrowserPreview | null>>().mockResolvedValue(sample);
    const client = { capabilities: { platform: "web", browserControl: true }, getRunBrowserPreview: getPreview, onRunEvent: () => () => undefined } as unknown as BuildWardenClient;
    await act(async () => root.render(<BuildWardenClientProvider client={client}><RunBrowserPreviewTile runId="r" active onOpen={() => undefined} /></BuildWardenClientProvider>));
    const first = container.querySelector("img")!;
    await act(async () => { allowImageLoad = true; first.dispatchEvent(new Event("load")); allowImageLoad = false; });
    expect(first.getAttribute("aria-hidden")).toBe("false");
    getPreview.mockResolvedValue({ state: { ...sample.state, currentUrl: "https://example.com/", activeAction: null }, thumbnail: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(container.querySelector("img")).toBe(first);
    expect(first.getAttribute("aria-hidden")).toBe("false");
    getPreview.mockRejectedValue(new Error("Temporary network error"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(container.querySelector("img")).toBe(first);
    expect(container.textContent).toContain("Reconnecting");
    getPreview.mockResolvedValue({ ...sample, thumbnail: { mimeType: "image/jpeg", dataBase64: "bmV3" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const pending = container.querySelectorAll("img")[1];
    expect(first.isConnected).toBe(true);
    expect(pending.getAttribute("aria-hidden")).toBe("true");
    let finishDecode!: () => void;
    vi.spyOn(pending, "decode").mockImplementation(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
    await act(async () => { allowImageLoad = true; pending.dispatchEvent(new Event("load")); allowImageLoad = false; });
    expect(first.isConnected).toBe(true);
    expect(pending.getAttribute("aria-hidden")).toBe("true");
    await act(async () => finishDecode());
    expect(first.isConnected).toBe(false);
    expect(container.querySelector("img")).toBe(pending);
    expect(pending.getAttribute("aria-hidden")).toBe("false");
    getPreview.mockResolvedValue({ ...sample, thumbnail: { mimeType: "image/jpeg", dataBase64: "broken" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await act(async () => container.querySelectorAll("img")[1].dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBe(pending);
  });
});
