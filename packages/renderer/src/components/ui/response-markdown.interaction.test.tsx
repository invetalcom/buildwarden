/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { ActivityRichText } from "./activity-rich-text";
import * as preparation from "./response-markdown-preparation";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
