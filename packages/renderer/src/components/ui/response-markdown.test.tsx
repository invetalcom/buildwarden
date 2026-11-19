import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { ActivityRichText } from "./activity-rich-text";
import { prepareResponseMarkdown } from "./response-markdown-preparation";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";

const render = (content: string) => renderToStaticMarkup(<BuildWardenClientProvider client={createElectronBuildWardenClient({} as DesktopApi)}><ActivityRichText content={content} /></BuildWardenClientProvider>);

describe("rich responses", () => {
  it("keeps inline HTML formatting models use, without attributes that could run code", () => {
    const html = render('Press <kbd>Ctrl</kbd>+<kbd>C</kbd>, <mark onclick="x()">note</mark> <u style="color:red">this</u>, <abbr title="Pull request" onmouseover="x()">PR</abbr>');
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<mark>note</mark>");
    expect(html).toContain("<u>this</u>");
    expect(html).toContain('<abbr title="Pull request">PR</abbr>');
    expect(html).not.toMatch(/onclick|onmouseover|style=/);
  });
  it.each([
    ["marker on its own line", "> [!WARNING]\n> Back up the database first.", "Warning"],
    ["marker followed by a blank quote line", "> [!tip]\n>\n> Back up the database first.", "Tip"],
  ])("renders GitHub alerts with a %s", (_name, markdown, title) => {
    const html = render(markdown);
    expect(html).toContain(`class="response-alert response-alert-${title.toLowerCase()}"`);
    expect(html).toMatch(new RegExp(`<div class="response-alert-title"[^>]*>${title}</div>`));
    expect(html).toContain("Back up the database first.");
    expect(html).not.toContain("[!");
    expect(html).not.toContain("<blockquote");
  });
  it("leaves ordinary quotes and unknown markers as quotes", () => {
    for (const markdown of ["> Plain quote", "> [!SUCCESS]\n> Not a GitHub alert", "> Text [!NOTE] later"]) {
      const html = render(markdown);
      expect(html).toContain("<blockquote");
      expect(html).not.toContain("response-alert");
    }
  });
  it("shows inline SVG as an image of itself, never as live markup", () => {
    const html = render('Logo: <svg viewBox="0 0 2 2"><title>Logo</title><script>alert(1)</script><text>Label</text></svg> done\n\n`<svg><text>code</text></svg>`');
    const src = /<img[^>]*src="(data:image\/svg\+xml;base64,[^"]+)"/.exec(html)?.[1];
    expect(src).toBeTruthy();
    const svg = atob(src!.split(",")[1]);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 2 2">/);
    expect(html).toContain('alt="Logo"');
    expect(html).not.toMatch(/<svg|<script|<text>Label/);
    expect(html).toMatch(/<code[^>]*>&lt;svg&gt;&lt;text&gt;code&lt;\/text&gt;&lt;\/svg&gt;<\/code>/);
  });
  it("keeps nested SVG inside its outer root and sibling SVGs apart", () => {
    const html = render('<svg viewBox="0 0 2 2"><svg><rect/></svg><text>outer</text></svg> and <svg><circle r="1"/></svg>');
    const sources = [...html.matchAll(/src="data:image\/svg\+xml;base64,([^"]+)"/g)].map((match) => atob(match[1]));
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatch(/<svg[^>]*><svg><rect\/><\/svg><text>outer<\/text><\/svg>$/);
    expect(sources[1]).toMatch(/<circle r="1"\/><\/svg>$/);
    expect(html).not.toMatch(/outer<\/text>|<\/svg>/);
  });
  it("shows SVG data images but still rejects HTML data and other protocols", () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(render(`![Chart](data:image/svg+xml;base64,${svg})`)).toContain(`src="data:image/svg+xml;base64,${svg}"`);
    expect(render("![Chart](data:image/svg+xml;utf8,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E)")).toContain("<img");
    for (const markdown of [`![x](data:text/html;base64,${svg})`, "![x](javascript:alert(1))", "![x](file:///etc/passwd)"]) {
      expect(render(markdown)).not.toContain("<img");
    }
  });
  it.each([
    ["dollars", "Inline $E=mc^2$ and\n\n$$\n\\int_0^1 x\\,dx\n$$"],
    ["backslash delimiters", "Inline \\(E=mc^2\\) and\n\\[\n\\int_0^1 x\\,dx\n\\]"],
    ["a math fence", "Inline $$E=mc^2$$ and\n\n```math\n\\int_0^1 x\\,dx\n```"],
  ])("renders math written with %s", (_name, markdown) => {
    const html = render(markdown);
    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html.match(/class="katex-display"/g)).toHaveLength(1);
    expect(html).toMatch(/<annotation encoding="application\/x-tex">\\int_0\^1 x\\,dx\s*<\/annotation>/);
    expect(html).not.toContain("katex-error");
    expect(html).not.toContain("response-code");
  });
  it("keeps math delimiters literal in a code fence that opens on a list-marker line", () => {
    const html = render("- ```tex\n  \\(a^2\\)\n  ```");
    expect(html).toMatch(/<code[^>]*>\\\(a\^2\\\)<\/code>/);
    expect(html).not.toContain("katex");
  });
  it("leaves prices, code and untrusted KaTeX commands harmless", () => {
    const html = render("From $5 to $10. `$x$`\n\n```\n$y$\n```\n\n$$\\href{javascript:alert(1)}{x}$$");
    expect(html).toContain("From $5 to $10.");
    expect(html).toMatch(/<code[^>]*>\$x\$<\/code>/);
    expect(html).toContain("$y$");
    expect(html).not.toMatch(/href="javascript|<a[^>]*katex/);
  });
  it("turns emoji shortcodes into emoji outside code and leaves unknown ones and times alone", () => {
    const html = render("Done :rocket: :white_check_mark: :not_an_emoji: at 10:30:00\n\n`:rocket:`\n\n$$a:b:c$$");
    expect(html).toContain("Done 🚀 ✅ :not_an_emoji: at 10:30:00");
    expect(html).toMatch(/<code[^>]*>:rocket:<\/code>/);
  });
  it("styles every heading level apart from body text", () => {
    const html = render("#### Four\n\n##### Five\n\n###### Six\n\nBody");
    for (const level of [4, 5, 6]) expect(html).toMatch(new RegExp(`<h${level} class="[^"]*font-semibold`));
  });
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
    // SVG data is allowed: it is only ever shown through <img>, where it cannot run scripts.
    expect(html).not.toMatch(/<script|onerror=|src="(?:data:(?!image\/svg\+xml;base64,)|file:|javascript:)|<form|type="radio"|style=|class="response-media-row"/);
    expect(html).toContain('Image unavailable');
  });
});
