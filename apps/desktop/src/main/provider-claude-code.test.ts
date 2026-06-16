import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeArgs,
  buildClaudeCanUseTool,
  ClaudeCodeProviderAdapter,
  getClaudeCodeAvailableModelsForVersion,
  mergeClaudeUsageUpdate,
  normalizeClaudeCodeModelId,
  parseClaudeCodeVersion,
  parseClaudeCodeStreamEvent,
  resolveClaudeCodeProcessLaunch,
} from "../../../../packages/provider-claude-code/src";

describe("ClaudeCodeProviderAdapter", () => {
  it("rejects blank binary path overrides", () => {
    const adapter = new ClaudeCodeProviderAdapter();

    expect(() =>
      adapter.validateConfiguration({
        providerType: "claude-code",
        label: "Claude Code",
        apiKey: "",
        config: {
          claudeBinaryPath: "   ",
        },
      }),
    ).toThrowError("Claude binary path cannot be blank when provided.");
  });

  it("accepts local CLI settings without an API key", () => {
    const adapter = new ClaudeCodeProviderAdapter();

    expect(() =>
      adapter.validateConfiguration({
        providerType: "claude-code",
        label: "Claude Code",
        apiKey: "",
        config: {
          claudeBinaryPath: "claude",
          claudeLaunchArgs: "--add-dir C:\\work\\shared",
        },
      }),
    ).not.toThrow();
  });

  it("launches Windows exe paths with spaces without routing them through cmd", () => {
    const binaryPath = "C:\\Program Files\\WindowsApps\\Claude_1.4758.0.0_x64__pzs8sxrjxfjjc\\app\\claude.exe";
    const launch = resolveClaudeCodeProcessLaunch(binaryPath, ["--version"]);

    if (process.platform === "win32") {
      expect(launch).toEqual({ command: binaryPath, args: ["--version"] });
    } else {
      expect(launch.command).toBe(binaryPath);
    }
  });

  it("routes Windows command shims through cmd with the full command quoted", () => {
    const binaryPath = "C:\\Program Files\\nodejs\\claude.cmd";
    const launch = resolveClaudeCodeProcessLaunch(binaryPath, ["--model", "claude-sonnet-4-5"]);

    if (process.platform === "win32") {
      expect(launch.command.toLowerCase()).toContain("cmd");
      expect(launch.args.at(-1)).toBe('"C:\\Program Files\\nodejs\\claude.cmd" "--model" "claude-sonnet-4-5"');
    } else {
      expect(launch.command).toBe(binaryPath);
    }
  });

  it("leaves bare Windows PATH commands unquoted when routing through cmd", () => {
    const launch = resolveClaudeCodeProcessLaunch("claude", ["--version"]);

    if (process.platform === "win32") {
      expect(launch.command.toLowerCase()).toContain("cmd");
      expect(launch.args.at(-1)).toBe('claude "--version"');
    } else {
      expect(launch).toEqual({ command: "claude", args: ["--version"] });
    }
  });

  it("maps old BuildWarden Claude model ids to current Claude Code model ids", () => {
    expect(normalizeClaudeCodeModelId("claude-sonnet-4.5")).toBe("claude-sonnet-4-6");
    expect(normalizeClaudeCodeModelId("claude-haiku-4.5")).toBe("claude-haiku-4-5");
    expect(normalizeClaudeCodeModelId("claude-opus-4-1")).toBe("claude-opus-4-7");
    expect(normalizeClaudeCodeModelId("sonnet")).toBe("sonnet");
  });

  it("parses Claude Code versions from CLI output", () => {
    expect(parseClaudeCodeVersion("Claude Code 2.1.111")).toBe("2.1.111");
    expect(parseClaudeCodeVersion("claude 2.2.0\n")).toBe("2.2.0");
    expect(parseClaudeCodeVersion("unknown")).toBeNull();
  });

  it("marks curated Claude models unavailable below known minimum CLI versions", () => {
    const olderModels = getClaudeCodeAvailableModelsForVersion("2.1.110");
    const opus47Models = getClaudeCodeAvailableModelsForVersion("2.1.111");
    const opus48Models = getClaudeCodeAvailableModelsForVersion("2.1.154");

    expect(olderModels.find((model) => model.modelId === "claude-opus-4-7")?.unavailableReason).toContain("v2.1.111");
    expect(opus47Models.find((model) => model.modelId === "claude-opus-4-7")?.unavailableReason).toBeUndefined();
    expect(opus47Models.find((model) => model.modelId === "claude-opus-4-8")?.unavailableReason).toContain("v2.1.154");
    expect(opus48Models.find((model) => model.modelId === "claude-opus-4-8")?.unavailableReason).toBeUndefined();
    expect(opus48Models.map((model) => model.modelId)).toContain("sonnet");
  });

  it("keeps the full curated Claude list when the version cannot be parsed", () => {
    const ids = getClaudeCodeAvailableModelsForVersion(null).map((model) => model.modelId);

    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).toContain("claude-haiku-4-5");
  });

  it("adds Claude resume arguments when a durable session id is available", () => {
    expect(
      buildClaudeCodeArgs({
        modelId: "sonnet",
        inputMode: "code",
        previousSessionId: "11111111-1111-4111-8111-111111111111",
        launchArgs: ["--add-dir", "C:\\work\\shared"],
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--effort",
      "medium",
      "--permission-mode",
      "acceptEdits",
      "--resume",
      "11111111-1111-4111-8111-111111111111",
      "--add-dir",
      "C:\\work\\shared",
    ]);
  });

  it("passes Claude Code bypass permissions flags when YOLO mode is enabled", () => {
    expect(
      buildClaudeCodeArgs({
        modelId: "sonnet",
        inputMode: "plan",
        yoloMode: true,
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--effort",
      "medium",
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-skip-permissions",
    ]);
  });

  it("returns Claude session permission updates for run-level shell approvals", async () => {
    const canUseTool = buildClaudeCanUseTool({
      runId: "run-1",
      cwd: "C:\\repo",
      prompt: "test",
      modelId: "sonnet",
      inputMode: "code",
      signal: new AbortController().signal,
      requestShellApproval: async () => "allow-for-run",
    });
    const suggestions = [
      {
        type: "addRules" as const,
        rules: [{ toolName: "Bash", ruleContent: "npm test" }],
        behavior: "allow" as const,
        destination: "session" as const,
      },
    ];

    await expect(
      canUseTool("Bash", { command: "npm test" }, { signal: new AbortController().signal, suggestions, toolUseID: "tool-1" }),
    ).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "npm test" },
      updatedPermissions: suggestions,
    });
  });

  it("returns Claude session permission updates for code-mode file edits", async () => {
    const canUseTool = buildClaudeCanUseTool({
      runId: "run-1",
      cwd: "C:\\repo",
      prompt: "test",
      modelId: "sonnet",
      inputMode: "code",
      signal: new AbortController().signal,
    });
    const suggestions = [
      {
        type: "addRules" as const,
        rules: [{ toolName: "Write", ruleContent: "src/App.tsx" }],
        behavior: "allow" as const,
        destination: "session" as const,
      },
    ];

    await expect(
      canUseTool("Write", { file_path: "src/App.tsx" }, { signal: new AbortController().signal, suggestions, toolUseID: "tool-1" }),
    ).resolves.toEqual({
      behavior: "allow",
      updatedInput: { file_path: "src/App.tsx" },
      updatedPermissions: suggestions,
    });
  });

  it("emits a canonical user-input event for Claude user questions", async () => {
    const chunks: unknown[] = [];
    const canUseTool = buildClaudeCanUseTool({
      runId: "run-1",
      cwd: "C:\\repo",
      prompt: "test",
      modelId: "sonnet",
      inputMode: "ask",
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
    });

    await expect(
      canUseTool("AskUserQuestion", { question: "Which API should I use?" }, { signal: new AbortController().signal, toolUseID: "tool-1" }),
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(chunks).toEqual([
      {
        type: "user-input-requested",
        title: "Claude question",
        value: "Which API should I use?",
        metadata: expect.objectContaining({
          provider: "claude-code",
          requestKind: "user-input",
          requestStatus: "opened",
          toolName: "AskUserQuestion",
          callId: "tool-1",
        }),
      },
    ]);
  });

  it("routes Claude structured user questions through BuildWarden user input", async () => {
    const requests: unknown[] = [];
    const canUseTool = buildClaudeCanUseTool({
      runId: "run-1",
      cwd: "C:\\repo",
      prompt: "test",
      modelId: "sonnet",
      inputMode: "plan",
      signal: new AbortController().signal,
      requestUserInput: async (request) => {
        requests.push(request);
        return { "Which framework?": "React" };
      },
    });
    const input = {
      questions: [
        {
          header: "Framework",
          question: "Which framework?",
          options: [
            { label: "React", description: "Use React" },
            { label: "Vue", description: "Use Vue" },
          ],
        },
      ],
    };

    await expect(
      canUseTool("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "tool-ask-1" }),
    ).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { "Which framework?": "React" },
      },
    });
    expect(requests).toEqual([
      expect.objectContaining({
        requestId: "tool-ask-1",
        title: "Claude question",
        questions: [
          {
            id: "Which framework?",
            header: "Framework",
            question: "Which framework?",
            options: [
              { label: "React", description: "Use React" },
              { label: "Vue", description: "Use Vue" },
            ],
            multiSelect: false,
            allowCustomAnswer: false,
          },
        ],
      }),
    ]);
  });

  it("emits a canonical plan update event for Claude plan proposals", async () => {
    const chunks: unknown[] = [];
    const canUseTool = buildClaudeCanUseTool({
      runId: "run-1",
      cwd: "C:\\repo",
      prompt: "test",
      modelId: "sonnet",
      inputMode: "plan",
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
    });

    await expect(
      canUseTool("ExitPlanMode", { plan: "1. Inspect files\n2. Patch component" }, { signal: new AbortController().signal, toolUseID: "tool-1" }),
    ).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(chunks).toEqual([
      {
        type: "plan-updated",
        title: "Proposed plan",
        value: "1. Inspect files\n2. Patch component",
        metadata: expect.objectContaining({
          provider: "claude-code",
          planKind: "proposal",
          toolName: "ExitPlanMode",
          callId: "tool-1",
        }),
      },
    ]);
  });

  it("allows Claude TodoWrite and emits plan progress", async () => {
    const chunks: unknown[] = [];
    const canUseTool = buildClaudeCanUseTool({
      runId: "run-1",
      cwd: "C:\\repo",
      prompt: "test",
      modelId: "sonnet",
      inputMode: "plan",
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
    });

    await expect(
      canUseTool(
        "TodoWrite",
        {
          todos: [
            { content: "Inspect contracts", status: "completed" },
            { content: "Patch header", status: "in_progress" },
            { content: "Run validation", status: "pending" },
          ],
        },
        { signal: new AbortController().signal, toolUseID: "todo-1" },
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(chunks).toEqual([
      {
        type: "plan-progress",
        title: "Plan progress",
        value: "1. [x] Inspect contracts\n2. [-] Patch header\n3. [ ] Run validation",
        metadata: expect.objectContaining({
          provider: "claude-code",
          toolName: "TodoWrite",
          callId: "todo-1",
          streamId: "claude-plan-progress",
          replace: true,
          planProgress: {
            source: "claude",
            steps: [
              { title: "Inspect contracts", status: "completed" },
              { title: "Patch header", status: "inProgress" },
              { title: "Run validation", status: "pending" },
            ],
          },
        }),
      },
    ]);
  });

  it("parses Claude Code assistant text and tool use as separate timeline chunks", () => {
    const parsed = parseClaudeCodeStreamEvent({
      type: "assistant",
      session_id: "session-1",
      message: {
        content: [
          { type: "text", text: "I'll inspect the file." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/App.tsx" } },
        ],
      },
    });

    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.assistantText).toBe("I'll inspect the file.");
    expect(parsed.chunks).toEqual([
      {
        type: "tool-call",
        title: "Tool call: read_file",
        value: "src/App.tsx",
        metadata: { toolName: "read_file", callId: "tool-1", rawToolName: "Read", provider: "claude-code", path: "src/App.tsx" },
      },
      {
        type: "message",
        title: "Agent output",
        value: "I'll inspect the file.",
        metadata: { assistantKind: "assistant" },
      },
    ]);
  });

  it("parses Claude TodoWrite tool use as plan progress", () => {
    const parsed = parseClaudeCodeStreamEvent({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "   ", status: "in_progress" },
                { content: "Ship it", status: "completed" },
              ],
            },
          },
        ],
      },
    });

    expect(parsed.chunks).toEqual([
      {
        type: "plan-progress",
        title: "Plan progress",
        value: "1. [-] Step 1\n2. [x] Ship it",
        metadata: {
          provider: "claude-code",
          toolName: "TodoWrite",
          rawToolName: "TodoWrite",
          callId: "todo-1",
          rawToolInput: {
            todos: [
              { content: "   ", status: "in_progress" },
              { content: "Ship it", status: "completed" },
            ],
          },
          planProgress: {
            source: "claude",
            steps: [
              { title: "Step 1", status: "inProgress" },
              { title: "Ship it", status: "completed" },
            ],
          },
          streamId: "claude-plan-progress",
          replace: true,
        },
      },
    ]);
  });

  it("caps Claude TodoWrite plan progress to the shared step limit", () => {
    const parsed = parseClaudeCodeStreamEvent({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "todo-1",
            name: "TodoWrite",
            input: {
              todos: Array.from({ length: 30 }, (_, index) => ({
                content: `Step ${String(index + 1)}`,
                status: "pending",
              })),
            },
          },
        ],
      },
    });

    expect(parsed.chunks).toHaveLength(1);
    const metadata = parsed.chunks[0]?.metadata as { planProgress?: { steps?: unknown[] } } | undefined;
    expect(metadata?.planProgress?.steps).toHaveLength(24);
  });

  it("parses Claude Code reasoning and tool results as distinct chunks", () => {
    const reasoning = parseClaudeCodeStreamEvent({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "Need to compare both components." }],
      },
    });
    const toolResult = parseClaudeCodeStreamEvent({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents" }],
      },
    });

    expect(reasoning.chunks).toEqual([
      {
        type: "message",
        title: "Reasoning",
        value: "Need to compare both components.",
        metadata: { assistantKind: "reasoning" },
      },
    ]);
    expect(toolResult.chunks).toEqual([
      {
        type: "tool-result",
        title: "Tool result",
        value: "file contents",
        metadata: { callId: "tool-1", ok: true, provider: "claude-code" },
      },
    ]);
  });

  it("counts Claude cache read and creation tokens in total input usage", () => {
    const parsed = parseClaudeCodeStreamEvent({
      type: "result",
      session_id: "session-1",
      result: "done",
      usage: {
        input_tokens: 40_000,
        output_tokens: 2_000,
        cache_read_input_tokens: 450_000,
        cache_creation_input_tokens: 10_000,
      },
    });

    expect(parsed.usage).toEqual({
      inputTokens: 500_000,
      outputTokens: 2_000,
      cachedInputTokens: 450_000,
      cacheCreationInputTokens: 10_000,
      totalTokens: 502_000,
      usedTokens: 502_000,
      totalProcessedTokens: 502_000,
      lastUsedTokens: 502_000,
      lastInputTokens: 500_000,
      lastCachedInputTokens: 450_000,
      lastOutputTokens: 2_000,
    });
  });

  it("parses Claude assistant message usage as a delta for mid-run updates", () => {
    const parsed = parseClaudeCodeStreamEvent({
      type: "assistant",
      session_id: "session-1",
      message: {
        id: "msg-usage-1",
        content: [{ type: "text", text: "I'll inspect the project." }],
        usage: {
          input_tokens: 1_200,
          output_tokens: 80,
          cache_read_input_tokens: 2_000,
        },
      },
    });

    expect(parsed.usageIsDelta).toBe(true);
    expect(parsed.usageKey).toBe("message:msg-usage-1");
    expect(parsed.usage).toEqual({
      inputTokens: 3_200,
      outputTokens: 80,
      cachedInputTokens: 2_000,
      totalTokens: 3_280,
    });
  });

  it("does not count repeated Claude assistant usage snapshots twice", () => {
    const first = parseClaudeCodeStreamEvent({
      type: "assistant",
      session_id: "session-1",
      requestId: "req-1",
      message: {
        id: "msg-usage-1",
        content: [{ type: "thinking", thinking: "Looking around." }],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 90,
        },
      },
    });
    const repeatedSnapshot = parseClaudeCodeStreamEvent({
      type: "assistant",
      session_id: "session-1",
      requestId: "req-1",
      message: {
        id: "msg-usage-1",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 90,
        },
      },
    });

    const counted = new Map();
    const initial = { inputTokens: 0, outputTokens: 0 };
    const afterFirst = mergeClaudeUsageUpdate(initial, counted, first);
    const afterRepeated = mergeClaudeUsageUpdate(afterFirst.usage, counted, repeatedSnapshot);

    expect(afterFirst.changed).toBe(true);
    expect(afterRepeated.changed).toBe(false);
    expect(afterRepeated.usage).toEqual({
      inputTokens: 100,
      outputTokens: 4,
      cachedInputTokens: 90,
      totalTokens: 104,
      totalProcessedTokens: 104,
    });
  });

  it("adds only the positive difference when a repeated Claude usage snapshot grows", () => {
    const first = parseClaudeCodeStreamEvent({
      type: "assistant",
      requestId: "req-1",
      message: {
        id: "msg-usage-1",
        content: [{ type: "text", text: "Partial." }],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 90,
        },
      },
    });
    const updated = parseClaudeCodeStreamEvent({
      type: "assistant",
      requestId: "req-1",
      message: {
        id: "msg-usage-1",
        content: [{ type: "text", text: "Complete." }],
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 5,
        },
      },
    });

    const counted = new Map();
    const afterFirst = mergeClaudeUsageUpdate({ inputTokens: 0, outputTokens: 0 }, counted, first);
    const afterUpdated = mergeClaudeUsageUpdate(afterFirst.usage, counted, updated);

    expect(afterUpdated.changed).toBe(true);
    expect(afterUpdated.usage).toEqual({
      inputTokens: 107,
      outputTokens: 7,
      cachedInputTokens: 90,
      cacheCreationInputTokens: 5,
      totalTokens: 114,
      totalProcessedTokens: 114,
    });
  });

  it("prefers aggregate Claude modelUsage over final-message usage", () => {
    const parsed = parseClaudeCodeStreamEvent({
      type: "result",
      session_id: "session-1",
      result: "done",
      usage: {
        input_tokens: 5_000,
        output_tokens: 500,
      },
      modelUsage: {
        sonnet: {
          inputTokens: 40_000,
          outputTokens: 2_000,
          cacheReadInputTokens: 450_000,
          cacheCreationInputTokens: 10_000,
        },
      },
    });

    expect(parsed.usage).toEqual({
      inputTokens: 500_000,
      outputTokens: 2_000,
      cachedInputTokens: 450_000,
      cacheCreationInputTokens: 10_000,
      totalTokens: 502_000,
      usedTokens: 502_000,
      totalProcessedTokens: 502_000,
      lastUsedTokens: 502_000,
      lastInputTokens: 500_000,
      lastCachedInputTokens: 450_000,
      lastOutputTokens: 2_000,
    });
  });

  it("preserves Claude task-progress context usage when final usage is accumulated", () => {
    const progress = parseClaudeCodeStreamEvent({
      type: "task_progress",
      usage: {
        input_tokens: 185_000,
        output_tokens: 5_000,
      },
      modelUsage: {
        sonnet: {
          contextWindow: 200_000,
        },
      },
    });
    const final = parseClaudeCodeStreamEvent({
      type: "result",
      result: "done",
      usage: {
        input_tokens: 530_000,
        output_tokens: 5_000,
      },
      modelUsage: {
        sonnet: {
          contextWindow: 200_000,
        },
      },
    });

    const counted = new Map();
    const afterProgress = mergeClaudeUsageUpdate({ inputTokens: 0, outputTokens: 0 }, counted, progress);
    const afterFinal = mergeClaudeUsageUpdate(afterProgress.usage, counted, final);

    expect(progress.usageIsContextSnapshot).toBe(true);
    expect(afterFinal.usage.usedTokens).toBe(190_000);
    expect(afterFinal.usage.maxTokens).toBe(200_000);
    expect(afterFinal.usage.inputTokens).toBe(530_000);
    expect(afterFinal.usage.outputTokens).toBe(5_000);
    expect(afterFinal.usage.totalProcessedTokens).toBe(535_000);
  });
});
