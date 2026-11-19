import { memo, useEffect, useState } from "react";
import { renderMermaidDiagram } from "../../lib/response-mermaid";
import { useDocumentTheme } from "../../lib/use-document-theme";
import { ResponseRenderedBlock } from "./response-rendered-block";

/** Waits for streamed source to settle before rendering, so partial diagrams do not flicker. */
const RENDER_DELAY_MS = 250;

/** A ```mermaid block: the diagram once the source parses, otherwise the source. */
export const ResponseMermaidBlock = memo(function ResponseMermaidBlock({ code, preClassName }: { code: string; preClassName?: string }) {
  const theme = useDocumentTheme();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void renderMermaidDiagram(code, theme).then((next) => {
        if (!cancelled) setUrl(next);
      });
    }, RENDER_DELAY_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [code, theme]);

  // The previous diagram stays while a new render is pending; a failed render shows the source.
  return <ResponseRenderedBlock code={code} language="mermaid" preClassName={preClassName} url={url} alt="Mermaid diagram" downloadFileName="diagram.svg" />;
});
