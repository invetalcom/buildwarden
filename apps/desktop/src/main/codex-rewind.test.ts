import { describe, expect, it, vi } from "vitest";
import { rewindCodexConversation } from "@buildwarden/provider-codex-cli";

describe("Codex native rewind compatibility", () => {
  it("counts native turns for older servers instead of counting user messages", async () => {
    const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>().mockImplementation(async (method) => {
      if (method === "thread/resume") return { thread: { id: "thread" } };
      if (method === "thread/revert") throw new Error("Unknown method thread/revert");
      if (method === "thread/read") return { thread: { turns: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] } };
      return {};
    });
    await rewindCodexConversation({ request: async <T>(method: string, params: unknown) => await request(method, params) as T }, "thread", "b");
    expect(request).toHaveBeenCalledWith("thread/rollback", { threadId: "thread", numTurns: 3 });
  });

  it("never retries an ambiguous failure with a second destructive protocol", async () => {
    const request = vi.fn(async <T>(method: string): Promise<T> => {
      if (method === "thread/resume") return { thread: { id: "thread" } } as T;
      throw new Error("Timed out waiting for thread/revert");
    });
    await expect(rewindCodexConversation({ request: async <T>(method: string) => await request(method) as T }, "thread", "b")).rejects.toThrow("Timed out");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume", "thread/revert"]);
  });
});
