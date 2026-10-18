import { describe, expect, it } from "vitest";
import type { RunExecutionRequest } from "@buildwarden/shared";
import { prepareChatWorkspaceSession } from "./chat-session-migration";

const request = (providerType: RunExecutionRequest["providerType"]): RunExecutionRequest => ({
  runId: "chat-1", mode: "ask", modelId: "test", apiKey: "test",
  providerType, worktreePath: "/app/chat-workspaces/chat-1", prompt: "Continue with the selected idea",
  previousResponseId: "old-session", providerSessionRuntime: {
    ownerId: "chat-1", ownerKind: "chat", providerType, harnessType: "claude-code", status: "ready", modelId: "test", runtimeMode: "ask",
    cwd: "/old/home", resumeCursor: { sessionId: "old-session" }, runtimePayload: null, lastSeenAt: "", createdAt: "", updatedAt: "",
  },
  priorChatMessages: [{ role: "user", content: "Give me ideas" }, { role: "assistant", content: "The selected idea ![Preview](data:image/png;base64,AAAA)" }],
  attachments: [],
});

describe("chat workspace session migration", () => {
  it.each(["claude-code", "cursor-agent"] as const)("replays history without resuming a %s session in a different cwd", (provider) => {
    const input = request(provider);
    const migrated = prepareChatWorkspaceSession(input);
    expect(migrated.previousResponseId).toBeNull();
    expect(migrated.providerSessionRuntime).toBeNull();
    expect(migrated.prompt).toContain("user: Give me ideas");
    expect(migrated.prompt).toContain("assistant: The selected idea");
    expect(migrated.prompt).not.toContain("base64");
    expect(migrated.prompt.match(/Continue with the selected idea/g)).toHaveLength(1);
    expect(migrated.attachments).toBe(input.attachments);
    expect(input.previousResponseId).toBe("old-session");
  });
  it("preserves same-workspace sessions and providers with their own resume handling", () => {
    const input = request("claude-code");
    input.worktreePath = input.providerSessionRuntime!.cwd;
    expect(prepareChatWorkspaceSession(input)).toBe(input);
    for (const provider of ["codex-cli", "ai-sdk", "openrouter"] as const) {
      const other = request(provider);
      expect(prepareChatWorkspaceSession(other)).toBe(other);
    }
  });
  it("handles legacy response IDs without runtime metadata and leaves new chats alone", () => {
    const legacy = { ...request("claude-code"), providerSessionRuntime: null };
    expect(prepareChatWorkspaceSession(legacy).previousResponseId).toBeNull();
    const fresh = { ...legacy, previousResponseId: null };
    expect(prepareChatWorkspaceSession(fresh)).toBe(fresh);
  });
});
