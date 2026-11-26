/**
 * Frames inside the app window are visual reply pages, which the renderer loads from `srcdoc`. A
 * sandboxed frame may still navigate itself, and no page policy stops that, so a page could carry
 * what it shows to another host in a URL. The window lets its frames load only the inline document
 * and an empty page; anything else is refused before a request is made.
 */
export const isAllowedEmbeddedFrameUrl = (raw: string): boolean => raw === "about:srcdoc" || raw === "about:blank";
