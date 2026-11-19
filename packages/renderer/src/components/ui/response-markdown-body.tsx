import { Fragment, memo, useMemo, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { splitResponseMarkdownBlocks } from "./response-markdown-blocks";
import { prepareResponseMarkdown } from "./response-markdown-preparation";
import { markdownSanitizeSchema, responseMediaLayout, responseUrlTransform } from "./response-markdown";

const remarkPlugins = [remarkGfm];

type MarkdownProps = {
  content: string;
  components: Components;
};

/** Renders the content as one Markdown document. */
export const ResponseMarkdownBlock = memo(function ResponseMarkdownBlock({ content, components }: MarkdownProps) {
  const prepared = useMemo(() => prepareResponseMarkdown(content), [content]);
  const rehypePlugins = useMemo<NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>>(() => [
    rehypeRaw, prepared.rehypeRestoreImages, [rehypeSanitize, markdownSanitizeSchema], responseMediaLayout,
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
