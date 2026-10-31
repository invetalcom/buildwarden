import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("marks only shortened fields as previews in project and loop run lists", async () => {
    const db = await makeDb();
    const { project, run, model } = addRunFixture(db);
    const loop = db.createProjectLoop({ projectId: project.id, name: "Loop", prompt: "Loop", runnerModelId: model.id,
      mergePolicy: "wait-for-approval", uiChangePolicy: "auto", baseBranch: "main", status: "completed" });
    const iteration = db.createProjectLoopIteration({ loopId: loop.id, iterationIndex: 0, title: "Step", objective: "Step" });
    db.updateProjectLoopIteration(iteration.id, { runId: run.id });
    const raw = new DatabaseSync(db.getFilePath());
    try {
      for (const field of ["prompt", "goal_text", "summary", "error_message"]) {
        for (const length of [499, 500, 501]) {
          raw.prepare("update runs set prompt = 'Prompt', goal_text = null, summary = '', error_message = null where id = ?").run(run.id);
          raw.prepare(`update runs set ${field} = ? where id = ?`).run("x".repeat(length), run.id);
          const rows = [db.listRunsForProject(project.id, true)[0], db.listProjectLoopListItems(project.id)[0]?.runs[0]];
          for (const row of rows) {
            expect(row).toMatchObject({ textIsPreview: length > 500, promptIsPreview: field === "prompt" && length > 500 });
            expect(row?.prompt.length).toBe(field === "prompt" ? Math.min(length, 500) : 6);
          }
        }
      }
      expect(db.getRun(run.id).textIsPreview).toBeUndefined();
    } finally { raw.close(); }
  });
  it("does not rewrite summaries for ordinary logs and backfills within existing transactions", async () => {
    const db = await makeDb();
    const { run } = addRunFixture(db);
    db.getRun(run.id);
    const raw = new DatabaseSync(db.getFilePath());
    try {
      raw.exec("create table summary_deletes (id text); create trigger audit_summary_delete after delete on run_list_summaries begin insert into summary_deletes values(old.run_id); end;");
      db.appendRunStep(run.id, "log", "Progress", "Working", '{}');
      db.appendRunStep(run.id, "log", "Progress", "Working", 'invalid json');
      expect(raw.prepare("select count(*) as count from summary_deletes").get()).toMatchObject({ count: 0 });
      db.appendRunStep(run.id, "log", "User", "Follow up", '{"source":"user"}');
      expect(raw.prepare("select count(*) as count from summary_deletes").get()).toMatchObject({ count: 1 });
      raw.exec("delete from run_list_summaries");
      expect(() => db.transaction(() => db.getRun(run.id))).not.toThrow();
    } finally { raw.close(); }
  });

  it("keeps large bodies out of snapshots while preserving detail, search, and hidden-run links", async () => {
    const db = await makeDb();
    const { project, provider, model } = addRunFixture(db);
    const body = "Large saved body ".repeat(20_000);
    const run = db.createRun({ projectId: project.id, providerAccountId: provider.id, modelId: model.id,
      harnessType: "ai-sdk", mode: "code", workspaceType: "worktree", kind: "lab-implementation",
      prompt: body + "search-at-the-end", branchName: "lab", worktreePath: "C:\\repo\\lab" });
    const thread = db.createProjectLabThread({ projectId: project.id, kind: "implementation", mode: "new-feature",
      status: "completed", origin: "manual", title: "Lab", summary: "Summary", seedPrompt: body,
      implementationPrompt: body, implementationRunId: run.id });
    db.appendProjectLabEvent({ threadId: thread.id, role: "implementation", label: "Output", content: body });
    db.upsertProjectInsight({ projectId: project.id, kind: "codebase-mood", title: "Mood", summary: "Summary", dataJson: JSON.stringify({ body }) });
    const loop = db.createProjectLoop({ projectId: project.id, name: "Loop", prompt: body, runnerModelId: model.id,
      mergePolicy: "wait-for-approval", uiChangePolicy: "auto", baseBranch: "main", status: "completed" });
    const iteration = db.createProjectLoopIteration({ loopId: loop.id, iterationIndex: 0, title: "Iteration", objective: body });
    db.updateProjectLoopIteration(iteration.id, { runId: run.id, processedCommentIdsJson: JSON.stringify([body]) });

    const snapshot = db.getSnapshot(project.id, run.id);
    expect(JSON.stringify(snapshot).length).toBeLessThan(20_000);
    const entry = snapshot.projects[0]!;
    expect(entry.labThreads[0]).toMatchObject({ eventCount: 1, implementationRun: { id: run.id, textIsPreview: true } });
    expect(entry.labThreads[0]?.events).toBeUndefined();
    expect(entry.insights[0]?.dataJson).toBeUndefined();
    expect(entry.loops[0]?.iterations[0]?.runId).toBe(run.id);
    expect(entry.loops[0]?.runs[0]?.prompt.length).toBe(500);
    expect(db.getProjectLabThreadDetail(thread.id).events[0]?.content).toBe(body);
    expect(db.listProjectInsights(project.id)[0]?.dataJson).toContain(body);
    expect(db.getProjectLoopDetail(loop.id).iterations[0]?.objective).toBe(body);
    expect(db.getRun(run.id).prompt).toBe(body + "search-at-the-end");
    expect(db.searchRunUserInput("search-at-the-end")).toEqual([run.id]);
    db.appendProjectLabEvent({ threadId: thread.id, role: "review", label: "Review", content: body });
    expect(db.getSnapshot().projects[0]?.labThreads[0]?.eventCount).toBe(2);
  });

  it("reopens run lists without replaying history and keeps appended summaries durable", async () => {
    const db = await makeDb();
    const { project, run } = addRunFixture(db);
    const prompt = db.appendRunStep(run.id, "log", "Follow-up", "Persisted follow-up", '{"source":"user"}');
    db.appendRunStep(run.id, "user-input-requested", "Question", "Choose", '{"requestKind":"user-input","requestStatus":"opened"}');
    const path = db.getFilePath();
    await db.close();
    const reopened = new BuildWardenDatabase(path);
    dbs.push(reopened);
    await reopened.init();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      expect(reopened.listRunsForProject(project.id)[0]).toMatchObject({
        lastUserInputAt: prompt.createdAt,
        pendingUserInputRequest: true,
      });
      expect(prepare.mock.calls.some(([sql]) => sql.includes("from run_steps"))).toBe(false);
      // Search remains complete without putting historical prompts in list summaries.
      expect(reopened.searchRunUserInput("Persisted follow-up")).toEqual([run.id]);
    } finally {
      prepare.mockRestore();
    }
  });

  it("backfills missing summaries once and invalidates edits across restart", async () => {
    const db = await makeDb();
    const { run } = addRunFixture(db);
    const question = db.appendRunStep(run.id, "user-input-requested", "Question", "Choose", '{"requestKind":"user-input","requestStatus":"opened"}');
    const raw = new DatabaseSync(db.getFilePath());
    raw.exec("delete from run_list_summaries");
    raw.close();
    expect(db.getRun(run.id).pendingUserInputRequest).toBe(true);
    db.updateRunStep(question.id, { metadataJson: '{"requestKind":"user-input","requestStatus":"resolved"}' });
    await db.close();
    const reopened = new BuildWardenDatabase(db.getFilePath());
    dbs.push(reopened);
    await reopened.init();
    expect(reopened.getRun(run.id).pendingUserInputRequest).toBe(false);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      reopened.getRun(run.id);
      expect(prepare.mock.calls.some(([sql]) => sql.includes("from run_steps"))).toBe(false);
    } finally {
      prepare.mockRestore();
    }
    reopened.deleteRun(run.id);
    const reader = new DatabaseSync(reopened.getFilePath());
    expect(reader.prepare("select count(*) as count from run_list_summaries").get()).toMatchObject({ count: 0 });
    reader.close();
  });

  it("rolls back persisted summaries and discards cached uncommitted history", async () => {
    const db = await makeDb();
    const { run } = addRunFixture(db);
    expect(() => db.transaction(() => {
      db.appendRunStep(run.id, "log", "Follow-up", "rolledback", '{"source":"user"}');
      db.appendRunStep(run.id, "user-input-requested", "Question", "Choose", '{"requestKind":"user-input","requestStatus":"opened"}');
      throw new Error("Rollback");
    })).toThrow("Rollback");
    expect(db.getRun(run.id)).toMatchObject({ lastUserInputAt: run.createdAt, pendingUserInputRequest: false });
    expect(db.searchRunUserInput("rolledback")).toEqual([]);
  });

  it("does not rescan user history after output replacements, but refreshes edited user history", async () => {
    const db = await makeDb();
    const { run } = addRunFixture(db);
    const user = db.appendRunStep(run.id, "log", "Prompt", "originalsearch", '{"source":"user"}');
    const output = db.appendRunStep(run.id, "output", "Answer", "Hello");
    expect(db.searchRunUserInput("originalsearch")).toEqual([run.id]);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      db.updateRunStep(output.id, { content: "Hello world" });
      prepare.mockClear();
      db.getRun(run.id);
      expect(db.searchRunUserInput("originalsearch")).toEqual([run.id]);
      expect(prepare.mock.calls.some(([sql]) => sql.includes("from run_steps"))).toBe(false);

      db.updateRunStep(user.id, { content: "editedsearch" });
      expect(db.searchRunUserInput("originalsearch")).toEqual([]);
      expect(db.searchRunUserInput("editedsearch")).toEqual([run.id]);
      db.updateRunStep(output.id, { eventType: "log", content: "convertedsearch", metadataJson: '{"source":"user"}' });
      expect(db.searchRunUserInput("convertedsearch")).toEqual([run.id]);
      db.updateRunStep(output.id, { eventType: "output" });
      expect(db.searchRunUserInput("convertedsearch")).toEqual([]);

      const request = db.appendRunStep(run.id, "user-input-requested", "Question", "Choose", JSON.stringify({ requestKind: "user-input", requestStatus: "opened" }));
      expect(db.getRun(run.id).pendingUserInputRequest).toBe(true);
      db.updateRunStep(request.id, { metadataJson: JSON.stringify({ requestKind: "user-input", requestStatus: "resolved", userInputAnswers: { choice: "answersearch" } }) });
      expect(db.getRun(run.id).pendingUserInputRequest).toBe(false);
      expect(db.searchRunUserInput("answersearch")).toEqual([run.id]);
    } finally {
      prepare.mockRestore();
    }
  });

  it("returns source-only search results while retaining display images in the transcript", async () => {
    const db = await makeDb();
    const { provider, model } = addRunFixture(db);
    const chat = db.createChat(provider.id, model.id, "Images");
    const image = `![Preview](data:image/png;base64,${"ABCD".repeat(50_000)})`;
    db.appendChatEvent(chat.id, "output", "Answer", image, { responseSourceText: "Description ![Preview](preview.png)", attachments: [{ data: image }] });
    db.appendChatEvent(chat.id, "output", "Legacy", image + " Legacy description");
    const result = db.listChatsWithSteps().find((item) => item.chat.id === chat.id)!;
    expect(result.steps[0].content).toBe("Description ![Preview](preview.png)");
    expect(result.steps[1].content).toContain("Legacy description");
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(JSON.stringify(result).length).toBeLessThan(2000);
    expect(db.getChatDetail(chat.id).steps[0].content).toBe(image);
  });
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

  it("stores provider, model, and token-category attribution for cost estimates", async () => {
    const db = await makeDb();
    const { project, provider, model, run } = addRunFixture(db);
    const standalone = db.createChat(provider.id, model.id, "Standalone question");
    const attribution = { providerType: "claude-code", modelId: "claude-sonnet-4-5" };

    db.recordRunTokenUsage(run.id, 1_000, 100, { ...attribution, cacheReadTokens: 800, cacheWriteTokens: 150, reasoningTokens: 40 });
    db.recordRunTokenUsage(run.id, 500, 50, { ...attribution, cacheReadTokens: 450 });
    db.recordChatTokenUsage(standalone.id, null, 300, 30, { providerType: "codex-cli", modelId: "gpt-5", cacheReadTokens: 200 });
    db.recordProjectTokenUsage(project.id, "model-call", "call-1", 70, 7);

    const rows = db.listTokenUsageCostRows("2000-01-01T00:00:00.000Z");
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectId: project.id, projectName: "Repo", providerType: "claude-code", modelId: "claude-sonnet-4-5",
        inputTokens: 1_500, outputTokens: 150, cacheReadTokens: 1_250, cacheWriteTokens: 150, reasoningTokens: 40,
      }),
      expect.objectContaining({ projectId: null, providerType: "codex-cli", modelId: "gpt-5", inputTokens: 300, cacheReadTokens: 200 }),
      expect.objectContaining({ projectId: project.id, providerType: null, modelId: null, inputTokens: 70, outputTokens: 7 }),
    ]));
    expect(rows[0]?.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(db.listTokenUsageCostRows(null, "hour")[0]?.bucket).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    expect(db.listTokenUsageCostRows("2999-01-01T00:00:00.000Z")).toEqual([]);
    expect(db.listTokenUsageCostRows(null)).toHaveLength(3);
    // Existing counters keep using processed input totals.
    expect(db.getRun(run.id)).toMatchObject({ inputTokens: 1_500, outputTokens: 150 });
  });

  it("skips an excluded time range, buckets by week or month, and ranks models by all-time usage", async () => {
    const db = await makeDb();
    const { run } = addRunFixture(db);
    db.recordRunTokenUsage(run.id, 1_000, 10, { providerType: "codex-cli", modelId: "gpt-5" });
    db.recordRunTokenUsage(run.id, 5_000, 50, { providerType: "claude-code", modelId: "claude-sonnet-5-5" });

    const everything = { from: "2000-01-01T00:00:00.000Z", to: "2999-01-01T00:00:00.000Z" };
    expect(db.listTokenUsageCostRows(null, "day", everything)).toEqual([]);
    expect(db.listTokenUsageCostRows(null, "day", { from: "2000-01-01T00:00:00.000Z", to: "2000-01-02T00:00:00.000Z" })).toHaveLength(2);

    const [week] = db.listTokenUsageCostRows(null, "week");
    expect(new Date(`${week!.bucket}T00:00:00`).getDay()).toBe(1);
    expect(db.listTokenUsageCostRows(null, "month")[0]?.bucket).toMatch(/^\d{4}-\d{2}$/);

    expect(db.getTokenUsageRanks()).toEqual({
      models: [{ providerType: "claude-code", modelId: "claude-sonnet-5-5" }, { providerType: "codex-cli", modelId: "gpt-5" }],
      projectIds: [run.projectId],
    });
    expect(db.getEarliestTokenUsageAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("adds attribution columns to a pre-existing usage ledger without losing its rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buildwarden-usage-ledger-"));
    tempDirs.push(dir);
    const filePath = join(dir, "buildwarden.sqlite");
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`create table token_usage_events (
      id text primary key, project_id text, owner_kind text not null, owner_id text not null,
      input_tokens integer not null, output_tokens integer not null, created_at text not null
    );
    insert into token_usage_events values ('legacy-1', null, 'chat', 'chat-1', 40, 4, '2026-01-02T10:00:00.000Z');`);
    legacy.close();

    const db = new BuildWardenDatabase(filePath);
    await db.init();
    dbs.push(db);

    expect(db.listTokenUsageCostRows(null)).toEqual([expect.objectContaining({
      modelId: null, providerType: null, inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    })]);
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
