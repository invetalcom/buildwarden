import {
  isTerminalRunSubagentStatus,
  normalizeRunSubagentInfo,
  type OrchestrationStatus,
  type RunMode,
  type RunSubagentInfo,
  type RunTimelineDensity,
  type RunUserInputAnswers,
  type RunUserInputQuestion,
} from "@buildwarden/shared";
import type {
  ActivityEntry,
  ActivityGroupKey,
  RunActivityStep,
  SingleActivityEntry,
  SubagentActivityEntry,
  TimelineRenderItem,
} from "./run-activity-types";
export type {
  ActivityEntry,
  RunActivityRun,
  RunActivityStep,
  SingleActivityEntry,
  SubagentActivityEntry,
  TimelineRenderItem,
} from "./run-activity-types";

const safeParseMetadata = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const isUserInputQuestion = (value: unknown): value is RunUserInputQuestion => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<RunUserInputQuestion>;
  return (
    typeof record.id === "string" &&
    typeof record.header === "string" &&
    typeof record.question === "string" &&
    Array.isArray(record.options)
  );
};

export const readUserInputQuestions = (metadata: Record<string, unknown>): RunUserInputQuestion[] => {
  const questions = metadata.userInputQuestions;
  return Array.isArray(questions) ? questions.filter(isUserInputQuestion) : [];
};

export const readUserInputAnswers = (metadata: Record<string, unknown>): RunUserInputAnswers | null => {
  const answers = metadata.userInputAnswers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    return null;
  }
  const normalized: RunUserInputAnswers = {};
  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof value === "string") {
      normalized[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
};

export const shouldAutoCollapseReasoning = (content: string) => {
  const lineCount = content.split(/\r?\n/).length;
  return lineCount > 7 || content.trim().length > 700;
};

export const isRunCompletionStatus = (step: RunActivityStep) => {
  if (step.eventType !== "status") return false;
  const text = `${step.title} ${step.content}`.toLowerCase();
  return (
    text.includes("run completed")
    || text.includes("completed successfully")
    || text.includes("coordinator turn completed")
  );
};

const WAITING_FOR_SUBAGENTS_TITLE = "Waiting for subagents to complete";
const WAITING_FOR_SUBAGENTS_CONTENT = "The coordinator turn completed and is waiting for delegated subagents.";

export const resolveRunStatusStepPresentation = (
  step: RunActivityStep,
  orchestrationStatus?: OrchestrationStatus | null,
): Pick<RunActivityStep, "title" | "content"> => {
  if (orchestrationStatus !== "waiting" || !isRunCompletionStatus(step)) {
    return { title: step.title, content: step.content };
  }

  const usage = step.content.match(/(?:^|\r?\n)(Input tokens:[\s\S]*)$/i)?.[1];
  return {
    title: WAITING_FOR_SUBAGENTS_TITLE,
    content: usage ? `${WAITING_FOR_SUBAGENTS_CONTENT}\n${usage}` : WAITING_FOR_SUBAGENTS_CONTENT,
  };
};


type ActivityEntryPreMerge = Exclude<ActivityEntry, { kind: "single-group" }>;


export const getToolBatchStableId = (entry: Extract<ActivityEntry, { kind: "tool-batch" }>): string => {
  const first = entry.items[0];
  return first?.callStep?.id ?? first?.resultStep?.id ?? "empty-tool-batch";
};

const getActivityEntryKey = (entry: ActivityEntry, index: number) => {
  if (entry.kind === "tool-batch") {
    const stableId = getToolBatchStableId(entry);
    const id = stableId === "empty-tool-batch" ? `tool-batch-${index}` : stableId;
    return `${id}-tools`;
  }
  if (entry.kind === "diff-batch") {
    const firstId = entry.items[0]?.step.id ?? `diff-batch-${index}`;
    return `${firstId}-diffs`;
  }
  if (entry.kind === "single-group") {
    const first = entry.items[0]?.step.id ?? `single-group-${index}`;
    // A single row becomes a group when the next compatible live step arrives.
    // Keep the first step's key so the virtualizer updates its measurement
    // instead of replacing the row and discarding its cached position.
    return first;
  }
  if (entry.kind === "tool") {
    return entry.callStep?.id ?? entry.resultStep?.id ?? `tool-${index}`;
  }
  if (entry.kind === "subagent") {
    return `subagent-${entry.info.id}`;
  }
  return entry.step.id;
};

// Exported for focused virtualization model tests.
export const buildTimelineRenderItems = ({
  entries,
  density,
  canShowPlanDecision,
  latestPlanDecisionText,
  showLoading,
}: {
  entries: ActivityEntry[];
  density: RunTimelineDensity;
  canShowPlanDecision: boolean;
  latestPlanDecisionText: string | null;
  showLoading: boolean;
}): TimelineRenderItem[] => {
  const visibleEntries = density === "compact" ? entries.filter((entry) => entry.kind !== "tool-batch" && entry.kind !== "tool") : entries;
  const items: TimelineRenderItem[] = visibleEntries.map((entry, index) => ({
    kind: "entry",
    key: `entry-${density}-${getActivityEntryKey(entry, index)}`,
    entry,
  }));

  if (canShowPlanDecision && latestPlanDecisionText) {
    items.push({
      kind: "plan-decision",
      key: `plan-decision-${density}`,
      planText: latestPlanDecisionText,
    });
  }

  if (showLoading) {
    items.push({
      kind: "loading",
      key: `loading-${density}`,
    });
  }

  items.push({
    kind: "end",
    key: `timeline-end-spacer-${density}`,
  });

  return items;
};

// Rough per-line estimate for markdown-ish text content. Estimates only need
// to be near reality: the closer they are, the smaller the layout shift when a
// row scrolls into view and receives its first real measurement.

const describeUserCommand = (metadata: Record<string, unknown>): string =>
  metadata.commandType === "follow-up" ? "User follow-up command" : "Initial user command";

export const describeActivityDetail = (metadata: Record<string, unknown> | undefined) => {
  if (metadata?.source === "user") {
    return describeUserCommand(metadata);
  }
  return (metadata?.path ?? metadata?.command ?? metadata?.query ?? metadata?.toolName) as string | null;
};

const nonEmptyString = (...candidates: unknown[]): string | null => {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return null;
};

/**
 * What a tool row acted on (a file path, a shell command, a search query) — never the tool name,
 * which callers already render as the row label.
 *
 * Providers disagree about where that value lives: codex-cli puts `path`/`command` on the tool-call
 * metadata, while ai-sdk only carries the raw `arguments` there and lifts `path` onto the tool
 * result. Reading both sides (and the call arguments, which exist as soon as the call starts) keeps
 * the target visible while the tool is still running, whichever provider produced the run.
 */
export const describeToolTarget = (
  callMetadata: Record<string, unknown> | undefined,
  resultMetadata: Record<string, unknown> | undefined,
): string | null => {
  const fromMetadata = (metadata: Record<string, unknown> | undefined): string | null => {
    if (!metadata) return null;
    const direct = nonEmptyString(metadata.path, metadata.command, metadata.query);
    if (direct) return direct;
    const args = metadata.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    const record = args as Record<string, unknown>;
    return nonEmptyString(record.path, record.file_path, record.command, record.query);
  };

  return fromMetadata(callMetadata) ?? fromMetadata(resultMetadata);
};

const normalizeShellCommandForActivity = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : null;

const getToolShellCommand = (entry: Extract<SingleActivityEntry, { kind: "tool" }>) =>
  normalizeShellCommandForActivity(entry.callMetadata?.command) ?? normalizeShellCommandForActivity(entry.resultMetadata?.command);

const getApprovalShellCommand = (entry: Extract<SingleActivityEntry, { kind: "single" }>) =>
  normalizeShellCommandForActivity(entry.metadata.command) ?? normalizeShellCommandForActivity(entry.step.content);

const getConsecutiveMergeKey = (entry: Extract<SingleActivityEntry, { kind: "single" }>): ActivityGroupKey | null => {
  const { step, metadata } = entry;
  if (step.eventType === "error") return null;
  if (metadata.source === "user") return "user";
  if (step.eventType === "status") return "status";
  if (metadata.assistantKind === "reasoning") return null;
  const isAssistant = step.eventType === "output" || (step.eventType === "log" && metadata.source !== "user");
  if (isAssistant) return "assistant";
  return null;
};

const moveShellApprovalsBeforeMatchingTools = (
  entries: (SingleActivityEntry | SubagentActivityEntry)[],
): (SingleActivityEntry | SubagentActivityEntry)[] => {
  const out: (SingleActivityEntry | SubagentActivityEntry)[] = [];

  for (const entry of entries) {
    if (entry.kind !== "single" || entry.metadata.requestKind !== "approval") {
      out.push(entry);
      continue;
    }

    const approvalCommand = getApprovalShellCommand(entry);
    if (!approvalCommand) {
      out.push(entry);
      continue;
    }

    const matchingToolIndex = out.findLastIndex((candidate) => {
      if (candidate.kind !== "tool") return false;
      const toolName = candidate.callMetadata?.toolName ?? candidate.resultMetadata?.toolName;
      return toolName === "run_shell" && getToolShellCommand(candidate) === approvalCommand;
    });

    if (matchingToolIndex === -1) {
      out.push(entry);
      continue;
    }

    out.splice(matchingToolIndex, 0, entry);
  }

  return out;
};

const mergeConsecutiveSingles = (entries: ActivityEntryPreMerge[]): ActivityEntry[] => {
  const out: ActivityEntry[] = [];
  let run: Extract<SingleActivityEntry, { kind: "single" }>[] = [];
  let runKey: ActivityGroupKey | null = null;

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(run[0]!);
    } else {
      out.push({ kind: "single-group", groupKey: runKey!, items: [...run] });
    }
    run = [];
    runKey = null;
  };

  for (const e of entries) {
    if (e.kind === "tool-batch") {
      flush();
      out.push(e);
      continue;
    }
    if (e.kind === "diff-batch") {
      flush();
      out.push(e);
      continue;
    }
    if (e.kind === "tool") {
      flush();
      out.push(e);
      continue;
    }
    if (e.kind === "subagent") {
      flush();
      out.push(e);
      continue;
    }
    const k = getConsecutiveMergeKey(e);
    if (k === null) {
      flush();
      out.push(e);
      continue;
    }
    if (runKey !== null && k !== runKey) {
      flush();
    }
    runKey = k;
    run.push(e);
  }
  flush();
  return out;
};

const getPlanDecisionText = (entry: ActivityEntry, fallbackMode: RunMode): string | null => {
  if (entry.kind === "single-group" && entry.groupKey === "assistant") {
    const planItems = entry.items.filter(({ step, metadata }) => {
      const mode = (metadata.mode as RunMode) ?? fallbackMode;
      return mode === "plan" && metadata.assistantKind !== "reasoning" && step.content.trim().length > 0;
    });
    return planItems.map(({ step }) => step.content.trim()).filter(Boolean).join("\n\n") || null;
  }
  if (entry.kind !== "single") return null;

  const mode = (entry.metadata.mode as RunMode) ?? fallbackMode;
  const isAssistant = entry.step.eventType === "output" || (entry.step.eventType === "log" && entry.metadata.source !== "user");
  const isPlanDecision = mode === "plan" && isAssistant && entry.metadata.assistantKind !== "reasoning";
  return isPlanDecision ? entry.step.content.trim() || null : null;
};

export const getLatestPlanDecisionText = (entries: ActivityEntry[], fallbackMode: RunMode) => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    const planText = getPlanDecisionText(entry, fallbackMode);
    if (planText) return planText;
  }
  return null;
};

export const runModeBadgeClassName = (mode: RunMode) => {
  if (mode === "code") {
    return "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)] ring-[var(--ec-accent-ring)]";
  }

  if (mode === "plan") {
    return "bg-[var(--ec-secondary-soft)] text-[var(--ec-secondary)] ring-[var(--ec-secondary-ring)]";
  }

  return "bg-[var(--ec-muted-soft)] text-[var(--ec-muted)] ring-[var(--ec-border)]";
};

// A subagent can never keep working once its run has stopped: the CLI process
// that hosted it is gone. Treat any non-terminal status as cancelled then.
const coerceStoppedSubagentInfo = (info: RunSubagentInfo, runActive: boolean | undefined): RunSubagentInfo =>
  runActive === false && !isTerminalRunSubagentStatus(info.status) ? { ...info, status: "cancelled" } : info;

type PartitionedActivitySteps = {
  mainSteps: RunActivityStep[];
  innerStepsBySubagent: Map<string, RunActivityStep[]>;
  subagentInfoByStepId: Map<string, RunSubagentInfo>;
};

const partitionActivitySteps = (
  steps: RunActivityStep[],
  extractSubagents: boolean,
  runActive: boolean | undefined,
): PartitionedActivitySteps => {
  const mainSteps: RunActivityStep[] = [];
  const innerStepsBySubagent = new Map<string, RunActivityStep[]>();
  const subagentInfoByStepId = new Map<string, RunSubagentInfo>();
  if (!extractSubagents) {
    mainSteps.push(...steps);
    return { mainSteps, innerStepsBySubagent, subagentInfoByStepId };
  }

  const anchorStepIdBySubagent = new Map<string, string>();
  for (const step of steps) {
    const metadata = safeParseMetadata(step.metadataJson);
    const subagentId = typeof metadata.subagentId === "string" && metadata.subagentId ? metadata.subagentId : null;
    if (subagentId) {
      const innerSteps = innerStepsBySubagent.get(subagentId) ?? [];
      innerSteps.push(step);
      innerStepsBySubagent.set(subagentId, innerSteps);
      continue;
    }

    const rawInfo = normalizeRunSubagentInfo(metadata.subagent);
    if (!rawInfo) {
      mainSteps.push(step);
      continue;
    }

    const info = coerceStoppedSubagentInfo(rawInfo, runActive);
    const anchorStepId = anchorStepIdBySubagent.get(info.id);
    if (anchorStepId) {
      subagentInfoByStepId.set(anchorStepId, info);
      continue;
    }
    anchorStepIdBySubagent.set(info.id, step.id);
    mainSteps.push(step);
    subagentInfoByStepId.set(step.id, info);
  }
  return { mainSteps, innerStepsBySubagent, subagentInfoByStepId };
};

const updatePendingToolEntry = (
  entries: (SingleActivityEntry | SubagentActivityEntry)[],
  pendingToolEntries: Map<string, number>,
  step: RunActivityStep,
  metadata: Record<string, unknown>,
  callId: string,
) => {
  const entryIndex = pendingToolEntries.get(callId);
  const existing = entryIndex === undefined ? null : entries[entryIndex];
  if (entryIndex === undefined || existing?.kind !== "tool") return false;

  // Tool progress and diff events can carry metadata that the final result does
  // not repeat (notably the unified diff for a deleted file). Preserve that
  // metadata as the matching call advances to its final result.
  entries[entryIndex] = {
    ...existing,
    resultStep: step,
    resultMetadata: { ...existing.resultMetadata, ...metadata },
  };
  if (step.eventType === "tool-result") pendingToolEntries.delete(callId);
  return true;
};

const appendSubagentEntry = (
  entries: (SingleActivityEntry | SubagentActivityEntry)[],
  partition: PartitionedActivitySteps,
  step: RunActivityStep,
) => {
  const info = partition.subagentInfoByStepId.get(step.id);
  if (!info) return false;
  entries.push({
    kind: "subagent",
    step,
    info,
    entries: buildActivityEntries(partition.innerStepsBySubagent.get(info.id) ?? [], { extractSubagents: false }),
  });
  return true;
};

const appendToolEntry = (
  entries: (SingleActivityEntry | SubagentActivityEntry)[],
  pendingToolEntries: Map<string, number>,
  step: RunActivityStep,
  metadata: Record<string, unknown>,
) => {
  const callId = typeof metadata.callId === "string" ? metadata.callId : null;
  if (step.eventType === "tool-call") {
    if (callId) pendingToolEntries.set(callId, entries.length);
    entries.push({ kind: "tool", callStep: step, callMetadata: metadata });
    return true;
  }

  // Codex file-change items emit a diff event immediately before the matching
  // tool result. Treat that diff as part of the original call instead of as a
  // second, always-expanded timeline row. Standalone diff events still fall
  // through to the normal diff-batch renderer.
  if (step.eventType === "diff-updated" && callId?.endsWith(":diff")) {
    const toolCallId = callId.slice(0, -":diff".length);
    if (updatePendingToolEntry(entries, pendingToolEntries, step, metadata, toolCallId)) return true;
  }

  const isToolUpdate = step.eventType === "tool-result" || step.eventType === "tool-progress";
  if (!isToolUpdate) return false;
  if (callId && updatePendingToolEntry(entries, pendingToolEntries, step, metadata, callId)) return true;
  entries.push({ kind: "tool", resultStep: step, resultMetadata: metadata });
  return true;
};

const createActivityEntries = (
  partition: PartitionedActivitySteps,
): (SingleActivityEntry | SubagentActivityEntry)[] => {
  const entries: (SingleActivityEntry | SubagentActivityEntry)[] = [];
  const pendingToolEntries = new Map<string, number>();
  const latestPlanProgressStepId = partition.mainSteps.findLast((step) => step.eventType === "plan-progress")?.id;

  for (const step of partition.mainSteps) {
    if (step.eventType === "plan-progress" && step.id !== latestPlanProgressStepId) continue;
    if (appendSubagentEntry(entries, partition, step)) continue;

    const metadata = safeParseMetadata(step.metadataJson);
    if (appendToolEntry(entries, pendingToolEntries, step, metadata)) continue;
    entries.push({ kind: "single", step, metadata });
  }
  return entries;
};

const groupActivityEntries = (
  entries: (SingleActivityEntry | SubagentActivityEntry)[],
): ActivityEntryPreMerge[] => {
  const groupedEntries: ActivityEntryPreMerge[] = [];
  for (const entry of moveShellApprovalsBeforeMatchingTools(entries)) {
    const previousEntry = groupedEntries[groupedEntries.length - 1];
    if (entry.kind === "tool") {
      if (previousEntry?.kind === "tool-batch") previousEntry.items.push(entry);
      else groupedEntries.push({ kind: "tool-batch", items: [entry] });
      continue;
    }
    if (entry.kind === "single" && entry.step.eventType === "diff-updated") {
      if (previousEntry?.kind === "diff-batch") previousEntry.items.push(entry);
      else groupedEntries.push({ kind: "diff-batch", items: [entry] });
      continue;
    }
    groupedEntries.push(entry);
  }
  return groupedEntries;
};

// Exported for focused virtualization model tests.
export const buildActivityEntries = (
  steps: RunActivityStep[],
  options: { extractSubagents?: boolean; runActive?: boolean } = {},
): ActivityEntry[] => {
  const extractSubagents = options.extractSubagents !== false;
  const partition = partitionActivitySteps(steps, extractSubagents, options.runActive);
  const entries = createActivityEntries(partition);
  return mergeConsecutiveSingles(groupActivityEntries(entries));
};

// Derives the latest state of every subagent in a run, for header badges.
// Exported for focused renderer behavior tests.
export const deriveRunSubagents = (
  steps: Pick<RunActivityStep, "metadataJson">[],
  options: { runActive?: boolean } = {},
): RunSubagentInfo[] => {
  const byId = new Map<string, RunSubagentInfo>();
  for (const step of steps) {
    const info = normalizeRunSubagentInfo(safeParseMetadata(step.metadataJson).subagent);
    if (info) {
      byId.set(info.id, coerceStoppedSubagentInfo(info, options.runActive));
    }
  }
  return [...byId.values()];
};

