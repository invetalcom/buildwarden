import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, sessionTitle } from "@buildwarden/shared";
import { SessionTitleService, type TitleGenerationInput } from "./session-titles";
import { validateUtilityText } from "./utility-text-generation";

const fixtures: Array<{ db: BuildWardenDatabase; dir: string; service: SessionTitleService }> = [];
const fixture = async (generate = vi.fn<(input: TitleGenerationInput) => Promise<string>>().mockResolvedValue("Repair login redirects")) => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-titles-"));
  const db = new BuildWardenDatabase(join(dir, "state.sqlite"));
  await db.init();
  const project = db.addProject({ repoPath: dir, baseBranch: "main", resolvedName: "Project" });
  const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "Provider", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
  const run = db.createRun({ projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "ai-sdk",
    mode: "code", workspaceType: "local", branchName: "main", worktreePath: dir, prompt: "Please investigate login redirects and fix them" });
  const chat = db.createChat(provider.id, model.id, "Explain our login redirects");
  db.appendRunStep(run.id, "log", "Initial command", run.prompt, JSON.stringify({ source: "user", commandType: "initial" }));
  db.appendChatEvent(chat.id, "log", "Initial message", chat.prompt, { source: "user", commandType: "initial" });
  const publish = vi.fn();
  const warn = vi.fn();
  const service = new SessionTitleService(db, generate, publish, warn);
  fixtures.push({ db, dir, service });
  return { db, run, chat, project, model, generate, publish, service };
};

afterEach(async () => {
  vi.useRealTimers();
  for (const { db, dir, service } of fixtures.splice(0)) {
    service.cancelAll(true);
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("saved run and chat titles", () => {
  it("defaults on, preserves prompts and activity timestamps, and reaches every list and bookmark", async () => {
    const { db, run, chat, project, service } = await fixture();
    db.addBookmark(run.id);
    db.addChatBookmark(chat.id);
    await service.regenerate("run", run.id, true);
    await service.regenerate("chat", chat.id, true);
    expect(db.getRun(run.id)).toMatchObject({ title: "Repair login redirects", prompt: run.prompt, updatedAt: run.updatedAt, titleGenerationPending: 0 });
    expect(db.getChat(chat.id)).toMatchObject({ title: "Repair login redirects", prompt: chat.prompt, updatedAt: chat.updatedAt });
    expect(db.listRunsForProject(project.id, true)[0]?.title).toBe("Repair login redirects");
    expect(db.listChats()[0]?.title).toBe("Repair login redirects");
    expect(db.listAllChats()[0]?.title).toBe("Repair login redirects");
    expect(db.getBookmarksWithSteps()[0]?.title).toBe("Repair login redirects");
    expect(db.getChatBookmarksWithSteps()[0]?.title).toBe("Repair login redirects");
    await db.close();
    await db.init();
    expect(db.getRun(run.id).title).toBe("Repair login redirects");
  });

  it("restores prompt labels when disabled, retains saved titles and rejects mutations", async () => {
    const { db, run, service, generate } = await fixture();
    service.rename("run", run.id, "  Fix   login  ");
    db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
    expect(sessionTitle(db.getRun(run.id))).toBe(run.prompt);
    service.startInitial("run", run.id);
    expect(generate).not.toHaveBeenCalled();
    await expect(service.regenerate("run", run.id)).rejects.toThrow("disabled");
    expect(() => service.rename("run", run.id, "New name")).toThrow("disabled");
    db.addBookmark(run.id);
    expect(db.getBookmarksWithSteps()[0]?.title).toBeNull();
    db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "true");
    expect(db.getRun(run.id).title).toBe("Fix login");
    expect(db.getBookmarksWithSteps()[0]?.title).toBe("Fix login");
  });

  it("does not overwrite a manual rename with a late result or duplicate the call", async () => {
    let resolve!: (value: string) => void;
    const generate = vi.fn<(input: TitleGenerationInput) => Promise<string>>(() => new Promise((done) => { resolve = done; }));
    const { db, run, service } = await fixture(generate);
    const pending = service.regenerate("run", run.id);
    expect(db.getRun(run.id).titleGenerationPending).toBe(1);
    await expect(service.regenerate("run", run.id)).rejects.toThrow("already");
    service.rename("run", run.id, "My login fix");
    resolve("Stale generated title");
    await pending;
    expect(db.getRun(run.id)).toMatchObject({ title: "My login fix", titleGenerationPending: 0 });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("ignores results after the toggle is switched off and back on", async () => {
    let resolve!: (value: string) => void;
    const generate = vi.fn<(input: TitleGenerationInput) => Promise<string>>(() => new Promise((done) => { resolve = done; }));
    const { db, chat, service } = await fixture(generate);
    const pending = service.regenerate("chat", chat.id);
    db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
    service.cancelAll();
    db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "true");
    resolve("Stale title");
    await pending;
    expect(db.getChat(chat.id)).toMatchObject({ title: null, titleGenerationPending: 0 });
    expect(generate.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it("uses conversation context, attachment text and separate title model/instructions", async () => {
    const { db, chat, service, generate } = await fixture();
    db.setSetting(APP_SETTING_KEYS.sessionTitleModelId, "title-model");
    db.setSetting(APP_SETTING_KEYS.sessionTitleInstructions, "Use German titles.");
    db.appendChatEvent(chat.id, "log", "Follow-up", "Focus on password reset", { source: "user",
      attachments: [{ fileName: "notes.txt", mimeType: "text/plain", dataBase64: Buffer.from("Redirect loses reset token").toString("base64") }] });
    db.appendChatEvent(chat.id, "output", "Response", "The reset token is dropped.");
    db.appendChatEvent(chat.id, "tool-result", "Shell", "INCIDENTAL TOOL OUTPUT");
    await service.regenerate("chat", chat.id);
    const input = generate.mock.calls[0]![0];
    expect(input.modelId).toBe("title-model");
    expect(input.systemPrompt).toContain("Use German titles.");
    expect(input.prompt).toContain("USER: Focus on password reset");
    expect(input.prompt).toContain("Redirect loses reset token");
    expect(input.prompt).toContain("ASSISTANT: The reset token is dropped.");
    expect(input.prompt).not.toContain("INCIDENTAL TOOL OUTPUT");
  });

  it("retries initial failures twice, clears progress and keeps the fallback on failure", async () => {
    const generate = vi.fn<(input: TitleGenerationInput) => Promise<string>>().mockRejectedValue(new Error("Unavailable"));
    const { db, run, service } = await fixture(generate);
    const pending = service.regenerate("run", run.id, true);
    const rejected = expect(pending).rejects.toThrow("Unavailable");
    await rejected;
    expect(generate).toHaveBeenCalledTimes(3);
    expect(db.getRun(run.id)).toMatchObject({ title: null, titleGenerationPending: 0 });
    expect(sessionTitle(db.getRun(run.id))).toBe(run.prompt);
  }, 10000);

  it("treats deleted owners and stale request IDs as no-ops", async () => {
    const { db, chat } = await fixture();
    expect(db.beginSessionTitle("chat", chat.id, "old")).toBe(true);
    db.renameSessionTitle("chat", chat.id, "Manual title");
    expect(db.finishSessionTitle("chat", chat.id, "old", "Stale")).toBe(false);
    expect(db.beginSessionTitle("chat", chat.id, "new")).toBe(true);
    db.deleteChat(chat.id);
    expect(db.finishSessionTitle("chat", chat.id, "new", "Deleted")).toBe(false);
  });

  it("validates generated titles and normalizes whitespace", () => {
    expect(validateUtilityText('{"title":"  Repair   login redirects  "}', "session-title")).toBe("Repair login redirects");
    for (const value of ['{}', '{"title":42}', '{"title":" "}', JSON.stringify({ title: "x".repeat(121) })]) {
      expect(() => validateUtilityText(value, "session-title")).toThrow();
    }
  });
});
