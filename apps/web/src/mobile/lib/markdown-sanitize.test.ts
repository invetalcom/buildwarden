import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { markdownSanitizeSchema } from "./markdown-sanitize";
import { markdownSanitizeSchema as sharedSchema } from "@buildwarden/renderer/response-content";
import { RichText } from "../components/RichText";

describe("mobile response rendering", () => {
  it("uses the same sanitizer as desktop", () => { expect(markdownSanitizeSchema).toBe(sharedSchema); });
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
});
