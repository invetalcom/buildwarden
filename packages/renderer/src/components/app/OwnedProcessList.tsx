import type { OwnedProcessOutput, OwnedProcessRecord } from "@buildwarden/shared";
import { ChevronRight, Copy, ExternalLink, OctagonX, RotateCw, Square } from "lucide-react";
import { LiveDot, Spinner } from "../ui/motion";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  describeProcessCommand,
  formatProcessCpu,
  formatProcessDuration,
  formatProcessMemory,
  localhostUrl,
  PROCESS_ROLE_LABELS,
  processStatusPresentation,
  WORKSPACE_ATTRIBUTION_HINT,
  type ProcessTreeRow,
} from "./owned-processes-model";
import type { OwnedProcessesState } from "./use-owned-processes";

const OUTPUT_REFRESH_MS = 1_500;

const copyText = (text: string) => {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
};

const statusDotClass = (process: OwnedProcessRecord) =>
  process.status === "running"
    ? "bg-[var(--ec-accent)] running-pulse"
    : process.status === "stopping"
      ? "bg-[var(--ec-warning)]"
      : process.endReason === "killed" || (process.exitCode !== null && process.exitCode !== 0)
        ? "bg-[var(--ec-danger)]"
        : "bg-[var(--ec-faint)]";

/** Live tail of output BuildWarden captured for a restarted process. */
const ProcessOutput = ({ process, loadOutput }: { process: OwnedProcessRecord; loadOutput: OwnedProcessesState["loadOutput"] }) => {
  const [output, setOutput] = useState<OwnedProcessOutput | null>(null);
  const running = process.status !== "exited";
  useEffect(() => {
    let disposed = false;
    const load = () => {
      void loadOutput(process.processId).then((next) => {
        if (!disposed && next) setOutput(next);
      });
    };
    load();
    if (!running) return () => { disposed = true; };
    const timer = window.setInterval(load, OUTPUT_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loadOutput, process.processId, running]);
  const text = output?.text ?? "";
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-[var(--ec-faint)]">
          Output{output?.truncated ? " (latest part)" : ""}
        </span>
        <Button type="button" variant="ghost" size="xs" className="h-6 px-1.5 text-[11px]" disabled={!text} onClick={() => copyText(text)}>
          <Copy className="h-3 w-3" aria-hidden />Copy output
        </Button>
      </div>
      <pre className="app-scrollbar max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--ec-border)] bg-[var(--ec-bg)] p-2 font-mono text-[11px] leading-4 text-[var(--ec-text)]">
        {text || (running ? "Waiting for output…" : "No output.")}
      </pre>
    </div>
  );
};

const DetailRow = ({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) => (
  <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 py-0.5">
    <span className="text-[var(--ec-faint)]">{label}</span>
    <span className={cn("min-w-0 select-text break-all text-[var(--ec-text)]", mono && "font-mono")}>{value}</span>
  </div>
);

export interface OwnedProcessListProps {
  rows: ProcessTreeRow[];
  state: OwnedProcessesState;
  now: number;
  /** Compact rows hide the metric columns (used in the chat toolbar). */
  compact?: boolean;
  /** Omitted when this client cannot reach the host's ports; they then show as plain labels. */
  onOpenPort?: (url: string) => void;
  openPortLabel: string;
}

const PORT_CHIP_CLASS = "shrink-0 rounded-full bg-[var(--ec-accent-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ec-accent)] ring-1 ring-inset ring-[var(--ec-accent-ring)]";

export const OwnedProcessList = ({ rows, state, now, compact = false, onOpenPort, openPortLabel }: OwnedProcessListProps) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <ul className="divide-y divide-[var(--ec-border)]" aria-label="Processes">
      {rows.map(({ process, depth, descendantCount }) => {
        const status = processStatusPresentation(process);
        const expanded = expandedId === process.processId;
        const busy = state.pending.has(process.processId);
        const live = process.status !== "exited";
        const isAgent = process.role === "agent";
        const command = describeProcessCommand(process);
        const childHint = descendantCount > 0 ? ` and ${String(descendantCount)} child process${descendantCount === 1 ? "" : "es"}` : "";
        return (
          <li key={process.processId} className={cn("group text-[11px]", !live && "opacity-75")}>
            <div className="flex min-h-8 items-center gap-1.5 px-2 py-1 hover:bg-[var(--ec-hover)]" style={{ paddingLeft: `${String(8 + depth * 14)}px` }}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => setExpandedId(expanded ? null : process.processId)}
                aria-expanded={expanded}
                title={process.commandLine ?? process.name}
              >
                <ChevronRight className={cn("h-3 w-3 shrink-0 text-[var(--ec-faint)] transition-transform", expanded && "rotate-90")} aria-hidden />
                <LiveDot active={process.status === "running"} className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(process))} />
                <span className="shrink-0 font-medium text-[var(--ec-text)]">{process.name}</span>
                {command !== process.name ? <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--ec-muted)]">{command}</span> : null}
                {isAgent || process.role === "restarted" ? (
                  <Badge tone="neutral" className="shrink-0 px-1.5 py-0 text-[9.5px]">{PROCESS_ROLE_LABELS[process.role]}</Badge>
                ) : null}
                {process.attribution === "workspace" ? (
                  <Badge tone="neutral" className="shrink-0 px-1.5 py-0 text-[9.5px]" title={WORKSPACE_ATTRIBUTION_HINT}>Detected</Badge>
                ) : null}
                <span className="sr-only">{status.label}</span>
              </button>
              {process.ports.map((port) => onOpenPort ? (
                <button
                  key={port}
                  type="button"
                  className={cn(PORT_CHIP_CLASS, "hover:brightness-110")}
                  onClick={() => onOpenPort(localhostUrl(port))}
                  title={`${openPortLabel} ${localhostUrl(port)}`}
                  aria-label={`${openPortLabel} port ${String(port)}`}
                >
                  :{port}
                </button>
              ) : (
                <span key={port} className={PORT_CHIP_CLASS} title={`Listening on port ${String(port)} on the host`}>:{port}</span>
              ))}
              {!compact ? (
                <span className="hidden shrink-0 tabular-nums text-[10px] text-[var(--ec-muted)] sm:inline">
                  {live ? `${formatProcessCpu(process.cpuPercent)} · ${formatProcessMemory(process.memoryBytes)} · ` : ""}
                  {formatProcessDuration(process.startedAt, process.endedAt, now)}
                </span>
              ) : null}
              {!live ? <Badge tone={status.tone} className="shrink-0 px-1.5 py-0 text-[9.5px]">{status.label}</Badge> : null}
              {!isAgent && state.canManage ? (
                <div className="flex shrink-0 items-center">
                  {process.restartable ? (
                    <Button
                      type="button" variant="ghost" size="icon" className="h-6 w-6"
                      disabled={busy || process.status === "stopping"}
                      onClick={() => void state.act({ action: "restart", processId: process.processId })}
                      title={live ? `Restart: stop${childHint} and run the same command again` : "Run the same command again"}
                      aria-label={`${live ? "Restart" : "Run again"} ${process.name}`}
                    >
                      <Spinner icon={RotateCw} spinning={Boolean(busy)} className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  ) : null}
                  {live ? (
                    <>
                      <Button
                        type="button" variant="ghost" size="icon" className="h-6 w-6"
                        disabled={busy || process.status === "stopping"}
                        onClick={() => void state.act({ action: "stop", processId: process.processId })}
                        title={`Stop${childHint}; force it after a few seconds`}
                        aria-label={`Stop ${process.name}`}
                      >
                        <Square className="h-3 w-3" aria-hidden />
                      </Button>
                      <Button
                        type="button" variant="ghost" size="icon" className="h-6 w-6 hover:text-[var(--ec-danger)]"
                        disabled={busy}
                        onClick={() => void state.act({ action: "kill", processId: process.processId })}
                        title={`Kill now${childHint}`}
                        aria-label={`Kill ${process.name}`}
                      >
                        <OctagonX className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
            {expanded ? (
              <div className="border-t border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2 text-[11px]" style={{ paddingLeft: `${String(22 + depth * 14)}px` }}>
                <DetailRow label="Status" value={status.label} />
                <DetailRow label="PID" value={String(process.pid)} mono />
                <DetailRow label="Role" value={isAgent ? "Agent (stop the run or chat to end it)" : PROCESS_ROLE_LABELS[process.role]} />
                {process.attribution === "workspace" ? <DetailRow label="Linked by" value={WORKSPACE_ATTRIBUTION_HINT} /> : null}
                <DetailRow label="Started" value={new Date(process.startedAt).toLocaleString()} />
                {process.endedAt ? <DetailRow label="Ended" value={new Date(process.endedAt).toLocaleString()} /> : null}
                {live ? <DetailRow label="CPU · Memory" value={`${formatProcessCpu(process.cpuPercent)} · ${formatProcessMemory(process.memoryBytes)}`} /> : null}
                {process.cwd ? <DetailRow label={process.role === "restarted" ? "Directory" : "Workspace"} value={process.cwd} mono /> : null}
                <DetailRow label="Command" value={process.commandLine ?? "Not available for this process"} mono />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {process.commandLine ? (
                    <Button type="button" variant="outline" size="xs" className="h-6 px-2 text-[11px]" onClick={() => copyText(process.commandLine ?? "")}>
                      <Copy className="h-3 w-3" aria-hidden />Copy command
                    </Button>
                  ) : null}
                  <Button type="button" variant="outline" size="xs" className="h-6 px-2 text-[11px]" onClick={() => copyText(String(process.pid))}>
                    <Copy className="h-3 w-3" aria-hidden />Copy PID
                  </Button>
                  {onOpenPort && process.ports.map((port) => (
                    <Button key={port} type="button" variant="outline" size="xs" className="h-6 px-2 text-[11px]" onClick={() => onOpenPort(localhostUrl(port))}>
                      <ExternalLink className="h-3 w-3" aria-hidden />{openPortLabel} :{port}
                    </Button>
                  ))}
                </div>
                {process.hasOutput ? <ProcessOutput process={process} loadOutput={state.loadOutput} /> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};
