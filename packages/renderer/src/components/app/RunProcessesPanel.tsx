import { Cpu, Eraser, OctagonX, Search, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { OwnedProcessList } from "./OwnedProcessList";
import { buildProcessTree, localhostUrl, summarizeProcesses } from "./owned-processes-model";
import { useOwnedProcesses, useProcessClock } from "./use-owned-processes";

const FilterToggle = ({ pressed, onChange, children }: { pressed: boolean; onChange: (next: boolean) => void; children: string }) => (
  <button
    type="button"
    aria-pressed={pressed}
    onClick={() => onChange(!pressed)}
    className={cn(
      "h-6 shrink-0 rounded-md border px-2 text-[11px] transition-colors",
      pressed
        ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
        : "border-[var(--ec-border)] text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
    )}
  >
    {children}
  </button>
);

/** Kill all asks for a second click within a few seconds instead of a modal. */
const useConfirmClick = (timeoutMs = 3_000) => {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [armed, timeoutMs]);
  return { armed, arm: () => setArmed(true), reset: () => setArmed(false) };
};

export interface RunProcessesPanelProps {
  runId: string;
  /** Opens a URL in the run's in-app browser panel; omitted where the host's ports are out of reach. */
  onOpenUrl?: (url: string) => void;
}

export const RunProcessesPanel = ({ runId, onOpenUrl }: RunProcessesPanelProps) => {
  const state = useOwnedProcesses("run", runId);
  const [showExited, setShowExited] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [query, setQuery] = useState("");
  const killAll = useConfirmClick();
  const processes = useMemo(() => state.snapshot?.processes ?? [], [state.snapshot]);
  const summary = useMemo(() => summarizeProcesses(processes), [processes]);
  const rows = useMemo(() => buildProcessTree(processes, { showExited, showAgents, query }), [processes, query, showAgents, showExited]);
  const now = useProcessClock(summary.running > 0 || summary.agents > 0);
  const bulkBusy = state.pending.has("stop-all") || state.pending.has("kill-all") || state.pending.has("clear-exited");

  if (!state.available) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--ec-muted)]">
        This session cannot view the host's processes.
      </div>
    );
  }
  if (state.snapshot && !state.snapshot.supported) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--ec-muted)]">
        BuildWarden cannot inspect processes on this operating system.
      </div>
    );
  }

  const hiddenCount = processes.filter((process) => process.role !== "agent").length - rows.filter((row) => row.process.role !== "agent").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-[var(--ec-border)] px-3 py-2">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 shrink-0 text-[var(--ec-accent)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--ec-text)]">Processes</p>
            <p className="truncate text-[11px] text-[var(--ec-muted)]">
              {summary.running} running · {summary.exited} exited
              {summary.ports.length > 0 ? ` · ports ${summary.ports.map((port) => `:${String(port)}`).join(" ")}` : ""}
            </p>
          </div>
          {state.canManage ? (<>
          <Button
            type="button" variant="ghost" size="xs" className="h-7 px-2 text-[11px]"
            disabled={bulkBusy || summary.running === 0}
            onClick={() => void state.act({ action: "stop-all" })}
            title="Stop every process this run started (the agent keeps running)"
          >
            <Square className="h-3 w-3" aria-hidden />Stop all
          </Button>
          <Button
            type="button" variant="ghost" size="xs"
            className={cn("h-7 px-2 text-[11px]", killAll.armed && "bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]")}
            disabled={bulkBusy || summary.running === 0}
            onClick={() => {
              if (!killAll.armed) {
                killAll.arm();
                return;
              }
              killAll.reset();
              void state.act({ action: "kill-all" });
            }}
            title="Kill every process this run started immediately"
          >
            <OctagonX className="h-3.5 w-3.5" aria-hidden />{killAll.armed ? "Confirm kill" : "Kill all"}
          </Button>
          <Button
            type="button" variant="ghost" size="icon" className="h-7 w-7"
            disabled={bulkBusy || summary.exited === 0}
            onClick={() => void state.act({ action: "clear-exited" })}
            title="Clear exited processes"
            aria-label="Clear exited processes"
          >
            <Eraser className="h-3.5 w-3.5" aria-hidden />
          </Button>
          </>) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--ec-faint)]" aria-hidden />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by name, command, PID, or port"
              aria-label="Filter processes"
              className="h-7 pl-6 text-[11px]"
            />
          </div>
          <FilterToggle pressed={showExited} onChange={setShowExited}>Exited</FilterToggle>
          <FilterToggle pressed={showAgents} onChange={setShowAgents}>Agent</FilterToggle>
        </div>
      </div>
      {state.error ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--ec-border)] bg-[var(--ec-danger-soft)] px-3 py-1.5 text-[11px] text-[var(--ec-danger)]" role="alert">
          <span className="min-w-0 flex-1">{state.error}</span>
          <button type="button" onClick={state.clearError} aria-label="Dismiss error"><X className="h-3 w-3" aria-hidden /></button>
        </div>
      ) : null}
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
        {rows.length > 0 ? (
          <OwnedProcessList rows={rows} state={state} now={now} onOpenPort={onOpenUrl} openPortLabel="Open in browser" />
        ) : (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1 px-6 py-8 text-center">
            <p className="text-sm font-medium text-[var(--ec-text)]">{query ? "No matching processes" : "No processes running"}</p>
            <p className="max-w-sm text-[11px] leading-5 text-[var(--ec-muted)]">
              {query
                ? "Try another filter."
                : "Dev servers, watchers, builds, and other commands the agent starts appear here, even after the agent's turn ends."}
            </p>
            {hiddenCount > 0 && !showExited ? (
              <Button type="button" variant="ghost" size="xs" className="mt-1 h-6 px-2 text-[11px]" onClick={() => setShowExited(true)}>
                Show {hiddenCount} exited
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {summary.ports.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-[var(--ec-border)] px-3 py-1.5 text-[11px] text-[var(--ec-muted)]">
          <span>Listening:</span>
          {summary.ports.map((port) => !onOpenUrl ? (
            <span key={port} className="px-1 font-mono text-[var(--ec-accent)]">{localhostUrl(port).replace("http://", "")}</span>
          ) : (
            <button
              key={port}
              type="button"
              className="rounded px-1 font-mono text-[var(--ec-accent)] hover:bg-[var(--ec-hover)]"
              onClick={() => onOpenUrl(localhostUrl(port))}
              title={`Open ${localhostUrl(port)} in the browser panel`}
            >
              {localhostUrl(port).replace("http://", "")}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
