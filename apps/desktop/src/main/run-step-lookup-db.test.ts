import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";

const tempDirs: string[] = [];
const dbs: BuildWardenDatabase[] = [];

const makeDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-run-step-lookup-db-"));
  tempDirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "buildwarden.sqlite"));
  await db.init();
  dbs.push(db);
  return db;
};

const addRun = (db: BuildWardenDatabase, repoPath = "C:\\repo") => {
  const project = db.addProject({ repoPath, baseBranch: "main", resolvedName: "Repo" });
  const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "AI SDK", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({
    providerAccountId: provider.id, modelId: "claude-fable-5", displayName: "Fable", config: {}, capabilities: {}, enabled: true,
  });
  return db.createRun({
    projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "ai-sdk", mode: "code",
    workspaceType: "worktree", prompt: "Implement", branchName: "main", worktreePath: "C:\\repo\\.buildwarden-worktrees\\run",
  });
};

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("getLatestUserCommandStep", () => {
  it("returns the latest user step with the command type", async () => {
    const db = await makeDb();
    const run = addRun(db);
    db.appendRunStep(run.id, "log", "Initial command", "First", JSON.stringify({ source: "user", commandType: "initial" }));
    db.appendRunStep(run.id, "log", "Follow-up", "Second", JSON.stringify({ source: "user", commandType: "follow-up" }));
    const latest = db.appendRunStep(run.id, "log", "Follow-up", "Third", JSON.stringify({ source: "user", commandType: "follow-up" }));
    db.appendRunStep(run.id, "output", "Agent output", "Answer", "{}");

    expect(db.getLatestUserCommandStep(run.id, "follow-up")).toMatchObject({ id: latest.id, content: "Third" });
    expect(db.getLatestUserCommandStep(run.id, "initial")).toMatchObject({ content: "First" });
  });

  it("orders steps written in the same millisecond by when they were written", async () => {
    const db = await makeDb();
    const run = addRun(db);
    const first = db.appendRunStep(run.id, "log", "Follow-up", "First", JSON.stringify({ source: "user", commandType: "follow-up" }));
    const second = db.appendRunStep(run.id, "log", "Follow-up", "Second", JSON.stringify({ source: "user", commandType: "follow-up" }));
    const raw = new DatabaseSync(db.getFilePath());
    try {
      raw.prepare("update run_steps set created_at = ? where id in (?, ?)").run(first.createdAt, first.id, second.id);
    } finally {
      raw.close();
    }

    expect(db.getLatestUserCommandStep(run.id, "follow-up")?.id).toBe(second.id);
  });

  it("skips steps of other sources, other runs and metadata that is not JSON", async () => {
    const db = await makeDb();
    const run = addRun(db);
    const other = addRun(db, "C:\\other");
    db.appendRunStep(run.id, "log", "Note", "Agent", JSON.stringify({ source: "agent", commandType: "follow-up" }));
    db.appendRunStep(other.id, "log", "Follow-up", "Other run", JSON.stringify({ source: "user", commandType: "follow-up" }));
    const broken = db.appendRunStep(run.id, "log", "Follow-up", "Broken", "{}");
    const raw = new DatabaseSync(db.getFilePath());
    try {
      raw.prepare("update run_steps set metadata_json = ? where id = ?").run("{not json", broken.id);
    } finally {
      raw.close();
    }

    expect(db.getLatestUserCommandStep(run.id, "follow-up")).toBeNull();
  });
});
