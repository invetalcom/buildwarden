import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Quote, Reply } from "lucide-react";
import { selectedResponseText, type ResponseCitation } from "../../lib/response-citation";
import { Button } from "./button";

export function ResponseCitationActions({ stepId, text, contentRef, onCite, className = "absolute bottom-0 right-0", selectionMenu = true }: {
  stepId: string;
  text: string;
  contentRef: RefObject<HTMLDivElement | null>;
  onCite?: (citation: ResponseCitation) => void;
  className?: string;
  /** Runs use their existing Copy / Notes / Tasks menu instead. */
  selectionMenu?: boolean;
}) {
  const disabledReason = (onCite as ((typeof onCite) & { disabledReason?: string }))?.disabledReason;
  const [menu, setMenu] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const content = contentRef.current;
    if (!onCite || !selectionMenu || !content) return;
    const open = (event: MouseEvent) => {
      const selected = selectedResponseText(content, window.getSelection());
      if (!selected) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ text: selected, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 48)) });
    };
    content.addEventListener("contextmenu", open);
    return () => content.removeEventListener("contextmenu", open);
  }, [contentRef, onCite, selectionMenu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);
  if (!onCite || !text.trim()) return null;
  return <>
    <Button type="button" variant="ghost" size="sm" className={`h-6 w-6 shrink-0 p-0 text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] ${className}`}
      aria-disabled={Boolean(disabledReason)} title={disabledReason ?? "Reply to response"} aria-label="Reply to response"
      onClick={() => { if (!disabledReason) onCite({ stepId, text, kind: "reply" }); }}>
      <Reply className="h-3.5 w-3.5" aria-hidden />
    </Button>
    {menu ? createPortal(<div role="menu" className="fixed z-[80] min-w-[13rem] glass-popover overflow-hidden py-1" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" disabled={Boolean(disabledReason)} title={disabledReason} autoFocus className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)]"
        onClick={() => { onCite({ stepId, text: menu.text, kind: "cite" }); setMenu(null); }}>
        <Quote className="h-3.5 w-3.5 text-[var(--ec-muted)]" aria-hidden /> Cite selected text
      </button>
    </div>, document.body) : null}
  </>;
}
