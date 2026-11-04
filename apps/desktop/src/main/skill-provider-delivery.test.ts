import { describe, expect, it } from "vitest";
import type { RunExecutionRequest } from "@buildwarden/shared";
import { buildAiSdkStartingMessages } from "@buildwarden/provider-ai-sdk";
import { buildCursorPrompt } from "@buildwarden/provider-cursor-agent";
import { buildPromptForMode, needsCodexToolMigration } from "@buildwarden/provider-codex-cli";
import { buildClaudePrompt } from "@buildwarden/provider-claude-code";
import { buildAzureAgentSetup } from "@buildwarden/provider-azure-legacy";

const input: RunExecutionRequest = {
  runId: "run", worktreePath: ".", mode: "code", prompt: "Task sentinel", providerType: "ai-sdk", modelId: "test", apiKey: "",
  repoContext: "SKILL_CATALOG_SENTINEL: call buildwarden_load_skill when relevant.",
};

describe("skill delivery across provider conversation paths", () => {
  it.each([undefined, "", "new catalog"])("replaces or removes stale Azure recovery context with %s", (repoContext) => {
    const chatMessages: NonNullable<RunExecutionRequest["resumeCheckpoint"]>["chatMessages"] = [
      { role: "system", content: "Original system instructions" },
      { role: "system", content: "Current recovered workspace context:\nold catalog" },
      { role: "assistant", content: null, toolCalls: [{ id: "call", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", toolCallId: "call", content: "result" },
    ];
    const setup = buildAzureAgentSetup({ ...input, repoContext, resumeCheckpoint: { round: 2, chatMessages } }, { tools: [], executeTool: async () => { throw new Error("Not executed"); } });
    expect(setup.messages.filter((message) => message.role !== "system")).toMatchObject([
      { role: "assistant", tool_calls: [{ id: "call", function: { name: "read_file" } }] },
      { role: "tool", tool_call_id: "call", content: "result" },
    ]);
    expect(JSON.stringify(setup.messages)).not.toContain("old catalog");
    expect(setup.messages).toContainEqual(chatMessages[0]);
    expect(setup.messages.filter((message) => message.role === "system")).toHaveLength(repoContext ? 2 : 1);
    if (repoContext) expect(setup.messages[0]?.content).toBe(`Current recovered workspace context:\n${repoContext}`);
    expect(chatMessages[1]?.content).toContain("old catalog");
  });

  it("delivers fresh context to initial AI SDK runs and follow-ups with reconstructed history", () => {
    const history = [{ role: "user", content: "earlier task" }, { role: "assistant", content: "earlier response" }];
    for (const priorMessages of [undefined, history]) {
      const messages = buildAiSdkStartingMessages({ ...input, priorMessages }, false, false);
      expect(JSON.stringify(messages)).toContain("SKILL_CATALOG_SENTINEL");
      expect(JSON.stringify(messages.at(-1)?.content)).toContain("Task sentinel");
      if (priorMessages) expect(messages).toEqual(expect.arrayContaining(history));
    }
  });

  it("preserves checkpoint tool-call/result pairs and replaces the recovery envelope", () => {
    const checkpointMessages = [
      { role: "system", content: "Current recovered workspace context:\nold catalog" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "read_file", input: { path: "README.md" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "read_file", output: "readme" }] },
    ];
    const messages = buildAiSdkStartingMessages({ ...input, resumeCheckpoint: { round: 2, messages: checkpointMessages } }, false, false);
    expect(messages.slice(1)).toEqual(checkpointMessages.slice(1));
    expect(JSON.stringify(messages)).not.toContain("old catalog");
    expect(JSON.stringify(messages)).toContain("SKILL_CATALOG_SENTINEL");
    expect(checkpointMessages[0]?.content).toContain("old catalog");
  });

  it("delivers skills to AI SDK chat without losing chat history", () => {
    const messages = buildAiSdkStartingMessages({ ...input, isChat: true, priorMessages: [{ role: "user", content: "Earlier chat" }] }, true, false);
    expect(messages[0]?.content).toContain("SKILL_CATALOG_SENTINEL");
    expect(messages[1]?.content).toBe("Earlier chat");
  });

  it("delivers repository context through Cursor and leaves utility prompts unchanged", () => {
    expect(buildCursorPrompt(input)).toContain("SKILL_CATALOG_SENTINEL");
    expect(buildCursorPrompt({ prompt: "Task sentinel" })).toBe("Task sentinel");
  });

  it.each([false, true])("delivers context to Codex with isChat=%s", (isChat) => {
    const prompt = buildPromptForMode({ prompt: input.prompt, repoContext: input.repoContext, inputMode: "ask", isChat });
    expect(prompt).toContain("SKILL_CATALOG_SENTINEL");
    expect(prompt).toContain("Task sentinel");
  });

  it("retains Claude's skill context and preserves the native compact command", () => {
    const options = { runId: "run", signal: new AbortController().signal, cwd: ".", prompt: input.prompt, inputMode: "code" as const, modelId: "test", repoContext: input.repoContext };
    expect(buildClaudePrompt(options)).toContain("SKILL_CATALOG_SENTINEL");
    expect(buildClaudePrompt({ ...options, prompt: "/compact" })).toBe("/compact");
  });

  it("delivers skills and prior conversation to Azure chats using the tool loop", () => {
    const context = { tools: [{ name: "buildwarden_load_skill" as const, description: "Load", inputSchema: { type: "object" } }], executeTool: async () => { throw new Error("Not executed"); } };
    const setup = buildAzureAgentSetup({ ...input, isChat: true, mode: "ask", priorChatMessages: [{ role: "user", content: "Earlier chat" }] }, context);
    expect(setup.messages[0]?.content).toContain("Only use tools that are explicitly available");
    expect(setup.messages[0]?.content).not.toContain("do not have access");
    const plain = buildAzureAgentSetup({ ...input, isChat: true }, { ...context, tools: [] });
    expect(plain.messages[0]?.content).toContain("You do not have access to any tools or files");
    const run = buildAzureAgentSetup({ ...input, isChat: false }, context);
    expect(run.messages[0]?.content).toContain("Policy:");
    expect(JSON.stringify(setup.messages)).toContain("SKILL_CATALOG_SENTINEL");
    expect(JSON.stringify(setup.messages)).toContain("Earlier chat");
    expect(setup.tools[0]).toMatchObject({ type: "function", function: { name: "buildwarden_load_skill" } });
  });
});

it("migrates legacy or changed Codex tools once and reuses identical schemas", () => {
  expect(needsCodexToolMigration("skills", undefined, true, true)).toBe(true);
  expect(needsCodexToolMigration("skills", "old", true, true)).toBe(true);
  expect(needsCodexToolMigration("skills", "skills", true, true)).toBe(false);
  expect(needsCodexToolMigration("tools", undefined, true, false)).toBe(false);
});
