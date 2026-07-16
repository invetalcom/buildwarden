import { useId, useRef } from "react";
import { appendChatAttachmentFiles, CHAT_ATTACHMENT_LIMITS } from "@buildwarden/shared";
import { Paperclip, X } from "lucide-react";
import { Button } from "../ui/button";

interface ChatAttachmentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  /** Single row beside Send; limits shown on attach button tooltip only. */
  variant?: "default" | "footer";
  /** Physical file slots reserved by logical attachments such as browser elements. */
  reservedFileSlots?: number;
}

export const ChatAttachmentPicker = ({ files, onChange, disabled, variant = "default", reservedFileSlots = 0 }: ChatAttachmentPickerProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const acceptedFileTypes = "image/*,application/pdf,text/*,application/json,.md,.txt,.pdf,.json";

  const addFromList = (list: FileList | null) => {
    if (!list?.length) return;
    const available = Math.max(0, CHAT_ATTACHMENT_LIMITS.maxFileCount - reservedFileSlots);
    onChange(appendChatAttachmentFiles(files, Array.from(list)).slice(0, available));
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const removeAt = (index: number) => {
    onChange(files.filter((_, i) => i !== index));
  };

  const limitsTitle = `Attach files · up to ${String(CHAT_ATTACHMENT_LIMITS.maxFileCount)} files, ${String(CHAT_ATTACHMENT_LIMITS.maxBytesPerFile / (1024 * 1024))} MB each · paste files in the prompt (Ctrl+V or ⌘+V)`;

  const fileList = (
    <ul className="flex min-w-0 flex-wrap content-center gap-1.5">
      {files.map((file, index) => (
        <li
          key={`${file.name}-${String(index)}-${String(file.size)}`}
          className="flex max-w-[min(100%,14rem)] items-center gap-1 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] pl-2 pr-1 py-0.5 text-[11px] text-[var(--ec-text)]"
        >
          <span className="truncate" title={file.name}>
            {file.name}
          </span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-[var(--ec-faint)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
            onClick={() => removeAt(index)}
            disabled={disabled}
            aria-label={`Remove ${file.name}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className={variant === "footer" ? "flex min-w-0 flex-wrap items-center gap-1.5" : "flex flex-col gap-1"}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        accept={acceptedFileTypes}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => addFromList(e.target.files)}
      />
      {variant === "footer" ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 shrink-0 rounded-full p-0 text-[var(--ec-muted)] hover:text-[var(--ec-text)]"
            disabled={disabled || files.length + reservedFileSlots >= CHAT_ATTACHMENT_LIMITS.maxFileCount}
            onClick={() => inputRef.current?.click()}
            title={limitsTitle}
            aria-label="Attach files"
          >
            <Paperclip className="h-4 w-4" />
            <span className="sr-only">Attach</span>
          </Button>
          {files.length > 0 ? fileList : null}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-1.5 text-[var(--ec-muted)] hover:text-[var(--ec-accent)]"
              disabled={disabled || files.length + reservedFileSlots >= CHAT_ATTACHMENT_LIMITS.maxFileCount}
              onClick={() => inputRef.current?.click()}
              title="Attach files"
            >
              <Paperclip className="h-3.5 w-3.5" />
              <span className="text-xs">Attach</span>
            </Button>
            <span className="text-[11px] text-[var(--ec-faint)]">
              Up to {String(CHAT_ATTACHMENT_LIMITS.maxFileCount)} files ·{" "}
              {String(CHAT_ATTACHMENT_LIMITS.maxBytesPerFile / (1024 * 1024))} MB each
            </span>
          </div>
          {files.length > 0 ? fileList : null}
        </>
      )}
    </div>
  );
};
