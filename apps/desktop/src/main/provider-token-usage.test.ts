import { describe, expect, it } from "vitest";
import type { RunTokenUsage } from "@buildwarden/shared";
import { normalizeAiSdkTokenUsage } from "../../../../packages/provider-ai-sdk/src";
import { normalizeCodexTokenUsage } from "../../../../packages/provider-codex-cli/src";
import { mergeClaudeUsageUpdate, parseClaudeCodeStreamEvent } from "../../../../packages/provider-claude-code/src";

type UsageFacts = {
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  maxTokens: number;
};

type ProviderUsageFormats = {
  codexCli: unknown;
  claudeCodeResult: unknown;
  aiSdk: unknown;
};

type ComparableRunTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  totalProcessedTokens: number;
  lastInputTokens: number;
  lastCachedInputTokens: number;
  lastOutputTokens: number;
  lastReasoningTokens: number;
};

const totalInputTokens = (facts: UsageFacts): number =>
  facts.uncachedInputTokens + facts.cacheReadInputTokens + facts.cacheWriteInputTokens;

const totalTokens = (facts: UsageFacts): number => totalInputTokens(facts) + facts.outputTokens;

const PROVIDER_USAGE_SCENARIO = {
  facts: {
    uncachedInputTokens: 1_200,
    cacheReadInputTokens: 2_400,
    cacheWriteInputTokens: 300,
    outputTokens: 180,
    reasoningTokens: 42,
    maxTokens: 200_000,
  },
  formats: {
    codexCli: {
      total_token_usage: {
        input_tokens: 3_900,
        output_tokens: 180,
        reasoning_output_tokens: 42,
        cache_read_input_tokens: 2_400,
        cache_write_input_tokens: 300,
        total_tokens: 4_080,
      },
      last_token_usage: {
        input_tokens: 3_900,
        output_tokens: 180,
        reasoning_output_tokens: 42,
        cache_read_input_tokens: 2_400,
        cache_write_input_tokens: 300,
        total_tokens: 4_080,
      },
      model_context_window: 200_000,
    },
    claudeCodeResult: {
      type: "result",
      session_id: "session-token-test",
      result: "done",
      modelUsage: {
        sonnet: {
          inputTokens: 1_200,
          outputTokens: 180,
          reasoningTokens: 42,
          cacheReadInputTokens: 2_400,
          cacheCreationInputTokens: 300,
          contextWindow: 200_000,
        },
      },
    },
    aiSdk: {
      inputTokens: 3_900,
      inputTokenDetails: {
        noCacheTokens: 1_200,
        cacheReadTokens: 2_400,
        cacheWriteTokens: 300,
      },
      outputTokens: 180,
      outputTokenDetails: {
        textTokens: 138,
        reasoningTokens: 42,
      },
      totalTokens: 4_080,
    },
  },
} as const satisfies { facts: UsageFacts; formats: ProviderUsageFormats };

const expectedComparableUsageFromFacts = (facts: UsageFacts): ComparableRunTokenUsage => {
  const inputTokens = totalInputTokens(facts);
  return {
    inputTokens,
    outputTokens: facts.outputTokens,
    reasoningTokens: facts.reasoningTokens,
    cachedInputTokens: facts.cacheReadInputTokens,
    cacheCreationInputTokens: facts.cacheWriteInputTokens,
    totalTokens: totalTokens(facts),
    totalProcessedTokens: totalTokens(facts),
    lastInputTokens: inputTokens,
    lastCachedInputTokens: facts.cacheReadInputTokens,
    lastOutputTokens: facts.outputTokens,
    lastReasoningTokens: facts.reasoningTokens,
  };
};

const requireUsageNumber = (value: number | undefined, fieldName: keyof RunTokenUsage): number => {
  if (typeof value !== "number") {
    throw new Error(`Expected normalized usage to include ${fieldName}.`);
  }
  return value;
};

const comparableTokenUsage = (usage: RunTokenUsage): ComparableRunTokenUsage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  reasoningTokens: requireUsageNumber(usage.reasoningTokens, "reasoningTokens"),
  cachedInputTokens: requireUsageNumber(usage.cachedInputTokens, "cachedInputTokens"),
  cacheCreationInputTokens: requireUsageNumber(usage.cacheCreationInputTokens, "cacheCreationInputTokens"),
  totalTokens: requireUsageNumber(usage.totalTokens, "totalTokens"),
  totalProcessedTokens: requireUsageNumber(usage.totalProcessedTokens, "totalProcessedTokens"),
  lastInputTokens: requireUsageNumber(usage.lastInputTokens, "lastInputTokens"),
  lastCachedInputTokens: requireUsageNumber(usage.lastCachedInputTokens, "lastCachedInputTokens"),
  lastOutputTokens: requireUsageNumber(usage.lastOutputTokens, "lastOutputTokens"),
  lastReasoningTokens: requireUsageNumber(usage.lastReasoningTokens, "lastReasoningTokens"),
});

const normalizeClaudeResultUsage = (event: unknown): RunTokenUsage => {
  const parsed = parseClaudeCodeStreamEvent(event);
  if (!parsed.usage) {
    throw new Error("Expected Claude result event to include usage.");
  }
  return mergeClaudeUsageUpdate({ inputTokens: 0, outputTokens: 0 }, new Map(), parsed).usage;
};

describe("provider token usage normalization", () => {
  it("documents provider-native usage formats before comparing normalized usage", () => {
    const { facts, formats } = PROVIDER_USAGE_SCENARIO;
    const inputTokens = totalInputTokens(facts);
    const tokens = totalTokens(facts);

    expect(formats.codexCli).toEqual({
      total_token_usage: {
        input_tokens: inputTokens,
        output_tokens: facts.outputTokens,
        reasoning_output_tokens: facts.reasoningTokens,
        cache_read_input_tokens: facts.cacheReadInputTokens,
        cache_write_input_tokens: facts.cacheWriteInputTokens,
        total_tokens: tokens,
      },
      last_token_usage: {
        input_tokens: inputTokens,
        output_tokens: facts.outputTokens,
        reasoning_output_tokens: facts.reasoningTokens,
        cache_read_input_tokens: facts.cacheReadInputTokens,
        cache_write_input_tokens: facts.cacheWriteInputTokens,
        total_tokens: tokens,
      },
      model_context_window: facts.maxTokens,
    });
    expect(formats.claudeCodeResult).toEqual({
      type: "result",
      session_id: "session-token-test",
      result: "done",
      modelUsage: {
        sonnet: {
          inputTokens: facts.uncachedInputTokens,
          outputTokens: facts.outputTokens,
          reasoningTokens: facts.reasoningTokens,
          cacheReadInputTokens: facts.cacheReadInputTokens,
          cacheCreationInputTokens: facts.cacheWriteInputTokens,
          contextWindow: facts.maxTokens,
        },
      },
    });
    expect(formats.aiSdk).toEqual({
      inputTokens,
      inputTokenDetails: {
        noCacheTokens: facts.uncachedInputTokens,
        cacheReadTokens: facts.cacheReadInputTokens,
        cacheWriteTokens: facts.cacheWriteInputTokens,
      },
      outputTokens: facts.outputTokens,
      outputTokenDetails: {
        textTokens: facts.outputTokens - facts.reasoningTokens,
        reasoningTokens: facts.reasoningTokens,
      },
      totalTokens: tokens,
    });
  });

  it("normalizes equivalent provider-native usage payloads to the same processed token usage", () => {
    const { facts, formats } = PROVIDER_USAGE_SCENARIO;
    const expected = expectedComparableUsageFromFacts(facts);
    const normalizedByProvider: Array<[string, RunTokenUsage]> = [
      ["Codex CLI", normalizeCodexTokenUsage(formats.codexCli)],
      ["Claude Code", normalizeClaudeResultUsage(formats.claudeCodeResult)],
      ["AI SDK", normalizeAiSdkTokenUsage(formats.aiSdk)],
    ];

    for (const [providerName, usage] of normalizedByProvider) {
      expect(comparableTokenUsage(usage), providerName).toEqual(expected);
    }
  });
});
