import type { DocumentTheme } from "./use-document-theme";

let queue: Promise<unknown> = Promise.resolve();
let renderCount = 0;

/** Sizes the SVG from its viewBox so it scales like an image instead of filling an unknown width. */
const withIntrinsicSize = (svg: string): string => {
  const viewBox = /viewBox="([\d.\s-]+)"/.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite)) return svg;
  const [, , width, height] = viewBox;
  return svg.replace(/<svg\b[^>]*>/, (tag) => tag
    .replace(/\s(?:width|height)="[^"]*"/g, "")
    .replace(/\sstyle="[^"]*max-width[^"]*"/, "")
    .replace(/^<svg/, `<svg width="${Math.ceil(width)}" height="${Math.ceil(height)}"`));
};

/**
 * Renders Mermaid source to an SVG data URL, or null when the source does not parse (for example while
 * it is still streaming). Strict security: no scripts, no click handlers, sanitized labels. The SVG is
 * shown through <img>, so even a sanitizer gap could not run code or reach the page.
 * Renders run one at a time because Mermaid keeps global configuration.
 */
export const renderMermaidDiagram = (source: string, theme: DocumentTheme): Promise<string | null> => {
  const run = queue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "light" ? "default" : "dark",
      fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
      // SVG text instead of HTML labels: <img> does not lay out foreign HTML reliably.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    if (!(await mermaid.parse(source, { suppressErrors: true }))) return null;
    const id = `response-mermaid-${++renderCount}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withIntrinsicSize(svg))}`;
    } catch {
      return null;
    } finally {
      // Mermaid leaves its measuring container (and error output) in the document.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run.catch(() => null);
};
