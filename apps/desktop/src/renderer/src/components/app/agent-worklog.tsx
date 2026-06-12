import { forwardRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export type AgentWorklogTone =
  | "prompt"
  | "answer"
  | "reasoning"
  | "tools"
  | "status"
  | "request"
  | "plan"
  | "diff"
  | "error"
  | "note";

export const AgentWorklog = forwardRef<
  HTMLDivElement,
  {
    children: ReactNode;
    className?: string;
    empty?: ReactNode;
  }
>(({ children, className, empty }, ref) => (
  <div ref={ref} className={cn("agent-worklog", className)}>
    {children}
    {empty ? <div className="agent-worklog-empty">{empty}</div> : null}
  </div>
));

AgentWorklog.displayName = "AgentWorklog";

export const AgentLogRow = ({
  tone,
  label,
  time,
  children,
  className,
}: {
  tone: AgentWorklogTone;
  label: string;
  time?: string | null;
  children: ReactNode;
  className?: string;
}) => (
  <section className={cn("agent-log-row", `agent-log-row--${tone}`, className)}>
    <div className="agent-log-gutter" aria-hidden="true">
      <span className="agent-log-dot" />
      <span className="agent-log-label">{label}</span>
      {time ? <span className="agent-log-time">{time}</span> : null}
    </div>
    <div className="agent-log-main">{children}</div>
  </section>
);

export const AgentPanel = ({
  tone = "note",
  children,
  className,
}: {
  tone?: AgentWorklogTone;
  children: ReactNode;
  className?: string;
}) => <div className={cn("agent-panel", `agent-panel--${tone}`, className)}>{children}</div>;

export const AgentPanelHeader = ({
  title,
  detail,
  actions,
  className,
}: {
  title: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) => (
  <div className={cn("agent-panel-header", className)}>
    <div className="min-w-0">
      <div className="agent-panel-title">{title}</div>
      {detail ? <div className="agent-panel-detail">{detail}</div> : null}
    </div>
    {actions ? <div className="agent-panel-actions">{actions}</div> : null}
  </div>
);

export const AgentChip = ({
  children,
  tone = "note",
  className,
}: {
  children: ReactNode;
  tone?: AgentWorklogTone;
  className?: string;
}) => <span className={cn("agent-chip", `agent-chip--${tone}`, className)}>{children}</span>;
