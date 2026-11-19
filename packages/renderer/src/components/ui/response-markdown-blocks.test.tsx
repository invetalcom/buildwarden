import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MIN_SPLIT_MARKDOWN_LENGTH, splitResponseMarkdownBlocks } from "./response-markdown-blocks";
import { ResponseMarkdownBlock, ResponseMarkdownBody } from "./response-markdown-body";

const fill = (text: string) => `${"Padding paragraph with **bold** and `code`.\n\n".repeat(Math.ceil(MIN_SPLIT_MARKDOWN_LENGTH / 40))}${text}`;

const FIXTURES: Record<string, string> = {
  mixed: [
    "# Summary", "",
    "Intro paragraph with a [link](https://example.com), `inline <div>` code and <https://example.org>.", "",
    "```tsx", "const view = <div className=\"x\" />;", "", "", "export default view;", "```", "",
    "- tight one", "- tight two", "  - nested", "", "- loose after blank", "",
    "1. first", "", "   continued paragraph in the first item", "", "2. second", "",
    "Paragraph between lists.", "", "3. third starts a new list", "",
    "| a | b |", "|---|---|", "| 1 | 2 |", "",
    "> quote one", "", "> quote two", "",
    "---", "",
    "- [ ] task", "- [x] done", "",
    "Setext heading", "==============", "",
    "    indented code", "", "    more indented code", "",
    "~~~", "```", "", "still code", "~~~", "",
    "Final ~~strike~~ text.",
  ].join("\n"),
  longFence: ["Text before.", "", "````md", "```js", "", "inner();", "```", "", "````", "", "After the fence."].join("\n"),
  unclosedFence: ["Streaming text.", "", "```python", "def f():", "", "    return 1"].join("\n"),
  orderedAfterParagraph: ["Steps:", "", "4. four", "", "Note.", "", "5. five", "", "Done."].join("\n"),
};

const render = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("response Markdown blocks", () => {
  it("keeps short responses whole", () => {
    expect(splitResponseMarkdownBlocks("One.\n\nTwo.")).toBeNull();
  });

  it.each(Object.entries(FIXTURES))("splits %s losslessly and renders it exactly as one document", (_name, fixture) => {
    const content = fill(fixture);
    const blocks = splitResponseMarkdownBlocks(content);
    expect(blocks?.length).toBeGreaterThan(3);
    expect(blocks?.join("")).toBe(content);
    expect(render(<ResponseMarkdownBody content={content} components={{}} />))
      .toBe(render(<ResponseMarkdownBlock content={content} components={{}} />));
  });

  it("does not cut inside fences, lists, or indented content", () => {
    const blocks = splitResponseMarkdownBlocks(fill(FIXTURES.mixed)) ?? [];
    const blockWith = (text: string) => blocks.find((block) => block.includes(text));
    expect(blockWith("```tsx")).toContain("export default view;\n```");
    expect(blockWith("- tight one")).toContain("- loose after blank");
    expect(blockWith("1. first")).toContain("2. second");
    expect(blockWith("    indented code")).toContain("more indented code");
    expect(blockWith("~~~")).toContain("still code\n~~~");
  });

  it.each([
    ["a link reference definition", "See [docs][d].\n\n[d]: https://example.com"],
    ["a link reference definition in a block quote", "See [docs][d].\n\n> [d]: https://example.com"],
    ["a link reference definition in a list item", "See [docs][d].\n\n- [d]: https://example.com"],
    ["a link reference definition with a wrapped label", "See [docs\nlabel][].\n\n[docs\nlabel]: https://example.com"],
    ["a footnote", "Claim.[^1]\n\n[^1]: Source."],
    ["an image", "### Title\n\n![Preview](https://example.com/a.png)"],
    ["raw HTML", "<details>\n\n**Hidden**\n\n</details>"],
    ["inline HTML", "Text <b>bold\n\nstill bold</b>"],
  ])("renders text with %s as one document", (_name, fixture) => {
    const content = fill(fixture);
    expect(splitResponseMarkdownBlocks(content)).toBeNull();
    expect(render(<ResponseMarkdownBody content={content} components={{}} />))
      .toBe(render(<ResponseMarkdownBlock content={content} components={{}} />));
  });

  it("still splits text that mentions a definition-like colon only inside code", () => {
    const content = fill("Type `Record<string, number>` as `{ [key: string]: number }`.\n\n```ts\nconst map: { [key: string]: number } = {};\n```\n\nDone.");
    expect(splitResponseMarkdownBlocks(content)).not.toBeNull();
  });
});
