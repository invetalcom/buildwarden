import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

const imageMocks = vi.hoisted(() => {
  const resized = { toJPEG: vi.fn(() => Buffer.from("resized-jpeg")) };
  const cropped = {
    getSize: vi.fn(() => ({ width: 344, height: 160 })),
    resize: vi.fn(() => resized),
    toJPEG: vi.fn(() => Buffer.from("cropped-jpeg")),
  };
  const image = {
    getSize: vi.fn(() => ({ width: 2_000, height: 1_000 })),
    crop: vi.fn(() => cropped),
    resize: vi.fn(() => resized),
    toJPEG: vi.fn(() => Buffer.from("original-jpeg")),
  };
  return { cropped, image, resized, createFromBuffer: vi.fn(() => image) };
});

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: imageMocks.createFromBuffer },
}));

import { RunBrowserInspector, isVolatileSelectorToken, sanitizeRunBrowserUrl } from "./run-browser-inspector";
import {
  CALL_RUN_BROWSER_ANNOTATION_MANAGER_SOURCE,
  SHOW_RUN_BROWSER_ANNOTATION_EDITOR_SOURCE,
} from "./run-browser-annotation-overlay";

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
  constructor(private readonly visualViewport?: { clientWidth: number; clientHeight: number }) {
    super();
  }
  sendCommand = vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    this.commands.push({ method, params, sessionId });
    switch (method) {
      case "DOM.resolveNode":
        return { object: { objectId: "node-1" } };
      case "DOM.getFrameOwner":
        return { backendNodeId: 7 };
      case "Runtime.callFunctionOn":
        return { result: { value: PAGE_DATA } };
      case "Accessibility.getPartialAXTree":
        return { nodes: [{ role: { value: "button" }, name: { value: "Save changes" } }] };
      case "Page.captureScreenshot":
        return { data: Buffer.from("source-jpeg").toString("base64") };
      case "Page.getLayoutMetrics":
        return this.visualViewport ? { cssVisualViewport: this.visualViewport } : {};
      default:
        return {};
    }
  });
}

const createInspector = (visualViewport?: { clientWidth: number; clientHeight: number }) => {
  const cdp = new FakeDebugger(visualViewport);
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

const commitPendingAnnotation = async (cdp: FakeDebugger, sessionId?: string, comment = "Match the reference spacing") => {
  let editorCall: FakeDebugger["commands"][number] | undefined;
  await vi.waitFor(() => {
    editorCall = cdp.commands.find(({ method, params, sessionId: commandSessionId }) =>
      method === "Runtime.callFunctionOn" &&
      commandSessionId === sessionId &&
      String(params.functionDeclaration ?? "").includes("manager.open(selectedElement"));
    expect(editorCall).toBeDefined();
  });
  const bindingName = cdp.commands.find(({ method }) => method === "Runtime.addBinding")?.params.name;
  const args = editorCall?.params.arguments as Array<{ value?: unknown }> | undefined;
  const token = args?.[1]?.value;
  expect(typeof bindingName).toBe("string");
  expect(typeof token).toBe("string");
  cdp.emit("message", {}, "Runtime.bindingCalled", {
    name: bindingName,
    payload: JSON.stringify({ type: "commit", token, comment }),
  }, sessionId);
};

describe("browser inspector redaction", () => {
  it("ships syntactically valid isolated annotation functions", () => {
    expect(() => new Script(`(${SHOW_RUN_BROWSER_ANNOTATION_EDITOR_SOURCE})`)).not.toThrow();
    expect(() => new Script(`(${CALL_RUN_BROWSER_ANNOTATION_MANAGER_SOURCE})`)).not.toThrow();
  });

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
      targetInfo: { type: "iframe", targetId: "frame-1", url: "https://frame.example/account?auth=private" },
    });
    await vi.waitFor(() => expect(cdp.commands.some(({ method, sessionId }) => method === "Overlay.enable" && sessionId === "child-1")).toBe(true));
    cdp.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 42 }, "child-1");
    await commitPendingAnnotation(cdp, "child-1");

    await vi.waitFor(() => expect(onSelection).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
    const captureId = onSelection.mock.calls[0]?.[0] as string;
    const capture = inspector.getCapture(captureId);
    expect(capture?.accessibleRole).toBe("button");
    expect(capture?.comment).toBe("Match the reference spacing");
    expect(capture?.annotationNumber).toBe(1);
    const ownerFrame = capture?.locator.segments.find((segment) => segment.kind === "frame");
    expect(ownerFrame).toBeDefined();
    expect(ownerFrame?.selector).not.toContain("frame.example");
    expect(cdp.commands).toContainEqual(expect.objectContaining({
      method: "DOM.getFrameOwner",
      params: { frameId: "frame-1" },
      sessionId: undefined,
    }));
    expect(capture?.url).not.toContain("private");
    expect(capture?.contextAttachment.source).toMatchObject({
      groupId: captureId,
      role: "context",
      annotationNumber: 1,
      comment: "Match the reference spacing",
      tagName: "button",
      accessibleName: "Save changes",
    });
    expect(capture?.screenshotAttachment.source).toMatchObject({ groupId: captureId, role: "screenshot" });
    expect(capture?.screenshotAttachment.dataBase64).toBe(Buffer.from("resized-jpeg").toString("base64"));
    expect(Buffer.from(capture?.contextAttachment.dataBase64 ?? "", "base64").toString("utf8")).toContain("Match the reference spacing");
    expect(imageMocks.image.resize).toHaveBeenCalledWith({ width: 1_600, height: 800, quality: "best" });
    const call = cdp.commands.find(({ method, params }) =>
      method === "Runtime.callFunctionOn" && String(params.functionDeclaration ?? "").includes("timeoutMs: 250"));
    expect(call?.params.functionDeclaration).toContain("timeoutMs: 250");
    expect(call?.params.arguments).toEqual([expect.objectContaining({ value: expect.stringContaining("globalThis.__buildwardenFinder = finder") })]);
    expect(cdp.commands.filter(({ method }) => method === "Overlay.setInspectMode").at(-1)?.params).toMatchObject({ mode: "searchForNode" });
    const currentTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(currentTime + 120_001);
    expect(inspector.getCapture(captureId)).toBeNull();
    now.mockRestore();
  });

  it("crops root-page screenshots around the selected element", async () => {
    const { cdp, inspector, onSelection } = createInspector({ clientWidth: 1_000, clientHeight: 600 });
    await inspector.start();
    cdp.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 42 });
    await commitPendingAnnotation(cdp);

    await vi.waitFor(() => expect(onSelection).toHaveBeenCalledOnce());
    const capture = inspector.getCapture(onSelection.mock.calls[0]?.[0] as string);
    expect(imageMocks.image.crop).toHaveBeenLastCalledWith({ x: 0, y: 13, width: 344, height: 160 });
    expect(capture?.screenshotAttachment.dataBase64).toBe(Buffer.from("cropped-jpeg").toString("base64"));
  });

  it("continues composer numbering and removes the matching page marker", async () => {
    const { cdp, inspector, onSelection } = createInspector();
    await inspector.start(4);
    cdp.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 42 });
    await commitPendingAnnotation(cdp);

    await vi.waitFor(() => expect(onSelection).toHaveBeenCalledOnce());
    const captureId = onSelection.mock.calls[0]?.[0] as string;
    expect(inspector.getCapture(captureId)?.annotationNumber).toBe(4);

    await inspector.removeAnnotation(captureId);
    expect(inspector.getCapture(captureId)).toBeNull();
    expect(cdp.commands).toContainEqual(expect.objectContaining({
      method: "Runtime.releaseObject",
      params: { objectId: "node-1" },
    }));
    expect(cdp.commands.some(({ method, params }) =>
      method === "Runtime.callFunctionOn" &&
      (params.arguments as Array<{ value?: unknown }> | undefined)?.[0]?.value === "remove")).toBe(true);
  });

  it("ignores worker targets and recursively auto-attaches iframe targets", async () => {
    const { cdp, inspector } = createInspector();
    await inspector.start();

    cdp.emit("message", {}, "Target.attachedToTarget", {
      sessionId: "worker-1",
      targetInfo: { type: "worker", url: "https://example.com/worker.js" },
    });
    await Promise.resolve();
    expect(cdp.commands.some(({ sessionId }) => sessionId === "worker-1")).toBe(false);

    cdp.emit("message", {}, "Target.attachedToTarget", {
      sessionId: "child-1",
      targetInfo: { type: "iframe", targetId: "frame-1", url: "https://frame.example" },
    });
    await vi.waitFor(() => expect(cdp.commands.some(({ method, sessionId }) =>
      method === "Target.setAutoAttach" && sessionId === "child-1")).toBe(true));
  });

  it("omits the optional CDP session argument for selections in the root target", async () => {
    const { cdp, inspector, onError, onSelection } = createInspector();
    await inspector.start();
    cdp.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 42 }, "");
    await commitPendingAnnotation(cdp);

    await vi.waitFor(() => expect(onSelection).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
    const rootResolveCall = cdp.sendCommand.mock.calls.find(([method]) => method === "DOM.resolveNode");
    expect(rootResolveCall).toHaveLength(2);
  });

  it("reports debugger detach", async () => {
    const { cdp, inspector, onError } = createInspector();
    await inspector.start();
    cdp.emit("detach", {}, "target closed");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("target closed"), true);
    inspector.dispose();
  });

  it("invalidates captures and inspection state when the main document is replaced", async () => {
    const { cdp, inspector, onInspectingChange, onSelection } = createInspector();
    await inspector.start();
    cdp.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 42 });
    await commitPendingAnnotation(cdp);
    await vi.waitFor(() => expect(onSelection).toHaveBeenCalledOnce());
    const captureId = onSelection.mock.calls[0]?.[0] as string;
    expect(inspector.getCapture(captureId)).not.toBeNull();

    inspector.handleNavigationReplacement();

    expect(inspector.getCapture(captureId)).toBeNull();
    expect(onInspectingChange).toHaveBeenLastCalledWith(false);
  });
});
