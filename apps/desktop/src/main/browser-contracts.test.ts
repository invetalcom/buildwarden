import { describe, expect, it } from "vitest";
import {
  extractAttachmentPayloadsFromMetadata,
  isBrowserElementAttachmentSource,
  validateChatAttachmentPayloads,
  type BrowserElementAttachmentSource,
  type ChatAttachmentPayload,
  type RunBrowserEvent,
} from "@buildwarden/shared";

const source: BrowserElementAttachmentSource = {
  kind: "browser-element",
  groupId: "browser-group-1",
  captureId: "capture-1",
  role: "context",
  url: "https://example.com/account",
  selector: "main > form:nth-of-type(1)",
};

describe("run browser shared contracts", () => {
  it("accepts and restores grouped browser element attachment metadata", () => {
    const attachment: ChatAttachmentPayload = {
      fileName: "browser-element-capture-1.md",
      mimeType: "text/markdown",
      dataBase64: Buffer.from("# Browser element", "utf8").toString("base64"),
      source,
    };

    expect(() => validateChatAttachmentPayloads([attachment])).not.toThrow();
    expect(extractAttachmentPayloadsFromMetadata({ attachments: [attachment] })).toEqual([attachment]);
  });

  it("rejects malformed browser attachment metadata", () => {
    expect(isBrowserElementAttachmentSource({ ...source, role: "preview" })).toBe(false);
    expect(() => validateChatAttachmentPayloads([{
      fileName: "browser-element.md",
      mimeType: "text/markdown",
      dataBase64: "YQ==",
      source: { ...source, selector: "" },
    }])).toThrow("invalid browser element metadata");
  });

  it("rejects inconsistent browser element attachment groups", () => {
    const context: ChatAttachmentPayload = {
      fileName: "browser-element-capture-1.md",
      mimeType: "text/markdown",
      dataBase64: "YQ==",
      source,
    };
    const screenshot: ChatAttachmentPayload = {
      fileName: "browser-element-capture-1.jpg",
      mimeType: "image/jpeg",
      dataBase64: "YQ==",
      source: { ...source, role: "screenshot" },
    };

    expect(() => validateChatAttachmentPayloads([context, screenshot])).not.toThrow();
    expect(() => validateChatAttachmentPayloads([context, { ...context }])).toThrow("duplicate context");
    expect(() => validateChatAttachmentPayloads([
      context,
      { ...screenshot, source: { ...screenshot.source!, selector: "button.cancel" } },
    ])).toThrow("does not match");
    expect(() => validateChatAttachmentPayloads([{ ...context, mimeType: "image/jpeg" }])).toThrow("does not match its MIME type");
    expect(() => validateChatAttachmentPayloads([screenshot])).toThrow("missing its Markdown context");
  });

  it("defines transport-neutral browser state events", () => {
    const event: RunBrowserEvent = {
      type: "state",
      runId: "run-1",
      state: {
        runId: "run-1",
        currentUrl: "about:blank",
        title: "",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        inspecting: false,
        viewport: { width: 1_024, height: 768 },
      },
    };

    expect(event.state.viewport).toEqual({ width: 1_024, height: 768 });
  });
});
