/** @vitest-environment happy-dom */

import {
  DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD,
  MAX_PASTED_TEXT_ATTACHMENT_THRESHOLD,
  MIN_PASTED_TEXT_ATTACHMENT_THRESHOLD,
  parsePastedTextAttachmentThresholdSetting,
} from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import {
  createPastedTextAttachmentFile,
  getPastedTextAttachmentTitle,
  isPastedTextAttachmentFile,
  shouldAttachPastedText,
} from "./pasted-text-attachment";

describe("pasted text attachments", () => {
  it("uses the configured character threshold as the only collapse trigger", () => {
    expect(shouldAttachPastedText("A normal pasted sentence.")).toBe(false);
    expect(shouldAttachPastedText("x".repeat(DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD - 1))).toBe(false);
    expect(shouldAttachPastedText("x".repeat(DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD))).toBe(true);
    expect(shouldAttachPastedText("x".repeat(39), 40)).toBe(false);
    expect(shouldAttachPastedText("x".repeat(40), 40)).toBe(true);
    expect(shouldAttachPastedText(Array.from({ length: 20 }, () => "x").join("\n"))).toBe(false);
    expect(shouldAttachPastedText(" \n\n ")).toBe(false);
  });

  it("defaults and clamps the persisted threshold", () => {
    expect(parsePastedTextAttachmentThresholdSetting(undefined)).toBe(DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD);
    expect(parsePastedTextAttachmentThresholdSetting("not-a-number")).toBe(DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD);
    expect(parsePastedTextAttachmentThresholdSetting("0")).toBe(MIN_PASTED_TEXT_ATTACHMENT_THRESHOLD);
    expect(parsePastedTextAttachmentThresholdSetting(MAX_PASTED_TEXT_ATTACHMENT_THRESHOLD + 1)).toBe(MAX_PASTED_TEXT_ATTACHMENT_THRESHOLD);
    expect(parsePastedTextAttachmentThresholdSetting("3456")).toBe(3_456);
  });

  it("creates a marked UTF-8 text file with a readable, file-safe title", async () => {
    const text = "\n  Run pnpm audit: packages/core?  \n" + "details\n".repeat(30);
    const file = createPastedTextAttachmentFile(text);

    expect(file.name).toBe("Run pnpm audit packages core.txt");
    expect(file.type).toBe("text/plain;charset=utf-8");
    expect(isPastedTextAttachmentFile(file)).toBe(true);
    expect(getPastedTextAttachmentTitle(file)).toBe("Run pnpm audit packages core");
    expect(await file.text()).toBe(text);
  });
});
