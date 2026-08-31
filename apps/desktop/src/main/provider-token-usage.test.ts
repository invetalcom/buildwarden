import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { HarnessType, ProviderType, RunTokenUsage } from "@buildwarden/shared";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAiSdkTokenUsage } from "@buildwarden/provider-ai-sdk";
import { normalizeAzureLegacyTokenUsage } from "@buildwarden/provider-azure-legacy";
import { normalizeCodexTokenUsage } from "@buildwarden/provider-codex-cli";
import { mergeClaudeUsageUpdate, parseClaudeCodeStreamEvent } from "@buildwarden/provider-claude-code";
import { normalizeCursorTokenUsage } from "@buildwarden/provider-cursor-agent";
import { advanceReportedTokenUsage } from "./token-usage-accounting";

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
  cursorAgent: unknown;
  azureLegacy: unknown;
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
    cursorAgent: {
      usage: {
        inputTokens: 3_900,
        outputTokens: 180,
        thoughtTokens: 42,
        cachedReadTokens: 2_400,
        cachedWriteTokens: 300,
        totalTokens: 4_080,
      },
    },
    azureLegacy: {
      prompt_tokens: 3_900,
      completion_tokens: 180,
      total_tokens: 4_080,
      prompt_tokens_details: { cached_tokens: 2_400 },
      completion_tokens_details: { reasoning_tokens: 42 },
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

const requireCursorUsage = (payload: unknown): RunTokenUsage => {
  const normalized = normalizeCursorTokenUsage(payload);
  if (!normalized) throw new Error("Expected Cursor payload to include usage.");
  return normalized;
};

type ProviderAccountingCase = {
  providerName: string;
  providerType: ProviderType;
  harnessType: HarnessType;
  normalize: () => RunTokenUsage;
};

const providerAccountingCases = (): ProviderAccountingCase[] => {
  const { formats } = PROVIDER_USAGE_SCENARIO;
  return [
    {
      providerName: "Codex CLI",
      providerType: "codex-cli",
      harnessType: "codex-app-server",
      normalize: () => normalizeCodexTokenUsage(formats.codexCli),
    },
    {
      providerName: "Claude Code",
      providerType: "claude-code",
      harnessType: "claude-code",
      normalize: () => normalizeClaudeResultUsage(formats.claudeCodeResult),
    },
    {
      providerName: "Cursor Agent",
      providerType: "cursor-agent",
      harnessType: "cursor-acp",
      normalize: () => requireCursorUsage(formats.cursorAgent),
    },
    {
      providerName: "AI SDK",
      providerType: "ai-sdk",
      harnessType: "ai-sdk",
      normalize: () => normalizeAiSdkTokenUsage(formats.aiSdk),
    },
    {
      providerName: "OpenRouter",
      providerType: "openrouter",
      harnessType: "ai-sdk",
      normalize: () => normalizeAiSdkTokenUsage(formats.aiSdk),
    },
    {
      providerName: "Azure Legacy",
      providerType: "azure-legacy",
      harnessType: "azure-legacy",
      normalize: () => normalizeAzureLegacyTokenUsage(formats.azureLegacy),
    },
  ];
};

const accountingDbs: BuildWardenDatabase[] = [];
const accountingTempDirs: string[] = [];

const makeAccountingDb = async (): Promise<BuildWardenDatabase> => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-provider-accounting-"));
  accountingTempDirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "buildwarden.sqlite"));
  await db.init();
  accountingDbs.push(db);
  return db;
};

afterEach(async () => {
  for (const db of accountingDbs.splice(0)) await db.close();
  for (const dir of accountingTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  it("normalizes the app-server tokenUsage shape Codex emits today", () => {
    // Verified against codex-cli 0.144.1: camelCase, total/last buckets, no cache-write counter.
    expect(
      normalizeCodexTokenUsage({
        total: { totalTokens: 14_514, inputTokens: 14_494, cachedInputTokens: 5_504, outputTokens: 20, reasoningOutputTokens: 13 },
        last: { totalTokens: 14_514, inputTokens: 14_494, cachedInputTokens: 5_504, outputTokens: 20, reasoningOutputTokens: 13 },
        modelContextWindow: 258_400,
      }),
    ).toMatchObject({
      inputTokens: 14_494,
      outputTokens: 20,
      cachedInputTokens: 5_504,
      reasoningTokens: 13,
      totalProcessedTokens: 14_514,
      usedTokens: 14_514,
      maxTokens: 258_400,
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

  it("uses model catalog context metadata for the AI SDK context meter", () => {
    expect(normalizeAiSdkTokenUsage({ inputTokens: 12_000, outputTokens: 500, totalTokens: 12_500 }, {
      buildwardenContextWindowTokens: 128_000,
    })).toMatchObject({
      inputTokens: 12_000,
      outputTokens: 500,
      usedTokens: 12_500,
      lastUsedTokens: 12_500,
      maxTokens: 128_000,
      totalProcessedTokens: 12_500,
    });
  });
});

describe("provider token usage accounting contracts", () => {
  it.each(providerAccountingCases())(
    "$providerName native usage reaches durable run, project, and daily totals",
    async ({ providerName, providerType, harnessType, normalize }) => {
      const db = await makeAccountingDb();
      const project = db.addProject({
        repoPath: `C:\\provider-accounting\\${providerType}`,
        baseBranch: "main",
        resolvedName: `${providerName} accounting`,
      });
      const provider = db.addProviderAccount({
        providerType,
        label: providerName,
        apiBaseUrl: null,
        apiKeyRef: "",
        configJson: "{}",
      });
      const model = db.addModel({
        providerAccountId: provider.id,
        modelId: `${providerType}-model`,
        displayName: `${providerName} model`,
        config: {},
        capabilities: {},
        enabled: true,
      });
      const run = db.createRun({
        projectId: project.id,
        providerAccountId: provider.id,
        modelId: model.id,
        harnessType,
        mode: "code",
        workspaceType: "worktree",
        prompt: `Test ${providerName} accounting`,
        branchName: "main",
        worktreePath: `C:\\provider-accounting\\${providerType}\\worktree`,
      });

      const normalized = normalize();
      const advance = advanceReportedTokenUsage(
        { inputTokens: 0, outputTokens: 0 },
        { inputTokens: 0, outputTokens: 0 },
        normalized,
      );
      db.recordRunTokenUsage(run.id, advance.inputTokensDelta, advance.outputTokensDelta);

      expect(normalized, providerName).toMatchObject({ inputTokens: 3_900, outputTokens: 180 });
      expect(db.getRun(run.id), providerName).toMatchObject({ inputTokens: 3_900, outputTokens: 180 });
      expect(db.getProject(project.id), providerName).toMatchObject({
        cumulativeInputTokens: 3_900,
        cumulativeOutputTokens: 180,
      });
      expect(db.getSnapshot().tokenUsage?.today, providerName).toEqual({ inputTokens: 3_900, outputTokens: 180 });
    },
  );
});
