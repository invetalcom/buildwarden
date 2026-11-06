import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { GitService } from "@buildwarden/git-service";
import type { RunRewindInput, RunTurnRestorePoint } from "@buildwarden/shared";
import { executeRunRewind } from "./run-rewind-service";

const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@buildwarden/provider-codex-cli", async (original) => ({
  ...await original<typeof import("@buildwarden/provider-codex-cli")>(),
  withCodexAccountClient: async (_options: unknown, action: (client: { request: typeof native.request }) => Promise<void>) => action(native),
}));

const databases: BuildWardenDatabase[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); native.request.mockReset();
  for (const db of databases.splice(0)) await db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(providerType: "claude-code" | "codex-cli" = "claude-code") {
  const dir = mkdtempSync(join(tmpdir(), "bw-rewind-")); directories.push(dir);
  const cwd = join(dir, "repo");
  execFileSync("git", ["init", "--initial-branch=main", cwd], { stdio: "ignore" });
  const gitCommand = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  gitCommand("config", "user.email", "test@example.com"); gitCommand("config", "user.name", "Test");
  writeFileSync(join(cwd, "app.txt"), "base"); gitCommand("add", "."); gitCommand("commit", "-m", "base");
  const db = new BuildWardenDatabase(join(dir, "state.sqlite")); await db.init(); databases.push(db);
  const project = db.addProject({ repoPath: cwd, baseBranch: "main", resolvedName: "Repo" });
  const provider = db.addProviderAccount({ providerType, label: "Provider", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", enabled: true, config: {}, capabilities: {} });
  const run = db.createRun({ projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: providerType === "codex-cli" ? "codex-app-server" : "claude-code",
    mode: "code", workspaceType: "local", prompt: "first", branchName: "main", worktreePath: cwd });
  const git = new GitService();
  const first = db.appendRunStep(run.id, "log", "Initial command", "first", JSON.stringify({ source: "user", commandType: "initial", providerAccountId: provider.id, goalText: "keep goal" }));
  const firstPoint: RunTurnRestorePoint = { id: randomUUID(), stepId: first.id, prompt: "first", createdAt: first.createdAt,
    commandType: "initial", patch: await git.createPromptRestorePatch(cwd), headSha: await git.getHeadCommitSha(cwd), filesAvailable: true };
  db.saveRunTurnRestorePoint(run.id, firstPoint);
  db.appendRunStep(run.id, "output", "Answer", "retained answer");
  writeFileSync(join(cwd, "app.txt"), "first turn");
  const follow = db.appendRunStep(run.id, "log", "Follow-up command", "second", JSON.stringify({ source: "user", commandType: "follow-up", providerAccountId: provider.id,
    attachments: [{ fileName: "notes.txt", mimeType: "text/plain", dataBase64: "bm90ZXM=" }] }));
  const previousSession = db.upsertProviderSessionRuntime({ ownerId: run.id, ownerKind: "run", providerAccountId: provider.id, providerType,
    harnessType: providerType === "codex-cli" ? "codex-app-server" : "claude-code", status: "ready", cwd, modelId: "test", runtimeMode: "code", resumeCursor: { threadId: "thread-one" }, runtimePayload: {} });
  const point: RunTurnRestorePoint = { ...firstPoint, providerSession: previousSession, id: randomUUID(), stepId: follow.id, prompt: "second", commandType: "follow-up", patch: await git.createPromptRestorePatch(cwd) };
  db.saveRunTurnRestorePoint(run.id, point);
  db.appendRunStep(run.id, "status", "Working", "working", JSON.stringify({ providerTurn: { threadId: "thread-one", turnId: "turn-two" } }));
  db.appendRunStep(run.id, "output", "Answer", "discarded answer");
  db.upsertProviderSessionRuntime({ ownerId: run.id, ownerKind: "run", providerAccountId: provider.id, providerType,
    harnessType: providerType === "codex-cli" ? "codex-app-server" : "claude-code", status: "ready", cwd, modelId: "test", runtimeMode: "code", resumeCursor: { threadId: "thread-one" }, runtimePayload: {} });
  db.setSetting(`runCheckpoint:${run.id}`, JSON.stringify({ round: 2, memo: "stale memory" }));
  db.updateRunStatus(run.id, "completed", { summary: "discarded summary", lastProviderResponseId: "stale-response" });
  writeFileSync(join(cwd, "app.txt"), "second turn and manual edits");
  const input: RunRewindInput = { runId: run.id, restorePointId: point.id, mode: "conversation-and-files" };
  const options = { db, git, run: db.getRun(run.id), input, assertSafe: vi.fn() };
  return { ...options, options, cwd, point, firstPoint, gitCommand, provider };
}

describe("coordinated prompt rewind", () => {
  it("restores files and active history, preserves an audit copy, and clears every stale resume path", async () => {
    const h = await fixture();
    const result = await executeRunRewind(h.options);
    expect(readFileSync(join(h.cwd, "app.txt"), "utf8")).toBe("first turn");
    expect(result).toMatchObject({ prompt: "second", providerStrategy: "fresh-session", attachments: [{ fileName: "notes.txt" }] });
    expect(readFileSync(result.safetyPatchPath!, "utf8")).toContain("second turn and manual edits");
    expect(h.db.getRunSteps(h.run.id).map((step) => step.content)).toContain("retained answer");
    expect(h.db.getRunSteps(h.run.id).map((step) => step.content)).not.toContain("discarded answer");
    expect(h.db.getRunRewindHistory(h.run.id)[0]?.steps.map((step) => step.content)).toContain("discarded answer");
    expect(h.db.getRun(h.run.id)).toMatchObject({ lastProviderResponseId: null, summary: null, goalText: "keep goal" });
    expect(h.db.getProviderAccountSessionRuntime(h.run.id, "run", h.provider.id)).toBeNull();
    expect(h.db.getSettings()[`runCheckpoint:${h.run.id}`]).toBeUndefined();
    expect(h.db.listRunTurnRestorePoints(h.run.id).map((point) => point.id)).toEqual([h.firstPoint.id]);
    expect(h.db.getPendingRunRewind(h.run.id)).toBeNull();
  });

  it("supports conversation-only rewind across commits and preserves the current files", async () => {
    const h = await fixture();
    h.gitCommand("add", "."); h.gitCommand("commit", "-m", "later commit");
    await executeRunRewind({ ...h.options, input: { ...h.input, mode: "conversation" } });
    expect(readFileSync(join(h.cwd, "app.txt"), "utf8")).toBe("second turn and manual edits");
    expect(h.assertSafe).not.toHaveBeenCalled();
    expect(h.db.getRunSteps(h.run.id).at(-1)?.content).toContain("Files were kept unchanged");
  });

  it("rejects file rewind across commits before detaching native history", async () => {
    const h = await fixture();
    h.gitCommand("add", "."); h.gitCommand("commit", "-m", "later commit");
    await expect(executeRunRewind(h.options)).rejects.toThrow("new commits");
    expect(h.db.getPendingRunRewind(h.run.id)).toBeNull();
    expect(h.db.getProviderSessionRuntime(h.run.id, "run")).not.toBeNull();
    expect(h.db.getRunSteps(h.run.id).at(-1)?.content).toBe("discarded answer");
  });

  it("persists a failed operation across restart and retries it without reviving stale history", async () => {
    const h = await fixture();
    const restore = vi.spyOn(h.git, "restorePromptRestorePatch").mockRejectedValueOnce(new Error("locked file"));
    await expect(executeRunRewind(h.options)).rejects.toThrow("locked file");
    expect(h.db.getPendingRunRewind(h.run.id)?.stage).toBe("provider-ready");
    expect(h.db.listPendingRewindWorkspaces()).toEqual([h.cwd]);
    const file = h.db.getFilePath(); await h.db.close();
    const reopened = new BuildWardenDatabase(file); await reopened.init(); databases.push(reopened);
    restore.mockRestore();
    await expect(executeRunRewind({ ...h.options, db: reopened, input: { ...h.input, restorePointId: h.firstPoint.id } })).rejects.toThrow("pending rewind");
    await executeRunRewind({ ...h.options, db: reopened });
    expect(reopened.getPendingRunRewind(h.run.id)).toBeNull();
    expect(reopened.getRunRewindHistory(h.run.id)).toHaveLength(1);
    expect(reopened.getProviderSessionRuntime(h.run.id, "run")).toBeNull();
  });

  it("can explicitly finish an interrupted rewind while keeping the current files", async () => {
    const h = await fixture();
    vi.spyOn(h.git, "restorePromptRestorePatch").mockRejectedValue(new Error("locked file"));
    await expect(executeRunRewind(h.options)).rejects.toThrow("locked file");
    h.gitCommand("add", "."); h.gitCommand("commit", "-m", "external change while interrupted");
    await executeRunRewind({ ...h.options, input: { ...h.input, mode: "conversation" } });
    expect(h.db.getPendingRunRewind(h.run.id)).toBeNull();
    expect(readFileSync(join(h.cwd, "app.txt"), "utf8")).toBe("second turn and manual edits");
    expect(h.db.getRunRewindHistory(h.run.id)[0]?.mode).toBe("conversation");
  });

  it("uses the recorded Codex turn boundary and resumes only the rewound account", async () => {
    const h = await fixture("codex-cli");
    native.request.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-one" } } : {});
    const result = await executeRunRewind(h.options);
    expect(result.providerStrategy).toBe("native");
    expect(native.request).toHaveBeenCalledWith("thread/revert", { threadId: "thread-one", beforeTurnId: "turn-two" });
    expect(h.db.getProviderAccountSessionRuntime(h.run.id, "run", h.provider.id)?.resumeCursor).toEqual({ threadId: "thread-one" });
    expect(h.db.getProviderAccountSessionRuntime(h.run.id, "run", h.provider.id)?.lastSeenAt).toBe(h.point.providerSession?.lastSeenAt);
  });

  it("does not resume an empty native thread when earlier turns need a fresh history handoff", async () => {
    // No native session existed at the selected boundary (first turn after a provider switch).
    const next = await fixture("codex-cli");
    const point = { ...next.point, id: randomUUID(), providerSession: null };
    next.db.saveRunTurnRestorePoint(next.run.id, point);
    const result = await executeRunRewind({ ...next.options, input: { ...next.input, restorePointId: point.id } });
    expect(result.providerStrategy).toBe("fresh-session");
    expect(native.request).not.toHaveBeenCalled();
  });

  it("can rewind again to an earlier retained prompt without losing archived history", async () => {
    const h = await fixture();
    await executeRunRewind(h.options);
    await executeRunRewind({ ...h.options, input: { ...h.input, restorePointId: h.firstPoint.id } });
    expect(readFileSync(join(h.cwd, "app.txt"), "utf8")).toBe("base");
    expect(h.db.getRunRewindHistory(h.run.id)).toHaveLength(2);
    expect(h.db.listRunTurnRestorePoints(h.run.id)).toEqual([]);
    expect(h.db.getRunSteps(h.run.id).every((step) => step.eventType === "status")).toBe(true);
  });

  it("falls back to a fresh session when native rewind is unavailable", async () => {
    const h = await fixture("codex-cli");
    native.request.mockRejectedValue(new Error("unsupported native history"));
    expect((await executeRunRewind(h.options)).providerStrategy).toBe("fresh-session");
    expect(h.db.getProviderSessionRuntime(h.run.id, "run")).toBeNull();
  });

  it("cleans retained snapshots and archives with the owning run", async () => {
    const h = await fixture();
    await executeRunRewind(h.options);
    h.db.deleteRun(h.run.id);
    expect(h.db.getRunRewindHistory(h.run.id)).toEqual([]);
    expect(h.db.listRunTurnRestorePoints(h.run.id)).toEqual([]);
    expect(h.db.listPendingRewindWorkspaces()).toEqual([]);
  });
});
