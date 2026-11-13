import type { ProjectForgeIssueLabel, ProjectForgeIssueSummary, ProjectForgeUserSummary } from "@buildwarden/shared";
import { Check, CircleCheck, CircleDot, CircleSlash, Search } from "lucide-react";
import { useMemo, useState, type ReactNode, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { Input } from "../ui/input";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import { issueLabelStyle, issueStateLabel } from "./project-issues-model";

const issueStateTone = (issue: Pick<ProjectForgeIssueSummary, "state" | "stateReason">): string => {
  if (issue.state === "open") return "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]";
  if (issue.stateReason === "not_planned" || issue.stateReason === "duplicate") {
    return "border-[var(--ec-border)] bg-[var(--ec-muted-soft)] text-[var(--ec-muted)]";
  }
  return "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]";
};

export const IssueStateIcon = ({ issue, className }: Readonly<{ issue: Pick<ProjectForgeIssueSummary, "state" | "stateReason">; className?: string }>) => {
  const label = issueStateLabel(issue);
  if (issue.state === "open") return <CircleDot className={cn("text-[var(--ec-success)]", className)} aria-label={label} />;
  if (issue.stateReason === "not_planned" || issue.stateReason === "duplicate") {
    return <CircleSlash className={cn("text-[var(--ec-muted)]", className)} aria-label={label} />;
  }
  return <CircleCheck className={cn("text-[var(--ec-accent)]", className)} aria-label={label} />;
};

export const IssueStateBadge = ({ issue }: Readonly<{ issue: Pick<ProjectForgeIssueSummary, "state" | "stateReason"> }>) => (
  <span className={cn("rounded-full border px-1.5 py-px text-[8px] font-semibold uppercase", issueStateTone(issue))}>{issueStateLabel(issue)}</span>
);

export const IssueLabelChip = ({ label, className }: Readonly<{ label: ProjectForgeIssueLabel; className?: string }>) => (
  <span
    className={cn(
      "inline-flex max-w-[11rem] items-center truncate rounded border border-[var(--ec-border)] bg-[var(--ec-panel)] px-1.5 py-px text-[9px] font-medium leading-4 text-[var(--ec-muted)]",
      className,
    )}
    style={issueLabelStyle(label.color)}
    title={label.description ? `${label.name}: ${label.description}` : label.name}
  >
    <span className="truncate">{label.name}</span>
  </span>
);

export const IssueAvatar = ({
  user,
  name,
  size = "md",
  accent = false,
}: Readonly<{ user?: ProjectForgeUserSummary | null; name?: string; size?: "sm" | "md"; accent?: boolean }>) => {
  const label = user?.username ?? name ?? "?";
  const sizeClass = size === "sm" ? "h-4 w-4 text-[7px]" : "h-7 w-7 text-[9px]";
  return user?.avatarUrl ? (
    <img src={user.avatarUrl} alt="" title={label} className={cn("shrink-0 rounded-full bg-[var(--ec-panel)] object-cover ring-1 ring-[var(--ec-border)]", sizeClass)} />
  ) : (
    <span
      title={label}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold ring-1 ring-inset",
        sizeClass,
        accent ? "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)] ring-[var(--ec-accent-ring)]" : "bg-[var(--ec-panel)] text-[var(--ec-muted)] ring-[var(--ec-border)]",
      )}
    >
      {label.slice(0, 2).toUpperCase()}
    </span>
  );
};

export const IssueAvatarStack = ({ users, max = 3 }: Readonly<{ users: readonly ProjectForgeUserSummary[]; max?: number }>) => {
  if (users.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center -space-x-1" title={users.map((user) => user.username).join(", ")}>
      {users.slice(0, max).map((user) => (
        <IssueAvatar key={user.username} user={user} size="sm" />
      ))}
      {users.length > max ? <span className="pl-1.5 text-[9px] text-[var(--ec-faint)]">+{String(users.length - max)}</span> : null}
    </span>
  );
};

export interface IssuePickerOption {
  value: string;
  label: string;
  description?: string | null;
  /** Leading swatch, avatar, or icon. */
  leading?: ReactNode;
}

/** Searchable single- or multi-choice list. Used inside a popover or as one page of a larger panel. */
export const IssuePickerPanel = ({
  title,
  options,
  selected,
  onToggle,
  multiple = true,
  emptyMessage = "Nothing to choose from.",
  busy = false,
}: Readonly<{
  title: string;
  options: readonly IssuePickerOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  multiple?: boolean;
  emptyMessage?: string;
  busy?: boolean;
}>) => {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter((option) => `${option.label}\n${option.description ?? ""}`.toLowerCase().includes(needle)) : options;
  }, [options, query]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  return (
    <>
      {options.length > 7 ? (
        <div className="relative shrink-0 border-b border-[var(--ec-border)] p-1.5">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--ec-faint)]" aria-hidden />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter"
            aria-label={`Filter ${title.toLowerCase()}`}
            className="h-7 pl-7 text-[11px]"
            autoFocus
          />
        </div>
      ) : null}
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-multiselectable={multiple} aria-label={title}>
        {visible.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-[var(--ec-faint)]">{busy ? "Loading…" : options.length === 0 ? emptyMessage : "No match."}</p>
        ) : (
          visible.map((option) => {
            const active = selectedSet.has(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                  active ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]" : "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]",
                )}
                onClick={() => onToggle(option.value)}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--ec-accent)]">
                  {active ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                </span>
                {option.leading}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.description ? <span className="block truncate text-[9px] text-[var(--ec-faint)]">{option.description}</span> : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </>
  );
};

/** Searchable single- or multi-choice popover for labels, assignees, and milestones. */
export const IssuePickerPopover = ({
  open,
  anchorRef,
  onClose,
  title,
  options,
  selected,
  onToggle,
  multiple = true,
  emptyMessage,
  busy = false,
  footer,
  align = "start",
}: Readonly<{
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  title: string;
  options: readonly IssuePickerOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  multiple?: boolean;
  emptyMessage?: string;
  busy?: boolean;
  footer?: ReactNode;
  align?: "start" | "end";
}>) => (
  <AnchorDropdownPortal
    open={open}
    anchorRef={anchorRef}
    onClose={onClose}
    align={align}
    widthPx={264}
    maxHeightPx={360}
    className="glass-popover flex flex-col overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-2xl shadow-black/45"
  >
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--ec-border)] px-2.5 py-1.5">
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-muted)]">{title}</p>
      {busy ? <span className="text-[9px] text-[var(--ec-faint)]">Loading…</span> : null}
    </div>
    <IssuePickerPanel
      title={title}
      options={options}
      selected={selected}
      multiple={multiple}
      emptyMessage={emptyMessage}
      busy={busy}
      onToggle={(value) => {
        onToggle(value);
        if (!multiple) onClose();
      }}
    />
    {footer ? <div className="shrink-0 border-t border-[var(--ec-border)] p-1.5">{footer}</div> : null}
  </AnchorDropdownPortal>
);

export const IssueLabelSwatch = ({ color }: Readonly<{ color: string | null }>) => (
  <span
    className="h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--ec-border)] bg-[var(--ec-muted-soft)]"
    style={color ? { backgroundColor: `#${color}`, borderColor: `color-mix(in srgb, #${color} 60%, var(--ec-border))` } : undefined}
    aria-hidden
  />
);
