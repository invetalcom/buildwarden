import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpHarnessAdapter, listAcpSessions, readAcpSessionTranscript, readElicitationForm } from "@buildwarden/provider-acp";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, type HarnessRunChunk, type RunExecutionRequest, type RunUserInputRequest } from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { HostEventBus } from "./host-events";

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

/**
 * An agent with the optional session methods. FAKE_CAPS lists the session capabilities it
 * advertises; FAKE_ELICIT makes its prompt ask a form first.
 */
const LIFECYCLE_AGENT = String.raw`
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const log = (entry) => appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(entry) + "\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const caps = (process.env.FAKE_CAPS ?? "").split(",").filter(Boolean);
const waiting = new Map();
let nextId = 1;
const request = (method, params) => new Promise((resolve) => {
  const id = "agent-" + nextId++;
  waiting.set(id, resolve);
  send({ id, method, params });
});
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
const modeOptions = (current) => [{ id: "mode", type: "select", currentValue: current, options: [{ value: "code", name: "Code" }, { value: "plan", name: "Plan" }] }];
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) {
    waiting.get(message.id)?.(message.result ?? { error: message.error });
    return;
  }
  const { id, method, params } = message;
  log({ method, params });
  if (method === "initialize") {
    const sessionCapabilities = Object.fromEntries(caps.filter((cap) => cap !== "load").map((cap) => [cap, {}]));
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: caps.includes("load"), sessionCapabilities, mcpCapabilities: { http: true } } } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId: "fresh-1" } });
  } else if (method === "session/fork") {
    send({ id, result: { sessionId: "forked-1" } });
  } else if (method === "session/resume") {
    if (process.env.FAKE_RESUME_FAILS) send({ id, error: { code: -32603, message: "cannot resume this one" } });
    else if (process.env.FAKE_MODE_RACE) {
      // The answer still says plan; the agent switched to code right after, in the same write.
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { configOptions: modeOptions("plan") } }) + "\n"
        + JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: modeOptions("code") } } }) + "\n");
    } else send({ id, result: {} });
  } else if (method === "session/set_config_option") {
    send({ id, result: { configOptions: modeOptions(params.value) } });
  } else if (method === "session/load" && process.env.FAKE_BIG_REPLAY) {
    for (let index = 0; index < 2; index += 1) update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a".repeat(1_500_000) } });
    send({ id, result: {} });
  } else if (method === "session/load") {
    update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Fix the " } });
    update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "build" } });
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Fixed " } });
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "it." } });
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Anything else?" } });
    update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "t", title: "Edit", kind: "edit", status: "completed" });
    update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Thanks" } });
    send({ id, result: {} });
  } else if (method === "session/list") {
    send({ id, result: params.cursor
      ? { sessions: [{ sessionId: "s-old", cwd: params.cwd }, { sessionId: "x".repeat(501), cwd: params.cwd }] }
      : { sessions: [{ sessionId: "s-new", cwd: params.cwd, title: "Fix build", updatedAt: "2026-11-26T10:00:00Z" }], nextCursor: "page-2" } });
  } else if (method === "session/prompt") {
    let answer = "";
    if (process.env.FAKE_ELICIT) {
      const response = await request("session/elicitation", { sessionId: params.sessionId, mode: "form", message: "Pick a target",
        requestedSchema: { type: "object", required: ["target"], properties: {
          target: { type: "string", title: "Target", oneOf: [{ const: "prod", title: "Production" }, { const: "dev", title: "Development" }] },
          confirm: { type: "boolean", title: "Confirm" },
          count: { type: "integer", title: "Count" },
        } } });
      answer = " " + JSON.stringify(response);
    }
    const text = params.prompt.map((block) => block.text ?? "").join("");
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "session=" + params.sessionId + " fallback=" + text.includes("<earlier_conversation>") + answer } });
    send({ id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined) {
    send({ id, result: null });
  }
});
`;

const setup = (caps: string[], env: string[] = []) => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-acp-life-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const script = join(root, "agent.mjs");
  const log = join(root, "agent.log");
  writeFileSync(script, LIFECYCLE_AGENT);
  writeFileSync(log, "");
  const config = { acpCommand: `"${process.execPath}" "${script}"`, acpEnv: [`FAKE_ACP_LOG=${log}`, `FAKE_CAPS=${caps.join(",")}`, ...env].join("\n") };
  const input: RunExecutionRequest = {
    runId: "run-1", providerAccountId: "acp-1", worktreePath: workspace, mode: "code", prompt: "Continue",
    providerType: "acp", modelId: "default", apiKey: "", config, resumeFallbackContext: "user: earlier",
  };
  const methods = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  return { input, workspace, config, methods };
};

const run = async (adapter: AcpHarnessAdapter, input: RunExecutionRequest) => {
  const chunks: HarnessRunChunk[] = [];
  const result = await adapter.run(input, { tools: [], executeTool: vi.fn() }, (chunk) => chunks.push(chunk), new AbortController().signal);
  return { result, chunks };
};

const session = (resumeCursor: Record<string, unknown>): RunExecutionRequest["providerSessionRuntime"] => ({
  ownerId: "run-1", ownerKind: "run", providerAccountId: "acp-1", providerType: "acp", harnessType: "acp", status: "ready",
  cwd: "/", modelId: null, runtimeMode: "code", resumeCursor, runtimePayload: null, lastSeenAt: "", createdAt: "", updatedAt: "",
});

describe("ACP native session fork", () => {
  it("forks the source session into the fork's workspace and keeps the new session", async () => {
    const { input, workspace, methods } = setup(["fork", "load"]);
    const { result, chunks } = await run(new AcpHarnessAdapter(), { ...input, providerSessionRuntime: session({ forkFromSessionId: "source-1" }) });
    expect(result.summary).toBe("session=forked-1 fallback=false");
    expect(methods().find((entry) => entry.method === "session/fork")?.params).toMatchObject({ sessionId: "source-1", cwd: workspace });
    expect(methods().some((entry) => entry.method === "session/new" || entry.method === "session/load")).toBe(false);
    expect(result.providerSessionRuntime?.resumeCursor).toEqual({ sessionId: "forked-1" });
    expect(chunks.some((chunk) => chunk.value.includes("Forked the agent's session"))).toBe(true);
  });

  it("starts a fresh session with the conversation when the agent cannot fork", async () => {
    const { input, methods } = setup(["load"]);
    const { result, chunks } = await run(new AcpHarnessAdapter(), { ...input, providerSessionRuntime: session({ forkFromSessionId: "source-1" }) });
    expect(result.summary).toBe("session=fresh-1 fallback=true");
    expect(methods().some((entry) => entry.method === "session/fork")).toBe(false);
    expect(chunks.some((chunk) => chunk.value.includes("cannot fork sessions"))).toBe(true);
  });
});

describe("ACP session resume", () => {
  it("resumes without a replay when the agent offers session/resume", async () => {
    const { input, methods } = setup(["resume", "load"]);
    const { result } = await run(new AcpHarnessAdapter(), { ...input, providerSessionRuntime: session({ sessionId: "prior-1" }) });
    expect(result.summary).toBe("session=prior-1 fallback=false");
    expect(methods().map((entry) => entry.method)).toContain("session/resume");
    expect(methods().map((entry) => entry.method)).not.toContain("session/load");
  });

  it("keeps a mode change that arrives right after the resume answer", async () => {
    const { input, methods } = setup(["resume"], ["FAKE_MODE_RACE=1"]);
    await run(new AcpHarnessAdapter(), { ...input, mode: "plan", providerSessionRuntime: session({ sessionId: "prior-1" }) });
    // The agent is in code mode now, so the inspect turn has to select plan again.
    expect(methods().find((entry) => entry.method === "session/set_config_option")?.params).toMatchObject({ configId: "mode", value: "plan" });
  });

  it("loads the session when the agent offers both and cannot resume this one", async () => {
    const { input, methods } = setup(["resume", "load"], ["FAKE_RESUME_FAILS=1"]);
    const { result } = await run(new AcpHarnessAdapter(), { ...input, providerSessionRuntime: session({ sessionId: "prior-1" }) });
    expect(result.summary).toBe("session=prior-1 fallback=false");
    expect(methods().map((entry) => entry.method).filter((method) => method.startsWith("session/") && method !== "session/prompt"))
      .toEqual(["session/resume", "session/load"]);
  });

  it("falls back to a fresh session with the conversation when nothing can reopen it", async () => {
    const { input } = setup([]);
    const { result } = await run(new AcpHarnessAdapter(), { ...input, providerSessionRuntime: session({ sessionId: "prior-1" }) });
    expect(result.summary).toBe("session=fresh-1 fallback=true");
  });
});

describe("ACP form elicitation", () => {
  it("asks the form as a question card and returns typed answers", async () => {
    const { input, methods } = setup([], ["FAKE_ELICIT=1"]);
    const asked: RunUserInputRequest[] = [];
    const requestUserInput = vi.fn(async (request: RunUserInputRequest) => {
      asked.push(request);
      return { field_0: "Production", field_1: "Yes", field_2: "3" };
    });
    const { result } = await run(new AcpHarnessAdapter(undefined, { requestUserInput }), input);
    expect(methods()[0]?.params).toMatchObject({ clientCapabilities: { elicitation: { form: {} } } });
    expect(asked[0]).toMatchObject({ content: "Pick a target", questions: [
      { id: "field_0", header: "Target", options: [{ label: "Production" }, { label: "Development" }] },
      { id: "field_1", header: "Confirm", options: [{ label: "Yes" }, { label: "No" }] },
      { id: "field_2", header: "Count", options: [], allowCustomAnswer: true },
    ] });
    expect(result.summary).toBe('session=fresh-1 fallback=false {"action":"accept","content":{"target":"prod","confirm":true,"count":3}}');
  });

  it("cancels when a required field is left without a valid answer, and advertises nothing without a way to ask", async () => {
    const form = readElicitationForm({ mode: "form", message: "?", requestedSchema: { required: ["n"], properties: { n: { type: "integer" } } } })!;
    expect(form.respond({ field_0: "many" })).toEqual({ action: "cancel" });
    expect(form.respond({ field_0: "4" })).toEqual({ action: "accept", content: { n: 4 } });
    expect(readElicitationForm({ mode: "url", url: "https://example.test" })).toBeNull();

    const { input, methods } = setup([]);
    await run(new AcpHarnessAdapter(), input);
    expect(methods()[0]?.params.clientCapabilities).not.toHaveProperty("elicitation");
  });

  it("resolves a choice by its label before another choice's value, and refuses labels it cannot tell apart", () => {
    const choices = (oneOf: unknown[]) => readElicitationForm({ mode: "form", requestedSchema: { required: ["color"], properties: { color: { type: "string", oneOf } } } });
    const form = choices([{ const: "blue", title: "Ocean" }, { const: "green", title: "blue" }])!;
    expect(form.respond({ field_0: "blue" })).toEqual({ action: "accept", content: { color: "green" } });
    expect(form.respond({ field_0: "Ocean" })).toEqual({ action: "accept", content: { color: "blue" } });
    expect(choices([{ const: "a", title: "Same" }, { const: "b", title: "Same" }])).toBeNull();
  });

  it("keeps an answer whose schema property is named __proto__", () => {
    const form = readElicitationForm(JSON.parse('{"mode":"form","requestedSchema":{"required":["__proto__"],"properties":{"__proto__":{"type":"string"}}}}'))!;
    const response = form.respond({ field_0: "kept" });
    expect(JSON.stringify(response)).toBe('{"action":"accept","content":{"__proto__":"kept"}}');
  });
});

describe("ACP saved sessions", () => {
  it("lists the sessions the agent saved for a folder across pages", async () => {
    const { workspace, config } = setup(["list"]);
    await expect(listAcpSessions({ cwd: workspace, config })).resolves.toEqual({ supported: true, sessions: [
      { sessionId: "s-new", cwd: workspace, title: "Fix build", updatedAt: "2026-11-26T10:00:00Z" },
      { sessionId: "s-old", cwd: workspace, title: null, updatedAt: null },
    ] });
    const unsupported = setup([]);
    await expect(listAcpSessions({ cwd: unsupported.workspace, config: unsupported.config })).resolves.toEqual({ supported: false, sessions: [] });
  });

  it("imports a saved session as a run that continues it", async () => {
    const { workspace, config } = setup(["load", "list"]);
    const db = new BuildWardenDatabase(join(workspace, "..", "buildwarden.sqlite"));
    await db.init();
    try {
      db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
      const project = db.addProject({ repoPath: workspace, baseBranch: "main", resolvedName: "Imports", kind: "folder" });
      const provider = db.addProviderAccount({ providerType: "acp", label: "Agent", apiBaseUrl: null, apiKeyRef: "", configJson: JSON.stringify(config) });
      const model = db.addModel({ providerAccountId: provider.id, modelId: "default", displayName: "Agent default", config: {}, capabilities: {}, enabled: true });
      const controller = new AppController(db, { readSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => undefined }, join(workspace, "..", "logs"),
        { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
        { killForRunId: () => {} }, new HostEventBus());

      expect((await controller.listAcpAgentSessions(provider.id, project.id)).sessions.map((entry) => [entry.sessionId, entry.imported]))
        .toEqual([["s-new", false], ["s-old", false]]);
      const imported = await controller.importAcpAgentSession({ providerAccountId: provider.id, projectId: project.id, sessionId: "s-new", title: "Fix build" });
      expect(imported).toMatchObject({ status: "completed", workspaceType: "local", worktreePath: workspace, modelId: model.id, summary: "Anything else?" });
      expect(db.getRunSteps(imported.id).map((entry) => [entry.eventType, entry.content.split(".")[0]])).toEqual([
        ["log", "Fix the build"], ["output", "Fixed it"], ["output", "Anything else?"], ["log", "Thanks"], ["status", "Imported the agent's session from Agent"],
      ]);
      expect(db.getProviderAccountSessionRuntime(imported.id, "run", provider.id)?.resumeCursor).toEqual({ sessionId: "s-new" });
      expect((await controller.listAcpAgentSessions(provider.id, project.id)).sessions.map((entry) => entry.imported)).toEqual([true, false]);
      await expect(controller.importAcpAgentSession({ providerAccountId: "missing", projectId: project.id, sessionId: "s" })).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it("reads a saved session's conversation from its replay", async () => {
    const { workspace, config } = setup(["load"]);
    await expect(readAcpSessionTranscript({ cwd: workspace, sessionId: "s-new", config })).resolves.toEqual({ loaded: true, messages: [
      { role: "user", text: "Fix the build" },
      { role: "assistant", text: "Fixed it." },
      { role: "assistant", text: "Anything else?" },
      { role: "user", text: "Thanks" },
    ] });
  });

  it("keeps a replayed conversation within its character budget, the last chunk included", async () => {
    const { workspace, config } = setup(["load"], ["FAKE_BIG_REPLAY=1"]);
    const { messages } = await readAcpSessionTranscript({ cwd: workspace, sessionId: "s-new", config });
    expect(messages.map((message) => [message.role, message.text.length])).toEqual([["assistant", 2_000_000]]);
  });
});
