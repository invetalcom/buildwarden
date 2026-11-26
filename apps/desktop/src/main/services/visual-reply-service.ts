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

/**
 * Replaces workspace image paths in `<img src>` and SVG `<image href>` with data URLs. Relative paths
 * resolve against `baseDirectory`, the folder of a page file.
 */
export const embedVisualReplyImages = (html: string, workspacePath: string, baseDirectory = workspacePath): string => {
  const load = createWorkspaceImageLoader(workspacePath, baseDirectory);
  // Values may be quoted or, as HTML allows, bare (`<img src=chart.png>`).
  return html.replace(/(<(?:img|image)\b[^>]*?\s(?:src|href|xlink:href)\s*=\s*)(?:(["'])([^"']+)\2|([^\s"'=<>`]+))/gi,
    (match: string, prefix: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      const source = (quoted ?? bare ?? "").replace(/&amp;/g, "&");
      const embedded = load(source);
      return embedded === source ? match : `${prefix}${quote ?? '"'}${embedded}${quote ?? '"'}`;
    });
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
    const page = Buffer.from(embedVisualReplyImages(source, run.worktreePath, baseDirectory), "utf8");
    if (page.byteLength > VISUAL_REPLY_LIMITS.maxPageBytes) return failure(callId, "The page with its images is larger than 15 MB. Use fewer or smaller images.");

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

  /** The frame document of a visual reply step. */
  getVisualReplyDocument(runId: string, stepId: string): string {
    const step = this.db.getRunSteps(runId).find((entry) => entry.id === stepId);
    const visual = step ? readVisualReplyMetadata(parseMetadataRecord(step.metadataJson)) : null;
    if (!visual) throw new Error("This visual reply is no longer available.");
    const blob = this.db.getAttachmentBlob(visual.blobId);
    if (!blob) throw new Error("The page of this visual reply was removed.");
    return buildVisualReplyDocument(Buffer.from(blob.dataBase64, "base64").toString("utf8"));
  }

  /** A signed path that lets a browser frame load the page for ten minutes, without the session. */
  createFrameTicketPath(runId: string, stepId: string): string {
    this.getVisualReplyDocument(runId, stepId);
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
