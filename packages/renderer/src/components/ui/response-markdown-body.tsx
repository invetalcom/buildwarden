import { memo, useMemo, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { prepareResponseMarkdown } from "./response-markdown-preparation";
import { markdownSanitizeSchema, responseMediaLayout, responseUrlTransform } from "./response-markdown";

const remarkPlugins = [remarkGfm];

export const ResponseMarkdownBody = memo(function ResponseMarkdownBody({ content, components }: {
  content: string;
  components: Components;
}) {
  const prepared = useMemo(() => prepareResponseMarkdown(content), [content]);
  const rehypePlugins = useMemo<NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>>(() => [
    rehypeRaw, prepared.rehypeRestoreImages, [rehypeSanitize, markdownSanitizeSchema], responseMediaLayout,
  ], [prepared]);
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}
    urlTransform={responseUrlTransform} components={components}>{prepared.markdown}</ReactMarkdown>;
});
