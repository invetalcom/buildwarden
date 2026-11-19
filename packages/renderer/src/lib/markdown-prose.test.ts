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
  it("recognizes fences that open on a list-marker line", () => {
    expect(upper("- ```tex\n  a\n  ```\nb")).toBe("- ```tex\n  a\n  ```\nB");
    expect(upper("1. ~~~\n   a\n   ~~~\n> * ```\n>   a\n>   ```\nb")).toBe("1. ~~~\n   a\n   ~~~\n> * ```\n>   a\n>   ```\nB");
    // A list item that only starts with a dash stays prose.
    expect(upper("- a ```b``` c")).toBe("- A ```b``` C");
  });
  it("ends an unclosed list or quote fence where its container ends", () => {
    // Blank lines stay inside the list item; the dedented paragraph is outside it.
    expect(upper("- ~~~\n  a\n\n  b\n\nc")).toBe("- ~~~\n  a\n\n  b\n\nC");
    expect(upper("1. ```\n   a\n  b")).toBe("1. ```\n   a\n  B");
    expect(upper("> ```\n> a\n\nb")).toBe("> ```\n> a\n\nB");
    expect(upper("> - ```\n>   a\n> b")).toBe("> - ```\n>   a\n> B");
    // Containers are checked outermost first: a quote inside a list item keeps the item's indentation.
    expect(upper("-   > ~~~\n    > a\n    > ~~~\nb")).toBe("-   > ~~~\n    > a\n    > ~~~\nB");
    expect(upper("-   > ~~~\n    > a\n    b")).toBe("-   > ~~~\n    > a\n    B");
    expect(upper("-   > ~~~\n    > a\n\n    > b")).toBe("-   > ~~~\n    > a\n\n    > B");
    // Tabs stop every 4 columns: after `-` (column 1) a tab reaches column 4, not 5.
    expect(upper("-\t~~~\n    a\n    ~~~\nb")).toBe("-\t~~~\n    a\n    ~~~\nB");
    expect(upper("-\t~~~\n\ta\n   b")).toBe("-\t~~~\n\ta\n   B");
    expect(upper(">\t- ```\n>\t  a\n>  b")).toBe(">\t- ```\n>\t  a\n>  B");
    // A container that continues keeps its explicit closing fence.
    expect(upper("- ```\n  a\n  ```\nb")).toBe("- ```\n  a\n  ```\nB");
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
