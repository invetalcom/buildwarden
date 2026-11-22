import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import { StatusBarItem } from "../../lib/status-bar";

type Props = {
  /** Receives the element run-scoped workspace segments (branch, diff, pull request, plan) render into. */
  workspaceSlotRef: (element: HTMLElement | null) => void;
  /** Receives the element session segments (context, tokens, processes) render into. */
  sessionSlotRef: (element: HTMLElement | null) => void;
  activeRunCount: number;
  onOpenAllRuns: () => void;
  /** App-wide segments supplied by the shell: approval inbox, subscription limits. */
  trailing?: ReactNode;
  /** Shown first, for example the instance a remote browser is connected to. */
  leading?: ReactNode;
};

/**
 * Bottom status bar. Left: the workspace of the open run. Right: the session, then the app.
 * It sits on the window backdrop without a fill; segments are separated by spacing only.
 */
export const AppStatusBar = ({ workspaceSlotRef, sessionSlotRef, activeRunCount, onOpenAllRuns, trailing, leading }: Props) => (
  <footer data-ui="statusbar" aria-label="Status bar">
    {leading}
    <span ref={workspaceSlotRef} className="contents" />
    <span className="min-w-2 flex-1" />
    <span ref={sessionSlotRef} className="contents" />
    <StatusBarItem
      icon={<Bot aria-hidden />}
      tone={activeRunCount > 0 ? "accent" : undefined}
      onClick={onOpenAllRuns}
      title="Open all runs"
      aria-label={`${String(activeRunCount)} runs in progress. Open all runs`}
    >
      {activeRunCount > 0 ? `${String(activeRunCount)} running` : "idle"}
    </StatusBarItem>
    {trailing}
  </footer>
);
