import type { ChatAttachmentPayload } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { mergeMobileTaskAttachments } from "./task-attachments";

describe("mergeMobileTaskAttachments", () => {
  it("does not persist a newly selected file that is already stored", () => {
    const stored: ChatAttachmentPayload = { fileName: "design.png", mimeType: "image/png", dataBase64: "AA==" };
    const storedEquivalent: ChatAttachmentPayload = { fileName: "design.png", mimeType: "image/png", dataBase64: "AA==" };
    const incoming: ChatAttachmentPayload = { fileName: "notes.md", mimeType: "text/markdown", dataBase64: "Iw==" };

    expect(mergeMobileTaskAttachments([stored], [storedEquivalent, incoming])).toEqual([stored, incoming]);
  });
});
