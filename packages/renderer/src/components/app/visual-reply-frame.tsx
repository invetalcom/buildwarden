import { useCallback, useEffect, useRef, useState } from "react";
import { Expand, PanelsTopLeft } from "lucide-react";
import { VISUAL_REPLY_MESSAGES, type VisualReplyFrame, type VisualReplyMetadata } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { DialogOverlay, DialogSurface } from "../ui/dialog-surface";
import { Spinner } from "../ui/motion";

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1600;
const INITIAL_HEIGHT = 240;

// Page variable ← app token. Chart colors fall back to the status colors when the usage charts' own
// series colors are not loaded on this page.
const THEME_SOURCES: ReadonlyArray<[string, string[]]> = [
  ["--bw-bg", ["--ec-bg"]],
  ["--bw-surface", ["--ec-panel"]],
  ["--bw-text", ["--ec-text"]],
  ["--bw-muted", ["--ec-muted"]],
  ["--bw-border", ["--ec-border"]],
  ["--bw-accent", ["--ec-accent"]],
  ["--bw-success", ["--ec-success"]],
  ["--bw-warning", ["--ec-warning"]],
  ["--bw-danger", ["--ec-danger"]],
  ["--bw-info", ["--ec-info"]],
  ["--bw-font", ["--bw-font-ui"]],
  ["--bw-font-mono", ["--bw-font-mono"]],
  ["--bw-chart-1", ["--usage-series-1", "--ec-accent"]],
  ["--bw-chart-2", ["--usage-series-2", "--ec-success"]],
  ["--bw-chart-3", ["--usage-series-3", "--ec-warning"]],
  ["--bw-chart-4", ["--usage-series-4", "--ec-danger"]],
  ["--bw-chart-5", ["--usage-series-5", "--ec-info"]],
  ["--bw-chart-6", ["--usage-series-6", "--ec-reasoning"]],
  ["--bw-chart-7", ["--usage-series-7", "--ec-muted"]],
];

/** The current design as page variables, read from the app's own tokens. */
const readVisualReplyTheme =(): { scheme: "light" | "dark"; vars: Record<string, string> } => {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const [name, sources] of THEME_SOURCES) {
    const value = sources.map((source) => computed.getPropertyValue(source).trim()).find(Boolean);
    if (value) vars[name] = value;
  }
  if (!vars["--bw-font"]) vars["--bw-font"] = getComputedStyle(document.body).fontFamily;
  return { scheme: root.dataset.theme === "light" ? "light" : "dark", vars };
};

/**
 * One sandboxed frame for a page. It has an opaque origin (no `allow-same-origin`), so the page
 * cannot reach the app. The page may only tell its height and ask to open a web link; both are
 * accepted only from this frame's own window.
 */
const SandboxedPage = ({ frame, title, fill = false }: { frame: VisualReplyFrame; title: string; fill?: boolean }) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const sendTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: VISUAL_REPLY_MESSAGES.theme, ...readVisualReplyTheme() }, "*");
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown; url?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === VISUAL_REPLY_MESSAGES.ready) sendTheme();
      if (data.type === VISUAL_REPLY_MESSAGES.size && typeof data.height === "number" && Number.isFinite(data.height)) {
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(data.height))));
      }
      if (data.type === VISUAL_REPLY_MESSAGES.openLink && typeof data.url === "string") {
        try {
          const url = new URL(data.url);
          if (url.protocol === "http:" || url.protocol === "https:") window.open(url.href, "_blank", "noopener,noreferrer");
        } catch {
          // Not a URL: ignore.
        }
      }
    };
    window.addEventListener("message", receive);
    // Follow theme switches while the page is open.
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-design-scheme", "style"] });
    return () => {
      window.removeEventListener("message", receive);
      observer.disconnect();
    };
  }, [sendTheme]);
  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block w-full rounded-[var(--bw-radius-cards,0.5rem)] border-0 bg-transparent"
      style={fill ? { height: "100%" } : { height }}
      onLoad={sendTheme}
      {...(frame.kind === "document" ? { srcDoc: frame.document } : { src: frame.url })}
    />
  );
};

/** A page an agent showed with `buildwarden_show_visual`, with a full-screen view. */
export const VisualReplyView = ({ runId, stepId, visual }: { runId: string; stepId: string; visual: VisualReplyMetadata }) => {
  const client = useBuildWardenClient();
  const [frame, setFrame] = useState<VisualReplyFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFrame(null);
    setError(null);
    client.getVisualReplyFrame(runId, stepId).then(
      (loaded) => { if (!cancelled) setFrame(loaded); },
      (caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)); },
    );
    return () => { cancelled = true; };
  }, [client, runId, stepId]);
  return (
    <div data-ui="visual-reply" className="agent-panel space-y-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <PanelsTopLeft className="h-3.5 w-3.5 shrink-0 text-[var(--ec-muted)]" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--ec-text)]">{visual.title}</p>
        <Button type="button" variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0 text-[var(--ec-muted)] hover:text-[var(--ec-text)]"
          disabled={!frame} onClick={() => setFullScreen(true)} title="Open full screen" aria-label="Open full screen">
          <Expand className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      {frame ? <SandboxedPage frame={frame} title={visual.title} /> : error ? (
        <p className="text-xs text-[var(--ec-danger)]">{error}</p>
      ) : (
        <div className="flex h-24 items-center justify-center" role="status" aria-label="Loading page"><Spinner className="h-4 w-4 text-[var(--ec-muted)]" aria-hidden /></div>
      )}
      {fullScreen && frame ? (
        <DialogOverlay onDismiss={() => setFullScreen(false)} onKeyDown={(event) => { if (event.key === "Escape") setFullScreen(false); }}>
          <DialogSurface title={visual.title} icon={<PanelsTopLeft className="h-4 w-4" />} onClose={() => setFullScreen(false)}
            className="h-[calc(100vh-3rem)] max-w-[min(96rem,calc(100vw-3rem))]" bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* A second frame: moving the inline one would reload it anyway. */}
            <div className="min-h-0 flex-1"><SandboxedPage frame={frame} title={visual.title} fill /></div>
          </DialogSurface>
        </DialogOverlay>
      ) : null}
    </div>
  );
};
