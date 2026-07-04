import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Download } from "lucide-react";

interface ImageLightboxProps {
  imageUrl: string;
  /** Shown in the header and used as the accessible dialog label. */
  title: string;
  /** File name used for the download link. */
  downloadFileName: string;
  onClose: () => void;
}

/**
 * Full-screen image viewer with a download action. Closes on backdrop click,
 * the Close button, or Escape. Used for chat image attachments and loop UI
 * review screenshots.
 */
export const ImageLightbox = ({ imageUrl, title, downloadFileName, onClose }: ImageLightboxProps) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[30000] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="max-h-full max-w-6xl overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <p className="truncate text-sm text-zinc-200">{title}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            <a
              href={imageUrl}
              download={downloadFileName}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
              title={`Download ${downloadFileName}`}
              aria-label={`Download ${downloadFileName}`}
            >
              <Download className="h-4 w-4" aria-hidden />
            </a>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
        <div className="flex max-h-[85vh] items-center justify-center bg-black p-3">
          <img src={imageUrl} alt={title} className="max-h-[80vh] max-w-full object-contain" />
        </div>
      </div>
    </div>,
    document.body,
  );
};
