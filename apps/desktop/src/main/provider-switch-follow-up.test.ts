import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { ProviderAccountRecord, ProviderSessionRuntimeRecord, RunRecord } from "@buildwarden/shared";
import { AppController } from "./app-controller";
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

  // Turn 1 ran on Codex. Legacy history: the initial step only records the model id.
  db.appendRunStep(run.id, "log", "Initial command", "Redesign the Kanban cards",
    JSON.stringify({ source: "user", commandType: "initial", modelId: codexModel.id }));
  finishTurn(codex, "Redesigned the cards; npm run build fails on a missing builder.", "thread-codex");

  return { db, controller, internals, run, codex, claude, codexModel, claudeModel, finishTurn, lastPrompt, handoffBlock };
};

describe("follow-ups that switch provider", () => {
  it("never resumes another provider's session and hands the full history to the new provider", async () => {
    const { db, controller, internals, run, claude, claudeModel, handoffBlock } = await setup();

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
  });

  it("resumes the original session when switching back and hands over only the missed turns", async () => {
    const { db, controller, internals, run, codex, claude, codexModel, claudeModel, finishTurn, lastPrompt, handoffBlock } = await setup();
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

    // The Codex session has now seen everything, so the next Codex turn needs no handoff.
    finishTurn(codex, "Softened the shadows.", "thread-codex");
    await controller.followUpRun(run.id, "Thanks, ship it", { modelId: codexModel.id });
    expect(lastPrompt()).not.toContain("<previous_conversation");
    expect(internals.resolveRunNativeSession(db.getRun(run.id), codex)).toMatchObject({ previousResponseId: "thread-codex" });
  });

  it("keeps resuming the same session without a handoff when only the model changes", async () => {
    const { db, controller, internals, run, codex, lastPrompt } = await setup();
    const otherCodexModel = db.addModel({ providerAccountId: codex.id, modelId: "gpt-codex-mini", displayName: "Mini", config: {}, capabilities: {}, enabled: true });

    await controller.followUpRun(run.id, "Make it faster", { modelId: otherCodexModel.id });

    expect(lastPrompt()).not.toContain("<previous_conversation");
    expect(internals.resolveRunNativeSession(db.getRun(run.id), codex)).toMatchObject({
      session: { resumeCursor: { threadId: "thread-codex" } },
      previousResponseId: "thread-codex",
    });
  });
});
