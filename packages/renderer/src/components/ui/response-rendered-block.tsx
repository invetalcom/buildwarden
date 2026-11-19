import { memo, useState } from "react";
import { CodeXml, Image } from "lucide-react";
import { CodeCopyButton, ResponseCodeView } from "./response-code-view";
import { ImageLightbox } from "./image-lightbox";

/**
 * A fenced block whose source renders as an image (Mermaid, SVG): the image once `url` is known,
 * otherwise the source. A toolbar button switches between the two; clicking the image enlarges it.
 * The image is always shown through <img>, so its content cannot run scripts or reach the page.
 */
export const ResponseRenderedBlock = memo(function ResponseRenderedBlock({ code, language, preClassName, url, alt, downloadFileName }: {
  code: string;
  language: string;
  preClassName?: string;
  url: string | null;
  alt: string;
  downloadFileName: string;
}) {
  const [showSource, setShowSource] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  if (!url || showSource) {
    return (
      <ResponseCodeView code={code} language={language} preClassName={preClassName} extraActions={url ? (
        <button type="button" onClick={() => setShowSource(false)} title="Show rendered" aria-label="Show rendered">
          <Image className="h-3 w-3" aria-hidden="true" />
        </button>
      ) : null} />
    );
  }
  return (
    <div className="response-code response-rendered">
      <button type="button" className="response-rendered-image" onClick={() => setEnlarged(true)} aria-label={`Enlarge ${alt}`}>
        <img src={url} alt={alt} decoding="async" />
      </button>
      <div className="response-code-toolbar">
        <span className="response-code-language">{language}</span>
        <button type="button" onClick={() => setShowSource(true)} title="Show source" aria-label="Show source">
          <CodeXml className="h-3 w-3" aria-hidden="true" />
        </button>
        <CodeCopyButton code={code} />
      </div>
      {enlarged ? <ImageLightbox imageUrl={url} downloadFileName={downloadFileName} title={alt} onClose={() => setEnlarged(false)} /> : null}
    </div>
  );
});
