import { MousePointer2, X } from "lucide-react";
import type { RunBrowserElementCapture } from "@buildwarden/shared";

type Props = {
  capture: RunBrowserElementCapture;
  disabled?: boolean;
  onRemove: () => void;
};

export const BrowserElementAttachmentPreview = ({ capture, disabled, onRemove }: Props) => {
  const label = (capture.accessibleName || capture.visibleText || capture.tagName).slice(0, 120);

  return (
    <div
      className="group flex h-11 max-w-[min(100%,20rem)] items-center overflow-hidden rounded-md border border-sky-500/35 bg-sky-500/[0.08] text-[11px] text-[var(--ec-text)] transition-colors hover:border-sky-400/55"
      title={`${capture.locator.selector}\n${capture.url}`}
    >
      <div className="relative h-full w-14 shrink-0 overflow-hidden border-r border-sky-500/25 bg-zinc-950">
        <img
          src={`data:${capture.screenshotAttachment.mimeType};base64,${capture.screenshotAttachment.dataBase64}`}
          alt=""
          className="h-full w-full object-cover opacity-90"
        />
        <span className="absolute left-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-600 px-1 text-[9px] font-bold leading-none text-white shadow-sm">
          {capture.annotationNumber}
        </span>
      </div>
      <div className="min-w-0 flex-1 px-2">
        <div className="flex min-w-0 items-center gap-1">
          <MousePointer2 className="h-3 w-3 shrink-0 text-sky-500" aria-hidden />
          <span className="truncate font-medium">{label}</span>
          <span className="shrink-0 text-[10px] text-[var(--ec-muted)]">&lt;{capture.tagName}&gt;</span>
        </div>
        <p className="mt-0.5 truncate text-[10px] text-[var(--ec-muted)]">
          {capture.comment || capture.locator.selector}
        </p>
      </div>
      <button
        type="button"
        className="mr-1 shrink-0 rounded p-1 text-[var(--ec-muted)] transition-colors hover:bg-sky-500/10 hover:text-[var(--ec-text)] disabled:opacity-40"
        aria-label={`Remove browser element ${label}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
