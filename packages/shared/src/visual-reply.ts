/**
 * Visual replies: an agent answers with a self-contained HTML page (a chart, table, diagram or
 * mockup) that the app shows above its written reply. The page runs in a sandboxed frame with an
 * opaque origin, so it cannot reach the app, the session or the host. It also cannot load anything
 * from the network: everything it needs must be inside the page.
 */

export const VISUAL_REPLY_TOOL_NAME = "buildwarden_show_visual";

/** Where the remote server serves a page to a browser client, followed by a signed ticket. */
export const VISUAL_REPLY_FRAME_PATH = "/visual/";

/** Limits for one page. Local images are embedded, so the stored page is larger than its source. */
export const VISUAL_REPLY_LIMITS = {
  maxTitleLength: 120,
  maxSourceBytes: 2 * 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
  maxPageBytes: 15 * 1024 * 1024,
} as const;

/** What a visual reply step stores in its metadata (`visualReply`); the page itself is an attachment file. */
export interface VisualReplyMetadata {
  title: string;
  blobId: string;
  byteLength: number;
}

/** How a client shows a stored page: as the frame's document (desktop) or from a signed host URL (browser). */
export type VisualReplyFrame = { kind: "document"; document: string } | { kind: "url"; url: string };

export const readVisualReplyMetadata = (metadata: Record<string, unknown>): VisualReplyMetadata | null => {
  const value = metadata.visualReply;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { title, blobId, byteLength } = value as Record<string, unknown>;
  return typeof title === "string" && typeof blobId === "string" && typeof byteLength === "number"
    ? { title, blobId, byteLength }
    : null;
};

/**
 * The page's own policy. Nothing may load from the network or leave the page: scripts, styles,
 * images and fonts must be inline or data URLs. The frame's sandbox is the real boundary; this
 * also stops a page from sending what it shows anywhere.
 */
export const VISUAL_REPLY_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Theme variables a page can read, filled in by the app from the current design. */
export const VISUAL_REPLY_THEME_VARIABLES = [
  "--bw-bg", "--bw-surface", "--bw-text", "--bw-muted", "--bw-border", "--bw-accent",
  "--bw-success", "--bw-warning", "--bw-danger", "--bw-info", "--bw-font", "--bw-font-mono",
  "--bw-chart-1", "--bw-chart-2", "--bw-chart-3", "--bw-chart-4", "--bw-chart-5", "--bw-chart-6", "--bw-chart-7",
] as const;

/** Messages between a page and the app. The app checks that each one comes from its own frame. */
export const VISUAL_REPLY_MESSAGES = {
  ready: "bw-visual-ready",
  size: "bw-visual-size",
  openLink: "bw-visual-open",
  theme: "bw-visual-theme",
} as const;

// Runs first in the page: applies the theme the app sends, reports the page height, and hands
// clicked web links to the app, which opens them in the browser.
const BOOTSTRAP_SCRIPT = `(() => {
  const post = (message) => parent.postMessage(message, "*");
  const root = document.documentElement;
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || data.type !== "${VISUAL_REPLY_MESSAGES.theme}") return;
    const vars = data.vars && typeof data.vars === "object" ? data.vars : {};
    for (const [name, value] of Object.entries(vars)) {
      if (/^--bw-[a-z0-9-]+$/.test(name) && typeof value === "string") root.style.setProperty(name, value);
    }
    const scheme = data.scheme === "light" ? "light" : "dark";
    root.style.colorScheme = scheme;
    root.dataset.theme = scheme;
  });
  let last = 0;
  const size = () => {
    const height = Math.ceil(Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0));
    if (height !== last) { last = height; post({ type: "${VISUAL_REPLY_MESSAGES.size}", height }); }
  };
  addEventListener("load", size);
  if (typeof ResizeObserver === "function") new ResizeObserver(size).observe(root);
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || (link.getAttribute("href") || "").startsWith("#")) return;
    event.preventDefault();
    try {
      const url = new URL(link.href);
      if (url.protocol === "http:" || url.protocol === "https:") post({ type: "${VISUAL_REPLY_MESSAGES.openLink}", url: url.href });
    } catch {}
  }, true);
  post({ type: "${VISUAL_REPLY_MESSAGES.ready}" });
})();`;

const HEAD_BLOCK = [
  '<meta charset="utf-8">',
  `<meta http-equiv="Content-Security-Policy" content="${VISUAL_REPLY_CONTENT_SECURITY_POLICY}">`,
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "<style>:root{color-scheme:light dark;--bw-bg:Canvas;--bw-surface:Canvas;--bw-text:CanvasText;--bw-muted:GrayText;--bw-border:GrayText;--bw-accent:LinkText;" +
    "--bw-font:system-ui,sans-serif;--bw-font-mono:ui-monospace,monospace}" +
    "html,body{margin:0;background:transparent;color:var(--bw-text);font-family:var(--bw-font)}</style>",
  `<script>${BOOTSTRAP_SCRIPT}</script>`,
].join("");

/**
 * The document a frame shows for a stored page: the policy, theme defaults and the bootstrap script
 * come first, before anything the page declares. The parser opens the head for them and then
 * ignores the page's own `<head>` tag and merges its `<html>` attributes, so a whole document and a
 * fragment both work, and no comment or odd markup in the page can move them.
 */
export const buildVisualReplyDocument = (html: string): string =>
  `<!doctype html>${HEAD_BLOCK}${html.replace(/^\uFEFF/, "").replace(/^\s*<!doctype[^>]*>/i, "")}`;
