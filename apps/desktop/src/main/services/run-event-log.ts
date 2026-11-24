import {
  type AppWarning,
  type AttachmentBlobResult,
  type ChatAttachmentPayload,
  type ChatEvent,
  type ChatStepRecord,
  previewLargeStepContent,
  type RunEvent,
  type RunOrganizationSnapshot,
  type StoredAttachmentMetadata,
} from "@buildwarden/shared";
import { AppService } from "./app-service";
import { withStepContentPreview, withStoredAttachmentMetadata } from "./run-step-content";

/** Persists run and chat timeline events and publishes them to connected clients. */
export class RunEventLog extends AppService<"titles"> {
  onChatEvent(listener: (event: ChatEvent) => void): () => void {
    return this.events.subscribe("chat", listener);
  }

  onRunEvent(listener: (event: RunEvent) => void): () => void {
    return this.events.subscribe("run", listener);
  }

  onAppWarning(listener: (warning: AppWarning) => void): () => void {
    return this.events.subscribe("warning", listener);
  }

  async appendRunEvent(
    runId: string,
    type: RunEvent["type"],
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) {
    const step = this.db.appendRunStep(runId, type, title, content, JSON.stringify(metadata ?? {}));
    if (metadata?.source === "user" && metadata.commandType === "initial") this.services.titles.sessionTitles.startInitial("run", runId);
    return step;
  }

  defaultRunEventTitle(type: RunEvent["type"]): string {
    switch (type) {
      case "output":
        return "Agent output";
      case "tool-call":
        return "Tool call";
      case "tool-result":
        return "Tool result";
      case "tool-progress":
        return "Tool progress";
      case "approval-requested":
        return "Approval requested";
      case "approval-resolved":
        return "Approval resolved";
      case "user-input-requested":
      case "request":
        return "User input requested";
      case "plan-updated":
      case "plan":
        return "Plan updated";
      case "plan-progress":
        return "Plan progress";
      case "diff-updated":
        return "Diff updated";
      case "error":
        return "Run error";
      default:
        return "Run update";
    }
  }

  emitEvent(rawEvent: RunEvent): void {
    const event = withStepContentPreview(withStoredAttachmentMetadata(rawEvent));
    // Output steps don't change the list summary. Keep its object identity in
    // clients and avoid reading the run row for every text replacement.
    if (event.step?.eventType === "output" && !event.run && !event.metadata?.usageTotals) {
      this.events.publish("run", event);
      return;
    }
    this.events.publish("run", { ...event, run: event.run ?? this.db.getRun(event.runId) });
  }

  emitChatEvent(chatId: string, rawEvent: Omit<ChatEvent, "chat" | "chatId">): void {
    const event = withStepContentPreview(withStoredAttachmentMetadata(rawEvent));
    if (event.step?.eventType === "output" && !event.metadata?.usageTotals) {
      this.events.publish("chat", { ...event, chatId });
      return;
    }
    this.events.publish("chat", { ...event, chatId, chat: this.db.getChat(chatId) });
  }

  async getAttachmentBlob(blobId: string): Promise<AttachmentBlobResult | null> {
    return this.db.getAttachmentBlob(blobId);
  }

  /** Full text of a step that clients received as a preview; null when the step no longer exists. */
  async getStepContent(kind: "run" | "chat", stepId: string): Promise<string | null> {
    return this.db.getStepContent(kind, stepId);
  }

  /** A step's text as clients receive it in history and live events. */
  getStepPreviewContent(kind: "run" | "chat", stepId: string): string | null {
    const step = this.db.getStepTypeAndContent(kind, stepId);
    return step ? previewLargeStepContent(step).content : null;
  }

  async appendChatEvent(
    chatId: string,
    eventType: RunEvent["type"],
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<ChatStepRecord> {
    const step = this.db.appendChatEvent(chatId, eventType, title, content, metadata);
    if (metadata?.source === "user" && metadata.commandType === "initial") this.services.titles.sessionTitles.startInitial("chat", chatId);
    return step;
  }

  buildStoredAttachmentMetadata(attachments: ChatAttachmentPayload[] | undefined): StoredAttachmentMetadata {
    if (!attachments?.length) {
      return {};
    }

    return {
      attachmentNames: attachments.map((attachment) => attachment.fileName),
      attachments,
    };
  }

  publishRunOrganization(snapshot: RunOrganizationSnapshot): RunOrganizationSnapshot {
    this.events.publish("runOrganization", { changedAt: new Date().toISOString() });
    return snapshot;
  }

  emitAppWarning(warning: AppWarning): void {
    this.events.publish("warning", warning);
  }
}
