/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AttachmentBlobResult, DesktopApi, StoredChatAttachment } from "@buildwarden/shared";
import { StoredChatAttachments } from "./StoredChatAttachments";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { resetStoredAttachmentCache } from "../../lib/stored-attachment-data";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const blobId = "a".repeat(64);
const stored: StoredChatAttachment = { fileName: "notes.txt", mimeType: "text/plain", blobId, byteLength: 11 };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const mount = async (getAttachmentBlob: DesktopApi["getAttachmentBlob"], attachments: StoredChatAttachment[] = [stored]) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = createElectronBuildWardenClient({ getAttachmentBlob } as DesktopApi);
  await act(() => root.render(<BuildWardenClientProvider client={client}><StoredChatAttachments attachments={attachments} /></BuildWardenClientProvider>));
};

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  resetStoredAttachmentCache();
});

it("loads a stored file once it is shown and renders its preview", async () => {
  let finish!: (result: AttachmentBlobResult | null) => void;
  const getAttachmentBlob = vi.fn(() => new Promise<AttachmentBlobResult | null>((resolve) => { finish = resolve; }));
  await mount(getAttachmentBlob);

  expect(container.textContent).toContain("Loading");
  expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  await act(async () => finish({ blobId, dataBase64: btoa("hello notes") }));

  expect(getAttachmentBlob).toHaveBeenCalledExactlyOnceWith(blobId);
  expect(container.querySelector("pre")?.textContent).toBe("hello notes");
  expect(container.querySelector("a[download='notes.txt']")?.getAttribute("href")).toMatch(/^(blob:|data:)/);
});

it("shares one load between components that show the same file", async () => {
  const getAttachmentBlob = vi.fn(async () => ({ blobId, dataBase64: btoa("hello notes") }));
  await mount(getAttachmentBlob, [stored, { ...stored, fileName: "copy.txt" }]);

  expect(getAttachmentBlob).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll("pre")).toHaveLength(2);
});

it("marks a file the host no longer has as unavailable", async () => {
  await mount(vi.fn(async () => null));

  expect(container.textContent).toContain("Unavailable");
  expect(container.querySelector("a[download]")).toBeNull();
});

it("renders inline attachments without loading anything", async () => {
  const getAttachmentBlob = vi.fn(async () => null);
  await mount(getAttachmentBlob, [{ fileName: "inline.txt", mimeType: "text/plain", dataBase64: btoa("inline text") }]);

  expect(getAttachmentBlob).not.toHaveBeenCalled();
  expect(container.querySelector("pre")?.textContent).toBe("inline text");
});
