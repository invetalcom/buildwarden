import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Loader2, MousePointer2, RefreshCw, Square, X } from "lucide-react";
import type { RunBrowserElementCapture, RunBrowserEvent, RunBrowserFrame, RunBrowserInput, RunBrowserState } from "@buildwarden/shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../../lib/cn";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import {
  getNativeSurfaceBounds,
  isNativeSurfaceOccluded,
  subscribeNativeSurfaceOcclusion,
} from "../../lib/native-surface-occlusion";
import type { RunBrowserSessionState } from "./RunDetailPage";
import { mapRunBrowserFramePoint } from "./run-browser-coordinate-mapping";

const DEFAULT_BROWSER_URL = "about:blank";
const DEFAULT_VIEWPORT = { width: 900, height: 600 };

type Props = {
  runId: string;
  uiActive?: boolean;
  className?: string;
  session: RunBrowserSessionState;
  onSessionChange: (session: RunBrowserSessionState) => void;
  onElementSelected?: (capture: RunBrowserElementCapture) => void;
};

const initialState = (runId: string, session: RunBrowserSessionState): RunBrowserState => ({
  runId,
  currentUrl: session.currentUrl || DEFAULT_BROWSER_URL,
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  inspecting: false,
  viewport: DEFAULT_VIEWPORT,
});

export const RunEmbeddedBrowser = ({
  className,
  runId,
  uiActive = true,
  session,
  onSessionChange,
  onElementSelected,
}: Props) => {
  const buildwarden = useBuildWardenClient();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const remoteTextInputRef = useRef<HTMLTextAreaElement>(null);
  const remoteFrameRef = useRef<RunBrowserFrame | null>(null);
  const remoteInputFrameRef = useRef(0);
  const pendingPointerRef = useRef<RunBrowserInput | null>(null);
  const pendingWheelRef = useRef<{ x: number; y: number; deltaX: number; deltaY: number; modifiers: number } | null>(null);
  const pressedPointerButtonRef = useRef<"left" | "middle" | "right" | null>(null);
  const lastRemotePointRef = useRef<{ x: number; y: number } | null>(null);
  const sessionRef = useRef(session);
  const addressFocusedRef = useRef(false);
  const onSessionChangeRef = useRef(onSessionChange);
  const onElementSelectedRef = useRef(onElementSelected);
  const lastBoundsRef = useRef({ x: 0, y: 0, width: 1, height: 1 });
  const lastViewportRef = useRef("");
  const lastRequestedUrlRef = useRef("");
  const [browserState, setBrowserState] = useState(() => initialState(runId, session));
  const [draftUrl, setDraftUrl] = useState(session.draftUrl || session.currentUrl || DEFAULT_BROWSER_URL);
  const [ready, setReady] = useState(false);
  const [remoteFrameReady, setRemoteFrameReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktopSurface = buildwarden.capabilities.platform === "electron";
  const browserControl = buildwarden.capabilities.browserControl;
  onSessionChangeRef.current = onSessionChange;
  onElementSelectedRef.current = onElementSelected;
  sessionRef.current = session;

  const applyState = useCallback((state: RunBrowserState) => {
    lastRequestedUrlRef.current = state.currentUrl;
    setBrowserState(state);
    if (!addressFocusedRef.current) setDraftUrl(state.currentUrl || DEFAULT_BROWSER_URL);
    onSessionChangeRef.current({
      draftUrl: state.currentUrl || DEFAULT_BROWSER_URL,
      currentUrl: state.currentUrl || DEFAULT_BROWSER_URL,
      history: [state.currentUrl || DEFAULT_BROWSER_URL],
      historyIndex: 0,
      reloadKey: 0,
    });
  }, []);

  const drawRemoteFrame = useCallback((frame: RunBrowserFrame) => {
    if (frame.sequence <= (remoteFrameRef.current?.sequence ?? 0)) return;
    remoteFrameRef.current = frame;
    const image = new Image();
    image.onload = () => {
      if (remoteFrameRef.current?.sequence !== frame.sequence) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = frame.width;
      canvas.height = frame.height;
      canvas.getContext("2d")?.drawImage(image, 0, 0, frame.width, frame.height);
      setRemoteFrameReady(true);
    };
    image.src = `data:image/jpeg;base64,${frame.dataBase64}`;
  }, []);

  useEffect(() => {
    const nextSession = sessionRef.current;
    setBrowserState(initialState(runId, nextSession));
    setDraftUrl(nextSession.draftUrl || nextSession.currentUrl || DEFAULT_BROWSER_URL);
    lastRequestedUrlRef.current = "";
    remoteFrameRef.current = null;
    pressedPointerButtonRef.current = null;
    lastRemotePointRef.current = null;
    setRemoteFrameReady(false);
    setReady(false);
    setError(null);
  }, [runId]);

  useEffect(() => {
    if (!browserControl) {
      setError("Remote browser control requires browser permission. Re-pair this device after browser access is enabled.");
      return;
    }
    let active = true;
    const unsubscribe = buildwarden.onRunBrowserEvent((event: RunBrowserEvent) => {
      if (!active || event.runId !== runId) return;
      if (event.type === "state") {
        applyState(event.state);
      } else if (event.type === "error") {
        setError(event.message);
      } else if (event.type === "selection-ready") {
        void buildwarden.getRunBrowserElementCapture({ runId, captureId: event.captureId })
          .then((capture) => {
            if (active) onElementSelectedRef.current?.(capture);
          })
          .catch((captureError: unknown) => {
            if (active) setError(captureError instanceof Error ? captureError.message : "Could not fetch the selected element.");
          });
      } else if (event.type === "frame") {
        drawRemoteFrame(event.frame);
      }
    }, [runId]);
    const initialBounds = surfaceRef.current ? getNativeSurfaceBounds(surfaceRef.current) : null;
    void buildwarden.ensureRunBrowser({
      runId,
      initialUrl: sessionRef.current.currentUrl || DEFAULT_BROWSER_URL,
      viewport: initialBounds
        ? { width: initialBounds.width, height: initialBounds.height, deviceScaleFactor: window.devicePixelRatio }
        : DEFAULT_VIEWPORT,
    }).then((state) => {
      if (!active) return;
      applyState(state);
      setReady(true);
    }).catch((ensureError: unknown) => {
      if (active) setError(ensureError instanceof Error ? ensureError.message : "Could not start the run browser.");
    });
    return () => {
      active = false;
      unsubscribe();
      if (desktopSurface) {
        void buildwarden.setRunBrowserDesktopSurface({ runId, bounds: lastBoundsRef.current, visible: false }).catch(() => undefined);
      }
    };
  }, [applyState, browserControl, buildwarden, desktopSurface, drawRemoteFrame, runId]);

  useEffect(() => {
    const requestedUrl = session.currentUrl;
    if (!ready || !requestedUrl || requestedUrl === browserState.currentUrl || requestedUrl === lastRequestedUrlRef.current) {
      return;
    }
    lastRequestedUrlRef.current = requestedUrl;
    setDraftUrl(requestedUrl);
    void buildwarden.navigateRunBrowser({ runId, url: requestedUrl }).catch((navigationError: unknown) => {
      setError(navigationError instanceof Error ? navigationError.message : "Could not open that URL.");
    });
  }, [browserState.currentUrl, buildwarden, ready, runId, session.currentUrl]);

  useEffect(() => {
    if (!desktopSurface) return;
    let frame = 0;
    const syncSurface = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = surfaceRef.current;
        const bounds = element ? getNativeSurfaceBounds(element) : null;
        const visible = Boolean(uiActive && ready && bounds && !isNativeSurfaceOccluded());
        const nextBounds = bounds ?? lastBoundsRef.current;
        lastBoundsRef.current = nextBounds;
        if (bounds) {
          const viewportKey = `${String(bounds.width)}x${String(bounds.height)}@${String(window.devicePixelRatio)}`;
          if (viewportKey !== lastViewportRef.current) {
            lastViewportRef.current = viewportKey;
            void buildwarden.setRunBrowserViewport({
              runId,
              viewport: { width: bounds.width, height: bounds.height, deviceScaleFactor: window.devicePixelRatio },
            }).catch(() => undefined);
          }
        }
        void buildwarden.setRunBrowserDesktopSurface({ runId, bounds: nextBounds, visible }).catch((surfaceError: unknown) => {
          setError(surfaceError instanceof Error ? surfaceError.message : "Could not position the browser surface.");
        });
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncSurface);
    if (surfaceRef.current) observer?.observe(surfaceRef.current);
    const unsubscribeOcclusion = subscribeNativeSurfaceOcclusion(syncSurface);
    window.addEventListener("scroll", syncSurface, true);
    window.visualViewport?.addEventListener("resize", syncSurface);
    window.visualViewport?.addEventListener("scroll", syncSurface);
    syncSurface();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      unsubscribeOcclusion();
      window.removeEventListener("scroll", syncSurface, true);
      window.visualViewport?.removeEventListener("resize", syncSurface);
      window.visualViewport?.removeEventListener("scroll", syncSurface);
      void buildwarden.setRunBrowserDesktopSurface({ runId, bounds: lastBoundsRef.current, visible: false }).catch(() => undefined);
    };
  }, [buildwarden, desktopSurface, ready, runId, uiActive]);

  useEffect(() => {
    if (desktopSurface || !browserControl || !ready) return;
    let frame = 0;
    const syncViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = surfaceRef.current?.getBoundingClientRect();
        if (!bounds || bounds.width < 1 || bounds.height < 1) return;
        void buildwarden.setRunBrowserViewport({
          runId,
          viewport: {
            width: Math.min(1_280, Math.round(bounds.width)),
            height: Math.min(800, Math.round(bounds.height)),
            deviceScaleFactor: window.devicePixelRatio,
          },
        }).catch(() => undefined);
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncViewport);
    if (surfaceRef.current) observer?.observe(surfaceRef.current);
    syncViewport();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [browserControl, buildwarden, desktopSurface, ready, runId]);

  const runAction = (action: "back" | "forward" | "reload" | "stop" | "start-inspect" | "cancel-inspect") => {
    setError(null);
    void buildwarden.runBrowserAction({ runId, action }).catch((actionError: unknown) => {
      setError(actionError instanceof Error ? actionError.message : "The browser action failed.");
    });
  };

  const navigate = () => {
    setError(null);
    void buildwarden.navigateRunBrowser({ runId, url: draftUrl }).catch((navigationError: unknown) => {
      setError(navigationError instanceof Error ? navigationError.message : "Could not open that URL.");
    });
  };

  const modifiersFor = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
    (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

  const remoteCoordinates = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    const frame = remoteFrameRef.current;
    if (!canvas || !frame) return null;
    const bounds = canvas.getBoundingClientRect();
    return mapRunBrowserFramePoint(clientX, clientY, bounds, frame);
  };

  const sendRemoteInput = (input: RunBrowserInput) => {
    void buildwarden.sendRunBrowserInput({ runId, input }).catch(() => undefined);
  };

  const releaseRemotePointer = (clientX: number, clientY: number, clickCount: number, modifiers: number) => {
    const button = pressedPointerButtonRef.current;
    if (!button) return;
    const point = remoteCoordinates(clientX, clientY) ?? lastRemotePointRef.current;
    pressedPointerButtonRef.current = null;
    const pendingPointer = pendingPointerRef.current;
    pendingPointerRef.current = null;
    if (pendingPointer) sendRemoteInput(pendingPointer);
    if (point) {
      sendRemoteInput({ type: "mouse", eventType: "mouseReleased", ...point, button, clickCount, modifiers });
    }
  };

  const flushRemoteInput = () => {
    remoteInputFrameRef.current = 0;
    const pointer = pendingPointerRef.current;
    pendingPointerRef.current = null;
    if (pointer) sendRemoteInput(pointer);
    const wheel = pendingWheelRef.current;
    pendingWheelRef.current = null;
    if (wheel) sendRemoteInput({ type: "wheel", ...wheel });
  };

  const scheduleRemoteInput = () => {
    if (!remoteInputFrameRef.current) remoteInputFrameRef.current = requestAnimationFrame(flushRemoteInput);
  };

  useEffect(() => () => {
    if (remoteInputFrameRef.current) cancelAnimationFrame(remoteInputFrameRef.current);
  }, []);

  return (
    <div className={cn("flex min-h-[320px] min-w-0 flex-1 flex-col overflow-hidden bg-[var(--ec-surface)]", className)}>
      <div className="shrink-0 border-b border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Globe className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden />
          <span className="mr-0.5 text-[11px] font-medium text-[var(--ec-text)]">Browser</span>
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Go back" disabled={!ready || !browserState.canGoBack} onClick={() => runAction("back")}>
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Go forward" disabled={!ready || !browserState.canGoForward} onClick={() => runAction("forward")}>
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Reload page" disabled={!ready} onClick={() => runAction("reload")}>
            <RefreshCw className={cn("h-3.5 w-3.5", browserState.loading && "animate-spin")} />
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Stop loading" disabled={!browserState.loading} onClick={() => runAction("stop")}>
            <Square className="h-3 w-3 fill-current" />
          </Button>
          <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
            <Input
              value={draftUrl}
              onFocus={() => { addressFocusedRef.current = true; }}
              onBlur={() => { addressFocusedRef.current = false; }}
              onChange={(event) => setDraftUrl(event.target.value)}
              placeholder="https://example.com or localhost:3000"
              spellCheck={false}
              className="h-7 min-w-0 rounded-md px-2 font-mono text-[11px]"
              aria-label="Browser address"
            />
            <Button type="submit" variant="secondary" size="sm" className="h-7 px-2 text-[11px]" disabled={!ready}>Open</Button>
          </form>
          <Button
            type="button"
            variant={browserState.inspecting ? "secondary" : "ghost"}
            size="sm"
            className={cn("h-7 w-7 p-0", browserState.inspecting && "text-sky-300")}
            aria-label={browserState.inspecting ? "Cancel element picker" : "Pick page element"}
            aria-pressed={browserState.inspecting}
            disabled={!ready}
            onClick={() => runAction(browserState.inspecting ? "cancel-inspect" : "start-inspect")}
          >
            {browserState.inspecting ? <X className="h-3.5 w-3.5" /> : <MousePointer2 className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="Open in external browser"
            disabled={!browserState.currentUrl.startsWith("http")}
            onClick={() => void buildwarden.openExternalUrl(browserState.currentUrl)}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </div>
        {browserState.inspecting ? <p className="mt-1 text-[10px] text-sky-300">Click an element in the page; press Escape to cancel.</p> : null}
        {error ? <p className="mt-1 truncate text-[10px] text-rose-300" title={error}>{error}</p> : null}
      </div>
      <div ref={surfaceRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white" data-run-browser-surface={runId}>
        {!desktopSurface && browserControl ? (
          <>
            <canvas
              ref={canvasRef}
              className="h-full w-full touch-none bg-white object-contain"
              aria-label="Remote run browser"
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => {
                const point = remoteCoordinates(event.clientX, event.clientY);
                if (!point) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                remoteTextInputRef.current?.focus();
                const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
                pressedPointerButtonRef.current = button;
                lastRemotePointRef.current = point;
                sendRemoteInput({ type: "mouse", eventType: "mousePressed", ...point, button, clickCount: event.detail || 1, modifiers: modifiersFor(event) });
              }}
              onPointerMove={(event) => {
                const point = remoteCoordinates(event.clientX, event.clientY);
                if (!point) return;
                lastRemotePointRef.current = point;
                pendingPointerRef.current = { type: "mouse", eventType: "mouseMoved", ...point, button: "none", modifiers: modifiersFor(event) };
                scheduleRemoteInput();
              }}
              onPointerUp={(event) => {
                releaseRemotePointer(event.clientX, event.clientY, event.detail || 1, modifiersFor(event));
              }}
              onPointerCancel={(event) => {
                releaseRemotePointer(event.clientX, event.clientY, event.detail || 1, modifiersFor(event));
              }}
              onWheel={(event) => {
                event.preventDefault();
                const point = remoteCoordinates(event.clientX, event.clientY);
                if (!point) return;
                const pending = pendingWheelRef.current;
                pendingWheelRef.current = {
                  ...point,
                  deltaX: (pending?.deltaX ?? 0) + event.deltaX,
                  deltaY: (pending?.deltaY ?? 0) + event.deltaY,
                  modifiers: modifiersFor(event),
                };
                scheduleRemoteInput();
              }}
            />
            <textarea
              ref={remoteTextInputRef}
              className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
              aria-label="Remote browser keyboard input"
              onKeyDown={(event) => {
                sendRemoteInput({ type: "key", eventType: "rawKeyDown", key: event.key, code: event.code, modifiers: modifiersFor(event) });
                if (event.key !== "Process" && event.key.length > 1) event.preventDefault();
              }}
              onKeyUp={(event) => {
                sendRemoteInput({ type: "key", eventType: "keyUp", key: event.key, code: event.code, modifiers: modifiersFor(event) });
                if (event.key !== "Process" && event.key.length > 1) event.preventDefault();
              }}
              onInput={(event) => {
                const text = event.currentTarget.value;
                if (text) sendRemoteInput({ type: "text", text });
                event.currentTarget.value = "";
              }}
              onPaste={(event) => {
                event.preventDefault();
                const text = event.clipboardData.getData("text/plain");
                if (text) sendRemoteInput({ type: "paste", text });
              }}
            />
          </>
        ) : null}
        {!ready || (!desktopSurface && (!browserControl || !remoteFrameReady)) ? (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 px-6 text-center text-xs text-zinc-400">
            {!ready && browserControl
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Starting browser…</>
              : error || "Waiting for the host browser frame…"}
          </div>
        ) : null}
      </div>
    </div>
  );
};
