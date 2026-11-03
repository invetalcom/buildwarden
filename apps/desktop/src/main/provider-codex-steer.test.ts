import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAppServerSession } from "@buildwarden/provider-codex-cli";
import { afterEach, describe, expect, it, vi } from "vitest";

const sessions: CodexAppServerSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) void session.stop(); });

async function createSession(options: { rejectSteer?: string } = {}) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const child = Object.assign(new EventEmitter(), {
    stdout, stdin, stderr: new PassThrough(), killed: true, kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
  stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const request = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (!request.method || request.id === undefined) continue;
      requests.push({ method: request.method, params: request.params ?? {} });
      const response = request.method === "turn/steer"
        ? options.rejectSteer ? { error: { message: options.rejectSteer } } : { result: { turnId: "turn-1" } }
        : { result: { thread: { id: "thread-1" }, turn: { id: "turn-1" } } };
      stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
    }
  });
  const session = new CodexAppServerSession(child, "thread-1", "C:\\repo", undefined, undefined, vi.fn());
  sessions.push(session);
  await session.initialize("gpt-5", "C:\\repo");
  const controller = new AbortController();
  const start = () => session.startTurn({ prompt: "Work", modelId: "gpt-5", mode: "code", signal: controller.signal });
  const complete = () => stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })}\n`);
  const waitForTurnStart = () => vi.waitFor(() => expect(requests.some((request) => request.method === "turn/start")).toBe(true));
  return { session, requests, start, complete, waitForTurnStart };
}

describe("Codex turn steering", () => {
  it("sends turn/steer for the active turn with text and image input", async () => {
    const { session, requests, start, complete, waitForTurnStart } = await createSession();
    const turn = start();
    await waitForTurnStart();
    await vi.waitFor(async () => {
      await session.steerTurn("Also handle the empty state", [
        { fileName: "shot.png", mimeType: "image/png", dataBase64: "aGVsbG8=" },
      ]);
    });

    const steer = requests.find((request) => request.method === "turn/steer");
    expect(steer?.params).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });
    const input = steer?.params.input as Array<{ type: string; text?: string; url?: string }>;
    expect(input[0]).toMatchObject({ type: "text" });
    expect(input[0]?.text).toContain("Also handle the empty state");
    expect(input).toContainEqual({ type: "image", url: "data:image/png;base64,aGVsbG8=" });

    complete();
    await expect(turn).resolves.toBeDefined();
    await expect(session.steerTurn("Too late", undefined)).rejects.toThrow(/not running/);
  });

  it("refuses to steer before a turn starts and surfaces Codex rejections", async () => {
    const { session, start, complete, waitForTurnStart } = await createSession({ rejectSteer: "expected turn mismatch" });
    await expect(session.steerTurn("Early", undefined)).rejects.toThrow(/not running/);
    const turn = start();
    await waitForTurnStart();
    await vi.waitFor(() => expect(session.steerTurn("Rejected", undefined)).rejects.toThrow("expected turn mismatch"));
    complete();
    await turn;
  });
});
