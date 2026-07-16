import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseWindow, BrowserWindow, WebContentsView } from "electron";

vi.mock("electron", () => ({
  BaseWindow: vi.fn(),
  WebContentsView: vi.fn(),
}));

import { HostBrowserService, normalizeRunBrowserUrl, runBrowserPartitionForProject } from "./host-browser-service";

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
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    service.setDesktopWindowVisible(true);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
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
