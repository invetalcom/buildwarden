import { normalizeResponseArtifactReferences } from "@buildwarden/shared";

type Node = { value?: string; properties?: Record<string, unknown>; children?: Node[] };

/** Keep megabytes of image bytes out of Markdown/HTML tokenization. Restore
 * them in the syntax tree BEFORE sanitization, so the usual URL policy applies.
 * Text/code examples are restored too; this does not change Markdown semantics.
 */
export const prepareResponseMarkdown = (content: string) => {
  let prefix = "buildwarden-embedded-image-";
  while (content.includes(prefix)) prefix = `_${prefix}`;
  const images: string[] = [];
  const compact = content.replace(/data:image\/[a-z\d.+-]+;base64,[a-z\d+/]+=*/gi, (source) => {
    images.push(source);
    return `${prefix}${images.length - 1}-end`;
  });
  const pattern = new RegExp(`${prefix}(\\d+)-end`, "g");
  const restore = (value: string) => value.includes(prefix)
    ? value.replace(pattern, (match, index: string) => images[Number(index)] ?? match)
    : value;
  const rehypeRestoreImages = () => (tree: Node): void => {
    if (!images.length) return;
    const visit = (node: Node) => {
      if (typeof node.value === "string") node.value = restore(node.value);
      if (node.properties) {
        for (const [key, value] of Object.entries(node.properties)) {
          if (typeof value === "string") node.properties[key] = restore(value);
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
  return { markdown: normalizeResponseArtifactReferences(compact), rehypeRestoreImages };
};
