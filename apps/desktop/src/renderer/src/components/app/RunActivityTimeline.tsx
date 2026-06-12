import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  extractAttachmentNamesFromMetadata,
  extractAttachmentPayloadsFromMetadata,
  type RunEventType,
  type RunMode,
  type RunStatus,
  type RunTimelineDensity,
  type RunUserInputAnswers,
  type RunUserInputQuestion,
} from "@buildwarden/shared";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  MessageSquareText,
  RotateCcw,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { ActivityMarkdownOrGitDiff } from "./activity-message-body";
import { AgentChip, AgentLogRow, AgentPanel, AgentWorklog } from "./agent-worklog";
import { GitDiffPreview } from "./git-diff-preview";
import { looksLikeGitDiff } from "./git-diff-utils";
import { RunPlanDecisionCard } from "./RunPlanDecisionCard";
import { RunPlanSteps } from "./RunPlanSteps";
import { RunUserInputRequestCard } from "./RunUserInputRequestCard";
import { StoredChatAttachments } from "./StoredChatAttachments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export type RunActivityStep = {
  id: string;
  eventType: RunEventType;
  title: string;
  content: string;
  metadataJson: string;
  createdAt: string;
};

export type RunActivityRun = {
  id: string;
  status: RunStatus;
  mode: RunMode;
};

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

const readUserInputQuestions = (metadata: Record<string, unknown>): RunUserInputQuestion[] => {
  const questions = metadata.userInputQuestions;
  return Array.isArray(questions) ? questions.filter(isUserInputQuestion) : [];
};

const readUserInputAnswers = (metadata: Record<string, unknown>): RunUserInputAnswers | null => {
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

const shouldAutoCollapseReasoning = (content: string) => {
  const lineCount = content.split(/\r?\n/).length;
  return lineCount > 7 || content.trim().length > 700;
};

const isRunCompletionStatus = (step: RunActivityStep) => {
  if (step.eventType !== "status") return false;
  const text = `${step.title} ${step.content}`.toLowerCase();
  return text.includes("run completed") || text.includes("completed successfully");
};

const TOOL_BATCH_MERGE_BY_PATH = new Set(["read_file"]);

type ToolBatchSummarizedRow = {
  toolName: string;
  detail: string | null;
  toolCallId?: string | null;
  command?: string | null;
  paths?: string[];
  count: number;
  failed: boolean;
  shellStreaming?: boolean;
  preview: string | null;
  writeFileDiff: string | null;
  createdAt: string;
};

type SingleActivityEntry =
  | {
      kind: "single";
      step: RunActivityStep;
      metadata: Record<string, unknown>;
    }
  | {
      kind: "tool";
      callStep?: RunActivityStep;
      callMetadata?: Record<string, unknown>;
      resultStep?: RunActivityStep;
      resultMetadata?: Record<string, unknown>;
    };

type ActivityGroupKey = "user" | "status" | "assistant";

type ActivityEntry =
  | SingleActivityEntry
  | {
      kind: "tool-batch";
      items: Extract<SingleActivityEntry, { kind: "tool" }>[];
    }
  | {
      kind: "diff-batch";
      items: Extract<SingleActivityEntry, { kind: "single" }>[];
    }
  | {
      kind: "single-group";
      groupKey: ActivityGroupKey;
      items: Extract<SingleActivityEntry, { kind: "single" }>[];
    };

type ActivityEntryPreMerge = Exclude<ActivityEntry, { kind: "single-group" }>;

type TimelineRenderItem =
  | {
      kind: "entry";
      key: string;
      entry: ActivityEntry;
    }
  | {
      kind: "plan-decision";
      key: string;
      planText: string;
    }
  | {
      kind: "loading";
      key: string;
    }
  | {
      kind: "end";
      key: string;
    };

const assignTimelineRef = (ref: Ref<HTMLDivElement> | undefined, node: HTMLDivElement | null) => {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(node);
    return;
  }
  (ref as { current: HTMLDivElement | null }).current = node;
};

const getActivityEntryKey = (entry: ActivityEntry, index: number) => {
  if (entry.kind === "tool-batch") {
    const first = entry.items[0];
    const id = first?.callStep?.id ?? first?.resultStep?.id ?? `tool-batch-${index}`;
    return `${id}-tools-${entry.items.length}`;
  }
  if (entry.kind === "diff-batch") {
    const first = entry.items[0];
    return `${first?.step.id ?? `diff-batch-${index}`}-diffs-${entry.items.length}`;
  }
  if (entry.kind === "single-group") {
    const first = entry.items[0]?.step.id ?? `single-group-${index}`;
    return `${first}-${entry.groupKey}-${entry.items.length}`;
  }
  if (entry.kind === "tool") {
    return entry.callStep?.id ?? entry.resultStep?.id ?? `tool-${index}`;
  }
  return entry.step.id;
};

// Exported for focused virtualization model tests.
// eslint-disable-next-line react-refresh/only-export-components
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
      key: `plan-decision-${density}-${items.length}`,
      planText: latestPlanDecisionText,
    });
  }

  if (showLoading) {
    items.push({
      kind: "loading",
      key: `loading-${density}-${items.length}`,
    });
  }

  items.push({
    kind: "end",
    key: `timeline-end-spacer-${density}`,
  });

  return items;
};

const estimateTimelineItemSize = (item: TimelineRenderItem | undefined, density: RunTimelineDensity) => {
  if (!item) return 80;
  if (item.kind === "end") return density === "compact" ? 8 : 18;
  if (item.kind === "loading") return 62;
  if (item.kind === "plan-decision") return 170;

  const { entry } = item;
  if (entry.kind === "tool-batch") {
    return Math.min(420, 42 + entry.items.length * (density === "detailed" ? 34 : 24));
  }
  if (entry.kind === "diff-batch") {
    return Math.min(360, 42 + entry.items.length * 34);
  }
  if (entry.kind === "tool") {
    return 48;
  }
  if (entry.kind === "single-group") {
    if (entry.groupKey === "status") return 42 + entry.items.length * 22;
    if (entry.groupKey === "user") return 104 + entry.items.length * 48;
    return density === "detailed" ? 260 : 190;
  }

  if (entry.step.eventType === "status") return 64;
  if (entry.step.eventType === "request" || entry.step.eventType === "user-input-requested") return 190;
  if (entry.step.eventType === "approval-requested" || entry.step.eventType === "approval-resolved") return 130;
  if (entry.step.eventType === "plan" || entry.step.eventType === "plan-updated" || entry.step.eventType === "diff-updated") {
    return 260;
  }
  if (entry.step.eventType === "error") return 120;

  return density === "detailed" ? 240 : 170;
};

const measureTimelineRowElement = (element: HTMLElement) => {
  const child = element.firstElementChild;
  if (child instanceof HTMLElement) {
    const childStyle = window.getComputedStyle(child);
    const marginTop = Number.parseFloat(childStyle.marginTop) || 0;
    const marginBottom = Number.parseFloat(childStyle.marginBottom) || 0;
    return Math.max(1, Math.ceil(child.getBoundingClientRect().height + marginTop + marginBottom));
  }
  return Math.max(1, Math.ceil(element.getBoundingClientRect().height));
};

const describeActivityDetail = (metadata: Record<string, unknown> | undefined) =>
  ((metadata?.source === "user"
    ? metadata.commandType === "follow-up"
      ? "User follow-up command"
      : "Initial user command"
    : null) ??
    metadata?.path ??
    metadata?.command ??
    metadata?.query ??
    metadata?.toolName) as string | null;

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

const moveShellApprovalsBeforeMatchingTools = (entries: SingleActivityEntry[]): SingleActivityEntry[] => {
  const out: SingleActivityEntry[] = [];

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

const getLatestPlanDecisionText = (entries: ActivityEntry[], fallbackMode: RunMode) => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    if (entry.kind === "single-group" && entry.groupKey === "assistant") {
      const planItems = entry.items.filter(({ step, metadata }) => {
        const mode = (metadata.mode as RunMode) ?? fallbackMode;
        return mode === "plan" && metadata.assistantKind !== "reasoning" && step.content.trim().length > 0;
      });
      const content = planItems.map(({ step }) => step.content.trim()).filter(Boolean).join("\n\n");
      if (content) {
        return content;
      }
      continue;
    }

    if (entry.kind === "single") {
      const mode = (entry.metadata.mode as RunMode) ?? fallbackMode;
      const isAssistant = entry.step.eventType === "output" || (entry.step.eventType === "log" && entry.metadata.source !== "user");
      if (mode === "plan" && isAssistant && entry.metadata.assistantKind !== "reasoning" && entry.step.content.trim()) {
        return entry.step.content.trim();
      }
    }
  }

  return null;
};

const runModeBadgeClassName = (mode: RunMode) => {
  if (mode === "code") {
    return "bg-cyan-500/10 text-cyan-300 ring-cyan-400/30";
  }

  if (mode === "plan") {
    return "bg-violet-500/10 text-violet-300 ring-violet-400/30";
  }

  return "bg-zinc-500/10 text-zinc-300 ring-zinc-400/30";
};

// Exported for focused virtualization model tests.
// eslint-disable-next-line react-refresh/only-export-components
export const buildActivityEntries = (steps: RunActivityStep[]) => {
  const entries: SingleActivityEntry[] = [];
  const pendingToolEntries = new Map<string, number>();

  for (const step of steps) {
    const metadata = safeParseMetadata(step.metadataJson);
    const callId = typeof metadata.callId === "string" ? metadata.callId : null;

    if (step.eventType === "tool-call") {
      if (callId) {
        pendingToolEntries.set(callId, entries.length);
      }
      entries.push({
        kind: "tool",
        callStep: step,
        callMetadata: metadata,
      });
      continue;
    }

    if ((step.eventType === "tool-result" || step.eventType === "tool-progress") && callId) {
      const entryIndex = pendingToolEntries.get(callId);
      const existing = entryIndex == null ? null : entries[entryIndex];
      if (entryIndex != null && existing?.kind === "tool") {
        entries[entryIndex] = {
          ...existing,
          resultStep: step,
          resultMetadata: metadata,
        };
        if (step.eventType === "tool-result") {
          pendingToolEntries.delete(callId);
        }
        continue;
      }
    }

    if (step.eventType === "tool-result" || step.eventType === "tool-progress") {
      entries.push({
        kind: "tool",
        resultStep: step,
        resultMetadata: metadata,
      });
      continue;
    }

    entries.push({
      kind: "single",
      step,
      metadata,
    });
  }

  const groupedEntries: ActivityEntryPreMerge[] = [];
  for (const entry of moveShellApprovalsBeforeMatchingTools(entries)) {
    const previousEntry = groupedEntries[groupedEntries.length - 1];
    if (entry.kind === "tool") {
      if (previousEntry?.kind === "tool-batch") {
        previousEntry.items.push(entry);
      } else {
        groupedEntries.push({
          kind: "tool-batch",
          items: [entry],
        });
      }
      continue;
    }
    if (entry.kind === "single" && entry.step.eventType === "diff-updated") {
      if (previousEntry?.kind === "diff-batch") {
        previousEntry.items.push(entry);
      } else {
        groupedEntries.push({
          kind: "diff-batch",
          items: [entry],
        });
      }
      continue;
    }
    groupedEntries.push(entry);
  }

  return mergeConsecutiveSingles(groupedEntries);
};

const ActivityToolBatchRow = ({
  item,
  itemIndex,
  run,
  density,
  busy,
  readOnly,
  onCancelRunShell,
}: {
  item: ToolBatchSummarizedRow;
  itemIndex: number;
  run: RunActivityRun;
  density: RunTimelineDensity;
  busy: boolean;
  readOnly: boolean;
  onCancelRunShell?: (run: RunActivityRun, toolCallId: string) => void;
}) => {
  const [writeFileDiffExpanded, setWriteFileDiffExpanded] = useState(false);
  const isCompact = density === "compact";
  const isDetailed = density === "detailed";
  const shellLineCount = item.toolName === "run_shell" && item.preview ? item.preview.split(/\r?\n/).length : 0;
  const hasInlineDiff = !item.failed && Boolean(item.writeFileDiff) && looksLikeGitDiff(item.writeFileDiff ?? "");
  const hasExpandableContent = Boolean(item.preview) || Boolean(item.paths?.length);
  const renderDetachedPreview = Boolean(item.preview) && !hasExpandableContent;
  const canCancelShell =
    !readOnly &&
    item.toolName === "run_shell" &&
    item.shellStreaming === true &&
    typeof item.toolCallId === "string" &&
    ["queued", "preparing", "running"].includes(run.status) &&
    Boolean(onCancelRunShell);

  return (
    <div
      key={`${item.toolName}-${item.detail ?? "detail"}-${itemIndex}`}
      className={cn("agent-tool-row min-w-0 w-full", item.failed ? "agent-tool-row--failed" : null)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {hasExpandableContent ? (
            <details className="agent-tool-details group w-full max-w-full">
              <summary className={cn("agent-tool-trigger", item.shellStreaming && "agent-tool-trigger--live")}>
                <ChevronDown className="h-3 w-3 shrink-0 text-[color:var(--ec-faint)] transition group-open:rotate-180" />
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: item.failed ? "var(--ec-danger)" : item.shellStreaming ? "var(--ec-accent)" : "var(--ec-faint)" }}
                />
                <span className="shrink-0 font-semibold text-[color:var(--ec-text)]">{item.toolName}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--ec-muted)]">
                  {item.command ?? item.detail ?? (item.paths?.length ? `${item.paths.length} files` : "")}
                </span>
                {item.count > 1 ? <span className="shrink-0 text-[10px] text-[color:var(--ec-faint)]">x{item.count}</span> : null}
                {item.toolName === "run_shell" && item.preview && !isCompact ? (
                  <span className="agent-tool-extra shrink-0 text-[10px] text-[color:var(--ec-faint)]">
                    {item.shellStreaming ? "live" : "output"} - {shellLineCount} line{shellLineCount === 1 ? "" : "s"}
                  </span>
                ) : null}
                {item.shellStreaming ? <span className="agent-tool-live-dots" aria-hidden /> : null}
              </summary>
              {item.paths && item.paths.length > 0 ? (
                <ul className="app-scrollbar mt-1 grid max-h-40 list-none grid-cols-1 gap-x-4 gap-y-0.5 overflow-y-auto border-l border-[color:var(--ec-border)] py-0.5 pl-3 font-mono text-[10px] leading-snug text-[color:var(--ec-muted)] sm:max-h-48 sm:grid-cols-2 xl:grid-cols-3">
                  {item.paths.map((p, pi) => (
                    <li key={`${String(pi)}-${p.slice(0, 80)}`} className="min-w-0 break-words" title={p}>
                      {p}
                    </li>
                  ))}
                </ul>
              ) : null}
              {item.preview ? (
                <pre
                  className={cn(
                    "agent-pre app-scrollbar mt-1 max-h-[min(70vh,36rem)] overflow-auto whitespace-pre-wrap break-words text-[10px] leading-snug",
                    item.failed ? "border-[color:var(--ec-danger-ring)]" : null,
                  )}
                >
                  {item.preview}
                </pre>
              ) : null}
              {isDetailed ? (
                <div className="agent-tool-meta">
                  <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
                  <span>{item.failed ? "failed" : item.shellStreaming ? "running" : "finished"}</span>
                  {item.toolCallId ? <span className="truncate">call {item.toolCallId}</span> : null}
                </div>
              ) : null}
            </details>
          ) : (
            <div className={cn("agent-tool-trigger agent-tool-trigger--static", item.shellStreaming && "agent-tool-trigger--live")}>
              <span className="h-3 w-3 shrink-0" aria-hidden />
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: item.failed ? "var(--ec-danger)" : item.shellStreaming ? "var(--ec-accent)" : "var(--ec-faint)" }}
              />
              <span className="shrink-0 font-semibold text-[color:var(--ec-text)]">{item.toolName}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--ec-muted)]">{item.command ?? item.detail}</span>
              {item.count > 1 ? <span className="shrink-0 text-[10px] text-[color:var(--ec-faint)]">x{item.count}</span> : null}
              {item.shellStreaming ? <span className="agent-tool-live-dots" aria-hidden /> : null}
            </div>
          )}
          {!hasExpandableContent && isDetailed ? (
            <div className="agent-tool-meta">
              <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
              <span>{item.failed ? "failed" : item.shellStreaming ? "running" : "finished"}</span>
              {item.toolCallId ? <span className="truncate">call {item.toolCallId}</span> : null}
            </div>
          ) : null}
        </div>
        {canCancelShell || hasInlineDiff ? (
          <div className="flex shrink-0 flex-col items-end gap-1">
            {canCancelShell ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 border-[color:var(--ec-danger-ring)] bg-[color:var(--ec-danger-soft)] px-2 text-[10px] text-[color:var(--ec-danger)] hover:bg-[color:var(--ec-danger-soft)]"
                disabled={busy}
                onClick={() => onCancelRunShell?.(run, item.toolCallId!)}
              >
                Cancel
              </Button>
            ) : null}
            {hasInlineDiff ? (
              <button
                type="button"
                className="rounded px-0.5 py-0.5 text-[color:var(--ec-muted)] transition hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
                onClick={() => setWriteFileDiffExpanded((current) => !current)}
                aria-label={writeFileDiffExpanded ? "Collapse diff" : "Expand diff"}
                title={writeFileDiffExpanded ? "Collapse diff" : "Expand diff"}
              >
                {writeFileDiffExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {renderDetachedPreview ? (
        item.toolName === "run_shell" ? (
          <details className="group mt-1 w-full max-w-full">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] text-[color:var(--ec-faint)] hover:text-[color:var(--ec-text)] [&::-webkit-details-marker]:hidden">
              <ChevronDown className="h-3 w-3 shrink-0 transition group-open:rotate-180" />
              <Terminal className="h-3 w-3 shrink-0" aria-hidden />
              <span className="font-medium text-[color:var(--ec-muted)]">{item.shellStreaming ? "Live output" : "Console output"}</span>
              <span>
                - {shellLineCount} line{shellLineCount === 1 ? "" : "s"}
              </span>
            </summary>
            <pre
              className={cn(
                "agent-pre app-scrollbar mt-1 max-h-[min(70vh,36rem)] overflow-auto whitespace-pre-wrap break-words text-[10px] leading-snug",
                item.failed ? "border-[color:var(--ec-danger-ring)]" : null,
              )}
            >
              {item.preview}
            </pre>
          </details>
        ) : (
          <pre className="agent-pre app-scrollbar mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words border-[color:var(--ec-danger-ring)] text-[10px] leading-snug">
            {item.preview}
          </pre>
        )
      ) : null}
      {hasInlineDiff && writeFileDiffExpanded && item.writeFileDiff ? (
        <div className="mt-1.5 min-w-0 w-full">
          <GitDiffPreview
            diffText={item.writeFileDiff}
            emptyMessage="Could not parse file diff."
            compact={density !== "detailed"}
            viewType="unified"
            activityEmphasis
            hideFileHeader
            alwaysExpandedFileSections
          />
        </div>
      ) : null}
    </div>
  );
};

type DiffBatchSummarizedRow = {
  id: string;
  title: string;
  toolName: string;
  path: string | null;
  content: string;
  createdAt: string;
};

const ActivityDiffBatchRow = ({
  item,
  density,
}: {
  item: DiffBatchSummarizedRow;
  density: RunTimelineDensity;
}) => {
  const hasContent = item.content.trim().length > 0;
  const detail = item.path ?? item.title.replace(/^Diff updated:\s*/i, "");

  return (
    <div className="agent-tool-row min-w-0 w-full">
      {hasContent ? (
        <details className="agent-tool-details group w-full max-w-full">
          <summary className="agent-tool-trigger">
            <ChevronDown className="h-3 w-3 shrink-0 text-[color:var(--ec-faint)] transition group-open:rotate-180" />
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--ec-info)]" />
            <span className="shrink-0 font-semibold text-[color:var(--ec-text)]">{item.toolName}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--ec-muted)]">{detail}</span>
          </summary>
          <div className="mt-1.5 rounded-md border border-[color:var(--ec-border)] bg-[color:var(--ec-panel-muted)] px-2 py-1.5">
            {looksLikeGitDiff(item.content) ? (
              <GitDiffPreview
                diffText={item.content}
                emptyMessage="Could not parse file diff."
                compact={density !== "detailed"}
                viewType="unified"
                activityEmphasis
                hideFileHeader
                alwaysExpandedFileSections
              />
            ) : (
              <ActivityMarkdownOrGitDiff content={item.content} compact={density !== "detailed"} className="text-[color:var(--ec-text)]" />
            )}
          </div>
        </details>
      ) : (
        <div className="agent-tool-trigger agent-tool-trigger--static">
          <span className="h-3 w-3 shrink-0" aria-hidden />
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--ec-info)]" />
          <span className="shrink-0 font-semibold text-[color:var(--ec-text)]">{item.toolName}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--ec-muted)]">{detail}</span>
        </div>
      )}
    </div>
  );
};

export function RunActivityTimeline({
  steps,
  run,
  className,
  endClassName,
  emptyMessage = "No activity recorded.",
  readOnly = false,
  density = "comfortable",
  busy = false,
  showLoading = false,
  runDurationLabel = null,
  restorablePromptStepId = null,
  copiedStepId,
  expandedReasoningStepIds,
  containerRef,
  endRef,
  virtualized = false,
  onCopyStepContent,
  onUndoRunToLastPrompt,
  onCancelRunShell,
  onPreparePlanContinuation,
  onSubmitPlanFeedback,
  onSubmitUserInputAnswers,
  onToggleReasoningStep,
}: {
  steps: RunActivityStep[];
  run: RunActivityRun;
  className?: string;
  endClassName?: string;
  emptyMessage?: string;
  readOnly?: boolean;
  density?: RunTimelineDensity;
  busy?: boolean;
  showLoading?: boolean;
  runDurationLabel?: string | null;
  restorablePromptStepId?: string | null;
  copiedStepId?: string | null;
  expandedReasoningStepIds?: Record<string, boolean>;
  containerRef?: Ref<HTMLDivElement>;
  endRef?: Ref<HTMLDivElement>;
  virtualized?: boolean;
  onCopyStepContent?: (text: string, stepId: string) => void | Promise<void>;
  onUndoRunToLastPrompt?: (run: RunActivityRun) => void;
  onCancelRunShell?: (run: RunActivityRun, toolCallId: string) => void;
  onPreparePlanContinuation?: (plan: string) => void;
  onSubmitPlanFeedback?: (feedback: string) => Promise<void>;
  onSubmitUserInputAnswers?: (run: RunActivityRun, requestId: string, answers: RunUserInputAnswers) => Promise<void> | void;
  onToggleReasoningStep?: (stepId: string) => void;
}) {
  const [internalCopiedStepId, setInternalCopiedStepId] = useState<string | null>(null);
  const [internalExpandedReasoningStepIds, setInternalExpandedReasoningStepIds] = useState<Record<string, boolean>>({});
  const activityEntries = useMemo(() => buildActivityEntries(steps), [steps]);
  const activeCopiedStepId = copiedStepId ?? internalCopiedStepId;
  const activeReasoningStepIds = expandedReasoningStepIds ?? internalExpandedReasoningStepIds;
  const isRunActive = ["queued", "preparing", "running"].includes(run.status);
  const latestPlanDecisionText = useMemo(
    () => getLatestPlanDecisionText(activityEntries, run.mode),
    [activityEntries, run.mode],
  );
  const canShowPlanDecision =
    !readOnly &&
    !isRunActive &&
    Boolean(onPreparePlanContinuation && onSubmitPlanFeedback && latestPlanDecisionText?.trim());
  const compactContent = density !== "detailed";
  const rowTime = (time: string | null | undefined) => (density === "compact" ? null : time);
  const stepMeasurementSignature = useMemo(
    () => steps.map((step) => `${step.id}:${step.eventType}:${step.title.length}:${step.content.length}:${step.metadataJson.length}`).join("|"),
    [steps],
  );

  const copyStepContent = async (text: string, stepId: string) => {
    if (onCopyStepContent) {
      await onCopyStepContent(text, stepId);
      return;
    }
    await navigator.clipboard.writeText(text);
    setInternalCopiedStepId(stepId);
    window.setTimeout(() => {
      setInternalCopiedStepId((current) => (current === stepId ? null : current));
    }, 1500);
  };

  const toggleReasoningStep = (stepId: string) => {
    if (onToggleReasoningStep) {
      onToggleReasoningStep(stepId);
      return;
    }
    setInternalExpandedReasoningStepIds((current) => ({
      ...current,
      [stepId]: !current[stepId],
    }));
  };

  const timelineItems = useMemo(
    () =>
      buildTimelineRenderItems({
        entries: activityEntries,
        density,
        canShowPlanDecision,
        latestPlanDecisionText,
        showLoading,
      }),
    [activityEntries, canShowPlanDecision, density, latestPlanDecisionText, showLoading],
  );
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const setWorklogRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollElementRef.current = node;
      assignTimelineRef(containerRef, node);
    },
    [containerRef],
  );
  const rowVirtualizer = useVirtualizer({
    count: timelineItems.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: (index) => estimateTimelineItemSize(timelineItems[index], density),
    getItemKey: (index) => timelineItems[index]?.key ?? index,
    measureElement: (element) => {
      return element instanceof HTMLElement ? measureTimelineRowElement(element) : 1;
    },
    useAnimationFrameWithResizeObserver: true,
    overscan: 10,
  });

  useEffect(() => {
    shouldStickToBottomRef.current = true;
  }, [run.id]);

  useEffect(() => {
    if (!virtualized) {
      return;
    }
    const container = scrollElementRef.current;
    if (!container) {
      return;
    }
    const updateStickiness = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      shouldStickToBottomRef.current = distanceFromBottom < 140;
    };
    updateStickiness();
    container.addEventListener("scroll", updateStickiness, { passive: true });
    return () => container.removeEventListener("scroll", updateStickiness);
  }, [virtualized]);

  const measureVisibleVirtualRows = useCallback(() => {
    const container = scrollElementRef.current;
    if (!container) {
      return;
    }
    container.querySelectorAll<HTMLElement>(".agent-virtual-row[data-index]").forEach((row) => {
      const index = Number(row.dataset.index);
      if (!Number.isFinite(index)) {
        return;
      }
      rowVirtualizer.resizeItem(index, measureTimelineRowElement(row));
    });
  }, [rowVirtualizer]);

  useLayoutEffect(() => {
    if (!virtualized) {
      return;
    }
    rowVirtualizer.measure();
    measureVisibleVirtualRows();
    const frame = window.requestAnimationFrame(measureVisibleVirtualRows);
    return () => window.cancelAnimationFrame(frame);
  }, [density, measureVisibleVirtualRows, rowVirtualizer, run.id, virtualized]);

  useLayoutEffect(() => {
    if (!virtualized) {
      return;
    }
    measureVisibleVirtualRows();
    const frame = window.requestAnimationFrame(measureVisibleVirtualRows);
    return () => window.cancelAnimationFrame(frame);
  }, [activeReasoningStepIds, measureVisibleVirtualRows, stepMeasurementSignature, timelineItems.length, virtualized]);

  useEffect(() => {
    if (!virtualized || !isRunActive || !shouldStickToBottomRef.current || timelineItems.length === 0) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(timelineItems.length - 1, { align: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isRunActive, rowVirtualizer, run.status, run.id, stepMeasurementSignature, steps.length, timelineItems.length, virtualized]);

  const renderActivityEntry = (entry: ActivityEntry): ReactNode => {
        if (entry.kind === "diff-batch") {
          const summarizedItems = entry.items.map<DiffBatchSummarizedRow>(({ step, metadata }) => {
            const toolName = typeof metadata.toolName === "string" ? metadata.toolName : step.title.replace(/^Diff updated:\s*/i, "") || "diff";
            const path = typeof metadata.path === "string" ? metadata.path : null;
            const content = typeof metadata.writeFileUnifiedDiff === "string" ? metadata.writeFileUnifiedDiff : step.content;
            return {
              id: step.id,
              title: step.title,
              toolName,
              path,
              content,
              createdAt: step.createdAt,
            };
          });
          const latestTimestamp = summarizedItems[summarizedItems.length - 1]?.createdAt ?? entry.items[0]?.step.createdAt;

          return (
            <AgentLogRow
              key={`${entry.items[0]?.step.id ?? "diff-batch"}-${entry.items.length}`}
              tone="diff"
              label={`Diffs (${entry.items.length})`}
              time={rowTime(latestTimestamp ? new Date(latestTimestamp).toLocaleTimeString() : null)}
            >
              <div className="agent-tool-stack agent-tool-stack--bare">
                {summarizedItems.map((item) => (
                  <ActivityDiffBatchRow key={item.id} item={item} density={density} />
                ))}
              </div>
            </AgentLogRow>
          );
        }

        if (entry.kind === "tool-batch") {
          const summarizedItems = entry.items.reduce<ToolBatchSummarizedRow[]>((rows, item) => {
            const callMetadata = item.callMetadata ?? {};
            const resultMetadata = item.resultMetadata ?? {};
            const toolName = String(callMetadata.toolName ?? resultMetadata.toolName ?? "tool");
            const detail = describeActivityDetail(resultMetadata) ?? describeActivityDetail(callMetadata);
            const failed = resultMetadata.ok === false;
            const shellStreaming = resultMetadata.shellStreaming === true;
            const toolCallId =
              typeof resultMetadata.callId === "string"
                ? resultMetadata.callId
                : typeof callMetadata.callId === "string"
                  ? callMetadata.callId
                  : null;
            const command =
              typeof resultMetadata.command === "string"
                ? resultMetadata.command
                : typeof callMetadata.command === "string"
                  ? callMetadata.command
                  : null;
            const preview = failed
              ? item.resultStep?.content ?? item.callStep?.content ?? null
              : toolName === "run_shell"
                ? (item.resultStep?.content ?? "").trim() || null
                : item.resultStep?.content && looksLikeGitDiff(item.resultStep.content)
                  ? item.resultStep.content
                  : null;
            const writeFileDiff =
              !failed && toolName === "write_file" && typeof resultMetadata.writeFileUnifiedDiff === "string"
                ? resultMetadata.writeFileUnifiedDiff
                : null;
            const createdAt = (item.resultStep ?? item.callStep)?.createdAt ?? new Date().toISOString();
            const previousRow = rows[rows.length - 1];
            const pathKey = detail?.trim() ?? "";
            const canMergeSamePath =
              toolName !== "write_file" &&
              toolName !== "run_shell" &&
              previousRow &&
              previousRow.toolName === toolName &&
              previousRow.detail === detail &&
              previousRow.failed === failed &&
              !previousRow.paths?.length;
            const canMergeReadFileRun =
              TOOL_BATCH_MERGE_BY_PATH.has(toolName) &&
              pathKey.length > 0 &&
              previousRow &&
              previousRow.toolName === toolName &&
              previousRow.failed === failed;

            if (canMergeSamePath) {
              previousRow.count += 1;
              previousRow.createdAt = createdAt;
              previousRow.toolCallId = toolCallId ?? previousRow.toolCallId;
              previousRow.command = command ?? previousRow.command;
              previousRow.shellStreaming = shellStreaming || previousRow.shellStreaming;
              previousRow.preview = preview ?? previousRow.preview;
              return rows;
            }

            if (canMergeReadFileRun) {
              const existingPaths = previousRow.paths ?? (previousRow.detail ? [previousRow.detail] : []);
              previousRow.paths = [...existingPaths, pathKey];
              previousRow.detail = null;
              previousRow.count += 1;
              previousRow.createdAt = createdAt;
              previousRow.toolCallId = toolCallId ?? previousRow.toolCallId;
              previousRow.command = command ?? previousRow.command;
              previousRow.shellStreaming = shellStreaming || previousRow.shellStreaming;
              previousRow.preview = preview ?? previousRow.preview;
              previousRow.writeFileDiff = writeFileDiff ?? previousRow.writeFileDiff;
              return rows;
            }

            rows.push({
              toolName,
              detail: pathKey ? detail : null,
              toolCallId,
              count: 1,
              failed,
              command,
              shellStreaming,
              preview,
              writeFileDiff,
              createdAt,
            });

            return rows;
          }, []);
          const latestTimestamp = summarizedItems[summarizedItems.length - 1]?.createdAt ?? entry.items[0]?.callStep?.createdAt;

          return (
            <AgentLogRow
              key={`${entry.items[0]?.callStep?.id ?? entry.items[0]?.resultStep?.id ?? "tool-batch"}-${entry.items.length}`}
              tone="tools"
              label={`Tools (${entry.items.length})`}
              time={rowTime(latestTimestamp ? new Date(latestTimestamp).toLocaleTimeString() : null)}
            >
              <div className="agent-tool-stack agent-tool-stack--bare">
                {summarizedItems.map((item, index) => (
                  <ActivityToolBatchRow
                    key={`${item.toolName}-${item.detail ?? "detail"}-${index}`}
                    item={item}
                    itemIndex={index}
                    run={run}
                    density={density}
                    busy={busy}
                    readOnly={readOnly}
                    onCancelRunShell={onCancelRunShell}
                  />
                ))}
              </div>
            </AgentLogRow>
          );
        }

        if (entry.kind === "tool") {
          return null;
        }

        if (entry.kind === "single-group") {
          const first = entry.items[0]!;
          const last = entry.items[entry.items.length - 1]!;
          const t0 = new Date(first.step.createdAt).toLocaleTimeString();
          const t1 = new Date(last.step.createdAt).toLocaleTimeString();
          const timeRange = entry.items.length > 1 && t0 !== t1 ? `${t0}-${t1}` : t0;
          const groupKey = `sg-${first.step.id}-${entry.groupKey}-${entry.items.length}`;

          if (entry.groupKey === "status") {
            return (
              <AgentLogRow key={groupKey} tone="status" label="Status" time={rowTime(timeRange)}>
                <AgentPanel tone="status" className="px-2.5 py-1.5">
                  <ul className="space-y-0.5">
                    {entry.items.map(({ step }) => (
                      <li
                        key={step.id}
                        className="flex items-start justify-between gap-2 border-t border-zinc-800/30 pt-0.5 first:border-t-0 first:pt-0"
                      >
                        <span className="min-w-0 flex-1 text-[10px] leading-snug text-zinc-400">
                          <span className="text-zinc-500">{step.title}</span>
                          {step.content ? <span className="text-zinc-500"> - {step.content}</span> : null}
                          {isRunCompletionStatus(step) && runDurationLabel ? (
                            <span className="text-[color:var(--ec-muted)]"> - Duration {runDurationLabel}</span>
                          ) : null}
                        </span>
                        <span className="agent-density-meta shrink-0 text-[10px] text-zinc-600 tabular-nums">
                          {new Date(step.createdAt).toLocaleTimeString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </AgentPanel>
              </AgentLogRow>
            );
          }

          if (entry.groupKey === "user") {
            return (
              <AgentLogRow key={groupKey} tone="prompt" label="Prompt" time={rowTime(timeRange)}>
                <div className="space-y-1">
                  {entry.items.map(({ step, metadata }) => {
                    const mode = (metadata.mode as RunMode) ?? run.mode;
                    const att = extractAttachmentNamesFromMetadata(metadata);
                    const attachments = extractAttachmentPayloadsFromMetadata(metadata);
                    const canUndoPrompt = !readOnly && step.id === restorablePromptStepId && Boolean(onUndoRunToLastPrompt);
                    return (
                      <div key={step.id} className="agent-panel agent-panel--prompt px-2.5 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1">
                            <Badge tone="queued" className="agent-chip--prompt px-1.5 py-0 text-[10px]">
                              {metadata.commandType === "follow-up" ? "follow-up" : "you"}
                            </Badge>
                            <Badge tone="queued" className={`agent-density-meta px-1.5 py-0 text-[10px] ${runModeBadgeClassName(mode)}`}>
                              {mode}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:text-[color:var(--ec-text)]"
                              onClick={() => void copyStepContent(step.content, step.id)}
                              title={activeCopiedStepId === step.id ? "Copied" : "Copy prompt"}
                              aria-label="Copy prompt"
                            >
                              {activeCopiedStepId === step.id ? (
                                <Check className="h-3.5 w-3.5 text-emerald-400" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            {canUndoPrompt ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
                                title="Undo changes since this prompt"
                                aria-label="Undo changes since this prompt"
                                onClick={() => onUndoRunToLastPrompt?.(run)}
                                disabled={busy || isRunActive}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </Button>
                            ) : null}
                            <span className="agent-density-meta text-[10px] text-zinc-500">{new Date(step.createdAt).toLocaleTimeString()}</span>
                          </div>
                        </div>
                        <StoredChatAttachments attachments={attachments} fallbackNames={att} compact={compactContent} />
                        <ActivityMarkdownOrGitDiff content={step.content} compact={compactContent} className="mt-1" />
                      </div>
                    );
                  })}
                </div>
              </AgentLogRow>
            );
          }

          const combinedAnswerText = entry.items.map(({ step }) => step.content).join("\n\n");

          return (
            <AgentLogRow key={groupKey} tone="answer" label="Answer" time={rowTime(timeRange)}>
              <div className="agent-panel agent-panel--answer relative space-y-1.5 px-2 py-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1 z-10 h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
                  onClick={() => void copyStepContent(combinedAnswerText, groupKey)}
                  title={activeCopiedStepId === groupKey ? "Copied" : "Copy response"}
                  aria-label="Copy response"
                >
                  {activeCopiedStepId === groupKey ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
                {entry.items.map(({ step, metadata }, i) => {
                  const detail = describeActivityDetail(metadata);
                  const itemMode = (metadata.mode as RunMode) ?? run.mode;
                  const shouldShowPlanSteps = itemMode === "plan" && metadata.assistantKind !== "reasoning";
                  return (
                    <div key={step.id} className={i === 0 ? "pr-8" : undefined}>
                      {i > 0 ? <div className="mb-1.5 pt-1.5" /> : null}
                      {detail && detail !== step.title ? (
                        <p className="agent-density-detail mb-1 truncate text-[10px] text-zinc-500">{String(detail)}</p>
                      ) : null}
                      {shouldShowPlanSteps ? <RunPlanSteps content={step.content} /> : null}
                      <ActivityMarkdownOrGitDiff content={step.content} compact={compactContent} className="agent-response-text" />
                    </div>
                  );
                })}
              </div>
            </AgentLogRow>
          );
        }

        const detail = describeActivityDetail(entry.metadata);
        const isUserEntry = entry.metadata.source === "user";
        const isAssistantEntry = entry.step.eventType === "output" || (entry.step.eventType === "log" && !isUserEntry);
        const isStatusEntry = entry.step.eventType === "status";
        const isErrorEntry = entry.step.eventType === "error";
        const isRequestEntry =
          entry.step.eventType === "request" ||
          entry.step.eventType === "user-input-requested" ||
          entry.step.eventType === "approval-requested" ||
          entry.step.eventType === "approval-resolved";
        const isPlanEntry = entry.step.eventType === "plan" || entry.step.eventType === "plan-updated";
        const isDiffEntry = entry.step.eventType === "diff-updated";
        const mode = (entry.metadata.mode as RunMode) ?? run.mode;
        const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();

        if (isUserEntry) {
          const att = extractAttachmentNamesFromMetadata(entry.metadata);
          const attachments = extractAttachmentPayloadsFromMetadata(entry.metadata);
          const canUndoPrompt = !readOnly && entry.step.id === restorablePromptStepId && Boolean(onUndoRunToLastPrompt);
          return (
            <AgentLogRow key={entry.step.id} tone="prompt" label="Prompt" time={rowTime(timestamp)}>
              <div className="agent-panel agent-panel--prompt px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <Badge tone="queued" className="agent-chip--prompt px-1.5 py-0 text-[10px]">
                      {entry.metadata.commandType === "follow-up" ? "follow-up" : "you"}
                    </Badge>
                    <Badge tone="queued" className={`agent-density-meta px-1.5 py-0 text-[10px] ${runModeBadgeClassName(mode)}`}>
                      {mode}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:text-[color:var(--ec-text)]"
                      onClick={() => void copyStepContent(entry.step.content, entry.step.id)}
                      title={activeCopiedStepId === entry.step.id ? "Copied" : "Copy prompt"}
                      aria-label="Copy prompt"
                    >
                      {activeCopiedStepId === entry.step.id ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    {canUndoPrompt ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
                        title="Undo changes since this prompt"
                        aria-label="Undo changes since this prompt"
                        onClick={() => onUndoRunToLastPrompt?.(run)}
                        disabled={busy || isRunActive}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    <span className="agent-density-meta text-[10px] text-zinc-500">{timestamp}</span>
                  </div>
                </div>
                <StoredChatAttachments attachments={attachments} fallbackNames={att} compact={compactContent} />
                <ActivityMarkdownOrGitDiff content={entry.step.content} compact={compactContent} className="mt-1 text-zinc-200" />
              </div>
            </AgentLogRow>
          );
        }

        if (isRequestEntry) {
          const requestKind =
            typeof entry.metadata.requestKind === "string"
              ? entry.metadata.requestKind
              : entry.step.eventType.startsWith("approval")
                ? "approval"
                : "user-input";
          const requestResolved = entry.step.eventType === "approval-resolved" || entry.metadata.requestStatus === "resolved";
          const approvalDecision =
            typeof entry.metadata.shellApprovalDecision === "string" ? entry.metadata.shellApprovalDecision : null;
          const approvalMessage =
            typeof entry.metadata.approvalResolutionMessage === "string" ? entry.metadata.approvalResolutionMessage : null;
          const isShellApproval = requestKind === "approval" && typeof entry.metadata.approvalRequestId === "string";
          const userInputRequestId =
            typeof entry.metadata.userInputRequestId === "string"
              ? entry.metadata.userInputRequestId
              : typeof entry.metadata.requestId === "string"
                ? entry.metadata.requestId
                : null;
          const userInputQuestions = readUserInputQuestions(entry.metadata);
          if (!readOnly && requestKind === "user-input" && userInputRequestId && userInputQuestions.length > 0) {
            return (
              <RunUserInputRequestCard
                key={entry.step.id}
                runId={run.id}
                requestId={userInputRequestId}
                title={entry.step.title}
                content={entry.step.content}
                timestamp={timestamp}
                questions={userInputQuestions}
                answers={readUserInputAnswers(entry.metadata)}
                resolved={requestResolved}
                disabled={busy || !isRunActive}
                onSubmitAnswers={
                  onSubmitUserInputAnswers
                    ? (answers) => onSubmitUserInputAnswers(run, userInputRequestId, answers)
                    : undefined
                }
              />
            );
          }
          const decisionLabel =
            approvalDecision === "deny"
              ? "Denied"
              : approvalDecision === "allow-for-run"
                ? "Allowed for run"
                : approvalDecision === "allow-always"
                  ? "Always allowed"
                  : approvalDecision === "allow-once"
                    ? "Allowed once"
                    : null;
          const requestIconClass = requestResolved
            ? "h-3.5 w-3.5 shrink-0 text-[color:var(--ec-faint)]"
            : "h-3.5 w-3.5 shrink-0 text-[color:var(--ec-info)]";
          return (
            <AgentPanel key={entry.step.id} tone="request" className="px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {isShellApproval ? <Terminal className={requestIconClass} /> : <MessageSquareText className={requestIconClass} />}
                  <p className="truncate text-[11px] font-medium text-[color:var(--ec-text)]">{entry.step.title}</p>
                  <Badge tone="queued" className="px-1.5 py-0 text-[10px] bg-[color:var(--ec-info-soft)] text-[color:var(--ec-info)] ring-[color:var(--ec-info-ring)]">
                    {requestKind}
                  </Badge>
                  {decisionLabel ? (
                    <Badge tone={approvalDecision === "deny" ? "failed" : "completed"} className="px-1.5 py-0 text-[10px]">
                      {decisionLabel}
                    </Badge>
                  ) : null}
                </div>
                <span className="agent-density-meta shrink-0 text-[10px] text-[color:var(--ec-faint)]">{timestamp}</span>
              </div>
              {isShellApproval ? (
                <>
                  <pre className="agent-pre app-scrollbar mt-1.5 max-h-28 overflow-auto text-[11px] leading-relaxed">
                    {entry.step.content}
                  </pre>
                  {!requestResolved ? (
                    <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-[color:var(--ec-muted)]">
                      <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--ec-info)]" />
                      <span>{approvalMessage ?? "Waiting for a shell approval decision."}</span>
                    </div>
                  ) : null}
                </>
              ) : (
                <ActivityMarkdownOrGitDiff content={entry.step.content} compact={compactContent} className="mt-1.5 text-[color:var(--ec-text)]" />
              )}
            </AgentPanel>
          );
        }

        if (isPlanEntry) {
          const canContinue = !readOnly && Boolean(onPreparePlanContinuation);
          return (
            <AgentPanel key={entry.step.id} tone="plan" className="px-2.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[color:var(--ec-success)]" />
                  <p className="truncate text-[11px] font-medium text-[color:var(--ec-text)]">{entry.step.title}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  {canContinue ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 rounded-md px-2 text-[10px] text-[color:var(--ec-success)] hover:bg-[color:var(--ec-success-soft)] hover:text-[color:var(--ec-success)]"
                      disabled={busy || isRunActive}
                      onClick={() => onPreparePlanContinuation?.(entry.step.content)}
                    >
                      Continue in code mode
                    </Button>
                  ) : null}
                  <span className="agent-density-meta shrink-0 text-[10px] text-[color:var(--ec-faint)]">{timestamp}</span>
                </div>
              </div>
              <RunPlanSteps content={entry.step.content} />
              <ActivityMarkdownOrGitDiff content={entry.step.content} compact={compactContent} className="mt-1.5 text-[color:var(--ec-text)]" />
            </AgentPanel>
          );
        }

        if (isDiffEntry) {
          return (
            <AgentLogRow key={entry.step.id} tone="diff" label="Diff" time={rowTime(timestamp)}>
              <AgentPanel tone="diff" className="px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-[11px] font-medium text-[color:var(--ec-text)]">{entry.step.title}</p>
                </div>
                {entry.step.content.trim() ? (
                  <ActivityMarkdownOrGitDiff content={entry.step.content} compact={compactContent} className="mt-1.5 text-[color:var(--ec-text)]" />
                ) : null}
              </AgentPanel>
            </AgentLogRow>
          );
        }

        if (isStatusEntry) {
          const statusDurationLabel = isRunCompletionStatus(entry.step) ? runDurationLabel : null;
          return (
            <AgentLogRow key={entry.step.id} tone="status" label="Status" time={rowTime(timestamp)}>
              <AgentPanel tone="status" className="px-2.5 py-1.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] font-medium leading-snug text-[color:var(--ec-text)]">{entry.step.title}</p>
                  {statusDurationLabel ? <AgentChip className="shrink-0">Duration {statusDurationLabel}</AgentChip> : null}
                </div>
                {entry.step.content ? (
                  <p className="mt-0.5 break-words text-[11px] leading-snug text-[color:var(--ec-muted)]">{entry.step.content}</p>
                ) : null}
              </AgentPanel>
            </AgentLogRow>
          );
        }

        if (isErrorEntry) {
          return (
            <AgentPanel key={entry.step.id} tone="error" className="px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium text-[color:var(--ec-danger)]">{entry.step.title}</p>
                <span className="agent-density-meta text-[10px] text-[color:var(--ec-faint)]">{timestamp}</span>
              </div>
              <pre className="agent-pre app-scrollbar mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px]">
                {entry.step.content}
              </pre>
            </AgentPanel>
          );
        }

        if (isAssistantEntry) {
          const isReasoning = entry.metadata.assistantKind === "reasoning";
          const shouldShowPlanSteps = mode === "plan" && !isReasoning;
          const reasoningAutoCollapsed = isReasoning && shouldAutoCollapseReasoning(entry.step.content);
          const reasoningExpanded = Boolean(activeReasoningStepIds[entry.step.id]);
          return (
            <AgentLogRow
              key={entry.step.id}
              tone={isReasoning ? "reasoning" : "answer"}
              label={isReasoning ? "Reason" : "Answer"}
              time={rowTime(timestamp)}
            >
              <div
                className={
                  isReasoning
                    ? "agent-panel agent-panel--reasoning px-2 py-1.5"
                    : "agent-panel agent-panel--answer relative space-y-1.5 px-2 py-1.5"
                }
              >
                {!isReasoning ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 z-10 h-6 w-6 shrink-0 p-0 text-[color:var(--ec-muted)] hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
                    onClick={() => void copyStepContent(entry.step.content, entry.step.id)}
                    title={activeCopiedStepId === entry.step.id ? "Copied" : "Copy response"}
                    aria-label="Copy response"
                  >
                    {activeCopiedStepId === entry.step.id ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                ) : null}
                {isReasoning && reasoningAutoCollapsed ? (
                  <button
                    type="button"
                    className="absolute right-1 top-0 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[color:var(--ec-muted)] transition-colors hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
                    onClick={() => toggleReasoningStep(entry.step.id)}
                    title={reasoningExpanded ? "Collapse reasoning" : "Expand reasoning"}
                  >
                    {reasoningExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                ) : null}
                {detail && detail !== entry.step.title ? (
                  <p className="agent-density-detail mb-1 truncate text-[10px] text-zinc-500">{String(detail)}</p>
                ) : null}
                <div className={!isReasoning ? "pr-8" : undefined}>
                  {isReasoning && reasoningAutoCollapsed && !reasoningExpanded ? (
                    <p className="text-[11px] leading-relaxed text-[color:var(--ec-muted)]">
                      Long reasoning digest collapsed. Expand it when you want the full note.
                    </p>
                  ) : (
                    <>
                      {shouldShowPlanSteps ? <RunPlanSteps content={entry.step.content} /> : null}
                      <ActivityMarkdownOrGitDiff content={entry.step.content} compact={compactContent} className="agent-response-text" />
                    </>
                  )}
                </div>
              </div>
            </AgentLogRow>
          );
        }

        return (
          <div key={entry.step.id} className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-zinc-200">{entry.step.title}</p>
                {detail ? <p className="mt-0.5 truncate text-[10px] text-zinc-400">{String(detail)}</p> : null}
              </div>
              <span className="agent-density-meta shrink-0 text-[10px] text-zinc-500">{timestamp}</span>
            </div>
            <div className="mt-1">
              <ActivityMarkdownOrGitDiff content={entry.step.content} compact={compactContent} className="text-zinc-300" />
            </div>
          </div>
        );
  };

  const renderTimelineItem = (item: TimelineRenderItem): ReactNode => {
    if (item.kind === "entry") {
      return renderActivityEntry(item.entry);
    }

    if (item.kind === "plan-decision") {
      return (
        <AgentLogRow key={item.key} tone="answer" label="Plan decision" time={null}>
          <RunPlanDecisionCard
            disabled={busy || isRunActive}
            onImplement={() => onPreparePlanContinuation?.(item.planText)}
            onSubmitFeedback={onSubmitPlanFeedback!}
          />
        </AgentLogRow>
      );
    }

    if (item.kind === "loading") {
      return (
        <div key={item.key} className="agent-loading">
          <div className="run-activity-loading-bar mb-2" />
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[color:var(--ec-accent)]" aria-hidden />
            <span className="animate-pulse">Agent is working...</span>
          </div>
        </div>
      );
    }

    return <div key={item.key} ref={endRef} className={endClassName} aria-hidden="true" />;
  };

  const worklogClassName = cn(className, `agent-worklog-density--${density}`, virtualized ? "agent-worklog--virtualized" : null);
  const isEmpty = activityEntries.length === 0 && !showLoading;

  if (virtualized) {
    return (
      <AgentWorklog ref={setWorklogRef} className={worklogClassName}>
        {isEmpty ? <div className="agent-worklog-empty">{emptyMessage}</div> : null}
        <div className="agent-virtual-spacer" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const item = timelineItems[virtualRow.index];
            if (!item) {
              return null;
            }
            return (
              <div
                key={virtualRow.key}
                ref={(node) => {
                  rowVirtualizer.measureElement(node);
                  if (node) {
                    rowVirtualizer.resizeItem(virtualRow.index, measureTimelineRowElement(node));
                  }
                }}
                data-index={virtualRow.index}
                className="agent-virtual-row"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderTimelineItem(item)}
              </div>
            );
          })}
        </div>
      </AgentWorklog>
    );
  }

  return (
    <AgentWorklog ref={setWorklogRef} className={worklogClassName}>
      {isEmpty ? <div className="agent-worklog-empty">{emptyMessage}</div> : null}
      {timelineItems.map((item) => renderTimelineItem(item))}
    </AgentWorklog>
  );
}
