import { useEffect, useRef, useState } from "react";
import { ComposerDraftStatus, type ComposerDraft } from "@buildwarden/renderer";
import { appendChatAttachmentFiles, CHAT_ATTACHMENT_LIMITS, type ChatAttachmentPayload, type FollowUpDelivery } from "@buildwarden/shared";
import { ArrowUp, ListPlus, Paperclip, Square, X, Zap } from "lucide-react";

const DELIVERY_LABELS: Record<FollowUpDelivery, string> = {
  queue: "Queue follow-up",
  steer: "Steer into the running turn",
};
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
  draft,
  placeholder,
  busy = false,
  disabled = false,
  disabledReason,
  onSubmit,
  onCancel,
  accessory,
  hasExternalAttachments = false,
  activeDelivery,
}: {
  draft: ComposerDraft;
  placeholder: string;
  busy?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSubmit: (value: string, attachments: ChatAttachmentPayload[], delivery?: FollowUpDelivery) => void | Promise<void>;
  /** Shown while the run/chat is active; replaces send unless `activeDelivery` keeps sending available. */
  onCancel?: () => void;
  /**
   * Keeps the composer usable while the agent works. `primary` is what send does;
   * `alternate` adds a second button for the other delivery (only when the turn can be steered).
   */
  activeDelivery?: { primary: FollowUpDelivery; alternate?: FollowUpDelivery };
  accessory?: React.ReactNode;
  hasExternalAttachments?: boolean;
}) => {
  const { prompt: value, setPrompt: setValue, files, setFiles } = draft;
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value]);

  const submit = async (delivery?: FollowUpDelivery) => {
    const trimmed = value.trim();
    if ((!trimmed && files.length === 0 && !hasExternalAttachments) || busy || disabled || draft.blocked) return;
    const releaseSubmission = draft.beginSubmission();
    if (!releaseSubmission) return;
    setAttachmentError(null);
    try {
      const attachments = await readMobileAttachmentFiles(files);
      await (delivery ? onSubmit(trimmed, attachments, delivery) : onSubmit(trimmed, attachments));
      draft.clearSubmitted(draft);
    } catch (caught) {
      setAttachmentError(caught instanceof Error ? caught.message : "Could not read the selected files.");
    } finally {
      releaseSubmission();
    }
  };

  const hasInput = Boolean(value.trim() || files.length || hasExternalAttachments);
  const sendsWhileActive = Boolean(onCancel && activeDelivery);
  const canSend = hasInput && !busy && !draft.submitting && !draft.blocked;
  const primaryDelivery = sendsWhileActive ? activeDelivery?.primary : undefined;
  const alternateDelivery = sendsWhileActive ? activeDelivery?.alternate : undefined;

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
      <ComposerDraftStatus draft={draft} />
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
        {!onCancel || sendsWhileActive ? (
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
              disabled={busy || draft.submitting || draft.loading || draft.readOnly || files.length >= CHAT_ATTACHMENT_LIMITS.maxFileCount}
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
          readOnly={draft.readOnly}
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
        ) : null}
        {alternateDelivery ? (
          <button
            type="button"
            aria-label={DELIVERY_LABELS[alternateDelivery]}
            disabled={!canSend}
            onClick={() => void submit(alternateDelivery)}
            className="flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--ec-border)] text-[var(--ec-text)] disabled:opacity-40"
          >
            {alternateDelivery === "steer" ? <Zap className="size-5" /> : <ListPlus className="size-5" />}
          </button>
        ) : null}
        {onCancel && !sendsWhileActive ? null : (
          <button
            type="button"
            aria-label={primaryDelivery ? DELIVERY_LABELS[primaryDelivery] : "Send"}
            disabled={!canSend}
            onClick={() => void submit(primaryDelivery)}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-full transition",
              hasInput && !busy && !draft.submitting
                ? "bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)]"
                : "bg-[var(--ec-control)] text-[var(--ec-faint)]",
            )}
          >
            {primaryDelivery === "steer" ? <Zap className="size-5" /> : null}
            {primaryDelivery === "queue" ? <ListPlus className="size-5" /> : null}
            {primaryDelivery ? null : <ArrowUp className="size-5" />}
          </button>
        )}
      </div>
    </div>
  );
};
