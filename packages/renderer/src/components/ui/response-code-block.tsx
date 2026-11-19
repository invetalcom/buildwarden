import { memo, useMemo } from "react";
import { normalizeCodeLanguage } from "../../lib/response-code";
import { isCompleteSvg, svgDataUrl } from "../../lib/response-svg";
import { ResponseCodeView } from "./response-code-view";
import { ResponseMermaidBlock } from "./response-mermaid-block";
import { ResponseRenderedBlock } from "./response-rendered-block";

const SvgBlock = ({ code, preClassName }: { code: string; preClassName?: string }) => {
  // Streaming SVG stays source until its root element closes.
  const url = useMemo(() => (isCompleteSvg(code) ? svgDataUrl(code) : null), [code]);
  return <ResponseRenderedBlock code={code} language="svg" preClassName={preClassName} url={url} alt="SVG image" downloadFileName="image.svg" />;
};

/**
 * A fenced block in a response. Diagram and image languages render as images; everything else as code.
 * `preClassName` carries each platform's own block styling.
 */
export const ResponseCodeBlock = memo(function ResponseCodeBlock({ code, language, preClassName }: {
  code: string;
  language: string | null;
  preClassName?: string;
}) {
  const name = normalizeCodeLanguage(language);
  if (name === "mermaid" || name === "mmd") return <ResponseMermaidBlock code={code} preClassName={preClassName} />;
  if (name === "svg") return <SvgBlock code={code} preClassName={preClassName} />;
  return <ResponseCodeView code={code} language={language} preClassName={preClassName} />;
});
