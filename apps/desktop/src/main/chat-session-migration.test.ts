import { describe, expect, it } from "vitest";
import { buildPriorChatCompletionMessagesFromSteps, type RunExecutionRequest } from "@buildwarden/shared";
import { prepareChatWorkspaceSession } from "./chat-session-migration";
import { buildRunChatFirstTurnPrompt, buildRunChatUpdateTurnPrompt } from "./run-chat-context";

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
  it("shortens oversized messages instead of dropping them, keeping the opening and latest exchange", () => {
    // A run chat's opening message carries the whole run context and can exceed the budget alone.
    const runContext = `RUN CONTEXT START ${"d".repeat(100_000)}`;
    const filler = Array.from({ length: 12 }, (_, index) => ({
      role: (index % 2 === 0 ? "assistant" : "user") as "assistant" | "user",
      content: `filler ${index} ${"y".repeat(10_000)}`,
    }));
    const switched = {
      ...request("claude-code"),
      providerSessionRuntime: null,
      previousResponseId: null,
      priorChatMessages: [
        { role: "user" as const, content: runContext },
        ...filler,
        { role: "user" as const, content: `latest question ${"q".repeat(30_000)}` },
        { role: "assistant" as const, content: `latest answer ${"a".repeat(30_000)}` },
      ],
    };
    const prompt = prepareChatWorkspaceSession(switched).prompt;
    expect(prompt).toContain("user: RUN CONTEXT START");
    expect(prompt).toContain("user: latest question");
    expect(prompt).toContain("assistant: latest answer");
    expect(prompt).toContain("[... truncated]");
    expect(prompt).toMatch(/\[\.\.\. \d+ items? omitted \.\.\.\]/);
    expect(prompt.length).toBeLessThan(55_000);
  });

  it("derives hidden context provenance from persisted steps", () => {
    const messages = buildPriorChatCompletionMessagesFromSteps([
      { id: "1", chatId: "c", eventType: "log", title: "", content: "context", metadataJson: '{"source":"run-context"}', createdAt: "1" },
      { id: "2", chatId: "c", eventType: "log", title: "", content: "current", metadataJson: '{"source":"user"}', createdAt: "2" },
    ]);
    expect(messages).toEqual([{ role: "user", content: "context", source: "run-context" }]);
  });

  it("preserves ordinary repeated user and assistant turns", () => {
    const content = "A repeated ordinary message. ".repeat(12);
    const prepared = prepareChatWorkspaceSession({
      ...request("claude-code"), providerSessionRuntime: null, previousResponseId: null,
      priorChatMessages: [{ role: "user", content }, { role: "assistant", content }],
      prompt: content,
    });
    const history = prepared.prompt.split("</prior_conversation>")[0]!;
    expect(history).toContain("user: " + content.trim());
    expect(history).toContain("assistant: " + content.trim());
  });

  describe("run chats", () => {
    const runContext = `You are answering questions about a coding agent run. ${"context ".repeat(60)}`;
    const runChat = (prompt: string, priorChatMessages: RunExecutionRequest["priorChatMessages"]) => ({
      ...request("claude-code"), providerSessionRuntime: null, previousResponseId: null, prompt, priorChatMessages,
    });

    it("does not repeat the run context on the first turn, which already carries it", () => {
      const firstTurn = runChat(buildRunChatFirstTurnPrompt(runContext, "What changed?"), [{ role: "user", content: runContext, source: "run-context" }]);
      expect(prepareChatWorkspaceSession(firstTurn)).toBe(firstTurn);
    });

    it("does not repeat a refreshed run context that the follow-up prompt already carries", () => {
      const prepared = prepareChatWorkspaceSession(runChat(buildRunChatUpdateTurnPrompt(runContext, "And now?"), [
        { role: "user", content: runContext, source: "run-context" },
        { role: "user", content: "What changed?" },
        { role: "assistant", content: "The cards were redesigned." },
      ]));
      expect(prepared.prompt.split(runContext)).toHaveLength(2);
      expect(prepared.prompt).toContain("assistant: The cards were redesigned.");
    });

    it("still hands over the run context when the first turn got no reply and the prompt lacks it", () => {
      const prepared = prepareChatWorkspaceSession(runChat("Try again", [
        { role: "user", content: runContext, source: "run-context" },
        { role: "user", content: "What changed?" },
      ]));
      expect(prepared.prompt).toContain("This chat continues in a new provider session.");
      expect(prepared.prompt).toContain("user: You are answering questions about a coding agent run.");
      expect(prepared.prompt).toContain("user: What changed?");
    });
  });
});
