import { ChevronDown, Cpu, Eraser, Square, X } from "lucide-react";
import { LiveDot } from "../ui/motion";
import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { OwnedProcessList } from "./OwnedProcessList";
import { buildProcessTree, localhostUrl, summarizeProcesses } from "./owned-processes-model";
import { useOwnedProcesses, useProcessClock } from "./use-owned-processes";

/**
 * Toolbar above the chat composer listing processes the chat's agent started (dev servers,
 * watchers). Hidden until the chat has started one; collapsed by default like the run's
 * changed-files card.
 */
export const ChatProcessesBar = ({ chatId }: { chatId: string }) => {
  const client = useBuildWardenClient();
  const state = useOwnedProcesses("chat", chatId);
  const [expanded, setExpanded] = useState(false);
  const processes = useMemo(() => state.snapshot?.processes ?? [], [state.snapshot]);
  const summary = useMemo(() => summarizeProcesses(processes), [processes]);
  const rows = useMemo(() => buildProcessTree(processes, { showExited: true, showAgents: false, query: "" }), [processes]);
  const now = useProcessClock(expanded && summary.running > 0);

  if (!state.available || rows.length === 0) return null;
  // `localhost` only reaches the host's ports from the desktop app itself.
  const openPort = client.capabilities.platform === "electron" ? (url: string) => void client.openExternalUrl(url) : undefined;
  const label = summary.running > 0
    ? `${String(summary.running)} process${summary.running === 1 ? "" : "es"} running`
    : `${String(summary.exited)} process${summary.exited === 1 ? "" : "es"} exited`;
  const bulkBusy = state.pending.has("stop-all") || state.pending.has("clear-exited");

  return (
    <div className="flex shrink-0 justify-center px-2 pb-1.5">
      <div
        className={cn(
          "overflow-hidden rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-lg shadow-black/20",
          expanded ? "w-full max-w-3xl" : "w-fit max-w-full",
        )}
      >
        <div className="flex h-8 items-center gap-1 px-1.5">
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-[12px] font-medium text-[var(--ec-text)] transition hover:bg-[var(--ec-hover)]"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse processes" : "Expand processes"}
          >
            <Cpu className="h-3.5 w-3.5 shrink-0 text-[var(--ec-accent)]" aria-hidden />
            {summary.running > 0 ? <LiveDot active className="size-1.5 shrink-0 rounded-full bg-[var(--ec-accent)] running-pulse" /> : null}
            <span className="truncate">{label}</span>
            <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-[var(--ec-muted)] transition-transform", expanded && "rotate-180")} aria-hidden />
          </button>
          {summary.ports.slice(0, 3).map((port) => !openPort ? (
            <span key={port} className="shrink-0 rounded-full bg-[var(--ec-accent-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ec-accent)] ring-1 ring-inset ring-[var(--ec-accent-ring)]" title={`Listening on port ${String(port)} on the host`}>:{port}</span>
          ) : (
            <button
              key={port}
              type="button"
              className="shrink-0 rounded-full bg-[var(--ec-accent-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ec-accent)] ring-1 ring-inset ring-[var(--ec-accent-ring)] hover:brightness-110"
              onClick={() => openPort(localhostUrl(port))}
              title={`Open ${localhostUrl(port)}`}
              aria-label={`Open port ${String(port)}`}
            >
              :{port}
            </button>
          ))}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {state.canManage && summary.running > 0 ? (
              <Button
                type="button" variant="ghost" size="icon" className="h-6 w-6"
                disabled={bulkBusy}
                onClick={() => void state.act({ action: "stop-all" })}
                title="Stop all processes this chat started"
                aria-label="Stop all processes"
              >
                <Square className="h-3 w-3" aria-hidden />
              </Button>
            ) : null}
            {state.canManage && summary.exited > 0 ? (
              <Button
                type="button" variant="ghost" size="icon" className="h-6 w-6"
                disabled={bulkBusy}
                onClick={() => void state.act({ action: "clear-exited" })}
                title="Clear exited processes"
                aria-label="Clear exited processes"
              >
                <Eraser className="h-3 w-3" aria-hidden />
              </Button>
            ) : null}
          </div>
        </div>
        {state.error ? (
          <div className="flex items-start gap-2 border-t border-[var(--ec-border)] bg-[var(--ec-danger-soft)] px-2.5 py-1 text-[11px] text-[var(--ec-danger)]" role="alert">
            <span className="min-w-0 flex-1">{state.error}</span>
            <button type="button" onClick={state.clearError} aria-label="Dismiss error"><X className="h-3 w-3" aria-hidden /></button>
          </div>
        ) : null}
        {expanded ? (
          <div className="app-scrollbar max-h-56 overflow-y-auto border-t border-[var(--ec-border)]">
            <OwnedProcessList rows={rows} state={state} now={now} compact onOpenPort={openPort} openPortLabel="Open" />
          </div>
        ) : null}
      </div>
    </div>
  );
};
