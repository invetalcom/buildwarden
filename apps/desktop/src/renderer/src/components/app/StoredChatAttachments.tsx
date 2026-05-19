import { useState } from "react";
import type { ChatAttachmentPayload } from "@easycode/shared";

const toDataUrl = (attachment: ChatAttachmentPayload): string =>
  `data:${attachment.mimeType || "application/octet-stream"};base64,${attachment.dataBase64}`;

const formatAttachmentLabel = (attachment: ChatAttachmentPayload): string => {
  const mime = (attachment.mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) {
    return "Image";
  }
  if (mime === "application/pdf") {
    return "PDF";
  }
  if (mime.startsWith("text/") || mime === "application/json") {
    return "Text";
  }
  return "File";
};

interface StoredChatAttachmentsProps {
  attachments: ChatAttachmentPayload[];
  fallbackNames?: string[];
  compact?: boolean;
}

export const StoredChatAttachments = ({
  attachments,
  fallbackNames = [],
  compact = false,
}: StoredChatAttachmentsProps) => {
  const [expandedImage, setExpandedImage] = useState<ChatAttachmentPayload | null>(null);

  if (attachments.length === 0 && fallbackNames.length === 0) {
    return null;
  }

  const imageAttachments = attachments.filter((attachment) => (attachment.mimeType || "").toLowerCase().startsWith("image/"));
  const nonImageAttachments = attachments.filter((attachment) => !imageAttachments.includes(attachment));
  const usedNames = new Set(attachments.map((attachment) => attachment.fileName));
  const namesOnly = fallbackNames.filter((name) => !usedNames.has(name));

  return (
    <>
      <div className={compact ? "mt-1.5 space-y-2" : "mt-2 space-y-2"}>
        {imageAttachments.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {imageAttachments.map((attachment, index) => (
              <button
                key={`${attachment.fileName}-${String(index)}`}
                type="button"
                className="group block overflow-hidden rounded-xl border border-fuchsia-500/15 bg-zinc-950/60 text-left transition hover:border-fuchsia-400/30"
                title={`Open ${attachment.fileName}`}
                onClick={() => setExpandedImage(attachment)}
              >
                <img
                  src={toDataUrl(attachment)}
                  alt={attachment.fileName}
                  className={compact ? "h-24 w-24 object-cover" : "h-28 w-28 object-cover"}
                />
                <div className="max-w-28 truncate border-t border-fuchsia-500/10 px-2 py-1 text-[10px] text-zinc-400 group-hover:text-zinc-300">
                  {attachment.fileName}
                </div>
              </button>
            ))}
          </div>
        ) : null}

        {nonImageAttachments.length > 0 || namesOnly.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {nonImageAttachments.map((attachment, index) => (
              <a
                key={`${attachment.fileName}-${String(index)}`}
                href={toDataUrl(attachment)}
                download={attachment.fileName}
                className="flex max-w-full items-center gap-1 rounded-md border border-fuchsia-500/15 bg-zinc-950/55 px-2 py-1 text-[11px] text-zinc-300 transition hover:border-fuchsia-400/30 hover:text-zinc-100"
                title={attachment.fileName}
              >
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">
                  {formatAttachmentLabel(attachment)}
                </span>
                <span className="truncate">{attachment.fileName}</span>
              </a>
            ))}
            {namesOnly.map((name, index) => (
              <span
                key={`${name}-${String(index)}`}
                className="max-w-full truncate rounded-md border border-fuchsia-500/15 bg-zinc-950/50 px-2 py-1 text-[11px] text-zinc-400"
                title={name}
              >
                {name}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {expandedImage ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setExpandedImage(null)}
          role="dialog"
          aria-modal="true"
          aria-label={expandedImage.fileName}
        >
          <div
            className="max-h-full max-w-6xl overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
              <p className="truncate text-sm text-zinc-200">{expandedImage.fileName}</p>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => setExpandedImage(null)}
              >
                Close
              </button>
            </div>
            <div className="flex max-h-[85vh] items-center justify-center bg-black p-3">
              <img
                src={toDataUrl(expandedImage)}
                alt={expandedImage.fileName}
                className="max-h-[80vh] max-w-full object-contain"
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};
