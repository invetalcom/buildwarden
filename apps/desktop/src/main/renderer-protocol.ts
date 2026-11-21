import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

/**
 * The packaged renderer loads from this privileged scheme instead of file://. Chromium keeps a V8
 * code cache only for http(s) and for custom schemes that opt in with `codeCache`, so file://
 * scripts were compiled again on every launch. A standard, secure scheme also gives the renderer a
 * real origin for storage, fetch and module workers.
 */
export const RENDERER_SCHEME = "buildwarden-app";
const RENDERER_HOST = "bundle";
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`;
export const RENDERER_INDEX_URL = `${RENDERER_ORIGIN}/index.html`;
/** An empty document on the renderer origin, for writing migrated storage before the app loads. */
export const RENDERER_BLANK_URL = `${RENDERER_ORIGIN}/__blank.html`;

const BLANK_DOCUMENT = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

type SchemePrivilegeRegistrar = {
  registerSchemesAsPrivileged(schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>): void;
};

/** Must run before the app is ready. */
export const registerRendererSchemePrivileges = (protocol: SchemePrivilegeRegistrar): void => {
  protocol.registerSchemesAsPrivileged([{
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  }]);
};

export const isRendererUrl = (raw: string): boolean => {
  try {
    // Node reports the origin of custom schemes as "null", so compare its parts.
    const url = new URL(raw);
    return url.protocol === `${RENDERER_SCHEME}:` && url.host === RENDERER_HOST;
  } catch {
    return false;
  }
};

/** Serves files below `rootDirectory`; everything else is 404. Reads go through Node, so asar archives work. */
export const createRendererRequestHandler = (rootDirectory: string) => {
  const root = resolve(rootDirectory);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host !== RENDERER_HOST) return new Response(null, { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    if (url.pathname === "/__blank.html") {
      return new Response(request.method === "HEAD" ? null : BLANK_DOCUMENT, { headers: { "content-type": CONTENT_TYPES[".html"]! } });
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (pathname.includes("\0")) return new Response(null, { status: 400 });
    const filePath = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!filePath.startsWith(root + sep)) return new Response(null, { status: 404 });
    try {
      if (!(await stat(filePath)).isFile()) return new Response(null, { status: 404 });
      const contents = await readFile(filePath);
      return new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
        headers: { "content-type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream" },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
};
