import { Loader2 } from "lucide-react";
import "./agent-working-indicator.css";

export const AgentWorkingIndicator = ({ label = "Agent is working...", className = "" }: { label?: string; className?: string }) => (
  <div className={`agent-loading ${className}`} role="status" aria-live="polite">
    <div className="run-activity-loading-bar mb-2" />
    <div className="flex items-center gap-2 text-[11px] text-[var(--ec-muted)]">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[color:var(--ec-accent)]" aria-hidden />
      <span className="animate-pulse">{label}</span>
    </div>
  </div>
);
