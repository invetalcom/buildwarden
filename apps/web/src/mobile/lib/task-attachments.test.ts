import type { ChatAttachmentPayload } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { hasUnhydratedAttachmentMetadata, mergeMobileTaskAttachments } from "./task-attachments";

describe("mergeMobileTaskAttachments", () => {
  it("does not persist a newly selected file that is already stored", () => {
    const stored: ChatAttachmentPayload = { fileName: "design.png", mimeType: "image/png", dataBase64: "AA==" };
    const storedEquivalent: ChatAttachmentPayload = { fileName: "design.png", mimeType: "image/png", dataBase64: "AA==" };
    const incoming: ChatAttachmentPayload = { fileName: "notes.md", mimeType: "text/markdown", dataBase64: "Iw==" };

    expect(mergeMobileTaskAttachments([stored], [storedEquivalent, incoming])).toEqual([stored, incoming]);
  });
});

describe("hasUnhydratedAttachmentMetadata", () => {
  it("requests a detail refresh for projected attachment names only", () => {
    expect(hasUnhydratedAttachmentMetadata(JSON.stringify({ attachmentNames: ["image.png"] }))).toBe(true);
    expect(hasUnhydratedAttachmentMetadata(JSON.stringify({
      attachmentNames: ["image.png"],
      attachments: [{ fileName: "image.png", mimeType: "image/png", dataBase64: "AA==" }],
    }))).toBe(false);
    expect(hasUnhydratedAttachmentMetadata("{bad json")).toBe(false);
  });
});
