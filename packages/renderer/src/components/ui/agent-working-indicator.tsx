import { LoadingBar, Spinner } from "./motion";
import "./agent-working-indicator.css";

export const AgentWorkingIndicator = ({ label = "Agent is working...", className = "" }: { label?: string; className?: string }) => (
  <div data-ui="working" className={`agent-loading ${className}`} role="status" aria-live="polite">
    <LoadingBar className="mb-2" />
    <div data-ui="working-row" className="flex items-center gap-2 text-[11px] text-[var(--ec-muted)]">
      <Spinner className="h-3.5 w-3.5 shrink-0 text-[color:var(--ec-accent)]" aria-hidden />
      <span data-ui="working-label" className="animate-pulse">{label}</span>
    </div>
  </div>
);
