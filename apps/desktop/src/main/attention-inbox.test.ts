import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, ATTENTION_KIND_LABELS, parseAttentionInboxSettings, type AttentionKind, type RunInput } from "@buildwarden/shared";

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
  it("keeps a suppressed blocked episode hidden through updates and restarts until attention clears", async () => {
    const { db, project, run } = await fixture();
    const coordinator = run();
    const orchestration = db.createOrchestration({ projectId: project.id, coordinatorRunId: coordinator.id,
      teamSnapshot: { version: 1, maxConcurrentTasks: 1, maxTasksPerOrchestration: 1, models: [], roles: [] } });
    const preferences = parseAttentionInboxSettings();
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    preferences.kinds.blocked = false;
    db.setSetting(APP_SETTING_KEYS.attentionInbox, JSON.stringify(preferences));
    vi.setSystemTime(new Date("2026-10-04T00:01:00Z"));
    db.updateOrchestration(orchestration.id, { status: "attention" });
    vi.setSystemTime(new Date("2026-10-04T00:02:00Z"));
    preferences.kinds.blocked = true;
    db.setSetting(APP_SETTING_KEYS.attentionInbox, JSON.stringify(preferences));
    vi.setSystemTime(new Date("2026-10-04T00:03:00Z"));
    db.updateOrchestration(orchestration.id, { status: "attention", errorMessage: "Still blocked" });
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, type: "status", title: "Update", content: "Still blocked" });
    expect(db.listAttentionInbox()).toEqual([]);
    const reopened = new BuildWardenDatabase(db.getFilePath()); await reopened.init();
    try {
      expect(reopened.listAttentionInbox()).toEqual([]);
      reopened.updateOrchestration(orchestration.id, { status: "active" });
      vi.setSystemTime(new Date("2026-10-04T00:04:00Z"));
      reopened.updateOrchestration(orchestration.id, { status: "attention" });
      const notice = reopened.listAttentionInbox()[0];
      expect(notice).toMatchObject({ kind: "blocked", createdAt: "2026-10-04T00:04:00.000Z" });
      vi.setSystemTime(new Date("2026-10-04T00:05:00Z"));
      reopened.updateOrchestration(orchestration.id, { lastDeliveredSequence: 1 });
      reopened.appendOrchestrationEvent({ orchestrationId: orchestration.id, type: "status", title: "Update", content: "Still blocked" });
      expect(reopened.listAttentionInbox()).toEqual([notice]);
    } finally { await reopened.close(); }
  });
  it("backfills a stable blocked notice timestamp when upgrading an older database", async () => {
    const { db, project, run } = await fixture();
    const orchestration = db.createOrchestration({ projectId: project.id, coordinatorRunId: run().id,
      teamSnapshot: { version: 1, maxConcurrentTasks: 1, maxTasksPerOrchestration: 1, models: [], roles: [] } });
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    db.updateOrchestration(orchestration.id, { status: "attention" });
    const legacy = new DatabaseSync(db.getFilePath());
    try { legacy.exec("alter table orchestrations drop column attention_started_at"); } finally { legacy.close(); }
    const reopened = new BuildWardenDatabase(db.getFilePath()); await reopened.init();
    try {
      vi.setSystemTime(new Date("2026-10-04T00:01:00Z"));
      reopened.updateOrchestration(orchestration.id, { errorMessage: "Still blocked" });
      expect(reopened.listAttentionInbox()[0]).toMatchObject({
        id: `orchestration:${orchestration.id}:2026-10-04T00:00:00.000Z`, createdAt: "2026-10-04T00:00:00.000Z",
      });
    } finally { await reopened.close(); }
  });
  it.each(Object.keys(ATTENTION_KIND_LABELS) as AttentionKind[])("suppresses %s publication while disabled, including after a restart", async (kind) => {
    const { db, project, run } = await fixture();
    const createEvent = () => {
      const item = run();
      if (kind === "review" || kind === "failed") {
        db.updateRunStatus(item.id, kind === "review" ? "completed" : "failed");
      } else {
        db.updateRunStatus(item.id, "running");
        if (kind === "blocked") {
          const orchestration = db.createOrchestration({ projectId: project.id, coordinatorRunId: item.id,
            teamSnapshot: { version: 1, maxConcurrentTasks: 1, maxTasksPerOrchestration: 1, models: [], roles: [] } });
          db.updateOrchestration(orchestration.id, { status: "attention" });
        } else {
          db.appendRunStep(item.id, kind === "approval" ? "approval-requested" : "user-input-requested", "Request", "Details", JSON.stringify({ requestStatus: "opened" }));
        }
      }
      return item.id;
    };
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    const earlier = createEvent();
    vi.setSystemTime(new Date("2026-10-04T00:01:00Z"));
    const preferences = parseAttentionInboxSettings();
    preferences.kinds[kind] = false;
    db.setSetting(APP_SETTING_KEYS.attentionInbox, JSON.stringify(preferences));
    vi.setSystemTime(new Date("2026-10-04T00:02:00Z"));
    const suppressed = createEvent();
    expect(db.listAttentionInbox()).toEqual([]);
    // Run history remains intact even when inbox publication is disabled.
    expect(db.getRun(suppressed)).toBeDefined();
    const reopened = new BuildWardenDatabase(db.getFilePath()); await reopened.init();
    try {
      expect(reopened.listAttentionInbox()).toEqual([]);
      vi.setSystemTime(new Date("2026-10-04T00:03:00Z"));
      preferences.kinds[kind] = true;
      reopened.setSetting(APP_SETTING_KEYS.attentionInbox, JSON.stringify(preferences));
      expect(reopened.listAttentionInbox().map((item) => item.runId)).toEqual([earlier]);
    } finally { await reopened.close(); }
    vi.setSystemTime(new Date("2026-10-04T00:04:00Z"));
    const latest = createEvent();
    expect(db.listAttentionInbox().map((item) => item.runId)).toEqual([latest, earlier]);
  });
  it("combines the master switch with individual choices and supports resetting preferences", async () => {
    const { db, run } = await fixture();
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    const preferences = parseAttentionInboxSettings();
    preferences.kinds.failed = false;
    db.setSetting(APP_SETTING_KEYS.attentionInbox, JSON.stringify(preferences));
    preferences.enabled = false;
    db.setSetting(APP_SETTING_KEYS.attentionInbox, JSON.stringify(preferences));
    vi.setSystemTime(new Date("2026-10-04T00:01:00Z"));
    db.updateRunStatus(run().id, "completed");
    db.updateRunStatus(run().id, "failed");
    expect(db.listAttentionInbox()).toEqual([]);
    vi.setSystemTime(new Date("2026-10-04T00:02:00Z"));
    preferences.enabled = true;
    db.setSetting(APP_SETTING_KEYS.attentionInbox, JSON.stringify(preferences));
    vi.setSystemTime(new Date("2026-10-04T00:03:00Z"));
    const result = run(); db.updateRunStatus(result.id, "completed");
    db.updateRunStatus(run().id, "failed");
    expect(db.listAttentionInbox().map((item) => item.runId)).toEqual([result.id]);
    vi.setSystemTime(new Date("2026-10-04T00:04:00Z"));
    db.deleteSetting(APP_SETTING_KEYS.attentionInbox);
    expect(db.listAttentionInbox().map((item) => item.runId)).toEqual([result.id]);
    vi.setSystemTime(new Date("2026-10-04T00:05:00Z"));
    const failure = run(); db.updateRunStatus(failure.id, "failed");
    expect(db.listAttentionInbox().map((item) => item.runId)).toEqual([failure.id, result.id]);
  });
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
  it("acknowledges a backlog with one candidate query, leaving new arrivals unread", async () => {
    const { db, run } = await fixture();
    for (let index = 0; index < 200; index++) db.updateRunStatus(run().id, "completed");
    const ids = db.listAttentionInbox().map((item) => item.id);
    const arrival = run(); db.updateRunStatus(arrival.id, "failed");
    const list = vi.spyOn(db, "listAttentionInbox");
    db.acknowledgeAttentionItems([...ids, ids[0], "stale-id"]);
    expect(list).toHaveBeenCalledTimes(1);
    db.acknowledgeAttentionItems(ids); // Retrying the same batch is harmless.
    expect(db.listAttentionInbox().map((item) => item.runId)).toEqual([arrival.id]);
    const reopened = new BuildWardenDatabase(db.getFilePath()); await reopened.init();
    try { expect(reopened.listAttentionInbox().map((item) => item.runId)).toEqual([arrival.id]); }
    finally { await reopened.close(); }
  });
  it("rejects an entire batch containing a live request", async () => {
    const { db, run } = await fixture();
    db.updateRunStatus(run().id, "completed");
    const active = run(); db.updateRunStatus(active.id, "running");
    db.appendRunStep(active.id, "approval-requested", "Approval", "Details", JSON.stringify({ requestStatus: "opened" }));
    const items = db.listAttentionInbox();
    expect(() => db.acknowledgeAttentionItems(items.map((item) => item.id).reverse())).toThrow("Resolve live requests");
    expect(db.listAttentionInbox()).toEqual(items);
  });
  it("rolls back earlier acknowledgements if a later database write fails", async () => {
    const { db, run } = await fixture();
    db.updateRunStatus(run().id, "completed");
    db.updateRunStatus(run().id, "completed");
    const items = db.listAttentionInbox();
    const connection = new DatabaseSync(db.getFilePath());
    try {
      connection.exec(`create trigger reject_ack before insert on attention_acknowledgements
        when new.run_id = '${items[1].runId}' begin select raise(abort, 'Test write failure'); end`);
      expect(() => db.acknowledgeAttentionItems(items.map((item) => item.id))).toThrow("Test write failure");
      expect(db.listAttentionInbox()).toEqual(items);
    } finally { connection.close(); }
  });
});
