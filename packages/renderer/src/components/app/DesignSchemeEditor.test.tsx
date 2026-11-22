/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDesignSchemePreset } from "@buildwarden/shared";
import { DesignSchemeEditor } from "./DesignSchemeEditor";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DesignSchemeEditor", () => {
  it("resets a predefined scheme to its original palette", async () => {
    const scheme = getDesignSchemePreset("crimson-grove")!;
    const onChange = vi.fn(async () => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<DesignSchemeEditor scheme={scheme} busy={false} onChange={onChange} />));
    const resetButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Reset to stock theme"));

    expect(resetButton).toBeTruthy();
    await act(async () => resetButton?.click());
    expect(onChange).toHaveBeenCalledWith(scheme);
  });

  it("downloads an attached theme file before revoking its URL", async () => {
    vi.useFakeTimers();
    const scheme = getDesignSchemePreset("midnight-blue")!;
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:theme");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(document.body.contains(this)).toBe(true);
      expect(this.download).toBe("midnight-blue.buildwarden-theme.json");
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<DesignSchemeEditor scheme={scheme} busy={false} onChange={vi.fn()} />));
    const exportButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Export theme"));
    await act(async () => exportButton?.click());

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[href="blob:theme"]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => vi.runAllTimers());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:theme");
  });

  it("shows export validation errors inline", async () => {
    const scheme = {
      ...getDesignSchemePreset("midnight-blue")!,
      colors: { ...getDesignSchemePreset("midnight-blue")!.colors, primary: "invalid" },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<DesignSchemeEditor scheme={scheme} busy={false} onChange={vi.fn()} />));
    const exportButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Export theme"));
    await act(async () => exportButton?.click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("invalid or incomplete colors");
  });

  const mount = async (scheme = getDesignSchemePreset("midnight-blue")!, onChange = vi.fn(async () => undefined)) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<DesignSchemeEditor scheme={scheme} busy={false} onChange={onChange} />));
    return { scheme, onChange, container };
  };
  const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((entry) => entry.textContent?.includes(label))!;

  it("previews an element color on the window, saves it on apply, and keeps hidden inputs positioned", async () => {
    const { onChange, container: host } = await mount();
    expect([...host.querySelectorAll("input.sr-only")].every((input) => input.parentElement?.classList.contains("relative"))).toBe(true);
    expect((button(host, "Apply custom scheme") as HTMLButtonElement).disabled).toBe(true);

    await type(host.querySelector<HTMLInputElement>('input[aria-label="Sidebar background"]')!, "#101820CC");
    expect(document.getElementById("buildwarden-design-custom")?.textContent).toContain('[data-ui="sidebar"]{background:#101820cc !important}');

    await act(async () => button(host, "Apply custom scheme").click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "custom", customization: { elements: { sidebar: { background: "#101820cc" } } } }));
  });

  it("previews a chosen indicator look on the window, saves it on apply, and takes an unsaved one back", async () => {
    const { onChange, container: host } = await mount();
    expect(document.documentElement.dataset.indSpinner).toBeUndefined();

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Spinner style"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === "Dots")!.click());
    expect(document.documentElement.dataset.indSpinner).toBe("dots");
    expect(document.body.dataset.indSpinner).toBe("dots");

    await act(async () => button(host, "Apply custom scheme").click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "custom", customization: { indicators: { spinner: "dots" } } }));

    // The saved design is still the stock one here, so leaving the editor removes the preview.
    await act(async () => root?.unmount());
    root = null;
    expect(document.documentElement.dataset.indSpinner).toBeUndefined();
  });

  it("does not bring a theme image back that was still being read when the draft was discarded", async () => {
    let finishRead: () => void = () => undefined;
    vi.stubGlobal("FileReader", class {
      result = "data:application/octet-stream;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { finishRead = () => this.onload?.(); }
    });
    const { onChange, container: host } = await mount();
    const customCss = () => document.getElementById("buildwarden-design-custom")?.textContent ?? "";
    const add = host.querySelector<HTMLInputElement>('input[aria-label="Add theme image"]')!;
    const pick = async (name: string) => {
      Object.defineProperty(add, "files", { value: [new File(["x"], name)], configurable: true });
      await act(async () => { add.dispatchEvent(new Event("change", { bubbles: true })); });
    };

    // Something else is changed, so there is a draft to discard.
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Spinner style"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === "Dots")!.click());
    await pick("late.svg");
    await act(async () => button(host, "Discard").click());
    await act(async () => { finishRead(); await Promise.resolve(); });
    expect(customCss()).not.toContain("--bw-asset-late");
    expect((button(host, "Apply custom scheme") as HTMLButtonElement).disabled).toBe(true);

    // An image read within the draft it was chosen for is added and saved.
    await pick("kept.svg");
    await act(async () => { finishRead(); await Promise.resolve(); });
    expect(customCss()).toContain("--bw-asset-kept");
    await act(async () => button(host, "Apply custom scheme").click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ customization: { assets: { kept: expect.objectContaining({ type: "image/svg+xml" }) } } }));
    vi.unstubAllGlobals();
  });

  it("restores the saved design when the editor closes with unsaved changes", async () => {
    const { container: host } = await mount();
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Cards background"]')!, "#223344");
    expect(document.getElementById("buildwarden-design-custom")).not.toBeNull();

    await act(async () => root?.unmount());
    root = null;
    expect(document.getElementById("buildwarden-design-custom")).toBeNull();
  });

  it("refuses custom css that could load remote files", async () => {
    const { onChange, container: host } = await mount();
    await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Custom CSS"]')!, "body { background: url(https://example.com/a.png) }");

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("cannot load files");
    expect((button(host, "Apply custom scheme") as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("buildwarden-design-custom")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers to undo the last change an agent made", async () => {
    const previous = getDesignSchemePreset("ocean-mint")!;
    const onChange = vi.fn(async () => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<DesignSchemeEditor scheme={getDesignSchemePreset("midnight-blue")!} busy={false} onChange={onChange} previousScheme={previous} />));

    await act(async () => button(container!, "Undo agent changes").click());
    expect(onChange).toHaveBeenCalledWith(previous);
  });

  it("puts the saved background image back when a draft image is discarded", async () => {
    const saved = { ...getDesignSchemePreset("midnight-blue")!, id: "custom", customization: { background: { image: "bg-0000000000000001" } } };
    const savedImage = { token: "bg-0000000000000001", mimeType: "image/png" as const, data: "AAAA" };
    const store = { get: vi.fn(async () => savedImage), set: vi.fn(async () => "bg-0000000000000002") };
    vi.stubGlobal("FileReader", class {
      result = "data:image/png;base64,BBBBBBBB";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => "blob:size-" + String((blob as Blob).size));
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<DesignSchemeEditor scheme={saved} busy={false} onChange={vi.fn()} backgroundImageStore={store} />));

    const picker = container.querySelector<HTMLInputElement>('input[aria-label="Choose background image"]')!;
    const file = new File([new Uint8Array([1])], "draft.png", { type: "image/png" });
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(store.set).toHaveBeenCalledWith({ mimeType: "image/png", data: "BBBBBBBB" });
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-6");

    const discard = [...container.querySelectorAll("button")].find((button) => button.textContent === "Discard");
    await act(async () => discard?.click());
    await act(async () => { await Promise.resolve(); });
    expect(store.get).toHaveBeenCalled();
    expect(store.set).toHaveBeenLastCalledWith(null);
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-3");
    vi.unstubAllGlobals();
  });

  it("keeps a newly chosen image when an earlier read of the saved image finishes late", async () => {
    const saved = { ...getDesignSchemePreset("midnight-blue")!, id: "custom", customization: { background: { image: "bg-0000000000000001" } } };
    let finishRead: (image: { token: string; mimeType: "image/png"; data: string }) => void = () => undefined;
    let uploads = 0;
    const store = {
      get: vi.fn(() => new Promise<{ token: string; mimeType: "image/png"; data: string }>((resolve) => { finishRead = resolve; })),
      // Each stored image gets its own token, as on the host.
      set: vi.fn(async (image: unknown) => (image ? `bg-000000000000001${String(uploads += 1)}` : null)),
    };
    let nextFile = "data:image/png;base64,BBBBBBBB";
    vi.stubGlobal("FileReader", class {
      result = nextFile;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => "blob:size-" + String((blob as Blob).size));
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<DesignSchemeEditor scheme={saved} busy={false} onChange={vi.fn()} backgroundImageStore={store} />));
    const picker = container.querySelector<HTMLInputElement>('input[aria-label="Choose background image"]')!;
    const choose = async () => {
      Object.defineProperty(picker, "files", { value: [new File([new Uint8Array([1])], "draft.png", { type: "image/png" })], configurable: true });
      await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
      await act(async () => { await Promise.resolve(); });
    };

    await choose();
    const discard = [...container.querySelectorAll("button")].find((button) => button.textContent === "Discard");
    await act(async () => discard?.click());
    expect(store.get).toHaveBeenCalledOnce();

    // A second image is chosen before the read of the saved one comes back.
    nextFile = "data:image/png;base64,CCCCCCCCCCCC";
    await choose();
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-9");

    await act(async () => { finishRead({ token: "bg-0000000000000001", mimeType: "image/png", data: "AAAA" }); await Promise.resolve(); });
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-9");
    vi.unstubAllGlobals();
  });

  it("does not show an image whose upload finishes after the editor was left", async () => {
    const saved = getDesignSchemePreset("midnight-blue")!;
    let finishUpload: (token: string) => void = () => undefined;
    const store = {
      get: vi.fn(async () => null),
      set: vi.fn((image: unknown) => (image ? new Promise<string>((resolve) => { finishUpload = resolve; }) : Promise.resolve(null))),
    };
    vi.stubGlobal("FileReader", class {
      result = "data:image/png;base64,DDDDDDDDDDDDDDDD";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => "blob:size-" + String((blob as Blob).size));
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<DesignSchemeEditor scheme={saved} busy={false} onChange={vi.fn()} backgroundImageStore={store} />));

    const picker = container.querySelector<HTMLInputElement>('input[aria-label="Choose background image"]')!;
    Object.defineProperty(picker, "files", { value: [new File([new Uint8Array([1])], "draft.png", { type: "image/png" })], configurable: true });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(store.set).toHaveBeenCalledWith({ mimeType: "image/png", data: "DDDDDDDDDDDDDDDD" });

    // The editor is left while the upload is still under way.
    await act(async () => root?.unmount());
    root = null;
    expect(store.set).toHaveBeenLastCalledWith(null);
    await act(async () => { finishUpload("bg-00000000000000dd"); await Promise.resolve(); });
    expect(document.body.style.getPropertyValue("--bw-bg-image")).not.toContain("blob:size-12");
    vi.unstubAllGlobals();
  });

  it("shows the saved image again and releases the draft's image when the saved design changes under a draft", async () => {
    const saved = { ...getDesignSchemePreset("midnight-blue")!, id: "custom", customization: { background: { image: "bg-00000000000000a1" } } };
    const store = {
      get: vi.fn(async () => ({ token: "bg-00000000000000a1", mimeType: "image/png" as const, data: "AAAA" })),
      set: vi.fn(async (image: unknown) => (image ? "bg-00000000000000b2" : null)),
    };
    vi.stubGlobal("FileReader", class {
      result = "data:image/png;base64,BBBBBBBB";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => "blob:size-" + String((blob as Blob).size));
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<DesignSchemeEditor scheme={saved} busy={false} onChange={vi.fn()} backgroundImageStore={store} />));

    const picker = container.querySelector<HTMLInputElement>('input[aria-label="Choose background image"]')!;
    Object.defineProperty(picker, "files", { value: [new File([new Uint8Array([1])], "draft.png", { type: "image/png" })], configurable: true });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-6");
    const apply = () => [...container!.querySelectorAll("button")].find((button) => button.textContent === "Apply custom scheme");
    expect(apply()?.disabled).toBe(false);

    // An agent changes a color: the saved design is a new object with the same image.
    const changed = { ...saved, colors: { ...saved.colors, primary: "#ff8800" } };
    await act(async () => root?.render(<DesignSchemeEditor scheme={changed} busy={false} onChange={vi.fn()} backgroundImageStore={store} />));
    await act(async () => { await Promise.resolve(); });

    expect(apply()?.disabled).toBe(true);
    expect(store.set).toHaveBeenLastCalledWith(null);
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-3");
    vi.unstubAllGlobals();
  });

  it("puts the saved image back when the editor is left before a discard's read of it finished", async () => {
    const saved = { ...getDesignSchemePreset("midnight-blue")!, id: "custom", customization: { background: { image: "bg-00000000000000a1" } } };
    const savedImage = { token: "bg-00000000000000a1", mimeType: "image/png" as const, data: "AAAA" };
    const reads: Array<(image: typeof savedImage) => void> = [];
    const store = {
      get: vi.fn(() => new Promise<typeof savedImage>((resolve) => { reads.push(resolve); })),
      set: vi.fn(async (image: unknown) => (image ? "bg-00000000000000b2" : null)),
    };
    vi.stubGlobal("FileReader", class {
      result = "data:image/png;base64,BBBBBBBB";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => "blob:size-" + String((blob as Blob).size));
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<DesignSchemeEditor scheme={saved} busy={false} onChange={vi.fn()} backgroundImageStore={store} />));

    const picker = container.querySelector<HTMLInputElement>('input[aria-label="Choose background image"]')!;
    Object.defineProperty(picker, "files", { value: [new File([new Uint8Array([1])], "draft.png", { type: "image/png" })], configurable: true });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-6");

    const discard = [...container.querySelectorAll("button")].find((button) => button.textContent === "Discard");
    await act(async () => discard?.click());
    expect(reads).toHaveLength(1);

    // The editor is left while the read of the saved image is still under way.
    await act(async () => root?.unmount());
    root = null;
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-6");
    await act(async () => { for (const finish of reads) finish(savedImage); await Promise.resolve(); });
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-3");
    vi.unstubAllGlobals();
  });

  it("still puts the saved image back when an upload started after a discard fails", async () => {
    const saved = { ...getDesignSchemePreset("midnight-blue")!, id: "custom", customization: { background: { image: "bg-00000000000000a1" } } };
    const savedImage = { token: "bg-00000000000000a1", mimeType: "image/png" as const, data: "AAAA" };
    let finishRead: (image: typeof savedImage) => void = () => undefined;
    let uploads = 0;
    const store = {
      get: vi.fn(() => new Promise<typeof savedImage>((resolve) => { finishRead = resolve; })),
      // The first upload is stored, the second one fails.
      set: vi.fn(async (image: unknown) => {
        if (!image) return null;
        uploads += 1;
        if (uploads > 1) throw new Error("The disk is full.");
        return "bg-00000000000000b2";
      }),
    };
    vi.stubGlobal("FileReader", class {
      result = "data:image/png;base64,BBBBBBBB";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => "blob:size-" + String((blob as Blob).size));
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<DesignSchemeEditor scheme={saved} busy={false} onChange={vi.fn()} backgroundImageStore={store} />));
    const picker = container.querySelector<HTMLInputElement>('input[aria-label="Choose background image"]')!;
    const choose = async () => {
      Object.defineProperty(picker, "files", { value: [new File([new Uint8Array([1])], "draft.png", { type: "image/png" })], configurable: true });
      await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
      await act(async () => { await Promise.resolve(); });
    };

    await choose();
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-6");
    const discard = [...container.querySelectorAll("button")].find((button) => button.textContent === "Discard");
    await act(async () => discard?.click());

    // A second upload starts before the read of the saved image came back, and fails.
    await choose();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The disk is full.");
    await act(async () => { finishRead(savedImage); await Promise.resolve(); });
    expect(document.body.style.getPropertyValue("--bw-bg-image")).toContain("blob:size-3");
    vi.unstubAllGlobals();
  });

  describe("background image in exported themes", () => {
    const withImage = { ...getDesignSchemePreset("midnight-blue")!, id: "custom", name: "Night", customization: { background: { image: "bg-00000000000000a1", dim: 0.2 } } };
    const stored = { token: "bg-00000000000000a1", mimeType: "image/png" as const, data: "AAAA" };
    const exportedText = async (blob: Blob) => JSON.parse(await blob.text()) as { backgroundImage?: unknown; scheme: { customization?: { background?: { image?: string } } } };
    const mountWith = async (scheme: typeof withImage, store?: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }) => {
      const onChange = vi.fn(async () => undefined);
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => root?.render(<DesignSchemeEditor scheme={scheme} busy={false} onChange={onChange} backgroundImageStore={store as never} />));
      return { onChange, host: container };
    };
    const exportTheme = async (host: HTMLElement) => {
      let blob: Blob | null = null;
      vi.spyOn(URL, "createObjectURL").mockImplementation((value) => { blob = value as Blob; return "blob:theme"; });
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
      await act(async () => [...host.querySelectorAll("button")].find((entry) => entry.textContent?.includes("Export theme"))?.click());
      await act(async () => { await Promise.resolve(); });
      return blob as Blob | null;
    };
    const importTheme = async (host: HTMLElement, text: string, size?: number) => {
      const file = new File([text], "night.buildwarden-theme.json", { type: "application/json" });
      if (size !== undefined) Object.defineProperty(file, "size", { value: size });
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Import design scheme"]')!;
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    };
    const fileWithImage = JSON.stringify({ format: "buildwarden-design-scheme", version: 1, exportedAt: "2026-11-22T00:00:00.000Z", scheme: withImage, backgroundImage: { mimeType: "image/png", data: "BBBB" } });

    it("puts the stored image into the exported file", async () => {
      const store = { get: vi.fn(async () => stored), set: vi.fn(async () => null) };
      const { host } = await mountWith(withImage, store);
      const file = await exportedText((await exportTheme(host))!);
      expect(file.backgroundImage).toEqual({ mimeType: "image/png", data: "AAAA" });
      expect(file.scheme.customization?.background?.image).toBe("bg-00000000000000a1");
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    it("still exports the theme when its image cannot be read, and says the image is missing", async () => {
      const store = { get: vi.fn(async () => null), set: vi.fn(async () => null) };
      const { host } = await mountWith(withImage, store);
      const file = await exportedText((await exportTheme(host))!);
      expect(file.backgroundImage).toBeUndefined();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("exported without its background image");
    });

    it("stores the image of an imported file and saves the theme with this host's token for it", async () => {
      const calls: string[] = [];
      const store = {
        get: vi.fn(async () => null),
        set: vi.fn(async (image: unknown) => { calls.push(image ? "store" : "release"); return image ? "bg-00000000000000c3" : null; }),
      };
      const { host, onChange } = await mountWith(getDesignSchemePreset("midnight-blue")! as never, store);
      onChange.mockImplementation(async () => { calls.push("save"); });
      await importTheme(host, fileWithImage);
      expect(store.set).toHaveBeenCalledWith({ mimeType: "image/png", data: "BBBB" });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: "Night", customization: { background: { image: "bg-00000000000000c3", dim: 0.2 } } }));
      // Stored before the theme that names it is saved, and released as a draft only afterwards.
      expect(calls).toEqual(["store", "save", "release"]);
    });

    it("imports the theme without a background image where no image can be stored", async () => {
      const { host, onChange } = await mountWith(getDesignSchemePreset("midnight-blue")! as never);
      await importTheme(host, fileWithImage);
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: "Night", customization: { background: { dim: 0.2 } } }));
    });

    it("imports nothing when the host refuses the image, and releases what it stored when saving fails", async () => {
      const refusing = { get: vi.fn(async () => null), set: vi.fn(async (image: unknown) => { if (image) throw new Error("The background image must be a PNG, JPEG, WebP or GIF file."); return null; }) };
      const first = await mountWith(getDesignSchemePreset("midnight-blue")! as never, refusing);
      await importTheme(first.host, fileWithImage);
      expect(first.onChange).not.toHaveBeenCalled();
      expect(first.host.querySelector('[role="alert"]')?.textContent).toContain("must be a PNG, JPEG, WebP or GIF file");
      await act(async () => root?.unmount());
      first.host.remove();

      const store = { get: vi.fn(async () => null), set: vi.fn(async (image: unknown) => (image ? "bg-00000000000000c3" : null)) };
      const second = await mountWith(getDesignSchemePreset("midnight-blue")! as never, store);
      second.onChange.mockRejectedValue(new Error("Settings are read-only."));
      await importTheme(second.host, fileWithImage);
      expect(store.set).toHaveBeenLastCalledWith(null);
      expect(second.host.querySelector('[role="alert"]')?.textContent).toContain("Settings are read-only.");
    });

    it("accepts a large file only when it is the background image that makes it large", async () => {
      const { host, onChange } = await mountWith(getDesignSchemePreset("midnight-blue")! as never);
      const plain = JSON.stringify({ format: "buildwarden-design-scheme", version: 1, exportedAt: "2026-11-22T00:00:00.000Z", scheme: getDesignSchemePreset("ocean-mint") });
      await importTheme(host, plain, 700_000);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("without a background image must be smaller than 600 KB");
      await importTheme(host, fileWithImage, 13_000_000);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("smaller than 12 MB");
      expect(onChange).not.toHaveBeenCalled();
      await importTheme(host, fileWithImage, 9_000_000);
      expect(onChange).toHaveBeenCalledOnce();
    });
  });
});
