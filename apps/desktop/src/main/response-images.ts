import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeResponseArtifactReferences } from "@buildwarden/shared";
import { isPathInsideRoot } from "./run-workspace-file";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_IMAGE_BYTES = 15 * 1024 * 1024;

const imageMime = (bytes: Buffer): string | null => {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
};

/** Embed workspace images before persisting/streaming, so bookmarks and remote clients retain them.
 * Never fetch URLs or read arbitrary host paths. Failed/partial references remain plain Markdown.
 */
export const createResponseImageEmbedder = (workspacePath: string) => {
  const cache = new Map<string, string>();
  let totalBytes = 0;
  const embed = (source: string): string => {
    if (/^(?:https?:|data:|blob:|\/\/)/i.test(source)) return source;
    const cached = cache.get(source);
    if (cached) return cached;
    let handle: number | undefined;
    try {
      let path = source.startsWith("file:") ? fileURLToPath(source) : decodeURIComponent(source);
      if (path.startsWith("sandbox:")) path = path.slice(8).replace(/^\/+/, "");
      if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return source;
      const workspaceRoot = resolve(workspacePath);
      const candidate = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
      // Reject lexical escapes (including UNC paths) before any filesystem lookup.
      if (!isPathInsideRoot(workspaceRoot, candidate)) return source;
      const root = realpathSync(workspaceRoot);
      const target = realpathSync(candidate);
      if (!isPathInsideRoot(root, target)) return source;
      handle = openSync(target, "r");
      const stat = fstatSync(handle);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES || stat.size + totalBytes > MAX_RESPONSE_IMAGE_BYTES) return source;
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(handle, bytes, offset, bytes.length - offset, offset);
        if (!count) return source;
        offset += count;
      }
      const mime = imageMime(bytes);
      if (!mime) return source;
      const data = `data:${mime};base64,${bytes.toString("base64")}`;
      totalBytes += bytes.length;
      cache.set(source, data);
      return data;
    } catch {
      return source;
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  };
  return (content: string): string => normalizeResponseArtifactReferences(content).replace(
    /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)|(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^\s)]+)([^\n)]*\))/g,
    (match: string, code: string | undefined, prefix: string, destination: string, suffix: string) => {
      if (code) return match;
      const source = destination.startsWith("<") ? destination.slice(1, -1) : destination;
      // Codex commonly writes [Screenshot](path.png). Only promote links when
      // the target is a validated local raster image; ordinary links stay links.
      const image = prefix.startsWith("!");
      if (!image && !/\.(?:png|jpe?g|gif|webp)$/i.test(source)) return match;
      const resolved = embed(source);
      return resolved === source ? match : `${image ? "" : "!"}${prefix}${resolved}${suffix}`;
    },
  );
};

/** Hydrate older output on read without modifying history or fetching remote URLs. */
export const hydrateResponseImageSteps = <T extends { eventType: string; content: string; metadataJson: string }>(
  workspacePath: string,
  steps: T[],
): T[] => {
  const embed = createResponseImageEmbedder(workspacePath);
  return steps.map((step) => {
    if (step.eventType !== "output") return step;
    const content = embed(step.content);
    if (content === step.content) return step;
    let metadata: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(step.metadataJson || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch { /* legacy metadata */ }
    return { ...step, content, metadataJson: JSON.stringify({ ...metadata, responseSourceText: metadata.responseSourceText ?? step.content }) };
  });
};
