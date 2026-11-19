import { defaultUrlTransform } from "react-markdown";
import { defaultSchema } from "rehype-sanitize";
import { DEEP_LINK_SCHEME, DEV_DEEP_LINK_SCHEME, parseDeepLinkUrl } from "@buildwarden/shared";

const APP_LINK_SCHEMES = [DEEP_LINK_SCHEME, DEV_DEEP_LINK_SCHEME];

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
  // App links only navigate inside BuildWarden; see `deep-links.ts`.
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto", ...APP_LINK_SCHEMES], src: ["http", "https", "data"] },
};

export const safeResponseImageUrl = (url: string): string => {
  if (/^https?:\/\//i.test(url)) {
    try { new URL(url); return url; } catch { return ""; }
  }
  // Raster data only. Never allow HTML, SVG, arbitrary protocols, or browser-relative host paths.
  if (url.length <= 7 * 1024 * 1024 && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(url)) return url;
  return "";
};

export const responseUrlTransform = (url: string, key: string): string =>
  key === "src" ? safeResponseImageUrl(url)
    : key === "href" && parseDeepLinkUrl(url, { schemes: APP_LINK_SCHEMES }) ? url
    : defaultUrlTransform(url);

export { responseMediaLayout } from "./response-media-layout";
