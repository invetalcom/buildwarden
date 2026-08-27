import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { ChatAttachmentPayload } from "@buildwarden/shared";
import {
  getStoredAttachmentMessageContent,
  getStoredBrowserElementDisplayInfo,
  groupStoredAttachments,
  getStoredAttachmentDownloadMimeType,
  getStoredAttachmentRenderMode,
  type StoredAttachmentRenderMode,
} from "./stored-chat-attachment-utils";

const attachment = (fileName: string, mimeType = "text/plain"): ChatAttachmentPayload => ({
  fileName,
  mimeType,
  dataBase64: "SGVsbG8=",
});

describe("stored chat attachment preview decisions", () => {
  it.each([
    ["report.xlsx"],
    ["legacy.xls"],
    ["macro.xlsm"],
    ["open.ods"],
    ["doc.docx"],
    ["slides.pptx"],
    ["bundle.zip"],
  ])("renders %s as an icon even when the MIME type is misleading text", (fileName) => {
    expect(getStoredAttachmentRenderMode(attachment(fileName))).toBe("icon");
  });

  it.each([
    ["data.csv"],
    ["data.tsv"],
    ["notes.txt"],
    ["source.ts"],
    ["payload.json"],
  ] satisfies Array<[string]>)("allows a text preview for %s", (fileName) => {
    expect(getStoredAttachmentRenderMode(attachment(fileName))).toBe("text");
  });

  it.each([
    ["diagram.png", "image"],
    ["document.pdf", "pdf"],
    ["audio.mp3", "audio"],
    ["movie.mp4", "video"],
  ] satisfies Array<[string, StoredAttachmentRenderMode]>)("keeps the dedicated %s preview mode", (fileName, mode) => {
    expect(getStoredAttachmentRenderMode(attachment(fileName, "application/octet-stream"))).toBe(mode);
  });

  it("uses the spreadsheet extension MIME type for downloads when the payload says text", () => {
    expect(getStoredAttachmentDownloadMimeType(attachment("report.xlsx"))).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("groups persisted browser context and screenshot payloads into one logical item", () => {
    const source = {
      kind: "browser-element" as const,
      groupId: "capture-1",
      captureId: "capture-1",
      url: "https://example.com/",
      selector: "button.save",
      annotationNumber: 2,
      comment: "Use the primary action color.",
      tagName: "button",
      accessibleName: "Save",
    };
    const context = { ...attachment("browser-element-capture-1.md", "text/markdown"), source: { ...source, role: "context" as const } };
    const screenshot = { ...attachment("browser-element-capture-1.jpg", "image/jpeg"), source: { ...source, role: "screenshot" as const } };
    const ordinary = attachment("notes.txt");

    expect(groupStoredAttachments([context, screenshot, ordinary])).toEqual([
      { kind: "browser-element", groupId: "capture-1", contextAttachment: context, screenshotAttachment: screenshot },
      { kind: "attachment", attachment: ordinary },
    ]);
  });

  it("uses persisted browser display metadata and recovers older notes from Markdown", () => {
    const source = {
      kind: "browser-element" as const,
      groupId: "capture-1",
      captureId: "capture-1",
      role: "context" as const,
      url: "https://example.com/",
      selector: "button.save",
    };
    const markdown = [
      "# Browser element #4",
      "",
      "- Element: `<button>`",
      "- Accessible name: Save changes",
      "",
      "## User note",
      "",
      "Make this the primary action and increase the spacing.",
      "",
      "## Visible text",
      "",
      "Save changes",
    ].join("\n");
    const context: ChatAttachmentPayload = {
      fileName: "browser-element-capture-1.md",
      mimeType: "text/markdown",
      dataBase64: Buffer.from(markdown, "utf8").toString("base64"),
      source,
    };

    expect(getStoredBrowserElementDisplayInfo(context, undefined, 1)).toMatchObject({
      annotationNumber: 4,
      comment: "Make this the primary action and increase the spacing.",
      tagName: "button",
      accessibleName: "Save changes",
      selector: "button.save",
    });
  });

  it("removes the generated attachment filename suffix from visible message content", () => {
    const names = ["browser-element-one.md", "browser-element-one.jpg"];
    expect(getStoredAttachmentMessageContent(`(no text)\nAttachments: ${names.join(", ")}`, names)).toBe("");
    expect(getStoredAttachmentMessageContent(`Update the form\nAttachments: ${names.join(", ")}`, names)).toBe("Update the form");
    expect(getStoredAttachmentMessageContent("Keep only this prompt\nAttachments: older-one.md, older-one.jpg", names)).toBe("Keep only this prompt");
    expect(getStoredAttachmentMessageContent("Keep this prompt unchanged", names)).toBe("Keep this prompt unchanged");
  });
});
