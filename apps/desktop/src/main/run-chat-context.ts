import type { ProviderType, RunRecord, RunStepRecord } from "@buildwarden/shared";

/**
 * Providers that rebuild the full conversation from persisted chat steps on every turn
 * (via `priorMessages` / `priorChatMessages`). For these, refreshing the hidden context
 * step is enough to surface new run activity; session-based CLI providers instead need
 * the updated context re-sent inside the prompt.
 */
export const providerReplaysChatHistory = (providerType: ProviderType): boolean =>
  providerType === "ai-sdk" || providerType === "azure-legacy";

/** Character budgets keep the seeded context well inside typical model context windows. */
const USER_PROMPTS_BUDGET = 6_000;
const ASSISTANT_OUTPUTS_BUDGET = 28_000;
const DIFF_BUDGET = 60_000;
const DIFF_PER_FILE_BUDGET = 12_000;

const TRUNCATION_MARKER = "\n[... truncated ...]";

const safeParseMetadata = (value: string): Record<string, unknown> => {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

const truncate = (value: string, budget: number): string => {
  if (value.length <= budget) {
    return value;
  }
  return value.slice(0, Math.max(0, budget - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
};

/** Keeps the most recent entries whole (newest kept first), then restores original order. */
const takeLatestWithinBudget = (entries: string[], budget: number): string[] => {
  const kept: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (used + entry.length > budget) {
      if (kept.length === 0) {
        kept.push(truncate(entry, budget));
      } else {
        kept.push("[... earlier entries omitted ...]");
      }
      break;
    }
    kept.push(entry);
    used += entry.length;
  }
  return kept.reverse();
};

/** Splits a unified diff into per-file sections, keeping "diff --git" headers with their hunks. */
const buildCodeChangesSection = (diffSection: string, diffUnavailableReason: string | null): string => {
  if (diffSection) {
    return `<code_changes>\nUnified git diff of the run's workspace:\n\n${diffSection}\n</code_changes>`;
  }
  const reasonSuffix = diffUnavailableReason ? ` (${diffUnavailableReason})` : "";
  return `<code_changes>\nNo diff is available${reasonSuffix}. The run may not have changed any files.\n</code_changes>`;
};

const truncateDiff = (diff: string): string => {
  const trimmed = diff.trim();
  if (!trimmed) {
    return "";
  }
  const sections = trimmed.split(/^(?=diff --git )/m);
  const out: string[] = [];
  let used = 0;
  let omittedFiles = 0;
  for (const section of sections) {
    const filePart = truncate(section.trimEnd(), DIFF_PER_FILE_BUDGET);
    if (used + filePart.length > DIFF_BUDGET) {
      omittedFiles += 1;
      continue;
    }
    out.push(filePart);
    used += filePart.length;
  }
  if (omittedFiles > 0) {
    out.push(`[... ${omittedFiles} file diff${omittedFiles === 1 ? "" : "s"} omitted to stay within the context budget ...]`);
  }
  return out.join("\n");
};

export interface RunChatContextInput {
  run: RunRecord;
  steps: RunStepRecord[];
  projectName: string;
  /** Unified diff of the run workspace; empty when unavailable. */
  diff: string;
  /** Set when the worktree/diff could not be loaded, to explain the missing diff to the model. */
  diffUnavailableReason?: string | null;
}

/**
 * Builds the hidden context block that seeds a run-scoped chat. Sent to the provider as part
 * of the first user turn and replayed via prior-message history on follow-ups.
 */
export const buildRunChatContext = (input: RunChatContextInput): string => {
  const { run, steps, projectName, diff } = input;

  const userPrompts: string[] = [];
  const assistantOutputs: string[] = [];
  for (const step of steps) {
    const metadata = safeParseMetadata(step.metadataJson);
    if (typeof metadata.subagentId === "string" && metadata.subagentId) {
      continue;
    }
    if (step.eventType === "log" && metadata.source === "user" && step.content.trim()) {
      userPrompts.push(step.content.trim());
      continue;
    }
    if (
      step.eventType === "output" &&
      step.content.trim() &&
      metadata.assistantKind !== "reasoning" &&
      step.title !== "Reasoning"
    ) {
      assistantOutputs.push(step.content.trim());
    }
  }

  const promptSection = takeLatestWithinBudget(userPrompts, USER_PROMPTS_BUDGET)
    .map((entry, index) => `${index + 1}. ${entry}`)
    .join("\n\n");
  const outputSection = takeLatestWithinBudget(assistantOutputs, ASSISTANT_OUTPUTS_BUDGET).join("\n\n---\n\n");
  const diffSection = truncateDiff(diff);

  const parts = [
    "You are answering questions about a coding agent run. Use the run context below to answer. Do not attempt to modify files or execute tasks; simply explain, summarize, and answer questions.",
    `<run_info>\nProject: ${projectName}\nBranch: ${run.branchName}\nMode: ${run.mode}\nStatus: ${run.status}\nStarted: ${run.startedAt ?? "unknown"}\nFinished: ${run.finishedAt ?? "not finished"}\n</run_info>`,
    promptSection ? `<run_instructions>\nUser prompts given to the agent:\n${promptSection}\n</run_instructions>` : "",
    outputSection ? `<agent_output>\n${outputSection}\n</agent_output>` : "",
    buildCodeChangesSection(diffSection, input.diffUnavailableReason ?? null),
  ];

  return parts.filter(Boolean).join("\n\n");
};

/**
 * First chat turn for providers that keep their own session (Claude Code, Codex CLI,
 * Cursor Agent): the context must travel inside the prompt.
 */
export const buildRunChatFirstTurnPrompt = (context: string, question: string): string =>
  `${context}\n\n<question>\n${question || "See the attached files."}\n</question>`;

/**
 * Follow-up turn for session-based providers after the run produced new activity:
 * re-sends the full refreshed context so answers reflect the latest run state.
 */
export const buildRunChatUpdateTurnPrompt = (context: string, question: string): string =>
  [
    "The agent run has produced new activity since the conversation started. This is the latest run context; it replaces every earlier version:",
    context,
    `<question>\n${question || "See the attached files."}\n</question>`,
  ].join("\n\n");
