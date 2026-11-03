import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, extractSkillMentions } from "@buildwarden/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SkillService } from "./skill-service";
import { skillPackagePath } from "./skill-packages";

const fixtures: Array<{ db: BuildWardenDatabase; root: string }> = [];
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "buildwarden-skill-service-"));
  const db = new BuildWardenDatabase(join(root, "app.sqlite")); await db.init();
  fixtures.push({ db, root });
  const service = new SkillService(db);
  const source = await mkdtemp(join(root, "source-"));
  await writeFile(join(source, "SKILL.md"), "---\nname: example\ndescription: Test workflow\n---\nVersion one");
  const imported = await service.import({ source: "local", path: source });
  return { root, source, db, service, id: imported.id };
};
afterEach(async () => { for (const { db, root } of fixtures.splice(0)) { await db.close(); await rm(root, { recursive: true, force: true }); } });

describe("skill selection and recovery", () => {
  it("preserves existing project defaults and global disables", async () => {
    const { db, service, id } = await setup();
    db.setSetting(APP_SETTING_KEYS.projectActiveSkills, JSON.stringify({ project: [id, "unknown"] }));
    const initial = await service.prepare("run", "run", "task", "project");
    expect(initial.packages.map((record) => record.metadata.id)).toEqual([id]);
    expect(initial.diagnostics.find((item) => item.skillId === "unknown")?.status).toBe("unavailable");
    db.setSetting(APP_SETTING_KEYS.integratedSkillsDisabled, JSON.stringify([id]));
    const disabled = await service.prepare("run", "run", `$skill(${id})`, "project");
    expect(disabled.packages).toEqual([]);
    expect(disabled.diagnostics[0]?.status).toBe("disabled");
  });

  it("supports explicit invocation without project selection and keeps it turn-scoped", async () => {
    const { service, id } = await setup();
    const explicit = await service.prepare("chat", "chat", `Use $skill(${id}) here`);
    expect(explicit.explicitIds).toEqual([id]);
    expect((await service.prepare("chat", "chat", "next turn")).packages).toEqual([]);
    expect(extractSkillMentions(`/native $skill(${id}) $skill(${id})`)).toEqual([id]);
  });

  it("distinguishes an empty override from project defaults", async () => {
    const { db, service, id } = await setup();
    db.setSetting(APP_SETTING_KEYS.projectActiveSkills, JSON.stringify({ project: [id] }));
    service.setSelection("run", "run", []);
    expect((await service.prepare("run", "run", "task", "project")).packages).toEqual([]);
    service.setSelection("run", "run", null);
    expect((await service.prepare("run", "run", "task", "project")).packages).toHaveLength(1);
  });

  it("pins instructions across update, removal, global disable, and DB reopen", async () => {
    const { db, root, source, service, id } = await setup();
    service.setSelection("run", "run", [id]);
    await service.prepare("run", "run", "task");
    service.recordEvent("run", "run", { skillEvent: true, skillId: id, skillStatus: "loaded" });
    const saved = db.getSessionSkills("run", "run")!;
    await writeFile(join(source, "SKILL.md"), "---\nname: example\ndescription: Test workflow\n---\nVersion two");
    const updated = await service.import({ source: "local", path: source });
    expect(updated.id).toBe(id);
    expect(updated.contentHash).not.toBe(saved.packages[0]?.hash);
    expect((await service.prepare("run", "run", "new turn")).packages[0]?.hash).toBe(updated.contentHash);
    service.remove(id);
    db.setSetting(APP_SETTING_KEYS.integratedSkillsDisabled, JSON.stringify([id]));
    await db.close(); await db.init();
    const reopened = new SkillService(db);
    expect(await reopened.prepare("run", "run", "recover", undefined, saved)).toEqual(saved);
    expect(db.getSessionSkills("run", "run")?.loadedIds).toEqual([id]);
    expect(await readFile(join(skillPackagePath(join(root, "skill-packages"), saved.packages[0]!.hash), "SKILL.md"), "utf8")).toContain("Version one");
  });

  it("cleans up session state when a run or chat is deleted", async () => {
    const { db, service, id, root } = await setup();
    const project = db.addProject({ repoPath: root, baseBranch: "main", resolvedName: "Test" });
    const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "Test", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
    const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
    const run = db.createRun({ projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "ai-sdk", mode: "code", workspaceType: "local", prompt: "task", branchName: "main", worktreePath: root });
    const chat = db.createChat(provider.id, model.id, "task", run.id);
    service.setSelection("run", run.id, [id]); service.setSelection("chat", chat.id, [id]);
    db.deleteRun(run.id);
    expect(db.getSessionSkills("run", run.id)).toBeNull();
    expect(db.getSessionSkills("chat", chat.id)).toBeNull();
    expect(db.listSkillPackages()).toHaveLength(1);
  });
});
