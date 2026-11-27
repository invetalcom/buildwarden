import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildVisualReplyDocument,
  readVisualReplyMetadata,
  VISUAL_REPLY_FRAME_PATH,
  VISUAL_REPLY_LIMITS,
  VISUAL_REPLY_TOOL_NAME,
  type RunToolResult,
} from "@buildwarden/shared";
import { createWorkspaceImageLoader, NONBLOCKING_READ_FLAGS } from "../response-images";
import { isPathInsideRoot } from "../run-workspace-file";
import { AppService } from "./app-service";
import { parseMetadataRecord } from "./run-step-content";

const FRAME_TICKET_TTL_MS = 10 * 60 * 1000;

const failure = (callId: string, content: string): RunToolResult => ({ toolCallId: callId, name: VISUAL_REPLY_TOOL_NAME, ok: false, content });

/** Reads a workspace file that must stay inside the workspace, also through links. */
const readWorkspaceText = (workspacePath: string, requested: string, maxBytes: number): string => {
  const root = resolve(workspacePath);
  const candidate = resolve(root, requested);
  if (!isPathInsideRoot(root, candidate)) throw new Error("The path must point to a file inside the workspace.");
  const target = realpathSync(candidate);
  if (!isPathInsideRoot(realpathSync(root), target)) throw new Error("The path must point to a file inside the workspace.");
  // Never blocks on a FIFO; the descriptor check below rejects it.
  const handle = openSync(target, NONBLOCKING_READ_FLAGS);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) throw new Error("The path is not a file.");
    if (stat.size > maxBytes) throw new Error(`The page is larger than ${String(Math.round(maxBytes / 1024 / 1024))} MB.`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(handle);
  }
};

// Elements whose content is text, not markup: an `<img>` written inside them is not an image.
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);
const IMAGE_SOURCE_ATTRIBUTES = new Set(["src", "href", "xlink:href"]);
const TAG_NAME = /<([a-zA-Z][^\s/>]*)/y;
const FOREIGN_END_TAG = /<\/(?:svg|math)[\s/>]/iy;
const isHtmlSpace = (char: string | undefined): boolean => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

interface StartTagAttribute { name: string; value: string | null; valueStart: number; valueEnd: number }

/**
 * Reads the attributes of a start tag from `start`, just after its name, the way the HTML tokenizer
 * does: a quoted value runs to its closing quote, so a `>` or text that looks like an attribute
 * inside it stays part of the value. Returns the attributes, the index after the tag and whether it
 * ends with `/>`.
 */
const readStartTag = (html: string, start: number): { attributes: StartTagAttribute[]; end: number; selfClosing: boolean } => {
  const attributes: StartTagAttribute[] = [];
  let index = start;
  while (index < html.length) {
    const char = html[index];
    if (char === "/" && html[index + 1] === ">") return { attributes, end: index + 2, selfClosing: true };
    if (isHtmlSpace(char) || char === "/") {
      index += 1;
      continue;
    }
    if (char === ">") return { attributes, end: index + 1, selfClosing: false };
    const nameStart = index;
    index += 1;
    while (index < html.length && !isHtmlSpace(html[index]) && !"/>=".includes(html[index]!)) index += 1;
    const name = html.slice(nameStart, index).toLowerCase();
    let cursor = index;
    while (isHtmlSpace(html[cursor])) cursor += 1;
    if (html[cursor] !== "=") {
      attributes.push({ name, value: null, valueStart: index, valueEnd: index });
      index = cursor;
      continue;
    }
    cursor += 1;
    while (isHtmlSpace(html[cursor])) cursor += 1;
    const quote = html[cursor];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, cursor + 1);
      const valueEnd = close < 0 ? html.length : close + 1;
      attributes.push({ name, value: html.slice(cursor + 1, close < 0 ? html.length : close), valueStart: cursor, valueEnd });
      index = valueEnd;
    } else {
      let valueEnd = cursor;
      while (valueEnd < html.length && !isHtmlSpace(html[valueEnd]) && html[valueEnd] !== ">") valueEnd += 1;
      attributes.push({ name, value: html.slice(cursor, valueEnd), valueStart: cursor, valueEnd });
      index = valueEnd;
    }
  }
  return { attributes, end: html.length, selfClosing: false };
};

/**
 * Replaces workspace image paths in `<img src>` and SVG `<image href>` with data URLs. Relative paths
 * resolve against `baseDirectory`, the folder of a page file. Only images in the page's markup are
 * embedded: comments and the text of elements such as `<script>` and `<style>` stay as written.
 * Inside SVG and MathML those elements hold markup, as in the HTML parser.
 * Returns null once the page would grow past `maxBytes`: every reference counts, also repeats of
 * one image the loader has cached.
 */
export const embedVisualReplyImages = (
  html: string,
  workspacePath: string,
  baseDirectory = workspacePath,
  maxBytes: number = VISUAL_REPLY_LIMITS.maxPageBytes,
): string | null => {
  const load = createWorkspaceImageLoader(workspacePath, baseDirectory);
  let bytes = Buffer.byteLength(html);
  if (bytes > maxBytes) return null;
  const parts: string[] = [];
  let copied = 0;
  // How many <svg> or <math> elements are open: their content is markup, also in <title> or <style>.
  let foreignDepth = 0;
  let index = html.indexOf("<");
  while (index >= 0) {
    if (html.startsWith("<!--", index)) {
      const close = html.indexOf("-->", index + 4);
      index = close < 0 ? -1 : html.indexOf("<", close + 3);
      continue;
    }
    TAG_NAME.lastIndex = index;
    const tag = TAG_NAME.exec(html);
    // End tags, doctypes and a lone `<` in text hold no images.
    if (!tag) {
      FOREIGN_END_TAG.lastIndex = index;
      if (foreignDepth > 0 && FOREIGN_END_TAG.test(html)) foreignDepth -= 1;
      index = html.indexOf("<", index + 1);
      continue;
    }
    const name = tag[1]!.toLowerCase();
    const { attributes, end, selfClosing } = readStartTag(html, index + tag[0].length);
    if ((name === "svg" || name === "math") && !selfClosing) foreignDepth += 1;
    if (name === "img" || name === "image") {
      for (const attribute of attributes) {
        if (!IMAGE_SOURCE_ATTRIBUTES.has(attribute.name) || !attribute.value) continue;
        const source = attribute.value.replace(/&amp;/g, "&");
        const embedded = load(source);
        if (embedded === source) continue;
        const replacement = `"${embedded}"`;
        // The total already holds the original reference; add what the replacement changes.
        bytes += Buffer.byteLength(replacement) - Buffer.byteLength(html.slice(attribute.valueStart, attribute.valueEnd));
        if (bytes > maxBytes) return null;
        parts.push(html.slice(copied, attribute.valueStart), replacement);
        copied = attribute.valueEnd;
      }
    }
    let next = end;
    // An HTML <title/> still opens raw text: HTML ignores the slash, SVG and MathML do not.
    if (foreignDepth === 0 && RAW_TEXT_ELEMENTS.has(name)) {
      const close = new RegExp(`</${name}[\\s/>]`, "ig");
      close.lastIndex = end;
      next = close.exec(html)?.index ?? html.length;
    }
    index = html.indexOf("<", next);
  }
  parts.push(html.slice(copied));
  return parts.join("");
};

/**
 * Stores the pages agents show with `buildwarden_show_visual` and hands them to clients. A desktop
 * client gets the document for its frame; a browser client gets a short-lived signed address on
 * the host, because a browser page's own policy would block the page's scripts in an inline frame.
 */
export class VisualReplyService extends AppService<"runEvents"> {
  private readonly ticketKey = randomBytes(32);

  async showVisual(runId: string, callId: string, args: Record<string, unknown>): Promise<RunToolResult> {
    const run = this.db.getRun(runId);
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title || title.length > VISUAL_REPLY_LIMITS.maxTitleLength) {
      return failure(callId, `Give the page a title of 1–${String(VISUAL_REPLY_LIMITS.maxTitleLength)} characters.`);
    }
    const inline = typeof args.html === "string" && args.html.trim() ? args.html : null;
    const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : null;
    if (Boolean(inline) === Boolean(path)) return failure(callId, "Pass the page either as `html` or as a workspace `path`, not both.");
    let source: string;
    try {
      source = inline ?? readWorkspaceText(run.worktreePath, path!, VISUAL_REPLY_LIMITS.maxSourceBytes);
    } catch (error) {
      return failure(callId, `Could not read the page: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Buffer.byteLength(source) > VISUAL_REPLY_LIMITS.maxSourceBytes) {
      return failure(callId, "The page is larger than 2 MB. Write it to a workspace file and keep data compact.");
    }
    const baseDirectory = path ? dirname(resolve(run.worktreePath, path)) : run.worktreePath;
    const embedded = embedVisualReplyImages(source, run.worktreePath, baseDirectory);
    const page = embedded === null ? null : Buffer.from(embedded, "utf8");
    if (!page || page.byteLength > VISUAL_REPLY_LIMITS.maxPageBytes) return failure(callId, "The page with its images is larger than 15 MB. Use fewer or smaller images.");

    const stored = this.db.putAttachmentBlob(page);
    const metadata = { assistantKind: "visual", toolCallId: callId, visualReply: { title, ...stored } };
    const content = `[Visual reply shown to the user: ${title}]`;
    const step = await this.services.runEvents.appendRunEvent(runId, "output", "Visual reply", content, metadata);
    this.services.runEvents.emitEvent({ runId, type: "output", title: "Visual reply", content, metadata, createdAt: step.createdAt, step });
    return {
      toolCallId: callId,
      name: VISUAL_REPLY_TOOL_NAME,
      ok: true,
      content: `The page "${title}" is shown to the user above your reply (${String(Math.ceil(page.byteLength / 1024))} KB). Now write your reply without repeating the page.`,
    };
  }

  /** The stored page of a visual reply step; throws when the step or its page is gone. */
  private getVisualReplyBlobId(runId: string, stepId: string): string {
    const step = this.db.getRunStep(runId, stepId);
    const visual = step ? readVisualReplyMetadata(parseMetadataRecord(step.metadataJson)) : null;
    if (!visual) throw new Error("This visual reply is no longer available.");
    return visual.blobId;
  }

  /** The frame document of a visual reply step. */
  getVisualReplyDocument(runId: string, stepId: string): string {
    const blob = this.db.getAttachmentBlob(this.getVisualReplyBlobId(runId, stepId));
    if (!blob) throw new Error("The page of this visual reply was removed.");
    return buildVisualReplyDocument(Buffer.from(blob.dataBase64, "base64").toString("utf8"));
  }

  /** A signed path that lets a browser frame load the page for ten minutes, without the session. */
  createFrameTicketPath(runId: string, stepId: string): string {
    // Only checks that the page exists; the frame loads it with the ticket.
    if (!this.db.hasAttachmentBlob(this.getVisualReplyBlobId(runId, stepId))) throw new Error("The page of this visual reply was removed.");
    const payload = Buffer.from(JSON.stringify({ runId, stepId, expiresAt: Date.now() + FRAME_TICKET_TTL_MS })).toString("base64url");
    return `${VISUAL_REPLY_FRAME_PATH}${payload}.${this.sign(payload)}`;
  }

  /** The document for a ticket from {@link createFrameTicketPath}, or null when it is forged, expired or gone. */
  resolveFrameTicket(ticket: string): string | null {
    const [payload, signature, extra] = ticket.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const { runId, stepId, expiresAt } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
      if (typeof runId !== "string" || typeof stepId !== "string" || typeof expiresAt !== "number" || expiresAt < Date.now()) return null;
      return this.getVisualReplyDocument(runId, stepId);
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.ticketKey).update(payload).digest("base64url");
  }
}
