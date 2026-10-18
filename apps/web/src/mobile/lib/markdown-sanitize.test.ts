import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { markdownSanitizeSchema } from "./markdown-sanitize";
import { markdownSanitizeSchema as sharedSchema } from "@buildwarden/renderer/response-content";
import { RichText } from "../components/RichText";

describe("mobile response rendering", () => {
  it("uses the same sanitizer as desktop", () => { expect(markdownSanitizeSchema).toBe(sharedSchema); });
  it("preserves the start number of image lists", () => {
    const html = renderToStaticMarkup(createElement(RichText, { children: '3. **Preview** — Details. ![Preview](https://example.com/a.png)' }));
    expect(html).toContain('start="3"');
    expect(html).toContain('class="response-media-row"');
  });
  it("renders tables, media rows and raster data images", () => {
    const html = renderToStaticMarkup(createElement(RichText, { children: "## Project\n\n![Preview](data:image/png;base64,iVBORw0KGgo=)\n\n### Title\n\nSubtitle\n\n| Goal | Pick |\n|---|---|\n| Learn | App |" }));
    expect(html).toContain('class="response-media-row"');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain('<table');
  });
  it("blocks active content and non-image data URLs", () => {
    const html = renderToStaticMarkup(createElement(RichText, { children: '<script>alert(1)</script><img src="data:text/html;base64,PGgxPg==" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><img src="file:///etc/passwd">' }));
    expect(html).not.toMatch(/<script|onerror=|href="javascript:|src="(?:data:|file:)/);
  });
  it.each([
    '1. **Rule matrix** — Spot missing rules. ![Preview](data:image/png;base64,iVBORw0KGgo=)\n2. **Bulk editing** — Update together. ![Preview](https://example.com/b.png)',
    '### Rule matrix\n\nSpot missing rules.\n\n![Preview](data:image/png;base64,iVBORw0KGgo=)\n\n### Bulk editing\n\nUpdate together.\n\n![Preview](https://example.com/b.png)',
  ])("uses the shared title-first card layout without provider-specific metadata", (children) => {
    const html = renderToStaticMarkup(createElement(RichText, { children }));
    expect(html.match(/class="response-media-row"/g)).toHaveLength(2);
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('Load external image from example.com');
    expect(html).not.toContain('src="https://');
    expect(html).toMatch(/response-media-image[\s\S]*response-media-text[\s\S]*Rule matrix[\s\S]*Spot missing rules/);
    expect(html).toContain('aria-label="Enlarge Preview"');
  });
});
