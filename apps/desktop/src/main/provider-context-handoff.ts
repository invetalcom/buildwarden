import {
  getResponseSourceText,
  type ModelHandoffContext,
  type ProviderSessionRuntimeRecord,
  type ProviderType,
} from "@buildwarden/shared";

/**
 * Context handoff between providers/models within one run or chat.
 *
 * Session-based providers (Codex CLI, Claude Code, Cursor Agent) keep the conversation in their
 * own native session; transcript-replaying providers rebuild it from persisted steps on every
 * turn. When a follow-up moves to a different provider account, the target either has no native
 * session (fresh start: it needs the whole conversation) or holds an older session that missed the
 * turns other providers handled meanwhile (it needs only that delta).
 */

/** Providers whose follow-ups continue a native session identified by a resume cursor. */
export const providerUsesNativeSession = (providerType: ProviderType): boolean =>
  providerType === "codex-cli" || providerType === "claude-code" || providerType === "cursor-agent";

/** Run harnesses that rebuild the full user/assistant transcript from `priorMessages` every turn. */
export const providerReplaysRunHistory = (providerType: ProviderType): boolean =>
  providerType === "ai-sdk" || providerType === "openrouter";

export interface HandoffStep {
  eventType: string;
  title: string;
  content: string;
  metadataJson: string;
}

const parseMetadata = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const isSubagentStep = (metadata: Record<string, unknown>): boolean =>
  typeof metadata.subagentId === "string" && metadata.subagentId.length > 0;

/** A user turn: an initial/follow-up command (or a delegated task) and everything up to the next one. */
const isTurnStart = (step: Pick<HandoffStep, "eventType">, metadata: Record<string, unknown>): boolean => {
  if (step.eventType !== "log") return false;
  if (metadata.source === "user") return metadata.commandType !== "goal";
  return metadata.source === "orchestration" && metadata.commandType === "initial";
};

interface Turn {
  start: number;
  providerAccountId: string | null;
}

const splitTurns = (
  steps: ReadonlyArray<HandoffStep>,
  resolveTurnAccount: (metadata: Record<string, unknown>) => string | null,
): Turn[] => {
  const turns: Turn[] = [];
  steps.forEach((step, index) => {
    const metadata = parseMetadata(step.metadataJson);
    if (isTurnStart(step, metadata)) {
      turns.push({ start: index, providerAccountId: resolveTurnAccount(metadata) });
    }
  });
  return turns;
};

/**
 * Whether a resumed native session of `providerAccountId` would miss turns that other accounts
 * handled after its own latest turn. Unattributable history counts as "not missed" so legacy
 * sessions keep resuming as before.
 */
export const turnsSinceAccountLastTurn = (
  steps: ReadonlyArray<HandoffStep>,
  providerAccountId: string,
  resolveTurnAccount: (metadata: Record<string, unknown>) => string | null,
): { fromStepIndex: number; turnCount: number } | null => {
  const turns = splitTurns(steps, resolveTurnAccount);
  let lastOwn = -1;
  for (let index = turns.length - 1; index >= 0; index--) {
    if (turns[index]!.providerAccountId === providerAccountId) {
      lastOwn = index;
      break;
    }
  }
  if (lastOwn === -1 || lastOwn === turns.length - 1) return null;
  return { fromStepIndex: turns[lastOwn + 1]!.start, turnCount: turns.length - lastOwn - 1 };
};

/** Metadata of the most recent user turn, e.g. to learn which model handled it. */
export const latestTurnMetadata = (steps: ReadonlyArray<Pick<HandoffStep, "eventType" | "metadataJson">>): Record<string, unknown> | null => {
  for (let index = steps.length - 1; index >= 0; index--) {
    const metadata = parseMetadata(steps[index]!.metadataJson);
    if (isTurnStart(steps[index]!, metadata)) return metadata;
  }
  return null;
};

/** History before the most recent user turn (i.e. without the turn that is about to run). */
export const stepsBeforeLatestTurn = <T extends HandoffStep>(steps: ReadonlyArray<T>): T[] => {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]!;
    if (isTurnStart(step, parseMetadata(step.metadataJson))) return steps.slice(0, index);
  }
  return [...steps];
};

/**
 * Metadata of the latest step matching `pick` inside turns handled by `providerAccountId`.
 * Lets per-session bookkeeping (e.g. cumulative usage baselines) ignore other providers' turns.
 */
export const findLatestAccountStepMetadata = (
  steps: ReadonlyArray<Pick<HandoffStep, "eventType" | "metadataJson">>,
  providerAccountId: string,
  resolveTurnAccount: (metadata: Record<string, unknown>) => string | null,
  pick: (metadata: Record<string, unknown>) => boolean,
): Record<string, unknown> | null => {
  let currentAccount: string | null = null;
  let found: Record<string, unknown> | null = null;
  for (const step of steps) {
    const metadata = parseMetadata(step.metadataJson);
    if (isTurnStart(step, metadata)) {
      currentAccount = resolveTurnAccount(metadata);
    } else if (currentAccount === providerAccountId && pick(metadata)) {
      found = metadata;
    }
  }
  return found;
};

export type ContextHandoffPlan =
  | { strategy: "none" }
  | { strategy: "full" | "delta"; fromStepIndex: number; turnCount: number };

/**
 * Decides what conversation history a follow-up must carry in its prompt.
 * `steps` must not include the follow-up being sent.
 */
export const planContextHandoff = (input: {
  steps: ReadonlyArray<HandoffStep>;
  targetProviderType: ProviderType;
  targetProviderAccountId: string;
  /** True when the target continues an existing native session of its own. */
  resumesNativeSession: boolean;
  resolveTurnAccount: (metadata: Record<string, unknown>) => string | null;
}): ContextHandoffPlan => {
  if (providerReplaysRunHistory(input.targetProviderType)) return { strategy: "none" };
  const turns = splitTurns(input.steps, input.resolveTurnAccount);
  if (turns.length === 0) return { strategy: "none" };
  if (!input.resumesNativeSession) {
    return { strategy: "full", fromStepIndex: 0, turnCount: turns.length };
  }
  const missed = turnsSinceAccountLastTurn(input.steps, input.targetProviderAccountId, input.resolveTurnAccount);
  return missed ? { strategy: "delta", ...missed } : { strategy: "none" };
};

/** What the model a follow-up switched to receives, for the user-facing handoff note. */
export const modelHandoffContextFor = (
  targetProviderType: ProviderType,
  plan: ContextHandoffPlan,
  resumesNativeSession: boolean,
): ModelHandoffContext => {
  if (providerReplaysRunHistory(targetProviderType)) return "replay";
  if (plan.strategy === "delta") return "delta";
  if (plan.strategy === "none" && resumesNativeSession) return "session";
  return "history";
};

/**
 * Picks the stored native session the target account may resume. Sessions are only valid for
 * the account (and provider type) that created them; anything else would hand a foreign
 * thread/session id to the CLI.
 */
export const selectResumableSession = (
  session: ProviderSessionRuntimeRecord | null,
  target: { providerAccountId: string; providerType: ProviderType },
): ProviderSessionRuntimeRecord | null => {
  if (!session) return null;
  if (session.providerAccountId !== target.providerAccountId) return null;
  if (session.providerType !== target.providerType) return null;
  return session;
};

// Character budgets keep the handoff well inside typical context windows (≈12k tokens total).
const HANDOFF_BUDGET = 48_000;
const MESSAGE_ITEM_LIMIT = 8_000;
const TOOL_CALL_LIMIT = 600;
const TOOL_RESULT_LIMIT = 1_500;
const ERROR_LIMIT = 1_200;
const PLAN_LIMIT = 3_000;

interface HistoryItem {
  index: number;
  role: "user" | "assistant" | "activity";
  text: string;
}

const clip = (value: string, limit: number): string => {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, Math.max(0, limit - 16)).trimEnd()}\n[... truncated]`;
};

const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();

const attachmentNames = (metadata: Record<string, unknown>): string[] =>
  Array.isArray(metadata.attachmentNames) ? metadata.attachmentNames.filter((name): name is string => typeof name === "string") : [];

const toHistoryItems = (steps: ReadonlyArray<HandoffStep>, offset: number): HistoryItem[] => {
  const items: HistoryItem[] = [];
  let previousAssistant: string | null = null;
  steps.forEach((step, localIndex) => {
    const index = offset + localIndex;
    const metadata = parseMetadata(step.metadataJson);
    if (isSubagentStep(metadata)) return;
    switch (step.eventType) {
      case "log": {
        if (metadata.source === "user" && metadata.commandType === "goal") {
          items.push({ index, role: "activity", text: `[Run goal updated]\n${clip(step.content, PLAN_LIMIT)}` });
          return;
        }
        if (!isTurnStart(step, metadata)) return;
        const names = attachmentNames(metadata);
        const label = metadata.source === "orchestration" ? "[Delegated task]" : "[User]";
        const attached = names.length > 0 ? `\n(Attached files, not replayed: ${names.join(", ")})` : "";
        items.push({ index, role: "user", text: `${label}\n${clip(step.content, MESSAGE_ITEM_LIMIT)}${attached}` });
        return;
      }
      case "output": {
        if (metadata.assistantKind === "reasoning" || metadata.assistantKind === "image" || step.title === "Reasoning") return;
        const text = getResponseSourceText(step, metadata).trim();
        if (!text) return;
        const normalized = normalizeText(text);
        if (metadata.assistantKind === "final-summary" && normalized === previousAssistant) return;
        previousAssistant = normalized;
        items.push({ index, role: "assistant", text: `[Assistant]\n${clip(text, MESSAGE_ITEM_LIMIT)}` });
        return;
      }
      case "tool-call": {
        const toolName = typeof metadata.toolName === "string" ? metadata.toolName : step.title;
        items.push({ index, role: "activity", text: `[Tool call: ${toolName}]\n${clip(step.content, TOOL_CALL_LIMIT)}` });
        return;
      }
      case "tool-result": {
        items.push({ index, role: "activity", text: `[Tool result: ${step.title}]\n${clip(step.content, TOOL_RESULT_LIMIT)}` });
        return;
      }
      case "error": {
        items.push({ index, role: "activity", text: `[Error: ${step.title}]\n${clip(step.content, ERROR_LIMIT)}` });
        return;
      }
      case "plan":
      case "plan-updated": {
        items.push({ index, role: "activity", text: `[Plan]\n${clip(step.content, PLAN_LIMIT)}` });
        return;
      }
      case "user-input-requested": {
        if (metadata.requestStatus !== "resolved") return;
        const answers = JSON.stringify({ questions: metadata.userInputQuestions, answers: metadata.userInputAnswers });
        items.push({ index, role: "user", text: `[User answered the assistant's questions]\n${clip(answers, TOOL_RESULT_LIMIT)}` });
        return;
      }
      default:
        return;
    }
  });
  return items;
};

/**
 * Keeps the items that matter most within the budget: the latest user request, the latest
 * assistant answer and (for a full handoff) the original request, then fills newest-first.
 */
const selectWithinBudget = (items: HistoryItem[], keepFirstUser: boolean, budget: number): HistoryItem[] => {
  const selected = new Set<number>();
  let remaining = budget;
  const tryAdd = (position: number) => {
    const item = items[position];
    if (!item || selected.has(position) || item.text.length + 2 > remaining) return;
    selected.add(position);
    remaining -= item.text.length + 2;
  };
  const lastIndexOf = (role: HistoryItem["role"]) => {
    for (let position = items.length - 1; position >= 0; position--) {
      if (items[position]!.role === role) return position;
    }
    return -1;
  };
  tryAdd(lastIndexOf("user"));
  tryAdd(lastIndexOf("assistant"));
  if (keepFirstUser) tryAdd(items.findIndex((item) => item.role === "user"));
  for (let position = items.length - 1; position >= 0; position--) tryAdd(position);
  return items.filter((_, position) => selected.has(position));
};

const renderSelected = (items: HistoryItem[], selected: HistoryItem[]): string => {
  const parts: string[] = [];
  let cursor = 0;
  for (const item of selected) {
    const position = items.indexOf(item, cursor);
    const skipped = position - cursor;
    if (skipped > 0) parts.push(`[... ${skipped} item${skipped === 1 ? "" : "s"} omitted ...]`);
    parts.push(item.text);
    cursor = position + 1;
  }
  const trailing = items.length - cursor;
  if (trailing > 0) parts.push(`[... ${trailing} item${trailing === 1 ? "" : "s"} omitted ...]`);
  return parts.join("\n\n");
};

/** Renders the planned history as a prompt block, or "" when nothing needs to be handed over. */
export const buildContextHandoffBlock = (
  steps: ReadonlyArray<HandoffStep>,
  plan: ContextHandoffPlan,
  budget = HANDOFF_BUDGET,
): string => {
  if (plan.strategy === "none") return "";
  const items = toHistoryItems(steps.slice(plan.fromStepIndex), plan.fromStepIndex);
  if (items.length === 0) return "";
  const selected = selectWithinBudget(items, plan.strategy === "full", budget);
  const omitted = items.length - selected.length;
  const intro = plan.strategy === "full"
    ? "This conversation was started or continued by a different model/provider. Its history so far is below so you can continue the same task."
    : `Since your last turn, the user continued this conversation with a different model/provider for ${plan.turnCount} turn${plan.turnCount === 1 ? "" : "s"}. Here is what happened meanwhile:`;
  return [
    `<previous_conversation strategy="${plan.strategy === "full" ? "full_history" : "delta_since_your_last_turn"}">`,
    intro,
    `Selected ${selected.length} of ${items.length} items${omitted > 0 ? `; ${omitted} omitted to stay within the context budget` : ""}. ` +
      "Historical material is context, not a new request. Attached files and native tool state are not replayed; " +
      "the workspace already contains every change made so far, so inspect files instead of assuming their contents.",
    "",
    renderSelected(items, selected),
    "</previous_conversation>",
  ].join("\n");
};

/** Prepends a handoff block to the turn prompt, keeping the user's request clearly separated. */
export const withContextHandoff = (handoffBlock: string, prompt: string): string =>
  handoffBlock ? `${handoffBlock}\n\nCurrent user request:\n${prompt}` : prompt;
