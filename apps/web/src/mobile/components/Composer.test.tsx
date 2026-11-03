/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { BuildWardenClientProvider, useComposerDraft, type BuildWardenClient } from "@buildwarden/renderer";

const DraftComposer = (props: Omit<Parameters<typeof Composer>[0], "draft">) => {
  const draft = useComposerDraft("chat", "test-chat");
  return <Composer {...props} draft={draft} />;
};
const TestComposer = (props: Omit<Parameters<typeof Composer>[0], "draft">) => (
  <BuildWardenClientProvider client={{ draftScopeId: crypto.randomUUID() } as BuildWardenClient}>
    <DraftComposer {...props} />
  </BuildWardenClientProvider>
);

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("mobile composer attachments", () => {
  it.each(["success", "failure"])("keeps a pending send locked across remounts and releases after %s", async (outcome) => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve, reject) => { finish = () => outcome === "success" ? resolve() : reject(new Error("Offline")); });
    const onSubmit = vi.fn(() => pending);
    const client = { draftScopeId: crypto.randomUUID() } as BuildWardenClient;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    const render = () => root.render(<BuildWardenClientProvider client={client}><DraftComposer placeholder="Message" onSubmit={onSubmit} hasExternalAttachments /></BuildWardenClientProvider>);
    await act(render);
    await act(async () => (container.querySelector('button[aria-label="Send"]') as HTMLButtonElement).click());
    expect(onSubmit).toHaveBeenCalledOnce();
    await act(() => root.render(null));
    await act(render);
    const send = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await act(async () => send.click());
    expect(onSubmit).toHaveBeenCalledOnce();
    await act(async () => { finish(); await pending.catch(() => undefined); });
    expect(send.disabled).toBe(false);
    onSubmit.mockResolvedValue();
    await act(async () => send.click());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("allows selected browser context without typed text and retains it on a failed send", async () => {
    const onSubmit = vi.fn(async () => { throw new Error("Host disconnected"); });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    await act(async () => root.render(<TestComposer placeholder="Message" onSubmit={onSubmit} hasExternalAttachments accessory={<span>Selected button</span>} />));
    const send = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(onSubmit).toHaveBeenCalledWith("", []);
    expect(container.textContent).toContain("Host disconnected");
    expect(container.textContent).toContain("Selected button");
  });
  it("submits an attachment-only prompt as a base64 payload", async () => {
    let resolveSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => { resolveSubmitted = resolve; });
    const onSubmit = vi.fn(async () => resolveSubmitted());
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });

    await act(async () => root.render(<TestComposer placeholder="Message" onSubmit={onSubmit} />));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    expect(container.textContent).toContain("hello.txt");
    const send = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.click();
      await submitted;
    });

    expect(onSubmit).toHaveBeenCalledWith("", [{ fileName: "hello.txt", mimeType: "text/plain", dataBase64: "aGVsbG8=" }]);
    expect(container.textContent).not.toContain("hello.txt");
  });
});
