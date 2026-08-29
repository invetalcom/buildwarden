import { useRef, useState } from "react";
import { Bot, ChevronDown, Loader2 } from "lucide-react";
import type { RunSubagentInfo } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";

const subagentStatusDotClass = (subagent: RunSubagentInfo) => {
  if (subagent.status === "running" || subagent.status === "pending") {
    return "animate-pulse bg-[var(--ec-accent)]";
  }
  if (subagent.status === "completed") {
    return "bg-[var(--ec-success)]";
  }
  return subagent.status === "failed" ? "bg-[var(--ec-danger)]" : "bg-[var(--ec-warning)]";
};

const subagentMenuTitle = (runningCount: number, totalCount: number) => {
  const noun = totalCount === 1 ? "subagent" : "subagents";
  return runningCount > 0 ? `${String(runningCount)} of ${String(totalCount)} ${noun} running` : `${String(totalCount)} ${noun}`;
};

export const RunSubagentMenu = ({
  subagents,
  onFocusSubagent,
}: {
  subagents: RunSubagentInfo[];
  onFocusSubagent?: (subagentId: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  if (subagents.length === 0) {
    return null;
  }
  const runningCount = subagents.filter((subagent) => subagent.status === "running" || subagent.status === "pending").length;
  return (
    <span ref={anchorRef} className="relative shrink-0">
      <button
        type="button"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition hover:brightness-125",
          runningCount > 0
            ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
            : "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]",
        )}
        title={subagentMenuTitle(runningCount, subagents.length)}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {runningCount > 0 ? <Loader2 className="size-3 animate-spin" /> : <Bot className="size-3" />}
        {subagents.length} subagent{subagents.length === 1 ? "" : "s"}
        <ChevronDown className="size-3" />
      </button>
      <AnchorDropdownPortal
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        widthPx={288}
        maxHeightPx={320}
        className="glass-popover overflow-hidden py-1"
      >
        <div role="menu" aria-label="Run subagents" className="app-scrollbar max-h-72 overflow-y-auto">
          {subagents.map((subagent) => {
            const label = subagent.name ?? subagent.description ?? subagent.prompt?.split("\n")[0] ?? subagent.id;
            const detail = subagent.name ? subagent.description ?? subagent.prompt?.split("\n")[0] : undefined;
            return (
              <button
                key={subagent.id}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] transition hover:bg-[var(--ec-hover)]"
                onClick={() => {
                  setOpen(false);
                  onFocusSubagent?.(subagent.id);
                }}
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", subagentStatusDotClass(subagent))} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{label}</span>
                  {detail ? <span className="block truncate text-[10px] text-[var(--ec-muted)]">{detail}</span> : null}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--ec-muted)]">{subagent.status}</span>
              </button>
            );
          })}
        </div>
      </AnchorDropdownPortal>
    </span>
  );
};
