import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import type { RunBrowserPreview } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";

const actionLabels: Record<string, string> = {
  open: "Opening page", navigate: "Navigating", snapshot: "Inspecting page", screenshot: "Capturing screenshot",
  click: "Clicking", type: "Typing", scroll: "Scrolling", wait: "Waiting for page",
};

type Props = {
  runId: string;
  active: boolean;
  onOpen: () => void;
};

/** Keep the displayed image mounted until its replacement has actually loaded. */
const PreviewThumbnail = ({ thumbnail }: Pick<RunBrowserPreview, "thumbnail">) => {
  const source = thumbnail ? `data:image/jpeg;base64,${thumbnail.dataBase64}` : null;
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const sources = [...new Set([loadedSource, source === failedSource ? null : source].filter((value): value is string => Boolean(value)))];
  return <span className="relative flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded border border-[var(--ec-border)] bg-[var(--ec-bg)]">
    {!loadedSource ? <Monitor aria-hidden="true" className="size-5 text-[var(--ec-muted)]" /> : null}
    {sources.map((src) => <img key={src} src={src} alt={src === loadedSource ? "Last captured browser page" : ""}
      aria-hidden={src !== loadedSource} onLoad={(event) => {
        const image = event.currentTarget;
        if (src === source) void image.decode().then(() => {
          if (image.isConnected) setLoadedSource(src);
        }).catch(() => setFailedSource(src));
      }} onError={() => setFailedSource(src)}
      className={`absolute inset-0 h-full w-full object-contain ${src === loadedSource ? "" : "invisible"}`} />)}
  </span>;
};

const ActiveBrowserPreviewTile = ({ runId, active, onOpen }: Props) => {
  const client = useBuildWardenClient();
  const [preview, setPreview] = useState<RunBrowserPreview | null>(null);
  const [connectionStale, setConnectionStale] = useState(false);
  useEffect(() => {
    if (!active || !client.capabilities.browserControl) return;
    let disposed = false;
    let inFlight = false;
    let revision = 0;
    let confirmedAt = 0;
    const refresh = async () => {
      if (document.visibilityState === "hidden") {
        revision++;
        setConnectionStale(true);
        return;
      }
      if (confirmedAt && Date.now() - confirmedAt > 2000) setConnectionStale(true);
      if (inFlight) return;
      inFlight = true;
      const requestedRevision = revision;
      try {
        const next = await client.getRunBrowserPreview(runId);
        if (!disposed && revision === requestedRevision) {
          confirmedAt = Date.now();
          setConnectionStale(false);
          setPreview(next);
        }
      } catch {
        if (!disposed && revision === requestedRevision) setConnectionStale(true);
      } finally {
        inFlight = false;
      }
    };
    // Desktop events make short actions immediate. Web/mobile poll the small read-only
    // preview endpoint, without subscribing to the full-size remote browser video stream.
    const unsubscribeBrowser = client.capabilities.platform === "electron"
      ? client.onRunBrowserEvent((event) => {
        if (event.runId !== runId || event.type !== "state") return;
        revision++;
        confirmedAt = Date.now();
        setConnectionStale(false);
        if (!event.state.previewSessionActive) setPreview(null);
        else {
          setPreview((current) => ({ state: event.state, thumbnail: current?.state.runId === runId ? current.thumbnail : null }));
          void refresh();
        }
      }, [runId]) : () => undefined;
    const unsubscribeRun = client.onRunEvent((event) => {
      const name = event.metadata?.toolName;
      const browserTool = event.metadata?.browserRunId === runId ||
        (typeof name === "string" && (name === "buildwarden_browser" || name.endsWith("__buildwarden_browser")));
      if (event.runId === runId && browserTool && (event.type === "tool-call" || event.type === "tool-result")) {
        revision++;
        void refresh();
      }
    });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    const onVisibility = () => { void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribeBrowser();
      unsubscribeRun();
    };
  }, [active, client, runId]);

  const current = active && client.capabilities.browserControl && preview?.state.runId === runId && preview.state.previewSessionActive ? preview : null;
  if (!current) return null;
  const title = current.state.title || current.state.currentUrl || "Shared browser";
  const action = current.state.activeAction?.action ?? "";
  const busy = Boolean(action) && !connectionStale && current.state.owner !== "human";
  const label = current.state.owner === "human" ? "You have control" : busy ? "Browser in use" : "Browser session";
  return <div className="flex shrink-0 justify-end px-3 py-2">
    <button type="button" onClick={onOpen} aria-label={`View live browser: ${title}`} title={title}
      className="flex w-full max-w-72 items-center gap-3 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2 text-left text-[var(--ec-text)] hover:border-[var(--ec-accent)] focus-visible:outline-2 focus-visible:outline-[var(--ec-accent)] max-sm:max-w-none">
      <PreviewThumbnail thumbnail={current.thumbnail} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-xs font-medium"><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full bg-[var(--ec-accent)] ${busy ? "motion-safe:animate-pulse" : ""}`} />{label}</span>
        <span className="block truncate text-[11px] text-[var(--ec-muted)]">{title}</span>
        <span className="block truncate text-[11px] text-[var(--ec-muted)]">{connectionStale ? "Reconnecting…" : current.state.owner === "human" ? "Agent browser actions paused" : busy ? actionLabels[action] ?? "Using browser" : "Between browser actions"}</span>
        <span className="block text-[11px] text-[var(--ec-accent)]">View live →</span>
      </span>
    </button>
  </div>;
};

export const RunBrowserPreviewTile = (props: Props) => props.active ? <ActiveBrowserPreviewTile key={props.runId} {...props} /> : null;
