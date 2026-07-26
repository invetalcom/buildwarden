import { useMemo } from "react";
import { cn } from "../lib/cn";
import { splitFencedBlocks } from "../lib/text-blocks";

/**
 * Minimal fenced-code-aware text renderer.
 *
 * The desktop UI renders full markdown, which costs `react-markdown` + `remark-gfm` +
 * `rehype-sanitize`. On a phone that payload is not worth it: agent output is overwhelmingly
 * prose plus fenced code, and code blocks are the only part where formatting carries meaning.
 * Everything else renders as plain text, so no untrusted HTML is ever interpreted.
 */
export const RichText = ({ children, className }: { children: string; className?: string }) => {
  const blocks = useMemo(() => splitFencedBlocks(children), [children]);
  if (blocks.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <pre
            key={index}
            className="m-scroll-thin m-mono overflow-x-auto rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-2.5 py-2 text-[12px] leading-5"
          >
            <code>{block.content.replace(/\n$/, "")}</code>
          </pre>
        ) : (
          <p key={index} className="m-wrap-anywhere whitespace-pre-wrap text-[13.5px] leading-6">
            {block.content.trim()}
          </p>
        ),
      )}
    </div>
  );
};
