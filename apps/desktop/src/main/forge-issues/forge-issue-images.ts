import { isForgeHostedImageUrl } from "@buildwarden/shared";
import type { ProjectPrReviewRemoteContext } from "../pr-review/pr-review-types";

/** Largest image handed to the renderer; its data URL must stay under the renderer's own 7 MB limit. */
export const FORGE_ISSUE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

const ASSET_ID_PATTERN = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i;

/** The id GitHub gives an uploaded attachment; it appears in both the Markdown URL and the signed download URL. */
export const githubAssetId = (url: string): string | null => {
  try {
    return ASSET_ID_PATTERN.exec(new URL(url).pathname)?.[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
};

/**
 * Reads the image addresses out of rendered issue HTML. For attachments, GitHub puts short-lived
 * signed URLs there, which are the only way to download images of private repositories.
 */
export const extractSignedGithubImageUrls = (html: string): Map<string, string> => {
  const urls = new Map<string, string>();
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)) {
    const url = (match[1] ?? "").replace(/&amp;/g, "&");
    const assetId = githubAssetId(url);
    if (assetId && url.startsWith("https://")) urls.set(assetId, url);
  }
  return urls;
};

/** Raster formats only: the bytes decide, not the header a server sent. */
export const sniffImageMimeType = (bytes: Uint8Array): string | null => {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
};

type ImageAttempt = { url: string; headers: Record<string, string>; authHost: string | null };

/**
 * Where to try loading an image from, in order. Credentials are only ever attached for the Git host itself,
 * never for a storage host a redirect leads to.
 */
export const planForgeIssueImageAttempts = (context: ProjectPrReviewRemoteContext, token: string | null, url: string): ImageAttempt[] => {
  const target = new URL(url);
  const attempts: ImageAttempt[] = [];
  if (context.provider === "github") {
    // Only github.com itself sees the token; images on githubusercontent.com are public or carry their own signature.
    if (token !== null && target.hostname === "github.com") attempts.push({ url, headers: { Authorization: `Bearer ${token}` }, authHost: "github.com" });
    attempts.push({ url, headers: {}, authHost: null });
    return attempts;
  }
  const upload = /\/uploads\/([\da-f]{32,})\/([^/?#]+)$/i.exec(target.pathname);
  if (token !== null && upload?.[1] && upload[2] && context.gitlab) {
    // Uploads of private projects are only served to a browser session; the API accepts the token.
    attempts.push({
      url: `${context.apiBaseUrl}/projects/${context.gitlab.encodedProjectPath}/uploads/${upload[1]}/${upload[2]}`,
      headers: { "PRIVATE-TOKEN": token },
      authHost: new URL(context.apiBaseUrl).host,
    });
  }
  attempts.push({ url, headers: {}, authHost: null });
  return attempts;
};

const fetchFollowingRedirects = async (attempt: ImageAttempt, signal: AbortSignal): Promise<Response> => {
  let current = attempt.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = new URL(current);
    if (target.protocol !== "https:") throw new Error("The image address is not secure (https).");
    const response = await fetch(current, {
      headers: { Accept: "image/*", ...(attempt.authHost === target.host ? attempt.headers : {}) },
      redirect: "manual",
      signal,
    });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return response;
    void response.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
  }
  throw new Error("The image address redirects too often.");
};

const readImage = async (response: Response): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FORGE_ISSUE_IMAGE_MAX_BYTES) throw new Error("The image is too large to show here.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > FORGE_ISSUE_IMAGE_MAX_BYTES) throw new Error("The image is too large to show here.");
  const mimeType = sniffImageMimeType(bytes);
  if (!mimeType) throw new Error("The file is not a PNG, JPEG, GIF, or WebP image.");
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
};

export interface LoadForgeIssueImageInput {
  context: ProjectPrReviewRemoteContext;
  token: string | null;
  url: string;
  /** Looks up a signed download address for a GitHub attachment that could not be read directly. */
  resolveSignedUrl?: (assetId: string) => Promise<string | null>;
}

/** Downloads an issue image as a data URL. Throws when the image is not on the Git host or cannot be read. */
export const loadForgeIssueImage = async (input: LoadForgeIssueImageInput): Promise<string> => {
  const { context, token, url } = input;
  if (!isForgeHostedImageUrl(context.provider, context.webBaseUrl, url)) {
    throw new Error("Only images hosted by the project's Git host are loaded automatically.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Loading the image timed out.")), IMAGE_REQUEST_TIMEOUT_MS);
  try {
    let failure = "The image could not be loaded.";
    for (const attempt of planForgeIssueImageAttempts(context, token, url)) {
      const response = await fetchFollowingRedirects(attempt, controller.signal);
      if (response.ok) return await readImage(response);
      void response.body?.cancel().catch(() => {});
      failure = `The Git host answered ${String(response.status)} for this image.`;
    }
    const assetId = context.provider === "github" ? githubAssetId(url) : null;
    const signedUrl = assetId && input.resolveSignedUrl ? await input.resolveSignedUrl(assetId) : null;
    if (signedUrl) {
      const response = await fetchFollowingRedirects({ url: signedUrl, headers: {}, authHost: null }, controller.signal);
      if (response.ok) return await readImage(response);
      void response.body?.cancel().catch(() => {});
      failure = `The Git host answered ${String(response.status)} for this image.`;
    }
    throw new Error(failure);
  } finally {
    clearTimeout(timer);
  }
};
