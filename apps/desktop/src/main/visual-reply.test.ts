import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import {
  APP_SETTING_KEYS,
  buildVisualReplyDocument,
  readVisualReplyMetadata,
  VISUAL_REPLY_CONTENT_SECURITY_POLICY,
  VISUAL_REPLY_FRAME_PATH,
  VISUAL_REPLY_TOOL_NAME,
} from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "./app-controller";
import { serviceOf } from "./controller-test-internals";
import { HostEventBus } from "./host-events";
import { embedVisualReplyImages } from "./services/visual-reply-service";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const roots: Array<{ root: string; db: BuildWardenDatabase }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const { root, db } of roots.splice(0)) {
    await db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** A folder project with one run whose workspace holds a page and an image. */
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-visual-"));
  const workspace = join(root, "project");
  mkdirSync(join(workspace, "out"), { recursive: true });
  writeFileSync(join(workspace, "chart.png"), PNG);
  writeFileSync(join(workspace, "out", "report.html"), '<h1>Report</h1><img src="../chart.png" alt="Chart">');
  writeFileSync(join(root, "secret.html"), "<p>outside</p>");

  const db = new BuildWardenDatabase(join(root, "buildwarden.sqlite"));
  await db.init();
  roots.push({ root, db });
  db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
  const project = db.addProject({ repoPath: workspace, baseBranch: "", resolvedName: "Pages", kind: "folder" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "gpt-test", displayName: "GPT test", config: {}, capabilities: {}, enabled: true });
  const run = db.createRun({
    projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server",
    mode: "code", workspaceType: "local", workspaceVcs: "folder", prompt: "Show me", branchName: "", worktreePath: workspace,
  });
  const events = new HostEventBus();
  const controller = new AppController(db, { readSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => undefined }, join(root, "logs"),
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, events);
  return { root, db, controller, run, service: serviceOf(controller, "visualReplies") };
};

const visualSteps = (db: BuildWardenDatabase, runId: string) =>
  db.getRunSteps(runId).filter((step) => readVisualReplyMetadata(JSON.parse(step.metadataJson) as Record<string, unknown>));

describe("visual replies", () => {
  it("stores an inline page as a step and serves it with the policy first", async () => {
    const { db, controller, run, service } = await setup();
    const result = await service.showVisual(run.id, "call-1", { title: "Sales by month", html: "<html lang=\"en\"><head><style>h1{color:red}</style></head><body><h1>Sales</h1></body></html>" });
    expect(result).toMatchObject({ ok: true, toolCallId: "call-1", name: VISUAL_REPLY_TOOL_NAME });

    const [step] = visualSteps(db, run.id);
    expect(step).toMatchObject({ eventType: "output", content: "[Visual reply shown to the user: Sales by month]" });
    const metadata = JSON.parse(step!.metadataJson) as Record<string, unknown>;
    expect(metadata).toMatchObject({ assistantKind: "visual", toolCallId: "call-1" });
    // The page stays out of SQLite and is kept by the blob cleanup.
    expect(step!.metadataJson).not.toContain("Sales</h1>");
    db.collectUnreferencedAttachmentBlobs(0, Date.now() + 60_000);
    expect(db.getAttachmentBlob(readVisualReplyMetadata(metadata)!.blobId)).not.toBeNull();

    const frame = await controller.getVisualReplyFrame(run.id, step!.id);
    expect(frame.kind).toBe("document");
    const document = frame.kind === "document" ? frame.document : "";
    expect(document.startsWith(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VISUAL_REPLY_CONTENT_SECURITY_POLICY}">`)).toBe(true);
    expect(document).toContain("<h1>Sales</h1>");
  });

  it("reads a workspace page and embeds its workspace images", async () => {
    const { db, controller, run, service } = await setup();
    await expect(service.showVisual(run.id, "call-2", { title: "Report", path: "out/report.html" })).resolves.toMatchObject({ ok: true });
    const [step] = visualSteps(db, run.id);
    const frame = await controller.getVisualReplyFrame(run.id, step!.id);
    expect(frame.kind === "document" ? frame.document : "").toContain(`<img src="data:image/png;base64,${PNG.toString("base64")}" alt="Chart">`);
  });

  it("refuses bad arguments and pages outside the workspace", async () => {
    const { root, db, run, service } = await setup();
    // Windows refuses file links without developer mode; the lexical escape below still runs there.
    let linked = true;
    try {
      symlinkSync(join(root, "secret.html"), join(run.worktreePath, "linked.html"));
    } catch {
      linked = false;
    }
    const attempts: Array<Record<string, unknown>> = [
      { html: "<p>no title</p>" },
      { title: "Both", html: "<p>x</p>", path: "out/report.html" },
      { title: "Neither" },
      { title: "Escape", path: "../secret.html" },
      ...(linked ? [{ title: "Link", path: "linked.html" }] : []),
      { title: "Missing", path: "out/missing.html" },
      { title: "Huge", html: "x".repeat(2 * 1024 * 1024 + 1) },
    ];
    for (const args of attempts) {
      await expect(service.showVisual(run.id, "call", args)).resolves.toMatchObject({ ok: false });
    }
    expect(visualSteps(db, run.id)).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO page without waiting for a writer", async () => {
    const { db, run, service } = await setup();
    execFileSync("mkfifo", [join(run.worktreePath, "pipe.html")]);
    await expect(service.showVisual(run.id, "call", { title: "Pipe", path: "pipe.html" })).resolves.toMatchObject({ ok: false });
    expect(visualSteps(db, run.id)).toHaveLength(0);
  });

  it("lets a signed ticket load the page for ten minutes and refuses forged ones", async () => {
    const { db, controller, run, service } = await setup();
    await service.showVisual(run.id, "call-3", { title: "Ticket", html: "<p>ticketed</p>" });
    const [step] = visualSteps(db, run.id);
    const frame = await controller.getVisualReplyFrameUrl(run.id, step!.id);
    expect(frame.kind).toBe("url");
    const path = frame.kind === "url" ? frame.url : "";
    expect(path.startsWith(VISUAL_REPLY_FRAME_PATH)).toBe(true);
    const ticket = path.slice(VISUAL_REPLY_FRAME_PATH.length);
    expect(controller.resolveVisualReplyFrameTicket(ticket)).toContain("<p>ticketed</p>");

    const [payload, signature] = ticket.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ runId: run.id, stepId: "other", expiresAt: Date.now() + 60_000 })).toString("base64url");
    expect(controller.resolveVisualReplyFrameTicket(`${forgedPayload}.${signature!}`)).toBeNull();
    expect(controller.resolveVisualReplyFrameTicket(`${payload!}.${signature!.slice(1)}x`)).toBeNull();
    expect(controller.resolveVisualReplyFrameTicket(`${payload!}`)).toBeNull();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(controller.resolveVisualReplyFrameTicket(ticket)).toBeNull();
  });

  it("does not hand out tickets for steps that are not visual replies", async () => {
    const { db, controller, run } = await setup();
    const answer = db.appendRunStep(run.id, "output", "Agent output", "Plain answer", "{}");
    await expect(controller.getVisualReplyFrameUrl(run.id, answer.id)).rejects.toThrow("no longer available");
  });
});

describe("visual reply documents", () => {
  it("puts the policy before anything the page declares", () => {
    const tricky = "<!DOCTYPE html><!-- <head> --><script>fetch('https://example.invalid')</script><p>x</p>";
    const document = buildVisualReplyDocument(tricky);
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("example.invalid"));
    expect(document.match(/<!doctype/gi)).toHaveLength(1);
  });

  it("blocks every network request in the policy", () => {
    expect(VISUAL_REPLY_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(VISUAL_REPLY_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(VISUAL_REPLY_CONTENT_SECURITY_POLICY).not.toMatch(/https?:/);
  });

  it("embeds only images that are inside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "buildwarden-visual-images-"));
    try {
      writeFileSync(join(root, "a.png"), PNG);
      const html = embedVisualReplyImages('<img src="a.png"><svg><image href="a.png"/></svg><img src="https://example.com/x.png"><img src="../b.png">', root);
      expect(html.match(/data:image\/png;base64,/g)).toHaveLength(2);
      expect(html).toContain('src="https://example.com/x.png"');
      expect(html).toContain('src="../b.png"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
