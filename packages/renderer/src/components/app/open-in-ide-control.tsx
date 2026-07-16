import { useRef, useState } from "react";
import { IDE_KIND_LABELS, type SupportedIdeKind } from "@buildwarden/shared";
import { ChevronDown, Monitor } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import { IdeBrandIcon } from "./ide-brand-icons";

export interface OpenInIdeControlProps {
  configuredIdeKinds: SupportedIdeKind[];
  onOpen: (kind: SupportedIdeKind) => void;
  /** Tighter control for the run header row (icon-only or minimal label). */
  compact?: boolean;
}

export const OpenInIdeControl = ({ configuredIdeKinds, onOpen, compact }: OpenInIdeControlProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  if (configuredIdeKinds.length === 0) {
    return null;
  }

  const pick = (kind: SupportedIdeKind) => {
    setMenuOpen(false);
    onOpen(kind);
  };

  const btnClass = compact
    ? "h-8 shrink-0 border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-2 text-xs text-[var(--ec-accent)] hover:bg-[var(--ec-hover)]"
    : "shrink-0 border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)] hover:bg-[var(--ec-hover)]";

  if (configuredIdeKinds.length === 1) {
    const kind = configuredIdeKinds[0]!;
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={btnClass}
        title={`Open workspace in ${IDE_KIND_LABELS[kind]}`}
        onClick={() => pick(kind)}
      >
        <IdeBrandIcon kind={kind} className="h-4 w-4 shrink-0" />
        {!compact ? (
          <span className="ml-1.5 max-w-[9rem] truncate sm:max-w-[12rem]">{IDE_KIND_LABELS[kind]}</span>
        ) : (
          <span className="sr-only">Open in {IDE_KIND_LABELS[kind]}</span>
        )}
      </Button>
    );
  }

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={cn(btnClass, "gap-1")}
        onClick={() => setMenuOpen((o) => !o)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        title="Open workspace in IDE"
      >
        <Monitor className="h-4 w-4 shrink-0" />
        {compact ? <span className="sr-only">Open in IDE</span> : <span>Open in IDE</span>}
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition ${menuOpen ? "rotate-180" : ""}`} />
      </Button>
      <AnchorDropdownPortal
        open={menuOpen}
        anchorRef={wrapRef}
        onClose={() => setMenuOpen(false)}
        align="start"
        widthPx={192}
        className="glass-popover overflow-hidden py-1"
      >
        <div role="menu">
          {configuredIdeKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ec-text)] transition hover:bg-[var(--ec-hover)]"
              onClick={() => pick(kind)}
            >
              <IdeBrandIcon kind={kind} className="h-5 w-5 shrink-0" />
              <span className="min-w-0 truncate">{IDE_KIND_LABELS[kind]}</span>
            </button>
          ))}
        </div>
      </AnchorDropdownPortal>
    </div>
  );
};
