import { describe, expect, it } from "vitest";
import { mapMarkdownProse } from "./markdown-prose";

const upper = (markdown: string) => mapMarkdownProse(markdown, (prose) => prose.toUpperCase());

describe("mapMarkdownProse", () => {
  it("skips fenced blocks, including ones inside quotes and lists, and keeps everything else", () => {
    expect(upper("a\n```ts\nconst b = 1;\n```\nc\n")).toBe("A\n```ts\nconst b = 1;\n```\nC\n");
    expect(upper("~~~~\n~~~\nx\n~~~~\ny")).toBe("~~~~\n~~~\nx\n~~~~\nY");
    expect(upper("> ```\n> x\n> ```\nz")).toBe("> ```\n> x\n> ```\nZ");
    expect(upper("1. item\n   ```\n   x\n   ```\n2. next")).toBe("1. ITEM\n   ```\n   x\n   ```\n2. NEXT");
  });
  it("treats an unclosed fence as code to the end, as while streaming", () => {
    expect(upper("a\n```\nb\nc")).toBe("A\n```\nb\nc");
  });
  it("skips inline code spans of any length, but not unmatched backticks", () => {
    expect(upper("a `b` c ``d ` e`` f")).toBe("A `b` C ``d ` e`` F");
    expect(upper("a ` b")).toBe("A ` B");
    expect(upper("a ```inline``` b")).toBe("A ```inline``` B");
  });
  it("preserves CRLF line endings", () => {
    expect(upper("a\r\n```\r\nb\r\n```\r\nc")).toBe("A\r\n```\r\nb\r\n```\r\nC");
  });
});
