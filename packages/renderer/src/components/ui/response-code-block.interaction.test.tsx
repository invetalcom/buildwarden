/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { ActivityRichText } from "./activity-rich-text";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { codeBlockFromPre, diffLineKind, loadCodeParser, normalizeCodeLanguage } from "../../lib/response-code";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const render = async (content: string) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <BuildWardenClientProvider client={createElectronBuildWardenClient({} as DesktopApi)}>
      <ActivityRichText content={content} />
    </BuildWardenClientProvider>,
  ));
  return { container, root };
};

const settle = async (language: string) => {
  await loadCodeParser(language);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("response code blocks", () => {
  it.each([
    ["ts", "const answer: number = 42; // done", ["tok-keyword", "tok-number", "tok-comment"]],
    ["bash", "echo \"hi\" # greet", ["tok-string", "tok-comment"]],
    ["python", "def run():\n    return 'x'", ["tok-keyword", "tok-string"]],
  ])("highlights %s and keeps the text unchanged", async (language, code, classes) => {
    const { container, root } = await render(`\`\`\`${language}\n${code}\n\`\`\``);
    try {
      await settle(language);
      const element = container.querySelector("pre code")!;
      expect(element.textContent).toBe(code);
      for (const className of classes) expect(element.querySelector(`.${className}`), className).not.toBeNull();
      expect(container.querySelector(".response-code-language")?.textContent).toBe(language);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("copies the block without the trailing fence newline", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container, root } = await render("```\nnpm test\n```");
    try {
      expect(container.querySelector(".response-code-language")).toBeNull();
      const button = container.querySelector<HTMLButtonElement>("button[aria-label='Copy code']")!;
      await act(async () => button.click());
      expect(writeText).toHaveBeenCalledWith("npm test");
      expect(container.querySelector("button[aria-label='Copied']")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("colours diff lines by kind", async () => {
    const { container, root } = await render("```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n same\n```");
    try {
      const kinds = Array.from(container.querySelectorAll(".response-diff-line")).map((line) => line.className.replace("response-diff-line response-diff-", ""));
      expect(kinds).toEqual(["header", "header", "hunk", "removed", "added", "context"]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("renders a complete svg block as an image and an unfinished one as source", async () => {
    const { container, root } = await render("```svg\n<svg viewBox=\"0 0 1 1\"><rect width=\"1\" height=\"1\"/></svg>\n```\n\n```svg\n<svg viewBox=\"0 0 1 1\">\n```");
    try {
      const image = container.querySelector<HTMLImageElement>(".response-rendered-image img")!;
      expect(atob(image.src.split(",")[1])).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">');
      expect(container.querySelectorAll(".response-rendered-image")).toHaveLength(1);
      expect(container.querySelector("pre code")?.textContent).toBe('<svg viewBox="0 0 1 1">');
      await act(async () => container.querySelector<HTMLButtonElement>("button[aria-label='Show source']")!.click());
      expect(container.querySelectorAll("pre code")).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("leaves unknown languages and indented code as plain text", async () => {
    const { container, root } = await render("```brainfuck-ish\n++>.\n```\n\n    indented code");
    try {
      const blocks = container.querySelectorAll("pre code");
      expect(blocks).toHaveLength(2);
      expect(blocks[0].textContent).toBe("++>.");
      expect(blocks[0].querySelector("span")).toBeNull();
      expect(blocks[1].textContent).toBe("indented code");
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("response code helpers", () => {
  it("reads only fenced code from pre nodes", () => {
    const pre = { type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", properties: { className: ["language-TS"] }, children: [{ type: "text", value: "x\n" }] }] };
    expect(codeBlockFromPre(pre)).toEqual({ code: "x", language: "ts" });
    expect(codeBlockFromPre({ type: "element", tagName: "pre", children: [{ type: "text", value: "raw" }] })).toBeNull();
    const code = { type: "element", tagName: "code", children: [{ type: "text", value: "x" }] };
    expect(codeBlockFromPre({ type: "element", tagName: "pre", children: [{ type: "text", value: "before" }, code, { type: "text", value: "after" }] })).toBeNull();
    expect(codeBlockFromPre({ type: "element", tagName: "pre", children: [{ type: "text", value: "\n" }, code, { type: "text", value: " " }] })).toEqual({ code: "x", language: null });
  });
  it("renders raw <pre> with text around its code as written", async () => {
    const { container, root } = await render("<pre>before <code>x</code> after</pre>");
    try {
      expect(container.querySelector("pre")?.textContent).toBe("before x after");
      expect(container.querySelector(".response-code")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("normalizes fence names and classifies diff lines", () => {
    expect(normalizeCodeLanguage("TS title=\"x.ts\"")).toBe("ts");
    expect(normalizeCodeLanguage("  ")).toBeNull();
    expect(["+++ b/x", "--- a/x", "diff --git a/x b/x", "@@ -1 +1 @@", "+a", "-b", " c", "---"].map(diffLineKind))
      .toEqual(["header", "header", "header", "hunk", "added", "removed", "context", "header"]);
  });
});
