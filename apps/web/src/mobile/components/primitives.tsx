import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Touch-sized primitives for the mobile UI. Deliberately independent of
 * `packages/renderer/src/components/ui` — those are sized for a mouse and are desktop templates.
 * Every interactive element here clears a 44px hit target and has no hover-only affordance.
 */

type ButtonTone = "accent" | "neutral" | "danger" | "ghost";
type ButtonSize = "md" | "sm";

const BUTTON_TONES: Record<ButtonTone, string> = {
  accent: "bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)] active:brightness-95",
  neutral: "bg-[var(--ec-control)] text-[var(--ec-text)] border border-[var(--ec-border)] active:bg-[var(--ec-control-hover)]",
  danger: "bg-[var(--ec-danger-soft)] text-[var(--ec-danger)] border border-[var(--ec-danger-ring)] active:bg-[var(--ec-danger-soft)]",
  ghost: "text-[var(--ec-muted)] active:bg-[var(--ec-hover)]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: ButtonSize;
  busy?: boolean;
  block?: boolean;
}

export const Button = ({
  tone = "accent",
  size = "md",
  busy = false,
  block = false,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) => (
  <button
    type="button"
    disabled={disabled || busy}
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-md font-medium transition select-none",
      "disabled:opacity-45",
      // "sm" is compact in text and padding, never in height: every button stays a 44px target.
      size === "md" ? "min-h-11 px-4 text-sm" : "min-h-11 px-3 text-xs",
      block && "w-full",
      BUTTON_TONES[tone],
      className,
    )}
    {...props}
  >
    {busy ? <Loader2 className="size-4 animate-spin" /> : null}
    {children}
  </button>
);

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}

export const IconButton = ({ label, className, children, ...props }: IconButtonProps) => (
  <button
    type="button"
    aria-label={label}
    className={cn(
      "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-[var(--ec-muted)]",
      "transition active:bg-[var(--ec-hover)] active:text-[var(--ec-text)] disabled:opacity-40",
      className,
    )}
    {...props}
  >
    {children}
  </button>
);

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input
    className={cn(
      "min-h-11 w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-[var(--ec-text)]",
      "placeholder:text-[var(--ec-faint)] focus:border-[var(--ec-accent-ring)] focus:outline-none",
      className,
    )}
    {...props}
  />
);

export const Textarea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    className={cn(
      "w-full resize-none rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 py-2.5",
      "text-[var(--ec-text)] placeholder:text-[var(--ec-faint)] focus:border-[var(--ec-accent-ring)] focus:outline-none",
      className,
    )}
    {...props}
  />
);

export const Spinner = ({ label = "Loading", className }: { label?: string; className?: string }) => (
  <Loader2 className={cn("size-5 animate-spin text-[var(--ec-accent)]", className)} aria-label={label} />
);

export const CenteredSpinner = ({ label }: { label?: string }) => (
  <div className="flex flex-1 items-center justify-center py-10">
    <Spinner label={label} />
  </div>
);

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const BADGE_TONES: Record<Tone, string> = {
  neutral: "bg-[var(--ec-muted-soft)] text-[var(--ec-muted)]",
  accent: "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]",
  success: "bg-[var(--ec-success-soft)] text-[var(--ec-success)]",
  warning: "bg-[var(--ec-warning-soft)] text-[var(--ec-warning)]",
  danger: "bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]",
  info: "bg-[var(--ec-info-soft)] text-[var(--ec-info)]",
};

export const Badge = ({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
      BADGE_TONES[tone],
      className,
    )}
  >
    {children}
  </span>
);

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div
    className={cn(
      "rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-[var(--ec-panel-shadow)]",
      className,
    )}
  >
    {children}
  </div>
);

export const SectionLabel = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="flex items-center justify-between gap-2 pl-4 pr-1 pt-3 pb-1">
    <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">{children}</h2>
    {action}
  </div>
);

/** Secondary text action next to a {@link SectionLabel}; padded so it still clears a 44px target. */
export const SectionAction = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button type="button" onClick={onClick} className="m-tap px-3 text-xs font-medium text-[var(--ec-accent)]">
    {children}
  </button>
);

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Renders a chevron and makes the whole row tappable. */
  onClick?: () => void;
  className?: string;
  danger?: boolean;
}

export const ListRow = ({ title, subtitle, leading, trailing, onClick, className, danger }: ListRowProps) => {
  const content = (
    <>
      {leading ? <span className="flex shrink-0 items-center text-[var(--ec-muted)]">{leading}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className={cn("truncate text-sm font-medium", danger && "text-[var(--ec-danger)]")}>{title}</span>
        {subtitle ? <span className="truncate text-xs text-[var(--ec-muted)]">{subtitle}</span> : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--ec-faint)]">{trailing}</span> : null}
      {onClick ? <ChevronRight className="size-4 shrink-0 text-[var(--ec-faint)]" /> : null}
    </>
  );

  const shared = cn("m-tap flex w-full items-center gap-3 px-4 py-2.5", className);
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(shared, "text-left transition active:bg-[var(--ec-hover)]")}>
      {content}
    </button>
  ) : (
    <div className={shared}>{content}</div>
  );
};

export const Divider = () => <div className="mx-4 border-t border-[var(--ec-border)]" />;

export const EmptyState = ({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message?: string;
  action?: ReactNode;
}) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 py-14 text-center">
    {icon ? <div className="text-[var(--ec-faint)]">{icon}</div> : null}
    <p className="text-sm font-medium text-[var(--ec-text)]">{title}</p>
    {message ? <p className="text-xs leading-5 text-[var(--ec-muted)]">{message}</p> : null}
    {action ? <div className="pt-2">{action}</div> : null}
  </div>
);

export interface SegmentOption<Value extends string> {
  value: Value;
  label: string;
  badge?: number;
}

/** Horizontally scrollable segment strip — the mobile stand-in for desktop tab rows. */
export const SegmentedTabs = <Value extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: readonly SegmentOption<Value>[];
  value: Value;
  onChange: (next: Value) => void;
  className?: string;
}) => (
  <div
    role="tablist"
    className={cn("m-scroll-x flex shrink-0 gap-1 border-b border-[var(--ec-border)] px-2", className)}
  >
    {options.map((option) => {
      const active = option.value === value;
      return (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={active}
          onClick={() => onChange(option.value)}
          className={cn(
            "m-tap relative shrink-0 whitespace-nowrap px-3 text-[13px] font-medium transition",
            active ? "text-[var(--ec-accent)]" : "text-[var(--ec-muted)]",
          )}
        >
          {option.label}
          {option.badge ? (
            <span className="ml-1.5 rounded-full bg-[var(--ec-accent-soft)] px-1.5 text-[10px] text-[var(--ec-accent)]">
              {option.badge > 99 ? "99+" : option.badge}
            </span>
          ) : null}
          {active ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--ec-accent)]" /> : null}
        </button>
      );
    })}
  </div>
);

export const FilterChip = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "m-tap shrink-0 whitespace-nowrap rounded-full border px-3.5 text-xs font-medium transition",
      active
        ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
        : "border-[var(--ec-border)] text-[var(--ec-muted)]",
    )}
  >
    {children}
  </button>
);

export const Toggle = ({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={cn(
      "relative h-6 w-10 shrink-0 rounded-full transition",
      checked ? "bg-[var(--ec-accent)]" : "bg-[var(--ec-control)]",
    )}
  >
    <span
      className={cn(
        "absolute top-0.5 size-5 rounded-full bg-[var(--ec-switch-thumb)] shadow transition-all",
        checked ? "left-[1.125rem]" : "left-0.5",
      )}
    />
  </button>
);

export const InlineError = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="mx-4 my-3 rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-3 py-2.5">
    <p className="m-wrap-anywhere text-xs leading-5 text-[var(--ec-danger)]">{message}</p>
    {onRetry ? (
      <button type="button" onClick={onRetry} className="mt-1.5 text-xs font-medium text-[var(--ec-danger-strong)] underline">
        Try again
      </button>
    ) : null}
  </div>
);
