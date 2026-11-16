# Orchestration tool-use evals

These cases check how coordinator models use the `buildwarden_*` tools. Each case is a short
transcript ending at the point where models have made a real mistake. Examples of such mistakes:

- polling instead of yielding;
- messaging a blocked child instead of answering its question;
- retrying a rejected call unchanged;
- delegating trivial work.

Each case lists the mistakes it has seen in `recordedMistakes`.

## What runs where

`pnpm test` checks the cases deterministically against the current coordinator policy and tool
descriptions, so it runs in CI and needs no API keys:

- every tool a case names must still exist;
- every phrase in `policyMustMention` must still appear in the policy or a tool description. If
  you reword the guidance, update the phrase, or the case is no longer protected;
- the scorer must fail every recorded mistake.

The live run sends each case to real models with the actual policy and tool definitions, and
scores the first response:

```bash
BUILDWARDEN_EVAL_MODELS="anthropic:claude-sonnet-5-5,openai:gpt-5.6" \
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
pnpm --filter @buildwarden/desktop eval:orchestration
```

The live run also reads these optional variables:

| Variable | Effect |
|---|---|
| `BUILDWARDEN_EVAL_REPEATS` | Runs each case several times, since models are not deterministic. Must be a positive whole number; the run stops before any request otherwise. |
| `OPENAI_BASE_URL` | Points the OpenAI-compatible client at another endpoint, such as OpenRouter. |
| `ANTHROPIC_BASE_URL` | Points the Anthropic client at another endpoint. |

Run the live evals before and after changing `ORCHESTRATION_COORDINATOR_PROMPT` or a tool
description in `apps/desktop/src/main/orchestration-tools.ts`.

### Baselines

Models are not deterministic, and some cases are hard for some models. A baseline records how
often each case passed for one model, so later runs fail only when a case gets worse:

```bash
# Record once per model family (Claude and Codex first), with several repeats:
BUILDWARDEN_EVAL_RECORD_BASELINE=1 BUILDWARDEN_EVAL_REPEATS=5 \
BUILDWARDEN_EVAL_MODELS="anthropic:claude-sonnet-5-5,openai:gpt-5.6" \
pnpm --filter @buildwarden/desktop eval:orchestration
```

This writes `baselines/<model>-<hash>.json`, where the hash identifies the exact model spec; commit it.
A recording run that could not measure every case (for example after an API error) writes nothing. Later runs with the same `BUILDWARDEN_EVAL_MODELS`
compare each case's pass rate with the saved one and fail when it drops. A case without a saved
rate still has to pass every attempt. Record a new baseline after an intended improvement.

## Adding a case

### Native CLI validation

`claude-cli:<model>` and `codex-cli:<model>` use the installed CLI login through BuildWarden's
actual adapters, in a fresh temporary workspace with native command approvals denied.
The synthetic conversation is supplied as a transcript; this is a separate baseline from
API message-history replay. Execution stops at the first host tool call. Use explicit model
IDs supported by the account (`default` uses the app's configured provider default).

```powershell
$env:BUILDWARDEN_EVAL_MODELS = 'claude-cli:sonnet,codex-cli:gpt-6-astra'
$env:BUILDWARDEN_EVAL_RECORD_BASELINE = '1'
$env:BUILDWARDEN_EVAL_REPEATS = '3'
pnpm --filter @buildwarden/desktop eval:orchestration
```

New baseline files include the policy hash, measured responses, and executed-model telemetry
when available. A one-repeat recording is a smoke baseline, not a stable regression threshold.
Review recorded responses before committing. Authentication, usage-limit, or transport errors
leave the baseline unwritten. CLI aliases can change models; re-record when provenance changes.

For offline transport regressions, run:

```bash
pnpm --filter @buildwarden/desktop exec vitest run src/main/provider-protocol-replay.test.ts src/main/provider-acp.test.ts src/main/provider-claude-steering.test.ts src/main/bridged-mcp-tools.test.ts
```

The ACP replay uses real stdio and JSON-RPC with a minimized **synthetic** fixture. Its provenance
is marked in the fixture, so it cannot be mistaken for a captured live-agent exchange. It covers
failed resume, fresh-session configuration, fallback history, and permission rejection. The
other suites exercise Claude background/steering events and required MCP connection failures.
Production captures must be sanitized of credentials, local paths, prompts, and customer data
before being added; do not record user runs automatically.

When you see a coordinator misuse a tool:

1. Copy the conversation up to the mistake into `messages`.
2. Add the wrong response to `recordedMistakes`.
3. Describe the correct behaviour in `expect`.

The `expect` keys are:

| Key | Meaning |
|---|---|
| `noToolCall` | The model must end its turn without calling a tool. |
| `firstToolCall.anyOf` | The first tool call must be one of these tools. |
| `forbiddenToolCalls` | None of the tool calls may use these tools. |
| `argumentsInclude` | The first call must have these argument values. |
| `argumentsExclude` | The first call must not have these argument values. |
| `taskArgumentsInclude` | Every delegated task must have these values. |
| `taskArgumentsExclude` | No delegated task may have these values. |
