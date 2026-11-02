import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RunUserInputAnswers, RunUserInputRequest } from "@buildwarden/shared";
import { CodexAppServerSession } from "@buildwarden/provider-codex-cli";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MINUTE = 60_000;
const sessions: CodexAppServerSession[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const session of sessions.splice(0)) session.stop(); vi.useRealTimers(); });

async function createSession(options: {
  hang?: string;
  failStart?: boolean;
  requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>;
} = {}) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const methods: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout, stdin, stderr: new PassThrough(), killed: true, kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
  stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk)) as { id?: number; method?: string };
    if (!request.method || request.id === undefined) return;
    methods.push(request.method);
    if (request.method === options.hang) return;
    const response = options.failStart && request.method === "turn/start"
      ? { error: { message: "Cannot start turn" } }
      : { result: { thread: { id: "thread" }, turn: { id: "turn" } } };
    stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
  });
  const session = new CodexAppServerSession(child, "thread", "C:\\repo", undefined, options.requestUserInput, vi.fn());
  sessions.push(session);
  await session.initialize("gpt-5", "C:\\repo");
  const controller = new AbortController();
  const start = () => session.startTurn({ prompt: "Work", modelId: "gpt-5", mode: "code", signal: controller.signal });
  const notify = (method: string, params: unknown = {}) => stdout.write(`${JSON.stringify({ method, params })}\n`);
  const complete = () => notify("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
  return { session, child, stdout, methods, controller, start, notify, complete };
}

describe("Codex turn lifecycle", () => {
  it("keeps active turns running past twenty minutes and clears monitoring on completion", async () => {
    const { start, notify, complete, methods } = await createSession();
    const turn = start();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(19 * MINUTE);
      notify("item/agentMessage/delta", { threadId: "thread", itemId: "message", delta: "Working" });
    }
    expect(methods).not.toContain("thread/read");
    complete();
    await expect(turn).resolves.toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows long silent work when the app-server responds to a bounded health check", async () => {
    const { start, complete, methods } = await createSession();
    const turn = start();
    await vi.advanceTimersByTimeAsync(61 * MINUTE);
    expect(methods.filter((method) => method === "thread/read")).toHaveLength(3);
    complete();
    await expect(turn).resolves.toBeDefined();
  });

  it("pauses idle checks while waiting for the user and resumes after their answer", async () => {
    let answer!: (value: RunUserInputAnswers) => void;
    const requestUserInput = vi.fn(() => new Promise<RunUserInputAnswers>((resolve) => { answer = resolve; }));
    const { start, stdout, methods, complete } = await createSession({ requestUserInput });
    const turn = start();
    stdout.write(`${JSON.stringify({ id: "approval", method: "item/fileChange/requestApproval", params: {} })}\n`);
    await vi.advanceTimersByTimeAsync(90 * MINUTE);
    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(methods).not.toContain("thread/read");
    answer({ approval: "Allow once" });
    await vi.advanceTimersByTimeAsync(21 * MINUTE);
    expect(methods).toContain("thread/read");
    complete();
    await turn;
  });

  it("fails a silent unresponsive app-server after the health request deadline", async () => {
    const { start } = await createSession({ hang: "thread/read" });
    const result = expect(start()).rejects.toThrow(/stopped responding.*thread\/read/);
    await vi.advanceTimersByTimeAsync(20 * MINUTE + 20_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["exit", "output", "error"])("rejects promptly on transport failure: %s", async (kind) => {
    const { start, child, stdout } = await createSession({ hang: "turn/start" });
    const result = expect(start()).rejects.toThrow(/exited early|output disconnected|broken pipe/);
    if (kind === "exit") child.emit("exit", 1, null);
    else if (kind === "error") child.emit("error", new Error("broken pipe"));
    else stdout.end();
    await vi.advanceTimersByTimeAsync(0);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up turn monitoring when turn/start fails", async () => {
    const { start } = await createSession({ failStart: true });
    await expect(start()).rejects.toThrow("Cannot start turn");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a turn with an already cancelled signal", async () => {
    const { start, controller, methods } = await createSession();
    controller.abort();
    await expect(start()).rejects.toThrow("Run cancelled");
    expect(methods).not.toContain("turn/start");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a turn while it is waiting for a user answer", async () => {
    const { start, controller, stdout, methods } = await createSession({ requestUserInput: () => new Promise(() => {}) });
    const result = expect(start()).rejects.toThrow("Run cancelled");
    await vi.advanceTimersByTimeAsync(0);
    stdout.write(`${JSON.stringify({ id: 9, method: "item/fileChange/requestApproval", params: {} })}\n`);
    controller.abort();
    await result;
    expect(methods).toContain("turn/interrupt");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled graceful interruption before closing the session", async () => {
    const { start, controller, session } = await createSession({ hang: "turn/interrupt" });
    const stop = vi.spyOn(session, "stop");
    const result = expect(start()).rejects.toThrow("Run cancelled");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(stop).toHaveBeenCalledOnce();
  });
});
