import { describe, expect, it } from "vitest";
import type { RunExecutionRequest } from "@buildwarden/shared";
import { prepareChatWorkspaceSession } from "./chat-session-migration";

const request = (providerType: RunExecutionRequest["providerType"]): RunExecutionRequest => ({
  runId: "chat-1", mode: "ask", modelId: "test", apiKey: "test",
  providerType, worktreePath: "/app/chat-workspaces/chat-1", prompt: "Continue with the selected idea",
  previousResponseId: "old-session", providerSessionRuntime: {
    ownerId: "chat-1", ownerKind: "chat", providerAccountId: "account-1", providerType, harnessType: "claude-code", status: "ready", modelId: "test", runtimeMode: "ask",
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
    expect(migrated.prompt).toContain("moved to a new workspace");
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
    const brandNew = { ...legacy, previousResponseId: null, priorChatMessages: [] };
    expect(prepareChatWorkspaceSession(brandNew)).toBe(brandNew);
  });
  it.each(["claude-code", "cursor-agent", "codex-cli"] as const)(
    "hands the prior conversation to a fresh %s session after a provider switch",
    (provider) => {
      const switched = { ...request(provider), providerSessionRuntime: null, previousResponseId: null };
      const prepared = prepareChatWorkspaceSession(switched);
      expect(prepared.prompt).toContain("continues in a new provider session");
      expect(prepared.prompt).toContain("user: Give me ideas");
      expect(prepared.prompt.endsWith("Continue with the selected idea")).toBe(true);
    },
  );
  it("leaves transcript-replaying providers without a session untouched", () => {
    const switched = { ...request("ai-sdk"), providerSessionRuntime: null, previousResponseId: null };
    expect(prepareChatWorkspaceSession(switched)).toBe(switched);
  });
  it("keeps the opening message and the newest messages when history exceeds the budget", () => {
    const long = "x".repeat(20_000);
    const switched = {
      ...request("claude-code"),
      providerSessionRuntime: null,
      previousResponseId: null,
      priorChatMessages: [
        { role: "user" as const, content: "opening request" },
        { role: "assistant" as const, content: long },
        { role: "user" as const, content: long },
        { role: "assistant" as const, content: long },
        { role: "user" as const, content: "latest question" },
      ],
    };
    const prompt = prepareChatWorkspaceSession(switched).prompt;
    expect(prompt).toContain("user: opening request");
    expect(prompt).toContain("user: latest question");
    expect(prompt).toContain("[... earlier messages omitted ...]");
    expect(prompt.length).toBeLessThan(60_000);
  });
});
