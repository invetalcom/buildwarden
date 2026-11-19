import { memo, useEffect, useState } from "react";
import { CodeXml, Workflow } from "lucide-react";
import { renderMermaidDiagram } from "../../lib/response-mermaid";
import { useDocumentTheme } from "../../lib/use-document-theme";
import { CodeCopyButton, ResponseCodeView } from "./response-code-view";
import { ImageLightbox } from "./image-lightbox";

/** Waits for streamed source to settle before rendering, so partial diagrams do not flicker. */
const RENDER_DELAY_MS = 250;

/**
 * A ```mermaid block: the diagram once the source parses, otherwise the source. A toolbar button
 * switches between the two; clicking the diagram enlarges it.
 */
export const ResponseMermaidBlock = memo(function ResponseMermaidBlock({ code, preClassName }: { code: string; preClassName?: string }) {
  const theme = useDocumentTheme();
  const [diagram, setDiagram] = useState<{ source: string; theme: string; url: string | null } | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [enlarged, setEnlarged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void renderMermaidDiagram(code, theme).then((url) => {
        if (!cancelled) setDiagram({ source: code, theme, url });
      });
    }, RENDER_DELAY_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [code, theme]);

  // Keep the previous diagram while a new render is pending; a failed render shows the source.
  const url = diagram?.url ?? null;
  if (!url || showSource) {
    return (
      <ResponseCodeView code={code} language="mermaid" preClassName={preClassName} extraActions={url ? (
        <button type="button" onClick={() => setShowSource(false)} title="Show diagram" aria-label="Show diagram">
          <Workflow className="h-3 w-3" aria-hidden="true" />
        </button>
      ) : null} />
    );
  }
  return (
    <div className="response-code response-mermaid">
      <button type="button" className="response-mermaid-diagram" onClick={() => setEnlarged(true)} aria-label="Enlarge diagram">
        <img src={url} alt="Mermaid diagram" decoding="async" />
      </button>
      <div className="response-code-toolbar">
        <span className="response-code-language">mermaid</span>
        <button type="button" onClick={() => setShowSource(true)} title="Show source" aria-label="Show source">
          <CodeXml className="h-3 w-3" aria-hidden="true" />
        </button>
        <CodeCopyButton code={code} />
      </div>
      {enlarged ? <ImageLightbox imageUrl={url} downloadFileName="diagram.svg" title="Diagram" onClose={() => setEnlarged(false)} /> : null}
    </div>
  );
});
