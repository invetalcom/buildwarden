import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Loader2, MousePointer2, RefreshCw, Square, X } from "lucide-react";
import type { RunBrowserElementCapture, RunBrowserEvent, RunBrowserState } from "@buildwarden/shared";
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
  const [error, setError] = useState<string | null>(null);
  const desktopSurface = buildwarden.capabilities.platform === "electron";
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

  useEffect(() => {
    const nextSession = sessionRef.current;
    setBrowserState(initialState(runId, nextSession));
    setDraftUrl(nextSession.draftUrl || nextSession.currentUrl || DEFAULT_BROWSER_URL);
    lastRequestedUrlRef.current = "";
    setReady(false);
    setError(null);
  }, [runId]);

  useEffect(() => {
    if (!desktopSurface) {
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
      }
    });
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
      void buildwarden.setRunBrowserDesktopSurface({ runId, bounds: lastBoundsRef.current, visible: false }).catch(() => undefined);
    };
  }, [applyState, buildwarden, desktopSurface, runId]);

  useEffect(() => {
    const requestedUrl = session.currentUrl;
    if (!desktopSurface || !ready || !requestedUrl || requestedUrl === browserState.currentUrl || requestedUrl === lastRequestedUrlRef.current) {
      return;
    }
    lastRequestedUrlRef.current = requestedUrl;
    setDraftUrl(requestedUrl);
    void buildwarden.navigateRunBrowser({ runId, url: requestedUrl }).catch((navigationError: unknown) => {
      setError(navigationError instanceof Error ? navigationError.message : "Could not open that URL.");
    });
  }, [browserState.currentUrl, buildwarden, desktopSurface, ready, runId, session.currentUrl]);

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
        {!ready || !desktopSurface ? (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 px-6 text-center text-xs text-zinc-400">
            {!ready && desktopSurface ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Starting browser…</> : error}
          </div>
        ) : null}
      </div>
    </div>
  );
};
