import { useEffect, useState, type ReactNode } from "react";
import { Check, Plus, X } from "lucide-react";
import { cn } from "../lib/cn";
import { Button, Input, ListRow } from "./primitives";

/**
 * Form rows for the mobile settings screens.
 *
 * Every control is a full-width row with the label above the input rather than the desktop's
 * label/control split, which needs horizontal room a phone does not have. Text and number fields
 * commit on blur (and on an explicit Save where a value can be invalid mid-typing) so a setting is
 * never written on every keystroke.
 */

export const SettingGroup = ({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) => (
  <section className="pb-2">
    <h2 className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">{title}</h2>
    {hint ? <p className="px-4 pb-2 text-[11px] leading-4 text-[var(--ec-muted)]">{hint}</p> : null}
    <div className="border-y border-[var(--ec-border)] bg-[var(--ec-panel-soft)]">{children}</div>
  </section>
);

/** Presentational switch. The row itself is the button, so this must not be interactive. */
const SwitchVisual = ({ checked }: { checked: boolean }) => (
  <span
    aria-hidden
    className={cn("relative h-6 w-10 shrink-0 rounded-full transition", checked ? "bg-[var(--ec-accent)]" : "bg-[var(--ec-control)]")}
  >
    <span
      className={cn(
        "absolute top-0.5 size-5 rounded-full bg-[var(--ec-switch-thumb)] shadow transition-all",
        checked ? "left-[1.125rem]" : "left-0.5",
      )}
    />
  </span>
);

/**
 * The whole row toggles, not just the switch. A 40×24 switch is well under a comfortable touch
 * target, and on a settings list the label is what a thumb naturally lands on.
 */
export const ToggleRow = ({
  title,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className="m-tap flex w-full items-center gap-3 border-b border-[var(--ec-border)] px-4 py-2 text-left transition last:border-b-0 active:bg-[var(--ec-hover)] disabled:opacity-50"
  >
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="text-[13px] font-medium">{title}</span>
      {description ? <span className="text-[11px] leading-4 text-[var(--ec-muted)]">{description}</span> : null}
    </span>
    <SwitchVisual checked={checked} />
  </button>
);

export const SelectRow = <Value extends string>({
  title,
  description,
  value,
  options,
  disabled = false,
  onChange,
}: {
  title: string;
  description?: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  disabled?: boolean;
  onChange: (next: Value) => void;
}) => (
  <label className="flex flex-col gap-1.5 border-b border-[var(--ec-border)] px-4 py-2.5 last:border-b-0">
    <span className="text-[13px] font-medium">{title}</span>
    {description ? <span className="text-[11px] leading-4 text-[var(--ec-muted)]">{description}</span> : null}
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as Value)}
      className="m-tap w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-[var(--ec-text)] disabled:opacity-50"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

export const TextRow = ({
  title,
  description,
  value,
  placeholder,
  disabled = false,
  mono = false,
  inputMode,
  invalid,
  onCommit,
}: {
  title: string;
  description?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  inputMode?: "text" | "numeric" | "url";
  invalid?: (draft: string) => string | null;
  onCommit: (next: string) => void;
}) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const problem = invalid?.(draft) ?? null;
  const dirty = draft !== value;

  return (
    <div className="flex flex-col gap-1.5 border-b border-[var(--ec-border)] px-4 py-2.5 last:border-b-0">
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">{title}</span>
        {description ? <span className="text-[11px] leading-4 text-[var(--ec-muted)]">{description}</span> : null}
        <Input
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          inputMode={inputMode}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={cn("text-[13px]", mono && "m-mono", problem && "border-[var(--ec-danger-ring)]")}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      {problem ? <p className="text-[11px] text-[var(--ec-danger)]">{problem}</p> : null}
      {dirty && !problem && !disabled ? (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onCommit(draft)}>
            <Check className="size-3.5" />
            Save
          </Button>
          <Button size="sm" tone="neutral" onClick={() => setDraft(value)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
};

/** Read-only informational row, for host-side values a phone cannot change. */
export const InfoRow = ({ title, value }: { title: string; value: ReactNode }) => (
  <ListRow title={title} trailing={<span className="max-w-[55vw] truncate text-right">{value}</span>} className="border-b border-[var(--ec-border)] last:border-b-0" />
);

export const CheckRow = ({
  title,
  description,
  checked,
  disabled = false,
  onToggle,
}: {
  title: ReactNode;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onToggle}
    className="m-tap flex w-full items-center gap-3 border-b border-[var(--ec-border)] px-4 py-2 text-left transition last:border-b-0 active:bg-[var(--ec-hover)] disabled:opacity-50"
  >
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[13px] font-medium">{title}</span>
      {description ? <span className="line-clamp-2 text-[11px] leading-4 text-[var(--ec-muted)]">{description}</span> : null}
    </span>
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded border",
        checked ? "border-[var(--ec-accent)] bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)]" : "border-[var(--ec-border-strong)]",
      )}
    >
      {checked ? <Check className="size-3.5" /> : null}
    </span>
  </button>
);

/** Editor for a persisted list of strings (shell allow-list patterns). */
export const StringListEditor = ({
  values,
  placeholder,
  disabled = false,
  onChange,
}: {
  values: readonly string[];
  placeholder: string;
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) => {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value || values.includes(value)) return;
    setDraft("");
    onChange([...values, value]);
  };

  return (
    <div className="flex flex-col gap-2 border-b border-[var(--ec-border)] px-4 py-2.5 last:border-b-0">
      {values.length === 0 ? <p className="text-[11px] text-[var(--ec-faint)]">Nothing added yet.</p> : null}
      {values.map((value) => (
        <div key={value} className="flex items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-2.5 py-1.5">
          <code className="m-mono m-wrap-anywhere min-w-0 flex-1 text-[12px]">{value}</code>
          <button
            type="button"
            aria-label={`Remove ${value}`}
            disabled={disabled}
            onClick={() => onChange(values.filter((entry) => entry !== value))}
            className="m-tap -my-1.5 -mr-2 flex w-11 shrink-0 items-center justify-center text-[var(--ec-faint)] disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="m-mono flex-1 text-[13px]"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={!draft.trim() || disabled}>
          <Plus className="size-4" />
        </Button>
      </form>
    </div>
  );
};
