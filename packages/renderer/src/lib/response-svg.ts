const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/** A complete SVG document: optional prolog/comments, then one <svg> root that is closed. */
const COMPLETE_SVG = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>][\s\S]*<\/svg\s*>\s*$/i;

export const isCompleteSvg = (source: string) => COMPLETE_SVG.test(source);

/** Inline SVG often omits its namespaces, without which an SVG file does not render as an image. */
const withNamespaces = (svg: string) => svg.replace(/<svg\b[^>]*>/i, (tag) => {
  let next = tag;
  if (!/\sxmlns\s*=/.test(next)) next = next.replace(/^<svg/i, `<svg xmlns="${SVG_NAMESPACE}"`);
  if (/\bxlink:/.test(svg) && !/\sxmlns:xlink\s*=/.test(next)) next = next.replace(/^<svg/i, `<svg xmlns:xlink="${XLINK_NAMESPACE}"`);
  return next;
});

const toBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

/** For <img> only: as an image, SVG cannot run scripts or load other resources. */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${toBase64(withNamespaces(svg.trim()))}`;

const svgTitle = (svg: string) => /<title[^>]*>([^<]{1,120})<\/title>/i.exec(svg)?.[1]?.trim();

/**
 * Raw `<svg>…</svg>` in Markdown is removed by sanitizing (leaving stray label text behind).
 * Turn each complete one into a Markdown image of itself instead.
 */
export const inlineSvgToImages = (prose: string): string =>
  prose.replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, (svg) => {
    const alt = (svgTitle(svg) ?? "SVG image").replace(/[[\]\\\n]/g, " ");
    return `![${alt}](${svgDataUrl(svg)})`;
  });
