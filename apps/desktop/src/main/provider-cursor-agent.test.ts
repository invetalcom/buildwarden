import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CursorAgentProviderAdapter,
  buildCursorPlanProgressChunk,
  createCursorDevLogger,
  deriveCursorMaxTokensFromConfigOptions,
  extractCursorTodosAsPlanProgress,
  mapCursorUserInputAnswers,
  normalizeCursorTokenUsage,
  parseCursorAboutOutput,
  parseCursorAvailableModelsResponse,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
  resolveCursorAgentProcessLaunch,
} from "@buildwarden/provider-cursor-agent";

describe("CursorAgentProviderAdapter", () => {
  it("accepts local Cursor Agent settings without an API key", () => {
    const adapter = new CursorAgentProviderAdapter();

    expect(() =>
      adapter.validateConfiguration({
        providerType: "cursor-agent",
        label: "Cursor Agent",
        apiKey: "",
        config: {
          cursorBinaryPath: "agent",
          cursorApiEndpoint: "https://cursor.example.test",
        },
      }),
    ).not.toThrow();
  });

  it("rejects blank Cursor binary path overrides", () => {
    const adapter = new CursorAgentProviderAdapter();

    expect(() =>
      adapter.validateConfiguration({
        providerType: "cursor-agent",
        label: "Cursor Agent",
        apiKey: "",
        config: {
          cursorBinaryPath: "   ",
        },
      }),
    ).toThrow("Cursor binary path cannot be blank");
  });

  it("wraps Windows command shims without shell mode while preserving explicit exe paths", () => {
    const shim = resolveCursorAgentProcessLaunch("agent", ["acp"]);

    if (process.platform === "win32") {
      expect(shim).toEqual({
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", '"agent" "acp"'],
      });
      expect(resolveCursorAgentProcessLaunch("C:\\Tools\\agent.exe", ["acp"])).toEqual({
        command: "C:\\Tools\\agent.exe",
        args: ["acp"],
      });
      expect(() => resolveCursorAgentProcessLaunch("agent", ["-e", "https://cursor.example.test?a=1&b=2", "acp"])).toThrow(
        "shell metacharacters",
      );
    } else {
      expect(shim).toEqual({ command: "agent", args: ["acp"] });
    }
  });

  it("writes Cursor dev request logs as JSONL", () => {
    const logDir = mkdtempSync(join(tmpdir(), "buildwarden-cursor-logs-"));
    try {
      const logger = createCursorDevLogger({
        logDirPath: logDir,
        runId: "run-1",
        modelId: "composer-2.5",
        sessionType: "run",
      });

      expect(logger.enabled).toBe(true);
      logger.log("cursor.rpc.outbound", { method: "initialize", params: { protocolVersion: 1 } });

      const line = readFileSync(join(logDir, "run-run-1-cursor-agent-composer-2.5.jsonl"), "utf8").trim();
      expect(JSON.parse(line)).toMatchObject({
        event: "cursor.rpc.outbound",
        data: {
          method: "initialize",
          params: { protocolVersion: 1 },
        },
      });
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("parses Cursor about output authentication state", () => {
    expect(parseCursorAboutOutput(JSON.stringify({ userEmail: "dev@example.com" }))).toEqual({
      authenticated: true,
      detail: "dev@example.com",
    });
    expect(parseCursorAboutOutput(JSON.stringify({ userEmail: null }))).toEqual({ authenticated: false });
    expect(parseCursorAboutOutput("not authenticated, please login")).toEqual({ authenticated: false });
  });

  it("parses available models and preserves ACP config options", () => {
    const models = parseCursorAvailableModelsResponse({
      models: [
        {
          value: "composer-2.5",
          name: "Composer 2.5",
          configOptions: [
            {
              id: "context",
              name: "Context Window",
              category: "model_config",
              type: "select",
              currentValue: "1m",
              options: [{ value: "1m", name: "1M" }],
            },
          ],
        },
        { value: "composer-2.5", name: "Duplicate" },
        { name: "Missing ID" },
      ],
    });

    expect(models).toEqual([
      {
        modelId: "composer-2.5",
        displayName: "Composer 2.5",
        source: "provider",
        config: {
          cursorAcpConfigOptions: [
            {
              id: "context",
              name: "Context Window",
              category: "model_config",
              type: "select",
              currentValue: "1m",
              options: [{ value: "1m", name: "1M" }],
            },
          ],
          cursorMaxTokens: 1_000_000,
        },
      },
    ]);
  });

  it("extracts Cursor context windows from config options", () => {
    expect(
      deriveCursorMaxTokensFromConfigOptions([
        {
          id: "contextWindow",
          name: "Context Window",
          category: "model_config",
          type: "select",
          currentValue: "272k",
        },
      ]),
    ).toBe(272_000);
  });

  it("maps BuildWarden answer labels back to Cursor option ids", () => {
    expect(
      mapCursorUserInputAnswers(
        {
          language: "TypeScript",
          modes: ["Plan", "Agent"],
          custom: "free-form",
        },
        {
          language: { TypeScript: "ts" },
          modes: { Plan: "plan", Agent: "agent" },
        },
      ),
    ).toEqual({
      language: "ts",
      modes: ["plan", "agent"],
      custom: "free-form",
    });
  });

  it("resolves base model ids and reasoning config updates", () => {
    expect(resolveCursorAcpBaseModelId("composer-2.5[fast=true]")).toBe("composer-2.5");
    expect(
      resolveCursorAcpConfigUpdates(
        [
          {
            id: "reasoning",
            name: "Reasoning",
            category: "model_config",
            type: "select",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
        { reasoningEffort: "high" },
      ),
    ).toEqual([{ configId: "reasoning", value: "high" }]);
  });

  it("maps Cursor todos to normalized plan progress", () => {
    expect(
      extractCursorTodosAsPlanProgress({
        todos: [
          { content: "Inspect ACP", status: "completed" },
          { title: "Wire renderer", status: "in_progress" },
          { content: "Run tests", status: "todo" },
        ],
        merge: true,
      }),
    ).toEqual({
      source: "cursor-acp",
      steps: [
        { title: "Inspect ACP", status: "completed" },
        { title: "Wire renderer", status: "inProgress" },
        { title: "Run tests", status: "pending" },
      ],
    });
  });

  it("builds replaceable Cursor plan-progress chunks", () => {
    const chunk = buildCursorPlanProgressChunk(
      {
        source: "cursor-acp",
        explanation: "Working",
        steps: [{ title: "Update shared types", status: "inProgress" }],
      },
      { method: "cursor/update_todos" },
    );

    expect(chunk).toMatchObject({
      type: "plan-progress",
      title: "Plan progress",
      value: "Working\n\n1. [-] Update shared types",
      metadata: {
        provider: "cursor-agent",
        streamId: "cursor-plan-progress",
        replace: true,
        planProgress: {
          source: "cursor-acp",
          explanation: "Working",
          steps: [{ title: "Update shared types", status: "inProgress" }],
        },
      },
    });
  });

  it("normalizes Cursor usage and context payloads", () => {
    expect(
      normalizeCursorTokenUsage({
        usage: {
          input_tokens: 120,
          output_tokens: 35,
          reasoning_tokens: 7,
          context_used_tokens: 512,
          context_window: 200_000,
        },
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 35,
      reasoningTokens: 7,
      lastReasoningTokens: 7,
      usedTokens: 512,
      lastUsedTokens: 512,
      maxTokens: 200_000,
      lastInputTokens: 120,
      lastOutputTokens: 35,
    });

    expect(
      normalizeCursorTokenUsage({
        update: {
          sessionUpdate: "usage_update",
          used: 4096,
          size: 200_000,
          input_tokens: 120,
          output_tokens: 35,
        },
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      usedTokens: 4096,
      lastUsedTokens: 4096,
      maxTokens: 200_000,
    });
  });
});
