import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpHarnessAdapter, AcpTerminals, resolveWorkspacePath, terminalCommandLine } from "@buildwarden/provider-acp";
import type { HarnessRunChunk, RunExecutionRequest } from "@buildwarden/shared";

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

const workspaceRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-acp-term-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { root, workspace };
};

type Authorize = (commandLine: string, request: { command: string; args: string[] }) => Promise<void>;

const terminalsFor = (workspace: string, authorize = vi.fn<Authorize>(async () => undefined)) => ({
  authorize,
  terminals: new AcpTerminals({ workspace, authorize, resolveCwd: (requested) => resolveWorkspacePath(workspace, requested) }),
});

describe("ACP terminals", () => {
  it("runs an approved command in the workspace and reports its output and exit", async () => {
    const { workspace } = workspaceRoot();
    const { terminals, authorize } = terminalsFor(workspace);
    const { terminalId } = await terminals.create({ command: process.execPath, args: ["-e", "console.log(process.cwd()); process.exit(3)"] });
    const args = ["-e", "console.log(process.cwd()); process.exit(3)"];
    expect(authorize).toHaveBeenCalledWith(terminalCommandLine(process.execPath, args), { command: process.execPath, args });
    await expect(terminals.waitForExit({ terminalId })).resolves.toEqual({ exitCode: 3, signal: null });
    const output = terminals.output({ terminalId });
    expect(output).toMatchObject({ truncated: false, exitStatus: { exitCode: 3, signal: null } });
    expect(output.output.trim().toLowerCase()).toBe(workspace.toLowerCase());
    await terminals.release({ terminalId });
    expect(() => terminals.output({ terminalId })).toThrow("Unknown terminal");
  });

  it("keeps only the newest output within the agent's byte limit", async () => {
    const { workspace } = workspaceRoot();
    const { terminals } = terminalsFor(workspace);
    const { terminalId } = await terminals.create({
      command: process.execPath, args: ["-e", "process.stdout.write('a'.repeat(5000) + 'é'.repeat(10) + 'END')"], outputByteLimit: 64,
    });
    await terminals.waitForExit({ terminalId });
    const { output, truncated } = terminals.output({ terminalId });
    expect(truncated).toBe(true);
    expect(output.endsWith("END")).toBe(true);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64);
    expect(output).not.toContain("\uFFFD");
  });

  it("starts nothing the shell policy refuses, and nothing outside the workspace", async () => {
    const { root, workspace } = workspaceRoot();
    const { terminals } = terminalsFor(workspace, vi.fn(async () => { throw new Error("Command was denied by the user"); }));
    await expect(terminals.create({ command: "echo", args: ["hi"] })).rejects.toThrow("denied");
    const allowing = terminalsFor(workspace).terminals;
    await expect(allowing.create({ command: "echo", args: ["hi"], cwd: root })).rejects.toThrow("inside the run workspace");
  });

  it("starts no terminal whose approval ends after the turn's cleanup began", async () => {
    const { workspace } = workspaceRoot();
    let approve!: () => void;
    const { terminals } = terminalsFor(workspace, vi.fn<Authorize>(() => new Promise<void>((resolve) => { approve = resolve; })));
    const creating = terminals.create({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
    await vi.waitFor(() => expect(approve).toBeTypeOf("function"));
    await terminals.closeAll();
    approve();
    await expect(creating).rejects.toThrow("The turn ended before this terminal started.");
  });

  it("kills a command that is still running", async () => {
    const { workspace } = workspaceRoot();
    const { terminals } = terminalsFor(workspace);
    const { terminalId } = await terminals.create({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
    await terminals.kill({ terminalId });
    const status = await terminals.waitForExit({ terminalId });
    expect(status.exitCode === 0).toBe(false);
  });

  it("quotes arguments for the platform's shell", () => {
    expect(terminalCommandLine("git", ["log", "-1", "--format=%H"], "linux")).toBe("git log -1 --format=%H");
    expect(terminalCommandLine("node", ["-e", "console.log('a b')"], "linux")).toBe("node -e 'console.log('\\''a b'\\'')'");
    expect(terminalCommandLine("C:\\Program Files\\node.exe", ["-e", "x y"], "win32")).toBe('"C:\\Program Files\\node.exe" -e "x y"');
    expect(terminalCommandLine("npm test -- --watch=false", [], "win32")).toBe("npm test -- --watch=false");
  });
});

/** An agent that asks to run a command, runs it in a BuildWarden terminal, and reports its output. */
const TERMINAL_AGENT = String.raw`
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const waiting = new Map();
let nextId = 1;
const request = (method, params) => new Promise((resolve) => {
  const id = "agent-" + nextId++;
  waiting.set(id, resolve);
  send({ id, method, params });
});
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
let terminalCapability = null;
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) {
    waiting.get(message.id)?.(message.result ?? { error: message.error });
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    terminalCapability = params.clientCapabilities.terminal;
    send({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId: "s1", modes: { availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }], currentModeId: "default" } } });
  } else if (method === "session/prompt") {
    const sessionId = params.sessionId;
    const decode = (name) => Buffer.from(process.env[name], "base64").toString("utf8");
    const command = decode("FAKE_COMMAND");
    const args = JSON.parse(decode("FAKE_ARGS"));
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "c1", title: "Run", kind: "execute", status: "pending", rawInput: { command: decode("FAKE_SHOWN") } });
    const permission = await request("session/request_permission", { sessionId, toolCall: { toolCallId: "c1" },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
    if (permission.outcome?.optionId !== "yes") {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "rejected" } });
      send({ id, result: { stopReason: "end_turn" } });
      return;
    }
    const created = await request("terminal/create", { sessionId, command, args });
    if (created.error) {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "create failed: " + created.error.message } });
      send({ id, result: { stopReason: "end_turn" } });
      return;
    }
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", content: [{ type: "terminal", terminalId: created.terminalId }] });
    if (process.env.FAKE_BORROW) {
      // Another command, run by the agent itself, that shows the approved terminal as its own.
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "c2", title: "Run", kind: "execute", status: "in_progress",
        rawInput: { command: "rm -rf build" }, content: [{ type: "terminal", terminalId: created.terminalId }] });
    }
    const exit = await request("terminal/wait_for_exit", { sessionId, terminalId: created.terminalId });
    const output = await request("terminal/output", { sessionId, terminalId: created.terminalId });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
    await request("terminal/release", { sessionId, terminalId: created.terminalId });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "terminal=" + terminalCapability + " exit=" + exit.exitCode + " out=" + output.output.trim() } });
    send({ id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined) {
    send({ id, result: null });
  }
});
`;

describe("ACP agent running commands in BuildWarden terminals", () => {
  const setup = (mode: RunExecutionRequest["mode"], command: { command: string; args: string[]; shown?: string } = {
    command: process.execPath, args: ["-e", "console.log('hello')"],
  }) => {
    const { root, workspace } = workspaceRoot();
    const script = join(root, "agent.mjs");
    writeFileSync(script, TERMINAL_AGENT);
    // By default the agent shows the command as BuildWarden quotes it for the shell.
    const shown = command.shown ?? terminalCommandLine(command.command, command.args);
    // Base64 keeps quotes intact through the agent's environment settings.
    const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
    const input: RunExecutionRequest = {
      runId: "run-1", providerAccountId: "acp-1", worktreePath: workspace, mode, prompt: "Run it",
      providerType: "acp", modelId: "default", apiKey: "",
      config: {
        acpCommand: `"${process.execPath}" "${script}"`,
        acpEnv: [`FAKE_COMMAND=${encode(command.command)}`, `FAKE_ARGS=${encode(JSON.stringify(command.args))}`, `FAKE_SHOWN=${encode(shown)}`].join("\n"),
      },
    };
    return { input, shown };
  };

  it("checks a command again when the approval matches it only after collapsing spaces or joining words", async () => {
    const authorizeShellCommand = vi.fn(async () => undefined);
    const adapter = new AcpHarnessAdapter(vi.fn(async () => "allow-once" as const), { authorizeShellCommand });
    // Shell source whose quoted spacing differs from the approved text.
    const spaced = setup("code", { command: 'echo "a  b"', args: [], shown: 'echo "a b"' });
    await adapter.run(spaced.input, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);
    expect(authorizeShellCommand).toHaveBeenCalledTimes(1);
    // One argument with a space, approved as text that reads as two words.
    const joined = setup("code", { command: "node", args: ["-e", "console.log('a b')"], shown: "node -e console.log('a b')" });
    await adapter.run(joined.input, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);
    expect(authorizeShellCommand).toHaveBeenCalledTimes(2);
    // Plain words join unambiguously, so their approval still covers the terminal.
    const plain = setup("code", { command: "node", args: ["--version"], shown: "node --version" });
    await adapter.run(plain.input, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);
    expect(authorizeShellCommand).toHaveBeenCalledTimes(2);
  });

  it("asks once in a code turn and shows the command's output in its step", async () => {
    const { input, shown } = setup("code");
    const approve = vi.fn(async () => "allow-once" as const);
    const authorizeShellCommand = vi.fn(async () => undefined);
    const chunks: HarnessRunChunk[] = [];
    const result = await new AcpHarnessAdapter(approve, { authorizeShellCommand })
      .run(input, { tools: [], executeTool: vi.fn() }, (chunk) => chunks.push(chunk), new AbortController().signal);
    expect(result.summary).toBe("terminal=true exit=0 out=hello");
    expect(approve).toHaveBeenCalledOnce();
    // The terminal runs the command the user just approved, so the shell policy is not asked again.
    expect(authorizeShellCommand).not.toHaveBeenCalled();
    const step = chunks.filter((chunk) => chunk.metadata?.callId === "c1").at(-1);
    expect(step).toMatchObject({ type: "tool-result", metadata: { ok: true } });
    expect(step?.value).toContain(`$ ${terminalCommandLine(process.execPath, ["-e", "console.log('hello')"])}`);
    expect(step?.value).toContain("hello");
    expect(shown).toContain("console.log");
  });

  it("checks shell source again when it differs from the approved command", async () => {
    const { input } = setup("code", { command: process.execPath, args: ["-e", "console.log('hello')"], shown: "echo 'a; b'" });
    const authorizeShellCommand = vi.fn(async () => undefined);
    await new AcpHarnessAdapter(vi.fn(async () => "allow-once" as const), { authorizeShellCommand })
      .run(input, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);
    expect(authorizeShellCommand).toHaveBeenCalledOnce();
  });

  it("applies the shell policy to a command in an inspect turn instead of stopping it", async () => {
    const { input } = setup("plan");
    const authorizeShellCommand = vi.fn(async () => undefined);
    const result = await new AcpHarnessAdapter(vi.fn(async () => "deny" as const), { authorizeShellCommand })
      .run(input, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);
    expect(result.summary).toBe("terminal=true exit=0 out=hello");
    // Once for the permission; the terminal then runs that approved command without asking again.
    expect(authorizeShellCommand).toHaveBeenCalledOnce();
    expect(authorizeShellCommand).toHaveBeenCalledWith(expect.stringContaining("console.log('hello')"), { yoloMode: false });
  });

  it("does not let another call borrow an approved terminal in an inspect turn", async () => {
    const { input } = setup("plan");
    const authorizeShellCommand = vi.fn(async () => undefined);
    const config = { ...input.config, acpEnv: `${String(input.config?.acpEnv)}\nFAKE_BORROW=1` };
    await expect(new AcpHarnessAdapter(vi.fn(async () => "deny" as const), { authorizeShellCommand })
      .run({ ...input, config }, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal))
      .rejects.toThrow('ran "Run: rm -rf build" without BuildWarden\'s permission');
  });

  it("rejects the command in an inspect turn when the shell policy refuses it", async () => {
    const { input } = setup("ask");
    const authorizeShellCommand = vi.fn(async () => { throw new Error("Command is not allowed"); });
    const result = await new AcpHarnessAdapter(vi.fn(async () => "deny" as const), { authorizeShellCommand })
      .run({ ...input, yoloMode: true }, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);
    expect(result.summary).toBe("rejected");
    // Full Access does not reach past an inspect-only turn.
    expect(authorizeShellCommand).toHaveBeenCalledWith(expect.any(String), { yoloMode: false });
  });
});
