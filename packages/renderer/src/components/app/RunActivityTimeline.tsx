import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type RunEventType,
  type RunTimelineDensity,
  type RunUserInputAnswers,
} from "@buildwarden/shared";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { AgentLogRow, AgentWorklog } from "./agent-worklog";
import { RunPlanDecisionCard } from "./RunPlanDecisionCard";
import { ActivitySubagentCard } from "./run-activity-subagent-card";
import { SingleActivityEntryView, SingleGroupActivityEntry, type ActivityRenderContext } from "./run-activity-entry-views";
import {
  ActivityDiffBatchRow,
  ActivityToolBatchRow,
  type DiffBatchSummarizedRow,
} from "./run-activity-tool-rows";
import { summarizeToolBatchItems } from "./run-activity-tool-model";
import {
  buildActivityEntries,
  buildTimelineRenderItems,
  getLatestPlanDecisionText,
  shouldAutoCollapseReasoning,
  type ActivityEntry,
  type RunActivityRun,
  type RunActivityStep,
  type TimelineRenderItem,
} from "./run-activity-model";
import { scrollVirtualTimelineToBoundary } from "./run-activity-scroll";
import { ScrollBoundaryControls } from "./ScrollBoundaryControls";

const assignTimelineRef = (ref: Ref<HTMLDivElement> | undefined, node: HTMLDivElement | null) => {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(node);
    return;
  }
  (ref as { current: HTMLDivElement | null }).current = node;
};

const estimateTextContentSize = (content: string, density: RunTimelineDensity) => {
  const lineHeight = density === "detailed" ? 20 : 18;
  let lines = 0;
  for (const line of content.split("\n")) {
    lines += Math.max(1, Math.ceil(line.length / 90));
  }
  return Math.min(1200, 44 + lines * lineHeight);
};

const estimateGroupedEntrySize = (
  entry: Extract<ActivityEntry, { kind: "single-group" }>,
  density: RunTimelineDensity,
) => {
  if (entry.groupKey === "status") return 42 + entry.items.length * 22;
  if (entry.groupKey === "user") return 104 + entry.items.length * 48;
  const contentSize = entry.items.reduce(
    (total, groupItem) => total + estimateTextContentSize(groupItem.step.content, density),
    0,
  );
  return Math.min(1600, 24 + contentSize);
};

const estimateSingleEntrySize = (
  entry: Extract<ActivityEntry, { kind: "single" }>,
  density: RunTimelineDensity,
  expandedReasoningStepIds: Record<string, boolean>,
) => {
  const fixedSizes: Partial<Record<RunEventType, number>> = {
    status: 64,
    request: 190,
    "user-input-requested": 190,
    "approval-requested": 130,
    "approval-resolved": 130,
    "plan-progress": 150,
    plan: 260,
    "plan-updated": 260,
    "diff-updated": 260,
    error: 120,
  };
  const fixedSize = fixedSizes[entry.step.eventType];
  if (fixedSize !== undefined) return fixedSize;

  const isCollapsedReasoning =
    entry.metadata.assistantKind === "reasoning" &&
    shouldAutoCollapseReasoning(entry.step.content) &&
    !expandedReasoningStepIds[entry.step.id];
  return isCollapsedReasoning ? 56 : estimateTextContentSize(entry.step.content, density);
};

const estimateActivityEntrySize = (
  entry: ActivityEntry,
  density: RunTimelineDensity,
  expandedReasoningStepIds: Record<string, boolean>,
) => {
  if (entry.kind === "tool-batch") return Math.min(420, 42 + entry.items.length * (density === "detailed" ? 34 : 24));
  if (entry.kind === "diff-batch") return Math.min(360, 42 + entry.items.length * 34);
  if (entry.kind === "tool") return 48;
  if (entry.kind === "subagent") return 96;
  if (entry.kind === "single-group") return estimateGroupedEntrySize(entry, density);
  return estimateSingleEntrySize(entry, density, expandedReasoningStepIds);
};

const estimateTimelineItemSize = (
  item: TimelineRenderItem | undefined,
  density: RunTimelineDensity,
  expandedReasoningStepIds: Record<string, boolean>,
) => {
  if (!item) return 80;
  if (item.kind === "end") return density === "compact" ? 8 : 18;
  if (item.kind === "loading") return 62;
  if (item.kind === "plan-decision") return 170;
  return estimateActivityEntrySize(item.entry, density, expandedReasoningStepIds);
};

type TimelineRenderContext = ActivityRenderContext & {
  density: RunTimelineDensity;
  activeSubagentFocus: { subagentId: string; nonce: number } | null;
  onCancelRunShell?: (run: RunActivityRun, toolCallId: string) => void;
  onSubmitPlanFeedback?: (feedback: string) => Promise<void>;
  endRef?: Ref<HTMLDivElement>;
  endClassName?: string;
};

const ActivityEntryView = ({ entry, context }: Readonly<{ entry: ActivityEntry; context: TimelineRenderContext }>) => {
  const { run, density, busy, readOnly, rowTime, compactContent, activeSubagentFocus, onCancelRunShell, onOpenWorkspaceFile } = context;

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
        tone="diff"
        label={`Diffs (${entry.items.length})`}
        time={rowTime(latestTimestamp ? new Date(latestTimestamp).toLocaleTimeString() : null)}
      >
        <div className="agent-tool-stack agent-tool-stack--bare">
          {summarizedItems.map((item) => (
            <ActivityDiffBatchRow key={item.id} item={item} density={density} onOpenWorkspaceFile={onOpenWorkspaceFile} />
          ))}
        </div>
      </AgentLogRow>
    );
  }

  if (entry.kind === "tool-batch") {
    const summarizedItems = summarizeToolBatchItems(entry.items);
    const latestTimestamp = summarizedItems[summarizedItems.length - 1]?.createdAt ?? entry.items[0]?.callStep?.createdAt;

    return (
      <AgentLogRow
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
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          ))}
        </div>
      </AgentLogRow>
    );
  }

  if (entry.kind === "tool") {
    return <></>;
  }

  if (entry.kind === "subagent") {
    return (
      <ActivitySubagentCard
        key={`subagent-${entry.info.id}`}
        entry={entry}
        compactContent={compactContent}
        focusNonce={activeSubagentFocus?.subagentId === entry.info.id ? activeSubagentFocus.nonce : 0}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        renderEntry={(nested, index) => (
          <div key={`subagent-${entry.info.id}-nested-${String(index)}`}><ActivityEntryView entry={nested} context={context} /></div>
        )}
        rowTime={rowTime}
      />
    );
  }

  if (entry.kind === "single-group") {
    return <SingleGroupActivityEntry entry={entry} context={context} />;
  }

  return <SingleActivityEntryView entry={entry} context={context} />;
};

const TimelineItemView = ({ item, context }: Readonly<{ item: TimelineRenderItem; context: TimelineRenderContext }>) => {
  if (item.kind === "entry") {
    return <ActivityEntryView entry={item.entry} context={context} />;
  }

  if (item.kind === "plan-decision") {
    return (
      <AgentLogRow key={item.key} tone="answer" label="Plan decision" time={null}>
        <RunPlanDecisionCard
          disabled={context.busy || context.isRunActive}
          onImplement={() => context.onPreparePlanContinuation?.(item.planText)}
          onSubmitFeedback={context.onSubmitPlanFeedback!}
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

  return <div key={item.key} ref={context.endRef} className={context.endClassName} aria-hidden="true" />;
};

const TimelineItemRow = memo(function TimelineItemRow({
  item,
  context,
}: Readonly<{
  item: TimelineRenderItem;
  context: TimelineRenderContext;
}>) {
  return <TimelineItemView item={item} context={context} />;
});

type TimelineScrollOptions = {
  timelineItems: TimelineRenderItem[];
  density: RunTimelineDensity;
  activeReasoningStepIds: Record<string, boolean>;
  virtualized: boolean;
  containerRef?: Ref<HTMLDivElement>;
  hasRenderableActivity: boolean;
  runId: string;
  runStatus: RunActivityRun["status"];
  isRunActive: boolean;
  stepMeasurementSignature: string;
  stepsLength: number;
  subagentFocus: { subagentId: string; nonce: number } | null;
  initialScrollPosition: "start" | "end";
};

const useTimelineScroll = ({
  timelineItems,
  density,
  activeReasoningStepIds,
  virtualized,
  containerRef,
  hasRenderableActivity,
  runId,
  runStatus,
  isRunActive,
  stepMeasurementSignature,
  stepsLength,
  subagentFocus,
  initialScrollPosition,
}: TimelineScrollOptions) => {const scrollElementRef = useRef<HTMLDivElement | null>(null);
const shouldStickToBottomRef = useRef(true);
const initiallyScrolledRunIdRef = useRef<string | null>(null);
const setWorklogRef = useCallback(
  (node: HTMLDivElement | null) => {
    scrollElementRef.current = node;
    assignTimelineRef(containerRef, node);
  },
  [containerRef],
);
const rowVirtualizer = useVirtualizer({
  enabled: virtualized,
  count: timelineItems.length,
  getScrollElement: () => scrollElementRef.current,
  estimateSize: (index) => estimateTimelineItemSize(timelineItems[index], density, activeReasoningStepIds),
  getItemKey: (index) => timelineItems[index]?.key ?? index,
  useAnimationFrameWithResizeObserver: true,
  // Use a real initial offset. A maximum-number "scroll to end" sentinel can
  // remain cached when a new run is shorter than its viewport because writing
  // scrollTop = 0 is a DOM no-op and emits no correcting scroll event.
  initialOffset: virtualized ? 0 : undefined,
  anchorTo: "end",
  scrollEndThreshold: 140,
  overscan: 4,
});
const scrollTimelineToEnd = useCallback(() => {
  const container = scrollElementRef.current;
  if (!container || !hasRenderableActivity) {
    return false;
  }

  if (virtualized) {
    scrollVirtualTimelineToBoundary(rowVirtualizer, "bottom");
  } else {
    container.scrollTop = container.scrollHeight;
  }
  shouldStickToBottomRef.current = true;
  return true;
}, [hasRenderableActivity, rowVirtualizer, virtualized]);

const scrollTimelineToStart = useCallback((behavior: ScrollBehavior = "smooth") => {
  const container = scrollElementRef.current;
  if (!container || !hasRenderableActivity) {
    return false;
  }

  shouldStickToBottomRef.current = false;
  if (virtualized) {
    scrollVirtualTimelineToBoundary(rowVirtualizer, "top");
  } else {
    container.scrollTo({ top: 0, behavior });
  }
  return true;
}, [hasRenderableActivity, rowVirtualizer, virtualized]);

useEffect(() => {
  shouldStickToBottomRef.current = initialScrollPosition === "end";
}, [initialScrollPosition, runId]);

const timelineItemsRef = useRef(timelineItems);
timelineItemsRef.current = timelineItems;
// A focus request outlives this component in App state, so a remount (e.g.
// reopening the same run) would otherwise replay the last jump. Seed the
// handled nonce from the mount-time prop and only act on nonces that arrive
// after mounting; cards likewise only see the focus while it is active.
const handledSubagentFocusNonceRef = useRef(subagentFocus?.nonce ?? 0);
const [activeSubagentFocus, setActiveSubagentFocus] = useState<{ subagentId: string; nonce: number } | null>(null);
useEffect(() => {
  if (!subagentFocus || subagentFocus.nonce === handledSubagentFocusNonceRef.current) {
    return;
  }
  handledSubagentFocusNonceRef.current = subagentFocus.nonce;
  setActiveSubagentFocus(subagentFocus);
  const index = timelineItemsRef.current.findIndex(
    (item) => item.kind === "entry" && item.entry.kind === "subagent" && item.entry.info.id === subagentFocus.subagentId,
  );
  if (index === -1) {
    return;
  }
  // Jumping to a card means the user left the live tail on purpose.
  shouldStickToBottomRef.current = false;
  if (virtualized) {
    rowVirtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
  }
  const frame = window.requestAnimationFrame(() => {
    scrollElementRef.current
      ?.querySelector(`[data-subagent-id="${CSS.escape(subagentFocus.subagentId)}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  return () => window.cancelAnimationFrame(frame);
}, [rowVirtualizer, subagentFocus, virtualized]);

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

useLayoutEffect(() => {
  if (initiallyScrolledRunIdRef.current === runId || !hasRenderableActivity || !scrollElementRef.current) {
    return;
  }

  const scrollToInitialPosition = () =>
    initialScrollPosition === "start" ? scrollTimelineToStart("auto") : scrollTimelineToEnd();

  scrollToInitialPosition();
  // Repeat after the virtualizer has observed the committed viewport and the
  // estimated spacer has received its actual dimensions. The immediate call
  // prevents a visible jump in the common case; this frame handles first mount.
  const frame = window.requestAnimationFrame(() => {
    if (scrollToInitialPosition()) {
      initiallyScrolledRunIdRef.current = runId;
    }
  });

  return () => {
    window.cancelAnimationFrame(frame);
  };
}, [hasRenderableActivity, initialScrollPosition, runId, scrollTimelineToEnd, scrollTimelineToStart]);

useEffect(() => {
  if (!virtualized || !isRunActive || !shouldStickToBottomRef.current || !hasRenderableActivity) {
    return;
  }
  const frame = window.requestAnimationFrame(() => {
    scrollTimelineToEnd();
  });
  return () => window.cancelAnimationFrame(frame);
}, [hasRenderableActivity, isRunActive, runStatus, runId, scrollTimelineToEnd, stepMeasurementSignature, stepsLength, virtualized]);



  return {
    activeSubagentFocus,
    rowVirtualizer,
    scrollElementRef,
    scrollTimelineToEnd,
    scrollTimelineToStart,
    setWorklogRef,
  };
};

type RunActivityTimelineProps = Readonly<{
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
  showBoundaryControls?: boolean;
  initialScrollPosition?: "start" | "end";
  subagentFocus?: { subagentId: string; nonce: number } | null;
  onCopyStepContent?: (text: string, stepId: string) => void | Promise<void>;
  onUndoRunToLastPrompt?: (run: RunActivityRun) => void;
  onCancelRunShell?: (run: RunActivityRun, toolCallId: string) => void;
  onPreparePlanContinuation?: (plan: string) => void;
  onSubmitPlanFeedback?: (feedback: string) => Promise<void>;
  onSubmitUserInputAnswers?: (run: RunActivityRun, requestId: string, answers: RunUserInputAnswers) => Promise<void> | void;
  onOpenWorkspaceFile?: (path: string) => void;
  onToggleReasoningStep?: (stepId: string) => void;
}>;

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
  showBoundaryControls = false,
  initialScrollPosition = "end",
  subagentFocus = null,
  onCopyStepContent,
  onUndoRunToLastPrompt,
  onCancelRunShell,
  onPreparePlanContinuation,
  onSubmitPlanFeedback,
  onSubmitUserInputAnswers,
  onOpenWorkspaceFile,
  onToggleReasoningStep,
}: RunActivityTimelineProps) {
  const [internalCopiedStepId, setInternalCopiedStepId] = useState<string | null>(null);
  const [internalExpandedReasoningStepIds, setInternalExpandedReasoningStepIds] = useState<Record<string, boolean>>({});
  const isRunActive = ["queued", "preparing", "running"].includes(run.status);
  const activityEntries = useMemo(() => buildActivityEntries(steps, { runActive: isRunActive }), [isRunActive, steps]);
  const activeCopiedStepId = copiedStepId ?? internalCopiedStepId;
  const activeReasoningStepIds = expandedReasoningStepIds ?? internalExpandedReasoningStepIds;
  const latestPlanDecisionText = useMemo(
    () => getLatestPlanDecisionText(activityEntries, run.mode),
    [activityEntries, run.mode],
  );
  const canShowPlanDecision =
    !readOnly &&
    !isRunActive &&
    Boolean(onPreparePlanContinuation && onSubmitPlanFeedback && latestPlanDecisionText?.trim());
  const compactContent = density !== "detailed";
  const rowTime = useCallback((time: string | null | undefined) => (density === "compact" ? null : time), [density]);
  const stepMeasurementSignature = useMemo(
    () => steps.map((step) => `${step.id}:${step.eventType}:${step.title.length}:${step.content.length}:${step.metadataJson.length}`).join("|"),
    [steps],
  );

  const copyStepContent = useCallback(
    async (text: string, stepId: string) => {
      if (onCopyStepContent) {
        await onCopyStepContent(text, stepId);
        return;
      }
      await navigator.clipboard.writeText(text);
      setInternalCopiedStepId(stepId);
      window.setTimeout(() => {
        setInternalCopiedStepId((current) => (current === stepId ? null : current));
      }, 1500);
    },
    [onCopyStepContent],
  );

  const toggleReasoningStep = useCallback(
    (stepId: string) => {
      if (onToggleReasoningStep) {
        onToggleReasoningStep(stepId);
        return;
      }
      setInternalExpandedReasoningStepIds((current) => ({
        ...current,
        [stepId]: !current[stepId],
      }));
    },
    [onToggleReasoningStep],
  );

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
  const hasRenderableActivity = activityEntries.length > 0 || showLoading;
  const {
    activeSubagentFocus,
    rowVirtualizer,
    scrollElementRef,
    scrollTimelineToEnd,
    scrollTimelineToStart,
    setWorklogRef,
  } = useTimelineScroll({
    timelineItems,
    density,
    activeReasoningStepIds,
    virtualized,
    containerRef,
    hasRenderableActivity,
    runId: run.id,
    runStatus: run.status,
    isRunActive,
    stepMeasurementSignature,
    stepsLength: steps.length,
    subagentFocus,
    initialScrollPosition,
  });
  const timelineRenderContext: TimelineRenderContext = useMemo(
    () => ({
      run,
      runDurationLabel,
      rowTime,
      readOnly,
      restorablePromptStepId,
      onUndoRunToLastPrompt,
      activeCopiedStepId,
      copyStepContent,
      busy,
      isRunActive,
      compactContent,
      onOpenWorkspaceFile,
      onPreparePlanContinuation,
      onSubmitUserInputAnswers,
      activeReasoningStepIds,
      toggleReasoningStep,
      density,
      activeSubagentFocus,
      onCancelRunShell,
      onSubmitPlanFeedback,
      endRef,
      endClassName,
    }),
    [
      run,
      runDurationLabel,
      rowTime,
      readOnly,
      restorablePromptStepId,
      onUndoRunToLastPrompt,
      activeCopiedStepId,
      copyStepContent,
      busy,
      isRunActive,
      compactContent,
      onOpenWorkspaceFile,
      onPreparePlanContinuation,
      onSubmitUserInputAnswers,
      activeReasoningStepIds,
      toggleReasoningStep,
      density,
      activeSubagentFocus,
      onCancelRunShell,
      onSubmitPlanFeedback,
      endRef,
      endClassName,
    ],
  );

  const worklogClassName = cn(className, `agent-worklog-density--${density}`, virtualized ? "agent-worklog--virtualized" : null);
  const isEmpty = activityEntries.length === 0 && !showLoading;

  if (virtualized) {
    return (
      <>
        {showBoundaryControls ? (
          <ScrollBoundaryControls
            scrollElementRef={scrollElementRef}
            onScrollToTop={() => void scrollTimelineToStart()}
            onScrollToBottom={() => void scrollTimelineToEnd()}
          />
        ) : null}
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
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="agent-virtual-row"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <TimelineItemRow item={item} context={timelineRenderContext} />
                </div>
              );
            })}
          </div>
        </AgentWorklog>
      </>
    );
  }

  return (
    <AgentWorklog ref={setWorklogRef} className={worklogClassName}>
      {isEmpty ? <div className="agent-worklog-empty">{emptyMessage}</div> : null}
      {timelineItems.map((item) => (
        <TimelineItemRow key={item.key} item={item} context={timelineRenderContext} />
      ))}
    </AgentWorklog>
  );
}
