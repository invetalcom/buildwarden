import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessAdapter, RunToolDefinition } from "@buildwarden/shared";
import { ORCHESTRATION_COORDINATOR_PROMPT, ORCHESTRATION_TOOL_DEFINITIONS } from "./orchestration-tools";

/**
 * Tool-use evals for the coordinator policy and the buildwarden_* tool descriptions. Each case
 * captures a situation where models made a real mistake. In CI the cases are checked against
 * the current wording: every recorded mistake must fail the scorer, and the guidance a case
 * relies on must still be in the policy or tool descriptions. With BUILDWARDEN_EVAL_MODELS set
 * (for example "anthropic:claude-sonnet-5-5,openai:gpt-5.6"), the same cases also run against
 * live models; see evals/orchestration-tool-use/README.md.
 */

type ToolCall = { name: string; arguments: Record<string, unknown> };
type ModelResponse = { toolCalls: ToolCall[]; text?: string; executedModel?: string };
interface EvalCase {
  id: string;
  title: string;
  mode: "code" | "ask" | "plan";
  messages: Array<
    | { role: "user"; content: string }
    | { role: "assistant"; content?: string; toolCalls?: Array<ToolCall & { id: string }> }
    | { role: "tool"; toolCallId: string; content: string }
  >;
  expect: {
    noToolCall?: boolean;
    firstToolCall?: { anyOf: string[] };
    forbiddenToolCalls?: string[];
    argumentsInclude?: Record<string, unknown>;
    argumentsExclude?: Record<string, unknown>;
    taskArgumentsInclude?: Record<string, unknown>;
    taskArgumentsExclude?: Record<string, unknown>;
  };
  policyMustMention: string[];
  recordedMistakes: Array<{ note: string; response: ModelResponse }>;
}

const CASES_DIR = join(__dirname, "..", "..", "..", "..", "evals", "orchestration-tool-use", "cases");
const cases: EvalCase[] = readdirSync(CASES_DIR).filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(CASES_DIR, name), "utf8")) as EvalCase);

/** A generic shell tool, so a model can make the "sleep in the shell" mistake. */
const SHELL_TOOL: RunToolDefinition = {
  name: "run_shell",
  description: "Run a shell command in the workspace.",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};
const EVAL_TOOLS = [...ORCHESTRATION_TOOL_DEFINITIONS, SHELL_TOOL];
const GUIDANCE = [ORCHESTRATION_COORDINATOR_PROMPT, ...ORCHESTRATION_TOOL_DEFINITIONS.map((tool) => tool.description)].join("\n");

const tasksOf = (call: ToolCall | undefined): Array<Record<string, unknown>> =>
  Array.isArray(call?.arguments.tasks) ? (call.arguments.tasks as Array<Record<string, unknown>>) : [];

/** Every reason a response breaks the case's expectations; empty when it passes. */
const scoreToolUseCase = (evalCase: EvalCase, response: ModelResponse): string[] => {
  const problems: string[] = [];
  const first = response.toolCalls[0];
  const { expect: expected } = evalCase;
  if (expected.noToolCall && response.toolCalls.length > 0) problems.push(`expected no tool call, got ${first!.name}`);
  if (expected.firstToolCall && !expected.firstToolCall.anyOf.includes(first?.name ?? "")) {
    problems.push(`first tool call ${first?.name ?? "(none)"} is not one of ${expected.firstToolCall.anyOf.join(", ")}`);
  }
  for (const call of response.toolCalls) {
    if (expected.forbiddenToolCalls?.includes(call.name)) problems.push(`called forbidden ${call.name}`);
  }
  for (const [key, value] of Object.entries(expected.argumentsInclude ?? {})) {
    if (JSON.stringify(first?.arguments[key]) !== JSON.stringify(value)) problems.push(`${key} should be ${JSON.stringify(value)}`);
  }
  for (const [key, value] of Object.entries(expected.argumentsExclude ?? {})) {
    if (JSON.stringify(first?.arguments[key]) === JSON.stringify(value)) problems.push(`${key} must not be ${JSON.stringify(value)}`);
  }
  for (const task of tasksOf(first)) {
    for (const [key, value] of Object.entries(expected.taskArgumentsInclude ?? {})) {
      if (JSON.stringify(task[key]) !== JSON.stringify(value)) problems.push(`task ${key} should be ${JSON.stringify(value)}`);
    }
    for (const [key, value] of Object.entries(expected.taskArgumentsExclude ?? {})) {
      if (JSON.stringify(task[key]) === JSON.stringify(value)) problems.push(`task ${key} must not be ${JSON.stringify(value)}`);
    }
  }
  return problems;
};

describe("orchestration tool-use eval cases", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  describe.each(cases)("$id", (evalCase) => {
    it("names only tools that exist", () => {
      const known = new Set(EVAL_TOOLS.map((tool) => tool.name));
      const named = [
        ...(evalCase.expect.firstToolCall?.anyOf ?? []),
        ...(evalCase.expect.forbiddenToolCalls ?? []),
        ...evalCase.messages.flatMap((message) => (message.role === "assistant" ? message.toolCalls ?? [] : []).map((call) => call.name)),
      ];
      for (const name of named) expect(known, name).toContain(name);
    });

    it("still finds the guidance it relies on in the policy and tool descriptions", () => {
      for (const phrase of evalCase.policyMustMention) expect(GUIDANCE, `${evalCase.id}: "${phrase}"`).toContain(phrase);
    });

    it("catches every recorded mistake", () => {
      expect(evalCase.recordedMistakes.length).toBeGreaterThan(0);
      for (const mistake of evalCase.recordedMistakes) {
        expect(scoreToolUseCase(evalCase, mistake.response), mistake.note).not.toEqual([]);
      }
    });
  });
});

// Live runs ----------------------------------------------------------------------------------

const MODEL_SPECS = (process.env.BUILDWARDEN_EVAL_MODELS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
/**
 * How many times each case runs. Anything but a positive whole number is refused before a
 * request is sent: `NaN` would skip every attempt and record a pass rate of `null`.
 */
const parseEvalRepeats = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return 1;
  const repeats = Number(raw);
  if (!Number.isSafeInteger(repeats) || repeats < 1) {
    throw new Error(`BUILDWARDEN_EVAL_REPEATS must be a positive whole number, not "${raw}".`);
  }
  return repeats;
};
const REPEATS = MODEL_SPECS.length > 0 ? parseEvalRepeats(process.env.BUILDWARDEN_EVAL_REPEATS) : 1;

describe("eval repeat count", () => {
  it("accepts a positive whole number and refuses anything else", () => {
    expect(parseEvalRepeats(undefined)).toBe(1);
    expect(parseEvalRepeats(" ")).toBe(1);
    expect(parseEvalRepeats("5")).toBe(5);
    for (const raw of ["five", "0", "-2", "2.5", "Infinity"]) {
      expect(() => parseEvalRepeats(raw), raw).toThrow("positive whole number");
    }
  });
});

const systemPrompt = (mode: EvalCase["mode"]) =>
  `${ORCHESTRATION_COORDINATOR_PROMPT}\n\nThis run is in ${mode} mode. You are a coding agent with these tools; act on the latest message.`;

const callAnthropic = async (model: string, evalCase: EvalCase): Promise<ModelResponse> => {
  const messages = evalCase.messages.map((message) => {
    if (message.role === "user") return { role: "user", content: message.content };
    if (message.role === "assistant") {
      return { role: "assistant", content: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
      ] };
    }
    return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
  });
  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 2_048, system: systemPrompt(evalCase.mode), messages,
      tools: EVAL_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
    }),
  });
  if (!response.ok) throw new Error(`Anthropic ${String(response.status)}: ${await response.text()}`);
  const body = await response.json() as { content: Array<{ type: string; name?: string; input?: Record<string, unknown>; text?: string }> };
  return {
    toolCalls: body.content.filter((block) => block.type === "tool_use").map((block) => ({ name: block.name ?? "", arguments: block.input ?? {} })),
    text: body.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
  };
};

const callOpenAiCompatible = async (model: string, evalCase: EvalCase): Promise<ModelResponse> => {
  const messages = [
    { role: "system", content: systemPrompt(evalCase.mode) },
    ...evalCase.messages.map((message) => {
      if (message.role === "user") return { role: "user", content: message.content };
      if (message.role === "assistant") {
        return { role: "assistant", content: message.content ?? null, tool_calls: (message.toolCalls ?? []).map((call) => ({
          id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) };
      }
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }),
  ];
  const response = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
    body: JSON.stringify({
      model, messages,
      tools: EVAL_TOOLS.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    }),
  });
  if (!response.ok) throw new Error(`OpenAI-compatible ${String(response.status)}: ${await response.text()}`);
  const body = await response.json() as { choices: Array<{ message: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> } }> };
  const message = body.choices[0]?.message;
  return {
    toolCalls: (message?.tool_calls ?? []).map((call) => ({ name: call.function.name, arguments: JSON.parse(call.function.arguments || "{}") as Record<string, unknown> })),
    text: message?.content ?? "",
  };
};

/** Exercises the real managed CLI transport using the user's existing login, in an empty workspace. */
const callNativeHarness = async (vendor: "claude-cli" | "codex-cli", model: string, evalCase: EvalCase, adapter?: HarnessAdapter): Promise<ModelResponse> => {
  const workspace = mkdtempSync(join(tmpdir(), "buildwarden-tool-eval-"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Live eval timed out")), 90_000);
  const toolCalls: ToolCall[] = [];
  const recordedCalls = new Set<string>();
  const recordCall = (call: ToolCall, id?: string) => {
    if (id && recordedCalls.has(id)) return;
    if (id) recordedCalls.add(id);
    toolCalls.push(call);
  };
  const output = new Map<string, string>();
  const errors: string[] = [];
  let executedModel: string | undefined;
  try {
    const harness = adapter ?? (vendor === "claude-cli"
      ? new (await import("@buildwarden/provider-claude-code")).ClaudeCodeHarnessAdapter(async () => "deny")
      : new (await import("@buildwarden/provider-codex-cli")).CodexCliHarnessAdapter(async () => "deny"));
    await harness.run({
      runId: "tool-use-eval", worktreePath: workspace, mode: "ask", apiKey: "",
      providerType: vendor === "claude-cli" ? "claude-code" : "codex-cli", modelId: model === "default" ? "" : model,
      instructions: systemPrompt(evalCase.mode),
      prompt: "Continue the following evaluation transcript. Make the appropriate first tool call, or end your turn if none is needed. Do not inspect files or execute commands.\n" + JSON.stringify(evalCase.messages),
    }, {
      tools: EVAL_TOOLS,
      executeTool: async (call) => {
        recordCall({ name: call.name, arguments: call.arguments }, call.id);
        controller.abort();
        return { toolCallId: call.id, name: call.name, ok: true, content: "Evaluation stopped after the first tool call." };
      },
    }, (chunk) => {
      // Native commands bypass executeTool, including attempts denied by the approval handler.
      if (chunk.type === "tool-call" && chunk.metadata?.toolName === "run_shell") {
        recordCall({ name: "run_shell", arguments: { command: chunk.metadata.command ?? chunk.value } },
          typeof chunk.metadata.callId === "string" ? chunk.metadata.callId : undefined);
      }
      if (chunk.type === "message") output.set(typeof chunk.metadata?.streamId === "string" ? chunk.metadata.streamId : String(output.size), chunk.value);
      if (chunk.type === "error") errors.push(chunk.value);
      if (typeof chunk.metadata?.executedModel === "string") executedModel = chunk.metadata.executedModel;
    }, controller.signal);
    if (controller.signal.aborted && toolCalls.length === 0) throw new Error("Live eval timed out without a response");
    if (errors.length > 0 && toolCalls.length === 0) throw new Error(errors.join("\n"));
    return { toolCalls, text: [...output.values()].join("\n"), executedModel };
  } catch (error) {
    if (toolCalls.length > 0) return { toolCalls, text: [...output.values()].join("\n"), executedModel };
    throw error;
  } finally {
    clearTimeout(timeout);
    rmSync(workspace, { recursive: true, force: true });
  }
};

describe("native eval response collection", () => {
  it("scores a denied native shell attempt even when executeTool is never reached", async () => {
    const adapter: HarnessAdapter = {
      harnessType: "codex-app-server",
      async run(_input, _context, onChunk) {
        onChunk({ type: "tool-call", title: "Shell", value: "sleep 5", metadata: { toolName: "run_shell", command: "sleep 5", callId: "shell-1" } });
        onChunk({ type: "tool-result", title: "Shell", value: "Denied", metadata: { toolName: "run_shell", callId: "shell-1" } });
        return { summary: "No commands executed", responseId: null, usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const evalCase: EvalCase = { ...cases[0]!, expect: { noToolCall: true, forbiddenToolCalls: ["run_shell"] } };
    const response = await callNativeHarness("codex-cli", "test", evalCase, adapter);
    expect(response.toolCalls).toEqual([{ name: "run_shell", arguments: { command: "sleep 5" } }]);
    expect(scoreToolUseCase(evalCase, response)).toEqual(["expected no tool call, got run_shell", "called forbidden run_shell"]);
  });
});

/**
 * Saved pass rates per model, so a live run fails on a regression instead of on every case a
 * model has always found hard. `BUILDWARDEN_EVAL_RECORD_BASELINE=1` writes the rates it measured.
 */
const BASELINE_DIR = join(__dirname, "..", "..", "..", "..", "evals", "orchestration-tool-use", "baselines");
const RECORD_BASELINE = process.env.BUILDWARDEN_EVAL_RECORD_BASELINE === "1";

interface EvalBaseline {
  model: string;
  recordedAt: string;
  repeats: number;
  /** Case id → share of attempts that passed. */
  cases: Record<string, number>;
  /** Synthetic eval conversations only; never production run transcripts. */
  responses?: Record<string, ModelResponse[]>;
  policyHash?: string;
}

/**
 * A readable name plus a hash of the exact spec, so specs that differ only in characters the
 * name drops (`org/model` and `org_model`) never share a file.
 */
const baselineFileName = (spec: string): string =>
  `${spec.replace(/[^a-zA-Z0-9._-]+/g, "_")}-${createHash("sha256").update(spec).digest("hex").slice(0, 10)}.json`;

const readBaseline = (spec: string): EvalBaseline | null => {
  const path = join(BASELINE_DIR, baselineFileName(spec));
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8")) as EvalBaseline;
  if (record.model !== spec) throw new Error(`Baseline ${path} was recorded for ${record.model}, not ${spec}.`);
  return record;
};

describe.skipIf(MODEL_SPECS.length === 0)("live orchestration tool use", () => {
  describe.each(MODEL_SPECS)("%s", (spec) => {
    const [vendor, ...rest] = spec.split(":");
    const model = rest.join(":");
    const baseline = RECORD_BASELINE ? null : readBaseline(spec);
    const measured: Record<string, number> = {};
    const responses: Record<string, ModelResponse[]> = {};
    afterAll(() => {
      if (!RECORD_BASELINE) return;
      // A run where a case never finished (an API error, a timeout) would replace a complete
      // baseline with a partial one, so only a run that measured every case is written.
      const missing = cases.filter((evalCase) => measured[evalCase.id] === undefined).map((evalCase) => evalCase.id);
      if (missing.length > 0) {
        console.warn(`Not recording the ${spec} baseline: no result for ${missing.join(", ")}.`);
        return;
      }
      mkdirSync(BASELINE_DIR, { recursive: true });
      const record: EvalBaseline = { model: spec, recordedAt: new Date().toISOString(), repeats: REPEATS, cases: measured,
        responses, policyHash: createHash("sha256").update(GUIDANCE).digest("hex") };
      writeFileSync(join(BASELINE_DIR, baselineFileName(spec)), `${JSON.stringify(record, null, 2)}\n`);
    });
    it.each(cases)("$id", async (evalCase) => {
      const failures: string[] = [];
      for (let attempt = 0; attempt < REPEATS; attempt += 1) {
        const response = vendor === "claude-cli" || vendor === "codex-cli" ? await callNativeHarness(vendor, model, evalCase)
          : vendor === "anthropic" ? await callAnthropic(model, evalCase) : await callOpenAiCompatible(model, evalCase);
        (responses[evalCase.id] ??= []).push(response);
        const problems = scoreToolUseCase(evalCase, response);
        if (problems.length > 0) failures.push(`attempt ${String(attempt + 1)}: ${problems.join("; ")}`);
      }
      const passRate = (REPEATS - failures.length) / REPEATS;
      measured[evalCase.id] = passRate;
      if (RECORD_BASELINE) return;
      const expected = baseline?.cases[evalCase.id];
      if (expected === undefined) {
        expect(failures, `${spec} ${evalCase.id}`).toEqual([]);
        return;
      }
      // Only a drop below the recorded rate is a regression.
      expect(passRate, `${spec} ${evalCase.id} fell below its baseline of ${String(expected)}: ${failures.join(" | ")}`)
        .toBeGreaterThanOrEqual(expected);
    }, 120_000);
  });
});
