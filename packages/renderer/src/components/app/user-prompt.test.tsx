/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DESIGN_SCHEME_PRESETS, type DesignPrompt, type DesktopApi, type StoredChatAttachment } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { applyDesignSchemeToDocument } from "../../lib/design-scheme";
import { UserPrompt } from "./user-prompt";

const base = DESIGN_SCHEME_PRESETS[0]!;
const text = (value: string) => btoa(value);
const FILES: StoredChatAttachment[] = [
  { fileName: "shot.png", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" },
  { fileName: "notes.md", mimeType: "text/markdown", dataBase64: text("# Title\n\nFirst line") },
  { fileName: "bundle.zip", mimeType: "application/zip", dataBase64: text("zip") },
];

let root: Root;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  applyDesignSchemeToDocument(base, false);
});

const render = async (prompt: DesignPrompt | undefined, props: Partial<Parameters<typeof UserPrompt>[0]> = {}) => {
  applyDesignSchemeToDocument(prompt ? { ...base, id: "custom", customization: { prompt } } : base, false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(
    <UserPrompt text={<p>Redesign the title</p>} attachments={FILES} fallbackNames={["old.pdf"]} kind="follow-up" mode={<span>code</span>} time="21:50" actions={<button type="button">Copy</button>} {...props} />,
  ));
  return {
    row: container.querySelector<HTMLElement>('[data-ui="message-user-row"]')!,
    bubble: container.querySelector<HTMLElement>('[data-ui="message-user"]')!,
    files: container.querySelector<HTMLElement>('[data-ui="message-user-files"]'),
    tiles: [...container.querySelectorAll<HTMLElement>('[data-ui="message-user-file"]')],
    details: container.querySelector<HTMLElement>('[data-ui="message-user-details"]')!,
  };
};

describe("a prompt you sent", () => {
  it("shows its files as thumbnails over the bubble, each by what the file is", async () => {
    const { row, bubble, files, tiles } = await render(undefined);
    expect([...row.children].indexOf(files!)).toBeLessThan([...row.children].indexOf(bubble));
    expect(bubble.contains(files)).toBe(false);
    expect(bubble.textContent).toBe("Redesign the title");
    expect(tiles.map((tile) => tile.dataset.kind)).toEqual(["image", "text", "icon", "icon"]);

    const [picture, notes, archive, nameOnly] = tiles as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(picture.tagName).toBe("BUTTON");
    expect(picture.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64,");
    expect(picture.textContent).toBe("PNG");
    expect(notes.querySelector("pre")?.textContent).toContain("# Title");
    // A file without a preview downloads; one whose data was not kept does nothing.
    expect(archive.tagName).toBe("A");
    expect(archive.getAttribute("download")).toBe("bundle.zip");
    expect(archive.textContent).toContain("ZIP");
    expect(nameOnly.tagName).toBe("SPAN");
    expect(nameOnly.textContent).toBe("PDF");
  });

  it("opens a picture in the viewer and a text file in the preview", async () => {
    const { tiles } = await render(undefined);
    await act(async () => tiles[0]!.click());
    expect(document.body.querySelector('[role="dialog"][aria-label="shot.png"] img')).not.toBeNull();
    await act(async () => document.body.querySelector<HTMLElement>('[role="dialog"]')!.click());
    await act(async () => tiles[1]!.click());
    expect(document.body.querySelector('[role="dialog"][aria-label="notes.md"] pre')?.textContent).toBe("# Title\n\nFirst line");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("puts the files inside the bubble, as thumbnails or as names, when the theme asks for it", async () => {
    const inside = await render({ files: "inside", thumbnailLabels: false });
    expect(inside.bubble.contains(inside.files)).toBe(true);
    expect(inside.files!.dataset.layout).toBe("inside");
    expect(inside.tiles[0]!.querySelector("img")).not.toBeNull();
    expect(inside.tiles[0]!.textContent).toBe("");
    await act(() => root.unmount());
    container.remove();

    const names = await render({ files: "names" });
    expect(names.bubble.contains(names.files)).toBe(true);
    expect(names.tiles.map((tile) => tile.textContent)).toEqual(["shot.png", "notes.md", "bundle.zip", "old.pdf"]);
    expect(names.tiles[0]!.querySelector("img")).toBeNull();
  });

  it("previews a PDF where the page can embed one, and offers it as a download in the desktop window", async () => {
    const pdf: StoredChatAttachment[] = [{ fileName: "guide.pdf", mimeType: "application/pdf", dataBase64: text("%PDF-1.4") }];
    const browser = await render(undefined, { attachments: pdf, fallbackNames: [] });
    expect(browser.tiles[0]!.dataset.kind).toBe("pdf");
    expect(browser.tiles[0]!.querySelector("object")?.getAttribute("type")).toBe("application/pdf");
    await act(() => root.unmount());
    container.remove();

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(() => root.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient({} as DesktopApi)}>
        <UserPrompt text="Read this" attachments={pdf} fallbackNames={[]} time="21:50" actions={null} />
      </BuildWardenClientProvider>,
    ));
    const tile = container.querySelector<HTMLElement>('[data-ui="message-user-file"]')!;
    expect(tile.dataset.kind).toBe("icon");
    expect(tile.querySelector("object")).toBeNull();
    expect(tile.getAttribute("download")).toBe("guide.pdf");
    expect(tile.textContent).toContain("PDF");
  });

  it("collapses the files past the limit into a tile that brings them back", async () => {
    const { tiles } = await render({ filesMax: 3 });
    expect(tiles.map((tile) => tile.dataset.kind)).toEqual(["image", "text", "more"]);
    expect(tiles[2]!.textContent).toBe("+2");
    await act(async () => tiles[2]!.click());
    expect([...container.querySelectorAll<HTMLElement>('[data-ui="message-user-file"]')].map((tile) => tile.dataset.kind)).toEqual(["image", "text", "icon", "icon"]);
  });

  it("never shows more tiles than the limit, down to a single tile that stands for every file", async () => {
    const { tiles } = await render({ filesMax: 1 });
    expect(tiles.map((tile) => tile.dataset.kind)).toEqual(["more"]);
    expect(tiles[0]!.textContent).toBe("+4");
    await act(async () => tiles[0]!.click());
    expect(container.querySelectorAll('[data-ui="message-user-file"]')).toHaveLength(4);
  });

  it("leaves the bubble empty for a prompt that only carries files", async () => {
    const { bubble, tiles } = await render(undefined, { text: null });
    expect(bubble.childNodes).toHaveLength(0);
    expect(tiles).toHaveLength(4);
  });

  it("shows the details the theme lists, in its order, followed by the buttons", async () => {
    const all = await render(undefined);
    expect(all.details.textContent).toBe("follow-upcode21:50Copy");
    await act(() => root.unmount());
    container.remove();
    const some = await render({ detailItems: ["time", "kind"] });
    expect(some.details.textContent).toBe("21:50follow-upCopy");
  });

  it("limits a long prompt to the lines the theme allows", async () => {
    const full = await render(undefined);
    expect(full.bubble.querySelector(".user-prompt-text")?.hasAttribute("data-clamped")).toBe(false);
    await act(() => root.unmount());
    container.remove();
    const clamped = await render({ clampLines: 4 });
    expect(clamped.bubble.querySelector<HTMLElement>(".user-prompt-text")?.dataset.clamped).toBe("fits");
  });
});
