import { memo, useMemo, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { prepareResponseMarkdown } from "./response-markdown-preparation";
import { responseAlerts } from "./response-alerts";
import { markdownSanitizeSchema, responseMediaLayout, responseUrlTransform } from "./response-markdown";

// `$x$` is normalized to `$$x$$` beforehand only when it is clearly math; see `response-math.ts`.
const remarkPlugins: NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]> = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];

// After sanitizing: KaTeX output is generated, not model-written. `trust: false` disables \href,
// \url, \includegraphics and \html*; the limits stop formulas from blowing up layout or CPU.
const katexOptions = { throwOnError: false, strict: "ignore", trust: false, maxSize: 20, maxExpand: 300, output: "htmlAndMathml" } as const;

export const ResponseMarkdownBody = memo(function ResponseMarkdownBody({ content, components }: {
  content: string;
  components: Components;
}) {
  const prepared = useMemo(() => prepareResponseMarkdown(content), [content]);
  const rehypePlugins = useMemo<NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>>(() => [
    // Slugs before sanitizing: it prefixes them with `user-content-`, which `response-anchors.ts` expects.
    rehypeRaw, prepared.rehypeRestoreImages, rehypeSlug, [rehypeSanitize, markdownSanitizeSchema], [rehypeKatex, katexOptions], responseAlerts, responseMediaLayout,
  ], [prepared]);
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}
    urlTransform={responseUrlTransform} components={components}>{prepared.markdown}</ReactMarkdown>;
});
