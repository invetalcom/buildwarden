import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseWindow, BrowserWindow, WebContentsView } from "electron";

vi.mock("electron", () => ({
  BaseWindow: vi.fn(),
  WebContentsView: vi.fn(),
}));

import { HostBrowserService, normalizeRunBrowserUrl, runBrowserPartitionForProject } from "./host-browser-service";
import { RunBrowserInspector } from "./run-browser-inspector";

class FakeNativeImage {
  constructor(
    private readonly bytes: Buffer,
    private readonly width: number,
    private readonly height: number,
  ) {}

  getSize = () => ({ width: this.width, height: this.height });
  resize = ({ width, height }: { width: number; height: number }) => new FakeNativeImage(this.bytes, width, height);
  toJPEG = () => this.bytes;
}

class FakeWebContents extends EventEmitter {
  readonly debugger = Object.assign(new EventEmitter(), { isAttached: () => false });
  currentUrl = "about:blank";
  title = "";
  loading = false;
  closed = false;
  back = false;
  forward = false;
  permissionCheckHandler: (() => boolean) | null = null;
  permissionRequestHandler: ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | null = null;
  windowOpenHandler: ((details: { url: string }) => { action: "deny" }) | null = null;
  readonly session = Object.assign(new EventEmitter(), {
    setPermissionCheckHandler: vi.fn((handler: () => boolean) => {
      this.permissionCheckHandler = handler;
    }),
    setPermissionRequestHandler: vi.fn((handler: typeof this.permissionRequestHandler) => {
      this.permissionRequestHandler = handler;
    }),
  });
  readonly navigationHistory = {
    canGoBack: () => this.back,
    canGoForward: () => this.forward,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  loadURL = vi.fn(async (url: string) => {
    this.currentUrl = url;
  });
  setWindowOpenHandler = vi.fn((handler: typeof this.windowOpenHandler) => {
    this.windowOpenHandler = handler;
  });
  getURL = () => this.currentUrl;
  getTitle = () => this.title;
  isLoading = () => this.loading;
  isDestroyed = () => this.closed;
  reload = vi.fn();
  stop = vi.fn();
  capturePage = vi.fn(async () => new FakeNativeImage(Buffer.from("unchanged-frame"), 2_000, 1_000));
  close = vi.fn(() => {
    this.closed = true;
  });
}

const createView = () => {
  const webContents = new FakeWebContents();
  const view = {
    webContents,
    setBounds: vi.fn(),
    setVisible: vi.fn(),
  };
  return { webContents, view: view as unknown as WebContentsView };
};

const createWindow = () => ({
  setSize: vi.fn(),
  destroyed: false,
  contentView: {
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  },
  isDestroyed() {
    return this.destroyed;
  },
  destroy: vi.fn(),
});

describe("run browser URL and partition policy", () => {
  it("normalizes web addresses and rejects privileged schemes", () => {
    expect(normalizeRunBrowserUrl("example.com/path")).toBe("https://example.com/path");
    expect(normalizeRunBrowserUrl("localhost:4200")).toBe("http://localhost:4200/");
    expect(normalizeRunBrowserUrl("about:blank")).toBe("about:blank");
    expect(() => normalizeRunBrowserUrl("file:///tmp/private.txt")).toThrow(/HTTP and HTTPS/);
    expect(() => normalizeRunBrowserUrl("javascript:alert(1)")).toThrow(/valid HTTP/);
  });

  it("uses a stable, opaque, project-isolated persistent partition", () => {
    const first = runBrowserPartitionForProject("project-a");
    expect(first).toMatch(/^persist:buildwarden-browser-project-[a-f0-9]{24}$/);
    expect(runBrowserPartitionForProject("project-a")).toBe(first);
    expect(runBrowserPartitionForProject("project-b")).not.toBe(first);
    expect(first).not.toContain("project-a");
  });
});

describe("HostBrowserService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("releases the mouse and prevents typing when the user takes control mid-click", async () => {
    const { view } = createView();
    const service = new HostBrowserService({
      getMainWindow: () => null, resolveRunProjectId: async () => "p",
      createView: () => view, createCompositor: () => createWindow() as unknown as BaseWindow,
    });
    service.setAgentActive("r", true);
    await service.executeAgentTool("r", "open", { action: "open", url: "https://example.com" });
    const dispatch = vi.spyOn(RunBrowserInspector.prototype, "dispatchInput").mockImplementation(async (input, assertControl) => {
      assertControl?.();
      if (input.type === "mouse" && input.eventType === "mousePressed") {
        await service.action({ runId: "r", action: "take-control" });
      }
    });
    try {
      const result = await service.executeAgentTool("r", "type", { action: "type", x: 20, y: 30, text: "must not be typed" });
      expect(result).toMatchObject({ ok: false, content: expect.stringContaining("user has browser control") });
      expect(dispatch.mock.calls.map(([input]) => input.type === "mouse" ? input.eventType : input.type))
        .toEqual(["mousePressed", "mouseReleased"]);
      expect(dispatch.mock.calls[1][1]).toBeUndefined();
      // Failure must release the in-flight action lock as well as the button.
      const status = await service.executeAgentTool("r", "status", { action: "status" });
      expect(status.ok).toBe(true);
      expect(JSON.parse(status.content)).toMatchObject({ owner: "human", activeAction: null });
    } finally {
      dispatch.mockRestore();
      service.setAgentActive("r", false);
      service.disposeAll();
    }
  });

  it("validates a resolved target against the viewport after an asynchronous resize", async () => {
    const { view } = createView();
    const service = new HostBrowserService({
      getMainWindow: () => null, resolveRunProjectId: async () => "p",
      createView: () => view, createCompositor: () => createWindow() as unknown as BaseWindow,
    });
    service.setAgentActive("r", true);
    await service.executeAgentTool("r", "open", { action: "open", url: "https://example.com" });
    const target = vi.spyOn(RunBrowserInspector.prototype, "agentTarget").mockImplementation(async () => {
      service.setViewport({ runId: "r", viewport: { width: 100, height: 100 } });
      return { x: 150, y: 50 };
    });
    const dispatch = vi.spyOn(RunBrowserInspector.prototype, "dispatchInput").mockResolvedValue(undefined);
    try {
      const result = await service.executeAgentTool("r", "click", { action: "click", nodeId: 1, snapshotId: "snapshot" });
      expect(result).toMatchObject({ ok: false, content: expect.stringContaining("valid viewport") });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      target.mockRestore();
      dispatch.mockRestore();
      service.disposeAll();
    }
  });

  it("keeps a bounded thumbnail session between actions until finish or turn completion", async () => {
    const { view, webContents } = createView();
    const create = vi.fn(() => view);
    const service = new HostBrowserService({ getMainWindow: () => null, resolveRunProjectId: async () => "p",
      createView: create, createCompositor: () => createWindow() as unknown as BaseWindow });
    expect(await service.getPreview("r")).toBeNull();
    service.setAgentActive("r", true);
    expect(await service.getPreview("r")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    await service.executeAgentTool("r", "open", { action: "open", url: "https://example.com" });
    expect(await service.getPreview("r")).toMatchObject({ state: { previewSessionActive: true, activeAction: null } });
    const waiting = service.executeAgentTool("r", "wait", { action: "wait", milliseconds: 2000 });
    await service.getPreview("r");
    await vi.advanceTimersByTimeAsync(0);
    const preview = await service.getPreview("r");
    expect(preview).toMatchObject({ state: { activeAction: { callId: "wait", action: "wait" }, currentUrl: "https://example.com/", owner: "agent" }, thumbnail: { mimeType: "image/jpeg", dataBase64: Buffer.from("unchanged-frame").toString("base64") } });
    await service.getPreview("r");
    expect(webContents.capturePage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await service.getPreview("r");
    expect(webContents.capturePage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(await service.getPreview("r")).toMatchObject({ state: { previewSessionActive: true, activeAction: null } });
    const cancelled = service.executeAgentTool("r", "wait-again", { action: "wait", milliseconds: 100 });
    await service.action({ runId: "r", action: "take-control" });
    expect(await service.getPreview("r")).toMatchObject({ state: { owner: "human", activeAction: null, previewSessionActive: true } });
    await vi.advanceTimersByTimeAsync(100);
    await cancelled;
    expect((await service.executeAgentTool("r", "finish", { action: "finish" })).ok).toBe(true);
    expect(await service.getPreview("r")).toBeNull();
    expect(webContents.closed).toBe(false);
    await service.executeAgentTool("r", "status", { action: "status" });
    expect(await service.getPreview("r")).toBeNull();
    await service.action({ runId: "r", action: "release-control" });
    await service.executeAgentTool("r", "another-action", { action: "screenshot" });
    expect(await service.getPreview("r")).not.toBeNull();
    service.setAgentActive("r", false);
    expect(await service.getPreview("r")).toBeNull();
    expect(webContents.loadURL).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });

  it("discards previews after cancellation and resets the session for a new turn", async () => {
    const { view, webContents } = createView();
    const service = new HostBrowserService({ getMainWindow: () => null, resolveRunProjectId: async () => "p",
      createView: () => view, createCompositor: () => createWindow() as unknown as BaseWindow });
    service.setAgentActive("r", true);
    await service.executeAgentTool("r", "open", { action: "open", url: "https://example.com" });
    let resolveCapture!: (image: FakeNativeImage) => void;
    webContents.capturePage.mockImplementationOnce(() => new Promise((resolve) => { resolveCapture = resolve; }));
    const waiting = service.executeAgentTool("r", "wait", { action: "wait", milliseconds: 100 });
    await service.getPreview("r");
    service.setAgentActive("r", false);
    resolveCapture(new FakeNativeImage(Buffer.from("stale"), 800, 600));
    expect(await service.getPreview("r")).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    service.setAgentActive("r", true);
    expect(await service.getPreview("r")).toBeNull();
    expect((await service.executeAgentTool("r", "bad", { action: "click" })).ok).toBe(false);
    expect(await service.getPreview("r")).toMatchObject({ state: { activeAction: null, previewSessionActive: true } });
    await service.executeAgentTool("r", "finish", { action: "finish" });
    expect(await service.getPreview("r")).toBeNull();
    service.disposeAll();
  });

  it("retains the previous thumbnail during navigation, failed capture, and pending replacement", async () => {
    const { view, webContents } = createView();
    const service = new HostBrowserService({ getMainWindow: () => null, resolveRunProjectId: async () => "p",
      createView: () => view, createCompositor: () => createWindow() as unknown as BaseWindow });
    service.setAgentActive("r", true);
    await service.executeAgentTool("r", "open", { action: "open", url: "https://example.com" });
    await service.getPreview("r");
    await vi.advanceTimersByTimeAsync(0);
    const original = (await service.getPreview("r"))!.thumbnail;
    expect(original).not.toBeNull();
    await service.executeAgentTool("r", "navigate", { action: "navigate", url: "https://example.org" });
    webContents.capturePage.mockRejectedValueOnce(new Error("Not painted"));
    expect((await service.getPreview("r"))!.thumbnail).toEqual(original);
    await vi.advanceTimersByTimeAsync(0);
    expect((await service.getPreview("r"))!.thumbnail).toEqual(original);
    let resolveCapture!: (image: FakeNativeImage) => void;
    webContents.capturePage.mockImplementationOnce(() => new Promise((resolve) => { resolveCapture = resolve; }));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await service.getPreview("r"))!.thumbnail).toEqual(original);
    resolveCapture(new FakeNativeImage(Buffer.from("next-frame"), 1000, 700));
    await vi.advanceTimersByTimeAsync(0);
    expect((await service.getPreview("r"))!.thumbnail?.dataBase64).toBe(Buffer.from("next-frame").toString("base64"));
    service.disposeAll();
  });

  it("shares the agent browser with the run surface, honors takeover, and pins only active runs", async () => {
    const { view, webContents } = createView();
    const service = new HostBrowserService({
      getMainWindow: () => null, resolveRunProjectId: async () => "project-a",
      createView: () => view, createCompositor: () => createWindow() as unknown as BaseWindow,
      idleTimeoutMs: 30,
    });
    service.setAgentActive("run-a", true);
    const call = (action: string, args = {}) => service.executeAgentTool("run-a", action, { action, ...args });
    expect((await call("open", { url: "http://localhost:3000" })).ok).toBe(true);
    expect((await service.ensure({ runId: "run-a", viewport: { width: 390, height: 600 } })).owner).toBe("agent");
    expect(webContents.loadURL).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(webContents.closed).toBe(false);
    await service.action({ runId: "run-a", action: "take-control" });
    expect((await call("navigate", { url: "https://example.com" })).ok).toBe(false);
    expect(webContents.loadURL).toHaveBeenCalledTimes(1);
    const screenshot = await call("screenshot");
    expect(screenshot.images?.[0].mimeType).toBe("image/jpeg");
    await service.action({ runId: "run-a", action: "release-control" });
    expect((await call("navigate", { url: "https://example.com" })).ok).toBe(true);
    service.setAgentActive("run-a", false);
    expect((await call("open", { url: "https://example.org" })).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(31);
    expect(webContents.closed).toBe(true);
    service.disposeAll();
  });

  it("invalidates an in-flight agent action on takeover without reclaiming control", async () => {
    const { view } = createView();
    const service = new HostBrowserService({ getMainWindow: () => null, resolveRunProjectId: async () => "p",
      createView: () => view, createCompositor: () => createWindow() as unknown as BaseWindow });
    service.setAgentActive("r", true);
    await service.executeAgentTool("r", "open", { action: "open", url: "https://example.com" });
    const waiting = service.executeAgentTool("r", "wait", { action: "wait", milliseconds: 100 });
    await service.action({ runId: "r", action: "take-control" });
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toMatchObject({ ok: false, content: expect.stringContaining("user has browser control") });
    expect((await service.executeAgentTool("r", "status", { action: "status" })).content).toContain('"owner":"human"');
    service.disposeAll();
  });

  it("denies permissions and downloads and reparents the native surface", async () => {
    const main = createWindow();
    const compositor = createWindow();
    const { view, webContents } = createView();
    let partition = "";
    const service = new HostBrowserService({
      getMainWindow: () => main as unknown as BrowserWindow,
      resolveRunProjectId: async () => "project-a",
      createView: (value) => {
        partition = value;
        return view;
      },
      createCompositor: () => compositor as unknown as BaseWindow,
    });

    await service.ensure({ runId: "run-a", initialUrl: "https://example.com", viewport: { width: 800, height: 600 } });
    expect(partition).toBe(runBrowserPartitionForProject("project-a"));
    expect(compositor.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(webContents.permissionCheckHandler?.()).toBe(false);
    const permissionDecision = vi.fn();
    webContents.permissionRequestHandler?.(null, "camera", permissionDecision);
    expect(permissionDecision).toHaveBeenCalledWith(false);
    const cancelDownload = vi.fn();
    webContents.session.emit("will-download", {}, { cancel: cancelDownload });
    expect(cancelDownload).toHaveBeenCalledOnce();

    service.setDesktopSurface({
      runId: "run-a",
      bounds: { x: 12.4, y: 20.6, width: 500.2, height: 300.8 },
      visible: true,
    });
    expect(compositor.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(main.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 12, y: 21, width: 500, height: 301 });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    service.setDesktopWindowVisible(false);
    expect(compositor.contentView.addChildView).toHaveBeenLastCalledWith(view);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    service.setDesktopWindowVisible(true);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    service.detachDesktopSurfaces();
    expect(main.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(compositor.contentView.addChildView).toHaveBeenLastCalledWith(view);
    // The compositor window stays hidden; its child keeps painting remotely.
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("shares one session creation across concurrent ensure calls", async () => {
    const compositor = createWindow();
    const { view } = createView();
    const resolveRunProjectId = vi.fn(async () => "project-a");
    const createViewForSession = vi.fn(() => view);
    const service = new HostBrowserService({
      getMainWindow: () => null,
      resolveRunProjectId,
      createView: createViewForSession,
      createCompositor: () => compositor as unknown as BaseWindow,
    });

    await Promise.all([
      service.ensure({ runId: "run-a", initialUrl: "https://example.com", viewport: { width: 640, height: 480 } }),
      service.ensure({ runId: "run-a", initialUrl: "https://example.com", viewport: { width: 800, height: 600 } }),
    ]);

    expect(resolveRunProjectId).toHaveBeenCalledOnce();
    expect(createViewForSession).toHaveBeenCalledOnce();
    expect(compositor.contentView.addChildView).toHaveBeenCalledOnce();
  });

  it("disposes a failed session creation and allows a retry", async () => {
    const compositor = createWindow();
    const failed = createView();
    const retry = createView();
    failed.webContents.loadURL.mockRejectedValueOnce(new Error("load failed"));
    const createViewForSession = vi.fn()
      .mockReturnValueOnce(failed.view)
      .mockReturnValueOnce(retry.view);
    const service = new HostBrowserService({
      getMainWindow: () => null,
      resolveRunProjectId: async () => "project-a",
      createView: createViewForSession,
      createCompositor: () => compositor as unknown as BaseWindow,
    });

    await expect(service.ensure({ runId: "run-a", initialUrl: "https://example.com", viewport: { width: 640, height: 480 } }))
      .rejects.toThrow("load failed");
    expect(failed.webContents.close).toHaveBeenCalledOnce();

    await expect(service.ensure({ runId: "run-a", initialUrl: "https://example.com", viewport: { width: 640, height: 480 } }))
      .resolves.toEqual(expect.objectContaining({ runId: "run-a" }));
    expect(createViewForSession).toHaveBeenCalledTimes(2);
  });

  it("routes safe popups into the session and blocks unsafe navigation", async () => {
    const compositor = createWindow();
    const { view, webContents } = createView();
    const events: string[] = [];
    const service = new HostBrowserService({
      getMainWindow: () => null,
      resolveRunProjectId: async () => "project-a",
      createView: () => view,
      createCompositor: () => compositor as unknown as BaseWindow,
    });
    service.onEvent((event) => {
      if (event.type === "error") events.push(event.message);
    });
    await service.ensure({ runId: "run-a", viewport: { width: 640, height: 480 } });

    expect(webContents.windowOpenHandler?.({ url: "https://example.com/popup" })).toEqual({ action: "deny" });
    expect(webContents.loadURL).toHaveBeenLastCalledWith("https://example.com/popup");
    const navigationEvent = { url: "file:///private", preventDefault: vi.fn() };
    webContents.emit("will-navigate", navigationEvent);
    expect(navigationEvent.preventDefault).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatch(/HTTP and HTTPS/);
  });

  it("disposes a hidden session after the idle grace period", async () => {
    const compositor = createWindow();
    const { view, webContents } = createView();
    const service = new HostBrowserService({
      getMainWindow: () => null,
      resolveRunProjectId: async () => "project-a",
      idleTimeoutMs: 1_000,
      createView: () => view,
      createCompositor: () => compositor as unknown as BaseWindow,
    });
    await service.ensure({ runId: "run-a", viewport: { width: 640, height: 480 } });

    vi.advanceTimersByTime(1_000);
    expect(webContents.close).toHaveBeenCalledOnce();
    await expect(service.navigate({ runId: "run-a", url: "https://example.com" })).rejects.toThrow(/not open/);
  });

  it("keeps a failed desktop attachment hidden and eligible for idle disposal", async () => {
    const compositor = createWindow();
    const { view, webContents } = createView();
    const service = new HostBrowserService({
      getMainWindow: () => null,
      resolveRunProjectId: async () => "project-a",
      idleTimeoutMs: 1_000,
      createView: () => view,
      createCompositor: () => compositor as unknown as BaseWindow,
    });
    await service.ensure({ runId: "run-a", viewport: { width: 640, height: 480 } });

    expect(() => service.setDesktopSurface({
      runId: "run-a",
      bounds: { x: 0, y: 0, width: 640, height: 480 },
      visible: true,
    })).toThrow(/window is unavailable/);

    vi.advanceTimersByTime(1_000);
    expect(webContents.close).toHaveBeenCalledOnce();
  });

  it("drops stale inspector state and reloads after the target renderer exits", async () => {
    const compositor = createWindow();
    const { view, webContents } = createView();
    const errors: Array<{ message: string; recoverable: boolean }> = [];
    const service = new HostBrowserService({
      getMainWindow: () => null,
      resolveRunProjectId: async () => "project-a",
      createView: () => view,
      createCompositor: () => compositor as unknown as BaseWindow,
    });
    service.onEvent((event) => {
      if (event.type === "error") errors.push(event);
    });
    await service.ensure({ runId: "run-a", viewport: { width: 640, height: 480 } });

    webContents.emit("render-process-gone", {}, { reason: "crashed" });

    expect(webContents.reload).toHaveBeenCalledOnce();
    expect(errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining("crashed"), recoverable: true }));
  });

  it("clears pending remote ownership when a run is deleted", async () => {
    const compositor = createWindow();
    const { view, webContents } = createView();
    const service = new HostBrowserService({
      getMainWindow: () => null,
      resolveRunProjectId: async () => "project-a",
      createView: () => view,
      createCompositor: () => compositor as unknown as BaseWindow,
    });
    service.setRemoteSubscriptions([], ["run-a"]);
    await service.ensure({ runId: "run-a", viewport: { width: 640, height: 480 } });

    service.disposeRun("run-a");

    expect(webContents.close).toHaveBeenCalledOnce();
    await expect(service.navigate({ runId: "run-a", url: "https://example.com" })).rejects.toThrow(/not open/);
  });

  it("streams bounded frames only while a remote run subscriber exists and skips unchanged images", async () => {
    const compositor = createWindow();
    const { view, webContents } = createView();
    const frames: Array<{
      runId: string;
      width: number;
      height: number;
      sequence: number;
      mimeType: "image/jpeg";
      dataBase64: string;
    }> = [];
    const service = new HostBrowserService({
      getMainWindow: () => null,
      resolveRunProjectId: async () => "project-a",
      createView: () => view,
      createCompositor: () => compositor as unknown as BaseWindow,
    });
    service.onEvent((event) => {
      if (event.type === "frame") frames.push(event.frame);
    });

    service.setRemoteSubscriptions([], ["run-a"]);
    await service.ensure({ runId: "run-a", viewport: { width: 2_000, height: 1_000 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(webContents.capturePage).toHaveBeenCalledOnce();
    expect(frames).toEqual([{
      runId: "run-a",
      width: 1_280,
      height: 640,
      sequence: 1,
      mimeType: "image/jpeg",
      dataBase64: Buffer.from("unchanged-frame").toString("base64"),
    }]);

    await vi.advanceTimersByTimeAsync(125);
    expect(webContents.capturePage).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(1);

    service.setRemoteSubscriptions(["run-a"], []);
    await vi.advanceTimersByTimeAsync(500);
    expect(webContents.capturePage).toHaveBeenCalledTimes(2);
  });
});
