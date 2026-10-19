/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunBrowserEvent, RunBrowserState } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { RunEmbeddedBrowser } from "./RunEmbeddedBrowser";

let root: Root;
let container: HTMLDivElement;
const frames = new Map<number, FrameRequestCallback>();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const flushFrames = () => {
  const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0));
};

it("batches touch scrolling per frame without scrolling taps or element inspection", async () => {
  const listeners = new Set<(event: RunBrowserEvent) => void>();
  const state: RunBrowserState = { runId: "r", currentUrl: "about:blank", title: "", loading: false, canGoBack: false, canGoForward: false, inspecting: false, viewport: { width: 400, height: 600 } };
  const sendRunBrowserInput = vi.fn(async () => undefined);
  const client = {
    capabilities: { platform: "web", browserControl: true },
    onRunBrowserEvent: (listener: (event: RunBrowserEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    ensureRunBrowser: vi.fn(async () => state), setRunBrowserViewport: vi.fn(async () => undefined), sendRunBrowserInput,
  } as unknown as BuildWardenClient;
  await act(async () => root.render(<BuildWardenClientProvider client={client}><RunEmbeddedBrowser runId="r"
    session={{ currentUrl: "about:blank", draftUrl: "about:blank", history: ["about:blank"], historyIndex: 0, reloadKey: 0 }} onSessionChange={vi.fn()} /></BuildWardenClientProvider>));
  const canvas = container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 600));
  await act(async () => {
    listeners.forEach((listener) => listener({ type: "frame", runId: "r", frame: { runId: "r", sequence: 1, width: 400, height: 600, mimeType: "image/jpeg", dataBase64: "" } }));
    flushFrames();
  });
  const touch = (type: string, y: number) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: "touch", clientX: 100, clientY: y }));
  await act(async () => { touch("pointerdown", 200); touch("pointermove", 196); flushFrames(); });
  expect(sendRunBrowserInput).not.toHaveBeenCalled();
  await act(async () => { touch("pointermove", 180); touch("pointermove", 160); touch("pointerup", 160); });
  expect(sendRunBrowserInput).not.toHaveBeenCalled();
  await act(async () => flushFrames());
  expect(sendRunBrowserInput).toHaveBeenCalledExactlyOnceWith({ runId: "r", input: { type: "wheel", x: 100, y: 160, deltaX: 0, deltaY: 36, modifiers: 0 } });

  sendRunBrowserInput.mockClear();
  await act(async () => { touch("pointerdown", 200); touch("pointerup", 200); flushFrames(); });
  expect(sendRunBrowserInput.mock.calls).toHaveLength(2);
  expect(sendRunBrowserInput).toHaveBeenLastCalledWith({ runId: "r", input: { type: "mouse", eventType: "mouseReleased", x: 100, y: 200, button: "left", clickCount: 1 } });

  sendRunBrowserInput.mockClear();
  await act(async () => listeners.forEach((listener) => listener({ type: "state", runId: "r", state: { ...state, inspecting: true } })));
  await act(async () => { touch("pointerdown", 200); touch("pointermove", 160); touch("pointerup", 160); flushFrames(); });
  expect(sendRunBrowserInput).not.toHaveBeenCalled();
});
