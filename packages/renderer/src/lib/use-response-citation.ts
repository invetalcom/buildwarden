import { useCallback, useEffect, useRef, type RefObject } from "react";
import { appendChatAttachmentFiles, CHAT_ATTACHMENT_LIMITS, getFileResponseCitation } from "@buildwarden/shared";
import type { ResponseCitation } from "./response-citation";
import type { ComposerDraft } from "./use-composer-draft";

export function useResponseCitation(draft: ComposerDraft, inputRef: RefObject<HTMLTextAreaElement | null>, disabled: boolean) {
  const pending = useRef(new Set<string>());
  const { blocked, submitting, setFiles, files } = draft;
  const currentDraft = useRef(draft);
  useEffect(() => { currentDraft.current = draft; }, [draft]);
  const limitReached = files.length >= CHAT_ATTACHMENT_LIMITS.maxFileCount;
  const append = useCallback(async (citation: ResponseCitation) => {
    if (disabled || blocked || submitting || !citation.text.trim()) return;
    const key = JSON.stringify([citation.kind, citation.stepId, citation.text]);
    if (pending.current.has(key)) return;
    pending.current.add(key);
    try {
      // Focus without moving an existing selection or caret.
      inputRef.current?.focus();
      const excerpt = citation.text.replace(/\s+/g, " ").trim().slice(0, 80);
      const responseCitation = { kind: citation.kind, stepId: citation.stepId, excerpt };
      const file = Object.assign(new File([citation.text], citation.kind === "reply" ? "Reply to assistant response.txt" : "Cited assistant response.txt", { type: "text/plain;charset=utf-8" }), { responseCitation });
      const matching = await Promise.all(files.map(async (existing) => {
        const source = getFileResponseCitation(existing);
        return source?.kind === citation.kind && source.stepId === citation.stepId && await existing.text().catch(() => null) === citation.text ? existing : null;
      }));
      if (currentDraft.current.setFiles !== setFiles || currentDraft.current.blocked || currentDraft.current.submitting) return;
      setFiles((current) => matching.some((existing) => existing && current.includes(existing)) ? current : appendChatAttachmentFiles(current, [file]));
    } finally { pending.current.delete(key); }
  }, [blocked, disabled, files, inputRef, setFiles, submitting]);
  return disabled || blocked || submitting ? undefined : Object.assign(append, { disabledReason: limitReached ? "Attachment limit reached. Remove an attachment first." : undefined });
}
