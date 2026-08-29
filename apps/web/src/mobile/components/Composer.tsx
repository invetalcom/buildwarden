import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "../lib/cn";
import { Textarea } from "./primitives";

/**
 * Sticky bottom composer.
 *
 * Sits above the safe-area inset and grows to a capped height, the way messaging apps do; the
 * page never scrolls behind it because the shell owns scrolling. `interactive-widget=resizes-content`
 * in the viewport meta means the on-screen keyboard shrinks the layout viewport, so the composer
 * stays visible without any JS keyboard tracking.
 */
export const Composer = ({
  placeholder,
  busy = false,
  disabled = false,
  disabledReason,
  onSubmit,
  onCancel,
  accessory,
}: {
  placeholder: string;
  busy?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSubmit: (value: string) => void | Promise<void>;
  /** Shown instead of send while the run/chat is active. */
  onCancel?: () => void;
  accessory?: React.ReactNode;
}) => {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value]);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy || disabled) return;
    setValue("");
    await onSubmit(trimmed);
  };

  if (disabled) {
    return (
      <div className="m-safe-bottom shrink-0 border-t border-[var(--ec-border)] bg-[var(--ec-sidebar)] px-4 py-3">
        <p className="text-center text-xs text-[var(--ec-faint)]">{disabledReason ?? "This session is read-only."}</p>
      </div>
    );
  }

  return (
    <div
      className="m-safe-bottom shrink-0 border-t border-[var(--ec-border)] bg-[var(--ec-sidebar)]"
      style={{ paddingLeft: "var(--m-safe-left)", paddingRight: "var(--m-safe-right)" }}
    >
      {accessory ? <div className="m-scroll-x flex gap-1.5 px-3 pt-2">{accessory}</div> : null}
      <div className="flex items-end gap-2 px-3 py-2">
        <Textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          enterKeyHint="enter"
          className={cn(
            "m-scroll-thin max-h-40 min-h-11 flex-1 rounded-2xl px-3.5 py-2.5",
          )}
        />
        {onCancel ? (
          <button
            type="button"
            aria-label="Stop"
            onClick={onCancel}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]"
          >
            <Square className="size-4 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            disabled={!value.trim() || busy}
            onClick={() => void submit()}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-full transition",
              value.trim() && !busy
                ? "bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)]"
                : "bg-[var(--ec-control)] text-[var(--ec-faint)]",
            )}
          >
            <ArrowUp className="size-5" />
          </button>
        )}
      </div>
    </div>
  );
};
