import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase, INITIAL_HISTORY_WINDOW_LIMITS } from "@buildwarden/db";

const tempDirs: string[] = [];
const dbs: BuildWardenDatabase[] = [];

const makeDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-history-page-"));
  tempDirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "buildwarden.sqlite"));
  await db.init();
  dbs.push(db);
  return db;
};

const makeFixture = (db: BuildWardenDatabase) => {
  const project = db.addProject({ repoPath: "C:\\repo", baseBranch: "main", resolvedName: "Repo" });
  const provider = db.addProviderAccount({
    providerType: "claude-code",
    label: "Claude",
    apiBaseUrl: null,
    apiKeyRef: "",
    configJson: "{}",
  });
  const model = db.addModel({
    providerAccountId: provider.id,
    modelId: "claude-sonnet",
    displayName: "Claude",
    config: {},
    capabilities: {},
    enabled: true,
  });
  const run = db.createRun({
    projectId: project.id,
    providerAccountId: provider.id,
    modelId: model.id,
    harnessType: "claude-code",
    mode: "code",
    workspaceType: "worktree",
    prompt: "Initial prompt",
    branchName: "main",
    worktreePath: "C:\\repo",
  });
  const chat = db.createChat(provider.id, model.id, "Initial prompt");
  return { run, chat };
};

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("user-anchored history pagination", () => {
  it("keeps complete run turns while paging 10 initial and 20 earlier user messages", async () => {
    const db = await makeDb();
    const { run } = makeFixture(db);
    for (let index = 0; index < 31; index += 1) {
      db.appendRunStep(run.id, "log", `user-${String(index)}`, `prompt-${String(index)}`, JSON.stringify({ source: "user" }));
      db.appendRunStep(run.id, "output", `assistant-${String(index)}`, `answer-${String(index)}`);
      await nextTick();
    }

    const initial = db.getInitialRunHistory(run.id);
    expect(initial.steps.filter((step) => step.title.startsWith("user-")).map((step) => step.title))
      .toEqual(Array.from({ length: 10 }, (_, index) => `user-${String(index + 21)}`));
    expect(initial.steps.filter((step) => step.title.startsWith("assistant-"))).toHaveLength(10);
    expect(initial.page.hasMore).toBe(true);

    const middle = db.getEarlierRunHistory(run.id, {
      beforeCursor: initial.page.beforeCursor!,
      snapshotRevision: initial.page.snapshotRevision,
    });
    expect(middle.stale).toBe(false);
    expect(middle.steps.filter((step) => step.title.startsWith("user-")).map((step) => step.title))
      .toEqual(Array.from({ length: 20 }, (_, index) => `user-${String(index + 1)}`));
    expect(middle.steps.filter((step) => step.title.startsWith("assistant-"))).toHaveLength(20);
    expect(middle.page.hasMore).toBe(true);

    const oldest = db.getEarlierRunHistory(run.id, {
      beforeCursor: middle.page.beforeCursor!,
      snapshotRevision: middle.page.snapshotRevision,
    });
    expect(oldest.steps.map((step) => step.title)).toEqual(["user-0", "assistant-0"]);
    expect(oldest.page).toMatchObject({ beforeCursor: null, hasMore: false });
  });

  it("rejects a stale prefix revision and applies the same turn boundary to chats", async () => {
    const db = await makeDb();
    const { chat } = makeFixture(db);
    for (let index = 0; index < 12; index += 1) {
      db.appendChatEvent(chat.id, "log", `user-${String(index)}`, `prompt-${String(index)}`, { source: "user" });
      db.appendChatEvent(chat.id, "output", `assistant-${String(index)}`, `answer-${String(index)}`);
      await nextTick();
    }

    const initial = db.getInitialChatHistory(chat.id);
    expect(initial.steps.filter((step) => step.title.startsWith("user-")).map((step) => step.title))
      .toEqual(["user-2", "user-3", "user-4", "user-5", "user-6", "user-7", "user-8", "user-9", "user-10", "user-11"]);
    const stale = db.getEarlierChatHistory(chat.id, {
      beforeCursor: initial.page.beforeCursor!,
      snapshotRevision: "stale-revision",
    });
    expect(stale.stale).toBe(true);
    expect(stale.steps).toEqual([]);
  });

  it("caps a single long turn by size and pages the rest without gaps", async () => {
    const db = await makeDb();
    const { run } = makeFixture(db);
    db.appendRunStep(run.id, "log", "user-0", "prompt-0", JSON.stringify({ source: "user" }));
    const largeResult = "x".repeat(400_000);
    for (let index = 0; index < 10; index += 1) {
      db.appendRunStep(run.id, "tool-result", `tool-${String(index)}`, largeResult);
    }

    const initial = db.getInitialRunHistory(run.id);
    const initialChars = initial.steps.reduce((total, step) => total + step.content.length, 0);
    expect(initialChars).toBeLessThanOrEqual(INITIAL_HISTORY_WINDOW_LIMITS.maxChars);
    expect(initial.steps.at(-1)?.title).toBe("tool-9");
    expect(initial.page.hasMore).toBe(true);

    const titles = initial.steps.map((step) => step.title);
    let page = initial.page;
    while (page.hasMore && page.beforeCursor) {
      const earlier = db.getEarlierRunHistory(run.id, { beforeCursor: page.beforeCursor, snapshotRevision: page.snapshotRevision });
      expect(earlier.stale).toBe(false);
      expect(earlier.steps.length).toBeGreaterThan(0);
      titles.unshift(...earlier.steps.map((step) => step.title));
      page = earlier.page;
    }
    expect(titles).toEqual(["user-0", ...Array.from({ length: 10 }, (_, index) => `tool-${String(index)}`)]);
  });

  it("always includes the newest step even when it exceeds the size budget", async () => {
    const db = await makeDb();
    const { run } = makeFixture(db);
    db.appendRunStep(run.id, "log", "user-0", "prompt-0", JSON.stringify({ source: "user" }));
    db.appendRunStep(run.id, "tool-result", "huge", "x".repeat(INITIAL_HISTORY_WINDOW_LIMITS.maxChars + 1));

    const initial = db.getInitialRunHistory(run.id);
    expect(initial.steps.map((step) => step.title)).toEqual(["huge"]);
    expect(initial.page.hasMore).toBe(true);
  });
});
