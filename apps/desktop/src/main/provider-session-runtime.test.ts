import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";

const tempDirs: string[] = [];
const dbs: BuildWardenDatabase[] = [];

const makeDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-provider-session-"));
  tempDirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "buildwarden.sqlite"));
  await db.init();
  dbs.push(db);
  return db;
};

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("provider session runtime persistence", () => {
  it("round-trips durable resume cursors and runtime payloads", async () => {
    const db = await makeDb();

    const saved = db.upsertProviderSessionRuntime({
      ownerId: "run-1",
      ownerKind: "run",
      providerType: "codex-cli",
      harnessType: "codex-app-server",
      status: "ready",
      cwd: "C:\\repo\\worktree",
      modelId: "gpt-5.3-codex",
      runtimeMode: "code",
      resumeCursor: { threadId: "thread-123" },
      runtimePayload: { sessionType: "run", previousResponseId: "thread-123" },
    });

    expect(saved.resumeCursor).toEqual({ threadId: "thread-123" });
    expect(saved.runtimePayload).toEqual({ sessionType: "run", previousResponseId: "thread-123" });

    const loaded = db.getProviderSessionRuntime("run-1", "run");
    expect(loaded?.providerType).toBe("codex-cli");
    expect(loaded?.resumeCursor).toEqual({ threadId: "thread-123" });
    expect(loaded?.status).toBe("ready");
  });

  it("updates existing owner bindings without losing createdAt", async () => {
    const db = await makeDb();
    const first = db.upsertProviderSessionRuntime({
      ownerId: "chat-1",
      ownerKind: "chat",
      providerType: "claude-code",
      harnessType: "claude-code",
      status: "ready",
      cwd: "C:\\Users\\me",
      modelId: "sonnet",
      runtimeMode: "ask",
      resumeCursor: { resume: "session-a" },
    });

    const second = db.upsertProviderSessionRuntime({
      ownerId: "chat-1",
      ownerKind: "chat",
      providerType: "claude-code",
      harnessType: "claude-code",
      status: "running",
      cwd: "C:\\Users\\me",
      modelId: "opus",
      runtimeMode: "ask",
      resumeCursor: { resume: "session-b" },
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.modelId).toBe("opus");
    expect(second.resumeCursor).toEqual({ resume: "session-b" });
  });

  it("remembers native sessions per provider account so switching back can resume them", async () => {
    const db = await makeDb();
    const base = {
      ownerId: "run-1",
      ownerKind: "run" as const,
      status: "ready" as const,
      cwd: "C:\\repo\\worktree",
      runtimeMode: "code" as const,
    };
    db.upsertProviderSessionRuntime({
      ...base,
      providerAccountId: "codex-account",
      providerType: "codex-cli",
      harnessType: "codex-app-server",
      resumeCursor: { threadId: "thread-codex" },
    });
    db.upsertProviderSessionRuntime({
      ...base,
      providerAccountId: "claude-account",
      providerType: "claude-code",
      harnessType: "claude-code",
      resumeCursor: { resume: "session-claude" },
    });

    expect(db.getProviderSessionRuntime("run-1", "run")).toMatchObject({
      providerAccountId: "claude-account",
      resumeCursor: { resume: "session-claude" },
    });
    expect(db.getProviderAccountSessionRuntime("run-1", "run", "codex-account")).toMatchObject({
      providerAccountId: "codex-account",
      providerType: "codex-cli",
      resumeCursor: { threadId: "thread-codex" },
    });
    expect(db.getProviderAccountSessionRuntime("run-1", "run", "cursor-account")).toBeNull();

    db.deleteProviderSessionRuntime("run-1", "run");
    expect(db.getProviderSessionRuntime("run-1", "run")).toBeNull();
    expect(db.getProviderAccountSessionRuntime("run-1", "run", "codex-account")).toBeNull();
  });

  it("drops a response id that belongs to another account when the run or chat switches accounts", async () => {
    const db = await makeDb();
    const project = db.addProject({ repoPath: "C:\\switch-repo", baseBranch: "main", resolvedName: "Switch Repo" });
    const addAccount = (providerType: "codex-cli" | "claude-code", label: string) =>
      db.addProviderAccount({ providerType, label, apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
    const codex = addAccount("codex-cli", "Codex");
    const claude = addAccount("claude-code", "Claude");
    const addModel = (providerAccountId: string, modelId: string) =>
      db.addModel({ providerAccountId, modelId, displayName: modelId, config: {}, capabilities: {} });
    const codexModel = addModel(codex.id, "gpt-codex");
    const codexModel2 = addModel(codex.id, "gpt-codex-mini");
    const claudeModel = addModel(claude.id, "sonnet");

    const run = db.createRun({
      projectId: project.id,
      providerAccountId: codex.id,
      modelId: codexModel.id,
      harnessType: "codex-app-server",
      mode: "code",
      workspaceType: "worktree",
      prompt: "Do the thing",
      branchName: "switch/run",
      worktreePath: "C:\\switch-worktree",
    });
    db.updateRunStatus(run.id, "completed", { lastProviderResponseId: "thread-codex" });
    expect(db.updateRunConfiguration(run.id, { providerAccountId: codex.id, modelId: codexModel2.id }).lastProviderResponseId)
      .toBe("thread-codex");
    expect(db.updateRunConfiguration(run.id, { providerAccountId: claude.id, modelId: claudeModel.id }).lastProviderResponseId)
      .toBeNull();

    const chat = db.createChat(codex.id, codexModel.id, "Chat");
    db.updateChatStatus(chat.id, "completed", { lastProviderResponseId: "thread-chat" });
    db.updateChatConfiguration(chat.id, codexModel2.id);
    expect(db.getChat(chat.id).lastProviderResponseId).toBe("thread-chat");
    db.updateChatConfiguration(chat.id, claudeModel.id);
    expect(db.getChat(chat.id)).toMatchObject({ providerAccountId: claude.id, modelId: claudeModel.id, lastProviderResponseId: null });
  });

  it("leaves legacy sessions unattributed even when the current account has the same provider type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buildwarden-provider-session-legacy-"));
    tempDirs.push(dir);
    const filePath = join(dir, "buildwarden.sqlite");
    const db = new BuildWardenDatabase(filePath);
    await db.init();
    const project = db.addProject({ repoPath: "C:\\legacy-repo", baseBranch: "main", resolvedName: "Legacy Repo" });
    const codex = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
    const sdk = db.addProviderAccount({ providerType: "ai-sdk", label: "SDK", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
    const codexModel = db.addModel({ providerAccountId: codex.id, modelId: "gpt-codex", displayName: "Codex", config: {}, capabilities: {} });
    const sdkModel = db.addModel({ providerAccountId: sdk.id, modelId: "gpt", displayName: "SDK", config: {}, capabilities: {} });
    const createRun = (providerAccountId: string, modelId: string, branchName: string) => db.createRun({
      projectId: project.id,
      providerAccountId,
      modelId,
      harnessType: "codex-app-server",
      mode: "code",
      workspaceType: "worktree",
      prompt: "Legacy",
      branchName,
      worktreePath: `C:\\legacy-${branchName}`,
    });
    const stillCodex = createRun(codex.id, codexModel.id, "still-codex");
    const switchedToSdk = createRun(sdk.id, sdkModel.id, "switched");
    for (const ownerId of [stillCodex.id, switchedToSdk.id]) {
      db.upsertProviderSessionRuntime({
        ownerId,
        ownerKind: "run",
        providerType: "codex-cli",
        harnessType: "codex-app-server",
        status: "ready",
        cwd: "C:\\legacy",
        runtimeMode: "code",
        resumeCursor: { threadId: `thread-${ownerId}` },
      });
    }
    await db.close();

    const reopened = new BuildWardenDatabase(filePath);
    await reopened.init();
    dbs.push(reopened);
    expect(reopened.getProviderSessionRuntime(stillCodex.id, "run")?.providerAccountId).toBeNull();
    expect(reopened.getProviderAccountSessionRuntime(stillCodex.id, "run", codex.id)).toBeNull();
    expect(reopened.getProviderSessionRuntime(switchedToSdk.id, "run")?.providerAccountId).toBeNull();
    expect(reopened.getProviderAccountSessionRuntime(switchedToSdk.id, "run", sdk.id)).toBeNull();
    expect(reopened.getProviderAccountSessionRuntime(switchedToSdk.id, "run", codex.id)).toBeNull();
  });
});
