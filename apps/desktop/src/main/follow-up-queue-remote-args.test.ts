import { describe, expect, it, vi } from "vitest";
import { defineRemoteArgsValidator, RemoteOperationRegistry } from "@buildwarden/remote-server";
import { REMOTE_ACCESS_PROTOCOL_VERSION } from "@buildwarden/shared";
import { isQueueFollowUpRemoteArgs, isUpdateFollowUpQueueRemoteArgs, omittedRemoteArg } from "./follow-up-queue-remote-args";

describe("follow-up queue remote arguments", () => {
  it("accepts the null a remote client sends for omitted options before a delivery", () => {
    expect(isQueueFollowUpRemoteArgs(["chat-1", "text", null, "queue"])).toBe(true);
    expect(isQueueFollowUpRemoteArgs(["chat-1", "text", null, "steer"])).toBe(true);
    expect(isQueueFollowUpRemoteArgs(["chat-1", "text", { attachments: [] }, null])).toBe(true);
    expect(isQueueFollowUpRemoteArgs(["chat-1", "text"])).toBe(true);
  });

  it("rejects malformed queue requests", () => {
    expect(isQueueFollowUpRemoteArgs(["chat-1", "text", "options", "queue"])).toBe(false);
    expect(isQueueFollowUpRemoteArgs(["chat-1", "text", null, "interrupt"])).toBe(false);
    expect(isQueueFollowUpRemoteArgs(["chat-1", 42])).toBe(false);
    expect(isUpdateFollowUpQueueRemoteArgs(["run-1", { type: "move", queuedFollowUpId: "q", direction: "sideways" }])).toBe(false);
    expect(isUpdateFollowUpQueueRemoteArgs(["run-1", { type: "resume" }])).toBe(true);
  });

  it("dispatches [id, text, null, queue] to the controller with options omitted", async () => {
    const registry = new RemoteOperationRegistry();
    const queueChatFollowUp = vi.fn<(chatId: string, prompt: string, options?: unknown, delivery?: unknown) => Promise<{ queue: []; outcome: "queued" }>>(
      async () => ({ queue: [], outcome: "queued" }));
    registry.register(
      "queueChatFollowUp",
      (chatId, prompt, options, delivery) => queueChatFollowUp(chatId, prompt, omittedRemoteArg(options), omittedRemoteArg(delivery)),
      defineRemoteArgsValidator<"queueChatFollowUp">(isQueueFollowUpRemoteArgs),
      "chat:operate",
    );

    const response = await registry.dispatch({
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId: "queue-1",
      method: "queueChatFollowUp",
      args: ["chat-1", "text", null, "queue"],
    }, ["chat:operate"], "session");

    expect(response).toMatchObject({ ok: true });
    expect(queueChatFollowUp).toHaveBeenCalledWith("chat-1", "text", undefined, "queue");
  });
});
