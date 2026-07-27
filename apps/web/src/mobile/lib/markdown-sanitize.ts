import { defaultSchema } from "rehype-sanitize";

/**
 * Sanitisation allow-list for rendered agent/user markdown.
 *
 * Agent output is untrusted: it can contain whatever a model emitted, including text pulled out of
 * the repository or off the network. Raw HTML is enabled (for `<details>`, `<img>`, task-list
 * checkboxes), so this schema is the thing standing between that text and script execution.
 *
 * It intentionally mirrors the desktop renderer's schema in
 * `packages/renderer/src/components/ui/activity-rich-text.tsx`; `markdown-sanitize.test.ts` fails
 * the build if the two stop agreeing on the tag and protocol allow-lists.
 */
export const MARKDOWN_EXTRA_TAG_NAMES = ["details", "summary", "sub", "img", "input", "br"] as const;

export const MARKDOWN_HREF_PROTOCOLS = ["http", "https", "mailto"] as const;
export const MARKDOWN_SRC_PROTOCOLS = ["http", "https"] as const;

export const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), ...MARKDOWN_EXTRA_TAG_NAMES])],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "href", "title"],
    details: ["open"],
    img: ["src", "alt", "title", "width", "height"],
    input: ["type", "checked", "disabled"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...MARKDOWN_HREF_PROTOCOLS],
    src: [...MARKDOWN_SRC_PROTOCOLS],
  },
};
