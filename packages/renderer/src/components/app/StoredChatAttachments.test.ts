import { describe, expect, it } from "vitest";
import type { ChatAttachmentPayload } from "@buildwarden/shared";
import {
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
});
