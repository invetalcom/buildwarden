import { useEffect, useRef, useState } from "react";
import { appendChatAttachmentFiles, CHAT_ATTACHMENT_LIMITS, type ChatAttachmentPayload } from "@buildwarden/shared";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { cn } from "../lib/cn";
import { readMobileAttachmentFiles } from "../lib/task-attachments";
import { Textarea } from "./primitives";

/**
 * Sticky bottom composer.
 *
 * Sits above the safe-area inset and grows to a capped height, the way messaging apps do; the
 * page never scrolls behind it because the shell owns scrolling. `interactive-widget=resizes-content`
 * in the viewport meta means the on-screen keyboard shrinks the layout viewport, so the composer
 * stays visible without any JS keyboard tracking.
 */
export const Composer = ({
  placeholder,
  busy = false,
  disabled = false,
  disabledReason,
  onSubmit,
  onCancel,
  accessory,
}: {
  placeholder: string;
  busy?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSubmit: (value: string, attachments: ChatAttachmentPayload[]) => void | Promise<void>;
  /** Shown instead of send while the run/chat is active. */
  onCancel?: () => void;
  accessory?: React.ReactNode;
}) => {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [readingFiles, setReadingFiles] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value]);

  const submit = async () => {
    const trimmed = value.trim();
    if ((!trimmed && files.length === 0) || busy || disabled || readingFiles) return;
    setReadingFiles(true);
    setAttachmentError(null);
    try {
      const attachments = await readMobileAttachmentFiles(files);
      await onSubmit(trimmed, attachments);
      setValue("");
      setFiles([]);
    } catch (caught) {
      setAttachmentError(caught instanceof Error ? caught.message : "Could not read the selected files.");
    } finally {
      setReadingFiles(false);
    }
  };

  const hasInput = Boolean(value.trim() || files.length);

  if (disabled) {
    return (
      <div className="m-safe-bottom shrink-0 border-t border-[var(--ec-border)] bg-[var(--ec-sidebar)] px-4 py-3">
        <p className="text-center text-xs text-[var(--ec-faint)]">{disabledReason ?? "This session is read-only."}</p>
      </div>
    );
  }

  return (
    <div
      className="m-safe-bottom shrink-0 border-t border-[var(--ec-border)] bg-[var(--ec-sidebar)]"
      style={{ paddingLeft: "var(--m-safe-left)", paddingRight: "var(--m-safe-right)" }}
    >
      {attachmentError ? <p className="px-3 pt-2 text-xs text-[var(--ec-danger)]">{attachmentError}</p> : null}
      {files.length > 0 || accessory ? (
        <div className="m-scroll-x flex gap-1.5 px-3 pt-2">
          {files.map((file, index) => (
            <span key={`${file.name}-${String(index)}`} className="inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] py-1 pl-2.5 pr-1 text-xs">
              <span className="max-w-40 truncate">{file.name}</span>
              <button type="button" className="flex size-7 items-center justify-center rounded-full text-[var(--ec-muted)]" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                <X className="size-3.5" />
              </button>
            </span>
          ))}
          {accessory}
        </div>
      ) : null}
      <div className="flex items-end gap-2 px-3 py-2">
        {!onCancel ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={(event) => {
                setFiles((current) => appendChatAttachmentFiles(current, Array.from(event.target.files ?? [])));
                setAttachmentError(null);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              aria-label="Attach files"
              disabled={busy || readingFiles || files.length >= CHAT_ATTACHMENT_LIMITS.maxFileCount}
              onClick={() => fileInputRef.current?.click()}
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--ec-muted)] disabled:opacity-40"
            >
              <Paperclip className="size-5" />
            </button>
          </>
        ) : null}
        <Textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          enterKeyHint="enter"
          className={cn(
            "m-scroll-thin max-h-40 min-h-11 flex-1 rounded-2xl px-3.5 py-2.5",
          )}
        />
        {onCancel ? (
          <button
            type="button"
            aria-label="Stop"
            onClick={onCancel}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]"
          >
            <Square className="size-4 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            disabled={!hasInput || busy || readingFiles}
            onClick={() => void submit()}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-full transition",
              hasInput && !busy && !readingFiles
                ? "bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)]"
                : "bg-[var(--ec-control)] text-[var(--ec-faint)]",
            )}
          >
            <ArrowUp className="size-5" />
          </button>
        )}
      </div>
    </div>
  );
};
