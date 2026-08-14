import { useId, useRef } from "react";
import { appendChatAttachmentFiles, CHAT_ATTACHMENT_LIMITS } from "@buildwarden/shared";
import { FileText, Paperclip, TextCursorInput, X } from "lucide-react";
import { getPastedTextAttachmentTitle, isPastedTextAttachmentFile } from "../../lib/pasted-text-attachment";
import { Button } from "../ui/button";
import { useComposerPastedTextRestore } from "./composer-pasted-text-restore";

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
  const restoringPastedTextFilesRef = useRef(new Set<File>());
  const inputId = useId();
  const restorePastedText = useComposerPastedTextRestore();
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

  const restoreAt = async (index: number) => {
    const file = files[index];
    if (
      !file ||
      !isPastedTextAttachmentFile(file) ||
      !restorePastedText ||
      restoringPastedTextFilesRef.current.has(file)
    ) {
      return;
    }
    restoringPastedTextFilesRef.current.add(file);
    try {
      const value = await file.text();
      restorePastedText(value);
      removeAt(index);
    } catch {
      window.alert(`Could not paste "${file.name}" back into the prompt.`);
    } finally {
      restoringPastedTextFilesRef.current.delete(file);
    }
  };

  const limitsTitle = `Attach files · up to ${String(CHAT_ATTACHMENT_LIMITS.maxFileCount)} files, ${String(CHAT_ATTACHMENT_LIMITS.maxBytesPerFile / (1024 * 1024))} MB each · paste files or long text in the prompt (Ctrl+V or ⌘+V)`;

  const fileList = (
    <ul className="flex min-w-0 flex-wrap content-center gap-1.5">
      {files.map((file, index) => {
        const isPastedText = isPastedTextAttachmentFile(file);
        return (
          <li
            key={`${file.name}-${String(index)}-${String(file.size)}`}
            className={isPastedText
              ? "flex h-10 max-w-[min(100%,18rem)] items-center gap-2 rounded-xl border border-[var(--ec-border)] bg-[var(--ec-panel)] py-1 pl-1.5 pr-1 text-[var(--ec-text)]"
              : "flex max-w-[min(100%,14rem)] items-center gap-1 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] py-0.5 pl-2 pr-1 text-[11px] text-[var(--ec-text)]"}
          >
            {isPastedText ? (
              <>
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--ec-control)] text-[var(--ec-muted)]">
                  <FileText className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[11px] font-medium" title={getPastedTextAttachmentTitle(file)}>
                    {getPastedTextAttachmentTitle(file)}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-[var(--ec-faint)]">Pasted text</span>
                </span>
              </>
            ) : (
              <span className="truncate" title={file.name}>
                {file.name}
              </span>
            )}
            {isPastedText && restorePastedText ? (
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-[var(--ec-faint)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
                onClick={() => void restoreAt(index)}
                disabled={disabled}
                title="Paste back into prompt"
                aria-label={`Paste ${file.name} back into prompt`}
              >
                <TextCursorInput className="h-3.5 w-3.5" />
              </button>
            ) : null}
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
        );
      })}
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
