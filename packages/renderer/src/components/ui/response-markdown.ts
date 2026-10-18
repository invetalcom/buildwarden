import { defaultUrlTransform } from "react-markdown";
import { defaultSchema } from "rehype-sanitize";

export const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), "details", "summary", "sub", "img", "input", "br"])],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "href", "title"],
    details: ["open"],
    img: ["src", "alt", "title", "width", "height"],
    input: ["type", "checked", "disabled"],
  },
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto"], src: ["http", "https", "data"] },
};

export const safeResponseImageUrl = (url: string): string => {
  if (/^https?:\/\//i.test(url)) return url;
  // Raster data only. Never allow HTML, SVG, arbitrary protocols, or browser-relative host paths.
  if (url.length <= 7 * 1024 * 1024 && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(url)) return url;
  return "";
};

export const responseUrlTransform = (url: string, key: string): string =>
  key === "src" ? safeResponseImageUrl(url) : defaultUrlTransform(url);

type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };
const meaningful = (nodes: Node[] = []) => nodes.filter((node) => node.type !== "text" || node.value?.trim());
const element = (tagName: string, children: Node[], className?: string): Node => ({
  type: "element", tagName, properties: className ? { className: [className] } : {}, children,
});

/** Runs AFTER sanitization. Only this transform can create the layout classes.
 * Recognizes an image followed by a heading/bold title and optional subtitle, or an
 * image and bold title in one paragraph. Other Markdown keeps its original layout.
 */
export const responseMediaLayout = () => (tree: Node): void => {
  const visit = (parent: Node) => {
    if (!parent.children || ["pre", "code", "table"].includes(parent.tagName ?? "")) return;
    for (const child of parent.children) visit(child);
    const children = parent.children;
    for (let index = 0; index < children.length; index++) {
      const current = children[index];
      if (current.tagName !== "p") continue;
      const parts = meaningful(current.children);
      if (parts[0]?.tagName !== "img") continue;
      let text: Node[] = [];
      let end = index + 1;
      if (parts[1]?.tagName === "strong") {
        text = [element("p", parts.slice(1))];
      } else if (parts.length === 1) {
        while (children[end]?.type === "text" && !children[end].value?.trim()) end++;
        const title = children[end];
        if (!title || !(["h3", "h4"].includes(title.tagName ?? "") ||
          (title.tagName === "p" && meaningful(title.children)[0]?.tagName === "strong"))) continue;
        text.push(title);
        end++;
        let subtitle = end;
        while (children[subtitle]?.type === "text" && !children[subtitle].value?.trim()) subtitle++;
        const next = children[subtitle];
        if (next?.tagName === "p" && !meaningful(next.children).some((node) => node.tagName === "img" || node.tagName === "strong")) {
          text.push(next);
          end = subtitle + 1;
        }
      }
      if (!text.length) continue;
      children.splice(index, end - index, element("div", [
        element("div", [parts[0]], "response-media-image"),
        element("div", text, "response-media-text"),
      ], "response-media-row"));
    }
  };
  visit(tree);
};
