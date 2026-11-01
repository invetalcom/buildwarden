/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_SETTING_KEYS, type AppSnapshot } from "@buildwarden/shared";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { scopedId } from "../../../../packages/renderer/src/lib/instance-identity";
import { runWorktreeTerminalSessionId } from "../../../../packages/renderer/src/components/app/run-worktree-terminal-session";
import { FederatedWorkspace } from "./federated-client";
import type { ConnectedInstance } from "./instance-manager";

vi.mock("@buildwarden/renderer", async () => ({
  ...await import("../../../../packages/renderer/src/lib/instance-identity"),
  ...await import("../../../../packages/renderer/src/lib/remote-buildwarden-client"),
}));
vi.mock("@buildwarden/renderer/logic", () => ({ EMPTY_SNAPSHOT: {} }));

const rawSnapshot = (): AppSnapshot => ({
  projects: [{ project: { id: "project", name: "Same name" }, runs: [{ id: "run", projectId: "project", modelId: "model", prompt: "run" }] }],
  models: [{ id: "model", modelId: "gpt-5", providerAccountId: "provider", displayName: "Model" }],
  providerAccounts: [{ id: "provider" }], chats: [{ id: "chat", modelId: "model" }], bookmarks: [], chatBookmarks: [],
  settings: {}, selectedProjectId: "project", selectedRunId: null, selectedChatId: null,
  runOrganization: { sections: [{ id: "section", name: "Work", position: 0 }], runs: [{ runId: "run", sectionId: "section", tags: [] }] },
} as unknown as AppSnapshot);

const setup = () => {
  const clients = ["a", "b"].map(() => ({
    capabilities: { platform: "web", mutations: true, settings: true, liveEvents: true },
    getUsageCostReport: vi.fn(async () => ({ models: [{ modelId: "gpt-5", matchedKey: "gpt-5" }], projects: [{ projectId: "project" }] })),
    getRunDetail: vi.fn(async () => ({ run: { id: "run", projectId: "project", modelId: "model" } })),
    createRun: vi.fn(async () => ({ id: "new", projectId: "project" })),
    followUpRun: vi.fn(async () => ({ id: "run" })),
    deleteRun: vi.fn(async () => undefined), setAppSetting: vi.fn(async () => undefined),
    listChatsWithSteps: vi.fn(async () => [{ chat: { id: "chat" }, steps: [] }] ),
    searchRunUserInput: vi.fn(async () => ["run"]),
    acknowledgeAttentionItems: vi.fn(async () => undefined),
    runTerminalStart: vi.fn(async () => ({ ok: true })),
    runTerminalWrite: vi.fn(async () => undefined), runTerminalResize: vi.fn(async () => undefined),
    sendRunBrowserInput: vi.fn(async () => undefined),
    respondToRunUserInput: vi.fn(async () => undefined),
    onRunEvent: vi.fn(() => vi.fn()), onRunBrowserEvent: vi.fn(() => vi.fn()),
    getIntegratedSkillContent: vi.fn(async () => "Skill body"),
  }));
  const entries = clients.map((client, i) => ({
    connection: { id: i ? "b" : "a", name: "Same name", hostOrigin: `https://${i}.example` },
    status: "online", client: client as unknown as BuildWardenClient, snapshot: rawSnapshot(),
  })) as ConnectedInstance[];
  const listeners = new Set<() => void>();
  const manager = {
    getSnapshot: () => ({ loaded: true, instances: entries }),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh: vi.fn(async () => undefined),
  };
  const workspace = new FederatedWorkspace(manager);
  return { workspace, client: workspace.client("a"), entries, a: clients[0], b: clients[1], manager, publish: () => listeners.forEach((fn) => fn()) };
};
beforeEach(() => localStorage.clear());

describe("integrated multi-instance workspace", () => {
  it("preserves usage model names while scoping project references", async () => {
    const { client } = setup();
    const report = await client.getUsageCostReport({ rangeDays: null });
    expect(report.models[0].modelId).toBe("gpt-5");
    expect(report.models[0].matchedKey).toBe("gpt-5");
    expect(report.projects[0].projectId).toBe(scopedId("a", "project"));
  });
  it("keeps identical IDs and names distinct and retains provider model identifiers", async () => {
    const { client } = setup();
    const snapshot = await client.getSnapshot();
    expect(snapshot.projects.map((p) => p.project.id)).toEqual([scopedId("a", "project"), scopedId("b", "project")]);
    expect(snapshot.projects.map((p) => p.project.name)).toEqual(["Same name", "Same name"]);
    expect(snapshot.projects[1].runs[0].modelId).toBe(scopedId("b", "model"));
    expect(snapshot.models[1]).toMatchObject({ id: scopedId("b", "model"), providerAccountId: scopedId("b", "provider"), modelId: "gpt-5" });
    expect(snapshot.runOrganization?.runs[1].sectionId).toBe(scopedId("b", "section"));
  });
  it("routes reads and mutations by item owner rather than the selected host", async () => {
    const { client, a, b } = setup();
    const detail = await client.getRunDetail(scopedId("b", "run"));
    await client.deleteRun(detail.run.id);
    expect(b.getRunDetail).toHaveBeenCalledWith("run");
    expect(b.deleteRun).toHaveBeenCalledWith("run");
    expect(a.deleteRun).not.toHaveBeenCalled();
    await expect(client.deleteRun("run")).rejects.toThrow("without an instance-owned item");
  });
  it("rejects cross-instance project/model combinations before dispatch", async () => {
    const { client, a, b } = setup();
    await expect(client.createRun({ projectId: scopedId("a", "project"), modelId: scopedId("b", "model") } as Parameters<BuildWardenClient["createRun"]>[0])).rejects.toThrow("different instances");
    expect(a.createRun).not.toHaveBeenCalled(); expect(b.createRun).not.toHaveBeenCalled();
  });
  it("does not reinterpret user prompts, answers, or execution controls as IDs", async () => {
    const { client, b } = setup();
    const text = scopedId("a", "literal text");
    await client.followUpRun(scopedId("b", "run"), text, { modelId: scopedId("b", "model") });
    expect(b.followUpRun).toHaveBeenCalledWith("run", text, { modelId: "model" });
    await client.respondToRunUserInput(scopedId("b", "run"), scopedId("b", "request"), { id: text });
    expect(b.respondToRunUserInput).toHaveBeenCalledWith("run", "request", { id: text });
  });
  it("keeps offline items visible, denies actions, and never falls back to another host", async () => {
    const { client, entries, a, b } = setup(); entries[1].status = "offline";
    expect((await client.getSnapshot()).projects).toHaveLength(2);
    await expect(client.deleteRun(scopedId("b", "run"))).rejects.toThrow("not connected");
    expect(a.deleteRun).not.toHaveBeenCalled(); expect(b.deleteRun).not.toHaveBeenCalled();
  });
  it("combines search and chat history and preserves cached history during an outage", async () => {
    const { client, b } = setup();
    expect(await client.searchRunUserInput("hello")).toEqual([scopedId("a", "run"), scopedId("b", "run")]);
    expect((await client.listChatsWithSteps()).map((item) => item.chat.id)).toEqual([scopedId("a", "chat"), scopedId("b", "chat")]);
    b.listChatsWithSteps.mockRejectedValueOnce(new Error("offline"));
    expect(await client.listChatsWithSteps()).toHaveLength(2);
  });
  it("partitions mixed-host batches and validates all destinations before sending", async () => {
    const { client, entries, a, b } = setup();
    await client.acknowledgeAttentionItems([scopedId("b", "alert"), scopedId("a", "alert")]);
    expect(a.acknowledgeAttentionItems).toHaveBeenCalledWith(["alert"]);
    expect(b.acknowledgeAttentionItems).toHaveBeenCalledWith(["alert"]);
    a.acknowledgeAttentionItems.mockClear(); entries[1].status = "offline";
    await expect(client.acknowledgeAttentionItems([scopedId("a", "next"), scopedId("b", "next")])).rejects.toThrow();
    expect(a.acknowledgeAttentionItems).not.toHaveBeenCalled();
  });
  it("scopes project-default dictionaries and decodes them only for their owning settings target", async () => {
    const { client, entries, a, b, workspace } = setup();
    const defaults = { project: { modelId: "model", worktreeModelIds: ["model"], modelConfigurations: { model: { reasoningEffort: "high" } }, mcpServers: [{ id: "external" }] } };
    entries[0].snapshot!.settings[APP_SETTING_KEYS.projectRunDefaults] = JSON.stringify(defaults);
    const value = (await client.getSnapshot()).settings[APP_SETTING_KEYS.projectRunDefaults];
    const mapped = JSON.parse(value);
    expect(mapped[scopedId("a", "project")].modelId).toBe(scopedId("a", "model"));
    expect(mapped[scopedId("a", "project")].mcpServers[0].id).toBe("external");
    workspace.selectInstance("b");
    await client.setAppSetting(APP_SETTING_KEYS.projectRunDefaults, value);
    expect(a.setAppSetting).toHaveBeenCalledWith(APP_SETTING_KEYS.projectRunDefaults, JSON.stringify(defaults));
    await expect(workspace.client("b").setAppSetting(APP_SETTING_KEYS.projectRunDefaults, value)).rejects.toThrow("different instance");
    expect(b.setAppSetting).not.toHaveBeenCalled();
    await expect(client.setAppSetting(APP_SETTING_KEYS.lastUsedRunModelId, scopedId("b", "model"))).rejects.toThrow("different instance");
  });
  it("preserves opaque orchestration role IDs while scoping model references", async () => {
    const { client, entries } = setup();
    entries[0].snapshot!.settings[APP_SETTING_KEYS.orchestrationTeam] = JSON.stringify({ roles: [{ id: "reviewer", modelId: "model" }] });
    const value = (await client.getSnapshot()).settings[APP_SETTING_KEYS.orchestrationTeam];
    expect(JSON.parse(value)).toEqual({ roles: [{ id: "reviewer", modelId: scopedId("a", "model") }] });
  });
  it("uses the same owner encoding for terminal RPCs and streamed terminal data", async () => {
    const { client, b } = setup();
    await client.runTerminalStart({ sessionId: runWorktreeTerminalSessionId(scopedId("b", "run")), cwd: "C:/repo" });
    expect(b.runTerminalStart).toHaveBeenCalledWith({ sessionId: "buildwarden-run-terminal:run", cwd: "C:/repo" });
  });
  it("routes repeated terminal and browser input without refreshing snapshots, while mutations still refresh", async () => {
    const { client, a, b, manager } = setup();
    const sessionId = runWorktreeTerminalSessionId(scopedId("b", "run"));
    for (const data of ["a", "b", "c"]) {
      await client.runTerminalWrite({ sessionId, data });
      await client.runTerminalResize({ sessionId, cols: 80, rows: 24 });
      await client.sendRunBrowserInput({ runId: scopedId("b", "run"), input: { type: "text", text: data } });
    }
    expect(b.runTerminalWrite).toHaveBeenCalledTimes(3);
    expect(b.runTerminalWrite).toHaveBeenLastCalledWith({ sessionId: "buildwarden-run-terminal:run", data: "c" });
    expect(b.runTerminalResize).toHaveBeenLastCalledWith({ sessionId: "buildwarden-run-terminal:run", cols: 80, rows: 24 });
    expect(b.sendRunBrowserInput).toHaveBeenLastCalledWith({ runId: "run", input: { type: "text", text: "c" } });
    expect(a.runTerminalWrite).not.toHaveBeenCalled();
    expect(a.runTerminalResize).not.toHaveBeenCalled();
    expect(a.sendRunBrowserInput).not.toHaveBeenCalled();
    expect(manager.refresh).not.toHaveBeenCalled();
    await client.deleteRun(scopedId("b", "run"));
    expect(manager.refresh).toHaveBeenCalledExactlyOnceWith("b");
  });
  it("binds event streams independently and removes subscriptions when a host is removed", () => {
    const { client, a, b, entries, publish } = setup();
    const listener = vi.fn(); const dispose = client.onRunEvent(listener);
    const callback = b.onRunEvent.mock.calls[0] as unknown as [(value: unknown) => void];
    callback[0]({ runId: "run", content: "run" });
    expect(listener).toHaveBeenCalledWith({ runId: scopedId("b", "run"), content: "run" });
    entries.pop(); publish();
    expect(b.onRunEvent.mock.results[0].value).toHaveBeenCalled();
    dispose(); expect(a.onRunEvent.mock.results[0].value).toHaveBeenCalled();
  });
  it("keeps skill catalog identities usable and persists project selection with its owner", async () => {
    const { client, workspace, a } = setup();
    await client.getIntegratedSkillContent("source:skill");
    expect(a.getIntegratedSkillContent).toHaveBeenCalledWith("source:skill");
    await client.selectProject(scopedId("b", "project"));
    expect(workspace.activeInstanceId).toBe("b");
    expect(workspace.snapshot("b").selectedProjectId).toBe(scopedId("b", "project"));
  });
});
