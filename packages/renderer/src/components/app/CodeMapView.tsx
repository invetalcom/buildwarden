import { Info, Loader2, RefreshCw } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { WorkspaceCodeMapResult } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { codeMapHoverLinks, drawCodeMap, drawCodeMapHover, readCodeMapPalette } from "./code-map-canvas";
import {
  buildCodeMapTree,
  codeMapBreadcrumb,
  codeMapChangesFromDiff,
  formatCodeMapLines,
  hitTestCodeMap,
  layoutCodeMap,
  type CodeMapNode,
  type CodeMapRect,
  type CodeMapTree,
} from "./code-map-model";

type LoadState = { result: WorkspaceCodeMapResult | null; loading: boolean; error: string | null };

export interface CodeMapViewProps {
  /** Loads the workspace scan. Must be referentially stable: the map reloads whenever it changes. */
  load: () => Promise<WorkspaceCodeMapResult>;
  /** Unified diff whose changed files are highlighted on the map. */
  diffText: string;
  onSelectChange: (path: string) => void;
  /** Caveat about where the map comes from, shown behind an info icon. */
  note?: string;
  className?: string;
}

/** Bumps whenever the app theme changes, so canvas colors read from CSS variables are redrawn. */
const useThemeRevision = (): number => {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return undefined;
    const observer = new MutationObserver(() => setRevision((current) => current + 1));
    observer.observe(document.body, { attributes: true, attributeFilter: ["style", "data-theme", "data-design-scheme"] });
    return () => observer.disconnect();
  }, []);
  return revision;
};

const prepareCanvas = (canvas: HTMLCanvasElement | null, width: number, height: number): CanvasRenderingContext2D | null => {
  const ctx = canvas?.getContext("2d") ?? null;
  if (!canvas || !ctx) return null;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
};

const Separator = () => <span className="text-[var(--ec-faint)]" aria-hidden>·</span>;

const HoverInfo = ({ node, tree, result }: { node: CodeMapNode; tree: CodeMapTree; result: WorkspaceCodeMapResult }) => {
  const imports = node.fileIndex >= 0 ? result.files[node.fileIndex]?.imports?.length ?? 0 : 0;
  const importedBy = node.fileIndex >= 0 ? tree.importedBy[node.fileIndex]?.length ?? 0 : 0;
  return (
    <>
      <span className="min-w-0 truncate text-[var(--ec-text)]" title={node.path}>{node.path}</span>
      <Separator />
      <span className="shrink-0">{formatCodeMapLines(node.lines)} lines</span>
      {node.children ? (
        <>
          <Separator />
          <span className="shrink-0">{node.changedFiles}/{node.fileCount} changed</span>
        </>
      ) : null}
      {node.changedFiles > 0 ? (
        <span className="shrink-0">
          <span className="text-[var(--ec-success)]">+{node.additions}</span>{" "}
          <span className="text-[var(--ec-danger)]">−{node.deletions}</span>
        </span>
      ) : null}
      {node.children ? null : (
        <>
          <Separator />
          <span className="shrink-0 text-[var(--ec-info)]">imports {imports}</span>
          <Separator />
          <span className="shrink-0 text-[var(--ec-success)]">imported by {importedBy}</span>
        </>
      )}
    </>
  );
};

const MapSummary = ({ root, truncated }: { root: CodeMapNode; truncated: boolean }) => (
  <>
    <span className="shrink-0">{formatCodeMapLines(root.lines)} lines</span>
    <Separator />
    <span className="shrink-0">{root.fileCount} files</span>
    <Separator />
    <span className="shrink-0">{root.changedFiles} changed</span>
    <Separator />
    <span className="min-w-0 truncate">
      hover: <span className="text-[var(--ec-info)]">imports</span> / <span className="text-[var(--ec-success)]">imported by</span>
    </span>
    {truncated ? <span className="shrink-0 text-[var(--ec-warning)]" title="The repository is larger than the map limit.">partial map</span> : null}
  </>
);

/**
 * Treemap of a whole workspace with a diff overlaid: files are sized by line count, changed files
 * are outlined by change kind, and hovering a file draws its import edges.
 */
export const CodeMapView = ({ load, diffText, onSelectChange, note, className }: CodeMapViewProps) => {
  const [state, setState] = useState<LoadState>({ result: null, loading: true, error: null });
  const [reloadKey, setReloadKey] = useState(0);
  const [focusPath, setFocusPath] = useState("");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoveredNode, setHoveredNode] = useState<CodeMapNode | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const themeRevision = useThemeRevision();

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    load()
      .then((result) => {
        if (!cancelled) setState({ result, loading: false, error: null });
      })
      .catch((caught: unknown) => {
        if (!cancelled) setState({ result: null, loading: false, error: caught instanceof Error ? caught.message : "Could not map the repository." });
      });
    return () => {
      cancelled = true;
    };
  }, [load, reloadKey]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  const result = state.result;
  const changes = useMemo(() => codeMapChangesFromDiff(diffText), [diffText]);
  const tree = useMemo(() => (result && !result.workspaceUnavailable ? buildCodeMapTree(result.files, changes) : null), [changes, result]);
  const focusNode = tree ? tree.folders.get(focusPath) ?? tree.root : null;
  const rects = useMemo(() => (focusNode ? layoutCodeMap(focusNode, size.width, size.height) : []), [focusNode, size]);
  const rectByNode = useMemo(() => new Map(rects.map((rect) => [rect.node, rect])), [rects]);
  const hoveredRect = hoveredNode ? rectByNode.get(hoveredNode) ?? null : null;

  useEffect(() => {
    const ctx = prepareCanvas(baseCanvasRef.current, size.width, size.height);
    if (ctx && baseCanvasRef.current) drawCodeMap(ctx, rects, readCodeMapPalette(baseCanvasRef.current));
  }, [rects, size, themeRevision]);

  useEffect(() => {
    const ctx = prepareCanvas(overlayCanvasRef.current, size.width, size.height);
    if (!ctx || !overlayCanvasRef.current || !hoveredRect || !tree || !result) return;
    drawCodeMapHover(ctx, readCodeMapPalette(overlayCanvasRef.current), hoveredRect, codeMapHoverLinks(tree, result.files, hoveredRect.node, rectByNode));
  }, [hoveredRect, rectByNode, result, size, themeRevision, tree]);

  const rectAt = (event: MouseEvent<HTMLDivElement>): CodeMapRect | null => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const hit = hitTestCodeMap(rects, event.clientX - bounds.left, event.clientY - bounds.top);
    return hit && hit.node !== focusNode ? hit : null;
  };
  const isActionable = (node: CodeMapNode) => (node.children ? node.children.length > 0 : Boolean(node.change));
  const activate = (node: CodeMapNode) => {
    if (node.children) {
      if (node.children.length > 0) {
        setHoveredNode(null);
        setFocusPath(node.path);
      }
    } else if (node.change) {
      onSelectChange(node.change.path);
    }
  };
  const zoomOut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !focusNode?.parent) return;
    event.preventDefault();
    setHoveredNode(null);
    setFocusPath(focusNode.parent.path);
  };

  const breadcrumb = focusNode ? codeMapBreadcrumb(focusNode) : [];
  let message: string | null = null;
  if (state.error) message = state.error;
  else if (result?.workspaceUnavailable) message = "The project folder is not available, so there is nothing to map.";
  else if (tree && tree.root.fileCount === 0) message = "No files to map.";
  else if (!tree) message = "Mapping repository…";

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col gap-1", className)}>
      <div className="flex h-6 shrink-0 items-center gap-1.5 font-mono text-[10px] text-[var(--ec-muted)]">
        <div className="flex shrink-0 items-center gap-1">
          {breadcrumb.map((node, index) => (
            <Fragment key={node.path}>
              {index > 0 ? <span className="text-[var(--ec-faint)]" aria-hidden>/</span> : null}
              {index === breadcrumb.length - 1 ? (
                <span className="text-[var(--ec-text)]">{node.name || "repo"}</span>
              ) : (
                <button
                  type="button"
                  className="rounded px-0.5 text-[var(--ec-accent)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-accent-strong)]"
                  onClick={() => setFocusPath(node.path)}
                  title={`Zoom out to ${node.path || "the repository"}`}
                >
                  {node.name || "repo"}
                </button>
              )}
            </Fragment>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          {hoveredRect && tree && result ? <HoverInfo node={hoveredRect.node} tree={tree} result={result} /> : null}
          {!hoveredRect && tree ? <MapSummary root={tree.root} truncated={Boolean(result?.truncated)} /> : null}
        </div>
        {note ? (
          <span className="shrink-0 text-[var(--ec-faint)]" title={note} aria-label={note} role="img">
            <Info className="h-3 w-3" aria-hidden />
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0 text-[var(--ec-muted)]"
          onClick={() => setReloadKey((current) => current + 1)}
          disabled={state.loading}
          title="Rescan the repository"
          aria-label="Rescan the repository"
        >
          {state.loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
        </Button>
      </div>
      <div
        ref={surfaceRef}
        className={cn("relative min-h-0 flex-1 overflow-hidden rounded-md outline-none", hoveredRect && isActionable(hoveredRect.node) ? "cursor-pointer" : "cursor-default")}
        tabIndex={0}
        role="group"
        aria-label={tree ? `Code map: ${tree.root.fileCount} files, ${tree.root.changedFiles} changed. Use the file list for an accessible view of the changes.` : "Code map"}
        onMouseMove={(event) => setHoveredNode(rectAt(event)?.node ?? null)}
        onMouseLeave={() => setHoveredNode(null)}
        onClick={(event) => {
          const hit = rectAt(event);
          if (hit) activate(hit.node);
        }}
        onKeyDown={zoomOut}
      >
        <canvas ref={baseCanvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
        <canvas ref={overlayCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />
        {message ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 px-4 text-center text-xs text-[var(--ec-muted)]">
            {state.loading && !state.error ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : null}
            <span role={state.error ? "alert" : "status"}>{message}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
};
