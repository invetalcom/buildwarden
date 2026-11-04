/*!
 * @license Adapted from T3 Code (https://github.com/pingdotgg/t3code).
 * MIT License — Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { parseTimestampMs, type UsageRecord, type UsageSpeed, type UsageTokenTotals } from "./session-usage-common";

interface CodexTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}
const CODEX_USAGE_FIELDS: Array<keyof CodexTokenUsage> = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const isCodexTokenUsage = (value: Record<string, unknown>): value is CodexTokenUsage & Record<string, unknown> => {
  if (!CODEX_USAGE_FIELDS.every((key) => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0)) return false;
  const usage = value as unknown as CodexTokenUsage;
  return usage.cached_input_tokens + usage.cache_write_input_tokens <= usage.input_tokens
    && usage.reasoning_output_tokens <= usage.output_tokens
    && usage.total_tokens >= usage.input_tokens + usage.output_tokens;
};

function readCodexTokenUsage(value: unknown): CodexTokenUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const input = raw["input_tokens"];
  const output = raw["output_tokens"];
  if (typeof input !== "number" || typeof output !== "number") return null;
  const usage = {
    input_tokens: input,
    cached_input_tokens: raw["cached_input_tokens"] === undefined ? 0 : raw["cached_input_tokens"],
    cache_write_input_tokens:
      raw["cache_write_input_tokens"] === undefined ? 0 : raw["cache_write_input_tokens"],
    output_tokens: output,
    reasoning_output_tokens:
      raw["reasoning_output_tokens"] === undefined ? 0 : raw["reasoning_output_tokens"],
    total_tokens: raw["total_tokens"] === undefined ? input + output : raw["total_tokens"],
  };
  return isCodexTokenUsage(usage) ? usage : null;
}

// A zeroed baseline rebases the counters, so the sequence start measured against it is forgotten.
function rebaseCodexUsage(state: CodexScanState, cumulative: CodexTokenUsage) {
  state.lastCumulativeUsage = cumulative;
  delete state.unreportedRequests;
  if (cumulative.input_tokens + cumulative.output_tokens === 0) delete state.sequenceStartSignature;
}

function advanceCodexUsage(previous: CodexTokenUsage | null, last: CodexTokenUsage) {
  return readCodexTokenUsage(
    Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, (previous?.[key] ?? 0) + last[key]])),
  );
}

interface CodexUnreportedRequest {
  timestampMs: number;
  model: string;
  speed: UsageSpeed;
  usage: CodexTokenUsage;
}
type CodexRequestAttribution = Omit<CodexUnreportedRequest, "usage">;

// An interrupted turn can end before a snapshot reports its last request. Bill those requests only
// when the `token_usage_record`s since the previous snapshot explain the whole gap; `last` is the
// final one.
function unreportedRequests(
  previous: CodexTokenUsage | null,
  cumulative: CodexTokenUsage,
  last: CodexTokenUsage,
  pending: readonly CodexUnreportedRequest[] | undefined,
) {
  if (
    previous === null ||
    pending === undefined ||
    CODEX_USAGE_FIELDS.some(
      (key) =>
        cumulative[key] - previous[key] !==
        pending.reduce((sum, request) => sum + request.usage[key], 0),
    )
  ) {
    return null;
  }
  const final = pending.at(-1)!;
  const remainder = readCodexTokenUsage(
    Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, final.usage[key] - last[key]])),
  );
  if (remainder === null) return null;
  return [...pending.slice(0, -1), { ...final, usage: remainder }].filter(
    (request) => request.usage.input_tokens + request.usage.output_tokens > 0,
  );
}

/**
 * Codex `token_count` events carry no model or service tier, so both are carried forward: the model
 * from the most recent `turn_context`, the tier from the most recent `thread_settings_applied`.
 */
export interface CodexScanState {
  model: string;
  speed: UsageSpeed;
  sessionId: string;
  lastUsageSignature: string | null;
  lastCumulativeUsage: CodexTokenUsage | null;
  sequenceStartSignature?: string;
  unreportedRequests?: CodexUnreportedRequest[];
  malformedRecords: number;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    speed: "standard",
    sessionId: "",
    lastUsageSignature: null,
    lastCumulativeUsage: null,
    malformedRecords: 0,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/** Forks copy and restamp parent history in a burst (0-40ms gaps); genuine child usage follows a model turn (5s+ observed). */
const FORK_COPY_MAX_GAP_MS = 1000;

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload["forked_from_id"] === "string") return true;
  const source = payload["source"];
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof spawn !== "object" || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>)["parent_thread_id"] === "string";
}

// The first usage line past the copied burst ends suppression for the rest of the rollout.
function isForkCopy(state: CodexScanState, timestampMs: number): boolean {
  if (!state.suppressingForkCopies) return false;
  if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
    state.forkCopyAnchorMs = timestampMs;
    return true;
  }
  state.suppressingForkCopies = false;
  state.lastUsageSignature = null;
  return false;
}

/**
 * Cumulative counters validate request deltas. Older events without cumulative counters use
 * normalized consecutive-request deduplication.
 */
export function parseCodexLine(line: string, state: CodexScanState): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return parseCodexRecord(parsed, state);
}

function parseCodexRecord(parsed: unknown, state: CodexScanState): readonly UsageRecord[] {
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return [];
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    // Only the first meta identifies this session; copied ancestor metas would misattribute later records.
    if (state.sawSessionMeta) return [];
    state.sawSessionMeta = true;
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return [];
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return [];
  }

  // Several of these may sit between two snapshots, so they only explain a gap in the counters.
  if (record["type"] === "token_usage_record") {
    const timestampMs = parseTimestampMs(record["timestamp"]);
    const usage = readCodexTokenUsage(payloadRecord["usage"]);
    if (timestampMs === null || usage === null || state.model.length === 0) return [];
    // Copied history is already billed in the parent.
    if (isForkCopy(state, timestampMs)) return [];
    (state.unreportedRequests ??= []).push({ ...codexAttribution(state, timestampMs), usage });
    return [];
  }

  if (payloadType === "thread_settings_applied") {
    const settings = payloadRecord["thread_settings"];
    if (typeof settings === "object" && settings !== null) {
      state.speed = codexSpeed((settings as Record<string, unknown>)["service_tier"]);
    }
    return [];
  }

  if (payloadType !== "token_count") return [];

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return [];
  const infoRecord = info as Record<string, unknown>;

  // Codex may re-emit these counters after the model or timestamp becomes available.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null || state.model.length === 0) return [];

  const last = readCodexTokenUsage(infoRecord["last_token_usage"]);
  const rawCumulative = infoRecord["total_token_usage"];
  const hasCumulative = rawCumulative !== undefined && rawCumulative !== null;
  const cumulative = hasCumulative ? readCodexTokenUsage(rawCumulative) : null;

  if (isForkCopy(state, timestampMs)) {
    // Copied history is already billed in the parent, but establishes the child's baseline.
    const signature = last === null ? null : JSON.stringify(last);
    if (cumulative !== null) rebaseCodexUsage(state, cumulative);
    else if (!hasCumulative && last !== null && signature !== state.lastUsageSignature) {
      state.lastCumulativeUsage = advanceCodexUsage(state.lastCumulativeUsage, last);
    }
    state.lastUsageSignature = signature;
    return [];
  }

  const previous = state.lastCumulativeUsage;
  const pending = state.unreportedRequests;
  // A valid snapshot remains the next baseline even when its paired request is malformed.
  if (cumulative !== null) rebaseCodexUsage(state, cumulative);
  if (last === null || (hasCumulative && cumulative === null)) {
    state.malformedRecords += 1;
    return [];
  }

  // Zero-component counters report context size, not a request: fill_to_context_window, or the
  // post-compaction marker whose total is the new context size (its cumulative may reset to zero).
  if (last.input_tokens + last.output_tokens === 0) {
    state.lastUsageSignature = null;
    return [];
  }

  if (
    cumulative !== null &&
    previous !== null &&
    CODEX_USAGE_FIELDS.every((key) => cumulative[key] === previous[key])
  ) {
    return [];
  }

  if (last.total_tokens !== last.input_tokens + last.output_tokens) {
    state.malformedRecords += 1;
    return [];
  }

  const signature = JSON.stringify(last);
  let unreported: readonly CodexUnreportedRequest[] = [];
  if (cumulative !== null) {
    // A session resumed in a new Codex process restarts its cumulative counters at this request.
    const restarted = CODEX_USAGE_FIELDS.every((key) => cumulative[key] === last[key]);
    const sequenceStart = JSON.stringify([timestampMs, last]);
    // Only the same event is a replay; a later request can restart with identical counters.
    if (restarted && sequenceStart === state.sequenceStartSignature) {
      state.lastCumulativeUsage = previous;
      return [];
    }
    // Forks and paginated continuations can inherit totals without copying a counter snapshot.
    // Only bill the latest request, and require the unseen prefix to be valid usage too.
    const reconciled =
      previous === null
        ? readCodexTokenUsage(
            Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, cumulative[key] - last[key]])),
          ) !== null
        : CODEX_USAGE_FIELDS.every((key) => cumulative[key] - previous[key] === last[key]);
    if (!restarted && !reconciled) {
      const bridged = unreportedRequests(previous, cumulative, last, pending);
      if (bridged === null) {
        state.malformedRecords += 1;
        return [];
      }
      unreported = bridged;
    }
    if (restarted) state.sequenceStartSignature = sequenceStart;
  } else {
    if (signature === state.lastUsageSignature) return [];
    // Advance expected totals for billed legacy requests so a cumulative re-emission is stale.
    const advanced = advanceCodexUsage(previous, last);
    if (advanced === null) {
      state.malformedRecords += 1;
      return [];
    }
    state.lastCumulativeUsage = advanced;
  }
  state.lastUsageSignature = signature;

  return [
    ...unreported.map((request) => codexRequestRecord(state, request.usage, request)),
    codexRequestRecord(state, last, codexAttribution(state, timestampMs)),
  ];
}

function codexAttribution(state: CodexScanState, timestampMs: number): CodexRequestAttribution {
  return {
    timestampMs,
    model: state.model,
    speed: state.speed,
  };
}

function codexRequestRecord(
  state: CodexScanState,
  usage: CodexTokenUsage,
  { timestampMs, model, speed }: CodexRequestAttribution,
): UsageRecord {
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = usage.cached_input_tokens;
  const cacheCreationTokens = usage.cache_write_input_tokens;
  const outputTokens = usage.output_tokens;

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: inputTokens - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: usage.reasoning_output_tokens,
  };

  return {
    provider: "codex",
    timestampMs,
    model,
    sessionId: state.sessionId,
    totals,
    reportedCostUsd: null,
    speed,
    dedupeKey: null,
  };
}

/** Missing, default and standard tiers bill as standard; fast aliases priority. */
function codexSpeed(serviceTier: unknown): UsageSpeed {
  if (serviceTier === "priority" || serviceTier === "fast") return "fast";
  if (serviceTier === "ultrafast") return "ultrafast";
  return "standard";
}
