import { describe, expect, it } from "vitest";
import { presentToolResult, toolPresentation } from "@buildwarden/shared";

describe("MCP presentation", () => {
  it("preserves ordinary data fields in structured results", () => {
    const structuredContent = {
      data: { status: "ready", data: "ordinary text" }, blob: "business field",
      json: { mimeType: "application/json", data: { status: "ready" } },
      text: { mimeType: "text/plain", data: "ordinary text" },
    };
    expect(JSON.parse(presentToolResult({ content: [], structuredContent }).text)).toEqual(structuredContent);
  });

  it.each(["image/png", "image/jpeg", "image/webp", "audio/wav", "audio/mpeg", "audio/ogg"])("omits type-less %s payloads without changing structured data", (mimeType) => {
    const binary = "aGVsbG8=";
    const structuredContent = {
      data: { status: "ready" },
      media: { mimeType, data: binary, label: "Preview" },
      nested: [{ source: { media_type: mimeType, data: binary } }],
    };
    const result = presentToolResult({ structuredContent });
    expect(result.text).not.toContain(binary);
    expect(JSON.parse(result.text)).toEqual({
      data: { status: "ready" },
      media: { mimeType, data: "[data omitted]", label: "Preview" },
      nested: [{ source: { media_type: mimeType, data: "[data omitted]" } }],
    });
    expect(result.images).toEqual([]);
  });

  it("omits binary resource, audio and nested image payloads by content shape", () => {
    const binary = "aGVsbG8=";
    const result = presentToolResult({ content: [
      { type: "resource", resource: { uri: "file:///report.pdf", mimeType: "application/pdf", blob: binary } },
      { type: "audio", mimeType: "audio/wav", data: binary },
      { type: "resource", resource: { uri: "file:///readme.txt", text: "Readable resource" } },
    ] });
    expect(result.text).not.toContain(binary);
    expect(result.text).toContain("[blob omitted]");
    expect(result.text).toContain("[data omitted]");
    expect(result.text).toContain("Readable resource");
    expect(result.text).toContain("file:///report.pdf");
    expect(presentToolResult({ structuredContent: { nested: [
      { type: "image", mimeType: "image/png", data: binary },
      { type: "image", source: { type: "base64", media_type: "image/png", data: binary } },
    ] } }).text).not.toContain(binary);
  });

  it("handles MCP, Claude and ACP image blocks without printing base64", () => {
    const result = presentToolResult([{ type: "text", text: "Ready" }, { type: "content", content: { type: "image", source: { media_type: "image/png", data: "aGVsbG8=" } } }]);
    expect(result).toEqual({ text: "Ready\n[Image]", images: [{ mimeType: "image/png", data: "aGVsbG8=" }] });
    expect(presentToolResult({ content: [], structuredContent: { status: "ready" } }).text).toContain("ready");
    expect(presentToolResult({ type: "image", mimeType: "text/html", data: "aGVsbG8=" }).images).toEqual([]);
  });
  it("uses intentional browser titles without mistaking arbitrary title arguments for display metadata", () => {
    expect(toolPresentation("mcp__buildwarden__buildwarden_browser", { action: "click" })).toMatchObject({ toolDisplayTitle: "Browser · click" });
    expect(toolPresentation("mcp__calendar__create", { title: "Private appointment" })).toMatchObject({ toolDisplayTitle: "calendar · create" });
  });
});
