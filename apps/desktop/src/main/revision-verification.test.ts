import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, verificationMatches, type RunVerificationRecord } from "@buildwarden/shared";
import { captureWorkspaceRevision } from "./workspace-revision";
import { verifyWorkspaceRevision } from "./revision-verification";
import { AppController } from "./app-controller";
import { HostEventBus } from "./host-events";
import * as diffWorker from "./run-worktree-diff-worker";

const exec = promisify(execFile);
const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-revision-test-")); dirs.push(dir);
  const cwd = join(dir, "repo"); await mkdir(cwd);
  const git = async (...args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.test");
  await writeFile(join(cwd, "source.txt"), "original\n"); await writeFile(join(cwd, ".gitignore"), "ignored/\n");
  await git("add", "."); await git("commit", "-m", "Initial");
  return { dir, cwd, git };
};
const check = async (cwd: string, commands = ['node -e "process.stdout.write(\'ok\')"'], signal?: AbortSignal) => {
  const saved: RunVerificationRecord[] = [];
  const record = await verifyWorkspaceRevision({ runId: "run", cwd, vcs: "git", commands, signal, save: (value) => saved.push(structuredClone(value)) });
  return { record, saved };
};

describe("revision verification", () => {
  it("includes staged, unstaged, binary and untracked changes without changing the real index", async () => {
    const { cwd, git } = await fixture(); const original = await captureWorkspaceRevision(cwd, "git");
    await writeFile(join(cwd, "source.txt"), "staged\n"); await git("add", ".");
    const staged = await captureWorkspaceRevision(cwd, "git");
    await writeFile(join(cwd, "source.txt"), "unstaged\n");
    const indexBefore = await readFile(join(cwd, ".git", "index"));
    const unstaged = await captureWorkspaceRevision(cwd, "git");
    await writeFile(join(cwd, "new.bin"), Buffer.from([0, 255, 1]));
    const untracked = await captureWorkspaceRevision(cwd, "git");
    expect(new Set([original, staged, unstaged, untracked].map((value) => value.fingerprint)).size).toBe(4);
    expect(await readFile(join(cwd, ".git", "index"))).toEqual(indexBefore);
    await git("add", "-A"); await git("commit", "-m", "Commit verified contents");
    const committed = await captureWorkspaceRevision(cwd, "git");
    expect(committed.fingerprint).toBe(untracked.fingerprint); expect(committed.head).not.toBe(untracked.head);
    await rm(join(cwd, "source.txt")); expect((await captureWorkspaceRevision(cwd, "git")).fingerprint).not.toBe(committed.fingerprint);
  }, 20_000);
  it("ignores generated artifacts but includes explicitly staged ignored files and fails closed for skipped files", async () => {
    const { cwd, git } = await fixture(); const before = await captureWorkspaceRevision(cwd, "git");
    await mkdir(join(cwd, "ignored")); await writeFile(join(cwd, "ignored", "output"), "artifact");
    expect((await captureWorkspaceRevision(cwd, "git")).fingerprint).toBe(before.fingerprint);
    await git("add", "-f", "ignored/output");
    expect((await captureWorkspaceRevision(cwd, "git")).fingerprint).not.toBe(before.fingerprint);
    await git("update-index", "--assume-unchanged", "source.txt");
    await expect(captureWorkspaceRevision(cwd, "git")).rejects.toThrow("assume-unchanged");
  }, 20_000);
  it("records passing evidence and invalidates it when commands or files change", async () => {
    const { cwd } = await fixture(); const { record, saved } = await check(cwd);
    expect(record.status).toBe("passed"); expect(record.results[0]).toMatchObject({ ok: true, exitCode: 0, output: "ok" });
    expect(saved[0].status).toBe("running");
    expect(verificationMatches(record, await captureWorkspaceRevision(cwd, "git"), record.commands)).toBe(true);
    expect(verificationMatches(record, await captureWorkspaceRevision(cwd, "git"), ["different command"])).toBe(false);
    await writeFile(join(cwd, "source.txt"), "later edit");
    expect(verificationMatches(record, await captureWorkspaceRevision(cwd, "git"), record.commands)).toBe(false);
  }, 20_000);
  it("never reports pass when a successful command modifies the reviewed files", async () => {
    const { cwd } = await fixture();
    const { record } = await check(cwd, ['node -e "require(\'fs\').writeFileSync(\'source.txt\', \'formatted\')"']);
    expect(record.status).toBe("stale"); expect(record.results[0].ok).toBe(true);
  }, 20_000);
  it("records failures, stops subsequent commands, and honors cancellation before spawning", async () => {
    const { cwd } = await fixture();
    const failure = await check(cwd, ['node -e "process.exit(4)"', 'node -e "process.exit(0)"']);
    expect(failure.record.status).toBe("failed"); expect(failure.record.results).toHaveLength(1);
    const abort = new AbortController(); abort.abort();
    const cancelled = await check(cwd, ['node -e "require(\'fs\').writeFileSync(\'forbidden\', \'x\')"'], abort.signal);
    expect(cancelled.record.status).toBe("cancelled"); expect(cancelled.record.results).toEqual([]);
    await expect(readFile(join(cwd, "forbidden"))).rejects.toThrow();
  }, 20_000);
  it("fingerprints folder workspaces with the same ignored directories as their snapshots", async () => {
    const { cwd } = await fixture(); const before = await captureWorkspaceRevision(cwd, "folder");
    await mkdir(join(cwd, "dist")); await writeFile(join(cwd, "dist", "built"), "output");
    expect((await captureWorkspaceRevision(cwd, "folder")).fingerprint).toBe(before.fingerprint);
    await writeFile(join(cwd, "new.txt"), "content"); expect((await captureWorkspaceRevision(cwd, "folder")).fingerprint).not.toBe(before.fingerprint);
  });
  it("rejects dirty submodules, including untracked files inside them", async () => {
    const parent = await fixture(); const child = await fixture();
    await parent.git("-c", "protocol.file.allow=always", "submodule", "add", child.cwd, "nested");
    await parent.git("commit", "-am", "Add submodule");
    const clean = await captureWorkspaceRevision(parent.cwd, "git"); expect(clean.fingerprint).toMatch(/^git:/);
    await writeFile(join(parent.cwd, "nested", "untracked.txt"), "new");
    await expect(captureWorkspaceRevision(parent.cwd, "git")).rejects.toThrow("submodule");
  }, 20_000);
  it("persists evidence across restart, blocks stale publish, and requires rerun after interruption", async () => {
    const { dir, cwd } = await fixture();
    const db = new BuildWardenDatabase(join(dir, "state.sqlite")); databases.push(db); await db.init();
    const project = db.addProject({ repoPath: cwd, baseBranch: "main", resolvedName: "Project" });
    const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
    const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
    const run = db.createRun({ projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server", mode: "code", workspaceType: "local", prompt: "Implement", branchName: "main", worktreePath: cwd });
    db.updateRunStatus(run.id, "completed");
    db.setSetting(APP_SETTING_KEYS.projectRunDefaults, JSON.stringify({ [project.id]: { verificationCommands: ['node -e "process.exit(0)"'] } }));
    db.setSetting(APP_SETTING_KEYS.revisionVerificationPolicy, JSON.stringify({ [project.id]: true }));
    const controller = new AppController(db, { readSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => undefined }, dir,
      { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
      { killForRunId: () => {} }, new HostEventBus());
    expect((await controller.getRunVerification(run.id)).status).toBe("not-run");
    await expect(controller.publishRunBranch(run.id, "unverified-publish")).rejects.toThrow("must pass verification");
    expect(db.getRun(run.id).branchName).toBe("main");
    expect((await exec("git", ["branch", "--show-current"], { cwd })).stdout.trim()).toBe("main");
    expect((await exec("git", ["branch", "--list", "unverified-publish"], { cwd })).stdout.trim()).toBe("");
    expect((await controller.verifyRunRevision(run.id)).status).toBe("passed");
    const diff = vi.spyOn(diffWorker, "runWorktreeDiffInWorker").mockResolvedValue({ ok: true, diff: "patch" });
    expect((await controller.getRunWorktreeDiff(run.id)).diffRevision?.fingerprint).toBe(db.getRunVerification(run.id)?.revision?.fingerprint);
    diff.mockImplementationOnce(async () => { await writeFile(join(cwd, "source.txt"), "changed while loading diff"); return { ok: true, diff: "old patch" }; });
    expect((await controller.getRunWorktreeDiff(run.id)).diffRevision).toBeNull();
    const reopened = new BuildWardenDatabase(db.getFilePath()); await reopened.init();
    expect(reopened.getRunVerification(run.id)?.status).toBe("passed"); await reopened.close();
    await writeFile(join(cwd, "source.txt"), "later edit");
    expect((await controller.getRunVerification(run.id)).status).toBe("stale");
    await expect(controller.commitRun(run.id, "Should not commit")).rejects.toThrow("must pass verification");
    db.updateRunStatus(run.id, "failed", { errorMessage: "Verification failed: npm test" });
    await expect(controller.commitRun(run.id, "Still requires passing verification")).rejects.toThrow("must pass verification");
    db.setSetting(APP_SETTING_KEYS.revisionVerificationPolicy, JSON.stringify({ [project.id]: false }));
    await controller.commitRun(run.id, "Commit despite optional verification failure");
    expect((await exec("git", ["log", "-1", "--format=%s"], { cwd })).stdout.trim()).toBe("Commit despite optional verification failure");
    expect(db.getRun(run.id).status).toBe("failed");
    await writeFile(join(cwd, "source.txt"), "more changes");
    db.updateRunStatus(run.id, "failed", { errorMessage: "Provider authentication failed" });
    await expect(controller.commitRun(run.id, "Do not relax other failures")).rejects.toThrow("agent must finish");
    db.updateRunStatus(run.id, "failed", { errorMessage: "Verification failed: npm test" });
    db.setSetting(APP_SETTING_KEYS.revisionVerificationPolicy, JSON.stringify({ [project.id]: true }));
    await controller.verifyRunRevision(run.id);
    await controller.commitRun(run.id, "Commit after verification passes");
    db.saveRunVerification({ ...db.getRunVerification(run.id)!, status: "running", finishedAt: null });
    expect((await controller.getRunVerification(run.id)).status).toBe("cancelled");
    db.deleteRun(run.id); expect(db.getRunVerification(run.id)).toBeNull();
  }, 30_000);
});
