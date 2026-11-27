import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, DEFAULT_ORCHESTRATION_TEAM_SETTINGS, buildDefaultOrchestrationTeam } from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { serviceOf } from "./controller-test-internals";
import { HostEventBus } from "./host-events";
import { describeModelMentions, type MentionableModel } from "./orchestration-tools";

const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-default-team-"));
  dirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "state.sqlite"));
  databases.push(db);
  await db.init();
  db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
  const project = db.addProject({ repoPath: dir, baseBranch: "main", resolvedName: "Project" });
  const claude = db.addProviderAccount({ providerType: "claude-code", label: "Claude", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const codex = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const opus = db.addModel({ providerAccountId: claude.id, modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", config: {}, capabilities: {}, enabled: true });
  const gpt = db.addModel({ providerAccountId: codex.id, modelId: "gpt-5.5", displayName: "GPT-5.5", config: {}, capabilities: {}, enabled: true });
  db.addModel({ providerAccountId: codex.id, modelId: "old", displayName: "Old", config: {}, capabilities: {}, enabled: false });
  const coordinator = db.createRun({
    projectId: project.id, providerAccountId: codex.id, modelId: gpt.id, harnessType: "codex-app-server", mode: "code",
    workspaceType: "local", branchName: "main", worktreePath: dir, prompt: "Coordinate", delegationEnabled: true,
  });
  const controller = new AppController(db, { readSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => undefined }, dir,
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: vi.fn() }, new HostEventBus());
  return { db, controller, coordinator, opus, gpt };
};

describe("default orchestration team", () => {
  it("covers every enabled model with one general role that prefers the coordinator's model", () => {
    const team = buildDefaultOrchestrationTeam(DEFAULT_ORCHESTRATION_TEAM_SETTINGS, ["a", "b"], "b");
    expect(team.roles).toEqual([expect.objectContaining({ id: "general", eligibleModelIds: ["a", "b"], preferredModelId: "b", maxConcurrent: 3 })]);
    expect(team.models).toEqual([{ modelId: "a", enabled: true, maxConcurrent: 2 }, { modelId: "b", enabled: true, maxConcurrent: 2 }]);
    expect(buildDefaultOrchestrationTeam(DEFAULT_ORCHESTRATION_TEAM_SETTINGS, ["a"], "gone").roles[0]?.preferredModelId).toBe("a");
    expect(buildDefaultOrchestrationTeam(DEFAULT_ORCHESTRATION_TEAM_SETTINGS, []).roles).toEqual([]);
  });

  it("keeps the limits the user set for a model", () => {
    const base = { ...DEFAULT_ORCHESTRATION_TEAM_SETTINGS, maxConcurrentTasks: 3, models: [{ modelId: "a", enabled: true, maxConcurrent: 1 }] };
    expect(buildDefaultOrchestrationTeam(base, ["a", "b"]).models).toEqual([
      { modelId: "a", enabled: true, maxConcurrent: 1 }, { modelId: "b", enabled: true, maxConcurrent: 2 },
    ]);
  });

  it("lets a run delegate without any team setup, and keeps a configured team as it is", async () => {
    const { db, controller, coordinator, opus, gpt } = await fixture();
    const orchestration = serviceOf(controller, "orchestration").getOrCreateOrchestration(coordinator);
    // Models created in the same millisecond list in no fixed order.
    expect(orchestration.teamSnapshot.roles).toEqual([expect.objectContaining({ id: "general", preferredModelId: gpt.id })]);
    expect([...orchestration.teamSnapshot.roles[0]!.eligibleModelIds].sort()).toEqual([opus.id, gpt.id].sort());

    db.setSetting(APP_SETTING_KEYS.orchestrationTeam, JSON.stringify({
      version: 1, maxConcurrentTasks: 2, maxTasksPerOrchestration: 4,
      models: [{ modelId: opus.id, enabled: true, maxConcurrent: 1 }],
      roles: [{ id: "reviewer", name: "Reviewer", description: "Reviews.", eligibleModelIds: [opus.id], preferredModelId: opus.id, maxConcurrent: 1 }],
    }));
    expect(serviceOf(controller, "orchestration").resolveOrchestrationTeamSettings(gpt.id).roles.map((role) => role.id)).toEqual(["reviewer"]);
  });

  it("keeps a model switched off in the pool out of the General role", async () => {
    const { db, controller, opus, gpt } = await fixture();
    db.setSetting(APP_SETTING_KEYS.orchestrationTeam, JSON.stringify({
      version: 1, maxConcurrentTasks: 3, maxTasksPerOrchestration: 12, models: [{ modelId: opus.id, enabled: false, maxConcurrent: 1 }], roles: [],
    }));
    const team = serviceOf(controller, "orchestration").resolveOrchestrationTeamSettings(gpt.id);
    expect(team.roles[0]?.eligibleModelIds).toEqual([gpt.id]);
    expect(team.models.map((model) => model.modelId)).toEqual([gpt.id]);
  });

  it("notes the models a coordinator's prompt names with @", async () => {
    const { controller, coordinator, opus } = await fixture();
    const prompt = serviceOf(controller, "orchestration").withModelMentions(coordinator, "Review this with @opus, mail me@example.com");
    expect(prompt).toContain(`- @opus: "${opus.id}" (Claude Opus 5.5, Claude)`);
    expect(prompt).not.toContain("example.com:");
    expect(serviceOf(controller, "orchestration").withModelMentions({ ...coordinator, delegationEnabled: false }, "@opus")).toBe("@opus");
  });
});

describe("describeModelMentions", () => {
  const models: MentionableModel[] = [
    { id: "m1", modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", providerLabel: "Claude", providerType: "claude-code" },
    { id: "m2", modelId: "opus", displayName: "Opus via OpenCode", providerLabel: "OpenCode", providerType: "acp" },
    { id: "m3", modelId: "gpt-5.5", displayName: "GPT-5.5", providerLabel: "Codex", providerType: "codex-cli" },
  ];

  it("resolves names, narrows by provider, and lists ambiguous matches", () => {
    const note = describeModelMentions("Use @gpt-5.5 for code, @opus:opencode for review and @opus as backup. Thanks @maria", models)!;
    expect(note).toContain('- @gpt-5.5: "m3" (GPT-5.5, Codex)');
    expect(note).toContain('- @opus:opencode: "m2" (Opus via OpenCode, OpenCode)');
    expect(note).toContain('- @opus: ambiguous, one of "m1" (Claude Opus 5.5, Claude), "m2" (Opus via OpenCode, OpenCode)');
    expect(note).not.toContain("@maria");
  });

  it("leaves sentence punctuation out of a mention", () => {
    const note = describeModelMentions("Review with @gpt-5.5. Then ask @opus:opencode.", models)!;
    expect(note).toContain('- @gpt-5.5: "m3"');
    expect(note).toContain('- @opus:opencode: "m2"');
  });

  it("adds nothing when no mention names a model", () => {
    expect(describeModelMentions("Ask @maria and see user@host", models)).toBeNull();
  });
});
