/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatAttachmentPayload, ChatStepRecord } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { MobileChatStep } from "./ChatTranscriptStep";
import { MobileAttachmentPicker, MobileStoredAttachments } from "./TaskAttachments";

const attachment = (fileName: string, mimeType: string, dataBase64 = "AA=="): ChatAttachmentPayload => ({
  fileName,
  mimeType,
  dataBase64,
});

describe("mobile stored attachments", () => {
  it("renders every supported preview mode and keeps unknown files downloadable", () => {
    const markup = renderToStaticMarkup(
      <MobileStoredAttachments attachments={[
        attachment("photo.png", "image/png"),
        attachment("recording.mp3", "audio/mpeg"),
        attachment("clip.mp4", "video/mp4"),
        attachment("brief.pdf", "application/pdf"),
        attachment("notes.txt", "text/plain", "SGVsbG8gbW9iaWxl"),
        attachment("archive.zip", "application/zip"),
      ]} />,
    );

    expect(markup).toContain("<img");
    expect(markup).toContain("<audio");
    expect(markup).toContain("<video");
    expect(markup).toContain("Open PDF");
    expect(markup).toContain("Hello mobile");
    expect(markup).toContain('data-attachment-kind="archive"');
    expect(markup).toContain('download="archive.zip"');
  });

  it("shows generated media carried by assistant step metadata", () => {
    const generated = attachment("generated-image.png", "image/png");
    const step: ChatStepRecord = {
      id: "step-1",
      chatId: "chat-1",
      eventType: "output",
      title: "Generated file",
      content: "Generated 1 file.",
      metadataJson: JSON.stringify({ attachments: [generated], attachmentNames: [generated.fileName] }),
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const markup = renderToStaticMarkup(<MobileChatStep step={step} />);
    expect(markup).toContain("generated-image.png");
    expect(markup).toContain("<img");
  });

  it("does not restrict the browser picker to a partial MIME allowlist", () => {
    const markup = renderToStaticMarkup(<MobileAttachmentPicker files={[]} onFilesChange={() => undefined} />);
    expect(markup).toContain('type="file"');
    expect(markup).not.toContain("accept=");
  });

  it("portals the image preview above the shell navigation", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <MobileStoredAttachments attachments={[attachment("photo.png", "image/png")]} />,
    ));

    await act(async () => {
      (container.querySelector('button[aria-label="Open photo.png"]') as HTMLButtonElement).click();
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(container.contains(dialog)).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });
});
