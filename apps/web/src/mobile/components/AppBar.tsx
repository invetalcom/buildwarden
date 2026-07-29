import type { ReactNode } from "react";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { cn } from "../lib/cn";
import { IconButton } from "./primitives";

export interface AppBarProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  /** Renders the title as a button that opens the project drawer. */
  onTitlePress?: () => void;
  leading?: ReactNode;
  actions?: ReactNode;
}

export const AppBar = ({ title, subtitle, onBack, onTitlePress, leading, actions }: AppBarProps) => (
  <header
    className="m-safe-top shrink-0 border-b border-[var(--ec-border)] bg-[var(--ec-sidebar)]"
    style={{ paddingLeft: "var(--m-safe-left)", paddingRight: "var(--m-safe-right)" }}
  >
    <div className="flex h-[var(--m-appbar-height)] items-center gap-1 px-1">
      {onBack ? (
        <IconButton label="Back" onClick={onBack}>
          <ChevronLeft className="size-6" />
        </IconButton>
      ) : (
        leading
      )}
      <div className="min-w-0 flex-1 px-1">
        {onTitlePress ? (
          <button type="button" onClick={onTitlePress} className="m-tap flex w-full min-w-0 items-center gap-1 text-left">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold leading-5">{title}</span>
              {subtitle ? <span className="block truncate text-[11px] text-[var(--ec-muted)]">{subtitle}</span> : null}
            </span>
            <ChevronDown className="size-4 shrink-0 text-[var(--ec-faint)]" />
          </button>
        ) : (
          <div className="min-w-0">
            <p className={cn("truncate font-semibold leading-5", subtitle ? "text-[15px]" : "text-base")}>{title}</p>
            {subtitle ? <p className="truncate text-[11px] text-[var(--ec-muted)]">{subtitle}</p> : null}
          </div>
        )}
      </div>
      {actions ? <div className="flex shrink-0 items-center">{actions}</div> : null}
    </div>
  </header>
);
