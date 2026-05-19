import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  appendChatAttachmentFiles,
  extractAttachmentNamesFromMetadata,
  extractAttachmentPayloadsFromMetadata,
  ChatAttachmentPayload,
  KeyboardShortcutId,
  RunDetail,
  RunRecord,
  RunWorkspacePanelId,
  RunWorkspaceTileSize,
  ShellApprovalDecision,
} from "@easycode/shared";
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Globe,
  Loader2,
  Maximize2,
  MessageSquareText,
  Minimize2,
  PanelBottom,
  PanelRight,
  Plus,
  RotateCcw,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  X,
} from "lucide-react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { buildVisibleConversationHistory } from "../../lib/context-window-estimate";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { ComposerSelect, RunComposer } from "./RunComposer";
import { RunEmbeddedBrowser } from "./RunEmbeddedBrowser";
import { StoredChatAttachments } from "./StoredChatAttachments";
import { RunWorktreeTerminal } from "./RunWorktreeTerminal";
import { ActivityMarkdownOrGitDiff } from "./activity-message-body";
import { DiffReviewPanel, type DiffReviewPanelState } from "./diff-review-panel";
import {
  GitDiffPreview,
  type GitDiffPreviewHandle,
} from "./git-diff-preview";
import { looksLikeGitDiff, summarizeDiffStats } from "./git-diff-utils";
import { cn } from "../../lib/cn";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

type ReviewPanelState = DiffReviewPanelState;

type TilePanelId = RunWorkspacePanelId;

// Kept for interface compatibility with the shared type.
type TileLayoutState = Record<TilePanelId, RunWorkspaceTileSize>;

type SecondaryPanelId = "diff" | "terminal" | "browser";
type SecondaryPanelPosition = "right" | "bottom";

type RunDetailModelOption = {
  id: string;
  label: string;
  modelId: string;
  providerType: import("@easycode/shared").ProviderType;
  providerFamily: import("@easycode/shared").UnifiedProviderFamily | null;
};

const safeParseMetadata = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const normalizeAssistantOutputText = (value: string) => value.replace(/\s+/g, " ").trim();

const dedupeFinalSummarySteps = (steps: RunDetail["steps"]) => {
  const deduped: RunDetail["steps"] = [];
  let previousAssistantContent: string | null = null;

  for (const step of steps) {
    const metadata = safeParseMetadata(step.metadataJson);
    if (step.eventType === "output" && metadata.assistantKind !== "reasoning" && step.title !== "Reasoning") {
      const normalizedContent = normalizeAssistantOutputText(step.content);
      const isDuplicateFinalSummary =
        metadata.assistantKind === "final-summary" &&
        Boolean(previousAssistantContent) &&
        normalizedContent.length > 0 &&
        normalizedContent === previousAssistantContent;
      if (isDuplicateFinalSummary) {
        continue;
      }
      previousAssistantContent = normalizedContent;
    }
    deduped.push(step);
  }

  return deduped;
};

const trimPreviouslyDisplayedReasoning = (current: string, previous: string | null) => {
  if (!previous) {
    return current;
  }
  if (current.startsWith(previous)) {
    return current.slice(previous.length).trimStart();
  }
  const normalizedCurrent = normalizeAssistantOutputText(current);
  const normalizedPrevious = normalizeAssistantOutputText(previous);
  if (!normalizedPrevious || !normalizedCurrent.startsWith(normalizedPrevious)) {
    return current;
  }

  const previousTokens = normalizedPrevious.split(" ").filter(Boolean).length;
  if (previousTokens <= 0) {
    return current;
  }

  let tokenCount = 0;
  let cutIndex = 0;
  for (let index = 0; index < current.length; index += 1) {
    const char = current[index];
    const prevChar = index > 0 ? current[index - 1] : "";
    const startsToken = /\S/.test(char) && !/\S/.test(prevChar);
    if (startsToken) {
      tokenCount += 1;
      if (tokenCount > previousTokens) {
        cutIndex = index;
        break;
      }
    }
  }

  return cutIndex > 0 ? current.slice(cutIndex).trimStart() : current;
};

const trimPreviouslyDisplayedAssistant = (current: string, previous: string | null) => {
  if (!previous) {
    return current;
  }
  if (current.startsWith(previous)) {
    return current.slice(previous.length).trimStart();
  }
  const normalizedCurrent = normalizeAssistantOutputText(current);
  const normalizedPrevious = normalizeAssistantOutputText(previous);
  if (!normalizedPrevious || !normalizedCurrent.startsWith(normalizedPrevious)) {
    return current;
  }

  const previousTokens = normalizedPrevious.split(" ").filter(Boolean).length;
  if (previousTokens <= 0) {
    return current;
  }

  let tokenCount = 0;
  let cutIndex = 0;
  for (let index = 0; index < current.length; index += 1) {
    const char = current[index];
    const prevChar = index > 0 ? current[index - 1] : "";
    const startsToken = /\S/.test(char) && !/\S/.test(prevChar);
    if (startsToken) {
      tokenCount += 1;
      if (tokenCount > previousTokens) {
        cutIndex = index;
        break;
      }
    }
  }

  return cutIndex > 0 ? current.slice(cutIndex).trimStart() : current;
};

const shouldAutoCollapseReasoning = (content: string) => {
  const lineCount = content.split(/\r?\n/).length;
  return lineCount > 7 || content.trim().length > 700;
};

const getLatestUserCommandOptions = (steps: RunDetail["steps"]) => {
  const latestUserStep = [...steps].reverse().find((step) => safeParseMetadata(step.metadataJson).source === "user");
  const metadata = latestUserStep ? safeParseMetadata(latestUserStep.metadataJson) : {};
  return {
    reasoningEffort: typeof metadata.reasoningEffort === "string" ? metadata.reasoningEffort : "medium",
    anthropicEffort: typeof metadata.anthropicEffort === "string" ? metadata.anthropicEffort : "medium",
    yoloMode: metadata.yoloMode === true,
  };
};


/** Tool names whose consecutive calls differ only by path/detail — batch into one compact row. */
const TOOL_BATCH_MERGE_BY_PATH = new Set(["read_file"]);

type ToolBatchSummarizedRow = {
  toolName: string;
  detail: string | null;
  toolCallId?: string | null;
  command?: string | null;
  /** Populated when multiple read_file (etc.) paths are merged into one row. */
  paths?: string[];
  count: number;
  failed: boolean;
  shellStreaming?: boolean;
  preview: string | null;
  writeFileDiff: string | null;
  createdAt: string;
};

const ActivityToolBatchRow = ({
  item,
  itemIndex,
  run,
  busy,
  onCancelRunShell,
}: {
  item: ToolBatchSummarizedRow;
  itemIndex: number;
  run: RunRecord;
  busy: boolean;
  onCancelRunShell: (run: RunRecord, toolCallId: string) => void;
}) => {
  const [writeFileDiffExpanded, setWriteFileDiffExpanded] = useState(false);
  const shellLineCount = item.toolName === "run_shell" && item.preview ? item.preview.split(/\r?\n/).length : 0;
  const hasInlineDiff = !item.failed && Boolean(item.writeFileDiff) && looksLikeGitDiff(item.writeFileDiff ?? "");
  const canCancelShell =
    item.toolName === "run_shell" &&
    item.shellStreaming === true &&
    typeof item.toolCallId === "string" &&
    ["queued", "preparing", "running"].includes(run.status);

  return (
    <div
      key={`${item.toolName}-${item.detail ?? "detail"}-${itemIndex}`}
      className={`min-w-0 w-full rounded-md px-2 py-1 ${item.failed ? "bg-rose-500/[0.07]" : "bg-zinc-900/50"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.failed ? "bg-rose-400" : "bg-cyan-400"}`} />
            <p className="truncate text-[11px] text-zinc-200">{item.toolName}</p>
            {item.toolName === "run_shell" && item.shellStreaming ? (
              <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0 text-[9px] uppercase tracking-wide text-amber-300">
                Live
              </span>
            ) : null}
            {item.count > 1 ? <span className="text-[10px] text-zinc-500">×{item.count}</span> : null}
          </div>
          {item.paths && item.paths.length > 0 ? (
            <details className="group mt-0.5 w-full max-w-full">
              <summary className="flex cursor-pointer list-none items-center gap-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
                <ChevronDown className="h-3 w-3 shrink-0 text-zinc-600 transition group-open:rotate-180" />
                <span>
                  {item.paths.length} file{item.paths.length === 1 ? "" : "s"}
                </span>
              </summary>
              <ul className="app-scrollbar mt-1 max-h-40 list-none grid grid-cols-1 gap-x-4 gap-y-0.5 overflow-y-auto border-l border-zinc-700/50 py-0.5 pl-2 font-mono text-[10px] leading-snug text-zinc-500 sm:max-h-48 sm:grid-cols-2 xl:grid-cols-3">
                {item.paths.map((p, pi) => (
                  <li key={`${String(pi)}-${p.slice(0, 80)}`} className="min-w-0 break-words" title={p}>
                    {p}
                  </li>
                ))}
              </ul>
            </details>
          ) : item.detail ? (
            <p className="mt-0.5 truncate text-[10px] text-zinc-500">{item.detail}</p>
          ) : null}
          {item.toolName === "run_shell" && item.command ? (
            <p className="mt-1 truncate rounded border border-zinc-800/80 bg-zinc-950/80 px-1.5 py-1 font-mono text-[10px] text-zinc-300">
              {item.command}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[10px] text-zinc-600">{new Date(item.createdAt).toLocaleTimeString()}</span>
          {canCancelShell ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 border-rose-500/30 bg-rose-500/10 px-2 text-[10px] text-rose-200 hover:bg-rose-500/20"
              disabled={busy}
              onClick={() => onCancelRunShell(run, item.toolCallId!)}
            >
              Cancel
            </Button>
          ) : null}
          {hasInlineDiff ? (
            <button
              type="button"
              className="rounded px-0.5 py-0.5 text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-300"
              onClick={() => setWriteFileDiffExpanded((current) => !current)}
              aria-label={writeFileDiffExpanded ? "Collapse diff" : "Expand diff"}
              title={writeFileDiffExpanded ? "Collapse diff" : "Expand diff"}
            >
              {writeFileDiffExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>
      </div>
      {item.preview ? (
        item.toolName === "run_shell" ? (
          <details className="group mt-1 w-full max-w-full" open={item.shellStreaming ? true : undefined}>
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
              <ChevronDown className="h-3 w-3 shrink-0 text-zinc-600 transition group-open:rotate-180" />
              <Terminal className="h-3 w-3 shrink-0 text-zinc-600" aria-hidden />
              <span className="font-medium text-zinc-400">{item.shellStreaming ? "Live output" : "Console output"}</span>
              <span className="text-zinc-600">
                · {shellLineCount} line{shellLineCount === 1 ? "" : "s"}
              </span>
            </summary>
            <pre
              className={cn(
                "app-scrollbar mt-1 max-h-[min(70vh,36rem)] overflow-auto whitespace-pre-wrap break-words rounded border p-1.5 font-mono text-[10px] leading-snug text-zinc-300",
                item.failed ? "border-rose-500/20 bg-zinc-950/80" : "border-zinc-700/40 bg-zinc-950/80",
              )}
            >
              {item.preview}
            </pre>
          </details>
        ) : (
          <pre
            className={cn(
              "app-scrollbar mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded border border-rose-500/20 bg-zinc-950/80 p-1.5 font-mono text-[10px] leading-snug text-zinc-300",
            )}
          >
            {item.preview}
          </pre>
        )
      ) : null}
      {hasInlineDiff && writeFileDiffExpanded && item.writeFileDiff ? (
        <div className="mt-1.5 min-w-0 w-full">
          <GitDiffPreview
            diffText={item.writeFileDiff}
            emptyMessage="Could not parse file diff."
            compact
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

const describeActivityDetail = (metadata: Record<string, unknown>) =>
  ((metadata.source === "user"
    ? metadata.commandType === "follow-up"
      ? "User follow-up command"
      : "Initial user command"
    : null) ??
    metadata.path ??
    metadata.command ??
    metadata.query ??
    metadata.toolName) as string | null;

type SingleActivityEntry =
  | {
      kind: "single";
      step: RunDetail["steps"][number];
      metadata: Record<string, unknown>;
    }
  | {
      kind: "tool";
      callStep: RunDetail["steps"][number];
      callMetadata: Record<string, unknown>;
      resultStep?: RunDetail["steps"][number];
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
      kind: "single-group";
      groupKey: ActivityGroupKey;
      items: Extract<SingleActivityEntry, { kind: "single" }>[];
    };

const getConsecutiveMergeKey = (entry: Extract<SingleActivityEntry, { kind: "single" }>): ActivityGroupKey | null => {
  const { step, metadata } = entry;
  if (step.eventType === "error") return null;
  if (metadata.source === "user") return "user";
  if (step.eventType === "status") return "status";
  /** Reasoning summaries are their own blocks, not merged with normal assistant output. */
  if (metadata.assistantKind === "reasoning") return null;
  const isAssistant = step.eventType === "output" || (step.eventType === "log" && metadata.source !== "user");
  if (isAssistant) return "assistant";
  return null;
};

type ActivityEntryPreMerge = Exclude<ActivityEntry, { kind: "single-group" }>;

const normalizeShellCommandForActivity = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : null;

const getToolShellCommand = (entry: Extract<SingleActivityEntry, { kind: "tool" }>) =>
  normalizeShellCommandForActivity(entry.callMetadata.command) ?? normalizeShellCommandForActivity(entry.resultMetadata?.command);

const getApprovalShellCommand = (entry: Extract<SingleActivityEntry, { kind: "single" }>) =>
  normalizeShellCommandForActivity(entry.metadata.command) ?? normalizeShellCommandForActivity(entry.step.content);

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
      const toolName = candidate.callMetadata.toolName ?? candidate.resultMetadata?.toolName;
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

const runModeBadgeClassName = (mode: RunRecord["mode"]) => {
  if (mode === "code") {
    return "bg-cyan-500/10 text-cyan-300 ring-cyan-400/30";
  }

  if (mode === "plan") {
    return "bg-violet-500/10 text-violet-300 ring-violet-400/30";
  }

  return "bg-zinc-500/10 text-zinc-300 ring-zinc-400/30";
};

export interface RunBrowserSessionState {
  draftUrl: string;
  currentUrl: string;
  history: string[];
  historyIndex: number;
  reloadKey: number;
}

interface RunDetailPageProps {
  /** When used inside a flex main column, pass `min-h-0 min-w-0 flex-1` so the scroll region can shrink. */
  className?: string;
  runDetail: RunDetail;
  busy: boolean;
  modelOptions: RunDetailModelOption[];
  keyboardShortcuts: Record<KeyboardShortcutId, string>;
  pendingShellApproval: { command: string; secondsRemaining: number } | null;
  /** Activity / diff / terminal / browser panel visibility. */
  showActivity: boolean;
  showDiff: boolean;
  showTerminal: boolean;
  showBrowser: boolean;
  /** Called when a panel should be toggled on or off from within the layout. */
  onTogglePanel: (panelId: TilePanelId) => void;
  /** Whether the secondary panel column is docked to the right or bottom. */
  secondaryPanelPosition: SecondaryPanelPosition;
  onSecondaryPanelPositionChange: (position: SecondaryPanelPosition) => void;
  /** Legacy tile order/layout — retained for interface compatibility, not actively used in layout. */
  tileOrder: TilePanelId[];
  tileLayout: TileLayoutState;
  onTileOrderChange: (next: TilePanelId[]) => void;
  onTileLayoutChange: (next: TileLayoutState) => void;
  browserSession: RunBrowserSessionState;
  terminalOpenLinksInApp: boolean;
  onTerminalOpenLinksInAppChange: (enabled: boolean) => void;
  onBrowserSessionChange: (session: RunBrowserSessionState) => void;
  onOpenBrowserUrl: (url: string) => void;
  onRespondToShellApproval: (decision: ShellApprovalDecision) => void;
  onCancelRunShell: (run: RunRecord, toolCallId: string) => void;
  onCancelRun: (run: RunRecord) => void;
  onUndoRunToLastPrompt: (run: RunRecord) => void;
  onRecoverInterruptedRun: (run: RunRecord) => void;
  onFollowUpRun: (
    run: RunRecord,
    prompt: string,
    options: {
      mode: RunRecord["mode"];
      modelId: string;
      attachments?: ChatAttachmentPayload[];
      reasoningEffort?: string;
      anthropicEffort?: string;
      yoloMode?: boolean;
    },
  ) => Promise<void>;
}

export const RunDetailPage = ({
  className,
  runDetail,
  busy,
  modelOptions,
  keyboardShortcuts,
  pendingShellApproval,
  showActivity,
  showDiff,
  showTerminal,
  showBrowser,
  onTogglePanel,
  secondaryPanelPosition,
  onSecondaryPanelPositionChange,
  tileLayout,
  browserSession,
  terminalOpenLinksInApp,
  onTerminalOpenLinksInAppChange,
  onBrowserSessionChange,
  onOpenBrowserUrl,
  onRespondToShellApproval,
  onCancelRunShell,
  onCancelRun,
  onUndoRunToLastPrompt,
  onRecoverInterruptedRun,
  onFollowUpRun,
}: RunDetailPageProps) => {
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [followUpFiles, setFollowUpFiles] = useState<File[]>([]);
  const [selectedMode, setSelectedMode] = useState<RunRecord["mode"]>(runDetail.run.mode);
  const [selectedModelId, setSelectedModelId] = useState(runDetail.run.modelId);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("medium");
  const [selectedAnthropicEffort, setSelectedAnthropicEffort] = useState("medium");
  const [selectedYoloMode, setSelectedYoloMode] = useState(false);
  const [expandedReasoningStepIds, setExpandedReasoningStepIds] = useState<Record<string, boolean>>({});
  const [copiedStepId, setCopiedStepId] = useState<string | null>(null);
  const [recoveryConfirmOpen, setRecoveryConfirmOpen] = useState(false);
  /** Once the user opens the terminal for this run, keep PTY + xterm mounted; toggling only hides the panel. */
  const [runTerminalPinned, setRunTerminalPinned] = useState(false);

  // Split-pane state
  const [splitPct, setSplitPct] = useState(() => {
    const stored = tileLayout.activity.colSpan;
    return Math.min(75, Math.max(25, (stored / 12) * 100));
  });
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitResizeStartRef = useRef<{ x: number; y: number; pct: number } | null>(null);

  // Which secondary panel tab is currently in view
  const [activeSecondaryTab, setActiveSecondaryTab] = useState<SecondaryPanelId | null>(null);
  // "Add panel" popover in the tab strip
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const addPanelRef = useRef<HTMLDivElement>(null);

  const activityContainerRef = useRef<HTMLDivElement | null>(null);
  const activityEndRef = useRef<HTMLDivElement | null>(null);
  const workspacePath = runDetail.workspacePath ?? runDetail.run.worktreePath;
  const isRunActive = ["queued", "preparing", "running"].includes(runDetail.run.status);
  const worktreeUnavailable = runDetail.worktreeUnavailable === true;
  const diffPending = runDetail.diffPending === true;
  const orderedSteps = useMemo(() => dedupeFinalSummarySteps(runDetail.steps), [runDetail.steps]);
  const contextHistoryText = useMemo(() => buildVisibleConversationHistory(runDetail.steps), [runDetail.steps]);
  const gitDiffPanelRef = useRef<GitDiffPreviewHandle>(null);
  const [allDiffFilesExpanded, setAllDiffFilesExpanded] = useState(false);
  const [modifiedFilesExpanded, setModifiedFilesExpanded] = useState(false);
  const diffStats = useMemo(
    () => (diffPending ? { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, files: [] } : summarizeDiffStats(runDetail.diff)),
    [diffPending, runDetail.diff],
  );
  const [selectedReviewModelId, setSelectedReviewModelId] = useState(runDetail.run.modelId);
  const [reviewPanel, setReviewPanel] = useState<ReviewPanelState>({ result: null, busy: false, error: null });
  const restorablePromptStepId = useMemo(() => {
    const restorePoint = runDetail.latestPromptRestorePoint;
    if (!restorePoint) {
      return null;
    }
    const matchingUserSteps = [...orderedSteps]
      .filter((step) => {
        const metadata = safeParseMetadata(step.metadataJson);
        return metadata.source === "user" && metadata.commandType === restorePoint.commandType;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matchingUserSteps[0]?.id ?? null;
  }, [orderedSteps, runDetail.latestPromptRestorePoint]);

  useEffect(() => {
    const defaultModelId = modelOptions.some((option) => option.id === runDetail.run.modelId)
      ? runDetail.run.modelId
      : (modelOptions[0]?.id ?? "");
    setSelectedReviewModelId(defaultModelId);
    setReviewPanel({ result: null, busy: false, error: null });
  }, [modelOptions, runDetail.run.id, runDetail.run.modelId, runDetail.diff]);

  useEffect(() => {
    setRecoveryConfirmOpen(false);
  }, [runDetail.run.id, runDetail.run.status]);

  useEffect(() => {
    if (modelOptions.some((option) => option.id === selectedReviewModelId)) {
      return;
    }
    setSelectedReviewModelId(modelOptions[0]?.id ?? "");
  }, [modelOptions, selectedReviewModelId]);

  const runDiffReview = async () => {
    setReviewPanel((current) => ({
      ...current,
      busy: true,
      error: null,
    }));
    try {
      const result = await window.easycode.analyzeRunDiff(runDetail.run.id, {
        modelId: selectedReviewModelId,
      });
      setReviewPanel({
        result,
        busy: false,
        error: null,
      });
    } catch (error) {
      setReviewPanel((current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : "Could not analyze the diff.",
      }));
    }
  };
  const reviewBusy = reviewPanel.busy;
  const branchPromotedToProject = runDetail.branchPromotedToProject === true;
  const recovery = runDetail.interruptedRecovery;
  const activityEntries = useMemo<ActivityEntry[]>(() => {
    const entries: SingleActivityEntry[] = [];
    const pendingToolEntries = new Map<string, number>();
    let previousAssistantContent: string | null = null;
    let previousReasoningContent: string | null = null;

    for (const step of orderedSteps) {
      const metadata = safeParseMetadata(step.metadataJson);
      const callId = typeof metadata.callId === "string" ? metadata.callId : null;

      if (step.eventType === "tool-call" && callId) {
        pendingToolEntries.set(callId, entries.length);
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
          pendingToolEntries.delete(callId);
          continue;
        }
      }

      const normalizedStep =
        step.eventType === "output"
          ? metadata.assistantKind === "reasoning"
            ? {
                ...step,
                content: trimPreviouslyDisplayedReasoning(step.content, previousReasoningContent),
              }
            : {
                ...step,
                content: trimPreviouslyDisplayedAssistant(step.content, previousAssistantContent),
              }
          : step;

      if (step.eventType === "output" && metadata.assistantKind === "reasoning") {
        previousReasoningContent = step.content;
      } else if (step.eventType === "output") {
        previousAssistantContent = step.content;
      }

      entries.push({
        kind: "single",
        step: normalizedStep,
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

      groupedEntries.push(entry);
    }

    return mergeConsecutiveSingles(groupedEntries);
  }, [orderedSteps]);
  const latestUserCommandOptions = useMemo(() => getLatestUserCommandOptions(runDetail.steps), [runDetail.steps]);

  useEffect(() => {
    setFollowUpPrompt("");
    setFollowUpFiles([]);
    setSelectedMode(runDetail.run.mode);
    setSelectedModelId(runDetail.run.modelId);
    setSelectedReasoningEffort(latestUserCommandOptions.reasoningEffort);
    setSelectedAnthropicEffort(latestUserCommandOptions.anthropicEffort);
    setSelectedYoloMode(latestUserCommandOptions.yoloMode);
  }, [
    latestUserCommandOptions.anthropicEffort,
    latestUserCommandOptions.reasoningEffort,
    latestUserCommandOptions.yoloMode,
    runDetail.run.id,
    runDetail.run.updatedAt,
    runDetail.run.mode,
    runDetail.run.modelId,
  ]);

  useEffect(() => {
    setRunTerminalPinned(false);
  }, [runDetail.run.id]);

  useEffect(() => {
    if (showTerminal) {
      setRunTerminalPinned(true);
    }
  }, [showTerminal]);

  useEffect(() => {
    if (!modelOptions.some((option) => option.id === selectedModelId)) {
      setSelectedModelId(modelOptions[0]?.id ?? "");
    }
  }, [modelOptions, selectedModelId]);

  useEffect(() => {
    setModifiedFilesExpanded(false);
  }, [runDetail.run.id, runDetail.run.updatedAt]);

  useEffect(() => {
    if (worktreeUnavailable) {
      return;
    }

    const container = activityContainerRef.current;
    const end = activityEndRef.current;
    if (!container || !end) {
      return;
    }

    end.scrollIntoView({ block: "end" });
  }, [orderedSteps.length, runDetail.run.updatedAt, worktreeUnavailable]);

  // Close "add panel" popover when clicking outside
  useEffect(() => {
    if (!addPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (addPanelRef.current && !addPanelRef.current.contains(e.target as Node)) {
        setAddPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [addPanelOpen]);

  // Keep the active secondary tab in sync with panel visibility changes
  useEffect(() => {
    setActiveSecondaryTab((prev) => {
      if (prev === "diff" && showDiff) return prev;
      if (prev === "terminal" && showTerminal) return prev;
      if (prev === "browser" && showBrowser) return prev;
      if (showDiff) return "diff";
      if (showTerminal) return "terminal";
      if (showBrowser) return "browser";
      return null;
    });
  }, [showDiff, showTerminal, showBrowser]);

  // Split-pane resize (works for both right and bottom positions)
  useEffect(() => {
    if (!isResizingSplit) return;

    const handleMouseMove = (e: MouseEvent) => {
      const start = splitResizeStartRef.current;
      const container = splitContainerRef.current;
      if (!start || !container) return;
      const rect = container.getBoundingClientRect();
      let pct: number;
      if (secondaryPanelPosition === "right") {
        if (!rect.width) return;
        pct = Math.min(75, Math.max(25, start.pct + ((e.clientX - start.x) / rect.width) * 100));
      } else {
        if (!rect.height) return;
        pct = Math.min(80, Math.max(20, start.pct + ((e.clientY - start.y) / rect.height) * 100));
      }
      setSplitPct(pct);
    };

    const stopResize = () => {
      setIsResizingSplit(false);
      splitResizeStartRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = secondaryPanelPosition === "right" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopResize);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizingSplit, secondaryPanelPosition]);

  const startSplitResize = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    splitResizeStartRef.current = { x: e.clientX, y: e.clientY, pct: splitPct };
    setIsResizingSplit(true);
  };

  const toggleSecondaryPosition = () => {
    const next = secondaryPanelPosition === "right" ? "bottom" : "right";
    setSplitPct(next === "right" ? 60 : 55);
    onSecondaryPanelPositionChange(next);
  };

  const handleFollowUpSubmit = async () => {
    const trimmed = followUpPrompt.trim();
    if ((!trimmed && followUpFiles.length === 0) || busy || isRunActive) {
      return;
    }
    let attachments: ChatAttachmentPayload[] | undefined;
    try {
      attachments = followUpFiles.length > 0 ? await readFilesAsChatPayloads(followUpFiles) : undefined;
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not read attachments.");
      return;
    }
    try {
      await onFollowUpRun(runDetail.run, trimmed, {
        mode: selectedMode,
        modelId: selectedModelId,
        attachments,
        reasoningEffort: selectedReasoningEffort,
        anthropicEffort: selectedAnthropicEffort,
        yoloMode: selectedYoloMode,
      });
      setFollowUpPrompt("");
      setFollowUpFiles([]);
    } catch {
      /* App surfaces errors */
    }
  };

  const preparePlanContinuation = (plan: string) => {
    setSelectedMode("code");
    setFollowUpPrompt(`Implement this plan:\n\n${plan.trim()}`);
    setFollowUpFiles([]);
  };

  const copyStepContent = async (text: string, stepId: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedStepId(stepId);
    window.setTimeout(() => {
      setCopiedStepId((current) => (current === stepId ? null : current));
    }, 1500);
  };

  // Derived visibility
  const hasSecondaryPanels = showDiff || showTerminal || showBrowser;
  const visiblePanelCount = [showActivity, showDiff, showTerminal, showBrowser].filter(Boolean).length;

  const canHideDiff = showDiff && visiblePanelCount > 1 && !worktreeUnavailable;
  const canHideTerminal = showTerminal && visiblePanelCount > 1 && !worktreeUnavailable;
  const canHideBrowser = showBrowser && visiblePanelCount > 1;

  const secondaryPanelDefs = [
    {
      id: "diff" as const,
      label: "Git Diff",
      Icon: GitBranch,
      enabled: showDiff,
      canToggle: !worktreeUnavailable,
      canHide: canHideDiff,
    },
    {
      id: "terminal" as const,
      label: "Terminal",
      Icon: SquareTerminal,
      enabled: showTerminal,
      canToggle: !worktreeUnavailable,
      canHide: canHideTerminal,
    },
    {
      id: "browser" as const,
      label: "Browser",
      Icon: Globe,
      enabled: showBrowser,
      canToggle: true,
      canHide: canHideBrowser,
    },
  ] as const;

  const isGitDiffPanelVisible = showDiff && activeSecondaryTab === "diff";
  const showModifiedFilesSummary = !isRunActive && !diffPending && diffStats.totalFiles > 0 && !isGitDiffPanelVisible;
  const modifiedFilesSummary = showModifiedFilesSummary ? (
    <div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-1 flex justify-center px-2">
      <div
        className={cn(
          "pointer-events-auto overflow-hidden rounded-md border border-zinc-800/70 bg-zinc-900/95 shadow-lg shadow-black/20 backdrop-blur",
          modifiedFilesExpanded ? "w-fit min-w-[22rem] max-w-full" : "w-[min(18rem,100%)]",
        )}
      >
        <div className="grid min-h-8 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-1 px-1.5 py-1">
          <span aria-hidden />
          <button
            type="button"
            className="flex min-w-0 items-center justify-center gap-1.5 rounded px-1.5 py-1 text-[12px] font-medium text-zinc-200 transition hover:bg-zinc-800/80 hover:text-zinc-100"
            onClick={() => setModifiedFilesExpanded((current) => !current)}
            aria-expanded={modifiedFilesExpanded}
            title={modifiedFilesExpanded ? "Collapse changed files" : "Expand changed files"}
            aria-label={modifiedFilesExpanded ? "Collapse changed files" : "Expand changed files"}
          >
            <span className="truncate">
              {diffStats.totalFiles} file{diffStats.totalFiles === 1 ? "" : "s"} changed
            </span>
            <span className="font-semibold text-teal-300/90">+{diffStats.totalAdditions}</span>
            <span className="font-semibold text-red-300/85">-{diffStats.totalDeletions}</span>
          </button>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0 text-zinc-500 hover:bg-zinc-800/80 hover:text-zinc-100"
              onClick={() => {
                if (!showDiff) {
                  onTogglePanel("diff");
                }
                setActiveSecondaryTab("diff");
              }}
              title="Show Git Diff View"
              aria-label="Show Git Diff View"
            >
              <GitBranch className="h-3.5 w-3.5" />
            </Button>
            {restorablePromptStepId ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0 text-zinc-500 hover:bg-zinc-800/80 hover:text-red-200"
                onClick={() => onUndoRunToLastPrompt(runDetail.run)}
                disabled={busy}
                title="Revert changes"
                aria-label="Revert changes"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
        {modifiedFilesExpanded ? (
          <div className="app-scrollbar max-h-52 overflow-y-auto border-t border-zinc-800/70 bg-zinc-950/35">
                {diffStats.files.map((file) => (
                  <div
                    key={`${file.path}-${file.additions}-${file.deletions}`}
                    className="flex w-max min-w-full items-center justify-between gap-6 border-b border-zinc-800/50 px-2.5 py-1.5 text-[11px] last:border-b-0"
                  >
                    <span className="whitespace-nowrap text-zinc-200">{file.path}</span>
                    <span className="shrink-0 text-[10px] font-medium">
                      <span className="text-teal-300/90">+{file.additions}</span>
                      <span className="mx-1 text-zinc-700">/</span>
                  <span className="text-red-300/85">-{file.deletions}</span>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  ) : null;

  // ─── Activity log content (shared render) ────────────────────────────────
  const activityContent = (
    <div ref={activityContainerRef} className="app-scrollbar min-h-0 flex-1 space-y-2 overflow-auto px-2.5 py-2">
      {activityEntries.map((entry) => {
        if (entry.kind === "tool-batch") {
          const summarizedItems = entry.items.reduce<ToolBatchSummarizedRow[]>((rows, item) => {
            const toolName = String(item.callMetadata.toolName ?? item.resultMetadata?.toolName ?? "tool");
            const detail = describeActivityDetail(item.resultMetadata ?? {}) ?? describeActivityDetail(item.callMetadata);
            const failed = item.resultMetadata?.ok === false;
            const shellStreaming = item.resultMetadata?.shellStreaming === true;
            const toolCallId =
              typeof item.resultMetadata?.callId === "string"
                ? item.resultMetadata.callId
                : typeof item.callMetadata.callId === "string"
                  ? item.callMetadata.callId
                  : null;
            const command =
              typeof item.resultMetadata?.command === "string"
                ? item.resultMetadata.command
                : typeof item.callMetadata.command === "string"
                  ? item.callMetadata.command
                  : null;
            const preview = failed
              ? item.resultStep?.content ?? item.callStep.content
              : toolName === "run_shell"
                ? (item.resultStep?.content ?? "").trim() || null
                : null;
            const writeFileDiff =
              !failed && toolName === "write_file" && typeof item.resultMetadata?.writeFileUnifiedDiff === "string"
                ? item.resultMetadata.writeFileUnifiedDiff
                : null;
            const createdAt = (item.resultStep ?? item.callStep).createdAt;
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

          const latestTimestamp = summarizedItems[summarizedItems.length - 1]?.createdAt ?? entry.items[0]?.callStep.createdAt;

          return (
            <div
              key={`${entry.items[0]?.callStep.id ?? "tool-batch"}-${entry.items.length}`}
              className="min-w-0 w-full rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-2 py-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <Badge tone="running" className="px-1.5 py-0 text-[10px] bg-cyan-500/10 text-cyan-300 ring-cyan-400/30">
                    tools
                  </Badge>
                  <span className="truncate text-[11px] font-medium text-zinc-200">{entry.items.length}×</span>
                </div>
                {latestTimestamp ? (
                  <span className="shrink-0 text-[10px] text-zinc-600">{new Date(latestTimestamp).toLocaleTimeString()}</span>
                ) : null}
              </div>
              <div className="mt-1 space-y-1">
                {summarizedItems.map((item, index) => {
                  return (
                    <ActivityToolBatchRow
                      key={`${item.toolName}-${item.detail ?? "detail"}-${index}`}
                      item={item}
                      itemIndex={index}
                      run={runDetail.run}
                      busy={busy}
                      onCancelRunShell={onCancelRunShell}
                    />
                  );
                })}
              </div>
            </div>
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
          const timeRange = entry.items.length > 1 && t0 !== t1 ? `${t0}–${t1}` : t0;
          const groupKey = `sg-${first.step.id}-${entry.groupKey}-${entry.items.length}`;

          if (entry.groupKey === "status") {
            return (
              <div key={groupKey} className="rounded-lg border border-zinc-800/50 bg-zinc-950/30 px-2 py-1">
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Status</span>
                  <span className="text-[10px] text-zinc-600">{timeRange}</span>
                </div>
                <ul className="space-y-0.5">
                  {entry.items.map(({ step }) => (
                    <li
                      key={step.id}
                      className="flex items-start justify-between gap-2 border-t border-zinc-800/30 pt-0.5 first:border-t-0 first:pt-0"
                    >
                      <span className="min-w-0 flex-1 text-[10px] leading-snug text-zinc-400">
                        <span className="text-zinc-500">{step.title}</span>
                        {step.content ? <span className="text-zinc-500"> · {step.content}</span> : null}
                      </span>
                      <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums">
                        {new Date(step.createdAt).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          }

          if (entry.groupKey === "user") {
            return (
              <div key={groupKey} className="ml-auto max-w-[min(92%,34rem)] space-y-1">
                {entry.items.map(({ step, metadata }) => {
                  const mode = (metadata.mode as RunRecord["mode"]) ?? runDetail.run.mode;
                  const att = extractAttachmentNamesFromMetadata(metadata);
                  const attachments = extractAttachmentPayloadsFromMetadata(metadata);
                  const canUndoPrompt = step.id === restorablePromptStepId;
                  return (
                    <div
                      key={step.id}
                      className="rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/[0.06] px-2.5 py-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1">
                          <Badge
                            tone="queued"
                            className="px-1.5 py-0 text-[10px] bg-fuchsia-500/10 text-fuchsia-300 ring-fuchsia-400/30"
                          >
                            {metadata.commandType === "follow-up" ? "follow-up" : "you"}
                          </Badge>
                          <Badge tone="queued" className={`px-1.5 py-0 text-[10px] ${runModeBadgeClassName(mode)}`}>
                            {mode}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 shrink-0 p-0 text-zinc-400 hover:text-fuchsia-200"
                            onClick={() => void copyStepContent(step.content, step.id)}
                            title={copiedStepId === step.id ? "Copied" : "Copy prompt"}
                            aria-label="Copy prompt"
                          >
                            {copiedStepId === step.id ? (
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
                              className="h-6 w-6 shrink-0 p-0 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                              title="Undo changes since this prompt"
                              aria-label="Undo changes since this prompt"
                              onClick={() => onUndoRunToLastPrompt(runDetail.run)}
                              disabled={busy || isRunActive}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          ) : null}
                          <span className="text-[10px] text-zinc-500">{new Date(step.createdAt).toLocaleTimeString()}</span>
                        </div>
                      </div>
                      <StoredChatAttachments attachments={attachments} fallbackNames={att} compact />
                      <ActivityMarkdownOrGitDiff content={step.content} compact className="mt-1" />
                    </div>
                  );
                })}
              </div>
            );
          }

          return (
            <div key={groupKey} className="w-full min-w-0">
              <div className="mb-0.5 flex flex-wrap items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
                <span className="font-medium text-cyan-400/90">Assistant</span>
                <span className="text-zinc-700">·</span>
                <span className="tabular-nums">{timeRange}</span>
                {entry.items.length > 1 ? (
                  <span className="normal-case text-zinc-600">({entry.items.length} parts)</span>
                ) : null}
              </div>
              <div className="mb-1 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 shrink-0 p-0 text-zinc-400 hover:text-cyan-300"
                  onClick={() => void copyStepContent(entry.items.map(({ step }) => step.content).join("\n\n"), groupKey)}
                  title={copiedStepId === groupKey ? "Copied" : "Copy response"}
                  aria-label="Copy response"
                >
                  {copiedStepId === groupKey ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              <div className="space-y-1.5 rounded-xl border border-cyan-500/12 bg-cyan-500/[0.03] px-2 py-1.5">
                {entry.items.map(({ step, metadata }, i) => {
                  const detail = describeActivityDetail(metadata);
                  return (
                    <div key={step.id}>
                      {i > 0 ? <div className="mb-1.5 border-t border-zinc-800/40 pt-1.5" /> : null}
                      {detail && detail !== step.title ? (
                        <p className="mb-1 truncate text-[10px] text-zinc-500">{String(detail)}</p>
                      ) : null}
                      <ActivityMarkdownOrGitDiff content={step.content} compact className="text-zinc-200" />
                    </div>
                  );
                })}
              </div>
            </div>
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
        const mode = (entry.metadata.mode as RunRecord["mode"]) ?? runDetail.run.mode;
        const timestamp = new Date(entry.step.createdAt).toLocaleTimeString();

        if (isUserEntry) {
          const att = extractAttachmentNamesFromMetadata(entry.metadata);
          const attachments = extractAttachmentPayloadsFromMetadata(entry.metadata);
          const canUndoPrompt = entry.step.id === restorablePromptStepId;
          return (
            <div key={entry.step.id} className="ml-auto max-w-[min(92%,34rem)] rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/[0.06] px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1">
                  <Badge
                    tone="queued"
                    className="px-1.5 py-0 text-[10px] bg-fuchsia-500/10 text-fuchsia-300 ring-fuchsia-400/30"
                  >
                    {entry.metadata.commandType === "follow-up" ? "follow-up" : "you"}
                  </Badge>
                  <Badge tone="queued" className={`px-1.5 py-0 text-[10px] ${runModeBadgeClassName(mode)}`}>
                    {mode}
                  </Badge>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 shrink-0 p-0 text-zinc-400 hover:text-fuchsia-200"
                    onClick={() => void copyStepContent(entry.step.content, entry.step.id)}
                    title={copiedStepId === entry.step.id ? "Copied" : "Copy prompt"}
                    aria-label="Copy prompt"
                  >
                    {copiedStepId === entry.step.id ? (
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
                      className="h-6 w-6 shrink-0 p-0 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                      title="Undo changes since this prompt"
                      aria-label="Undo changes since this prompt"
                      onClick={() => onUndoRunToLastPrompt(runDetail.run)}
                      disabled={busy || isRunActive}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  <span className="text-[10px] text-zinc-500">{timestamp}</span>
                </div>
              </div>
              <StoredChatAttachments attachments={attachments} fallbackNames={att} compact />
              <ActivityMarkdownOrGitDiff content={entry.step.content} compact className="mt-1 text-zinc-200" />
            </div>
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
            ? "h-3.5 w-3.5 shrink-0 text-zinc-500"
            : "h-3.5 w-3.5 shrink-0 text-violet-300";
          const requestTitleClass = requestResolved
            ? "truncate text-[11px] font-medium text-zinc-300"
            : "truncate text-[11px] font-medium text-violet-100";
          const requestTimeClass = requestResolved
            ? "shrink-0 text-[10px] text-zinc-600"
            : "shrink-0 text-[10px] text-violet-200/70";
          return (
            <div
              key={entry.step.id}
              className={
                requestResolved
                  ? "rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-2.5 py-2"
                  : "rounded-lg border border-violet-500/25 bg-violet-500/[0.06] px-2.5 py-2"
              }
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {isShellApproval ? <Terminal className={requestIconClass} /> : <MessageSquareText className={requestIconClass} />}
                  <p className={requestTitleClass}>{entry.step.title}</p>
                  <Badge tone="queued" className="px-1.5 py-0 text-[10px] bg-violet-500/10 text-violet-200 ring-violet-400/30">
                    {requestKind}
                  </Badge>
                  {decisionLabel ? (
                    <Badge
                      tone={approvalDecision === "deny" ? "failed" : "completed"}
                      className="px-1.5 py-0 text-[10px]"
                    >
                      {decisionLabel}
                    </Badge>
                  ) : null}
                </div>
                <span className={requestTimeClass}>{timestamp}</span>
              </div>
              {isShellApproval ? (
                <>
                  <pre className="app-scrollbar mt-1.5 max-h-28 overflow-auto rounded-md border border-zinc-800/80 bg-zinc-950/65 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-200">
                    {entry.step.content}
                  </pre>
                  {!requestResolved ? (
                    <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-violet-200/80">
                      <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0 text-violet-300" />
                      <span>{approvalMessage ?? "Waiting for a shell approval decision."}</span>
                    </div>
                  ) : null}
                </>
              ) : (
                <ActivityMarkdownOrGitDiff content={entry.step.content} compact className="mt-1.5 text-zinc-200" />
              )}
            </div>
          );
        }

        if (isPlanEntry) {
          return (
            <div key={entry.step.id} className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.055] px-2.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                  <p className="truncate text-[11px] font-medium text-emerald-100">{entry.step.title}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 rounded-md px-2 text-[10px] text-emerald-200 hover:bg-emerald-500/10 hover:text-emerald-100"
                    disabled={busy || isRunActive}
                    onClick={() => preparePlanContinuation(entry.step.content)}
                  >
                    Continue in code mode
                  </Button>
                  <span className="shrink-0 text-[10px] text-emerald-200/70">{timestamp}</span>
                </div>
              </div>
              <ActivityMarkdownOrGitDiff content={entry.step.content} compact className="mt-1.5 text-zinc-200" />
            </div>
          );
        }

        if (isDiffEntry) {
          return (
            <div key={entry.step.id} className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[11px] font-medium text-cyan-100">{entry.step.title}</p>
                <span className="shrink-0 text-[10px] text-cyan-200/70">{timestamp}</span>
              </div>
              <ActivityMarkdownOrGitDiff content={entry.step.content} compact className="mt-1.5 text-zinc-200" />
            </div>
          );
        }

        if (isStatusEntry) {
          return (
            <div
              key={entry.step.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800/50 bg-zinc-950/35 px-2 py-1"
            >
              <div className="min-w-0">
                <p className="truncate text-[10px] font-medium uppercase tracking-wide text-zinc-500">{entry.step.title}</p>
                {entry.step.content ? (
                  <p className="mt-0.5 truncate text-[10px] text-zinc-500">{entry.step.content}</p>
                ) : null}
              </div>
              <span className="shrink-0 text-[10px] text-zinc-600">{timestamp}</span>
            </div>
          );
        }

        if (isErrorEntry) {
          return (
            <div key={entry.step.id} className="rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium text-rose-200">{entry.step.title}</p>
                <span className="text-[10px] text-rose-200/70">{timestamp}</span>
              </div>
              <pre className="app-scrollbar mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-rose-500/15 bg-zinc-950/60 p-1.5 text-[10px] text-zinc-200">
                {entry.step.content}
              </pre>
            </div>
          );
        }

        if (isAssistantEntry) {
          const isReasoning = entry.metadata.assistantKind === "reasoning";
          const reasoningAutoCollapsed = isReasoning && shouldAutoCollapseReasoning(entry.step.content);
          const reasoningExpanded = Boolean(expandedReasoningStepIds[entry.step.id]);
          return (
            <div key={entry.step.id} className="w-full min-w-0">
              <div className="mb-0.5 flex flex-wrap items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
                <span className={`font-medium ${isReasoning ? "text-amber-400/90" : "text-cyan-400/90"}`}>
                  {isReasoning ? "Reasoning" : "Assistant"}
                </span>
                <span className="text-zinc-700">·</span>
                <span className="tabular-nums">{timestamp}</span>
              </div>
              <div
                className={
                  isReasoning
                    ? "rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-2 py-1.5"
                    : "relative rounded-xl border border-cyan-500/12 bg-cyan-500/[0.03] px-2 py-1.5"
                }
              >
                {!isReasoning ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 z-10 h-6 w-6 shrink-0 p-0 text-zinc-400 hover:bg-cyan-500/10 hover:text-cyan-300"
                    onClick={() => void copyStepContent(entry.step.content, entry.step.id)}
                    title={copiedStepId === entry.step.id ? "Copied" : "Copy response"}
                    aria-label="Copy response"
                  >
                    {copiedStepId === entry.step.id ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                ) : null}
                {isReasoning ? (
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 text-[10px] leading-snug text-zinc-500">
                      Reasoning summary from the model (API-visible digest, not raw hidden tokens).
                    </p>
                    {reasoningAutoCollapsed ? (
                      <button
                        type="button"
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-amber-300/60 transition-colors hover:bg-amber-500/10 hover:text-amber-200"
                        onClick={() =>
                          setExpandedReasoningStepIds((current) => ({
                            ...current,
                            [entry.step.id]: !current[entry.step.id],
                          }))
                        }
                        title={reasoningExpanded ? "Collapse reasoning" : "Expand reasoning"}
                      >
                        {reasoningExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {detail && detail !== entry.step.title ? (
                  <p className="mb-1 truncate text-[10px] text-zinc-500">{String(detail)}</p>
                ) : null}
                <div className={isReasoning && reasoningAutoCollapsed && !reasoningExpanded ? "max-h-36 overflow-hidden" : undefined}>
                  <ActivityMarkdownOrGitDiff content={entry.step.content} compact className="text-zinc-200" />
                </div>
              </div>
            </div>
          );
        }

        return (
          <div key={entry.step.id} className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-zinc-200">{entry.step.title}</p>
                {detail ? <p className="mt-0.5 truncate text-[10px] text-zinc-400">{String(detail)}</p> : null}
              </div>
              <span className="shrink-0 text-[10px] text-zinc-500">{timestamp}</span>
            </div>
            <div className="mt-1">
              <ActivityMarkdownOrGitDiff content={entry.step.content} compact className="text-zinc-300" />
            </div>
          </div>
        );
      })}
      {isRunActive ? (
        <div className="rounded-lg border border-cyan-500/10 bg-zinc-950/40 px-2 py-2">
          <div className="run-activity-loading-bar mb-2" />
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-400/90" aria-hidden />
            <span className="animate-pulse">Agent is working…</span>
          </div>
        </div>
      ) : null}
      <div ref={activityEndRef} />
    </div>
  );

  return (
    <div className={cn("flex min-h-0 flex-col gap-1.5", className)}>
      {recovery ? (
        <Card
          className={cn(
            "shrink-0 overflow-hidden border p-0",
            recovery.available ? "border-cyan-500/25 bg-zinc-950" : "border-amber-500/25 bg-amber-500/5",
          )}
        >
          <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <div className="relative mt-0.5 h-8 w-8 shrink-0 rounded-md border border-cyan-400/20 bg-cyan-400/10">
                <div className="absolute inset-x-1 top-1 h-1 rounded-full bg-cyan-300/70" />
                <div className="absolute bottom-1 left-1 right-1 h-4 rounded-sm border border-cyan-300/30 bg-zinc-950/80" />
                <RotateCcw className="absolute bottom-1.5 left-2 h-4 w-4 text-cyan-200" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold text-zinc-100">{recovery.title}</p>
                  {recovery.kind === "checkpoint" && recovery.checkpointRound ? (
                    <Badge className="border-cyan-500/20 bg-cyan-500/10 text-[10px] text-cyan-100">
                      checkpoint {recovery.checkpointRound}
                    </Badge>
                  ) : recovery.providerSessionAvailable ? (
                    <Badge className="border-cyan-500/20 bg-cyan-500/10 text-[10px] text-cyan-100">provider session</Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[11px] leading-5 text-zinc-400">{recovery.detail}</p>
              </div>
            </div>
            {recovery.available ? (
              <div className="flex shrink-0 items-center gap-2">
                {recoveryConfirmOpen ? (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-8 border-zinc-700 bg-zinc-900/80 px-2 text-xs"
                      onClick={() => setRecoveryConfirmOpen(false)}
                      disabled={busy}
                    >
                      Not now
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 bg-cyan-500 px-2 text-xs font-semibold text-zinc-950 hover:bg-cyan-400"
                      onClick={() => onRecoverInterruptedRun(runDetail.run)}
                      disabled={busy}
                    >
                      {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                      Continue from here
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 bg-cyan-500 px-2 text-xs font-semibold text-zinc-950 hover:bg-cyan-400"
                    onClick={() => setRecoveryConfirmOpen(true)}
                    disabled={busy}
                  >
                    Review recovery
                  </Button>
                )}
              </div>
            ) : null}
          </div>
          {recoveryConfirmOpen ? (
            <div className="border-t border-cyan-500/10 bg-cyan-500/[0.04] px-3 py-2 text-[11px] leading-5 text-zinc-300">
              Easycode will start one new turn, reconnect the saved provider thread when possible, inspect the workspace before editing, and keep the
              existing activity log intact.
            </div>
          ) : null}
        </Card>
      ) : null}
      {/* Worktree unavailable banner */}
      {worktreeUnavailable ? (
        <Card className={cn("shrink-0 p-3", branchPromotedToProject ? "border-cyan-500/20 bg-cyan-500/5" : "border-amber-500/20 bg-amber-500/5")}>
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "rounded-full p-1.5",
                branchPromotedToProject
                  ? "border border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
                  : "border border-amber-500/30 bg-amber-500/10 text-amber-300",
              )}
            >
              <GitBranch className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              {branchPromotedToProject ? (
                <>
                  <p className="text-xs font-medium text-cyan-200">Branch moved to the project repository</p>
                  <p className="mt-0.5 text-[11px] text-zinc-400">
                    The branch <span className="font-mono text-cyan-200/90">{runDetail.run.branchName}</span> still exists locally and should be checked out in
                    the main project repository. This run's temporary Easycode worktree was removed on purpose, so Git diffs are no longer available here.
                    The Activity Log is still available.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs font-medium text-amber-200">Git worktree no longer available</p>
                  <p className="mt-0.5 text-[11px] text-zinc-400">
                    The branch <span className="font-mono text-amber-200/90">{runDetail.run.branchName}</span> or its worktree has been removed.
                    Git diffs cannot be shown. Only the Activity Log is available.
                  </p>
                </>
              )}
            </div>
          </div>
        </Card>
      ) : null}

      {/* ── Main split area ──────────────────────────────────────────── */}
      <div
        ref={splitContainerRef}
        className={cn(
          "flex min-h-0 flex-1 overflow-hidden",
          secondaryPanelPosition === "right" ? "flex-row gap-1" : "flex-col gap-1",
        )}
      >
        {/* Left / Top pane – Activity Log */}
        {showActivity ? (
          <div
            className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-800/60"
            style={
              hasSecondaryPanels
                ? secondaryPanelPosition === "right"
                  ? { width: `${splitPct}%`, flexShrink: 0 }
                  : { flexBasis: `${splitPct}%`, flexShrink: 0 }
                : { flex: 1 }
            }
          >
            {activityContent}
          </div>
        ) : null}

        {/* Drag-to-resize divider */}
        {showActivity && hasSecondaryPanels ? (
          <div
            role="separator"
            aria-label="Resize panels"
            className={cn(
              "shrink-0 rounded-full transition-colors",
              secondaryPanelPosition === "right"
                ? "w-1.5 cursor-col-resize"
                : "h-1.5 cursor-row-resize",
              isResizingSplit ? "bg-cyan-500/50" : "bg-zinc-800/60 hover:bg-cyan-500/30",
            )}
            onMouseDown={startSplitResize}
          />
        ) : null}

        {/* Right / Bottom pane – Secondary panels with tab strip */}
        {hasSecondaryPanels ? (
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800/60"
          >
            {/* Tab strip */}
            <div className="flex h-9 shrink-0 items-stretch border-b border-zinc-800/80 bg-zinc-950/50">
              {/* Only render enabled panels as tabs */}
              {secondaryPanelDefs.filter((p) => p.enabled).map((panel) => {
                const Icon = panel.Icon;
                const isActive = activeSecondaryTab === panel.id;
                return (
                  <button
                    key={panel.id}
                    type="button"
                    className={cn(
                      "group relative -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs transition",
                      isActive
                        ? "border-cyan-500/70 bg-zinc-900/50 text-zinc-100"
                        : "cursor-pointer border-transparent text-zinc-400 hover:bg-zinc-800/30 hover:text-zinc-200",
                    )}
                    onClick={() => setActiveSecondaryTab(panel.id)}
                    title={panel.label}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="whitespace-nowrap">{panel.label}</span>
                    {panel.canHide ? (
                      <span
                        role="button"
                        tabIndex={0}
                        className="ml-0.5 flex h-4 w-4 items-center justify-center rounded opacity-0 transition group-hover:opacity-100 hover:bg-zinc-700/80"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTogglePanel(panel.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            onTogglePanel(panel.id);
                          }
                        }}
                        title={`Hide ${panel.label}`}
                        aria-label={`Hide ${panel.label}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </span>
                    ) : null}
                  </button>
                );
              })}

              {/* "Add panel" button — shown when there are hidden panels */}
              {secondaryPanelDefs.some((p) => !p.enabled && p.canToggle) ? (
                <div ref={addPanelRef} className="relative flex items-center">
                  <button
                    type="button"
                    className={cn(
                      "flex h-full items-center gap-1 border-b-2 border-transparent px-2 text-[11px] text-zinc-600 transition hover:bg-zinc-800/50 hover:text-zinc-300",
                      addPanelOpen && "bg-zinc-800/50 text-zinc-300",
                    )}
                    onClick={() => setAddPanelOpen((o) => !o)}
                    title="Add panel"
                    aria-label="Add panel"
                    aria-expanded={addPanelOpen}
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                  {addPanelOpen ? (
                    <div className="absolute left-0 top-full z-50 mt-0.5 min-w-[9rem] overflow-hidden rounded-lg border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/40">
                      {secondaryPanelDefs
                        .filter((p) => !p.enabled && p.canToggle)
                        .map((panel) => {
                          const Icon = panel.Icon;
                          return (
                            <button
                              key={panel.id}
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 transition hover:bg-zinc-800/80"
                              onClick={() => {
                                onTogglePanel(panel.id);
                                setActiveSecondaryTab(panel.id);
                                setAddPanelOpen(false);
                              }}
                            >
                              <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                              {panel.label}
                            </button>
                          );
                        })}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Spacer */}
              <div className="flex flex-1 items-center justify-end gap-0.5 px-1.5">
                {/* Activity restore when hidden */}
                {!showActivity ? (
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-zinc-600 transition hover:bg-zinc-800/60 hover:text-zinc-300"
                    onClick={() => onTogglePanel("activity")}
                    title="Show Activity Log"
                    aria-label="Show Activity Log"
                  >
                    <MessageSquareText className="h-3 w-3" />
                    <Plus className="h-2.5 w-2.5" />
                  </button>
                ) : null}

                {/* Position toggle: dock right ↔ dock bottom */}
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded text-zinc-600 transition hover:bg-zinc-800/60 hover:text-zinc-300"
                  onClick={toggleSecondaryPosition}
                  title={secondaryPanelPosition === "right" ? "Move panel to bottom" : "Move panel to right"}
                  aria-label={secondaryPanelPosition === "right" ? "Move panel to bottom" : "Move panel to right"}
                >
                  {secondaryPanelPosition === "right" ? (
                    <PanelBottom className="h-3.5 w-3.5" />
                  ) : (
                    <PanelRight className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>

            {/* Active panel content */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">

              {/* Git Diff panel */}
              {showDiff && activeSecondaryTab === "diff" ? (
                <div className="flex h-full min-h-0 flex-col overflow-hidden">
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {diffPending ? (
                      <div
                        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-zinc-500"
                        role="status"
                        aria-live="polite"
                      >
                        <Loader2 className="h-8 w-8 animate-spin text-cyan-500/70" aria-hidden />
                        <p className="font-medium text-zinc-400">Computing worktree diff…</p>
                        <p className="max-w-sm text-xs text-zinc-600">
                          The activity log updates in real time. Diff loading runs separately so you can switch runs without waiting on git.
                        </p>
                      </div>
                    ) : (
                      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
                        <div className="relative z-20 mb-3 rounded-lg border border-zinc-800/80 bg-zinc-950/45">
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-stretch">
                            <button
                              type="button"
                              className="group min-w-0 px-3 py-2.5 text-left transition hover:bg-zinc-900/55"
                              onClick={() => gitDiffPanelRef.current?.toggleExpandAllFiles()}
                              title={allDiffFilesExpanded ? "Collapse all files" : "Expand all files"}
                              aria-label={allDiffFilesExpanded ? "Collapse all files" : "Expand all files"}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                {allDiffFilesExpanded ? (
                                  <Minimize2 className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition group-hover:text-zinc-300" aria-hidden />
                                ) : (
                                  <Maximize2 className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition group-hover:text-zinc-300" aria-hidden />
                                )}
                                <span className="truncate text-sm font-semibold text-zinc-100">
                                  {diffStats.totalFiles} file{diffStats.totalFiles === 1 ? "" : "s"} changed
                                </span>
                                <span className="text-xs font-semibold text-teal-300/90">+{diffStats.totalAdditions}</span>
                                <span className="text-xs font-semibold text-red-300/85">-{diffStats.totalDeletions}</span>
                              </div>
                              <p className="mt-0.5 text-[10px] text-zinc-600 transition group-hover:text-zinc-500">
                                {allDiffFilesExpanded ? "Collapse file diffs" : "Expand file diffs"}
                              </p>
                            </button>
                            <div className="flex items-center gap-1 border-l border-zinc-800/80 px-2">
                              <ComposerSelect
                                value={selectedReviewModelId}
                                onChange={setSelectedReviewModelId}
                                disabled={reviewBusy || modelOptions.length === 0}
                                icon={Bot}
                                iconClassName="text-cyan-300"
                                buttonClassName="h-7 max-w-[11rem] rounded-md border-transparent bg-transparent px-1.5 text-[11px] hover:border-zinc-800 hover:bg-zinc-900/80"
                                options={modelOptions.map((option) => ({
                                  value: option.id,
                                  label: option.label,
                                  contextModelId: option.modelId,
                                  providerType: option.providerType,
                                  providerFamily: option.providerFamily,
                                }))}
                                menuClassName="w-[22rem]"
                                menuSide="bottom"
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="h-7 shrink-0 border border-zinc-800 bg-zinc-900/80 px-2.5 text-[11px] text-zinc-100 hover:bg-zinc-800"
                                onClick={() => void runDiffReview()}
                                disabled={reviewBusy || isRunActive || !runDetail.diff.trim()}
                                title="Run reviewer simulator"
                              >
                                {reviewBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                                {reviewPanel.result ? "Review again" : "Review"}
                              </Button>
                            </div>
                          </div>
                        </div>
                        {reviewPanel.busy || reviewPanel.error || reviewPanel.result ? (
                          <div className="mb-3">
                            <DiffReviewPanel
                              state={reviewPanel}
                              onRun={() => void runDiffReview()}
                              disabled={isRunActive || !runDetail.diff.trim()}
                              defaultExpanded
                              compact
                              hideRunButton
                            />
                          </div>
                        ) : null}
                        <GitDiffPreview
                          ref={gitDiffPanelRef}
                          diffText={runDetail.diff}
                          className="max-h-none overflow-visible"
                          emptyMessage={
                            "No diff generated yet. This can happen if the run completed without repository changes or git has not refreshed yet."
                          }
                          activityEmphasis
                          defaultCollapsedFileSections
                          onAllFilesExpandedChange={setAllDiffFilesExpanded}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {/* Terminal panel */}
              {showTerminal && activeSecondaryTab === "terminal" ? (
                <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
                  <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[10px] text-zinc-500" title={workspacePath}>
                          {workspacePath}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <label className="flex shrink-0 items-center gap-2 text-[10px] text-zinc-400">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border border-zinc-700 bg-zinc-950 accent-cyan-400"
                          checked={terminalOpenLinksInApp}
                          onChange={(event) => onTerminalOpenLinksInAppChange(event.target.checked)}
                        />
                        Open links in app
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 shrink-0 p-0 text-zinc-400 hover:text-zinc-100"
                        title="Open external"
                        aria-label="Open external"
                        onClick={() => void window.easycode.openSystemTerminalAtPath(workspacePath)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2">
                      <RunWorktreeTerminal
                        className="min-h-0 flex-1"
                        runId={runDetail.run.id}
                        cwd={workspacePath}
                        disabled={false}
                        uiActive={showTerminal}
                        openLinksInApp={terminalOpenLinksInApp}
                      onOpenUrlInApp={onOpenBrowserUrl}
                    />
                  </div>
                </div>
              ) : null}

              {/* Browser panel */}
              {showBrowser && activeSecondaryTab === "browser" ? (
                <RunEmbeddedBrowser
                  className="h-full min-h-0"
                  session={browserSession}
                  onSessionChange={onBrowserSessionChange}
                />
              ) : null}

            </div>
          </div>
        ) : null}
      </div>

      {/* Keep PTY + xterm mounted after first open; toggling Terminal only hides the panel. */}
      {!worktreeUnavailable && runTerminalPinned && !showTerminal ? (
        <div className="pointer-events-none fixed left-[-12000px] top-0 z-0 h-[420px] w-[896px] opacity-0" aria-hidden>
          <RunWorktreeTerminal
            runId={runDetail.run.id}
            cwd={workspacePath}
            disabled={false}
            uiActive={false}
            openLinksInApp={terminalOpenLinksInApp}
            onOpenUrlInApp={onOpenBrowserUrl}
          />
        </div>
      ) : null}

      {/* ── Bottom: shell approval + follow-up composer ─────────────── */}
      <div className="shrink-0 space-y-1 pt-0.5">
        {pendingShellApproval ? (
          <Card className="border-amber-500/25 bg-[linear-gradient(180deg,rgba(120,53,15,0.12),rgba(9,9,11,0.96))] p-4">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <div className="rounded-full border border-amber-500/30 bg-amber-500/10 p-2 text-amber-300">
                    <Terminal className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-[0.25em] text-amber-300/80">Shell approval needed</p>
                    <p className="mt-1 text-sm text-zinc-300">
                      This command is outside the default safe allowlist. It will be auto-denied in{" "}
                      <span className="font-medium text-amber-200">{pendingShellApproval.secondsRemaining}s</span> if you do nothing.
                    </p>
                  </div>
                </div>
                <pre className="app-scrollbar mt-4 max-h-40 overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 text-sm text-zinc-200">
                  {pendingShellApproval.command}
                </pre>
                <p className="mt-3 text-xs text-zinc-500">
                  Allow once for a single execution. &quot;For this run&quot; remembers the exact command until the run ends. &quot;Save to
                  settings&quot; adds a permanent exact-match pattern (see Settings → GIT &amp; Workspace).
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => onRespondToShellApproval("deny")} disabled={busy}>
                  Deny
                </Button>
                <Button variant="secondary" onClick={() => onRespondToShellApproval("allow-once")} disabled={busy}>
                  Allow once
                </Button>
                <Button variant="secondary" onClick={() => onRespondToShellApproval("allow-for-run")} disabled={busy}>
                  Allow for this run
                </Button>
                <Button
                  className="gap-2"
                  onClick={() => onRespondToShellApproval("allow-always")}
                  disabled={busy}
                  title="Adds an exact-match regex for this command to Settings"
                >
                  <ShieldCheck className="h-4 w-4 shrink-0" />
                  Always allow (save to settings)
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        <div className="relative">
          {modifiedFilesSummary}
          <RunComposer
            attachments={
              <ChatAttachmentPicker
                variant="footer"
                files={followUpFiles}
                onChange={setFollowUpFiles}
                disabled={busy || isRunActive}
              />
            }
            prompt={followUpPrompt}
            onPromptChange={setFollowUpPrompt}
            selectedMode={selectedMode}
            onModeChange={setSelectedMode}
            selectedModelId={selectedModelId}
            onModelChange={setSelectedModelId}
            modelOptions={modelOptions.map((option) => ({
              value: option.id,
              label: option.label,
              contextModelId: option.modelId,
              providerType: option.providerType,
              providerFamily: option.providerFamily,
            }))}
            busy={busy}
            isRunActive={isRunActive}
            dropdownSide="top"
            sticky={false}
            dense
            submitShortcut={keyboardShortcuts.submitComposer}
            onAddAttachmentFiles={(incoming) => setFollowUpFiles((prev) => appendChatAttachmentFiles(prev, incoming))}
            placeholder="Follow up on this run… (optional if you attach files)"
            submitDisabled={
              busy || isRunActive || !selectedModelId || (!followUpPrompt.trim() && followUpFiles.length === 0)
            }
            onCancel={() => onCancelRun(runDetail.run)}
            onSubmit={() => void handleFollowUpSubmit()}
            contextHistoryText={contextHistoryText}
            contextAttachmentFiles={followUpFiles}
            reasoningEffort={selectedReasoningEffort}
            anthropicEffort={selectedAnthropicEffort}
            onReasoningEffortChange={setSelectedReasoningEffort}
            onAnthropicEffortChange={setSelectedAnthropicEffort}
            yoloMode={selectedYoloMode}
            onYoloModeChange={setSelectedYoloMode}
          />
        </div>
      </div>
    </div>
  );
};
