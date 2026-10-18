import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { DEFAULT_RUN_SECTION_COLOR } from "@buildwarden/shared";

const directories: string[] = [];
const databases: BuildWardenDatabase[] = [];
const fixture = async () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-run-sections-")); directories.push(dir);
  const path = join(dir, "state.sqlite");
  const db = new BuildWardenDatabase(path); await db.init(); databases.push(db);
  const project = db.addProject({ repoPath: "C:/repo", baseBranch: "main", resolvedName: "Repo" });
  const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "AI", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
  const createRun = () => db.createRun({ projectId: project.id, providerAccountId: provider.id, modelId: model.id,
    harnessType: "ai-sdk", mode: "code", workspaceType: "worktree", prompt: "Fix auth", branchName: "fix/auth", worktreePath: "C:/repo/worktrees/auth" });
  return { db, path, project, createRun, run: createRun() };
};

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sidebar run organization persistence", () => {
  it("migrates sections created before colors while keeping assignments", async () => {
    const { db, path, run } = await fixture();
    const section = db.createRunSection("Existing").sections[0]!;
    db.updateRunOrganization(run.id, { sectionId: section.id });
    await db.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("alter table run_sections drop column color");
    legacy.close();
    const upgraded = new BuildWardenDatabase(path); await upgraded.init(); databases.push(upgraded);
    expect(upgraded.getRunOrganization().sections[0]).toEqual({ ...section, color: DEFAULT_RUN_SECTION_COLOR });
    expect(upgraded.getRunOrganization().runs[0]?.sectionId).toBe(section.id);
  });

  it("persists custom and Uncategorized colors without altering runs, names, order or tags", async () => {
    const { db, path, run } = await fixture();
    const section = db.createRunSection("Auth", "#A78BFA").sections[0]!;
    expect(section.color).toBe("#a78bfa");
    db.updateRunOrganization(run.id, { sectionId: section.id, tags: ["auth"] });
    db.setRunSectionColor(section.id, "#FACC15");
    db.setRunSectionColor("uncategorized", "#123456");
    db.renameRunSection(section.id, "Authentication");
    expect(db.reorderRunSections([section.id]).sections[0]?.color).toBe("#facc15");
    const before = db.getRunOrganization();
    expect(() => db.setRunSectionColor(section.id, "red")).toThrow("hex color");
    expect(() => db.createRunSection("Invalid", "#fff")).toThrow("hex color");
    expect(() => db.setRunSectionColor("missing", "#123456")).toThrow("not found");
    expect(db.getRunOrganization()).toEqual(before);
    expect(db.getRun(run.id)).toEqual(run);
    await db.close();
    const reopened = new BuildWardenDatabase(path); await reopened.init(); databases.push(reopened);
    expect(reopened.getRunOrganization()).toEqual(before);
    expect(reopened.getRunOrganization().uncategorizedColor).toBe("#123456");
  });

  it("upgrades an existing database without changing its runs or requiring assignments", async () => {
    const { db, path, run } = await fixture();
    await db.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("drop table run_organization; drop table run_sections;");
    legacy.close();
    const upgraded = new BuildWardenDatabase(path); await upgraded.init(); databases.push(upgraded);
    expect(upgraded.getRun(run.id)).toEqual(run);
    expect(upgraded.getSnapshot().runOrganization).toEqual({ sections: [], runs: [] });
    const section = upgraded.createRunSection("Migrated work").sections[0]!;
    expect(upgraded.updateRunOrganization(run.id, { sectionId: section.id }).runs[0]?.sectionId).toBe(section.id);
  });

  it("defaults existing and new runs to Uncategorized; survives reopening without changing execution or workspace state", async () => {
    const { db, path, run, createRun } = await fixture();
    expect(db.getSnapshot().runOrganization).toEqual({ sections: [], runs: [] });
    const section = db.createRunSection(" This week ").sections[0]!;
    db.updateRunOrganization(run.id, { sectionId: section.id, tags: ["Auth", "auth", " bug "] });
    expect(db.getRun(run.id)).toEqual(run);
    const nextRun = createRun();
    expect(db.getRunOrganization().runs.some((record) => record.runId === nextRun.id)).toBe(false);
    await db.close();
    const reopened = new BuildWardenDatabase(path); await reopened.init(); databases.push(reopened);
    expect(reopened.getSnapshot().runOrganization).toEqual({ sections: [section], runs: [{ runId: run.id, sectionId: section.id, tags: ["auth", "bug"] }] });
    expect(reopened.getRun(run.id).worktreePath).toBe(run.worktreePath);
  });

  it("moves runs between sections and back, preserving tags and For Later state", async () => {
    const { db, run } = await fixture();
    const first = db.createRunSection("First").sections[0]!;
    const second = db.createRunSection("Second").sections[1]!;
    db.updateRunOrganization(run.id, { sectionId: first.id, tags: ["auth"] });
    db.updateRunListVisibility(run.id, "for-later");
    expect(db.updateRunOrganization(run.id, { sectionId: second.id }).runs[0]).toEqual({ runId: run.id, sectionId: second.id, tags: ["auth"] });
    expect(db.updateRunOrganization(run.id, { tags: ["fix"] }).runs[0]?.sectionId).toBe(second.id);
    expect(db.updateRunOrganization(run.id, { sectionId: null }).runs[0]).toEqual({ runId: run.id, sectionId: null, tags: ["fix"] });
    expect(db.getRun(run.id).listVisibility).toBe("for-later");
  });

  it("renames/reorders sections and safely removes one without deleting runs or tags", async () => {
    const { db, run } = await fixture();
    const first = db.createRunSection("First").sections[0]!;
    const second = db.createRunSection("Second").sections[1]!;
    db.renameRunSection(first.id, "Current");
    expect(db.reorderRunSections([second.id, first.id]).sections.map((section) => section.name)).toEqual(["Second", "Current"]);
    db.updateRunOrganization(run.id, { sectionId: first.id, tags: ["auth"] });
    expect(db.deleteRunSection(first.id).runs[0]).toEqual({ runId: run.id, sectionId: null, tags: ["auth"] });
    expect(db.getRun(run.id)).toEqual(run);
  });

  it("rejects invalid destinations, duplicate names and malformed updates atomically", async () => {
    const { db, run } = await fixture();
    const first = db.createRunSection("First").sections[0]!;
    db.updateRunOrganization(run.id, { sectionId: first.id, tags: ["auth"] });
    const before = db.getRunOrganization();
    expect(() => db.createRunSection(" FIRST ")).toThrow("already exists");
    expect(() => db.createRunSection("Uncategorized")).toThrow("section name");
    expect(() => db.createRunSection(" ")).toThrow("section name");
    expect(() => db.deleteRunSection("uncategorized")).toThrow("not found");
    expect(() => db.updateRunOrganization(run.id, { sectionId: "missing", tags: ["changed"] })).toThrow("not found");
    expect(() => db.updateRunOrganization(run.id, { tags: ["x".repeat(41)] })).toThrow("Invalid");
    expect(() => db.updateRunOrganization("missing", { sectionId: first.id })).toThrow();
    expect(() => db.reorderRunSections([first.id, first.id])).toThrow("exactly once");
    expect(db.getRunOrganization()).toEqual(before);
  });

  it("cleans assignments on run/project deletion while retaining reusable sections", async () => {
    const { db, project, run, createRun } = await fixture();
    const section = db.createRunSection("Work").sections[0]!;
    const other = createRun();
    db.updateRunOrganization(run.id, { sectionId: section.id });
    db.updateRunOrganization(other.id, { sectionId: section.id });
    db.deleteRun(run.id);
    expect(db.getRunOrganization().runs.map((record) => record.runId)).toEqual([other.id]);
    db.deleteProject(project.id);
    expect(db.getRunOrganization()).toEqual({ sections: [section], runs: [] });
  });
});
