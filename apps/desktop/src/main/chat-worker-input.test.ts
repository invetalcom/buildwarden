import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessToolContext } from "@buildwarden/shared";

const mocks = vi.hoisted(() => ({
  on: vi.fn<(event: string, callback: (message: Record<string, unknown>) => void) => void>(),
  postMessage: vi.fn(), run: vi.fn(),
}));
vi.mock("node:worker_threads", () => ({
  parentPort: { on: mocks.on, postMessage: mocks.postMessage },
  workerData: { request: { runId: "chat-1", providerType: "codex-cli", worktreePath: "." } },
}));
vi.mock("./harness-adapters", () => ({ createHarnessAdapter: () => ({ run: mocks.run }) }));
vi.mock("./logger", () => ({ logInfo: vi.fn(), logError: vi.fn() }));
afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });

const start = async () => {
  mocks.run.mockImplementation(async (_request: unknown, context: HarnessToolContext) => {
    const result = await context.executeTool({ id: "tool-1", name: "buildwarden_ask_user", arguments: { questions: [
      { id: "goal", header: "Goal", question: "Which project?", options: [{ label: "AI" }, { label: "Web" }] },
    ] } });
    return { summary: result.content, responseId: null, usage: { inputTokens: 0, outputTokens: 0 } };
  });
  await import("./chat-worker");
  await vi.waitFor(() => expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "user-input-request" })));
  const request = mocks.postMessage.mock.calls.find(([payload]) => payload.type === "user-input-request")?.[0] as { requestId: string };
  const listener = mocks.on.mock.calls.find(([event]) => event === "message")?.[1];
  if (!listener) throw Error("Missing worker message listener");
  return { request, listener };
};

describe("chat worker questions", () => {
  it("waits for the matching answer and resumes the tool with the selected value", async () => {
    const { request, listener } = await start();
    listener({ type: "user-input-response", requestId: "stale", answers: { goal: "Web" } });
    expect(mocks.postMessage.mock.calls.some(([message]) => message.type === "done")).toBe(false);
    listener({ type: "user-input-response", requestId: request.requestId, answers: { goal: "AI" } });
    await vi.waitFor(() => expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "done", result: expect.objectContaining({ summary: JSON.stringify({ answers: { goal: "AI" } }) }),
    })));
  });
  it("rejects a waiting question when the chat is cancelled", async () => {
    const { listener } = await start();
    listener({ type: "cancel" });
    await vi.waitFor(() => expect(mocks.postMessage).toHaveBeenCalledWith({ type: "error", error: "Chat cancelled." }));
    expect(mocks.postMessage.mock.calls.some(([message]) => message.type === "done")).toBe(false);
  });
});
