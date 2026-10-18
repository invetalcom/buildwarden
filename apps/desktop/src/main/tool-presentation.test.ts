import { describe, expect, it } from "vitest";
import { presentToolResult, toolPresentation } from "@buildwarden/shared";

describe("MCP presentation", () => {
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
