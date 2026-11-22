import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export type TabItem<Value extends string> = {
  value: Value;
  label: ReactNode;
  icon?: ReactNode;
  /** Small count shown after the label. */
  count?: number | string;
  title?: string;
  disabled?: boolean;
};

export type TabListProps<Value extends string> = {
  items: ReadonlyArray<TabItem<Value>>;
  value: Value;
  onChange: (value: Value) => void;
  /** Accessible name of the tab list. */
  label: string;
  className?: string;
  /** Controls shown at the end of the tab row, such as a primary page action. */
  trailing?: ReactNode;
  /** Id prefix that links each tab to its panel (`${idBase}-panel-${value}`). */
  idBase?: string;
};

/**
 * Tabs whose active tab is joined to the panel below it. Put the content in an element with
 * `data-ui="tab-panel"` (or use {@link TabPanel}) directly under the list so the two read as one shape.
 */
export const TabList = <Value extends string>({ items, value, onChange, label, className, trailing, idBase }: TabListProps<Value>) => {
  const listRef = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (direction === 0 && event.key !== "Home" && event.key !== "End") return;
    const enabled = items.filter((item) => !item.disabled);
    if (enabled.length === 0) return;
    const index = enabled.findIndex((item) => item.value === value);
    const next = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1) : enabled[(index + direction + enabled.length) % enabled.length];
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-tab-value="${CSS.escape(next.value)}"]`)?.focus());
  };
  return (
    <div className={cn("flex min-w-0 items-end gap-2", className)}>
      <div ref={listRef} role="tablist" aria-label={label} data-ui="tab-list" className="min-w-0 flex-1" onKeyDown={move}>
        {items.map((item) => {
          const active = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={idBase ? `${idBase}-tab-${item.value}` : undefined}
              aria-controls={idBase ? `${idBase}-panel-${item.value}` : undefined}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              disabled={item.disabled}
              title={item.title}
              data-ui="tab"
              data-active={active}
              data-tab-value={item.value}
              onClick={() => onChange(item.value)}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.count !== undefined && item.count !== "" && item.count !== 0 ? (
                <span data-ui="count" className="rounded-full px-1 font-mono text-[10px] tabular-nums text-[var(--ec-faint)]">{item.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-1.5 pb-1">{trailing}</div> : null}
    </div>
  );
};

export const TabPanel = ({ className, children, id, labelledBy }: { className?: string; children: ReactNode; id?: string; labelledBy?: string }) => (
  <div role="tabpanel" id={id} aria-labelledby={labelledBy} data-ui="tab-panel" className={cn("min-h-0 min-w-0", className)}>
    {children}
  </div>
);
