import { Fragment, memo, useMemo, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkGemoji from "remark-gemoji";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { splitResponseMarkdownBlocks } from "./response-markdown-blocks";
import { prepareResponseMarkdown } from "./response-markdown-preparation";
import { responseAlerts } from "./response-alerts";
import { markdownSanitizeSchema, responseMediaLayout, responseUrlTransform } from "./response-markdown";

// `$x$` is normalized to `$$x$$` beforehand only when it is clearly math; see `response-math.ts`.
// remark-gemoji turns GitHub shortcodes (`:rocket:`) into emoji, outside code only.
const remarkPlugins: NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]> = [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkGemoji];

// After sanitizing: KaTeX output is generated, not model-written. `trust: false` disables \href,
// \url, \includegraphics and \html*; the limits stop formulas from blowing up layout or CPU.
const katexOptions = { throwOnError: false, strict: "ignore", trust: false, maxSize: 20, maxExpand: 300, output: "htmlAndMathml" } as const;

type MarkdownProps = {
  content: string;
  components: Components;
};

/** Renders the content as one Markdown document. */
export const ResponseMarkdownBlock = memo(function ResponseMarkdownBlock({ content, components }: MarkdownProps) {
  const prepared = useMemo(() => prepareResponseMarkdown(content), [content]);
  const rehypePlugins = useMemo<NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>>(() => [
    // Slugs before sanitizing: it prefixes them with `user-content-`, which `response-anchors.ts` expects.
    rehypeRaw, prepared.rehypeRestoreImages, rehypeSlug, [rehypeSanitize, markdownSanitizeSchema], [rehypeKatex, katexOptions], responseAlerts, responseMediaLayout,
  ], [prepared]);
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}
    urlTransform={responseUrlTransform} components={components}>{prepared.markdown}</ReactMarkdown>;
});

/**
 * Long responses render as independent top-level blocks. While a response
 * streams, earlier blocks keep their text and skip parsing; only the tail re-renders.
 */
export const ResponseMarkdownBody = memo(function ResponseMarkdownBody({ content, components }: MarkdownProps) {
  const blocks = useMemo(() => splitResponseMarkdownBlocks(content), [content]);
  if (!blocks) return <ResponseMarkdownBlock content={content} components={components} />;
  // Blocks only grow at the end, so an index identifies the same block across updates.
  // A whole document separates top-level elements with a newline text node; keep it.
  return blocks.map((block, index) => (
    <Fragment key={index}>
      {index > 0 ? "\n" : null}
      <ResponseMarkdownBlock content={block} components={components} />
    </Fragment>
  ));
});
