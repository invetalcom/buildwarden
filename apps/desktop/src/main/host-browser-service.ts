import { createHash } from "node:crypto";
import { BaseWindow, WebContentsView, type BrowserWindow, type Rectangle } from "electron";
import type {
  EnsureRunBrowserInput,
  NavigateRunBrowserInput,
  RunBrowserActionInput,
  RunBrowserEvent,
  RunBrowserElementCapture,
  RunBrowserState,
  RunBrowserViewport,
  SetRunBrowserDesktopSurfaceInput,
  SetRunBrowserViewportInput,
  GetRunBrowserElementCaptureInput,
} from "@buildwarden/shared";
import { logWarn } from "./logger";
import { RunBrowserInspector } from "./run-browser-inspector";

const DEFAULT_BROWSER_URL = "about:blank";
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MIN_VIEWPORT_EDGE = 1;
const MAX_VIEWPORT_EDGE = 4_096;

type SessionParent = "main" | "compositor" | null;

type HostBrowserSession = {
  runId: string;
  projectId: string;
  view: WebContentsView;
  viewport: RunBrowserViewport;
  inspecting: boolean;
  desktopVisible: boolean;
  parent: SessionParent;
  idleTimer: ReturnType<typeof setTimeout> | null;
  inspector: RunBrowserInspector | null;
};

export interface HostBrowserServiceOptions {
  getMainWindow: () => BrowserWindow | null;
  resolveRunProjectId: (runId: string) => Promise<string>;
  idleTimeoutMs?: number;
  createView?: (partition: string) => WebContentsView;
  createCompositor?: () => BaseWindow;
}

export const normalizeRunBrowserUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Enter a URL.");
  }
  if (trimmed === DEFAULT_BROWSER_URL) {
    return trimmed;
  }
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : /^(localhost|127(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error("Enter a valid HTTP(S) URL or localhost address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS pages can be opened in the run browser.");
  }
  return url.toString();
};

export const runBrowserPartitionForProject = (projectId: string): string => {
  const digest = createHash("sha256").update(projectId).digest("hex").slice(0, 24);
  return `persist:buildwarden-browser-project-${digest}`;
};

const normalizeViewport = (viewport: RunBrowserViewport): RunBrowserViewport => ({
  width: Math.min(MAX_VIEWPORT_EDGE, Math.max(MIN_VIEWPORT_EDGE, Math.round(viewport.width))),
  height: Math.min(MAX_VIEWPORT_EDGE, Math.max(MIN_VIEWPORT_EDGE, Math.round(viewport.height))),
  ...(Number.isFinite(viewport.deviceScaleFactor) && Number(viewport.deviceScaleFactor) > 0
    ? { deviceScaleFactor: Math.min(4, Math.max(0.5, Number(viewport.deviceScaleFactor))) }
    : {}),
});

const viewportBounds = (viewport: RunBrowserViewport): Rectangle => ({
  x: 0,
  y: 0,
  width: viewport.width,
  height: viewport.height,
});

export class HostBrowserService {
  private readonly sessions = new Map<string, HostBrowserSession>();
  private readonly listeners = new Set<(event: RunBrowserEvent) => void>();
  private compositor: BaseWindow | null = null;

  constructor(private readonly options: HostBrowserServiceOptions) {}

  async ensure(input: EnsureRunBrowserInput): Promise<RunBrowserState> {
    const runId = input.runId.trim();
    if (!runId) {
      throw new Error("A run id is required.");
    }
    const viewport = normalizeViewport(input.viewport);
    let session = this.sessions.get(runId);
    if (!session) {
      const projectId = await this.options.resolveRunProjectId(runId);
      const partition = runBrowserPartitionForProject(projectId);
      const view = this.options.createView?.(partition) ?? new WebContentsView({
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          devTools: false,
        },
      });
      session = {
        runId,
        projectId,
        view,
        viewport,
        inspecting: false,
        desktopVisible: false,
        parent: null,
        idleTimer: null,
        inspector: null,
      };
      this.sessions.set(runId, session);
      this.configureSession(session);
      this.attachToCompositor(session);
      const initialUrl = normalizeRunBrowserUrl(input.initialUrl ?? DEFAULT_BROWSER_URL);
      await view.webContents.loadURL(initialUrl);
    } else {
      session.viewport = viewport;
      if (!session.desktopVisible) {
        session.view.setBounds(viewportBounds(viewport));
      }
    }
    this.cancelIdleDisposal(session);
    this.emitState(session);
    if (!session.desktopVisible) {
      this.scheduleIdleDisposal(session);
    }
    return this.stateFor(session);
  }

  async navigate(input: NavigateRunBrowserInput): Promise<void> {
    const session = this.requireSession(input.runId);
    this.cancelIdleDisposal(session);
    await session.view.webContents.loadURL(normalizeRunBrowserUrl(input.url));
  }

  async action(input: RunBrowserActionInput): Promise<void> {
    const session = this.requireSession(input.runId);
    const history = session.view.webContents.navigationHistory;
    switch (input.action) {
      case "back":
        if (history.canGoBack()) history.goBack();
        break;
      case "forward":
        if (history.canGoForward()) history.goForward();
        break;
      case "reload":
        session.view.webContents.reload();
        break;
      case "stop":
        session.view.webContents.stop();
        break;
      case "start-inspect":
        await this.ensureInspector(session).start();
        break;
      case "cancel-inspect":
        await session.inspector?.cancel();
        break;
    }
    this.emitState(session);
  }

  setViewport(input: SetRunBrowserViewportInput): void {
    const session = this.requireSession(input.runId);
    session.viewport = normalizeViewport(input.viewport);
    if (!session.desktopVisible) {
      session.view.setBounds(viewportBounds(session.viewport));
    }
    this.emitState(session);
  }

  setDesktopSurface(input: SetRunBrowserDesktopSurfaceInput): void {
    const session = this.requireSession(input.runId);
    session.desktopVisible = input.visible;
    if (input.visible) {
      const mainWindow = this.options.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error("The BuildWarden window is unavailable.");
      }
      this.moveToParent(session, "main", mainWindow);
      session.view.setBounds({
        x: Math.max(0, Math.round(input.bounds.x)),
        y: Math.max(0, Math.round(input.bounds.y)),
        width: Math.max(1, Math.round(input.bounds.width)),
        height: Math.max(1, Math.round(input.bounds.height)),
      });
      session.view.setVisible(true);
      this.cancelIdleDisposal(session);
      return;
    }
    session.view.setVisible(false);
    this.attachToCompositor(session);
    this.scheduleIdleDisposal(session);
  }

  onEvent(listener: (event: RunBrowserEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getElementCapture(input: GetRunBrowserElementCaptureInput): RunBrowserElementCapture {
    const session = this.requireSession(input.runId);
    const capture = session.inspector?.getCapture(input.captureId) ?? null;
    if (!capture) throw new Error("The browser element capture expired. Select the element again.");
    return capture;
  }

  disposeRun(runId: string): void {
    const session = this.sessions.get(runId);
    if (session) this.disposeSession(session);
  }

  disposeAll(): void {
    for (const session of [...this.sessions.values()]) {
      this.disposeSession(session);
    }
    if (this.compositor && !this.compositor.isDestroyed()) {
      this.compositor.destroy();
    }
    this.compositor = null;
    this.listeners.clear();
  }

  private configureSession(session: HostBrowserSession): void {
    const contents = session.view.webContents;
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.on("will-download", (_event, item) => item.cancel());
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const normalized = normalizeRunBrowserUrl(url);
        void contents.loadURL(normalized);
      } catch (error) {
        this.emitError(session.runId, error instanceof Error ? error.message : "The popup URL was blocked.");
      }
      return { action: "deny" };
    });
    const blockUnsafeNavigation = (event: Electron.Event<{ url: string }>) => {
      try {
        normalizeRunBrowserUrl(event.url);
      } catch (error) {
        event.preventDefault();
        this.emitError(session.runId, error instanceof Error ? error.message : "The navigation was blocked.");
      }
    };
    contents.on("will-navigate", blockUnsafeNavigation);
    contents.on("will-redirect", blockUnsafeNavigation);
    contents.on("did-start-loading", () => this.emitState(session));
    contents.on("did-stop-loading", () => this.emitState(session));
    contents.on("did-navigate", () => this.emitState(session));
    contents.on("did-navigate-in-page", () => this.emitState(session));
    contents.on("page-title-updated", () => this.emitState(session));
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        this.emitError(session.runId, `Could not load ${validatedUrl || "the page"}: ${errorDescription}`);
      }
      this.emitState(session);
    });
    contents.on("render-process-gone", (_event, details) => {
      this.emit({
        type: "error",
        runId: session.runId,
        message: `The browser renderer exited (${details.reason}).`,
        recoverable: false,
      });
    });
  }

  private requireSession(runId: string): HostBrowserSession {
    const session = this.sessions.get(runId);
    if (!session) {
      throw new Error("The run browser session is not open.");
    }
    return session;
  }

  private stateFor(session: HostBrowserSession): RunBrowserState {
    const contents = session.view.webContents;
    return {
      runId: session.runId,
      currentUrl: contents.getURL() || DEFAULT_BROWSER_URL,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      inspecting: session.inspecting,
      viewport: session.viewport,
    };
  }

  private emitState(session: HostBrowserSession): void {
    this.emit({ type: "state", runId: session.runId, state: this.stateFor(session) });
  }

  private emitError(runId: string, message: string): void {
    this.emit({ type: "error", runId, message, recoverable: true });
  }

  private emit(event: RunBrowserEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private ensureInspector(session: HostBrowserSession): RunBrowserInspector {
    if (session.inspector) return session.inspector;
    session.inspector = new RunBrowserInspector({
      runId: session.runId,
      webContents: session.view.webContents,
      onInspectingChange: (inspecting) => {
        session.inspecting = inspecting;
        this.emitState(session);
      },
      onSelection: (captureId, summary) => {
        this.emit({ type: "selection-ready", runId: session.runId, captureId, summary });
      },
      onError: (message, recoverable) => {
        this.emit({ type: "error", runId: session.runId, message, recoverable });
      },
    });
    return session.inspector;
  }

  private ensureCompositor(): BaseWindow {
    if (this.compositor && !this.compositor.isDestroyed()) {
      return this.compositor;
    }
    this.compositor = this.options.createCompositor?.() ?? new BaseWindow({
      width: 1,
      height: 1,
      show: false,
      focusable: false,
      frame: false,
      skipTaskbar: true,
    });
    return this.compositor;
  }

  private attachToCompositor(session: HostBrowserSession): void {
    const compositor = this.ensureCompositor();
    this.moveToParent(session, "compositor", compositor);
    session.view.setBounds(viewportBounds(session.viewport));
    session.view.setVisible(false);
  }

  private moveToParent(session: HostBrowserSession, target: Exclude<SessionParent, null>, window: BrowserWindow | BaseWindow): void {
    if (session.parent === target) return;
    const mainWindow = this.options.getMainWindow();
    if (session.parent === "main" && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(session.view);
    } else if (session.parent === "compositor" && this.compositor && !this.compositor.isDestroyed()) {
      this.compositor.contentView.removeChildView(session.view);
    }
    window.contentView.addChildView(session.view);
    session.parent = target;
  }

  private cancelIdleDisposal(session: HostBrowserSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  private scheduleIdleDisposal(session: HostBrowserSession): void {
    this.cancelIdleDisposal(session);
    session.idleTimer = setTimeout(() => {
      if (!session.desktopVisible) this.disposeSession(session);
    }, this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  }

  private disposeSession(session: HostBrowserSession): void {
    this.cancelIdleDisposal(session);
    session.inspector?.dispose();
    session.inspector = null;
    try {
      if (session.parent === "main") {
        const mainWindow = this.options.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(session.view);
      } else if (session.parent === "compositor" && this.compositor && !this.compositor.isDestroyed()) {
        this.compositor.contentView.removeChildView(session.view);
      }
      if (!session.view.webContents.isDestroyed()) session.view.webContents.close();
    } catch (error) {
      logWarn("Failed to dispose a run browser session cleanly.", { runId: session.runId, error });
    }
    this.sessions.delete(session.runId);
  }
}
