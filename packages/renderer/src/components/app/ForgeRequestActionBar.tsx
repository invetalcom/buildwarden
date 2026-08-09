import type { RunForgeMergeMethod, UpdateRunForgeRequestInput } from "@buildwarden/shared";
import { Check, ChevronDown, GitMerge, Pencil, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import { forgeRequestActionAvailability, type ForgeRequestActionTarget } from "./forge-request-actions";

export const ForgeRequestActionBar = ({
  request,
  canWrite,
  busy,
  compact = false,
  className,
  onUpdate,
  onMerge,
}: {
  request: ForgeRequestActionTarget;
  canWrite: boolean;
  busy: boolean;
  compact?: boolean;
  className?: string;
  onUpdate: (action: UpdateRunForgeRequestInput["action"]) => void | Promise<void>;
  onMerge: (method: RunForgeMergeMethod) => void | Promise<void>;
}) => {
  const [mergeMenuOpen, setMergeMenuOpen] = useState(false);
  const mergeMenuAnchorRef = useRef<HTMLDivElement>(null);
  const availability = forgeRequestActionAvailability(request, canWrite);
  const hasActions = Object.values(availability).some(Boolean);
  const kind = request.provider === "github" ? "PR" : "MR";
  const buttonClassName = compact ? "h-7 gap-1.5 px-2 text-[10px]" : "h-8 gap-1.5 px-2.5 text-[11px]";

  useEffect(() => setMergeMenuOpen(false), [request.number, request.state, request.draft]);

  const update = async (action: UpdateRunForgeRequestInput["action"]) => {
    if (
      (action === "close" || action === "reopen")
      && !window.confirm(`${action === "close" ? "Close" : "Reopen"} ${kind} #${String(request.number)}?`)
    ) return;
    await onUpdate(action);
  };

  const merge = async (method: RunForgeMergeMethod) => {
    setMergeMenuOpen(false);
    if (!window.confirm(`Merge ${kind} #${String(request.number)} using ${method}? The source branch will be kept.`)) return;
    await onMerge(method);
  };

  if (!hasActions) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {availability.canToggleDraft ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={buttonClassName}
          disabled={busy}
          onClick={() => void update(request.draft ? "mark-ready" : "mark-draft")}
        >
          {request.draft ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Pencil className="h-3.5 w-3.5" aria-hidden />}
          {request.draft ? "Mark ready" : "Mark draft"}
        </Button>
      ) : null}
      {availability.canMerge ? (
        <div ref={mergeMenuAnchorRef} className="relative">
          <Button
            type="button"
            size="sm"
            className={buttonClassName}
            disabled={busy}
            onClick={() => setMergeMenuOpen((current) => !current)}
            aria-expanded={mergeMenuOpen}
            aria-haspopup="menu"
          >
            <GitMerge className="h-3.5 w-3.5" aria-hidden />
            Merge
            <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
          </Button>
          <AnchorDropdownPortal
            open={mergeMenuOpen}
            anchorRef={mergeMenuAnchorRef}
            align="start"
            placement="auto"
            widthPx={152}
            onClose={() => setMergeMenuOpen(false)}
            className="isolate overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 p-1 opacity-100 shadow-2xl shadow-black/70 ring-1 ring-black/50"
          >
            <div role="menu" aria-label="Merge method">
              {request.supportedMergeMethods.map((method) => (
                <button
                  key={method}
                  type="button"
                  role="menuitem"
                  className="block w-full rounded-md px-2.5 py-2 text-left text-xs capitalize text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
                  onClick={() => void merge(method)}
                >
                  {method}
                </button>
              ))}
            </div>
          </AnchorDropdownPortal>
        </div>
      ) : null}
      {availability.canClose ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(buttonClassName, "border-rose-500/25 bg-rose-500/[0.03] text-rose-300/90 hover:bg-rose-500/10 hover:text-rose-200")}
          disabled={busy}
          onClick={() => void update("close")}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Close
        </Button>
      ) : null}
      {availability.canReopen ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={buttonClassName}
          disabled={busy}
          onClick={() => void update("reopen")}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reopen
        </Button>
      ) : null}
    </div>
  );
};
