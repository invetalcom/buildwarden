import { useId, useRef } from "react";
import { appendChatAttachmentFiles, CHAT_ATTACHMENT_LIMITS } from "@easycode/shared";
import { Paperclip, X } from "lucide-react";
import { Button } from "../ui/button";

interface ChatAttachmentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  /** Single row beside Send; limits shown on attach button tooltip only. */
  variant?: "default" | "footer";
}

export const ChatAttachmentPicker = ({ files, onChange, disabled, variant = "default" }: ChatAttachmentPickerProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const acceptedFileTypes = "image/*,application/pdf,text/*,application/json,.md,.txt,.pdf,.json";

  const addFromList = (list: FileList | null) => {
    if (!list?.length) return;
    onChange(appendChatAttachmentFiles(files, Array.from(list)));
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
          className="flex max-w-[min(100%,14rem)] items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900/80 pl-2 pr-1 py-0.5 text-[11px] text-zinc-300"
        >
          <span className="truncate" title={file.name}>
            {file.name}
          </span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
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
            className="h-9 shrink-0 gap-1 px-2 text-zinc-400 hover:text-cyan-300"
            disabled={disabled || files.length >= CHAT_ATTACHMENT_LIMITS.maxFileCount}
            onClick={() => inputRef.current?.click()}
            title={limitsTitle}
          >
            <Paperclip className="h-4 w-4" />
            <span className="text-xs">Attach</span>
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
              className="h-7 gap-1 px-1.5 text-zinc-400 hover:text-cyan-300"
              disabled={disabled || files.length >= CHAT_ATTACHMENT_LIMITS.maxFileCount}
              onClick={() => inputRef.current?.click()}
              title="Attach files"
            >
              <Paperclip className="h-3.5 w-3.5" />
              <span className="text-xs">Attach</span>
            </Button>
            <span className="text-[11px] text-zinc-600">
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
