import type { ReactNode } from "react";
import { ChevronRight, Eye } from "lucide-react";
import type { PrWatchWakeRecord } from "./pr-watch-ui";

/** A turn the PR watch started: its one-line reason, with the prompt the agent got folded away. */
export const PrWatchWakeMessage = ({ wake, children }: Readonly<{ wake: PrWatchWakeRecord; children: ReactNode }>) => (
  <div className="min-w-0">
    <p className="flex items-center gap-1.5 font-medium">
      <Eye className="h-3.5 w-3.5 shrink-0 text-[var(--ec-accent)]" aria-hidden />
      <span className="min-w-0">{wake.label}</span>
    </p>
    <details className="group/wake mt-1">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-[var(--ec-muted)] outline-none hover:text-[var(--ec-text)] focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)] [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 shrink-0 transition group-open/wake:rotate-90" aria-hidden />
        {wake.repair ? "Show the request" : "Show the prompt"}
      </summary>
      <div className="mt-1">{children}</div>
    </details>
  </div>
);
