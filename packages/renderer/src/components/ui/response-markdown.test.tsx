import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { ActivityRichText } from "./activity-rich-text";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";

const render = (content: string) => renderToStaticMarkup(<BuildWardenClientProvider client={createElectronBuildWardenClient({} as DesktopApi)}><ActivityRichText content={content} /></BuildWardenClientProvider>);

describe("rich responses", () => {
  it("shows a readable HTML source link instead of a host-specific visualization token", () => {
    const token = '\uE200visualize\uE202{"path":"C:/repo/work/feature concepts.html","mode":"wide"}\uE201';
    const html = render(`Concept screenshots above.\n\n${token}`);
    expect(html).toContain('href="/C:/repo/work/feature%20concepts.html"');
    expect(html).toContain('Visualization source (HTML)');
    expect(html).not.toContain('\uE200visualize');
    expect(render(`\`${token}\``)).toContain('\uE200visualize');
    expect(render('\uE200visualize\uE202{"path":"javascript:alert(1).html"}\uE201')).not.toContain('href=');
  });
  it("renders a section heading, image on the left, and title/subtitle on the right", () => {
    const html = render('## Project\n\n![Dashboard](https://example.com/dashboard.png)\n\n### A compliance platform\n\nTarget: manufacturers\n\n**The opportunity:** Details');
    expect(html).toMatch(/<h2[^>]*>Project<\/h2>/);
    expect(html).toContain('class="response-media-row"');
    expect(html).toContain('class="response-media-image"');
    expect(html).toMatch(/response-media-text[\s\S]*<h3[\s\S]*A compliance platform[\s\S]*Target: manufacturers/);
    expect(html).toMatch(/<\/div><\/div>\s*<p[^>]*><strong[^>]*>The opportunity:/);
  });
  it("supports inline image/bold-title rows without changing standalone images or code", () => {
    expect(render('![Preview](https://example.com/a.png) **Title**\nDescription')).toContain('response-media-row');
    expect(render('![Preview](https://example.com/a.png)')).not.toContain('response-media-row');
    expect(render('```md\n![Preview](https://example.com/a.png) **Title**\n```')).not.toContain('<img');
  });
  it("retains tables and safe raster data images", () => {
    const html = render('| Goal | Pick |\n|---|---|\n| Learn | Dashboard |\n\n![Generated](data:image/png;base64,iVBORw0KGgo=)');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });
  it("blocks unsafe sources, raw forms, scripts and injected layout styling", () => {
    const html = render('<script>alert(1)</script><img src="data:image/svg+xml;base64,PHN2Zz4=" onerror="alert(1)"><img src="file:///etc/passwd"><img src="javascript:alert(1)"><form><input type="radio"><button>Send</button></form><div class="response-media-row" style="position:fixed">Text</div>');
    expect(html).not.toMatch(/<script|onerror=|src="(?:data:|file:|javascript:)|<form|type="radio"|style=|class="response-media-row"/);
    expect(html).toContain('Image unavailable');
  });
});
