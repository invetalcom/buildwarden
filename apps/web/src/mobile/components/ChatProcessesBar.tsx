import { useMemo, useState } from "react";
import { buildProcessTree, LiveDot, summarizeProcesses, useOwnedProcesses } from "@buildwarden/renderer";
import { ChevronUp, Cpu } from "lucide-react";
import { ProcessList } from "./ProcessList";
import { Sheet } from "./Sheet";

/**
 * Pill above the chat composer that appears once the chat's agent started a process; it opens a
 * sheet with the full process list and its actions.
 */
export const ChatProcessesBar = ({ chatId }: { chatId: string }) => {
  const state = useOwnedProcesses("chat", chatId);
  const [open, setOpen] = useState(false);
  const processes = useMemo(() => state.snapshot?.processes ?? [], [state.snapshot]);
  const summary = useMemo(() => summarizeProcesses(processes), [processes]);
  const visible = useMemo(() => buildProcessTree(processes, { showExited: true, showAgents: false, query: "" }).length > 0, [processes]);

  if (!state.available || !visible) return null;
  const label = summary.running > 0
    ? `${String(summary.running)} process${summary.running === 1 ? "" : "es"} running`
    : `${String(summary.exited)} process${summary.exited === 1 ? "" : "es"} exited`;
  return (
    <div className="flex shrink-0 justify-center px-2 pt-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="m-tap flex max-w-full items-center gap-2 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3.5 text-xs font-medium text-[var(--ec-text)] active:bg-[var(--ec-hover)]"
        aria-label={`${label}. Show processes`}
      >
        <Cpu className="size-4 shrink-0 text-[var(--ec-accent)]" />
        {summary.running > 0 ? <LiveDot active className="size-1.5 shrink-0 rounded-full bg-[var(--ec-accent)] running-pulse" /> : null}
        <span className="truncate">{label}</span>
        {summary.ports.length > 0 ? (
          <span className="shrink-0 font-mono text-[var(--ec-accent)]">{summary.ports.slice(0, 2).map((port) => `:${String(port)}`).join(" ")}</span>
        ) : null}
        <ChevronUp className="size-4 shrink-0 text-[var(--ec-muted)]" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Processes" full>
        <ProcessList state={state} ownerLabel="chat" />
      </Sheet>
    </div>
  );
};
