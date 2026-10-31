import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { RunStatus } from "@buildwarden/shared";
import { ArrowLeft, ArrowUpRight, Unlink } from "lucide-react";
import { cn } from "../../lib/cn";
import { formatRunRelativeTime } from "./run-summary-format";

/** Chromium reports the mouse "back" side button (XButton1) as button 3. */
const MOUSE_BACK_BUTTON = 3;

/** "2h ago" style meta item; the full timestamp (or a custom tooltip) shows on hover. */
export const RelativeTime = ({ value, prefix, tooltip }: { value: string; prefix?: string; tooltip?: string }) => (
  <time className="shrink-0" dateTime={value} title={tooltip ?? new Date(value).toLocaleString()}>
    {prefix ? `${prefix} ` : null}{formatRunRelativeTime(value)}
  </time>
);

/**
 * Bookmark header action that jumps to the live run/chat the bookmark was copied from.
 * Without `onOpen` the original is gone, so it renders a muted hint instead of a dead button.
 */
export const OpenOriginalButton = ({ kind, onOpen }: { kind: "run" | "chat"; onOpen?: () => void }) =>
  onOpen ? (
    <button type="button" className="app-detail-header-link group" onClick={onOpen} title={`Open the original ${kind}`}>
      Open {kind}
      <ArrowUpRight className="h-3.5 w-3.5 transition-transform duration-150 group-hover:-translate-y-px group-hover:translate-x-px" aria-hidden />
    </button>
  ) : (
    <span className="app-detail-header-link" data-unavailable title={`The original ${kind} was deleted; this bookmark is the only copy.`}>
      <Unlink className="h-3.5 w-3.5" aria-hidden />
      Original deleted
    </span>
  );

interface DetailHeaderProps {
  status: RunStatus;
  /** Live work: pulses the status dot and sweeps the bottom rail. Snapshots (bookmarks) stay still. */
  active?: boolean;
  title: string;
  titleTooltip?: string;
  backLabel: string;
  onBack: () => void;
  /** Rendered after the status in the meta row, separated by dots; falsy entries are skipped. */
  meta?: ReactNode[];
  actions?: ReactNode;
}

/**
 * Compact frosted header shared by chat, chat-bookmark, and run-bookmark detail pages:
 * back button, title, status-led meta row, and optional trailing actions. While mounted,
 * the mouse back side button also triggers `onBack`.
 */
export const DetailHeader = ({ status, active = false, title, titleTooltip, backLabel, onBack, meta = [], actions }: DetailHeaderProps) => {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    const handleMouseBack = (event: MouseEvent) => {
      if (event.button !== MOUSE_BACK_BUTTON) return;
      event.preventDefault();
      onBackRef.current();
    };
    window.addEventListener("mouseup", handleMouseBack);
    return () => window.removeEventListener("mouseup", handleMouseBack);
  }, []);

  const metaItems = meta.filter(Boolean);
  return (
    <header className="app-detail-header" data-status={status} data-active={active || undefined}>
      <button type="button" className="app-detail-header-back group" onClick={onBack} title={backLabel} aria-label={backLabel}>
        <ArrowLeft className="h-4 w-4 transition-transform duration-150 group-hover:-translate-x-0.5" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[13px] font-semibold leading-5 text-[var(--ec-text)]" title={titleTooltip}>{title}</h2>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-[var(--ec-muted)]">
          <span className="app-detail-header-status">
            <span aria-hidden className={cn("app-detail-header-dot", active && "running-pulse")} />
            {status}
          </span>
          {metaItems.map((item, index) => (
            <Fragment key={index}>
              <span aria-hidden className="text-[var(--ec-faint)]">·</span>
              {item}
            </Fragment>
          ))}
        </div>
      </div>
      {actions}
    </header>
  );
};
