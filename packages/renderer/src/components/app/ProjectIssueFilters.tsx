import type { ProjectForgeIssueSavedFilter, ProjectForgeIssueSort, ProjectForgeIssueStateFilter } from "@buildwarden/shared";
import { Bookmark, ChevronLeft, ChevronRight, Milestone, SlidersHorizontal, Tag, Trash2, UserRound, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented-control";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import { IssuePickerPanel, type IssuePickerOption } from "./project-issue-parts";
import { countActiveIssueFilters, DEFAULT_ISSUE_FILTERS, issueFiltersEqual, issueFiltersFromSaved, type IssueFilters } from "./project-issues-model";

const STATE_OPTIONS: ReadonlyArray<{ value: ProjectForgeIssueStateFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const SORT_OPTIONS: ReadonlyArray<{ value: ProjectForgeIssueSort; label: string }> = [
  { value: "updated", label: "Updated" },
  { value: "created", label: "Newest" },
  { value: "comments", label: "Comments" },
];

const describeAssignee = (assignee: string): string => {
  if (assignee === "") return "Anyone";
  if (assignee === "@me") return "Assigned to me";
  if (assignee === "none") return "Unassigned";
  return assignee;
};

type FilterPage = "root" | "labels" | "assignee" | "milestone";

export interface IssueFilterBarProps {
  filters: IssueFilters;
  busy: boolean;
  labelOptions: readonly IssuePickerOption[];
  assigneeOptions: readonly IssuePickerOption[];
  milestoneOptions: readonly IssuePickerOption[];
  /** Labels, assignees, and milestones are still being fetched. */
  optionsBusy: boolean;
  labelsEmptyMessage: string;
  savedFilters: readonly ProjectForgeIssueSavedFilter[];
  /** Whether saved views may be added and deleted (not in a read-only remote session). */
  canEditViews: boolean;
  onChange: (patch: Partial<IssueFilters>) => void;
  /** Called when the panel opens, so its options can be fetched. */
  onOpen: () => void;
  onSaveView: (name: string) => void;
  onDeleteView: (key: string) => void;
}

const sectionTitleClass = "px-1 pb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-muted)]";

const FilterRow = ({ icon, name, value, active, onClick }: Readonly<{ icon: ReactNode; name: string; value: string; active: boolean; onClick: () => void }>) => (
  <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-[var(--ec-text)] transition-colors hover:bg-[var(--ec-hover)]" onClick={onClick}>
    <span className="shrink-0 text-[var(--ec-muted)]">{icon}</span>
    <span className="shrink-0">{name}</span>
    <span className={cn("ml-auto min-w-0 truncate", active ? "font-medium text-[var(--ec-accent)]" : "text-[var(--ec-faint)]")}>{value}</span>
    <ChevronRight className="h-3 w-3 shrink-0 text-[var(--ec-faint)]" aria-hidden />
  </button>
);

/** The panel's content. It lives inside the popover, so it starts on the overview every time the panel opens. */
const IssueFilterPanel = ({
  filters,
  labelOptions,
  assigneeOptions,
  milestoneOptions,
  optionsBusy,
  labelsEmptyMessage,
  savedFilters,
  canEditViews,
  activeView,
  onChange,
  onSaveView,
  onDeleteView,
  onClose,
}: Readonly<Omit<IssueFilterBarProps, "busy" | "onOpen"> & { activeView: ProjectForgeIssueSavedFilter | null; onClose: () => void }>) => {
  const [page, setPage] = useState<FilterPage>("root");
  const [viewName, setViewName] = useState("");
  const isDefault = issueFiltersEqual(filters, DEFAULT_ISSUE_FILTERS);

  if (page !== "root") {
    const title = page === "labels" ? "Labels" : page === "assignee" ? "Assignee" : "Milestone";
    const clearable = page === "labels" ? filters.labels.length > 0 : page === "assignee" ? filters.assignee !== "" : filters.milestone !== "";
    return (
      <>
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--ec-border)] px-1.5 py-1">
          <button type="button" className="inline-flex items-center gap-1 rounded-md py-1 pl-1 pr-2 text-[11px] font-medium text-[var(--ec-text)] transition-colors hover:bg-[var(--ec-hover)]" onClick={() => setPage("root")} aria-label="Back to all filters">
            <ChevronLeft className="h-3.5 w-3.5 text-[var(--ec-muted)]" aria-hidden />
            {title}
          </button>
          {optionsBusy ? <span className="text-[9px] text-[var(--ec-faint)]">Loading…</span> : null}
          {clearable ? (
            <button
              type="button"
              className="ml-auto rounded-md px-2 py-1 text-[10px] text-[var(--ec-muted)] transition-colors hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
              onClick={() => onChange(page === "labels" ? { labels: [] } : page === "assignee" ? { assignee: "" } : { milestone: "" })}
            >
              Clear
            </button>
          ) : null}
        </div>
        {page === "labels" ? (
          <IssuePickerPanel
            title="Labels"
            options={labelOptions}
            selected={filters.labels}
            busy={optionsBusy}
            emptyMessage={labelsEmptyMessage}
            onToggle={(value) => onChange({ labels: filters.labels.includes(value) ? filters.labels.filter((label) => label !== value) : [...filters.labels, value] })}
          />
        ) : page === "assignee" ? (
          <IssuePickerPanel
            title="Assignee"
            options={assigneeOptions}
            selected={[filters.assignee]}
            multiple={false}
            busy={optionsBusy}
            onToggle={(value) => {
              onChange({ assignee: value });
              setPage("root");
            }}
          />
        ) : (
          <IssuePickerPanel
            title="Milestone"
            options={milestoneOptions}
            selected={[filters.milestone]}
            multiple={false}
            busy={optionsBusy}
            onToggle={(value) => {
              onChange({ milestone: value });
              setPage("root");
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--ec-border)] px-2.5 py-1.5">
        <p className="text-[11px] font-semibold text-[var(--ec-text)]">Filters</p>
        {!isDefault ? (
          <button type="button" className="rounded-md px-1.5 py-0.5 text-[10px] text-[var(--ec-muted)] transition-colors hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" onClick={() => onChange(DEFAULT_ISSUE_FILTERS)}>
            Reset
          </button>
        ) : null}
      </div>
      <div className="app-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2">
        <div>
          <p className={sectionTitleClass}>Sort by</p>
          <SegmentedControl
            label="Sort issues"
            value={filters.sort}
            options={SORT_OPTIONS}
            onChange={(sort) => onChange({ sort })}
            className="flex w-full text-[11px] [&>button]:flex-1"
          />
        </div>
        <div>
          <p className={sectionTitleClass}>Show only</p>
          <FilterRow
            icon={<Tag className="h-3.5 w-3.5" aria-hidden />}
            name="Labels"
            value={filters.labels.length > 0 ? filters.labels.join(", ") : "Any"}
            active={filters.labels.length > 0}
            onClick={() => setPage("labels")}
          />
          <FilterRow icon={<UserRound className="h-3.5 w-3.5" aria-hidden />} name="Assignee" value={describeAssignee(filters.assignee)} active={filters.assignee !== ""} onClick={() => setPage("assignee")} />
          <FilterRow icon={<Milestone className="h-3.5 w-3.5" aria-hidden />} name="Milestone" value={filters.milestone || "Any"} active={filters.milestone !== ""} onClick={() => setPage("milestone")} />
        </div>
        <div>
          <p className={sectionTitleClass}>Saved views</p>
          {savedFilters.length === 0 ? (
            <p className="px-1 pb-1 text-[10px] leading-snug text-[var(--ec-faint)]">{canEditViews ? "Name a combination of filters to get back to it with one click." : "No saved views yet."}</p>
          ) : (
            savedFilters.map((saved) => {
              const active = activeView?.key === saved.key;
              return (
                <div key={saved.key} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-[var(--ec-hover)]",
                      active ? "font-medium text-[var(--ec-accent)]" : "text-[var(--ec-text)]",
                    )}
                    onClick={() => {
                      onChange(issueFiltersFromSaved(saved));
                      onClose();
                    }}
                    title={saved.name}
                  >
                    <Bookmark className={cn("h-3.5 w-3.5 shrink-0", active ? "fill-current" : "text-[var(--ec-muted)]")} aria-hidden />
                    <span className="truncate">{saved.name}</span>
                  </button>
                  {canEditViews ? (
                    <button type="button" className="shrink-0 rounded p-1 text-[var(--ec-faint)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-danger)]" aria-label={`Delete the view ${saved.name}`} onClick={() => onDeleteView(saved.key)}>
                      <Trash2 className="h-3 w-3" aria-hidden />
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
          {canEditViews && !isDefault && !activeView ? (
            <form
              className="mt-1 flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                const name = viewName.trim();
                if (!name) return;
                onSaveView(name);
                setViewName("");
              }}
            >
              <Input value={viewName} onChange={(event) => setViewName(event.target.value)} placeholder="Name the current filters" aria-label="Name for the current filters" className="h-7 min-w-0 flex-1 text-[11px]" maxLength={60} />
              <Button type="submit" size="xs" variant="secondary" className="h-7 px-2 text-[10px]" disabled={!viewName.trim()}>
                Save
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    </>
  );
};

const FilterChip = ({ children, label, onRemove }: Readonly<{ children: ReactNode; label: string; onRemove: () => void }>) => (
  <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] py-px pl-2 pr-0.5 text-[10px] text-[var(--ec-text)]">
    <span className="flex min-w-0 items-center gap-1 truncate">{children}</span>
    <button type="button" className="shrink-0 rounded-full p-0.5 text-[var(--ec-faint)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" onClick={onRemove} aria-label={`Remove the filter ${label}`}>
      <X className="h-2.5 w-2.5" aria-hidden />
    </button>
  </span>
);

/**
 * The filters of the issue list: the state as a switch, everything else behind one "Filters" button,
 * and the active filters as removable chips underneath.
 */
export const IssueFilterBar = (props: IssueFilterBarProps) => {
  const { filters, busy, labelOptions, savedFilters, onChange, onOpen } = props;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const activeCount = countActiveIssueFilters(filters);
  const activeView = savedFilters.find((saved) => issueFiltersEqual(issueFiltersFromSaved(saved), filters)) ?? null;
  const highlighted = activeCount > 0 || activeView !== null;

  return (
    <div className="border-b border-[var(--ec-border)] px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl label="Issue state" value={filters.state} options={STATE_OPTIONS} onChange={(state) => onChange({ state })} disabled={busy} className="text-[11px]" />
        <Button
          ref={buttonRef}
          type="button"
          size="xs"
          variant="ghost"
          className={cn(
            "h-7 min-w-0 gap-1.5 border px-2 text-[11px]",
            highlighted
              ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)] hover:bg-[var(--ec-accent-soft)] hover:text-[var(--ec-accent)]"
              : "border-transparent text-[var(--ec-muted)] hover:text-[var(--ec-text)]",
          )}
          onClick={() => {
            if (!open) onOpen();
            setOpen((value) => !value);
          }}
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Sort, filter by label, assignee, or milestone, and saved views"
        >
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{activeView?.name ?? "Filters"}</span>
          {activeCount > 0 ? <span className="shrink-0 rounded-full bg-[var(--ec-accent)] px-1 font-mono text-[9px] leading-4 text-[var(--ec-accent-foreground)]">{String(activeCount)}</span> : null}
        </Button>
      </div>
      {activeCount > 0 ? (
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
          {filters.labels.map((name) => (
            <FilterChip key={`label-${name}`} label={name} onRemove={() => onChange({ labels: filters.labels.filter((label) => label !== name) })}>
              {labelOptions.find((option) => option.value === name)?.leading}
              <span className="truncate">{name}</span>
            </FilterChip>
          ))}
          {filters.assignee ? (
            <FilterChip label={describeAssignee(filters.assignee)} onRemove={() => onChange({ assignee: "" })}>
              <UserRound className="h-2.5 w-2.5 shrink-0 text-[var(--ec-muted)]" aria-hidden />
              <span className="truncate">{describeAssignee(filters.assignee)}</span>
            </FilterChip>
          ) : null}
          {filters.milestone ? (
            <FilterChip label={filters.milestone} onRemove={() => onChange({ milestone: "" })}>
              <Milestone className="h-2.5 w-2.5 shrink-0 text-[var(--ec-muted)]" aria-hidden />
              <span className="truncate">{filters.milestone}</span>
            </FilterChip>
          ) : null}
        </div>
      ) : null}
      <AnchorDropdownPortal
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        align="end"
        widthPx={288}
        maxHeightPx={420}
        className="glass-popover flex flex-col overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-2xl shadow-black/45"
      >
        <IssueFilterPanel {...props} activeView={activeView} onClose={() => setOpen(false)} />
      </AnchorDropdownPortal>
    </div>
  );
};
