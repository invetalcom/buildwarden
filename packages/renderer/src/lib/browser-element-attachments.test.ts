import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { ProviderType, RunBrowserElementCapture } from "@buildwarden/shared";
import {
  browserElementPayloadsForProvider,
  browserElementReservedFileSlots,
  validateBrowserElementCaptureAddition,
} from "./browser-element-attachments";
import { intersectNativeSurfaceBounds } from "./native-surface-occlusion";

const payload = (fileName: string, mimeType: string, text: string) => ({
  fileName,
  mimeType,
  dataBase64: Buffer.from(text).toString("base64"),
});

const capture = (id: string): RunBrowserElementCapture => ({
  id,
  runId: "run-1",
  capturedAt: "2026-07-16T18:00:00.000Z",
  url: "https://example.com/",
  pageTitle: "Example",
  locator: { selector: "button.save", segments: [{ kind: "element", selector: "button.save" }] },
  tagName: "button",
  accessibleRole: "button",
  accessibleName: "Save",
  visibleText: "Save",
  sanitizedHtml: "<button>Save</button>",
  attributes: {},
  computedStyles: {},
  ancestry: ["body"],
  frameworkHints: [],
  bounds: { x: 10, y: 20, width: 80, height: 32 },
  contextAttachment: {
    ...payload(`browser-element-${id}.md`, "text/markdown", "context"),
    source: { kind: "browser-element", groupId: id, captureId: id, role: "context", url: "https://example.com/", selector: "button.save" },
  },
  screenshotAttachment: {
    ...payload(`browser-element-${id}.jpg`, "image/jpeg", "jpeg"),
    source: { kind: "browser-element", groupId: id, captureId: id, role: "screenshot", url: "https://example.com/", selector: "button.save" },
  },
});

describe("browser element composer attachments", () => {
  it("reserves two physical slots per logical element", () => {
    const captures = [capture("one"), capture("two")];
    expect(browserElementReservedFileSlots(captures)).toBe(4);
    expect(validateBrowserElementCaptureAddition(
      [{ size: 1 } as File, { size: 1 } as File, { size: 1 } as File],
      captures,
      capture("three"),
    )).toMatch(/two attachment slots/);
  });

  it.each([
    "ai-sdk",
    "azure-legacy",
    "codex-cli",
    "cursor-agent",
  ] satisfies ProviderType[])("sends Markdown and JPEG to the vision-capable %s provider", (providerType) => {
    const selected = [capture("one")];
    expect(browserElementPayloadsForProvider(selected, providerType).map(({ mimeType, source }) => [mimeType, source?.role])).toEqual([
      ["text/markdown", "context"],
      ["image/jpeg", "screenshot"],
    ]);
  });

  it("sends Markdown without JPEG to the text-only Claude Code transport", () => {
    const selected = [capture("one")];
    expect(browserElementPayloadsForProvider(selected, "claude-code").map(({ mimeType }) => mimeType)).toEqual([
      "text/markdown",
    ]);
  });
});

describe("native browser surface clipping", () => {
  it("intersects the surface with the visible renderer area", () => {
    expect(intersectNativeSurfaceBounds(
      { x: 50, y: 40, width: 300, height: 200 },
      { x: 100, y: 0, width: 200, height: 180 },
    )).toEqual({ x: 100, y: 40, width: 200, height: 140 });
    expect(intersectNativeSurfaceBounds(
      { x: -100, y: 0, width: 50, height: 50 },
      { x: 0, y: 0, width: 100, height: 100 },
    )).toBeNull();
  });
});
