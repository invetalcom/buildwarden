/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { ActivityRichText } from "./activity-rich-text";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (source: string) => !source.includes("-->|")),
  render: vi.fn(async (id: string) => {
    document.body.insertAdjacentHTML("beforeend", `<div id="d${id}"></div>`);
    return { svg: `<svg id="${id}" width="100%" style="max-width: 120.5px;" viewBox="0 0 120.5 80"><text>A</text></svg>` };
  }),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

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

const waitForRender = () => act(async () => { await vi.advanceTimersByTimeAsync(300); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.body.removeAttribute("data-theme");
  vi.clearAllMocks();
});

it("renders a mermaid block as a sized image and switches to its source", async () => {
  const { container, root } = await render("```mermaid\ngraph TD\n  A --> B\n```");
  try {
    expect(container.querySelector("pre code")?.textContent).toBe("graph TD\n  A --> B");
    await waitForRender();
    const image = container.querySelector<HTMLImageElement>(".response-mermaid-diagram img")!;
    const svg = decodeURIComponent(image.getAttribute("src")!.replace("data:image/svg+xml;charset=utf-8,", ""));
    expect(svg).toMatch(/^<svg width="121" height="80" id=/);
    expect(svg).not.toContain("max-width");
    expect(container.querySelector("pre")).toBeNull();
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", theme: "dark" }));
    // Mermaid's measuring containers do not stay behind in the page.
    expect(document.querySelector("[id^='dresponse-mermaid-']")).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>("button[aria-label='Show source']")!.click());
    expect(container.querySelector("pre code")?.textContent).toBe("graph TD\n  A --> B");
    await act(async () => container.querySelector<HTMLButtonElement>("button[aria-label='Show diagram']")!.click());
    expect(container.querySelector(".response-mermaid-diagram img")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows the source when the diagram does not parse", async () => {
  const { container, root } = await render("```mermaid\ngraph TD\n  A -->|\n```");
  try {
    await waitForRender();
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(container.querySelector(".response-mermaid-diagram")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe("graph TD\n  A -->|");
    expect(container.querySelector("button[aria-label='Show diagram']")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("renders again in the light theme", async () => {
  const { root } = await render("```mermaid\ngraph TD\n  A --> B\n```");
  try {
    await waitForRender();
    await act(async () => document.body.setAttribute("data-theme", "light"));
    await waitForRender();
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" }));
  } finally {
    await act(async () => root.unmount());
  }
});
