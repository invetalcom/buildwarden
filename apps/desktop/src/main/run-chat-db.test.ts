import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";

const tempDirs: string[] = [];
const dbs: BuildWardenDatabase[] = [];

const makeDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-run-chat-db-"));
  tempDirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "buildwarden.sqlite"));
  await db.init();
  dbs.push(db);
  return db;
};

const addRunFixture = (db: BuildWardenDatabase) => {
  const project = db.addProject({
    repoPath: "C:\\repo",
    baseBranch: "main",
    resolvedName: "Repo",
  });
  const provider = db.addProviderAccount({
    providerType: "ai-sdk",
    label: "AI SDK",
    apiBaseUrl: null,
    apiKeyRef: "",
    configJson: "{}",
  });
  const model = db.addModel({
    providerAccountId: provider.id,
    modelId: "claude-fable-5",
    displayName: "Fable",
    config: {},
    capabilities: {},
    enabled: true,
  });
  const run = db.createRun({
    projectId: project.id,
    providerAccountId: provider.id,
    modelId: model.id,
    harnessType: "ai-sdk",
    mode: "code",
    workspaceType: "worktree",
    prompt: "Implement",
    branchName: "main",
    worktreePath: "C:\\repo\\.buildwarden-worktrees\\run",
  });
  return { project, provider, model, run };
};

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("run-scoped chats", () => {
  it("persists question answers, preserves questions, and rejects duplicate or invalid replies", async () => {
    const db = await makeDb();
    const { provider, model } = addRunFixture(db);
    const chat = db.createChat(provider.id, model.id, "Recommend a project");
    const questions = [{ id: "goal", header: "Goal", question: "What interests you?", multiSelect: true,
      options: [{ label: "AI" }, { label: "Web" }], allowCustomAnswer: false }];
    const step = db.appendChatEvent(chat.id, "user-input-requested", "Question", "", {
      userInputRequestId: "request-1", userInputQuestions: questions, requestStatus: "opened",
    });
    expect(() => db.resolveChatUserInput(chat.id, "request-1", { goal: "Other" })).toThrow("available options");
    const resolved = db.resolveChatUserInput(chat.id, "request-1", { goal: ["AI", "Web"] });
    expect(resolved.id).toBe(step.id);
    expect(JSON.parse(db.getChatSteps(chat.id)[0].metadataJson)).toMatchObject({
      userInputQuestions: questions, userInputAnswers: { goal: ["AI", "Web"] }, requestStatus: "resolved",
    });
    expect(() => db.resolveChatUserInput(chat.id, "request-1", { goal: "AI" })).toThrow("no longer waiting");
    const filePath = db.getFilePath();
    await db.close();
    dbs.splice(dbs.indexOf(db), 1);
    const reopened = new BuildWardenDatabase(filePath);
    await reopened.init();
    dbs.push(reopened);
    expect(JSON.parse(reopened.getChatSteps(chat.id)[0].metadataJson).userInputAnswers).toEqual({ goal: ["AI", "Web"] });
  });

  it("expires unanswered questions without discarding the conversation", async () => {
    const db = await makeDb();
    const { provider, model } = addRunFixture(db);
    const chat = db.createChat(provider.id, model.id, "Question");
    db.appendChatEvent(chat.id, "user-input-requested", "Question", "", {
      userInputRequestId: "old", userInputQuestions: [], requestStatus: "opened",
    });
    db.closeChatUserInputRequests(chat.id);
    expect(JSON.parse(db.getChatSteps(chat.id)[0].metadataJson).requestStatus).toBe("cancelled");
    expect(() => db.resolveChatUserInput(chat.id, "old", {})).toThrow("no longer waiting");
    expect(db.getChat(chat.id).prompt).toBe("Question");
  });

  it("records every reported run delta in the run, project, and daily ledger", async () => {
    const db = await makeDb();
    const { project, run } = addRunFixture(db);

    db.recordRunTokenUsage(run.id, 100, 20);
    db.recordRunTokenUsage(run.id, 50, 10);

    expect(db.getRun(run.id)).toMatchObject({ inputTokens: 150, outputTokens: 30 });
    expect(db.getProject(project.id)).toMatchObject({ cumulativeInputTokens: 150, cumulativeOutputTokens: 30 });
    expect(db.getTokenUsageSince("2000-01-01T00:00:00.000Z")).toEqual({ inputTokens: 150, outputTokens: 30 });
  });

  it("attributes run-chat usage to the run project and the daily usage ledger", async () => {
    const db = await makeDb();
    const { project, provider, model, run } = addRunFixture(db);
    const runChat = db.createChat(provider.id, model.id, "Question about the run", run.id);

    db.recordChatTokenUsage(runChat.id, project.id, 120, 30);

    expect(db.getChat(runChat.id)).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    expect(db.getProject(project.id)).toMatchObject({ cumulativeInputTokens: 120, cumulativeOutputTokens: 30 });
    expect(db.getTokenUsageSince("2000-01-01T00:00:00.000Z")).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it("keeps standalone chat usage in durable global and daily totals", async () => {
    const db = await makeDb();
    const { provider, model } = addRunFixture(db);
    const standalone = db.createChat(provider.id, model.id, "Standalone question");

    db.recordChatTokenUsage(standalone.id, null, 75, 25);

    expect(db.getStandaloneChatTokenUsage()).toEqual({ inputTokens: 75, outputTokens: 25 });
    expect(db.getTokenUsageSince("2000-01-01T00:00:00.000Z")).toEqual({ inputTokens: 75, outputTokens: 25 });
    db.deleteChat(standalone.id);
    expect(db.getStandaloneChatTokenUsage()).toEqual({ inputTokens: 75, outputTokens: 25 });
  });

  it("keeps run chats out of the standalone chat list", async () => {
    const db = await makeDb();
    const { provider, model, run } = addRunFixture(db);

    const standalone = db.createChat(provider.id, model.id, "Standalone question");
    const runChat = db.createChat(provider.id, model.id, "Question about the run", run.id);

    const listed = db.listChats();
    expect(listed.map((chat) => chat.id)).toEqual([standalone.id]);
    expect(db.getChat(runChat.id).runId).toBe(run.id);
    expect(db.getChat(standalone.id).runId).toBeNull();
  });

  it("returns the latest chat for a run", async () => {
    const db = await makeDb();
    const { provider, model, run } = addRunFixture(db);

    expect(db.getLatestChatForRun(run.id)).toBeNull();
    const chat = db.createChat(provider.id, model.id, "Question", run.id);
    expect(db.getLatestChatForRun(run.id)?.id).toBe(chat.id);
  });

  it("lists every chat attached to a run", async () => {
    const db = await makeDb();
    const { provider, model, run } = addRunFixture(db);

    expect(db.getChatsForRun(run.id)).toEqual([]);
    const first = db.createChat(provider.id, model.id, "First", run.id);
    const second = db.createChat(provider.id, model.id, "Second", run.id);
    db.createChat(provider.id, model.id, "Standalone");

    const ids = db.getChatsForRun(run.id).map((chat) => chat.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it("deletes run chats and their steps together with the run", async () => {
    const db = await makeDb();
    const { provider, model, run } = addRunFixture(db);

    const runChat = db.createChat(provider.id, model.id, "Question", run.id);
    db.appendChatEvent(runChat.id, "log", "Run context", "context", { source: "run-context" });
    db.appendChatEvent(runChat.id, "log", "Initial message", "Question", { source: "user" });
    const standalone = db.createChat(provider.id, model.id, "Standalone");

    db.deleteRun(run.id);

    expect(db.getLatestChatForRun(run.id)).toBeNull();
    expect(() => db.getChat(runChat.id)).toThrow();
    expect(db.getChatSteps(runChat.id)).toEqual([]);
    expect(db.getChat(standalone.id).id).toBe(standalone.id);
  });
});
