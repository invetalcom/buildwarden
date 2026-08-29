import OpenAI from "openai";
import {
  runShellActivityStreamId,
  type HarnessRunChunk,
  type HarnessToolContext,
  type RunTokenUsage,
} from "@buildwarden/shared";
import { describeToolCall, isRunToolName, safeJsonParse } from "./harness-shared";

export type AzureLegacyToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export const collectAzureLegacyRound = async (
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  streamOutId: string,
  onChunk: (chunk: HarnessRunChunk) => void,
  normalizeUsage: (usage: OpenAI.CompletionUsage | undefined) => RunTokenUsage,
): Promise<{ usage: RunTokenUsage; assistantContent: string; toolCalls: AzureLegacyToolCall[] }> => {
  let usage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };
  let assistantContent = "";
  const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = normalizeUsage(chunk.usage);
    }
    const delta = chunk.choices[0]?.delta;
    if (!delta) {
      continue;
    }
    if (delta.content) {
      assistantContent += delta.content;
      onChunk({
        type: "message",
        title: "Agent output",
        value: assistantContent,
        metadata: { streamId: streamOutId, replace: true },
      });
    }
    for (const toolCallDelta of delta.tool_calls ?? []) {
      const index = toolCallDelta.index ?? 0;
      const current = toolCallParts.get(index) ?? { id: "", name: "", arguments: "" };
      if (toolCallDelta.id) current.id = toolCallDelta.id;
      if (toolCallDelta.function?.name) current.name += toolCallDelta.function.name;
      if (toolCallDelta.function?.arguments) current.arguments += toolCallDelta.function.arguments;
      toolCallParts.set(index, current);
    }
  }

  const toolCalls = [...toolCallParts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, toolCall]) => ({
      id: toolCall.id || crypto.randomUUID(),
      type: "function" as const,
      function: { name: toolCall.name, arguments: toolCall.arguments || "{}" },
    }));
  return { usage, assistantContent, toolCalls };
};

export const executeAzureLegacyToolCalls = async <State>(
  toolCalls: AzureLegacyToolCall[],
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  toolContext: HarnessToolContext,
  completionState: State,
  onChunk: (chunk: HarnessRunChunk) => void,
  updateCompletionState: (
    state: State,
    toolName: string,
    toolResult: { ok: boolean; metadata?: Record<string, unknown> },
  ) => void,
): Promise<string[]> => {
  const toolResultsForCheckpoint: string[] = [];
  for (const toolCall of toolCalls) {
    const name = toolCall.function.name;
    const parsedArgs = safeJsonParse(toolCall.function.arguments || "{}");
    if (!isRunToolName(name, toolContext)) {
      throw new Error(`The model requested an unsupported tool: ${name}`);
    }
    onChunk({
      type: "tool-call",
      title: `Tool call: ${name}`,
      value: describeToolCall(name, parsedArgs),
      metadata: { toolName: name, arguments: parsedArgs, callId: toolCall.id },
    });
    const toolResult = await toolContext.executeTool({ id: toolCall.id, name, arguments: parsedArgs });
    updateCompletionState(completionState, name, toolResult);
    onChunk({
      type: "tool-result",
      title: `Tool result: ${name}`,
      value: toolResult.content,
      metadata: {
        toolName: name,
        callId: toolCall.id,
        ok: toolResult.ok,
        ...toolResult.metadata,
        ...(name === "run_shell" ? { streamId: runShellActivityStreamId(toolCall.id), replace: true } : {}),
      },
    });
    messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult.content });
    toolResultsForCheckpoint.push(toolResult.content);
  }
  return toolResultsForCheckpoint;
};
