import { useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail, RunStepRecord } from "@buildwarden/shared";
import {
  buildActivityEntries,
  describeActivityDetail,
  describeToolTarget,
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
  Terminal,
  Wrench,
} from "lucide-react";
import { relativeTime } from "../lib/format";
import { dedupeFinalSummarySteps, finalAssistantStep, summaryDuplicatesTranscript } from "../lib/run-activity-dedupe";
import { toolWriteFileDiff } from "../lib/tool-write-file-diff";
import { RichText } from "./RichText";
import { InlineDiff } from "./DiffViewer";
import { Badge } from "./primitives";

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

  if (isUser) {
    return (
      <div className="flex justify-end px-3 py-1.5">
        <div className="max-w-[86%] rounded-2xl rounded-br-md bg-[var(--ec-accent-soft)] px-3 py-2">
          <RichText className="text-[var(--ec-text)]">{step.content || step.title}</RichText>
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
        {step.content ? <RichText className="mt-1 text-[var(--ec-danger)]">{step.content}</RichText> : null}
      </div>
    );
  }

  if (isReasoning) {
    return (
      <div className="px-4 py-1">
        <Collapsible summary={<span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ec-faint)]">Reasoning</span>}>
          <RichText className="text-[var(--ec-muted)]">{step.content}</RichText>
        </Collapsible>
      </div>
    );
  }

  // A finished run's answer is what a phone user scrolls to the bottom for; lift it out of the
  // stream of ordinary output rows instead of repeating it in a second card.
  if (isFinalResponse) {
    return (
      <div className="mx-3 my-2 rounded-lg border border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ec-success)]">Final response</p>
        <RichText className="mt-1">{step.content}</RichText>
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
      <RichText>{step.content}</RichText>
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

export const ActivityTimeline = ({ detail }: { detail: RunDetail }) => {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
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

  useEffect(() => {
    if (!stickToBottom.current) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-8 py-12 text-center text-xs text-[var(--ec-muted)]">
        {runActive ? "Waiting for the first step…" : "This run produced no activity."}
      </div>
    );
  }

  return (
    <div className="m-scroll flex flex-col py-2" onScroll={onScroll}>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setLimit((current) => current + PAGE_SIZE)}
          className="m-tap mx-4 mb-2 rounded-md border border-[var(--ec-border)] text-xs font-medium text-[var(--ec-muted)]"
        >
          Load {Math.min(hidden, PAGE_SIZE)} earlier {hidden === 1 ? "entry" : "entries"}
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
      {detail.run.errorMessage ? (
        <div className="mx-3 mt-2 rounded-lg border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ec-danger)]">Failure</p>
          <p className="m-wrap-anywhere mt-1 whitespace-pre-wrap text-[13px] leading-6 text-[var(--ec-danger)]">
            {detail.run.errorMessage}
          </p>
        </div>
      ) : null}
      <div ref={bottomRef} className="h-2" />
    </div>
  );
};
