import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunToolDefinition } from "@buildwarden/shared";
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
type ModelResponse = { toolCalls: ToolCall[]; text?: string };
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
const REPEATS = Math.max(1, Number(process.env.BUILDWARDEN_EVAL_REPEATS ?? 1));

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

describe.skipIf(MODEL_SPECS.length === 0)("live orchestration tool use", () => {
  describe.each(MODEL_SPECS)("%s", (spec) => {
    const [vendor, ...rest] = spec.split(":");
    const model = rest.join(":");
    it.each(cases)("$id", async (evalCase) => {
      const failures: string[] = [];
      for (let attempt = 0; attempt < REPEATS; attempt += 1) {
        const response = vendor === "anthropic" ? await callAnthropic(model, evalCase) : await callOpenAiCompatible(model, evalCase);
        const problems = scoreToolUseCase(evalCase, response);
        if (problems.length > 0) failures.push(`attempt ${String(attempt + 1)}: ${problems.join("; ")}`);
      }
      expect(failures, `${spec} ${evalCase.id}`).toEqual([]);
    }, 120_000);
  });
});
