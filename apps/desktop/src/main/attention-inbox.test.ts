import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { RunInput } from "@buildwarden/shared";

const fixtures: Array<{ db: BuildWardenDatabase; dir: string }> = [];
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-inbox-"));
  const db = new BuildWardenDatabase(join(dir, "state.sqlite")); await db.init(); fixtures.push({ db, dir });
  const project = db.addProject({ repoPath: dir, baseBranch: "main", resolvedName: "Project" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
  const run = (extra: Partial<RunInput> = {}) => db.createRun({ projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server", mode: "code", workspaceType: "worktree", prompt: "Implement", branchName: "work", worktreePath: dir, ...extra });
  return { db, project, run };
};
afterEach(async () => { vi.useRealTimers(); for (const { db, dir } of fixtures.splice(0)) { await db.close(); await rm(dir, { recursive: true, force: true }); } });

describe("attention inbox", () => {
  it("prioritizes live requests across projects, including hidden child runs", async () => {
    const { db, run } = await fixture();
    const completed = run(); db.updateRunStatus(completed.id, "completed", { summary: "Done" });
    const failed = run(); db.updateRunStatus(failed.id, "failed", { errorMessage: "Verification failed" });
    const project2 = db.addProject({ repoPath: "/other", baseBranch: "main", resolvedName: "Other" });
    const child = run({ kind: "orchestration-task", projectId: project2.id }); db.updateRunStatus(child.id, "running");
    const step = db.appendRunStep(child.id, "approval-requested", "Approval", "pnpm install", JSON.stringify({ requestStatus: "opened", requestKind: "approval" }));
    expect(db.listAttentionInbox().map((item) => item.kind)).toEqual(["approval", "failed", "review"]);
    expect(db.listAttentionInbox()[0].projectName).toBe("Other");
    expect(() => db.acknowledgeAttentionItem(`request:${step.id}`)).toThrow("Resolve live requests");
    db.updateRunStep(step.id, { metadataJson: JSON.stringify({ requestStatus: "resolved" }) });
    expect(db.listAttentionInbox().some((item) => item.kind === "approval")).toBe(false);
  });
  it("does not show cancelled requests as actionable and does not resurface acknowledgements", async () => {
    const { db, run } = await fixture();
    const active = run(); db.updateRunStatus(active.id, "running");
    db.appendRunStep(active.id, "user-input-requested", "Question", "Which branch?", JSON.stringify({ requestStatus: "opened" }));
    expect(db.listAttentionInbox()[0].kind).toBe("input");
    db.updateRunStatus(active.id, "cancelled"); expect(db.listAttentionInbox()).toEqual([]);
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z")); db.updateRunStatus(active.id, "completed");
    const id = db.listAttentionInbox()[0].id; db.acknowledgeAttentionItem(id); db.acknowledgeAttentionItem(id);
    expect(db.listAttentionInbox()).toEqual([]);
    const reopened = new BuildWardenDatabase(db.getFilePath()); await reopened.init();
    try { expect(reopened.listAttentionInbox()).toEqual([]); } finally { await reopened.close(); }
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z")); db.updateRunStatus(active.id, "completed");
    expect(db.listAttentionInbox()[0].id).not.toBe(id);
  });
  it("keeps parked results out of the inbox and removes deleted runs", async () => {
    const { db, run } = await fixture(); const item = run();
    db.updateRunStatus(item.id, "completed");
    db.updateRunListVisibility(item.id, "for-later"); expect(db.listAttentionInbox()).toEqual([]);
    db.updateRunListVisibility(item.id, "default"); expect(db.listAttentionInbox()).toHaveLength(1);
    db.deleteRun(item.id); expect(db.listAttentionInbox()).toEqual([]);
  });
});
