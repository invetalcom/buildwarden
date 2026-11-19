/** `#target` links that point inside the same response (footnotes, heading links). */
export const isResponseAnchorHref = (href: string): boolean => href.length > 1 && href.startsWith("#");

const decodeFragment = (fragment: string) => {
  try { return decodeURIComponent(fragment); } catch { return fragment; }
};

/**
 * Sanitizing prefixes every id with `user-content-` (against DOM clobbering), while links keep the
 * id as written. Footnotes end up prefixed twice, because remark-gfm already prefixes them.
 * Several responses on one page also reuse ids such as `fn-1`, so look only inside this response.
 */
export const findResponseAnchorTarget = (link: Element, href: string): HTMLElement | null => {
  const container = link.closest(".response-markdown");
  if (!container) return null;
  const id = decodeFragment(href.slice(1));
  const elements = Array.from(container.querySelectorAll<HTMLElement>("[id]"));
  for (const candidate of [`user-content-${id}`, id]) {
    const match = elements.find((element) => element.id === candidate);
    if (match) return match;
  }
  return null;
};

const FLASH_CLASS = "response-anchor-flash";

export const scrollToResponseAnchor = (link: Element, href: string): boolean => {
  const target = findResponseAnchorTarget(link, href);
  if (!target) return false;
  target.scrollIntoView?.({ block: "center", behavior: "smooth" });
  target.classList.remove(FLASH_CLASS);
  // Restart the highlight when the same target is chosen twice.
  void target.offsetWidth;
  target.classList.add(FLASH_CLASS);
  window.setTimeout(() => target.classList.remove(FLASH_CLASS), 1600);
  return true;
};
