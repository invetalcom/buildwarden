import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { ActivityRichText } from "./activity-rich-text";
import { prepareResponseMarkdown } from "./response-markdown-preparation";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";

const render = (content: string) => renderToStaticMarkup(<BuildWardenClientProvider client={createElectronBuildWardenClient({} as DesktopApi)}><ActivityRichText content={content} /></BuildWardenClientProvider>);

describe("rich responses", () => {
  it("does not fetch external images from Markdown or raw HTML without consent", () => {
    const html = render('![External](https://example.com/image?secret=value)\n\n<img src="https://example.net/image?secret=value" alt="Raw">');
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/(?:src|srcset|href)=/);
    expect(html).not.toContain("secret=value");
    expect(html.match(/Load external image/g)).toHaveLength(2);
  });
  it.each([
    ["tight numbered list", "1. **Rule matrix** — Spot missing rules. ![Preview](IMAGE)\n2. **Bulk editing** — Update together. ![Preview](IMAGE)"],
    ["loose numbered list", "1. **Rule matrix** — Spot missing rules. ![Preview](IMAGE)\n\n2. **Bulk editing** — Update together. ![Preview](IMAGE)"],
    ["bulleted list", "- **Rule matrix** — Spot missing rules. ![Preview](IMAGE)\n- **Bulk editing** — Update together. ![Preview](IMAGE)"],
    ["heading, description, image", "### Rule matrix\n\nSpot missing rules.\n\n![Preview](IMAGE)\n\n### Bulk editing\n\nUpdate together.\n\n![Preview](IMAGE)"],
    ["heading then inline description/image", "### Rule matrix\n\nSpot missing rules. ![Preview](IMAGE)\n\n### Bulk editing\n\nUpdate together. ![Preview](IMAGE)"],
    ["bold title then separate image", "**Rule matrix** — Spot missing rules.\n\n![Preview](IMAGE)\n\n**Bulk editing** — Update together.\n\n![Preview](IMAGE)"],
    ["heading, image, caption", "### Rule matrix\n\n![Preview](IMAGE)\n\nSpot missing rules.\n\n### Bulk editing\n\n![Preview](IMAGE)\n\nUpdate together."],
  ])("groups provider-independent %s responses into cards", (_name, markdown) => {
    for (const source of ["https://example.com/preview.png", "data:image/png;base64,iVBORw0KGgo="]) {
      const html = render(markdown.replaceAll("IMAGE", source));
      expect(html.match(/class="response-media-row"/g)).toHaveLength(2);
      const cards = html.split('class="response-media-row"').slice(1);
      expect(cards[0]).toContain('Rule matrix');
      expect(cards[0]).toContain('Spot missing rules');
      expect(cards[0]).not.toContain('Bulk editing');
      expect(cards[1]).toContain('Bulk editing');
      expect(cards[1]).toContain('Update together');
      if (source.startsWith("data:")) expect(html.match(/<img /g)).toHaveLength(2);
      else {
        expect(html).not.toContain("<img");
        expect(html.match(/Load external image/g)).toHaveLength(2);
      }
      expect(html).toMatch(/response-media-image[\s\S]*response-media-text[\s\S]*Rule matrix[\s\S]*Spot missing rules/);
      expect(html).toMatch(/Bulk editing[\s\S]*Update together/);
      expect(html).not.toMatch(/<p[^>]*>\s*<div/);
    }
  });
  it("preserves list numbering, nested lists, links and formatting inside cards", () => {
    const html = render('3. **Rule matrix** — Inspect [details](https://example.com/docs) and `rules.json`. *Read* [more](https://example.com/more). ![Preview](https://example.com/a.png)\n   - Keep this nested item.\n4. Plain item without an image.');
    expect(html).toContain('<ol');
    expect(html).toContain('start="3"');
    expect(html.match(/class="response-media-row"/g)).toHaveLength(1);
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toMatch(/<code[^>]*>rules.json<\/code>/);
    expect(html).toMatch(/Read<\/em> <a/);
    expect(html).toMatch(/<\/div><\/div>\s*<ul/);
    expect(html).toContain('Plain item without an image.');
    expect(html).not.toContain('— Inspect');
  });
  it.each([
    '**Gallery**\n\n![One](https://example.com/a.png) ![Two](https://example.com/b.png)',
    '**Title**\n\n---\n\n![Preview](https://example.com/a.png)',
    '- **Title**\n- ![Preview](https://example.com/a.png)',
    '**Linked image** [![Preview](https://example.com/a.png)](https://example.com/docs)',
    '| Example |\n|---|\n| **Title** ![Preview](https://example.com/a.png) |',
    'Ordinary prose.\n\n![Preview](https://example.com/a.png)',
  ])("does not invent associations for ambiguous or unrelated content: %s", (markdown) => {
    expect(render(markdown)).not.toContain('class="response-media-row"');
  });
  it("keeps large image payloads out of Markdown parsing and restores exact image sources", () => {
    const image = `data:image/png;base64,${"a".repeat(2_000_000)}=`;
    const content = `![Preview](${image}) **Title**\nDescription`;
    expect(prepareResponseMarkdown(content).markdown.length).toBeLessThan(100);
    expect(render(content)).toContain(`src="${image}"`);
  });
  it("preserves reference images, raw HTML images and literal data URL examples", () => {
    const image = "data:image/png;base64,iVBORw0KGgo=";
    const html = render(`![Reference][preview]\n\n[preview]: ${image}\n\n<img src="${image}" alt="HTML">\n\n\`${image}\`\n\nbuildwarden-embedded-image-0-end`);
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html.split(`src="${image}"`)).toHaveLength(3);
    expect(html).toContain(`${image}</code>`);
    expect(html).toContain("buildwarden-embedded-image-0-end");
    expect(render(`[Unsafe link](${image})`)).not.toContain(`href="${image}"`);
  });
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
