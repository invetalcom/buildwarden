import {
  extractAttachmentNamesFromMetadata,
  extractAttachmentPayloadsFromMetadata,
  type ChatStepRecord,
} from "@buildwarden/shared";
import { getStoredAttachmentMessageContent } from "@buildwarden/renderer/logic";
import { parseStepMetadata } from "../lib/chat-steps";
import { RichText } from "./RichText";
import { MobileStoredAttachments } from "./TaskAttachments";

export const MobileChatStep = ({ step }: { step: ChatStepRecord }) => {
  const metadata = parseStepMetadata(step.metadataJson);
  const isUser = metadata.source === "user";
  const isError = step.eventType === "error";
  const isReasoning = step.eventType === "output" && metadata.assistantKind === "reasoning";
  const attachments = extractAttachmentPayloadsFromMetadata(metadata);
  const attachmentNames = extractAttachmentNamesFromMetadata(metadata);
  const content = isUser
    ? getStoredAttachmentMessageContent(step.content || step.title, attachmentNames)
    : step.content;

  if (isError) {
    return (
      <div className="mx-3 my-1.5 rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-3 py-2 text-[var(--ec-danger)]">
        <p className="text-xs font-semibold">{step.title}</p>
        {content ? <RichText className="mt-1">{content}</RichText> : null}
        <MobileStoredAttachments attachments={attachments} fallbackNames={attachmentNames} />
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex justify-end px-3 py-1.5">
        <div className="min-w-0 max-w-[86%] rounded-2xl rounded-br-md border border-[var(--ec-user-input-ring)] bg-[var(--ec-user-input-soft)] px-3 py-2">
          {content ? <RichText>{content}</RichText> : null}
          <MobileStoredAttachments attachments={attachments} fallbackNames={attachmentNames} />
        </div>
      </div>
    );
  }

  if (isReasoning) {
    return (
      <details className="mx-3 my-1.5 rounded-md border border-[var(--ec-reasoning-ring)] bg-[var(--ec-reasoning-soft)] px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--ec-reasoning)]">Reasoning</summary>
        <RichText className="mt-2 text-[var(--ec-muted)]">{content}</RichText>
      </details>
    );
  }

  if (step.eventType === "status") {
    return <p className="px-4 py-1 text-[11px] text-[var(--ec-faint)]">{step.title}</p>;
  }

  return (
    <div className="min-w-0 px-4 py-1.5">
      <MobileStoredAttachments attachments={attachments} fallbackNames={attachmentNames} />
      {content ? <RichText>{content}</RichText> : null}
    </div>
  );
};
