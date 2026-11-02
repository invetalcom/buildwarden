import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RunUserInputAnswers, RunUserInputRequest, ShellApprovalDecision } from "@buildwarden/shared";
import { CodexAppServerSession } from "@buildwarden/provider-codex-cli";
import { afterEach, describe, expect, it, vi } from "vitest";

const sessions: CodexAppServerSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.stop(); });

function createSession(
  requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>,
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>,
) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const responses: unknown[] = [];
  stdin.on("data", (chunk) => { responses.push(JSON.parse(String(chunk))); });
  const child = Object.assign(new EventEmitter(), {
    stdout, stdin, stderr: new PassThrough(), killed: true, kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  const session = new CodexAppServerSession(child, "thread", "C:\\repo", requestShellApproval, requestUserInput, vi.fn());
  sessions.push(session);
  const send = (method: string, params: unknown = {}, id: string | number = 7) => {
    stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  };
  return { session, responses, send };
}

describe("Codex approval requests", () => {
  it.each(["item/fileRead/requestApproval", "item/fileChange/requestApproval"])("waits for explicit approval of %s", async (method) => {
    let resolveAnswer!: (answers: RunUserInputAnswers) => void;
    const requestUserInput = vi.fn(() => new Promise<RunUserInputAnswers>((resolve) => { resolveAnswer = resolve; }));
    const { send, responses } = createSession(requestUserInput);
    const params = { threadId: "thread", itemId: "item", reason: "Update config", grantRoot: "C:\\outside" };
    send(method, params, "file-approval");
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalledOnce());
    expect(responses).toEqual([]);
    expect(requestUserInput).toHaveBeenCalledWith(expect.objectContaining({
      questions: [expect.objectContaining({
        question: expect.stringContaining("C:\\\\outside"),
        allowCustomAnswer: false,
        options: [{ label: "Deny" }, { label: "Allow once" }],
      })],
      metadata: expect.objectContaining({ rawRequestMethod: method, rawRequestParams: params }),
    }));
    resolveAnswer({ approval: "Allow once" });
    await vi.waitFor(() => expect(responses).toEqual([{ id: "file-approval", result: { decision: "accept" } }]));
  });

  it.each(["Deny", "yes", "Allow for this turn", [], ["Allow once", "Deny"]])("denies non-approval answers: %j", async (answer) => {
    const { send, responses } = createSession(async () => ({ approval: answer }));
    send("item/fileChange/requestApproval");
    await vi.waitFor(() => expect(responses).toEqual([{ id: 7, result: { decision: "decline" } }]));
  });

  it.each(["item/fileRead/requestApproval", "item/fileChange/requestApproval", "item/commandExecution/requestApproval"])("fails closed without a UI for %s", async (method) => {
    const { send, responses } = createSession();
    send(method);
    await vi.waitFor(() => expect(responses).toEqual([{ id: 7, result: { decision: "decline" } }]));
  });

  it("denies failed or cancelled approval prompts", async () => {
    const { send, responses } = createSession(async () => { throw new Error("Cancelled"); });
    send("item/fileChange/requestApproval");
    await vi.waitFor(() => expect(responses).toEqual([{ id: 7, result: { decision: "decline" } }]));
  });

  it("grants only the requested permissions for the current turn", async () => {
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ["C:\\read"], write: ["C:\\write"], entries: [{ path: { type: "glob", pattern: "C:/logs/*.log" }, access: "read" }] },
    };
    const requestUserInput = vi.fn(async () => ({ approval: ["Allow for this turn"] }));
    const { send, responses } = createSession(requestUserInput);
    send("item/permissions/requestApproval", { permissions, cwd: "C:\\repo", reason: "Read logs and fetch dependencies" });
    await vi.waitFor(() => expect(responses).toEqual([{ id: 7, result: { permissions, scope: "turn" } }]));
    expect(requestUserInput.mock.calls[0]).toBeDefined();
  });

  it.each(["Deny", "Allow once", "acceptForSession"])("returns an empty grant when permissions are not explicitly approved (%s)", async (approval) => {
    const { send, responses } = createSession(async () => ({ approval }));
    send("item/permissions/requestApproval", { permissions: { network: { enabled: true } } });
    await vi.waitFor(() => expect(responses).toEqual([{ id: 7, result: { permissions: {}, scope: "turn" } }]));
  });

  it.each([undefined, null, [], "all"])("denies missing or malformed permissions (%j)", async (permissions) => {
    const requestUserInput = vi.fn(async () => ({ approval: "Allow for this turn" }));
    const { send, responses } = createSession(requestUserInput);
    send("item/permissions/requestApproval", { permissions });
    await vi.waitFor(() => expect(responses).toEqual([{ id: 7, result: { permissions: {}, scope: "turn" } }]));
    expect(requestUserInput).not.toHaveBeenCalled();
  });

  it("denies permissions when no prompt handler exists", async () => {
    const { send, responses } = createSession();
    send("item/permissions/requestApproval", { permissions: { network: { enabled: true } } });
    await vi.waitFor(() => expect(responses).toEqual([{ id: 7, result: { permissions: {}, scope: "turn" } }]));
  });

  it("uses chat's question bridge when no shell approval handler exists", async () => {
    const requestUserInput = vi.fn(async () => ({ approval: "Allow once" }));
    const { send, responses } = createSession(requestUserInput);
    send("item/commandExecution/requestApproval", { command: "echo test", cwd: "C:\\repo" });
    await vi.waitFor(() => expect(responses).toEqual([{ id: 7, result: { decision: "accept" } }]));
    expect(requestUserInput).toHaveBeenCalledOnce();
  });

  it.each([
    { networkApprovalContext: { host: "example.com", protocol: "https", port: 443 } },
    { additionalPermissions: { fileSystem: { write: ["C:\\outside"] } } },
    { kind: "stdin" },
  ])("does not reuse shell allowlist decisions for additional scope: %j", async (scope) => {
    const requestShellApproval = vi.fn(async () => "allow-for-run" as const);
    const requestUserInput = vi.fn(async () => ({ approval: "Deny" }));
    const { send, responses } = createSession(requestUserInput, requestShellApproval);
    send("item/commandExecution/requestApproval", { command: "echo test", ...scope });
    await vi.waitFor(() => expect(responses).toEqual([{ id: 7, result: { decision: "decline" } }]));
    expect(requestShellApproval).not.toHaveBeenCalled();
    expect(requestUserInput).toHaveBeenCalledOnce();
  });

  it.each([
    { approval: "deny" as const, availableDecisions: undefined, expected: "decline" },
    { approval: "allow-once" as const, availableDecisions: ["cancel"], expected: "cancel" },
    { approval: "allow-once" as const, availableDecisions: ["accept", "decline"], expected: "accept" },
  ])("respects supported command decisions: $expected", async ({ approval, availableDecisions, expected }) => {
    const requestShellApproval = vi.fn(async () => approval);
    const { send, responses } = createSession(undefined, requestShellApproval);
    send("item/commandExecution/requestApproval", { command: "echo test", availableDecisions });
    await vi.waitFor(() => expect(responses).toEqual([{ id: 7, result: { decision: expected } }]));
    expect(requestShellApproval).toHaveBeenCalledWith("echo test");
  });

  it("discards approval replies after the session stops", async () => {
    let resolveAnswer!: (answers: RunUserInputAnswers) => void;
    const requestUserInput = vi.fn(() => new Promise<RunUserInputAnswers>((resolve) => { resolveAnswer = resolve; }));
    const { send, responses, session } = createSession(requestUserInput);
    send("item/fileChange/requestApproval");
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalledOnce());
    session.stop();
    resolveAnswer({ approval: "Allow once" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(responses).toEqual([]);
  });
});
