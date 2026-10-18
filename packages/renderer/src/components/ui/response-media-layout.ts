type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };
const meaningful = (nodes: Node[] = []) => nodes.filter((node) => node.type !== "text" || node.value?.trim());
const element = (tagName: string, children: Node[], className?: string): Node => ({
  type: "element", tagName, properties: className ? { className: [className] } : {}, children,
});
const hasImage = (node: Node): boolean => node.tagName === "img" || Boolean(node.children?.some(hasImage));
const isTitle = (node: Node, imageFirst = false): boolean => !hasImage(node) && (
  (imageFirst ? ["h3", "h4", "h5", "h6"] : ["h2", "h3", "h4", "h5", "h6"]).includes(node.tagName ?? "") ||
  (node.tagName === "p" && meaningful(node.children)[0]?.tagName === "strong")
);
const isDescription = (node: Node): boolean => node.tagName === "p" && meaningful(node.children).length > 0 && !hasImage(node) && !isTitle(node);

// Give a bold title its own line, retaining links/emphasis/code in the description.
const textBlocks = (node: Node): Node[] => {
  const parts = node.children ?? [];
  const titleIndex = parts.findIndex((part) => part.type !== "text" || part.value?.trim());
  if (node.tagName !== "p" || parts[titleIndex]?.tagName !== "strong") return [node];
  const description = parts.slice(titleIndex + 1);
  if (description[0]?.type === "text") {
    description[0] = { ...description[0], value: description[0].value?.replace(/^\s*(?:[—–-]|:)\s+/, "") };
  }
  while (description[0]?.tagName === "br") description.shift();
  return [element("p", [parts[titleIndex]]), ...(meaningful(description).length ? [element("p", description)] : [])];
};
const mediaRow = (image: Node, text: Node[]): Node => element("div", [
  element("div", [image], "response-media-image"),
  element("div", text.flatMap(textBlocks), "response-media-text"),
], "response-media-row");

// Only unambiguous single, direct images qualify. Linked images and multi-image paragraphs
// retain their original markup; never move images out of links or other blocks.
const splitImage = (nodes: Node[]): { image: Node; text: Node[] } | null => {
  const withImage = nodes.filter(hasImage);
  if (withImage.length !== 1 || withImage[0].tagName !== "img") return null;
  const image = withImage[0];
  const text = nodes.filter((node) => node !== image);
  while (text.length && (text[0].tagName === "br" || (text[0].type === "text" && !text[0].value?.trim()))) text.shift();
  while (text.length && (text.at(-1)?.tagName === "br" || (text.at(-1)?.type === "text" && !text.at(-1)?.value?.trim()))) text.pop();
  return { image, text };
};
const imageParagraph = (node: Node) => node.tagName === "p" ? splitImage(node.children ?? []) : null;
const nextContent = (nodes: Node[], start: number): number => {
  while (nodes[start]?.type === "text" && !nodes[start].value?.trim()) start++;
  return start;
};
const previousContent = (nodes: Node[], start: number): number => {
  while (nodes[start]?.type === "text" && !nodes[start].value?.trim()) start--;
  return start;
};
const phrasingTags = new Set(["strong", "em", "a", "img", "br", "code", "del", "sub", "sup", "span"]);

/** Provider-independent Markdown layout, applied AFTER sanitization.
 * Match a single image with an explicit heading/bold title and at most one
 * adjacent description. Keep list boundaries, other sections and multi-image paragraphs intact.
 */
export const responseMediaLayout = () => (tree: Node): void => {
  const visit = (parent: Node) => {
    if (!parent.children || ["pre", "code", "table"].includes(parent.tagName ?? "")) return;
    for (const child of parent.children) visit(child);
    const children = parent.children;

    // Tight Markdown lists have inline children directly inside <li>, without <p>.
    if (parent.tagName === "li") {
      const end = children.findIndex((node) => node.type !== "text" && !phrasingTags.has(node.tagName ?? ""));
      const count = end === -1 ? children.length : end;
      const inline = splitImage(children.slice(0, count));
      if (inline && meaningful(inline.text)[0]?.tagName === "strong") {
        children.splice(0, count, mediaRow(inline.image, [element("p", inline.text)]));
      }
    }

    // Inline title/description/image, in either order (including loose lists).
    for (let i = 0; i < children.length; i++) {
      const inline = imageParagraph(children[i]);
      if (inline && meaningful(inline.text)[0]?.tagName === "strong") {
        children[i] = mediaRow(inline.image, [element("p", inline.text)]);
      }
    }

    // Prefer image-first matches so a preceding section heading stays full width.
    for (let i = 0; i < children.length; i++) {
      const image = imageParagraph(children[i]);
      if (!image || image.text.length) continue;
      const titleIndex = nextContent(children, i + 1);
      const title = children[titleIndex];
      if (!title || !isTitle(title, true)) continue;
      const previousIndex = previousContent(children, i - 1);
      const previous = children[previousIndex];
      const beforeDescription = children[previousContent(children, previousIndex - 1)];
      if (previous && ((isTitle(previous) && previous.tagName !== "h2") ||
        (isDescription(previous) && beforeDescription && isTitle(beforeDescription)))) continue;
      const text = [title];
      let end = titleIndex + 1;
      const descriptionIndex = nextContent(children, end);
      if (children[descriptionIndex] && isDescription(children[descriptionIndex])) {
        text.push(children[descriptionIndex]);
        end = descriptionIndex + 1;
      }
      children.splice(i, end - i, mediaRow(image.image, text));
    }

    // Title, optional description, then image; also title followed by an image
    // and description in the same paragraph. Never search across another block.
    for (let i = 0; i < children.length; i++) {
      const title = children[i];
      if (!isTitle(title)) continue;
      let imageIndex = nextContent(children, i + 1);
      const text = [title];
      if (children[imageIndex] && isDescription(children[imageIndex])) {
        text.push(children[imageIndex]);
        imageIndex = nextContent(children, imageIndex + 1);
      }
      const image = children[imageIndex] && imageParagraph(children[imageIndex]);
      if (!image) continue;
      // A new bold title next to an image belongs to its own card.
      if (meaningful(image.text)[0]?.tagName === "strong") continue;
      if (image.text.length) text.push(element("p", image.text));
      let end = imageIndex + 1;
      if (text.length === 1) {
        const descriptionIndex = nextContent(children, end);
        if (children[descriptionIndex] && isDescription(children[descriptionIndex])) {
          text.push(children[descriptionIndex]);
          end = descriptionIndex + 1;
        }
      }
      children.splice(i, end - i, mediaRow(image.image, text));
    }
  };
  visit(tree);
};
