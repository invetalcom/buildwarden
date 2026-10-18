/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { ActivityRichText } from "./activity-rich-text";
import { ResponseImage } from "./response-image";
import * as preparation from "./response-markdown-preparation";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("retains the reserved preview frame on failure and recovers when its source changes", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ResponseImage src="https://example.com/first.png" alt="Preview" />));
    expect(container.querySelector("img")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => container.querySelector("img")?.dispatchEvent(new Event("error")));
    const fallback = container.querySelector('[role="img"]');
    expect(fallback?.classList.contains("response-image-button")).toBe(true);
    expect(fallback?.textContent).toContain("image unavailable");
    expect(container.querySelector("button")).toBeNull();

    await act(async () => root.render(<ResponseImage src="https://example.com/second.png" alt="Preview" />));
    expect(container.querySelector("img")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/second.png");
    expect(container.querySelector("button.response-image-button")).not.toBeNull();
    expect(container.querySelector('[role="img"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("requires approval for each external URL and keeps embedded images automatic", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    for (const url of ["https://example.com/image?d=first", "https://example.com/image?d=second", "http://example.net/image"]) {
      await act(() => root.render(<ResponseImage src={url} alt="Preview" />));
      expect(container.querySelector("img, [src], [srcset]")).toBeNull();
      expect(container.textContent).toContain("Load image from");
      await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
      expect(container.querySelector("img")?.getAttribute("src")).toBe(url);
      expect(container.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
    }
    await act(() => root.render(<ResponseImage src="data:image/png;base64,AAAA" alt="Embedded" />));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  } finally { await act(() => root.unmount()); }
});

it("does not reparse unchanged image responses on composer updates but renders new output", async () => {
  const prepare = vi.spyOn(preparation, "prepareResponseMarkdown");
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = createElectronBuildWardenClient({} as DesktopApi);
  const openFile = vi.fn();
  const image = "![Preview](data:image/png;base64,iVBORw0KGgo=)";
  const render = async (draft: string, content = image) => {
    await act(async () => root.render(<BuildWardenClientProvider client={client}>
      <ActivityRichText content={content} onOpenWorkspaceFile={openFile} />
      <textarea value={draft} readOnly />
    </BuildWardenClientProvider>));
  };
  try {
    await render("");
    const originalImage = container.querySelector("img");
    expect(originalImage).not.toBeNull();
    await render("Follow");
    await render("Follow up");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")).toBe(originalImage);
    await render("Follow up", `${image}\n\nNew response`);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("New response");
  } finally {
    await act(async () => root.unmount());
    prepare.mockRestore();
  }
});
