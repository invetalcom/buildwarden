import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { ChatRecord, ChatStepRecord, ProviderAccountRecord, ProviderSessionRuntimeRecord, RunRecord } from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { getChatWorkspacePath } from "./chat-workspace";
import { HostEventBus } from "./host-events";

const exec = promisify(execFile);
const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Internals = {
  startWorker: (...args: unknown[]) => object;
  runWorkers: Map<string, unknown>;
  capturePromptRestorePoint: () => Promise<void>;
  buildIntegratedSkillContext: () => Promise<undefined>;
  resolveRunNativeSession: (run: RunRecord, provider: ProviderAccountRecord) => {
    session: ProviderSessionRuntimeRecord | null;
    previousResponseId: string | null;
  };
};

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-provider-switch-")); dirs.push(dir);
  const cwd = join(dir, "repo"); await mkdir(cwd);
  const git = (...args: string[]) => exec("git", args, { cwd, windowsHide: true });
  await git("init", "-b", "main"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.test");
  await writeFile(join(cwd, "source.txt"), "original\n"); await git("add", "."); await git("commit", "-m", "Initial");

  const db = new BuildWardenDatabase(join(dir, "state.sqlite")); databases.push(db); await db.init();
  const project = db.addProject({ repoPath: cwd, baseBranch: "main", resolvedName: "Project" });
  const codex = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const claude = db.addProviderAccount({ providerType: "claude-code", label: "Claude", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const codexModel = db.addModel({ providerAccountId: codex.id, modelId: "gpt-codex", displayName: "Codex", config: {}, capabilities: {}, enabled: true });
  const claudeModel = db.addModel({ providerAccountId: claude.id, modelId: "sonnet", displayName: "Sonnet", config: {}, capabilities: {}, enabled: true });
  const run = db.createRun({
    projectId: project.id, providerAccountId: codex.id, modelId: codexModel.id, harnessType: "codex-app-server",
    mode: "code", workspaceType: "local", prompt: "Redesign the Kanban cards", branchName: "main", worktreePath: cwd,
  });
  const secrets = { readSecret: vi.fn(async (): Promise<string | null> => null), saveSecret: async () => undefined, deleteSecret: async () => undefined };
  const controller = new AppController(db, secrets, dir,
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, new HostEventBus());
  const internals = controller as unknown as Internals;
  const startWorker = vi.spyOn(internals, "startWorker").mockReturnValue({});
  vi.spyOn(internals, "capturePromptRestorePoint").mockResolvedValue(undefined);
  vi.spyOn(internals, "buildIntegratedSkillContext").mockResolvedValue(undefined);

  /** Simulates a provider finishing a turn: its answer, its native session and the completed status. */
  const finishTurn = (provider: ProviderAccountRecord, answer: string, sessionId: string) => {
    internals.runWorkers.delete(run.id);
    db.appendRunStep(run.id, "output", "Agent output", answer, "{}");
    db.upsertProviderSessionRuntime({
      ownerId: run.id, ownerKind: "run", providerAccountId: provider.id, providerType: provider.providerType,
      harnessType: provider.providerType === "codex-cli" ? "codex-app-server" : "claude-code",
      status: "ready", cwd, runtimeMode: "code",
      resumeCursor: provider.providerType === "codex-cli" ? { threadId: sessionId } : { resume: sessionId },
    });
    db.updateRunStatus(run.id, "completed", { lastProviderResponseId: sessionId });
  };
  const lastPrompt = () => {
    const options = startWorker.mock.calls.at(-1)?.[5] as { promptOverride?: string } | undefined;
    return options?.promptOverride ?? "";
  };
  const handoffBlock = () => /<previous_conversation[\s\S]*<\/previous_conversation>/.exec(lastPrompt())?.[0] ?? "";
  /** The "Passing over to …" note persisted right before the latest follow-up, if any. */
  const handoffNote = () => {
    const note = db.getRunSteps(run.id).at(-2);
    return note?.title === "Model switched"
      ? { content: note.content, ...(JSON.parse(note.metadataJson) as { modelHandoff: Record<string, unknown> }).modelHandoff }
      : null;
  };

  // Turn 1 ran on Codex. Legacy history: the initial step only records the model id.
  db.appendRunStep(run.id, "log", "Initial command", "Redesign the Kanban cards",
    JSON.stringify({ source: "user", commandType: "initial", modelId: codexModel.id }));
  finishTurn(codex, "Redesigned the cards; npm run build fails on a missing builder.", "thread-codex");

  return { db, controller, internals, run, codex, claude, codexModel, claudeModel, finishTurn, lastPrompt, handoffBlock, handoffNote, startWorker };
};

describe("follow-ups that switch provider", () => {
  it("never resumes another provider's session and hands the full history to the new provider", async () => {
    const { db, controller, internals, run, claude, claudeModel, handoffBlock, handoffNote } = await setup();

    await controller.followUpRun(run.id, "Install the missing builder", { modelId: claudeModel.id });

    const switched = db.getRun(run.id);
    expect(switched.lastProviderResponseId).toBeNull();
    expect(internals.resolveRunNativeSession(switched, claude)).toEqual({ session: null, previousResponseId: null });
    const block = handoffBlock();
    expect(block).toContain('strategy="full_history"');
    expect(block).toContain("Redesign the Kanban cards");
    expect(block).toContain("npm run build fails on a missing builder");
    expect(block).not.toContain("Install the missing builder");
    const followUpStep = db.getRunSteps(run.id).at(-1)!;
    expect(JSON.parse(followUpStep.metadataJson)).toMatchObject({
      providerAccountId: claude.id,
      contextHandoff: { strategy: "full", turnCount: 1 },
    });
    expect(handoffNote()).toMatchObject({
      content: "Passing over to Sonnet · Claude",
      fromModelLabel: "Codex",
      toModelLabel: "Sonnet",
      toProviderLabel: "Claude",
      providerChanged: true,
      context: "history",
    });
  });

  it("resumes the original session when switching back and hands over only the missed turns", async () => {
    const { db, controller, internals, run, codex, claude, codexModel, claudeModel, finishTurn, lastPrompt, handoffBlock, handoffNote } = await setup();
    await controller.followUpRun(run.id, "Install the missing builder", { modelId: claudeModel.id });
    finishTurn(claude, "Installed @angular-devkit/build-angular; the build passes.", "session-claude");

    await controller.followUpRun(run.id, "Polish the card shadows", { modelId: codexModel.id });

    const resumed = internals.resolveRunNativeSession(db.getRun(run.id), codex);
    expect(resumed.session?.resumeCursor).toEqual({ threadId: "thread-codex" });
    expect(resumed.previousResponseId).toBeNull();
    const block = handoffBlock();
    expect(block).toContain('strategy="delta_since_your_last_turn"');
    expect(block).toContain("Install the missing builder");
    expect(block).toContain("the build passes");
    expect(block).not.toContain("Redesign the Kanban cards");
    expect(handoffNote()).toMatchObject({ toModelLabel: "Codex", context: "delta" });

    // The Codex session has now seen everything, so the next Codex turn needs no handoff.
    finishTurn(codex, "Softened the shadows.", "thread-codex");
    await controller.followUpRun(run.id, "Thanks, ship it", { modelId: codexModel.id });
    expect(lastPrompt()).not.toContain("<previous_conversation");
    expect(handoffNote()).toBeNull();
    expect(internals.resolveRunNativeSession(db.getRun(run.id), codex)).toMatchObject({ previousResponseId: "thread-codex" });
  });

  it("keeps resuming the same session without a handoff when only the model changes", async () => {
    const { db, controller, internals, run, codex, lastPrompt, handoffNote } = await setup();
    const otherCodexModel = db.addModel({ providerAccountId: codex.id, modelId: "gpt-codex-mini", displayName: "Mini", config: {}, capabilities: {}, enabled: true });

    await controller.followUpRun(run.id, "Make it faster", { modelId: otherCodexModel.id });

    expect(lastPrompt()).not.toContain("<previous_conversation");
    expect(handoffNote()).toMatchObject({ toModelLabel: "Mini", providerChanged: false, context: "session" });
    expect(internals.resolveRunNativeSession(db.getRun(run.id), codex)).toMatchObject({
      session: { resumeCursor: { threadId: "thread-codex" } },
      previousResponseId: "thread-codex",
    });
  });
});

describe("follow-up handoff edge cases", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("re-sends the missed turns when a return to the original provider failed before it started", async () => {
    const { db, controller, internals, run, claude, codexModel, claudeModel, finishTurn, handoffBlock } = await setup();
    await tick();
    await controller.followUpRun(run.id, "Install the missing builder", { modelId: claudeModel.id });
    finishTurn(claude, "Installed @angular-devkit/build-angular; the build passes.", "session-claude");
    await tick();
    // The return to Codex fails before Codex reports its session (e.g. the CLI cannot start).
    await controller.followUpRun(run.id, "Polish the card shadows", { modelId: codexModel.id });
    internals.runWorkers.delete(run.id);
    db.updateRunStatus(run.id, "failed", { errorMessage: "Codex CLI could not start" });
    await tick();

    await controller.followUpRun(run.id, "Try again", { modelId: codexModel.id });

    const block = handoffBlock();
    expect(block).toContain('strategy="delta_since_your_last_turn"');
    expect(block).toContain("has not seen the last 2 turns");
    expect(block).toContain("the build passes");
    expect(block).toContain("Polish the card shadows");
  });

  it("re-attaches files from earlier follow-ups when switching provider", async () => {
    const { db, controller, run, codex, codexModel, claudeModel, finishTurn, lastPrompt, startWorker } = await setup();
    const mockup = { fileName: "mockup.png", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" };
    db.appendRunStep(run.id, "log", "Follow-up command", "Match this mockup", JSON.stringify({
      source: "user", commandType: "follow-up", modelId: codexModel.id, providerAccountId: codex.id,
      attachments: [mockup], attachmentNames: [mockup.fileName],
    }));
    finishTurn(codex, "Matched the mockup.", "thread-codex");

    await controller.followUpRun(run.id, "Double-check against the mockup", { modelId: claudeModel.id });

    const options = startWorker.mock.calls.at(-1)?.[5] as { attachments?: Array<{ fileName: string }> } | undefined;
    expect(options?.attachments?.map((entry) => entry.fileName)).toEqual(["mockup.png"]);
    expect(lastPrompt()).toContain("re-attached to this message: mockup.png");
  });
});

describe("chat follow-ups that switch model", () => {
  type ChatInternals = {
    startChatWorker: (...args: unknown[]) => object;
    resolveChatNativeSession: (chat: ChatRecord, provider: ProviderAccountRecord, steps: ChatStepRecord[]) => {
      session: ProviderSessionRuntimeRecord | null;
    };
  };

  it("rejects cursorless run and chat sessions despite owner-level response IDs", async () => {
    const { db, controller, run, codex, codexModel } = await setup();
    db.upsertProviderSessionRuntime({
      ownerId: run.id, ownerKind: "run", providerAccountId: codex.id, providerType: "codex-cli",
      harnessType: "codex-app-server", status: "ready", cwd: run.worktreePath, runtimeMode: "code",
      resumeCursor: null,
    });
    const runInternals = controller as unknown as Internals;
    expect(db.getRun(run.id).lastProviderResponseId).not.toBeNull();
    expect(runInternals.resolveRunNativeSession(db.getRun(run.id), codex)).toEqual({ session: null, previousResponseId: null });

    const chat = db.createChat(codex.id, codexModel.id, "Hi");
    db.updateChatStatus(chat.id, "completed", { lastProviderResponseId: "stale-thread" });
    db.upsertProviderSessionRuntime({
      ownerId: chat.id, ownerKind: "chat", providerAccountId: codex.id, providerType: "codex-cli",
      harnessType: "codex-app-server", status: "ready", cwd: getChatWorkspacePath(db.getFilePath(), chat.id),
      runtimeMode: "ask", resumeCursor: null,
    });
    const chatInternals = controller as unknown as ChatInternals;
    expect(chatInternals.resolveChatNativeSession(db.getChat(chat.id), codex, [])).toEqual({ session: null, previousResponseId: null });
  });

  it("labels the switch as a fresh session when a moved Claude chat cannot resume", async () => {
    const { db, controller, claude, claudeModel } = await setup();
    const opus = db.addModel({ providerAccountId: claude.id, modelId: "opus", displayName: "Opus", config: {}, capabilities: {}, enabled: true });
    const internals = controller as unknown as ChatInternals;
    vi.spyOn(internals, "startChatWorker").mockReturnValue({});
    const chat = db.createChat(claude.id, claudeModel.id, "Hi");
    db.appendChatEvent(chat.id, "log", "Initial message", "Hi", { source: "user", commandType: "initial", modelId: claudeModel.id });
    db.appendChatEvent(chat.id, "output", "Agent output", "Hello!", {});
    const upsertSession = (cwd: string) => db.upsertProviderSessionRuntime({
      ownerId: chat.id, ownerKind: "chat", providerAccountId: claude.id, providerType: "claude-code", harnessType: "claude-code",
      status: "ready", cwd, runtimeMode: "ask", resumeCursor: { resume: "session-claude" },
    });
    db.updateChatStatus(chat.id, "completed", { lastProviderResponseId: "session-claude" });

    upsertSession(getChatWorkspacePath(db.getFilePath(), chat.id));
    expect(internals.resolveChatNativeSession(db.getChat(chat.id), claude, db.getChatSteps(chat.id)).session).not.toBeNull();
    // A legacy chat whose Claude session lives in another directory cannot be resumed here.
    upsertSession("C:\\legacy-home");
    expect(internals.resolveChatNativeSession(db.getChat(chat.id), claude, db.getChatSteps(chat.id)).session).toBeNull();

    await controller.followUpChat(chat.id, "And now?", { modelId: opus.id });

    const note = db.getChatSteps(chat.id).find((entry) => entry.title === "Model switched");
    expect(JSON.parse(note!.metadataJson)).toMatchObject({
      userFacing: true,
      modelHandoff: { toModelLabel: "Opus", providerChanged: false, context: "history" },
    });
  });
});
