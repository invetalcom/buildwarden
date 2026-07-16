import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

const imageMocks = vi.hoisted(() => {
  const resized = { toJPEG: vi.fn(() => Buffer.from("resized-jpeg")) };
  const image = {
    getSize: vi.fn(() => ({ width: 2_000, height: 1_000 })),
    resize: vi.fn(() => resized),
    toJPEG: vi.fn(() => Buffer.from("original-jpeg")),
  };
  return { image, resized, createFromBuffer: vi.fn(() => image) };
});

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: imageMocks.createFromBuffer },
}));

import { RunBrowserInspector, isVolatileSelectorToken, sanitizeRunBrowserUrl } from "./run-browser-inspector";

const PAGE_DATA = {
  locatorSegments: [
    { kind: "shadow" as const, selector: "app-shell" },
    { kind: "element" as const, selector: "button.save" },
  ],
  fallback: "html > body > app-shell > button:nth-of-type(2)",
  tagName: "button",
  visibleText: "Save changes",
  sanitizedHtml: "<button class=\"save\">Save changes</button>",
  attributes: { class: "save" },
  computedStyles: { display: "inline-block" },
  ancestry: ["body", "app-shell"],
  frameworkHints: [{ framework: "angular" as const, name: "SettingsComponent" }],
  bounds: { x: 20, y: 40, width: 120, height: 32 },
  url: "https://user:pass@example.com/settings?session=private&tab=profile",
  title: "Settings",
};

class FakeDebugger extends EventEmitter {
  attached = false;
  readonly commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  attach = vi.fn(() => {
    this.attached = true;
  });
  detach = vi.fn(() => {
    this.attached = false;
  });
  isAttached = () => this.attached;
  sendCommand = vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    this.commands.push({ method, params, sessionId });
    switch (method) {
      case "DOM.resolveNode":
        return { result: { objectId: "node-1" } };
      case "Runtime.callFunctionOn":
        return { result: { value: PAGE_DATA } };
      case "Accessibility.getPartialAXTree":
        return { nodes: [{ role: { value: "button" }, name: { value: "Save changes" } }] };
      case "Page.captureScreenshot":
        return { data: Buffer.from("source-jpeg").toString("base64") };
      default:
        return {};
    }
  });
}

const createInspector = () => {
  const cdp = new FakeDebugger();
  const webContents = { debugger: cdp, getURL: () => "https://example.com" } as unknown as WebContents;
  const onInspectingChange = vi.fn();
  const onSelection = vi.fn();
  const onError = vi.fn();
  const inspector = new RunBrowserInspector({
    runId: "run-a",
    webContents,
    onInspectingChange,
    onSelection,
    onError,
  });
  return { cdp, inspector, onError, onInspectingChange, onSelection };
};

describe("browser inspector redaction", () => {
  it("removes credentials and redacts sensitive query and fragment values", () => {
    const sanitized = sanitizeRunBrowserUrl("https://user:pass@example.com/path?token=abc&tab=one#session=def&panel=two");
    expect(sanitized).not.toContain("user");
    expect(sanitized).not.toContain("pass");
    expect(sanitized).not.toContain("abc");
    expect(sanitized).not.toContain("def");
    expect(sanitized).toContain("tab=one");
    expect(sanitized).toContain("panel=two");
  });

  it("rejects common generated selector tokens", () => {
    expect(isVolatileSelectorToken("save-button")).toBe(false);
    expect(isVolatileSelectorToken("css-abc1234")).toBe(true);
    expect(isVolatileSelectorToken("9-item")).toBe(true);
    expect(isVolatileSelectorToken("a82f9c304d7710")).toBe(true);
  });
});

describe("RunBrowserInspector", () => {
  it("attaches protocol 1.3, enables domains, and cancels inspect mode", async () => {
    const { cdp, inspector, onInspectingChange } = createInspector();
    await inspector.start();

    expect(cdp.attach).toHaveBeenCalledWith("1.3");
    expect(cdp.commands.map(({ method }) => method)).toEqual(expect.arrayContaining([
      "DOM.enable",
      "Runtime.enable",
      "CSS.enable",
      "Accessibility.enable",
      "Page.enable",
      "Overlay.enable",
      "Target.setAutoAttach",
      "Overlay.setInspectMode",
    ]));
    expect(cdp.commands.find(({ method }) => method === "Target.setAutoAttach")?.params).toMatchObject({ flatten: true });
    expect(onInspectingChange).toHaveBeenLastCalledWith(true);

    await inspector.cancel();
    expect(onInspectingChange).toHaveBeenLastCalledWith(false);
    expect(cdp.commands.filter(({ method }) => method === "Overlay.setInspectMode").at(-1)?.params).toMatchObject({ mode: "none" });
  });

  it("captures a selected backend node with frame context and a bounded JPEG", async () => {
    const { cdp, inspector, onError, onSelection } = createInspector();
    await inspector.start();
    cdp.emit("message", {}, "Target.attachedToTarget", {
      sessionId: "child-1",
      targetInfo: { url: "https://frame.example/account?auth=private" },
    });
    await vi.waitFor(() => expect(cdp.commands.some(({ method, sessionId }) => method === "Overlay.enable" && sessionId === "child-1")).toBe(true));
    cdp.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 42 }, "child-1");

    await vi.waitFor(() => expect(onSelection).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
    const captureId = onSelection.mock.calls[0]?.[0] as string;
    const capture = inspector.getCapture(captureId);
    expect(capture?.accessibleRole).toBe("button");
    expect(capture?.locator.segments[0]).toMatchObject({ kind: "frame" });
    expect(capture?.url).not.toContain("private");
    expect(capture?.contextAttachment.source).toMatchObject({ groupId: captureId, role: "context" });
    expect(capture?.screenshotAttachment.source).toMatchObject({ groupId: captureId, role: "screenshot" });
    expect(capture?.screenshotAttachment.dataBase64).toBe(Buffer.from("resized-jpeg").toString("base64"));
    expect(imageMocks.image.resize).toHaveBeenCalledWith({ width: 1_600, height: 800, quality: "best" });
    const call = cdp.commands.find(({ method }) => method === "Runtime.callFunctionOn");
    expect(call?.params.functionDeclaration).toContain("timeoutMs: 250");
    expect(call?.params.arguments).toEqual([expect.objectContaining({ value: expect.stringContaining("globalThis.__buildwardenFinder = finder") })]);
    const currentTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(currentTime + 120_001);
    expect(inspector.getCapture(captureId)).toBeNull();
    now.mockRestore();
  });

  it("reports debugger detach", async () => {
    const { cdp, inspector, onError } = createInspector();
    await inspector.start();
    cdp.emit("detach", {}, "target closed");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("target closed"), true);
    inspector.dispose();
  });
});
