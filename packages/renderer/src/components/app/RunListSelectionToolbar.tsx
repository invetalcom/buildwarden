import { ListChecks, Trash2, X } from "lucide-react";
import { Button } from "../ui/button";

interface RunListSelectionToolbarProps {
  selectionMode: boolean;
  selectedCount: number;
  visibleCount: number;
  allVisibleSelected: boolean;
  busy?: boolean;
  onBegin: () => void;
  onToggleAllVisible: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

export const RunListSelectionToolbar = ({
  selectionMode,
  selectedCount,
  visibleCount,
  allVisibleSelected,
  busy = false,
  onBegin,
  onToggleAllVisible,
  onDelete,
  onCancel,
}: RunListSelectionToolbarProps) => {
  if (!selectionMode) {
    return (
      <Button type="button" variant="secondary" size="xs" onClick={onBegin}>
        <ListChecks className="size-3.5" aria-hidden />
        Select
      </Button>
    );
  }

  return (
    <div
      role="toolbar"
      aria-label="Run selection actions"
      className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] p-0.5 pl-2"
    >
      <span className="whitespace-nowrap text-xs font-medium tabular-nums text-[var(--ec-accent)]">
        {selectedCount} selected
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-7"
        disabled={busy || visibleCount === 0}
        onClick={onToggleAllVisible}
      >
        {allVisibleSelected ? "Clear visible" : "Select all"}
      </Button>
      <Button
        type="button"
        variant="danger"
        size="xs"
        className="h-7"
        disabled={busy || selectedCount === 0}
        onClick={onDelete}
      >
        <Trash2 className="size-3.5" aria-hidden />
        Delete
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={busy}
        onClick={onCancel}
        aria-label="Cancel run selection"
        title="Cancel selection"
      >
        <X className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
};
