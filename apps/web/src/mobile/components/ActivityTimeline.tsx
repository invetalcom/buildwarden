import { useEffect, useMemo, useRef, useState } from "react";
import {
  extractAttachmentNamesFromMetadata,
  extractAttachmentPayloadsFromMetadata,
  type RunDetail,
  type RunStepRecord,
} from "@buildwarden/shared";
import {
  buildActivityEntries,
  describeActivityDetail,
  describeToolTarget,
  getStoredAttachmentMessageContent,
  type ActivityEntry,
  type RunActivityStep,
  type SingleActivityEntry,
} from "@buildwarden/renderer/logic";
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  FileDiff,
  Info,
  Loader2,
  Terminal,
  Wrench,
} from "lucide-react";
import { relativeTime } from "../lib/format";
import { dedupeFinalSummarySteps, finalAssistantStep, summaryDuplicatesTranscript } from "../lib/run-activity-dedupe";
import { toolWriteFileDiff } from "../lib/tool-write-file-diff";
import { RichText } from "./RichText";
import { InlineDiff } from "./DiffViewer";
import { Badge } from "./primitives";
import { MobileStoredAttachments } from "./TaskAttachments";

/**
 * Mobile run timeline.
 *
 * Entry grouping (tool batches, diff batches, consecutive assistant turns, subagents) is the
 * shared `buildActivityEntries` model, so a run reads the same on both platforms. Only the row
 * markup is mobile-specific: single column, no hover affordances, code and tool output collapsed
 * by default so a long run stays scannable with a thumb.
 *
 * Instead of a virtualiser this renders a trailing window with an explicit "Load earlier" control:
 * cheaper than variable-height virtualisation, and it matches how a phone user reads a run — from
 * the bottom, occasionally scrolling back.
 *
 * `run.errorMessage` is deliberately not rendered, matching the desktop: every host path that sets
 * it also appends the matching error or status step (see `appendRunEvent` calls around
 * `updateRunStatus` in `apps/desktop/src/main/app-controller.ts`), so a card would only repeat the
 * failure the transcript already ends with.
 */

const PAGE_SIZE = 60;

const stepsForModel = (steps: readonly RunStepRecord[]): RunActivityStep[] =>
  steps.map((step) => ({
    id: step.id,
    eventType: step.eventType,
    title: step.title,
    content: step.content,
    metadataJson: step.metadataJson,
    createdAt: step.createdAt,
  }));

const Collapsible = ({ summary, children, defaultOpen = false }: { summary: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="m-tap flex w-full items-center gap-2 py-1 text-left"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0 text-[var(--ec-faint)]" /> : <ChevronRight className="size-3.5 shrink-0 text-[var(--ec-faint)]" />}
        <span className="min-w-0 flex-1">{summary}</span>
      </button>
      {open ? <div className="pl-5.5 pt-1">{children}</div> : null}
    </div>
  );
};

const SingleRow = ({
  entry,
  isFinalResponse = false,
}: {
  entry: Extract<SingleActivityEntry, { kind: "single" }>;
  isFinalResponse?: boolean;
}) => {
  const { step, metadata } = entry;
  const isUser = metadata.source === "user";
  const isError = step.eventType === "error";
  const isReasoning = metadata.assistantKind === "reasoning";
  const isStatus = step.eventType === "status";
  const detail = describeActivityDetail(metadata);
  const attachments = extractAttachmentPayloadsFromMetadata(metadata);
  const attachmentNames = extractAttachmentNamesFromMetadata(metadata);
  const content = isUser ? getStoredAttachmentMessageContent(step.content || step.title, attachmentNames) : step.content;

  if (isUser) {
    return (
      <div className="flex justify-end px-3 py-1.5">
        <div className="max-w-[86%] rounded-2xl rounded-br-md border border-[var(--ec-user-input-ring)] bg-[var(--ec-user-input-soft)] px-3 py-2">
          {content ? <RichText className="text-[var(--ec-text)]">{content}</RichText> : null}
          <MobileStoredAttachments attachments={attachments} fallbackNames={attachmentNames} />
        </div>
      </div>
    );
  }

  if (isStatus) {
    return (
      <div className="flex items-center gap-2 px-4 py-1 text-[11px] text-[var(--ec-faint)]">
        <Info className="size-3 shrink-0" />
        <span className="truncate">{step.title}</span>
        <span className="ml-auto shrink-0">{relativeTime(step.createdAt)}</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-3 my-1.5 rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ec-danger)]">
          <AlertTriangle className="size-3.5" />
          {step.title}
        </div>
        {content ? <RichText className="mt-1 text-[var(--ec-danger)]">{content}</RichText> : null}
        <MobileStoredAttachments attachments={attachments} fallbackNames={attachmentNames} />
      </div>
    );
  }

  if (isReasoning) {
    return (
      <div className="px-4 py-1">
        <div className="rounded-md border border-[var(--ec-reasoning-ring)] bg-[var(--ec-reasoning-soft)] px-2 py-1">
          <Collapsible summary={<span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ec-reasoning)]">Reasoning</span>}>
          <RichText className="text-[var(--ec-muted)]">{content}</RichText>
          </Collapsible>
        </div>
      </div>
    );
  }

  // A finished run's answer is what a phone user scrolls to the bottom for; lift it out of the
  // stream of ordinary output rows instead of repeating it in a second card.
  if (isFinalResponse) {
    return (
      <div className="mx-3 my-2 rounded-lg border border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ec-success)]">Final response</p>
        <MobileStoredAttachments attachments={attachments} fallbackNames={attachmentNames} />
        {content ? <RichText className="mt-1">{content}</RichText> : null}
      </div>
    );
  }

  return (
    <div className="px-4 py-1.5">
      {step.title && step.title !== "Assistant" ? (
        <p className="mb-0.5 text-[11px] font-medium text-[var(--ec-faint)]">
          {step.title}
          {detail ? <span className="m-mono ml-1.5 text-[var(--ec-muted)]">{detail}</span> : null}
        </p>
      ) : null}
      <MobileStoredAttachments attachments={attachments} fallbackNames={attachmentNames} />
      {content ? <RichText>{content}</RichText> : null}
    </div>
  );
};

const ToolRow = ({ entry }: { entry: Extract<SingleActivityEntry, { kind: "tool" }> }) => {
  const call = entry.callMetadata ?? {};
  const result = entry.resultMetadata ?? {};
  const toolName = (call.toolName ?? result.toolName ?? entry.callStep?.title ?? "tool") as string;
  const target = describeToolTarget(call, result) ?? "";
  const failed = result.ok === false || entry.resultStep?.eventType === "error";
  const pending = !entry.resultStep;
  const output = entry.resultStep?.content ?? "";
  const isShell = toolName === "run_shell";
  // A write_file row's content is only "Wrote N characters to …", which the row header already
  // says. When the tool recorded a diff, show that instead — it is the reason to open the row.
  const diff = failed ? null : toolWriteFileDiff(result, call);

  return (
    <div className="px-4 py-0.5">
      <Collapsible
        summary={
          <span className="flex min-w-0 items-center gap-1.5">
            {isShell ? <Terminal className="size-3.5 shrink-0 text-[var(--ec-muted)]" /> : <Wrench className="size-3.5 shrink-0 text-[var(--ec-muted)]" />}
            <span className="shrink-0 text-[11px] font-medium text-[var(--ec-muted)]">{toolName}</span>
            {target ? <span className="m-mono min-w-0 truncate text-[11px] text-[var(--ec-faint)]">{target}</span> : null}
            {pending ? <Badge tone="accent">running</Badge> : null}
            {failed ? <Badge tone="danger">failed</Badge> : null}
          </span>
        }
      >
        {diff ? (
          <InlineDiff diff={diff} />
        ) : output ? (
          <pre className="m-scroll-thin m-mono max-h-64 overflow-auto rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-2.5 py-2 text-[11.5px] leading-5">
            {output.length > 8000 ? `${output.slice(0, 8000)}\n…truncated` : output}
          </pre>
        ) : (
          <p className="text-[11px] text-[var(--ec-faint)]">{pending ? "Waiting for the tool to finish…" : "No output."}</p>
        )}
      </Collapsible>
    </div>
  );
};

/**
 * Desktop shows this for the whole time a run is active (`showLoading={isRunActive}`), always as the
 * last row, and suppresses the empty state while it is up. Same rules here: an active run with no
 * steps yet reads as working rather than empty, and a run that stops loses the row immediately.
 */
const WorkingRow = () => (
  <div className="mx-3 my-2 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2.5">
    <div className="m-shimmer mb-2" />
    <div className="flex items-center gap-2 text-[11px] text-[var(--ec-faint)]">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--ec-accent)]" aria-hidden />
      <span className="animate-pulse">Agent is working...</span>
    </div>
  </div>
);

const EntryView = ({ entry, finalResponseStepId }: { entry: ActivityEntry; finalResponseStepId: string | null }) => {
  switch (entry.kind) {
    case "single":
      return <SingleRow entry={entry} isFinalResponse={entry.step.id === finalResponseStepId} />;
    case "tool":
      return <ToolRow entry={entry} />;
    case "single-group":
      return (
        <div className="flex flex-col">
          {entry.items.map((item) => (
            <SingleRow key={item.step.id} entry={item} isFinalResponse={item.step.id === finalResponseStepId} />
          ))}
        </div>
      );
    case "tool-batch":
      return (
        <div className="flex flex-col">
          {entry.items.map((item, index) => (
            <ToolRow key={item.callStep?.id ?? item.resultStep?.id ?? index} entry={item} />
          ))}
        </div>
      );
    case "diff-batch":
      return (
        <div className="mx-4 my-1 flex items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2">
          <FileDiff className="size-3.5 shrink-0 text-[var(--ec-muted)]" />
          <span className="text-[11px] text-[var(--ec-muted)]">
            {entry.items.length} file {entry.items.length === 1 ? "change" : "changes"} — open the Diff tab
          </span>
        </div>
      );
    case "subagent":
      return (
        <div className="mx-3 my-1.5 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 py-1.5">
          <Collapsible
            summary={
              <span className="flex min-w-0 items-center gap-1.5">
                <Bot className="size-3.5 shrink-0 text-[var(--ec-accent)]" />
                <span className="min-w-0 truncate text-[12px] font-medium">{entry.info.name || "Subagent"}</span>
                <Badge tone={entry.info.status === "failed" ? "danger" : entry.info.status === "completed" ? "success" : "accent"}>
                  {entry.info.status}
                </Badge>
              </span>
            }
          >
            <div className="flex flex-col border-l border-[var(--ec-border)] pl-1">
              {entry.entries.map((nested, index) => (
                <EntryView key={index} entry={nested} finalResponseStepId={finalResponseStepId} />
              ))}
            </div>
          </Collapsible>
        </div>
      );
  }
};

export const ActivityTimeline = ({
  detail,
  historyLoading = false,
  onLoadEarlierHistory,
}: {
  detail: RunDetail;
  historyLoading?: boolean;
  onLoadEarlierHistory?: () => void | Promise<void>;
}) => {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const runActive = ["queued", "preparing", "running"].includes(detail.run.status);

  const steps = useMemo(() => dedupeFinalSummarySteps(detail.steps), [detail.steps]);

  const entries = useMemo(
    () => buildActivityEntries(stepsForModel(steps), { runActive }),
    [steps, runActive],
  );

  // Only a finished run has a final answer; highlighting the newest message mid-run would make it
  // flip in and out of the callout as the agent keeps talking.
  const finalResponseStepId = useMemo(
    () => (runActive ? null : finalAssistantStep(steps)?.id ?? null),
    [runActive, steps],
  );

  // The stored summary is normally the same text the transcript already ends with; only surface it
  // when the run actually says something the timeline does not.
  const summary = detail.run.summary?.trim() ?? "";
  const showSummary = Boolean(summary) && !summaryDuplicatesTranscript(summary, steps);

  const visible = entries.slice(Math.max(0, entries.length - limit));
  const hidden = entries.length - visible.length;

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [detail.run.id]);

  // runActive is a dependency because the working row appearing or disappearing changes the height
  // of the timeline without changing the entry count.
  useEffect(() => {
    if (!stickToBottom.current) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, runActive]);

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  const loadEarlierHistory = async () => {
    if (!onLoadEarlierHistory || historyLoading) return;
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    stickToBottom.current = false;
    await onLoadEarlierHistory();
    setLimit((current) => current + 150);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    if (element) element.scrollTop = previousTop + (element.scrollHeight - previousHeight);
  };

  // An active run is never "empty": it gets the working row below, exactly as the desktop timeline
  // suppresses its empty message whenever the loading row is up.
  if (entries.length === 0 && !runActive) {
    return (
      <div className="flex flex-1 items-center justify-center px-8 py-12 text-center text-xs text-[var(--ec-muted)]">
        This run produced no activity.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="m-scroll flex flex-col py-2" onScroll={onScroll}>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setLimit((current) => current + PAGE_SIZE)}
          className="m-tap mx-4 mb-2 rounded-md border border-[var(--ec-border)] text-xs font-medium text-[var(--ec-muted)]"
        >
          Load {Math.min(hidden, PAGE_SIZE)} earlier {hidden === 1 ? "entry" : "entries"}
        </button>
      ) : null}
      {hidden === 0 && detail.historyPage?.hasMore && onLoadEarlierHistory ? (
        <button
          type="button"
          onClick={() => void loadEarlierHistory()}
          disabled={historyLoading}
          className="m-tap mx-4 mb-2 rounded-md border border-[var(--ec-border)] text-xs font-medium text-[var(--ec-muted)] disabled:opacity-60"
        >
          {historyLoading ? "Loading earlier turns…" : "Load earlier turns"}
        </button>
      ) : null}
      {visible.map((entry, index) => (
        <EntryView key={`${index}-${entry.kind}`} entry={entry} finalResponseStepId={finalResponseStepId} />
      ))}
      {/* Neutral, not green: the green callout means "the agent's final answer", and this card only
          appears in the rare case where the stored summary says something different. */}
      {showSummary ? (
        <div className="mx-3 mt-2 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ec-faint)]">Run summary</p>
          <RichText className="mt-1">{summary}</RichText>
        </div>
      ) : null}
      {runActive ? <WorkingRow /> : null}
      <div ref={bottomRef} className="h-2" />
    </div>
  );
};
