import { describe, expect, it } from "vitest";
import type { ChatAttachmentPayload } from "@buildwarden/shared";
import {
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
    ["audio.mp3"],
    ["movie.mp4"],
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
    };
    const context = { ...attachment("browser-element-capture-1.md", "text/markdown"), source: { ...source, role: "context" as const } };
    const screenshot = { ...attachment("browser-element-capture-1.jpg", "image/jpeg"), source: { ...source, role: "screenshot" as const } };
    const ordinary = attachment("notes.txt");

    expect(groupStoredAttachments([context, screenshot, ordinary])).toEqual([
      { kind: "browser-element", groupId: "capture-1", contextAttachment: context, screenshotAttachment: screenshot },
      { kind: "attachment", attachment: ordinary },
    ]);
  });
});
