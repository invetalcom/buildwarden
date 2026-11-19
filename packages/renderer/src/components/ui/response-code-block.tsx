import { memo } from "react";
import { normalizeCodeLanguage } from "../../lib/response-code";
import { ResponseCodeView } from "./response-code-view";
import { ResponseMermaidBlock } from "./response-mermaid-block";

/**
 * A fenced block in a response. Diagram languages render as diagrams; everything else as code.
 * `preClassName` carries each platform's own block styling.
 */
export const ResponseCodeBlock = memo(function ResponseCodeBlock({ code, language, preClassName }: {
  code: string;
  language: string | null;
  preClassName?: string;
}) {
  const name = normalizeCodeLanguage(language);
  if (name === "mermaid" || name === "mmd") return <ResponseMermaidBlock code={code} preClassName={preClassName} />;
  return <ResponseCodeView code={code} language={language} preClassName={preClassName} />;
});
