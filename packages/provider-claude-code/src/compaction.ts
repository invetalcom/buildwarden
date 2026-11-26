import {
  DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW,
  MIN_CLAUDE_AUTO_COMPACT_WINDOW,
  type RunTokenUsage,
} from "@buildwarden/shared";

/**
 * Room Claude Code keeps free below its compaction window for the reply and a safety buffer.
 * Measured on Claude Code 2.1.332: a 100k window compacted at about 67k. Used only until the
 * session reports its own threshold.
 */
export const CLAUDE_COMPACT_RESERVE_TOKENS = 33_000;

/** Share of the threshold that, reached right after compacting, means compaction freed too little. */
const CLAUDE_COMPACTION_INEFFECTIVE_SHARE = 0.9;

/** Window sent to Claude Code as `autoCompactWindow`: the configured value, never below the floor. */
export const resolveClaudeAutoCompactWindow = (configured: number | undefined): number =>
  Math.max(MIN_CLAUDE_AUTO_COMPACT_WINDOW, Math.round(configured ?? DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW));

/** When Claude Code compacts a session, as configured and, once known, as the session reports it. */
export type ClaudeCompactionPolicy = {
  /** The `autoCompactWindow` BuildWarden sent. */
  configuredWindow: number;
  /** The window Claude Code measures usage against, from `getContextUsage`. */
  reportedWindow?: number;
  /** The occupancy at which Claude Code compacts, from `getContextUsage`. */
  reportedThreshold?: number;
  /** False when the user turned automatic compaction off in their Claude Code settings. */
  enabled: boolean;
};

export const createClaudeCompactionPolicy = (configuredWindow: number): ClaudeCompactionPolicy => ({
  configuredWindow,
  enabled: true,
});

const positiveNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** Adds what Claude Code's `getContextUsage` reports about compaction. Unknown shapes change nothing. */
export const withReportedClaudeContextUsage = (policy: ClaudeCompactionPolicy, response: unknown): ClaudeCompactionPolicy => {
  if (typeof response !== "object" || response === null) return policy;
  const report = response as Record<string, unknown>;
  const reportedWindow = positiveNumber(report.rawMaxTokens);
  const reportedThreshold = positiveNumber(report.autoCompactThreshold);
  return {
    ...policy,
    ...(reportedWindow !== undefined ? { reportedWindow } : {}),
    ...(reportedThreshold !== undefined ? { reportedThreshold } : {}),
    ...(typeof report.isAutoCompactEnabled === "boolean" ? { enabled: report.isAutoCompactEnabled } : {}),
  };
};

/** The window usage is measured against: what the session reports, else the smaller of model and configured window. */
const claudeCompactionWindow = (policy: ClaudeCompactionPolicy, modelWindow: number | undefined): number =>
  policy.reportedWindow ?? (modelWindow === undefined ? policy.configuredWindow : Math.min(modelWindow, policy.configuredWindow));

export const claudeCompactionThreshold = (policy: ClaudeCompactionPolicy, modelWindow?: number): number =>
  policy.reportedThreshold ?? Math.max(0, claudeCompactionWindow(policy, modelWindow) - CLAUDE_COMPACT_RESERVE_TOKENS);

/**
 * Measures context against the window Claude Code compacts in rather than the model's full window,
 * so a 1M-window model that compacts near 167k does not read as a few percent full.
 */
export const applyClaudeCompactionPolicy = (usage: RunTokenUsage, policy: ClaudeCompactionPolicy): RunTokenUsage => {
  const maxTokens = policy.enabled ? claudeCompactionWindow(policy, usage.maxTokens) : usage.maxTokens;
  const cap = (value: number | undefined) => (value === undefined || maxTokens === undefined ? value : Math.min(value, maxTokens));
  const next: RunTokenUsage = { ...usage, compactsAutomatically: policy.enabled };
  if (maxTokens !== undefined) next.maxTokens = maxTokens;
  if (usage.usedTokens !== undefined) next.usedTokens = cap(usage.usedTokens);
  if (usage.lastUsedTokens !== undefined) next.lastUsedTokens = cap(usage.lastUsedTokens);
  if (policy.enabled) next.autoCompactThreshold = claudeCompactionThreshold(policy, usage.maxTokens);
  else delete next.autoCompactThreshold;
  return next;
};

/** Context an assistant message's request occupied, for the main conversation only. */
const mainConversationContextTokens = (event: Record<string, unknown>): number | undefined => {
  if (event.type !== "assistant" || event.parent_tool_use_id) return undefined;
  const message = event.message as { usage?: Record<string, unknown> } | undefined;
  const usage = message?.usage;
  if (!usage) return undefined;
  const count = (key: string) => (typeof usage[key] === "number" ? usage[key] : 0);
  const total = count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens");
  return total > 0 ? total : undefined;
};

const formatThousands = (value: number): string => `${String(Math.round(value / 1_000))}k`;

/**
 * Notices an automatic compaction that freed too little room: the first request after it already
 * fills most of the threshold, so the session compacts again within a few steps. Warns once a turn.
 */
export class ClaudeCompactionWatch {
  private awaitingFirstRequest = false;
  private warned = false;

  /** Returns a warning when the event shows that the latest compaction did not free enough room. */
  observe(event: Record<string, unknown>, threshold: number): string | null {
    if (event.type === "system" && event.subtype === "compact_boundary") {
      const metadata = event.compact_metadata as { trigger?: unknown } | undefined;
      this.awaitingFirstRequest = metadata?.trigger === "auto";
      return null;
    }
    if (!this.awaitingFirstRequest) return null;
    const contextTokens = mainConversationContextTokens(event);
    if (contextTokens === undefined) return null;
    this.awaitingFirstRequest = false;
    if (this.warned || threshold <= 0 || contextTokens < threshold * CLAUDE_COMPACTION_INEFFECTIVE_SHARE) return null;
    this.warned = true;
    return `Claude's context is still ${formatThousands(contextTokens)} tokens right after compacting, close to where it compacts (${formatThousands(threshold)}), so it will compact again soon. `
      + "Tools, skills and instructions that load with every session take up most of that. Use a larger auto-compact window for this Claude provider, or turn off skills, plugins or MCP servers you do not need.";
  }
}
