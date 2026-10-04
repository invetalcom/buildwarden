import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, parseWorkspaceSetupSettings, type HarnessRunChunk, type WorkspaceSetupProfile } from "@buildwarden/shared";
import { copyWorkspaceEnvironmentFile, runWorkspaceSetup } from "./workspace-setup";

const dirs: string[] = [];
const profile: WorkspaceSetupProfile = { id: "node", name: "Node", dependencies: "isolated", submodules: "none", environmentFiles: [], commands: [], previewCommand: "pnpm dev", previewUrl: "http://localhost:3000" };
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-setup-")); dirs.push(root);
  const source = join(root, "source"); const target = join(root, "target");
  await mkdir(source); await mkdir(target);
  return { root, source, target };
};
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("workspace setup", () => {
  it("copies only named files and preserves existing workspace values", async () => {
    const { source, target } = await fixture();
    await writeFile(join(source, ".env.local"), "SECRET=source");
    await copyWorkspaceEnvironmentFile(source, target, ".env.local");
    expect(await readFile(join(target, ".env.local"), "utf8")).toBe("SECRET=source");
    await writeFile(join(target, ".env.local"), "SECRET=workspace");
    await copyWorkspaceEnvironmentFile(source, target, ".env.local");
    expect(await readFile(join(target, ".env.local"), "utf8")).toBe("SECRET=workspace");
  });
  it("rejects traversal, git metadata and escaping destination junctions", async () => {
    const { source, target, root } = await fixture();
    await mkdir(join(source, "config")); await writeFile(join(source, "config", "env"), "secret");
    for (const file of ["../outside", ".git/config", "node_modules/file", source]) {
      await expect(copyWorkspaceEnvironmentFile(source, target, file)).rejects.toThrow();
    }
    const outside = join(root, "outside"); await mkdir(outside);
    await symlink(outside, join(target, "config"), process.platform === "win32" ? "junction" : "dir");
    await expect(copyWorkspaceEnvironmentFile(source, target, "config/env")).rejects.toThrow("escapes");
  });
  it("rejects source directory links into excluded metadata", async () => {
    const { source, target } = await fixture();
    await mkdir(join(source, ".git"));
    await writeFile(join(source, ".git", "config"), "private metadata");
    await symlink(join(source, ".git"), join(source, "config"), process.platform === "win32" ? "junction" : "dir");
    await expect(copyWorkspaceEnvironmentFile(source, target, "config/config")).rejects.toThrow("symlinks");
    await expect(readFile(join(target, "config", "config"))).rejects.toThrow();
  });
  it.skipIf(process.platform === "win32")("rejects source file symlinks within the repository", async () => {
    const { source, target } = await fixture();
    await writeFile(join(source, "private"), "secret");
    await symlink(join(source, "private"), join(source, ".env"));
    await expect(copyWorkspaceEnvironmentFile(source, target, ".env")).rejects.toThrow("symlinks");
  });
  it("runs commands in order, stops on failure and never records command output", async () => {
    const { source, target } = await fixture();
    const chunks: HarnessRunChunk[] = [];
    await expect(runWorkspaceSetup({ profile: { ...profile, commands: ['node -e "console.log(123456)"', 'node -e "process.exit(7)"', 'node -e "process.exit(0)"'] }, sourcePath: source, workspacePath: target, git: false, signal: new AbortController().signal, onChunk: (chunk) => chunks.push(chunk) })).rejects.toThrow("command 2 failed");
    expect(chunks.at(-1)?.metadata?.setupStatus).toBe("failed");
    expect(chunks.some((chunk) => chunk.title?.includes("command 3"))).toBe(false);
    expect(chunks.some((chunk) => chunk.value === "123456")).toBe(false);
  });
  it("does not execute an aborted setup", async () => {
    const { source, target } = await fixture();
    const controller = new AbortController(); controller.abort();
    const chunks: HarnessRunChunk[] = [];
    await expect(runWorkspaceSetup({ profile, sourcePath: source, workspacePath: target, git: false, signal: controller.signal, onChunk: (chunk) => chunks.push(chunk) })).rejects.toThrow();
    expect(chunks.at(-1)?.title).toBe("Workspace setup cancelled");
  });
  it("records successful setup even without commands", async () => {
    const { source, target } = await fixture(); const chunks: HarnessRunChunk[] = [];
    await runWorkspaceSetup({ profile, sourcePath: source, workspacePath: target, git: false, signal: new AbortController().signal, onChunk: (chunk) => chunks.push(chunk) });
    expect(chunks.at(-1)?.metadata?.setupStatus).toBe("completed");
  });
  it("normalizes old and malformed settings without enabling an unknown profile", () => {
    expect(parseWorkspaceSetupSettings("broken")).toEqual({});
    const settings = parseWorkspaceSetupSettings(JSON.stringify({ p: { activeProfileId: "missing", profiles: [profile] } }));
    expect(settings.p.activeProfileId).toBe("");
    expect(settings.p.profiles[0]).toEqual(profile);
  });
  it("deduplicates normalized IDs and normalizes the active profile reference", () => {
    const prefix = "x".repeat(80);
    const settings = parseWorkspaceSetupSettings(JSON.stringify({ p: { activeProfileId: `${prefix}first`, profiles: [
      { ...profile, id: `${prefix}first` }, { ...profile, id: `${prefix}second` }, { ...profile, id: "" },
    ] } }));
    expect(settings.p).toEqual({ activeProfileId: prefix, profiles: [{ ...profile, id: prefix }] });
  });
  it("snapshots profiles for new isolated runs and preserves them across settings edits and restart", async () => {
    const { root } = await fixture(); const dbPath = join(root, "state.sqlite");
    const db = new BuildWardenDatabase(dbPath); await db.init();
    let runId: string;
    try {
      const project = db.addProject({ repoPath: root, baseBranch: "main", resolvedName: "Test" });
      const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
      const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
      db.setSetting(APP_SETTING_KEYS.workspaceSetupProfiles, JSON.stringify({ [project.id]: { activeProfileId: profile.id, profiles: [profile] } }));
      const input = { projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server" as const, mode: "code" as const, prompt: "Test", branchName: "test", worktreePath: root };
      const run = db.createRun({ ...input, workspaceType: "worktree" }); runId = run.id;
      expect(db.getRunWorkspaceSetup(run.id)?.profile).toEqual(profile);
      const captured = { ...profile, name: "Captured before worktree creation" };
      expect(db.getRunWorkspaceSetup(db.createRun({ ...input, workspaceType: "worktree", workspaceSetupProfile: captured }).id)?.profile).toEqual(captured);
      expect(db.getRunWorkspaceSetup(db.createRun({ ...input, workspaceType: "worktree", workspaceSetupProfile: null }).id)).toBeNull();
      expect(db.getRunWorkspaceSetup(db.createRun({ ...input, workspaceType: "local" }).id)).toBeNull();
      const beforeFailure = db.listRunsForProject(project.id).map((entry) => entry.id);
      const save = vi.spyOn(db, "saveRunWorkspaceSetup").mockImplementationOnce(() => { throw new Error("snapshot write failed"); });
      expect(() => db.createRun({ ...input, workspaceType: "worktree" })).toThrow("snapshot write failed");
      expect(db.listRunsForProject(project.id).map((entry) => entry.id)).toEqual(beforeFailure);
      save.mockRestore();
      db.setSetting(APP_SETTING_KEYS.workspaceSetupProfiles, "{}");
      db.saveRunWorkspaceSetup(run.id, { profile: { ...profile, name: "Should not replace snapshot" }, status: "completed" });
    } finally { await db.close(); }
    const reopened = new BuildWardenDatabase(dbPath); await reopened.init();
    try {
      expect(reopened.getRunWorkspaceSetup(runId!)).toEqual({ profile, status: "completed" });
      const connection = new DatabaseSync(dbPath);
      try { connection.prepare("update run_workspace_setup set profile_json = ? where run_id = ?").run("broken", runId!); }
      finally { connection.close(); }
      expect(reopened.getRunWorkspaceSetup(runId!)).toBeNull();
      expect(() => reopened.getRunWorkspaceSetup(runId!, true)).toThrow("corrupted");
      reopened.deleteRun(runId!); expect(reopened.getRunWorkspaceSetup(runId!)).toBeNull();
    } finally { await reopened.close(); }
  });
});

