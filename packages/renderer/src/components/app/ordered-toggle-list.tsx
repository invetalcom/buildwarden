import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

export interface OrderedToggleItem<Key extends string> {
  key: Key;
  label: string;
  hint: string;
}

/**
 * Switches the items of a list on and off and sets their order. Items that are on come first, in
 * their order; the rest follow in the order of `items`.
 */
export const OrderedToggleList = <Key extends string>({ items, active, label, switchLabel, disabled, minActive = 0, onChange }: {
  items: ReadonlyArray<OrderedToggleItem<Key>>;
  /** Keys that are on, in display order. */
  active: readonly Key[];
  /** Accessible name of the list. */
  label: string;
  /** Accessible name of one item's switch, from the item's label. */
  switchLabel: (itemLabel: string) => string;
  disabled: boolean;
  /** The last items that are on cannot be switched off below this number. */
  minActive?: number;
  onChange: (active: Key[]) => void;
}) => {
  const rows = [...active.flatMap((key) => items.find((item) => item.key === key) ?? []), ...items.filter((item) => !active.includes(item.key))];
  const move = (key: Key, delta: number) => {
    const next = [...active];
    const index = next.indexOf(key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <ul className="p-1" aria-label={label}>
      {rows.map((item) => {
        const index = active.indexOf(item.key);
        const on = index >= 0;
        return (
          <li key={item.key} className="flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1">
            <Switch
              aria-label={switchLabel(item.label)}
              checked={on}
              disabled={disabled || (on && active.length <= minActive)}
              onCheckedChange={(checked) => onChange(checked ? [...active, item.key] : active.filter((entry) => entry !== item.key))}
            />
            <span className="min-w-0 flex-1 truncate text-xs">
              <span className={cn("font-medium", on ? "text-[var(--ec-text)]" : "text-[var(--ec-muted)]")}>{item.label}</span>
              <span className="ml-2 text-[var(--ec-faint)]">{item.hint}</span>
            </span>
            <Button type="button" size="icon" variant="ghost" className="size-6" disabled={disabled || !on || index === 0} aria-label={`Move ${item.label} earlier`} title="Move earlier" onClick={() => move(item.key, -1)}><ArrowUp className="size-3.5" aria-hidden /></Button>
            <Button type="button" size="icon" variant="ghost" className="size-6" disabled={disabled || !on || index === active.length - 1} aria-label={`Move ${item.label} later`} title="Move later" onClick={() => move(item.key, 1)}><ArrowDown className="size-3.5" aria-hidden /></Button>
          </li>
        );
      })}
    </ul>
  );
};
