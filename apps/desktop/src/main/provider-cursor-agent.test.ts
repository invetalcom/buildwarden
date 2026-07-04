import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CursorAgentProviderAdapter,
  assertCursorAgentAvailable,
  buildCursorPlanProgressChunk,
  createCursorDevLogger,
  deriveCursorMaxTokensFromConfigOptions,
  extractCursorTodosAsPlanProgress,
  getCursorAgentBinaryPath,
  getCursorAgentBinaryPathCandidates,
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

  it("rejects blank Cursor API endpoint overrides", () => {
    const adapter = new CursorAgentProviderAdapter();

    expect(() =>
      adapter.validateConfiguration({
        providerType: "cursor-agent",
        label: "Cursor Agent",
        apiKey: "",
        config: {
          cursorApiEndpoint: "   ",
        },
      }),
    ).toThrow("Cursor API endpoint cannot be blank");
  });

  it("allows configuration with no config object at all", () => {
    const adapter = new CursorAgentProviderAdapter();

    expect(() =>
      adapter.validateConfiguration({
        providerType: "cursor-agent",
        label: "Cursor Agent",
        apiKey: "",
      }),
    ).not.toThrow();
  });

  it("lists the Cursor Auto preset as the recommended fallback model", () => {
    const adapter = new CursorAgentProviderAdapter();

    expect(adapter.listRecommendedModels()).toEqual(["default"]);
  });

  it("wraps Windows command shims through cmd while preserving explicit exe paths", () => {
    const shim = resolveCursorAgentProcessLaunch("agent", ["acp"]);

    if (process.platform === "win32") {
      expect(shim).toEqual({
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/c", 'call agent "acp"'],
        windowsVerbatimArguments: true,
      });
      expect(resolveCursorAgentProcessLaunch("C:\\Users\\test\\AppData\\Local\\cursor-agent\\agent.cmd", ["about"])).toEqual({
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/c", 'call "C:\\Users\\test\\AppData\\Local\\cursor-agent\\agent.cmd" "about"'],
        windowsVerbatimArguments: true,
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

  it("launches a full Windows command-shim path without quoting it as a literal command", () => {
    if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
      return;
    }
    const binaryPath = join(process.env.LOCALAPPDATA, "cursor-agent", "agent.cmd");
    if (!existsSync(binaryPath)) {
      return;
    }

    const launch = resolveCursorAgentProcessLaunch(binaryPath, ["about"]);
    const result = spawnSync(launch.command, launch.args, {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("ist entweder falsch geschrieben");
    expect(result.stdout).toContain("Cursor CLI");
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

  it("returns no models when the response is missing a models array", () => {
    expect(parseCursorAvailableModelsResponse({})).toEqual([]);
    expect(parseCursorAvailableModelsResponse({ models: "not-an-array" })).toEqual([]);
    expect(parseCursorAvailableModelsResponse(null)).toEqual([]);
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

  it("returns undefined when no context window config option is present", () => {
    expect(deriveCursorMaxTokensFromConfigOptions(undefined)).toBeUndefined();
    expect(deriveCursorMaxTokensFromConfigOptions([])).toBeUndefined();
    expect(
      deriveCursorMaxTokensFromConfigOptions([
        { id: "reasoning", name: "Reasoning", category: "model_config", type: "select" },
      ]),
    ).toBeUndefined();
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

  it("passes through answers unchanged when no answer map exists for a question", () => {
    expect(
      mapCursorUserInputAnswers(
        { unmapped: "raw-value", list: ["a", "b"] },
        { language: { TypeScript: "ts" } },
      ),
    ).toEqual({ unmapped: "raw-value", list: ["a", "b"] });
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

  it("defaults an unset or blank model id to the Cursor default model", () => {
    expect(resolveCursorAcpBaseModelId(undefined)).toBe("default");
    expect(resolveCursorAcpBaseModelId(null)).toBe("default");
    expect(resolveCursorAcpBaseModelId("   ")).toBe("default");
    expect(resolveCursorAcpBaseModelId("plain-model")).toBe("plain-model");
  });

  it("returns no config updates when no reasoning effort is requested or no matching option exists", () => {
    expect(resolveCursorAcpConfigUpdates(undefined, undefined)).toEqual([]);
    expect(resolveCursorAcpConfigUpdates([], { reasoningEffort: "high" })).toEqual([]);
    expect(
      resolveCursorAcpConfigUpdates(
        [{ id: "context", name: "Context Window", category: "model_config", type: "select" }],
        { reasoningEffort: "high" },
      ),
    ).toEqual([]);
    expect(
      resolveCursorAcpConfigUpdates(
        [
          {
            id: "reasoning",
            name: "Reasoning",
            category: "model_config",
            type: "select",
            options: [{ value: "low", name: "Low" }],
          },
        ],
        { reasoningEffort: "nonexistent" },
      ),
    ).toEqual([]);
  });

  it("returns null when there are no todos to map", () => {
    expect(extractCursorTodosAsPlanProgress(null)).toBeNull();
    expect(extractCursorTodosAsPlanProgress({})).toBeNull();
    expect(extractCursorTodosAsPlanProgress({ todos: [] })).toBeNull();
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

  it("returns null when the payload has no recognizable usage fields", () => {
    expect(normalizeCursorTokenUsage(null)).toBeNull();
    expect(normalizeCursorTokenUsage("not-an-object")).toBeNull();
    expect(normalizeCursorTokenUsage({ unrelated: true })).toBeNull();
  });

  it("recurses into a nested update payload to find usage fields", () => {
    expect(
      normalizeCursorTokenUsage({
        update: {
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      }),
    ).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      lastInputTokens: 10,
      lastOutputTokens: 4,
    });
  });

  it("resolves the configured Cursor binary path over auto-detected candidates", () => {
    expect(getCursorAgentBinaryPath({ cursorBinaryPath: "/custom/path/to/agent" })).toBe("/custom/path/to/agent");
    expect(typeof getCursorAgentBinaryPath(undefined)).toBe("string");
    expect(getCursorAgentBinaryPath(undefined).length).toBeGreaterThan(0);
  });

  it("derives Cursor binary path candidates from the home directory or environment", () => {
    if (process.platform === "win32") {
      const env = { APPDATA: "C:\\Users\\test\\AppData\\Roaming", USERPROFILE: "C:\\Users\\test" } as NodeJS.ProcessEnv;
      const candidates = getCursorAgentBinaryPathCandidates(env);
      expect(candidates).toContain(join("C:\\Users\\test\\AppData\\Roaming", "npm", "agent.exe"));
      expect(candidates).toContain(join("C:\\Users\\test\\AppData\\Roaming", "npm", "cursor-agent.cmd"));
    } else {
      expect(getCursorAgentBinaryPathCandidates()).toEqual([
        join(homedir(), ".local", "bin", "agent"),
        join(homedir(), ".local", "bin", "cursor-agent"),
      ]);
    }
  });

  it("rejects when the configured Cursor binary cannot be found or executed", async () => {
    await expect(
      assertCursorAgentAvailable({ cursorBinaryPath: "buildwarden-nonexistent-cursor-agent-binary" }),
    ).rejects.toThrow(/Cursor Agent CLI was not found or is not available/);
  });
});
