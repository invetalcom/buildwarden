import { createHash } from "node:crypto";
import { BrowserWindow, WebContentsView, type BaseWindow, type Rectangle } from "electron";
import type {
  EnsureRunBrowserInput,
  NavigateRunBrowserInput,
  RunBrowserActionInput,
  RunBrowserEvent,
  RunBrowserElementCapture,
  RunBrowserInputEnvelope,
  RunBrowserState,
  RunBrowserPreview,
  RunBrowserViewport,
  SetRunBrowserDesktopSurfaceInput,
  SetRunBrowserViewportInput,
  GetRunBrowserElementCaptureInput,
  RunToolResult,
} from "@buildwarden/shared";
import { executeBrowserAgentAction } from "./browser-agent-actions";
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
  desktopBounds: Rectangle | null;
  parent: SessionParent;
  idleTimer: ReturnType<typeof setTimeout> | null;
  inspector: RunBrowserInspector | null;
  remoteSubscribers: number;
  frameTimer: ReturnType<typeof setTimeout> | null;
  frameCaptureInFlight: boolean;
  frameCapturePending: boolean;
  lastFrameHash: string;
  lastFrameAt: number;
  frameSequence: number;
  owner: "unclaimed" | "agent" | "human";
  controlGeneration: number;
  preview?: { url: string; capturedAt: number; thumbnail: RunBrowserPreview["thumbnail"] };
  previewCapture?: Promise<void>;
  previewAttempt?: { url: string; startedAt: number };
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
  let withProtocol = trimmed;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    withProtocol = /^(localhost|127(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`;
  }
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
  private readonly sessionCreations = new Map<string, Promise<HostBrowserSession>>();
  private readonly pendingRemoteSubscribers = new Map<string, number>();
  private readonly listeners = new Set<(event: RunBrowserEvent) => void>();
  private compositor: BaseWindow | null = null;
  private desktopWindowVisible = true;
  private readonly activeAgents = new Set<string>();
  private readonly agentEpochs = new Map<string, number>();
  private readonly agentCalls = new Set<string>();
  private readonly browserActions = new Map<string, { callId: string; action: string }>();
  private readonly previewSessions = new Set<string>();
  private readonly agentInputs = new Set<string>();

  setAgentActive(runId: string, active: boolean): void {
    this.previewSessions.delete(runId);
    this.agentEpochs.set(runId, (this.agentEpochs.get(runId) ?? 0) + 1);
    if (active) this.activeAgents.add(runId);
    else {
      this.activeAgents.delete(runId);
      this.browserActions.delete(runId);
    }
    const session = this.sessions.get(runId);
    if (!session) return;
    if (active) this.cancelIdleDisposal(session);
    else {
      session.controlGeneration++;
      if (session.owner === "agent") {
        session.view.webContents.stop();
        session.owner = "unclaimed";
      }
      this.emitState(session);
      this.scheduleIdleDisposal(session);
    }
  }

  async executeAgentTool(runId: string, callId: string, args: Record<string, unknown>): Promise<RunToolResult> {
    const result = (ok: boolean, content: string, images?: RunToolResult["images"]): RunToolResult => ({
      toolCallId: callId, name: "buildwarden_browser", ok, content, ...(images ? { images } : {}),
      metadata: { browserRunId: runId, action: args.action },
    });
    if (!this.activeAgents.has(runId)) return result(false, "The run is no longer active.");
    const epoch = this.agentEpochs.get(runId);
    if (this.agentCalls.has(runId)) return result(false, "Another browser action is in progress. Wait for it to finish.");
    this.agentCalls.add(runId);
    try {
      const action = String(args.action);
      if (action === "status") {
        const existing = this.sessions.get(runId);
        return result(true, JSON.stringify(existing ? this.stateFor(existing) : { open: false }));
      }
      if (action === "finish") {
        this.previewSessions.delete(runId);
        const session = this.sessions.get(runId);
        if (session?.owner === "agent") session.owner = "unclaimed";
        return result(true, "Browser preview session finished. The page remains open for inspection.");
      }
      this.previewSessions.add(runId);
      this.browserActions.set(runId, { callId, action });
      const existing = this.sessions.get(runId);
      if (existing) this.emitState(existing);
      if (action === "open" && !this.sessions.has(runId)) {
        if (typeof args.url !== "string") throw new Error("open requires a URL.");
        await this.ensure({ runId, initialUrl: args.url, viewport: { width: 1100, height: 720 } });
      }
      const session = this.requireSession(runId);
      const generation = session.controlGeneration;
      const assertControl = () => {
        if (!this.activeAgents.has(runId) || this.agentEpochs.get(runId) !== epoch || this.sessions.get(runId) !== session) throw new Error("Browser run ended.");
        if (session.owner === "human" || session.controlGeneration !== generation) throw new Error("The user has browser control. Wait until they choose Release to agent.");
      };
      const dispatch = async (input: Parameters<RunBrowserInspector["dispatchInput"]>[0], release = false) => {
        this.agentInputs.add(runId);
        try { await this.ensureInspector(session).dispatchInput(input, release ? undefined : assertControl); }
        finally { this.agentInputs.delete(runId); }
      };
      if (action === "snapshot") return result(true, JSON.stringify({ ...this.stateFor(session), snapshot: await this.ensureInspector(session).agentSnapshot() }));
      if (action === "screenshot") {
        const capture = await this.capturePage(session);
        const scaled = capture.getSize().width > 1600 ? capture.resize({ width: 1600 }) : capture;
        return result(true, JSON.stringify(this.stateFor(session)), [{ mimeType: "image/jpeg", data: scaled.toJPEG(75).toString("base64") }]);
      }
      assertControl();
      session.owner = "agent";
      this.emitState(session);
      await executeBrowserAgentAction(action, args, {
        get viewport() { return session.viewport; },
        assertControl,
        dispatch,
        resolveTarget: (nodeId, snapshotId) => this.ensureInspector(session).agentTarget(nodeId, snapshotId, assertControl),
        navigate: async (rawUrl, force) => {
          const url = normalizeRunBrowserUrl(rawUrl);
          if (force || session.view.webContents.getURL() !== url) await session.view.webContents.loadURL(url);
        },
      });
      assertControl();
      this.requestRemoteFrame(session, true);
      return result(true, JSON.stringify(this.stateFor(session)));
    } catch (error) {
      return result(false, error instanceof Error ? error.message : String(error));
    } finally {
      this.agentCalls.delete(runId);
      this.browserActions.delete(runId);
      const session = this.sessions.get(runId);
      if (session) this.emitState(session);
    }
  }

  /** Read-only: observing activity never creates, navigates, or takes over a browser. */
  async getPreview(runId: string): Promise<RunBrowserPreview | null> {
    const session = this.sessions.get(runId);
    if (!session || !this.hasPreviewSession(session)) return null;
    const url = session.view.webContents.getURL();
    if ((!session.previewAttempt || session.previewAttempt.url !== url || Date.now() - session.previewAttempt.startedAt >= 1000) && !session.previewCapture) {
      session.previewAttempt = { url, startedAt: Date.now() };
      session.previewCapture = (async () => {
        try {
          const source = await this.capturePage(session);
          const size = source.getSize();
          if (size.width < 1 || size.height < 1 || session.view.webContents.isDestroyed() || session.view.webContents.getURL() !== url) return;
          const scale = Math.min(1, 240 / size.width, 160 / size.height);
          const image = source.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "good" });
          const jpeg = image.toJPEG(55);
          if (jpeg.length <= 40_000) session.preview = { url, capturedAt: Date.now(), thumbnail: { mimeType: "image/jpeg", dataBase64: jpeg.toString("base64") } };
        } catch {
          // Navigation or a failed capture must not replace the last good frame.
        }
      })().finally(() => { session.previewCapture = undefined; });
    }
    // Return activity immediately; a slow/unpainted page must not block the indicator.
    // The next poll picks up the independently captured thumbnail.
    if (this.sessions.get(runId) !== session || !this.hasPreviewSession(session)) return null;
    return { state: this.stateFor(session), thumbnail: session.preview?.thumbnail ?? null };
  }

  private hasPreviewSession(session: HostBrowserSession): boolean {
    return this.activeAgents.has(session.runId) && this.previewSessions.has(session.runId);
  }

  private activeBrowserAction(session: HostBrowserSession): RunBrowserState["activeAction"] {
    return this.activeAgents.has(session.runId) && session.owner !== "human"
      ? this.browserActions.get(session.runId) ?? null : null;
  }

  private takeHumanControl(session: HostBrowserSession): void {
    if (session.owner !== "human") {
      if (session.owner === "agent" && session.view.webContents.isLoading()) session.view.webContents.stop();
      session.owner = "human";
      session.controlGeneration++;
      this.emitState(session);
    }
  }

  constructor(private readonly options: HostBrowserServiceOptions) {}

  async ensure(input: EnsureRunBrowserInput): Promise<RunBrowserState> {
    const runId = input.runId.trim();
    if (!runId) {
      throw new Error("A run id is required.");
    }
    const viewport = normalizeViewport(input.viewport);
    const initialUrl = normalizeRunBrowserUrl(input.initialUrl ?? DEFAULT_BROWSER_URL);
    let session = this.sessions.get(runId);
    if (!session) {
      let creation = this.sessionCreations.get(runId);
      if (!creation) {
        creation = this.createSession(runId, viewport, initialUrl);
        this.sessionCreations.set(runId, creation);
      }
      try {
        session = await creation;
      } finally {
        if (this.sessionCreations.get(runId) === creation) {
          this.sessionCreations.delete(runId);
        }
      }
    }
    session.viewport = viewport;
    if (session.parent === "compositor") this.attachToCompositor(session);
    this.cancelIdleDisposal(session);
    this.emitState(session);
    if (!session.desktopVisible && session.remoteSubscribers === 0) {
      this.scheduleIdleDisposal(session);
    }
    return this.stateFor(session);
  }

  private async createSession(runId: string, viewport: RunBrowserViewport, initialUrl: string): Promise<HostBrowserSession> {
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
        backgroundThrottling: false,
      },
    });
    const session: HostBrowserSession = {
      runId,
      projectId,
      view,
      viewport,
      inspecting: false,
      desktopVisible: false,
      desktopBounds: null,
      parent: null,
      idleTimer: null,
      inspector: null,
      remoteSubscribers: this.pendingRemoteSubscribers.get(runId) ?? 0,
      frameTimer: null,
      frameCaptureInFlight: false,
      frameCapturePending: false,
      lastFrameHash: "",
      lastFrameAt: 0,
      frameSequence: 0,
      owner: "unclaimed",
      controlGeneration: 0,
    };
    this.sessions.set(runId, session);
    try {
      this.configureSession(session);
      this.attachToCompositor(session);
      await view.webContents.loadURL(initialUrl);
      if (session.remoteSubscribers > 0) this.requestRemoteFrame(session, true);
      return session;
    } catch (error) {
      this.disposeSession(session);
      throw error;
    }
  }

  async navigate(input: NavigateRunBrowserInput): Promise<void> {
    const session = this.requireSession(input.runId);
    this.takeHumanControl(session);
    this.cancelIdleDisposal(session);
    await session.view.webContents.loadURL(normalizeRunBrowserUrl(input.url));
    this.requestRemoteFrame(session, true);
  }

  async action(input: RunBrowserActionInput): Promise<void> {
    const session = this.requireSession(input.runId);
    if (input.action !== "release-control") this.takeHumanControl(session);
    const history = session.view.webContents.navigationHistory;
    switch (input.action) {
      case "take-control":
        break;
      case "release-control":
        await session.inspector?.cancel();
        session.owner = "unclaimed";
        session.controlGeneration++;
        break;
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
        await this.ensureInspector(session).start(input.annotationStartNumber);
        break;
      case "cancel-inspect":
        await session.inspector?.cancel();
        break;
      case "remove-annotation":
        if (input.captureId) await session.inspector?.removeAnnotation(input.captureId);
        break;
      case "clear-annotations":
        await session.inspector?.clearAnnotations();
        break;
    }
    this.emitState(session);
    this.requestRemoteFrame(session, true);
  }

  setViewport(input: SetRunBrowserViewportInput): void {
    const session = this.requireSession(input.runId);
    session.viewport = normalizeViewport(input.viewport);
    if (session.parent === "compositor") this.attachToCompositor(session);
    this.emitState(session);
    this.requestRemoteFrame(session, true);
  }

  setDesktopSurface(input: SetRunBrowserDesktopSurfaceInput): void {
    const session = this.requireSession(input.runId);
    if (input.visible) {
      session.desktopVisible = false;
      try {
        const mainWindow = this.options.getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) {
          throw new Error("The BuildWarden window is unavailable.");
        }
        session.desktopBounds = {
          x: Math.max(0, Math.round(input.bounds.x)),
          y: Math.max(0, Math.round(input.bounds.y)),
          width: Math.max(1, Math.round(input.bounds.width)),
          height: Math.max(1, Math.round(input.bounds.height)),
        };
        if (this.desktopWindowVisible) {
          this.moveToParent(session, "main", mainWindow);
          session.view.setBounds(session.desktopBounds);
          session.view.setVisible(true);
        } else this.attachToCompositor(session);
      } catch (error) {
        if (session.remoteSubscribers === 0) this.scheduleIdleDisposal(session);
        throw error;
      }
      session.desktopVisible = true;
      this.cancelIdleDisposal(session);
      return;
    }
    session.desktopVisible = false;
    session.view.setVisible(false);
    this.attachToCompositor(session);
    if (session.remoteSubscribers === 0) this.scheduleIdleDisposal(session);
  }

  setDesktopWindowVisible(visible: boolean): void {
    this.desktopWindowVisible = visible;
    for (const session of this.sessions.values()) {
      if (!session.desktopVisible) continue;
      if (!visible) this.attachToCompositor(session);
      else {
        const window = this.options.getMainWindow();
        if (window && !window.isDestroyed() && session.desktopBounds) {
          this.moveToParent(session, "main", window);
          session.view.setBounds(session.desktopBounds);
          session.view.setVisible(true);
        }
      }
    }
  }

  detachDesktopSurfaces(): void {
    for (const session of this.sessions.values()) {
      if (!session.desktopVisible && session.parent !== "main") continue;
      session.desktopVisible = false;
      session.view.setVisible(false);
      this.attachToCompositor(session);
      if (session.remoteSubscribers === 0) this.scheduleIdleDisposal(session);
    }
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

  async sendInput(envelope: RunBrowserInputEnvelope): Promise<void> {
    const session = this.requireSession(envelope.runId);
    if (envelope.input.type !== "mouse" || envelope.input.eventType === "mousePressed") this.takeHumanControl(session);
    if (session.owner === "agent") return;
    await this.ensureInspector(session).dispatchInput(envelope.input);
    this.requestRemoteFrame(session, true);
  }

  setRemoteSubscriptions(previousRunIds: readonly string[], nextRunIds: readonly string[]): void {
    const previous = new Set(previousRunIds);
    const next = new Set(nextRunIds);
    for (const runId of previous) {
      if (!next.has(runId)) this.updateRemoteSubscriber(runId, -1);
    }
    for (const runId of next) {
      if (!previous.has(runId)) this.updateRemoteSubscriber(runId, 1);
    }
  }

  disposeRun(runId: string): void {
    this.previewSessions.delete(runId);
    this.browserActions.delete(runId);
    this.activeAgents.delete(runId);
    this.agentEpochs.delete(runId);
    this.pendingRemoteSubscribers.delete(runId);
    const session = this.sessions.get(runId);
    if (session) this.disposeSession(session);
  }

  disposeAll(): void {
    this.previewSessions.clear();
    this.browserActions.clear();
    this.activeAgents.clear();
    this.agentEpochs.clear();
    for (const session of [...this.sessions.values()]) {
      this.disposeSession(session);
    }
    if (this.compositor && !this.compositor.isDestroyed()) {
      this.compositor.destroy();
    }
    this.compositor = null;
    this.listeners.clear();
    this.pendingRemoteSubscribers.clear();
  }

  private configureSession(session: HostBrowserSession): void {
    const contents = session.view.webContents;
    contents.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown" && !this.agentInputs.has(session.runId)) this.takeHumanControl(session);
    });
    contents.on("before-mouse-event", (_event, input) => {
      if (input.type === "mouseDown" && !this.agentInputs.has(session.runId)) this.takeHumanControl(session);
    });
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
    contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) session.inspector?.handleNavigationReplacement();
    });
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
      session.inspector?.dispose();
      session.inspector = null;
      session.inspecting = false;
      this.stopRemoteFrames(session);
      this.emit({
        type: "error",
        runId: session.runId,
        message: `The browser renderer exited (${details.reason}).`,
        recoverable: true,
      });
      try {
        contents.reload();
        this.requestRemoteFrame(session, true);
      } catch {
        this.disposeSession(session);
      }
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
      owner: session.owner,
      activeAction: this.activeBrowserAction(session),
      previewSessionActive: this.hasPreviewSession(session),
      viewport: session.viewport,
    };
  }

  private emitState(session: HostBrowserSession): void {
    this.emit({ type: "state", runId: session.runId, state: this.stateFor(session) });
    this.requestRemoteFrame(session, true);
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

  private updateRemoteSubscriber(runId: string, delta: number): void {
    const nextCount = Math.max(0, (this.pendingRemoteSubscribers.get(runId) ?? 0) + delta);
    if (nextCount > 0) this.pendingRemoteSubscribers.set(runId, nextCount);
    else this.pendingRemoteSubscribers.delete(runId);
    const session = this.sessions.get(runId);
    if (!session) return;
    session.remoteSubscribers = nextCount;
    if (nextCount > 0) {
      this.cancelIdleDisposal(session);
      this.requestRemoteFrame(session, true);
    } else {
      this.stopRemoteFrames(session);
      if (!session.desktopVisible) this.scheduleIdleDisposal(session);
    }
  }

  private requestRemoteFrame(session: HostBrowserSession, immediate = false): void {
    if (session.remoteSubscribers <= 0 || session.view.webContents.isDestroyed()) return;
    if (session.frameCaptureInFlight) {
      session.frameCapturePending ||= immediate;
      return;
    }
    if (session.frameTimer) clearTimeout(session.frameTimer);
    const elapsed = Date.now() - session.lastFrameAt;
    const delay = Math.max(0, 125 - elapsed);
    session.frameTimer = setTimeout(() => {
      session.frameTimer = null;
      void this.captureRemoteFrame(session);
    }, delay);
  }

  private async captureRemoteFrame(session: HostBrowserSession): Promise<void> {
    if (session.remoteSubscribers <= 0 || session.frameCaptureInFlight) return;
    session.frameCaptureInFlight = true;
    session.frameCapturePending = false;
    try {
      const source = await this.capturePage(session);
      session.lastFrameAt = Date.now();
      const size = source.getSize();
      if (size.width < 1 || size.height < 1) return;
      const scale = Math.min(1, 1_280 / size.width, 800 / size.height);
      const image = scale < 1
        ? source.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "good" })
        : source;
      const jpeg = image.toJPEG(65);
      const hash = createHash("sha256").update(jpeg).digest("hex");
      if (hash !== session.lastFrameHash) {
        session.lastFrameHash = hash;
        const outputSize = image.getSize();
        this.emit({
          type: "frame",
          runId: session.runId,
          frame: {
            runId: session.runId,
            sequence: ++session.frameSequence,
            width: outputSize.width,
            height: outputSize.height,
            mimeType: "image/jpeg",
            dataBase64: jpeg.toString("base64"),
          },
        });
      }
    } catch (error) {
      this.emitError(session.runId, error instanceof Error ? error.message : "Could not capture a remote browser frame.");
    } finally {
      session.frameCaptureInFlight = false;
      if (session.remoteSubscribers > 0) this.requestRemoteFrame(session, session.frameCapturePending);
    }
  }

  private stopRemoteFrames(session: HostBrowserSession): void {
    if (session.frameTimer) clearTimeout(session.frameTimer);
    session.frameTimer = null;
    session.frameCapturePending = false;
    session.lastFrameHash = "";
  }

  private async capturePage(session: HostBrowserSession) {
    try {
      return await session.view.webContents.capturePage();
    } catch {
      // Native capture needs a displayed surface; CDP can also capture a run
      // whose view is currently hosted by the hidden compositor.
      return this.ensureInspector(session).screenshot();
    }
  }

  private ensureCompositor(): BaseWindow {
    if (this.compositor && !this.compositor.isDestroyed()) {
      return this.compositor;
    }
    this.compositor = this.options.createCompositor?.() ?? new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      focusable: false,
      frame: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    if (!this.options.createCompositor) {
      // A BaseWindow has no initial renderer to initialize Chromium's compositor.
      // Load a blank, hidden BrowserWindow so child views paint and accept input
      // without displaying or focusing an extra window (also for remote clients).
      void (this.compositor as BrowserWindow).loadURL("about:blank").catch(() => undefined);
    }
    return this.compositor;
  }

  private attachToCompositor(session: HostBrowserSession): void {
    const compositor = this.ensureCompositor();
    compositor.setSize(
      Math.max(...[...this.sessions.values()].map((entry) => entry.viewport.width)),
      Math.max(...[...this.sessions.values()].map((entry) => entry.viewport.height)),
    );
    this.moveToParent(session, "compositor", compositor);
    session.view.setBounds(viewportBounds(session.viewport));
    // Keep the renderer's surface alive inside the hidden compositor. Hiding the
    // view itself prevents Chromium hit testing for CDP input while the panel is closed.
    session.view.setVisible(true);
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
    if (this.activeAgents.has(session.runId)) return;
    session.idleTimer = setTimeout(() => {
      if (!session.desktopVisible && session.remoteSubscribers === 0) this.disposeSession(session);
    }, this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  }

  private disposeSession(session: HostBrowserSession): void {
    this.previewSessions.delete(session.runId);
    this.cancelIdleDisposal(session);
    this.stopRemoteFrames(session);
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
    } catch {
      // Browser errors can contain the current target URL. Keep host-browser logs
      // limited to opaque BuildWarden identifiers.
      logWarn("Failed to dispose a run browser session cleanly.", { runId: session.runId });
    }
    if (this.sessions.get(session.runId) === session) {
      this.sessions.delete(session.runId);
    }
  }
}
