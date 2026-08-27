import { describe, expect, it } from "vitest";
import type { ProjectSnapshot, ProviderType, RunRecord, UnifiedProviderFamily } from "@buildwarden/shared";
import {
  buildModelExecutionProfile,
  buildRunReasoningInput,
  findProjectRun,
  harnessTypeForProvider,
  removeRunIdsFromOpenPanes,
  resolveRunModelConfiguration,
  snapshotContainsRunId,
} from "./app-model";

describe("harnessTypeForProvider", () => {
  const cases: Array<[ProviderType, string]> = [
    ["codex-cli", "codex-app-server"],
    ["claude-code", "claude-code"],
    ["cursor-agent", "cursor-acp"],
    ["azure-legacy", "azure-legacy"],
    ["ai-sdk", "ai-sdk"],
    ["openrouter", "ai-sdk"],
  ];

  it.each(cases)("maps %s to harness type %s", (providerType, expected) => {
    expect(harnessTypeForProvider(providerType)).toBe(expected);
  });
});

describe("buildRunReasoningInput", () => {
  it("resolves independent values for each selected model chip", () => {
    const configurations = {
      openai: { effort: "high", executionMode: "priority" },
      claude: { effort: "xhigh", executionMode: "auto" },
    };
    expect(resolveRunModelConfiguration("openai", configurations, "low", "medium", "auto", false)).toEqual({
      effort: "high",
      executionMode: "priority",
    });
    expect(resolveRunModelConfiguration("claude", configurations, "low", "medium", "fast", true)).toEqual({
      effort: "xhigh",
      executionMode: "auto",
    });
    expect(resolveRunModelConfiguration("missing", configurations, "low", "medium", "fast", true)).toEqual({
      effort: "medium",
      executionMode: "fast",
    });
  });

  it("maps Codex effort and fast mode without conflating the two controls", () => {
    const profile = buildModelExecutionProfile("codex-cli", null, "gpt-5.6-sol");
    expect(buildRunReasoningInput("codex-cli", null, "ultra", "auto", profile, "fast")).toEqual({
      reasoningEffort: "ultra",
      executionOptions: { reasoningEffort: "ultra", serviceTier: "fast" },
    });
  });

  it("maps only Cursor controls advertised through ACP", () => {
    const profile = buildModelExecutionProfile("cursor-agent", null, "cursor-model", {
      cursorAcpConfigOptions: [{
        id: "reasoning_effort",
        name: "Reasoning",
        type: "select",
        options: [{ value: "high", name: "High" }],
      }],
    });
    expect(buildRunReasoningInput("cursor-agent", null, "high", "auto", profile)).toEqual({
      reasoningEffort: "high",
      executionOptions: { reasoningEffort: "high" },
    });
  });

  it("omits unsupported values instead of silently substituting medium", () => {
    expect(buildRunReasoningInput("cursor-agent", null, "extreme", "medium")).toEqual({});
  });

  it("does not invent a Claude ultracode choice from xhigh support", () => {
    const profile = buildModelExecutionProfile("claude-code", null, "claude-opus-4-8");
    expect(profile.controls.find((control) => control.id === "reasoningEffort")?.options.map((entry) => entry.value))
      .not.toContain("ultracode");
    expect(buildRunReasoningInput("claude-code", null, "auto", "ultracode", profile)).toEqual({
      executionOptions: { speed: "auto" },
    });
  });

  it("routes AI SDK openai family through OpenAI-style reasoning effort", () => {
    const profile = buildModelExecutionProfile("ai-sdk", "openai", "gpt-5.5");
    expect(buildRunReasoningInput("ai-sdk", "openai" as UnifiedProviderFamily, "low", "medium", profile)).toEqual({
      reasoningEffort: "low",
      executionOptions: { reasoningEffort: "low", serviceTier: "auto" },
    });
  });

  it("routes AI SDK anthropic family through Anthropic-style effort", () => {
    const profile = buildModelExecutionProfile("ai-sdk", "anthropic", "claude-opus-4-8");
    expect(buildRunReasoningInput("ai-sdk", "anthropic" as UnifiedProviderFamily, "medium", "max", profile)).toEqual({
      anthropicEffort: "max",
      executionOptions: { anthropicEffort: "max", speed: "auto" },
    });
  });

  it("maps Google thinking levels using the Google provider option name", () => {
    const profile = buildModelExecutionProfile("ai-sdk", "google", "gemini-3.1-pro-preview");
    expect(buildRunReasoningInput("ai-sdk", "google", "high", "auto", profile)).toEqual({
      executionOptions: { thinkingLevel: "high" },
    });
  });

  it("keeps Azure Legacy completely outside the new execution-option contract", () => {
    expect(buildRunReasoningInput("azure-legacy", null, "high", "high")).toEqual({});
  });
});

describe("buildModelExecutionProfile", () => {
  const values = (
    providerType: ProviderType,
    providerFamily: UnifiedProviderFamily | null,
    modelId: string,
    controlId: "reasoningEffort" | "thinkingLevel" | "speed" | "serviceTier",
  ) => buildModelExecutionProfile(providerType, providerFamily, modelId).controls
    .find((control) => control.id === controlId)?.options.map((entry) => entry.value) ?? [];

  it("limits Codex GPT-5.5 to the four efforts advertised by Codex", () => {
    expect(values("codex-cli", null, "gpt-5.5", "reasoningEffort")).toEqual([
      "auto", "low", "medium", "high", "xhigh",
    ]);
    expect(values("codex-cli", null, "gpt-5.5", "reasoningEffort")).not.toContain("ultra");
    expect(values("codex-cli", null, "gpt-5.6-sol", "reasoningEffort")).toContain("ultra");
    expect(values("codex-cli", null, "gpt-5.6-luna", "reasoningEffort")).not.toContain("ultra");
    expect(values("codex-cli", null, "gpt-5.4", "serviceTier")).toEqual(["auto", "fast"]);
    expect(values("codex-cli", null, "gpt-5.4-mini", "serviceTier")).toEqual([]);
  });

  it("repairs stale inferred profiles but preserves provider-advertised metadata", () => {
    const legacyConfig = {
      buildwardenExecutionProfile: {
        controls: [{
          id: "reasoningEffort",
          label: "Effort",
          options: ["low", "medium", "high", "xhigh", "max", "ultra"].map((value) => ({ value, label: value })),
        }],
      },
    };
    expect(buildModelExecutionProfile("codex-cli", null, "gpt-5.5", legacyConfig).controls[0]?.options.map((entry) => entry.value))
      .toEqual(["auto", "low", "medium", "high", "xhigh"]);

    const providerConfig = {
      buildwardenExecutionProfile: {
        source: "provider",
        controls: [{
          id: "reasoningEffort",
          label: "Effort",
          options: [{ value: "high", label: "High" }],
        }],
      },
    };
    expect(buildModelExecutionProfile("codex-cli", null, "gpt-5.5", providerConfig).controls[0]?.options.map((entry) => entry.value))
      .toEqual(["auto", "high"]);
  });

  it("keeps direct OpenAI API effort profiles distinct from Codex", () => {
    expect(values("ai-sdk", "openai", "gpt-5.5", "reasoningEffort")).toEqual([
      "auto", "none", "low", "medium", "high", "xhigh",
    ]);
    expect(values("ai-sdk", "openai", "gpt-5.5-pro", "reasoningEffort")).toEqual([
      "auto", "medium", "high", "xhigh",
    ]);
    expect(values("ai-sdk", "openai", "gpt-5.6-sol", "reasoningEffort")).toEqual([
      "auto", "none", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(values("ai-sdk", "openai", "gpt-5.5", "serviceTier")).toEqual([
      "auto", "default", "flex", "priority",
    ]);
  });

  it("uses exact model-specific Claude, Gemini, and xAI controls", () => {
    expect(values("ai-sdk", "anthropic", "claude-opus-4-8", "reasoningEffort")).toEqual([
      "auto", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(values("ai-sdk", "anthropic", "claude-opus-4-8", "speed")).toEqual([
      "auto", "standard", "fast",
    ]);
    expect(values("ai-sdk", "anthropic", "claude-opus-4-7", "speed")).toEqual([]);
    expect(values("ai-sdk", "google", "gemini-3.1-pro-preview", "thinkingLevel")).toEqual([
      "auto", "low", "medium", "high",
    ]);
    expect(values("ai-sdk", "google", "gemini-3.5-flash", "thinkingLevel")).toEqual([
      "auto", "minimal", "low", "medium", "high",
    ]);
    expect(values("ai-sdk", "xai", "grok-4.5", "reasoningEffort")).toEqual([
      "auto", "low", "medium", "high",
    ]);
  });

  it("repairs a stale Claude Code Sonnet alias with its current effort choices", () => {
    expect(values("claude-code", null, "sonnet", "reasoningEffort")).toEqual([
      "auto", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(values("claude-code", null, "sonnet", "speed")).toEqual([]);
  });

  it("does not guess controls for custom OpenAI-compatible or unknown models", () => {
    expect(buildModelExecutionProfile("ai-sdk", "openai-compatible", "custom-reasoner")).toEqual({ controls: [] });
    expect(buildModelExecutionProfile("codex-cli", null, "future-codex-model")).toEqual({ controls: [] });
    expect(buildModelExecutionProfile("claude-code", null, "future-claude-model")).toEqual({ controls: [] });
  });
});

describe("removeRunIdsFromOpenPanes", () => {
  it("removes coordinator and child panes from a cascade while preserving unrelated runs", () => {
    expect(removeRunIdsFromOpenPanes(
      { left: "coordinator-1", right: "child-1" },
      new Set(["coordinator-1", "child-1"]),
    )).toEqual({});
    expect(removeRunIdsFromOpenPanes(
      { left: "child-1", right: "run-2" },
      new Set(["coordinator-1", "child-1"]),
    )).toEqual({ right: "run-2" });
  });
});

describe("orchestrated run lookup", () => {
  it("finds durable subagent runs for direct selection and restoration", () => {
    const child = {
      id: "child-1",
      projectId: "project-1",
      kind: "orchestration-task",
    } as RunRecord;
    const project = {
      project: {
        id: "project-1",
        name: "BuildWarden",
        repoPath: "C:/repo",
        baseBranch: "main",
        kind: "git",
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        createdAt: "2026-08-09T10:00:00.000Z",
        updatedAt: "2026-08-09T10:00:00.000Z",
        lastOpenedAt: "2026-08-09T10:00:00.000Z",
      },
      runs: [],
      forLaterRuns: [],
      orchestratedRuns: [child],
      activeRuns: [],
      recentRuns: [],
      tasks: [],
      insights: [],
      labThreads: [],
      loops: [],
    } satisfies ProjectSnapshot;

    expect(findProjectRun([project], child.id)).toEqual({ project, run: child });
    expect(snapshotContainsRunId([project], child.id)).toBe(true);
  });
});
