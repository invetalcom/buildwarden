import { useEffect, useMemo, useState } from "react";
import {
  buildProcessTree,
  describeProcessCommand,
  formatProcessCpu,
  formatProcessDuration,
  formatProcessMemory,
  LiveDot,
  PROCESS_ROLE_LABELS,
  processStatusPresentation,
  summarizeProcesses,
  useProcessClock,
  WORKSPACE_ATTRIBUTION_HINT,
  type OwnedProcessesState,
} from "@buildwarden/renderer";
import type { OwnedProcessOutput, OwnedProcessRecord } from "@buildwarden/shared";
import { Copy, Cpu, Eraser, OctagonX, RotateCw, ScrollText, Square } from "lucide-react";
import { cn } from "../lib/cn";
import { Badge, Button, EmptyState, FilterChip, InlineError, ListRow, type Tone } from "./primitives";
import { ActionSheet, ConfirmSheet, Sheet, type SheetAction } from "./Sheet";

const OUTPUT_REFRESH_MS = 1_500;

const STATUS_TONES: Record<string, Tone> = {
  running: "accent",
  queued: "warning",
  failed: "danger",
  cancelled: "neutral",
  completed: "success",
};

const copyText = (text: string) => {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
};

const statusDot = (process: OwnedProcessRecord) =>
  process.status === "running"
    ? "bg-[var(--ec-accent)] running-pulse"
    : process.status === "stopping"
      ? "bg-[var(--ec-warning)]"
      : process.endReason === "killed" || (process.exitCode !== null && process.exitCode !== 0)
        ? "bg-[var(--ec-danger)]"
        : "bg-[var(--ec-faint)]";

/** Captured output of a restarted process, refreshed while it runs. */
const OutputSheet = ({ process, state, onClose }: { process: OwnedProcessRecord | null; state: OwnedProcessesState; onClose: () => void }) => {
  const [output, setOutput] = useState<OwnedProcessOutput | null>(null);
  const processId = process?.processId ?? null;
  const running = process ? process.status !== "exited" : false;
  const { loadOutput } = state;
  useEffect(() => {
    setOutput(null);
    if (!processId) return;
    let disposed = false;
    const load = () => void loadOutput(processId).then((next) => { if (!disposed && next) setOutput(next); });
    load();
    if (!running) return () => { disposed = true; };
    const timer = window.setInterval(load, OUTPUT_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loadOutput, processId, running]);
  const text = output?.text ?? "";
  return (
    <Sheet
      open={Boolean(process)}
      onClose={onClose}
      full
      title={process ? `${process.name} output${output?.truncated ? " (latest part)" : ""}` : "Output"}
      footer={<Button tone="neutral" block disabled={!text} onClick={() => copyText(text)}><Copy className="size-4" />Copy output</Button>}
    >
      <pre className="m-wrap-anywhere whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-5 text-[var(--ec-text)]">
        {text || (running ? "Waiting for output…" : "No output.")}
      </pre>
    </Sheet>
  );
};

export interface ProcessListProps {
  state: OwnedProcessesState;
  ownerLabel: "run" | "chat";
  /** Shown above the list; the chat sheet omits it because its title already summarizes. */
  showHeader?: boolean;
}

/** Touch-sized list of the processes a run or chat started, with actions in an action sheet. */
export const ProcessList = ({ state, ownerLabel, showHeader = true }: ProcessListProps) => {
  const [showExited, setShowExited] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outputId, setOutputId] = useState<string | null>(null);
  const [confirmKillAll, setConfirmKillAll] = useState(false);
  const processes = useMemo(() => state.snapshot?.processes ?? [], [state.snapshot]);
  const summary = useMemo(() => summarizeProcesses(processes), [processes]);
  const rows = useMemo(() => buildProcessTree(processes, { showExited, showAgents, query: "" }), [processes, showAgents, showExited]);
  const now = useProcessClock(summary.running > 0);
  const selected = processes.find((process) => process.processId === selectedId) ?? null;
  const outputProcess = processes.find((process) => process.processId === outputId) ?? null;
  const bulkBusy = state.pending.has("stop-all") || state.pending.has("kill-all") || state.pending.has("clear-exited");

  if (state.snapshot && !state.snapshot.supported) {
    return <EmptyState icon={<Cpu className="size-8" />} title="Not supported" message="BuildWarden cannot inspect processes on the host's operating system." />;
  }

  const actions = (process: OwnedProcessRecord): SheetAction[] => {
    const live = process.status !== "exited";
    const manageable = state.canManage && process.role !== "agent";
    return [
      ...(manageable && process.restartable ? [{
        label: live ? "Restart" : "Run again",
        hint: "Runs the same command again in the workspace",
        icon: <RotateCw className="size-4" />,
        onSelect: () => void state.act({ action: "restart", processId: process.processId }),
      }] : []),
      ...(manageable && live ? [
        { label: "Stop", hint: "Asks it to exit, then forces it after a few seconds", icon: <Square className="size-4" />, onSelect: () => void state.act({ action: "stop", processId: process.processId }) },
        { label: "Kill now", danger: true, icon: <OctagonX className="size-4" />, onSelect: () => void state.act({ action: "kill", processId: process.processId }) },
      ] : []),
      ...(process.hasOutput ? [{ label: "Show output", icon: <ScrollText className="size-4" />, onSelect: () => setOutputId(process.processId) }] : []),
      ...(process.commandLine ? [{ label: "Copy command", hint: process.commandLine, icon: <Copy className="size-4" />, onSelect: () => copyText(process.commandLine ?? "") }] : []),
      { label: "Copy PID", hint: process.attribution === "workspace" ? WORKSPACE_ATTRIBUTION_HINT : String(process.pid), icon: <Copy className="size-4" />, onSelect: () => copyText(String(process.pid)) },
    ];
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showHeader ? (
        <div className="shrink-0 border-b border-[var(--ec-border)] px-4 py-2">
          <p className="text-xs text-[var(--ec-muted)]">
            {summary.running} running · {summary.exited} exited
            {summary.ports.length > 0 ? ` · ports ${summary.ports.map((port) => `:${String(port)}`).join(" ")}` : ""}
          </p>
        </div>
      ) : null}
      <div className="m-scroll-x flex shrink-0 items-center gap-2 border-b border-[var(--ec-border)] px-4 py-1.5">
        <FilterChip active={showExited} onClick={() => setShowExited((current) => !current)}>Exited</FilterChip>
        <FilterChip active={showAgents} onClick={() => setShowAgents((current) => !current)}>Agent</FilterChip>
        {state.canManage ? (
          <>
            <Button tone="neutral" size="sm" className="ml-auto" disabled={bulkBusy || summary.running === 0} onClick={() => void state.act({ action: "stop-all" })}>
              <Square className="size-3.5" />Stop all
            </Button>
            <Button tone="danger" size="sm" disabled={bulkBusy || summary.running === 0} onClick={() => setConfirmKillAll(true)}>
              <OctagonX className="size-3.5" />Kill all
            </Button>
            <Button tone="ghost" size="sm" aria-label="Clear exited processes" disabled={bulkBusy || summary.exited === 0} onClick={() => void state.act({ action: "clear-exited" })}>
              <Eraser className="size-4" />
            </Button>
          </>
        ) : null}
      </div>
      {state.error ? <InlineError message={state.error} /> : null}
      <div className="m-scroll min-h-0 flex-1">
        {rows.length === 0 ? (
          <EmptyState
            icon={<Cpu className="size-8" />}
            title="No processes running"
            message={`Dev servers, watchers, and other commands this ${ownerLabel} starts appear here.`}
          />
        ) : rows.map(({ process, depth }) => {
          const status = processStatusPresentation(process);
          const live = process.status !== "exited";
          return (
            <div key={process.processId} style={{ paddingLeft: `${String(depth * 16)}px` }} className="border-b border-[var(--ec-border)]">
              <ListRow
                onClick={() => setSelectedId(process.processId)}
                leading={<LiveDot active={process.status === "running"} className={cn("size-2 rounded-full", statusDot(process))} />}
                title={(
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{process.name}</span>
                    {process.role !== "command" ? <Badge>{PROCESS_ROLE_LABELS[process.role]}</Badge> : null}
                    {process.attribution === "workspace" ? <Badge>Detected</Badge> : null}
                  </span>
                )}
                subtitle={(
                  <span className="flex flex-col gap-0.5">
                    <span className="truncate font-mono">{describeProcessCommand(process)}</span>
                    <span className="truncate">
                      {live ? `${formatProcessCpu(process.cpuPercent)} · ${formatProcessMemory(process.memoryBytes)} · ` : ""}
                      {formatProcessDuration(process.startedAt, process.endedAt, now)}
                      {process.ports.length > 0 ? ` · ${process.ports.map((port) => `:${String(port)}`).join(" ")}` : ""}
                    </span>
                  </span>
                )}
                trailing={live ? null : <Badge tone={STATUS_TONES[status.tone] ?? "neutral"}>{status.label}</Badge>}
              />
            </div>
          );
        })}
      </div>
      <ActionSheet
        open={Boolean(selected)}
        onClose={() => setSelectedId(null)}
        title={selected ? `${selected.name} · PID ${String(selected.pid)}` : undefined}
        actions={selected ? actions(selected) : []}
      />
      <OutputSheet process={outputProcess} state={state} onClose={() => setOutputId(null)} />
      <ConfirmSheet
        open={confirmKillAll}
        title="Kill all processes?"
        message={`Ends every process this ${ownerLabel} started immediately. The agent keeps running.`}
        confirmLabel="Kill all"
        danger
        onClose={() => setConfirmKillAll(false)}
        onConfirm={() => {
          setConfirmKillAll(false);
          void state.act({ action: "kill-all" });
        }}
      />
    </div>
  );
};
