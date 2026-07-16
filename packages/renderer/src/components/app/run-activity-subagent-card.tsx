import { useEffect, useState, type ReactNode } from "react";
import { Bot, ChevronDown, Loader2 } from "lucide-react";
import type { RunSubagentInfo } from "@buildwarden/shared";
import { ActivityMarkdownOrGitDiff } from "./activity-message-body";
import { AgentLogRow, AgentPanel } from "./agent-worklog";
import { Badge } from "../ui/badge";
import type { ActivityEntry, SubagentActivityEntry } from "./run-activity-model";

const ExpandChevron = ({ expanded }: Readonly<{ expanded: boolean }>) =>
  expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : null;
const formatSubagentDurationLabel = (info: RunSubagentInfo): string | null => {
  const durationMs =
    info.usage?.durationMs ??
    (info.startedAtMs !== undefined && info.endedAtMs !== undefined && info.endedAtMs > info.startedAtMs
      ? info.endedAtMs - info.startedAtMs
      : undefined);
  if (durationMs === undefined || durationMs <= 0) {
    return null;
  }
  if (durationMs < 1_000) {
    return "<1s";
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) {
    return `${String(totalSeconds)}s`;
  }
  return `${String(Math.floor(totalSeconds / 60))}m ${String(totalSeconds % 60)}s`;
};

const subagentStatusBadge = (status: RunSubagentInfo["status"]): { label: string; className: string } => {
  if (status === "completed") return { label: "done", className: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30" };
  if (status === "failed") return { label: "failed", className: "bg-red-500/10 text-red-300 ring-red-400/30" };
  if (status === "cancelled") return { label: "cancelled", className: "bg-amber-500/10 text-amber-300 ring-amber-400/30" };
  if (status === "running") return { label: "running", className: "bg-sky-500/10 text-sky-300 ring-sky-400/30" };
  return { label: "pending", className: "bg-zinc-500/10 text-zinc-300 ring-zinc-400/30" };
};

const buildSubagentStats = (info: RunSubagentInfo, durationLabel: string | null) => {
  const stats: string[] = [];
  if (durationLabel) stats.push(durationLabel);
  if (info.usage?.totalTokens) stats.push(`${info.usage.totalTokens.toLocaleString()} tok`);
  if (info.usage?.toolUses) stats.push(`${String(info.usage.toolUses)} ${info.usage.toolUses === 1 ? "tool" : "tools"}`);
  if (info.model) stats.push(info.model);
  if (info.isBackground) stats.push("background");
  return stats;
};

const SubagentExpandedContent = ({
  entry,
  heading,
  compactContent,
  onOpenWorkspaceFile,
  renderEntry,
}: Readonly<{
  entry: SubagentActivityEntry;
  heading: string;
  compactContent: boolean;
  onOpenWorkspaceFile?: (path: string) => void;
  renderEntry: (nested: ActivityEntry, index: number) => ReactNode;
}>) => (
  <div className="mt-1.5 space-y-1.5 border-l border-zinc-800/60 pl-2">
    {entry.info.prompt?.trim() && entry.info.prompt.trim() !== heading ? (
      <p className="whitespace-pre-wrap text-[10px] leading-snug text-zinc-500">{entry.info.prompt.trim()}</p>
    ) : null}
    {entry.entries.length > 0 ? (
      <div className="agent-worklog agent-worklog--nested">
        {entry.entries.map((nested, index) => renderEntry(nested, index))}
      </div>
    ) : null}
    {entry.info.summary?.trim() ? (
      <div className="agent-panel agent-panel--answer px-2 py-1.5">
        <ActivityMarkdownOrGitDiff
          content={entry.info.summary.trim()}
          compact={compactContent}
          className="agent-response-text"
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      </div>
    ) : null}
  </div>
);

export const ActivitySubagentCard = ({
  entry,
  compactContent,
  focusNonce = 0,
  onOpenWorkspaceFile,
  renderEntry,
  rowTime,
}: {
  entry: SubagentActivityEntry;
  compactContent: boolean;
  focusNonce?: number;
  onOpenWorkspaceFile?: (path: string) => void;
  renderEntry: (nested: ActivityEntry, index: number) => ReactNode;
  rowTime: (time: string | null | undefined) => string | null | undefined;
}) => {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (focusNonce > 0) {
      setExpanded(true);
    }
  }, [focusNonce]);
  const { info } = entry;
  const isRunning = info.status === "running";
  const badge = subagentStatusBadge(info.status);
  const durationLabel = formatSubagentDurationLabel(info);
  const heading = info.description?.trim() || info.prompt?.trim().split("\n")[0] || "Delegated task";
  const lastToolActivity = info.lastToolName ? `Using ${info.lastToolName}` : null;
  const liveActivity = isRunning ? info.activity ?? lastToolActivity : null;
  const hasExpandableContent = entry.entries.length > 0 || Boolean(info.summary?.trim()) || Boolean(info.prompt?.trim());
  const stats = buildSubagentStats(info, durationLabel);

  return (
    <div data-subagent-id={info.id}>
      <AgentLogRow tone="tools" label="Subagent" time={rowTime(new Date(entry.step.createdAt).toLocaleTimeString())}>
        <AgentPanel tone="tools" className="px-2.5 py-1.5">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1.5 text-left"
          onClick={() => setExpanded((current) => !current)}
          disabled={!hasExpandableContent}
          aria-expanded={expanded}
        >
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-400" />
          ) : (
            <Bot className="h-3.5 w-3.5 shrink-0 text-[color:var(--ec-muted)]" />
          )}
          <span className="shrink-0 text-[11px] font-medium text-zinc-200">{info.name ?? "agent"}</span>
          <Badge tone="queued" className={`shrink-0 px-1.5 py-0 text-[10px] ${badge.className}`}>
            {badge.label}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-400" title={heading}>
            {heading}
          </span>
          {stats.length > 0 ? (
            <span className="agent-density-meta shrink-0 text-[10px] text-zinc-500 tabular-nums">{stats.join(" · ")}</span>
          ) : null}
          {hasExpandableContent ? <ExpandChevron expanded={expanded} /> : null}
        </button>
        {liveActivity ? (
          <p className="mt-1 truncate pl-5 text-[10px] text-sky-300/80" title={liveActivity}>
            {liveActivity}
          </p>
        ) : null}
        {expanded ? (
          <SubagentExpandedContent
            entry={entry}
            heading={heading}
            compactContent={compactContent}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            renderEntry={renderEntry}
          />
        ) : null}
        </AgentPanel>
      </AgentLogRow>
    </div>
  );
};

